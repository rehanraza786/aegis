"""HTTP seam extraction (Python edition; mirror of http.mjs)."""
import re
from bisect import bisect_left

CLASS_MAPPING_RE = re.compile(r'@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)')
METHOD_MAPPING_RE = re.compile(r'@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)|\(\s*\)|\b)')
REQUEST_METHOD_RE = re.compile(r"method\s*=\s*RequestMethod\.(\w+)")
FEIGN_RE = re.compile(r"@FeignClient\s*\(([^)]*)\)")
FETCH_RE = re.compile(r"\bfetch\s*\(\s*([`\"'])((?:\\.|(?!\1).)*)\1")
AXIOS_METHOD_RE = re.compile(r"\baxios\s*\.\s*(get|post|put|delete|patch|head)\s*\(\s*([`\"'])((?:\\.|(?!\2).)*)\2")
HTTP_GENERIC_RE = re.compile(r"\b(?:http|apiClient|client|api)\s*\.\s*(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*([`\"'])((?:\\.|(?!\2).)*)\2")
REST_TEMPLATE_RE = re.compile(r'restTemplate\s*\.\s*(getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|delete|exchange|patchForObject)\s*\(\s*"([^"]+)"(?:[^;]*?HttpMethod\.(\w+))?')
WEBCLIENT_RE = re.compile(r"\.\s*(get|post|put|delete|patch|head)\s*\(\s*\)\s*[\s\S]{0,80}?\.\s*uri\s*\(\s*([`\"'])((?:\\.|(?!\2).)*)\2")
METHOD_OF = {"getForObject": "GET", "getForEntity": "GET", "postForObject": "POST",
             "postForEntity": "POST", "postForLocation": "POST", "put": "PUT",
             "delete": "DELETE", "patchForObject": "PATCH"}


def normalize_path(raw):
    p = raw.strip()
    p = re.sub(r"^https?://[^/]+", "", p, flags=re.I)
    p = re.split(r"[?#]", p)[0]
    p = re.sub(r"\$\{[^}]*\}", "{}", p)
    p = re.sub(r"\{[^}]*\}", "{}", p)
    p = re.sub(r":(\w+)", "{}", p)
    if not p.startswith("/"):
        p = "/" + p
    p = re.sub(r"/{2,}", "/", p)
    return p.rstrip("/") if len(p) > 1 else p


# Newline offsets computed once per text (extraction is single-threaded, so a
# last-text memo suffices), O(log n) per lookup — replaces the per-match prefix
# re-scan, O(text × matches) on big files. Parity: makeLineAt (Node).
_ln_text = None
_ln_offs = None


def _line(text, i):
    global _ln_text, _ln_offs
    if text is not _ln_text:
        offs = []
        find = text.find
        j = find("\n")
        while j != -1:
            offs.append(j)
            j = find("\n", j + 1)
        _ln_text, _ln_offs = text, offs
    return bisect_left(_ln_offs, i) + 1


def extract_java_http(text):
    endpoints, calls = [], []
    is_controller = bool(re.search(r"@RestController|@Controller\b", text))
    feign = FEIGN_RE.search(text)
    prefixes = [(m.start(), m.group(1)) for m in CLASS_MAPPING_RE.finditer(text)]
    class_idxs = {i for i, _ in prefixes}

    def prefix_at(i):
        p = ""
        for idx, pref in prefixes:
            if idx <= i:
                p = pref
            else:
                break
        return p

    for m in METHOD_MAPPING_RE.finditer(text):
        if any(abs(ci - m.start()) < 2 for ci in class_idxs):
            continue
        if m.group(1) == "Request":
            mm = REQUEST_METHOD_RE.search(text[m.start():m.start() + 200])
            method = (mm.group(1) if mm else "GET").upper()
        else:
            method = m.group(1).upper()
        path = re.sub(r"/{2,}", "/", prefix_at(m.start()) + "/" + (m.group(2) or ""))
        rec = {"method": method, "path": path, "norm": normalize_path(path), "line": _line(text, m.start())}
        if is_controller:
            endpoints.append({**rec, "detail": f"Spring @{m.group(1)}Mapping"})
        elif feign:
            name = re.search(r'"([^"]+)"', feign.group(1))
            calls.append({**rec, "client": f"FeignClient({name.group(1) if name else '?'})"})
    for m in REST_TEMPLATE_RE.finditer(text):
        method = (m.group(3) or METHOD_OF.get(m.group(1), "GET")).upper()
        calls.append({"method": method, "path": m.group(2), "norm": normalize_path(m.group(2)),
                      "line": _line(text, m.start()), "client": "RestTemplate"})
    for m in WEBCLIENT_RE.finditer(text):
        calls.append({"method": m.group(1).upper(), "path": m.group(3), "norm": normalize_path(m.group(3)),
                      "line": _line(text, m.start()), "client": "WebClient"})
    return endpoints, calls


