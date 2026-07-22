"""Kafka topology extraction (Python edition; mirror of kafka.mjs).
Correlates producers/consumers across modules; resolves topics from literals,
static-final constants, and application.yaml/.properties placeholders."""
import re
from pathlib import Path

CONFIG_FILE_RE = re.compile(r"(^|/)(application|bootstrap)[^/]*\.(ya?ml|properties)$")
# Java `static final String X = "…"` and Kotlin `const val X[: String] = "…"`
CONST_RE = re.compile(r'(?:(?:static\s+final|final\s+static)\s+String\s+(\w+)|const\s+val\s+(\w+)(?:\s*:\s*String)?)\s*=\s*"([^"]+)"')
# value forms: Java array {"a","b"}, Kotlin array ["a","b"], or a bare expression
TOPICS_ATTR_RE = re.compile(r"topics\s*=\s*(\{(?:[^{}]|\$\{[^}]*\})*\}|\[(?:[^\[\]]|\$\{[^}]*\})*\]|(?:[^,)]|\$\{[^}]*\})+)")
LISTENER_RE = re.compile(r"@KafkaListener\s*\(([\s\S]*?)\)")
SUBSCRIBE_RE = re.compile(r"\.subscribe\s*\(\s*(?:List\.of|Arrays\.asList|Collections\.singletonList|Set\.of)?\s*\(?\s*([^;)]+)")
SEND_RE = re.compile(r"[Tt]emplate\w*\s*\.\s*send\s*\(\s*([^,)]+)|[Pp]roducer\w*\s*\.\s*send\s*\(\s*([^,)]+)")
PRODUCER_RECORD_RE = re.compile(r"new\s+ProducerRecord\s*<[^>]*>\s*\(\s*([^,)]+)")
LITERAL_RE = re.compile(r'"([^"]+)"')
PLACEHOLDER_RE = re.compile(r"^\$\{([^:}]+)(?::([^}]*))?\}$")


def load_config_map(repo_root, tracked, log):
    cfg = {}
    for rel in tracked:
        if not CONFIG_FILE_RE.search(rel):
            continue
        try:
            text = (Path(repo_root) / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if rel.endswith(".properties"):
            for line in text.splitlines():
                m = re.match(r"^\s*([\w.\-\[\]]+)\s*[=:]\s*(.+?)\s*$", line)
                if m and not line.strip().startswith("#"):
                    cfg[m.group(1)] = m.group(2)
        else:
            stack = []
            for raw in text.splitlines():
                st = raw.strip()
                if not st or st.startswith("#") or st == "---":
                    continue
                indent = len(raw) - len(raw.lstrip(" "))
                m = re.match(r"^\s*([\w.\-\[\]\"']+)\s*:\s*(.*)$", raw)
                if not m:
                    continue
                key = m.group(1).strip("'\"")
                while stack and stack[-1][1] >= indent:
                    stack.pop()
                full = ".".join([k for k, _ in stack] + [key])
                value = m.group(2).strip().strip("'\"")
                if value and not value.startswith("#"):
                    cfg[full] = value.split(" #")[0].strip()
                stack.append((key, indent))
    log.info("Kafka: loaded %d config properties", len(cfg))
    return cfg


def load_constants(texts):
    const = {}
    for _, text in texts:
        for m in CONST_RE.finditer(text):
            const.setdefault(m.group(1) or m.group(2), m.group(3))
    return const


def _resolve(raw, cfg, const):
    expr = raw.strip().strip("()").strip()
    out = []

    # Runtime concatenation: PREFIX + "." + env. Resolve what we can and mark the whole
    # thing UNRESOLVED with a partial like "orders.created.{?}", so an assistant sees
    # exactly what is missing, instead of silently picking one literal out of the
    # expression and calling it the topic name, which would be a lie.
    if "+" in expr:
        parts = [p.strip() for p in expr.split("+") if p.strip()]
        unknown = False
        pieces = []
        for p in parts:
            lit = re.match(r'^"([^"]*)"$', p)
            if lit:
                pieces.append(lit.group(1))
                continue
            ident = re.sub(r"[^\w.]", "", p).split(".")[-1]
            if ident and ident in const:
                pieces.append(const[ident])
                continue
            ph = re.match(r'^"?\$\{([^:}]+)(?::([^}]*))?\}"?$', p)
            if ph:
                v = cfg.get(ph.group(1), ph.group(2))
                if v is not None:
                    pieces.append(v)
                    continue
            unknown = True
            pieces.append("{?}")
        return [("".join(pieces), not unknown, "runtime concatenation" if unknown else None)]

    literals = LITERAL_RE.findall(expr)
    if literals:
        for lit in literals:
            ph = PLACEHOLDER_RE.match(lit)
            if ph:
                v = cfg.get(ph.group(1), ph.group(2))
                out.append((v if v is not None else lit, v is not None, ph.group(1)))
            else:
                out.append((lit, True, None))
        return out
    ident = re.sub(r"[^\w]", "", expr.split(".")[-1])
    if ident and ident in const:
        return [(const[ident], True, ident)]
    if ident:
        return [(expr[:80], False, None)]
    return out


def extract_kafka_edges(text, cfg, const):
    edges, seen = [], set()

    def push(raw, direction, idx):
        line = text.count("\n", 0, idx) + 1
        for topic, resolved, via in _resolve(raw, cfg, const):
            key = (topic, direction, line)
            if key not in seen:
                seen.add(key)
                edges.append({"topic": topic, "direction": direction, "line": line,
                              "resolved": resolved, "via": via})

    for m in LISTENER_RE.finditer(text):
        attr = TOPICS_ATTR_RE.search(m.group(1))
        if attr:
            push(attr.group(1), "consume", m.start())
        elif re.match(r'^\s*"[^"]+"\s*$', m.group(1)):
            push(m.group(1), "consume", m.start())
    for m in SUBSCRIBE_RE.finditer(text):
        push(m.group(1), "consume", m.start())
    for m in SEND_RE.finditer(text):
        push(m.group(1) or m.group(2), "produce", m.start())
    for m in PRODUCER_RECORD_RE.finditer(text):
        push(m.group(1), "produce", m.start())
    return edges
