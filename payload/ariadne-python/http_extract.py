"""HTTP seam extraction (Python edition; mirror of http.mjs)."""
import re

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


def _line(text, i):
    return text.count("\n", 0, i) + 1


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
