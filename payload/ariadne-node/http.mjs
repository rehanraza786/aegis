/**
 * HTTP seam extraction, correlates REST endpoints with their callers across
 * the full stack:
 *   endpoints (Java Spring): @RestController + @Get/Post/Put/Delete/Patch/
 *     RequestMapping, class-level prefix combined with method-level path
 *   clients: TS/JS fetch & axios (string + template literals), Java
 *     RestTemplate, WebClient, and FeignClient interfaces
 * Paths are normalized so `/api/orders/{id}`, `/api/orders/:id`, and
 * `/api/orders/${orderId}` all correlate. Dynamic concatenation suffixes
 * become a trailing wildcard so they still prefix-match.
 */

const CLASS_MAPPING_RE = /@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/g;
const METHOD_MAPPING_RE = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)|\(\s*\)|\b)/g;
const REQUEST_METHOD_RE = /method\s*=\s*RequestMethod\.(\w+)/;
const FEIGN_RE = /@FeignClient\s*\(([^)]*)\)/;

const FETCH_RE = /\bfetch\s*\(\s*([`"'])((?:\\.|(?!\1).)*)\1/g;
const AXIOS_METHOD_RE = /\baxios\s*\.\s*(get|post|put|delete|patch|head)\s*\(\s*([`"'])((?:\\.|(?!\2).)*)\2/g;
const AXIOS_CONFIG_RE = /\baxios\s*(?:\.request)?\s*\(\s*\{[^}]*?url\s*:\s*([`"'])((?:\\.|(?!\1).)*)\1[^}]*?(?:method\s*:\s*([`"'])(\w+)\3)?/g;
const HTTP_CLIENT_GENERIC_RE = /\b(?:http|apiClient|client|api)\s*\.\s*(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*([`"'])((?:\\.|(?!\2).)*)\2/g;
const REST_TEMPLATE_RE = /restTemplate\s*\.\s*(getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|delete|exchange|patchForObject)\s*\(\s*"([^"]+)"(?:[^;]*?HttpMethod\.(\w+))?/g;
const WEBCLIENT_RE = /\.\s*(get|post|put|delete|patch|head)\s*\(\s*\)\s*[\s\S]{0,80}?\.\s*uri\s*\(\s*([`"'])((?:\\.|(?!\2).)*)\2/g;

const METHOD_OF = { getForObject: "GET", getForEntity: "GET", postForObject: "POST", postForEntity: "POST", postForLocation: "POST", put: "PUT", delete: "DELETE", patchForObject: "PATCH" };

/** Normalize any path shape to comparable segments: params -> {}, origins stripped, query dropped. */
export function normalizePath(raw) {
  let p = raw.trim();
  p = p.replace(/^https?:\/\/[^/]+/i, "");                 // strip origin
  p = p.split(/[?#]/)[0];                                    // strip query/hash
  p = p.replace(/\$\{[^}]*\}/g, "{}");                       // ${expr} -> {}
  p = p.replace(/\{[^}]*\}/g, "{}");                         // {id} -> {}
  p = p.replace(/:(\w+)/g, "{}");                            // :id -> {}
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p;
}

const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;

/** Java: extract Spring endpoints (and Feign client calls) from one file. */
export function extractJavaHttp(text) {
  const endpoints = [];
  const calls = [];
  const isController = /@RestController|@Controller\b/.test(text);
  const feign = text.match(FEIGN_RE);
  const isFeign = !!feign;

  // class-level prefixes (position -> prefix)
  const prefixes = [];
  CLASS_MAPPING_RE.lastIndex = 0;
  for (const m of text.matchAll(CLASS_MAPPING_RE)) prefixes.push({ idx: m.index, prefix: m[1], cls: m[2] });
  const prefixAt = (i) => { let p = ""; for (const x of prefixes) { if (x.idx <= i) p = x.prefix; else break; } return p; };
  const classIdxs = new Set(prefixes.map((p) => p.idx));

  METHOD_MAPPING_RE.lastIndex = 0;
  for (const m of text.matchAll(METHOD_MAPPING_RE)) {
    // skip the class-level @RequestMapping we already consumed
    if ([...classIdxs].some((ci) => Math.abs(ci - m.index) < 2)) continue;
    let method = m[1] === "Request"
      ? (text.slice(m.index, m.index + 200).match(REQUEST_METHOD_RE)?.[1] ?? "GET")
      : m[1].toUpperCase();
    const path = (prefixAt(m.index) + "/" + (m[2] ?? "")).replace(/\/{2,}/g, "/");
    const rec = { method, path, norm: normalizePath(path), line: lineAt(text, m.index) };
    if (isController) endpoints.push({ ...rec, detail: "Spring @" + m[1] + "Mapping" });
    else if (isFeign) calls.push({ ...rec, client: `FeignClient(${(feign[1].match(/"([^"]+)"/)?.[1] ?? "?")})` });
  }
  // Java outbound clients
  for (const m of text.matchAll(REST_TEMPLATE_RE)) {
    const method = m[3]?.toUpperCase() ?? METHOD_OF[m[1]] ?? "GET";
    calls.push({ method, path: m[2], norm: normalizePath(m[2]), line: lineAt(text, m.index), client: "RestTemplate" });
  }
  for (const m of text.matchAll(WEBCLIENT_RE)) {
    calls.push({ method: m[1].toUpperCase(), path: m[3], norm: normalizePath(m[3]), line: lineAt(text, m.index), client: "WebClient" });
  }
  return { endpoints, calls };
}

/** TS/JS: extract outbound HTTP calls from one file. */
export function extractTsHttp(text) {
  const calls = [];
  const push = (method, raw, idx, client, matchEnd) => {
    if (!raw || /^[a-z]+:[^/]/.test(raw)) return; // skip mailto:, data:, etc.
    // concatenated tail ("..." + var ...) -> dynamic-suffix wildcard
    const concat = matchEnd != null && /^\s*\+/.test(text.slice(matchEnd, matchEnd + 10));
    const norm = normalizePath(raw) + (concat ? "/{**}" : "");
    calls.push({ method: method.toUpperCase(), path: raw + (concat ? "…" : ""), norm, line: lineAt(text, idx), client });
  };
  for (const m of text.matchAll(FETCH_RE)) {
    const opts = text.slice(m.index, m.index + 300).match(/method\s*:\s*[`"'](\w+)/);
    push(opts?.[1] ?? "GET", m[2], m.index, "fetch", m.index + m[0].length);
  }
  for (const m of text.matchAll(AXIOS_METHOD_RE)) push(m[1], m[3], m.index, "axios", m.index + m[0].length);
  for (const m of text.matchAll(AXIOS_CONFIG_RE)) push(m[4] ?? "GET", m[2], m.index, "axios");
  for (const m of text.matchAll(HTTP_CLIENT_GENERIC_RE)) push(m[1], m[3], m.index, "http-client");
  return calls;
}

/** Does a call's normalized path match an endpoint's? Exact, or prefix when the call ends dynamic. */
export function pathsMatch(callNorm, epNorm) {
  if (segsMatch(callNorm, epNorm)) return true;
  // fetch(`${API_BASE}/api/orders`) normalizes to /{}/api/orders: that leading
  // placeholder is a base-URL/origin variable, not a path segment, and env-based
  // base URLs are the dominant frontend pattern. Retry with it stripped, call
  // side only, so those calls still correlate with /api/orders endpoints.
  if (callNorm.startsWith("/{}/")) return segsMatch(callNorm.slice(3), epNorm);
  return false;
}

function segsMatch(callNorm, epNorm) {
  if (callNorm === epNorm) return true;
  const seg = (s) => s.split("/");
  let c = seg(callNorm);
  const e = seg(epNorm);
  const dynamicTail = c[c.length - 1] === "{**}";
  if (dynamicTail) {
    c = c.slice(0, -1);
    if (e.length < c.length) return false;
    return c.every((s, i) => s === e[i] || s === "{}" || e[i] === "{}");
  }
  if (c.length !== e.length) return false;
  return c.every((s, i) => s === e[i] || s === "{}" || e[i] === "{}");
}
