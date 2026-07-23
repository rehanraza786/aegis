/**
 * Kafka topology extraction: correlates inbound/outbound message handling
 * across Java modules by resolving topic names from literals, constants, and
 * application.yaml/.properties placeholders.
 *
 * Detects (Spring Kafka + vanilla client, best-effort):
 *   consume: @KafkaListener(topics = ...), consumer.subscribe(...)
 *   produce: kafkaTemplate.send(topic, ...), new ProducerRecord<>(topic, ...)
 * Topic expressions resolved in order: "literal" → ${config.key[:default]} via
 * flattened application config → CONSTANT / Class.CONSTANT via a repo-wide
 * static-final-String map. Unresolvable expressions are kept with
 * resolved=false so nothing silently disappears.
 */
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE_RE = /(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/;
// Java `static final String X = "…"` and Kotlin `const val X[: String] = "…"`
const CONST_RE = /(?:(?:static\s+final|final\s+static)\s+String\s+(\w+)|const\s+val\s+(\w+)(?:\s*:\s*String)?)\s*=\s*"([^"]+)"/g;
const LISTENER_RE = /@(?:Kafka|Jms|Rabbit)?KafkaListener\s*\(([^)]*)\)|@KafkaListener\s*\(([^)]*)\)/gs;
const LISTENER_SIMPLE_RE = /@KafkaListener\s*\(([\s\S]*?)\)\s*(?:public|protected|private|void|[\w<>]+\s+\w+\s*\()/g;
// receiver captured so rx streams don't masquerade as consumers (flux.subscribe)
// and rabbitTemplate/jmsTemplate stop masquerading as Kafka producers
const SUBSCRIBE_RE = /\b(\w*[Cc]onsumer\w*)\s*\.\s*subscribe\s*\(\s*(?:List\.of|Arrays\.asList|Collections\.singletonList|Set\.of)?\s*\(?\s*([^;)]+)/g;
const SEND_RE = /\b(\w*(?:[Tt]emplate|[Pp]roducer)\w*)\s*\.\s*(?:send|convertAndSend)\s*\(\s*([^,)]+)/g;
/** Which messaging system a Spring template/producer receiver belongs to. */
export function systemOfReceiver(name) {
  if (/rabbit/i.test(name)) return "rabbit";
  if (/jms/i.test(name)) return "jms";
  if (/sqs/i.test(name)) return "sqs";
  if (/sns/i.test(name)) return "sns";
  if (/pulsar/i.test(name)) return "pulsar";
  return "kafka";
}
const PRODUCER_RECORD_RE = /new\s+ProducerRecord\s*<[^>]*>\s*\(\s*([^,)]+)/g;
// value forms: Java array {"a","b"}, Kotlin array ["a","b"], or a bare expression
const TOPICS_ATTR_RE = /topics\s*=\s*(\{(?:[^{}]|\$\{[^}]*\})*\}|\[(?:[^\[\]]|\$\{[^}]*\})*\]|(?:[^,)]|\$\{[^}]*\})+)/;

/** Flatten application.yaml/.properties files into { "a.b.c": "value" }. */
export function loadConfigMap(repoRoot, trackedFiles, log = () => {}) {
  const map = new Map();
  for (const rel of trackedFiles) {
    if (!CONFIG_FILE_RE.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, rel), "utf8"); } catch { continue; }
    if (rel.endsWith(".properties")) {
      // split on \r?\n: Windows checkouts/editors produce CRLF, and in JS regex
      // `.` excludes \r while `$` only matches true end-of-string, so a stray
      // \r makes every value line silently fail to parse.
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([\w.\-\[\]]+)\s*[=:]\s*(.+?)\s*$/);
        if (m && !line.trim().startsWith("#")) map.set(m[1], m[2]);
      }
    } else {
      // minimal YAML flattener: indentation-based, scalars only (enough for topic keys)
      const stack = [];
      for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim() || raw.trim().startsWith("#") || raw.trim() === "---") continue;
        const indent = raw.match(/^ */)[0].length;
        const m = raw.match(/^\s*([\w.\-\[\]"']+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].replace(/['"]/g, "");
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const full = [...stack.map((s) => s.key), key].join(".");
        const value = m[2].trim().replace(/^['"]|['"]$/g, "");
        if (value && !value.startsWith("#")) map.set(full, value.split(" #")[0].trim());
        stack.push({ key, indent });
      }
    }
  }
  log("INFO", `Kafka: loaded ${map.size} config properties`);
  return map;
}

/** Repo-wide constant map from java-ish sources: NAME -> value (collisions keep first). */
export function loadConstants(texts) {
  const map = new Map();
  for (const { text } of texts) {
    CONST_RE.lastIndex = 0;
    for (const m of text.matchAll(CONST_RE)) {
      const name = m[1] ?? m[2];
      if (!map.has(name)) map.set(name, m[3]);
    }
  }
  return map;
}

