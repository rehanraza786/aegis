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
const CONST_RE = /(?:static\s+final|final\s+static)\s+String\s+(\w+)\s*=\s*"([^"]+)"/g;
const LISTENER_RE = /@(?:Kafka|Jms|Rabbit)?KafkaListener\s*\(([^)]*)\)|@KafkaListener\s*\(([^)]*)\)/gs;
const LISTENER_SIMPLE_RE = /@KafkaListener\s*\(([\s\S]*?)\)\s*(?:public|protected|private|void|[\w<>]+\s+\w+\s*\()/g;
const SUBSCRIBE_RE = /\.subscribe\s*\(\s*(?:List\.of|Arrays\.asList|Collections\.singletonList|Set\.of)?\s*\(?\s*([^;)]+)/g;
const SEND_RE = /(?:[Tt]emplate|[Pp]roducer)\w*\s*\.\s*send\s*\(\s*([^,)]+)/g;
const PRODUCER_RECORD_RE = /new\s+ProducerRecord\s*<[^>]*>\s*\(\s*([^,)]+)/g;
const TOPICS_ATTR_RE = /topics\s*=\s*(\{(?:[^{}]|\$\{[^}]*\})*\}|(?:[^,)]|\$\{[^}]*\})+)/;

/** Flatten application.yaml/.properties files into { "a.b.c": "value" }. */
export function loadConfigMap(repoRoot, trackedFiles, log = () => {}) {
  const map = new Map();
  for (const rel of trackedFiles) {
    if (!CONFIG_FILE_RE.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, rel), "utf8"); } catch { continue; }
    if (rel.endsWith(".properties")) {
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([\w.\-\[\]]+)\s*[=:]\s*(.+?)\s*$/);
        if (m && !line.trim().startsWith("#")) map.set(m[1], m[2]);
      }
    } else {
      // minimal YAML flattener: indentation-based, scalars only (enough for topic keys)
      const stack = [];
      for (const raw of text.split("\n")) {
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
      if (!map.has(m[1])) map.set(m[1], m[2]);
    }
  }
  return map;
}

function resolveExpr(raw, configMap, constants) {
  let expr = raw.trim().replace(/^\(+|\)+$/g, "").trim();
  const results = [];

  // Runtime concatenation: PREFIX + "." + env. Resolve every part we can and mark
  // the whole thing UNRESOLVED with a partial like "orders.created.{?}" — that tells
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

/** Extract message edges from one java/kotlin file. Returns [{topic, direction, line, resolved, via}] */
export function extractKafkaEdges(text, configMap, constants) {
  const edges = [];
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  const push = (raw, direction, idx) => {
    for (const r of resolveExpr(raw, configMap, constants)) {
      edges.push({ ...r, direction, line: lineAt(idx) });
    }
  };
  LISTENER_SIMPLE_RE.lastIndex = 0;
  for (const m of text.matchAll(/@KafkaListener\s*\(([\s\S]*?)\)/g)) {
    const attr = m[1].match(TOPICS_ATTR_RE);
    if (attr) push(attr[1], "consume", m.index);
    else if (/^\s*"[^"]+"\s*$/.test(m[1])) push(m[1], "consume", m.index); // @KafkaListener("topic")
  }
  for (const m of text.matchAll(SUBSCRIBE_RE)) push(m[1], "consume", m.index);
  for (const m of text.matchAll(SEND_RE)) push(m[1], "produce", m.index);
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