# ---------- Endpoints beyond Spring: Express/Fastify/Router + Nest, Flask/FastAPI ----------
EXPRESS_EP_RE = re.compile(r"\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|delete|patch|head|all)\s*\(\s*([\"'`])((?:\\.|(?!\2).)*)\2")
NEST_CTRL_RE = re.compile(r"@Controller\s*\(\s*(?:[\"'`]([^\"'`]*)[\"'`])?\s*\)")
NEST_EP_RE = re.compile(r"@(Get|Post|Put|Delete|Patch|Head|All)\s*\(\s*(?:[\"'`]([^\"'`]*)[\"'`])?\s*\)")
FLASK_EP_RE = re.compile(r"@\w+\.route\s*\(\s*([\"'])([^\"']*)\1([^)]*)\)")
FASTAPI_EP_RE = re.compile(r"@\w+\.(get|post|put|delete|patch|head)\s*\(\s*([\"'])([^\"']*)\2")
PY_CALL_RE = re.compile(r"\b(requests|httpx|session|client)\s*\.\s*(get|post|put|delete|patch|head)\s*\(\s*f?([\"'])((?:\\.|(?!\3).)*)\3")


def extract_ts_endpoints(text):
    """TS/JS: Express/Fastify/Router registrations and Nest controllers as endpoints."""
    endpoints = []
    for m in EXPRESS_EP_RE.finditer(text):
        if not m.group(3).startswith("/"):
            continue  # event names etc., not routes
        method = "GET" if m.group(1) == "all" else m.group(1).upper()
        endpoints.append({"method": method, "path": m.group(3), "norm": normalize_path(m.group(3)),
                          "line": _line(text, m.start()), "detail": f"Express {m.group(1)}"})
    prefixes = [(m.start(), m.group(1) or "") for m in NEST_CTRL_RE.finditer(text)]
    if prefixes:
        def prefix_at(i):
            p = ""
            for idx, pref in prefixes:
                if idx <= i:
                    p = pref
                else:
                    break
            return p
        for m in NEST_EP_RE.finditer(text):
            path = re.sub(r"/{2,}", "/", "/" + prefix_at(m.start()) + "/" + (m.group(2) or ""))
            method = "GET" if m.group(1) == "All" else m.group(1).upper()
            endpoints.append({"method": method, "path": path, "norm": normalize_path(path),
                              "line": _line(text, m.start()), "detail": f"Nest @{m.group(1)}"})
    return endpoints


def extract_py_http(text):
    """Python: Flask/FastAPI endpoints + requests/httpx/aiohttp-session calls."""
    endpoints, calls = [], []
    for m in FLASK_EP_RE.finditer(text):
        methods = [x.upper() for x in re.findall(r"[\"'](GET|POST|PUT|DELETE|PATCH|HEAD)[\"']", m.group(3) or "", re.I)]
        for method in (methods or ["GET"]):
            endpoints.append({"method": method, "path": m.group(2), "norm": normalize_path(m.group(2)),
                              "line": _line(text, m.start()), "detail": "Flask route"})
    for m in FASTAPI_EP_RE.finditer(text):
        endpoints.append({"method": m.group(1).upper(), "path": m.group(3), "norm": normalize_path(m.group(3)),
                          "line": _line(text, m.start()), "detail": f"FastAPI {m.group(1)}"})
    for m in PY_CALL_RE.finditer(text):
        url = m.group(4)
        if re.match(r"^[a-z]+:[^/]", url) and not re.match(r"^https?:", url):
            continue  # mailto: etc.
        # f-string {expr} placeholders normalize to {} exactly like template literals
        calls.append({"method": m.group(2).upper(), "path": url, "norm": normalize_path(url),
                      "line": _line(text, m.start()), "client": m.group(1)})
    return endpoints, calls


def extract_ts_http(text):
    calls = []

    def push(method, raw, start, end, client):
        if not raw or re.match(r"^[a-z]+:[^/]", raw):
            return
        concat = bool(re.match(r"\s*\+", text[end:end + 10]))
        norm = normalize_path(raw) + ("/{**}" if concat else "")
        calls.append({"method": method.upper(), "path": raw + ("…" if concat else ""),
                      "norm": norm, "line": _line(text, start), "client": client})

    for m in FETCH_RE.finditer(text):
        opts = re.search(r"method\s*:\s*[`\"'](\w+)", text[m.start():m.start() + 300])
        push(opts.group(1) if opts else "GET", m.group(2), m.start(), m.end(), "fetch")
    for m in AXIOS_METHOD_RE.finditer(text):
        push(m.group(1), m.group(3), m.start(), m.end(), "axios")
    for m in HTTP_GENERIC_RE.finditer(text):
        push(m.group(1), m.group(3), m.start(), m.end(), "http-client")
    return calls


def paths_match(call_norm, ep_norm):
    if _segs_match(call_norm, ep_norm):
        return True
    # fetch(`${API_BASE}/api/orders`) normalizes to /{}/api/orders: that leading
    # placeholder is a base-URL/origin variable, not a path segment, and env-based
    # base URLs are the dominant frontend pattern. Retry with it stripped, call
    # side only, so those calls still correlate with /api/orders endpoints.
    if call_norm.startswith("/{}/"):
        return _segs_match(call_norm[3:], ep_norm)
    return False


def _segs_match(call_norm, ep_norm):
    if call_norm == ep_norm:
        return True
    c, e = call_norm.split("/"), ep_norm.split("/")
    if c and c[-1] == "{**}":
        c = c[:-1]
        if len(e) < len(c):
            return False
        return all(s == e[i] or s == "{}" or e[i] == "{}" for i, s in enumerate(c))
    if len(c) != len(e):
        return False
    return all(s == e[i] or s == "{}" or e[i] == "{}" for i, s in enumerate(c))