function resolveExpr(raw, configMap, constants) {
  let expr = raw.trim().replace(/^\(+|\)+$/g, "").trim();
  const results = [];

  // Runtime concatenation: PREFIX + "." + env. Resolve every part we can and mark
  // the whole thing UNRESOLVED with a partial like "orders.created.{?}", that tells
  // an assistant exactly what is missing, instead of silently picking one literal
  // out of the expression and calling it the topic name (which is a lie).
  if (/\+/.test(expr)) {
    const parts = expr.split("+").map((p) => p.trim()).filter(Boolean);
    let unknown = false;
    const pieces = parts.map((p) => {
      const lit = p.match(/^"([^"]*)"$/);
      if (lit) return lit[1];
      const ident = p.replace(/[^\w.]/g, "").split(".").pop();
      if (ident && constants.has(ident)) return constants.get(ident);
      const ph = p.match(/^"?\$\{([^:}]+)(?::([^}]*))?\}"?$/);
      if (ph) { const v = configMap.get(ph[1]) ?? ph[2]; if (v != null) return v; }
      unknown = true;
      return "{?}";
    });
    const joined = pieces.join("");
    return [{ topic: joined, resolved: !unknown, via: unknown ? "runtime concatenation" : null }];
  }

  // list literals: {"a", "b"} or "a", "b"
  const literals = [...expr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (literals.length) {
    for (const lit of literals) {
      const ph = lit.match(/^\$\{([^:}]+)(?::([^}]*))?\}$/);
      if (ph) {
        const v = configMap.get(ph[1]) ?? ph[2];
        results.push({ topic: v ?? lit, resolved: v != null, via: ph[1] });
      } else {
        results.push({ topic: lit, resolved: true, via: null });
      }
    }
    return results;
  }
  // bare identifier / Class.CONSTANT
  const ident = expr.split(".").pop().replace(/[^\w]/g, "");
  if (ident && constants.has(ident)) {
    return [{ topic: constants.get(ident), resolved: true, via: ident }];
  }
  if (ident) return [{ topic: expr.slice(0, 80), resolved: false, via: null }];
  return results;
}

/** Extract message edges from one java/kotlin file. Returns [{topic, direction, line, resolved, via, system}] */
export function extractKafkaEdges(text, configMap, constants) {
  const edges = [];
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  const push = (raw, direction, idx, system = "kafka") => {
    for (const r of resolveExpr(raw, configMap, constants)) {
      edges.push({ ...r, direction, line: lineAt(idx), system });
    }
  };
  LISTENER_SIMPLE_RE.lastIndex = 0;
  for (const m of text.matchAll(/@KafkaListener\s*\(([\s\S]*?)\)/g)) {
    const attr = m[1].match(TOPICS_ATTR_RE);
    if (attr) push(attr[1], "consume", m.index);
    else if (/^\s*"[^"]+"\s*$/.test(m[1])) push(m[1], "consume", m.index); // @KafkaListener("topic")
  }
  for (const m of text.matchAll(/@(Rabbit|Jms)Listener\s*\(([\s\S]*?)\)/g)) {
    const attr = m[2].match(/(?:queues|destination)\s*=\s*((?:[^,)]|\$\{[^}]*\})+)/);
    if (attr) push(attr[1], "consume", m.index, m[1].toLowerCase());
  }
  for (const m of text.matchAll(SUBSCRIBE_RE)) push(m[2], "consume", m.index);
  for (const m of text.matchAll(SEND_RE)) push(m[2], "produce", m.index, systemOfReceiver(m[1]));
  for (const m of text.matchAll(PRODUCER_RECORD_RE)) push(m[1], "produce", m.index);
  // de-dup identical edges from overlapping regexes
  const seen = new Set();
  return edges.filter((e) => {
    const k = `${e.topic}|${e.direction}|${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Brokers beyond the JVM: amqplib/pika (Rabbit), boto3 (SQS), NATS ----------
const AMQP_PUB_RE = /\.\s*sendToQueue\s*\(\s*["'`]([^"'`]+)/g;
const AMQP_SUB_RE = /\.\s*(?:assertQueue|consume)\s*\(\s*["'`]([^"'`]+)/g;
const PIKA_PUB_RE = /basic_publish\s*\([^)]*routing_key\s*=\s*["']([^"']+)/g;
const PIKA_SUB_RE = /basic_consume\s*\([^)]*queue\s*=\s*["']([^"']+)/g;
const SQS_PUB_RE = /send_message(?:_batch)?\s*\([^)]*QueueUrl\s*=\s*["']([^"']+)/g;
const SQS_SUB_RE = /receive_message\s*\([^)]*QueueUrl\s*=\s*["']([^"']+)/g;
const NATS_PUB_RE = /\.\s*publish\s*\(\s*["'`]([^"'`]+)/g;
const NATS_SUB_RE = /\.\s*subscribe\s*\(\s*["'`]([^"'`]+)/g;

/** Message edges from TS/JS/Python broker clients. Library presence gates each
 *  family, so `.publish(` in ordinary code never becomes a phantom queue. */
export function extractBrokerEdges(text) {
  const edges = [];
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  const push = (re, direction, system) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      edges.push({ topic: m[1], direction, line: lineAt(m.index), resolved: true, via: null, system });
    }
  };
  if (/amqplib|amqp:\/\//.test(text)) { push(AMQP_PUB_RE, "produce", "rabbit"); push(AMQP_SUB_RE, "consume", "rabbit"); }
  if (/import\s+pika|pika\./.test(text)) { push(PIKA_PUB_RE, "produce", "rabbit"); push(PIKA_SUB_RE, "consume", "rabbit"); }
  if (/boto3|sqs/i.test(text)) {
    SQS_PUB_RE.lastIndex = 0;
    for (const m of text.matchAll(SQS_PUB_RE)) edges.push({ topic: m[1].split("/").pop(), direction: "produce", line: lineAt(m.index), resolved: true, via: "QueueUrl", system: "sqs" });
    SQS_SUB_RE.lastIndex = 0;
    for (const m of text.matchAll(SQS_SUB_RE)) edges.push({ topic: m[1].split("/").pop(), direction: "consume", line: lineAt(m.index), resolved: true, via: "QueueUrl", system: "sqs" });
  }
  if (/\bnats\b|connect\s*\(\s*["']nats:/i.test(text)) { push(NATS_PUB_RE, "produce", "nats"); push(NATS_SUB_RE, "consume", "nats"); }
  const seen = new Set();
  return edges.filter((e) => {
    const k = `${e.system}|${e.topic}|${e.direction}|${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
