/** Sample seam extractor: Spring Cloud Stream functional bindings.
 * @Bean Consumer/Supplier/Function beans + spring.cloud.stream.bindings.<name>-in/out-0.destination
 * become msg_edges, flowing through message_flow/docgen like native Kafka edges.
 * Drop into .ariadne/extensions/, the same contract covers gateways, gRPC, GraphQL, etc. */
const BEAN_RE = /@Bean\s+(?:public\s+)?(Consumer|Supplier|Function)\s*<[^>]*>\s+(\w+)\s*\(|fun\s+(\w+)\s*\(\s*\)\s*:\s*(Consumer|Supplier|Function)\b/g;

export const extractors = {
  kafka(text, { configMap, relpath }) {
    const cfg = (k) => (configMap?.get ? configMap.get(k) : configMap?.[k]);
    const out = [];
    const lineAt = (i) => text.slice(0, i).split("\n").length;
    for (const m of text.matchAll(BEAN_RE)) {
      const kind = (m[1] ?? m[4] ?? "").toLowerCase();
      const name = m[2] ?? m[3];
      if (!name) continue;
      const line = lineAt(m.index);
      const inKey = `spring.cloud.stream.bindings.${name}-in-0.destination`;
      const outKey = `spring.cloud.stream.bindings.${name}-out-0.destination`;
      if ((kind === "consumer" || kind === "function") && cfg(inKey)) {
        out.push({ topic: cfg(inKey), direction: "consume", line, via: inKey });
      }
      if ((kind === "supplier" || kind === "function") && cfg(outKey)) {
        out.push({ topic: cfg(outKey), direction: "produce", line, via: outKey });
      }
    }
    return out;
  },
};
