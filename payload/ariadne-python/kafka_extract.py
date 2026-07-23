"""Kafka topology extraction (Python edition; mirror of kafka.mjs).
Correlates producers/consumers across modules; resolves topics from literals,
static-final constants, and application.yaml/.properties placeholders."""
import re
from bisect import bisect_left
from pathlib import Path

CONFIG_FILE_RE = re.compile(r"(^|/)(application|bootstrap)[^/]*\.(ya?ml|properties)$")

# Newline offsets computed once per text (extraction is single-threaded, so a
# last-text memo suffices), O(log n) per lookup — replaces the per-match prefix
# re-scan, O(text × matches) on big files. Parity: makeLineAt (Node).
_ln_text = None
_ln_offs = None


def _line(text, idx):
    global _ln_text, _ln_offs
    if text is not _ln_text:
        offs = []
        find = text.find
        i = find("\n")
        while i != -1:
            offs.append(i)
            i = find("\n", i + 1)
        _ln_text, _ln_offs = text, offs
    return bisect_left(_ln_offs, idx) + 1
# Java `static final String X = "…"` and Kotlin `const val X[: String] = "…"`
CONST_RE = re.compile(r'(?:(?:static\s+final|final\s+static)\s+String\s+(\w+)|const\s+val\s+(\w+)(?:\s*:\s*String)?)\s*=\s*"([^"]+)"')
# value forms: Java array {"a","b"}, Kotlin array ["a","b"], or a bare expression
TOPICS_ATTR_RE = re.compile(r"topics\s*=\s*(\{(?:[^{}]|\$\{[^}]*\})*\}|\[(?:[^\[\]]|\$\{[^}]*\})*\]|(?:[^,)]|\$\{[^}]*\})+)")
LISTENER_RE = re.compile(r"@KafkaListener\s*\(([\s\S]*?)\)")
BROKER_LISTENER_RE = re.compile(r"@(Rabbit|Jms)Listener\s*\(([\s\S]*?)\)")
BROKER_ATTR_RE = re.compile(r"(?:queues|destination)\s*=\s*((?:[^,)]|\$\{[^}]*\})+)")
# receiver captured so rx streams don't masquerade as consumers (flux.subscribe)
# and rabbitTemplate/jmsTemplate stop masquerading as Kafka producers
SUBSCRIBE_RE = re.compile(r"\b(\w*[Cc]onsumer\w*)\s*\.\s*subscribe\s*\(\s*(?:List\.of|Arrays\.asList|Collections\.singletonList|Set\.of)?\s*\(?\s*([^;)]+)")
SEND_RE = re.compile(r"\b(\w*(?:[Tt]emplate|[Pp]roducer)\w*)\s*\.\s*(?:send|convertAndSend)\s*\(\s*([^,)]+)")


def system_of_receiver(name):
    """Which messaging system a Spring template/producer receiver belongs to."""
    low = name.lower()
    for sys_ in ("rabbit", "jms", "sqs", "sns", "pulsar"):
        if sys_ in low:
            return sys_
    return "kafka"
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

    def push(raw, direction, idx, system="kafka"):
        line = _line(text, idx)
        for topic, resolved, via in _resolve(raw, cfg, const):
            key = (topic, direction, line)
            if key not in seen:
                seen.add(key)
                edges.append({"topic": topic, "direction": direction, "line": line,
                              "resolved": resolved, "via": via, "system": system})

    for m in LISTENER_RE.finditer(text):
        attr = TOPICS_ATTR_RE.search(m.group(1))
        if attr:
            push(attr.group(1), "consume", m.start())
        elif re.match(r'^\s*"[^"]+"\s*$', m.group(1)):
            push(m.group(1), "consume", m.start())
    for m in BROKER_LISTENER_RE.finditer(text):
        attr = BROKER_ATTR_RE.search(m.group(2))
        if attr:
            push(attr.group(1), "consume", m.start(), m.group(1).lower())
    for m in SUBSCRIBE_RE.finditer(text):
        push(m.group(2), "consume", m.start())
    for m in SEND_RE.finditer(text):
        push(m.group(2), "produce", m.start(), system_of_receiver(m.group(1)))
    for m in PRODUCER_RECORD_RE.finditer(text):
        push(m.group(1), "produce", m.start())
    return edges


# ---------- Brokers beyond the JVM: amqplib/pika (Rabbit), boto3 (SQS), NATS ----------
AMQP_PUB_RE = re.compile(r"\.\s*sendToQueue\s*\(\s*[\"'`]([^\"'`]+)")
AMQP_SUB_RE = re.compile(r"\.\s*(?:assertQueue|consume)\s*\(\s*[\"'`]([^\"'`]+)")
PIKA_PUB_RE = re.compile(r"basic_publish\s*\([^)]*routing_key\s*=\s*[\"']([^\"']+)")
PIKA_SUB_RE = re.compile(r"basic_consume\s*\([^)]*queue\s*=\s*[\"']([^\"']+)")
SQS_PUB_RE = re.compile(r"send_message(?:_batch)?\s*\([^)]*QueueUrl\s*=\s*[\"']([^\"']+)")
SQS_SUB_RE = re.compile(r"receive_message\s*\([^)]*QueueUrl\s*=\s*[\"']([^\"']+)")
NATS_PUB_RE = re.compile(r"\.\s*publish\s*\(\s*[\"'`]([^\"'`]+)")
NATS_SUB_RE = re.compile(r"\.\s*subscribe\s*\(\s*[\"'`]([^\"'`]+)")


def extract_broker_edges(text):
    """Message edges from TS/JS/Python broker clients. Library presence gates
    each family, so `.publish(` in ordinary code never becomes a phantom queue."""
    edges, seen = [], set()

    def push(topic, direction, idx, system, via=None):
        line = _line(text, idx)
        key = (system, topic, direction, line)
        if key not in seen:
            seen.add(key)
            edges.append({"topic": topic, "direction": direction, "line": line,
                          "resolved": True, "via": via, "system": system})

    if re.search(r"amqplib|amqp://", text):
        for m in AMQP_PUB_RE.finditer(text):
            push(m.group(1), "produce", m.start(), "rabbit")
        for m in AMQP_SUB_RE.finditer(text):
            push(m.group(1), "consume", m.start(), "rabbit")
    if re.search(r"import\s+pika|pika\.", text):
        for m in PIKA_PUB_RE.finditer(text):
            push(m.group(1), "produce", m.start(), "rabbit")
        for m in PIKA_SUB_RE.finditer(text):
            push(m.group(1), "consume", m.start(), "rabbit")
    if re.search(r"boto3|sqs", text, re.I):
        for m in SQS_PUB_RE.finditer(text):
            push(m.group(1).split("/")[-1], "produce", m.start(), "sqs", "QueueUrl")
        for m in SQS_SUB_RE.finditer(text):
            push(m.group(1).split("/")[-1], "consume", m.start(), "sqs", "QueueUrl")
    if re.search(r"\bnats\b|connect\s*\(\s*[\"']nats:", text, re.I):
        for m in NATS_PUB_RE.finditer(text):
            push(m.group(1), "produce", m.start(), "nats")
        for m in NATS_SUB_RE.finditer(text):
            push(m.group(1), "consume", m.start(), "nats")
    return edges
