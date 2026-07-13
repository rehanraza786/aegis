"""Sample seam extractor (Python): Spring Cloud Stream functional bindings -> msg_edges."""
import re

BEAN_RE = re.compile(r"@Bean\s+(?:public\s+)?(Consumer|Supplier|Function)\s*<[^>]*>\s+(\w+)\s*\("
                     r"|fun\s+(\w+)\s*\(\s*\)\s*:\s*(Consumer|Supplier|Function)\b")


def _kafka(text, ctx):
    cfg = ctx["config"]
    out = []
    for m in BEAN_RE.finditer(text):
        kind = (m.group(1) or m.group(4) or "").lower()
        name = m.group(2) or m.group(3)
        if not name:
            continue
        line = text.count("\n", 0, m.start()) + 1
        in_key = f"spring.cloud.stream.bindings.{name}-in-0.destination"
        out_key = f"spring.cloud.stream.bindings.{name}-out-0.destination"
        if kind in ("consumer", "function") and cfg.get(in_key):
            out.append({"topic": cfg[in_key], "direction": "consume", "line": line, "via": in_key})
        if kind in ("supplier", "function") and cfg.get(out_key):
            out.append({"topic": cfg[out_key], "direction": "produce", "line": line, "via": out_key})
    return out


extractors = {"kafka": _kafka}
