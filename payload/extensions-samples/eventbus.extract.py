"""Sample FILE-SCOPED seam extractor: a house TypeScript event bus.
(Python-edition twin of eventbus.extract.mjs.)

"files" widens the hook beyond the default java/kotlin set — this is the
pattern for making a Go/Rails/Node-only stack a first-class citizen: rows
land in the NATIVE tables, so bus events show up in message_flow, in the
generated diagrams, in the graph view, and in the orphan-topic warnings
exactly like Spring-Kafka edges do."""
import re

EMIT_RE = re.compile(r"\bbus\.emit\(\s*[\"']([^\"']+)[\"']")
ON_RE = re.compile(r"\bbus\.on\(\s*[\"']([^\"']+)[\"']")


def _kafka(text, ctx):
    out = []
    for m in EMIT_RE.finditer(text):
        out.append({"topic": m.group(1), "direction": "produce",
                    "line": text.count("\n", 0, m.start()) + 1, "via": "bus.emit"})
    for m in ON_RE.finditer(text):
        out.append({"topic": m.group(1), "direction": "consume",
                    "line": text.count("\n", 0, m.start()) + 1, "via": "bus.on"})
    return out


extractors = {"kafka": {"fn": _kafka, "files": r"\.(ts|tsx)$"}}
