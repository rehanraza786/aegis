/** Sample FILE-SCOPED seam extractor: a house TypeScript event bus.
 * `files` widens the hook beyond the default java/kotlin set — this is the
 * pattern for making a Go/Rails/Node-only stack a first-class citizen: rows
 * land in the NATIVE tables, so bus events show up in message_flow, in the
 * generated diagrams, in the graph view, and in the orphan-topic warnings
 * exactly like Spring-Kafka edges do. */
const EMIT_RE = /\bbus\.emit\(\s*["']([^"']+)["']/g;
const ON_RE = /\bbus\.on\(\s*["']([^"']+)["']/g;

export const extractors = {
  kafka: {
    files: /\.(ts|tsx)$/,
    fn(text) {
      const lineAt = (i) => text.slice(0, i).split("\n").length;
      const out = [];
      for (const m of text.matchAll(EMIT_RE)) out.push({ topic: m[1], direction: "produce", line: lineAt(m.index), via: "bus.emit" });
      for (const m of text.matchAll(ON_RE)) out.push({ topic: m[1], direction: "consume", line: lineAt(m.index), via: "bus.on" });
      return out;
    },
  },
};
