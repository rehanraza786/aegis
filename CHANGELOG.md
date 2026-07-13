# Changelog

## 0.1.0 — first public release

Early release. The graph, the tools, the docs, and the tests are all real and
exercised on every push, but this has not yet been run against a large
production codebase — expect to adjust an extractor or two for your dialects.
See "Known limitations" in the README before you rely on it.

**Ariadne** — codebase graph MCP server, two runtime editions at parity (Node
≥18, Python ≥3.10). 21 tools: symbols and call graph (tree-sitter AST for Java,
Kotlin, TypeScript, TSX, JavaScript, Python), SCIP compiler-grade references,
Kafka topology with YAML-placeholder and constant resolution, Liquibase ↔
JPA/Querydsl data map with schema-drift detection, full-stack HTTP seam (Spring
↔ fetch/axios/RestTemplate/WebClient/Feign), Lombok generated-member synthesis,
multi-repo workspace mode, checksum-cached incremental indexing with scoped
correlation passes, PDF indexing.

**Mnemosyne** — temporal decision memory over git-versioned ADRs: supersession
chains, `as_of` time-travel, drift checks, and in-chat capture via
`save_decision`.

**Semantic layer** — hash-cached LLM insights (`explain`, `save_insight`), with
Copilot-seat, local-model, API, and plan/apply providers. Off by default.

**Documentation** — seven generated documents including PROGRESS.md for
stakeholders and the agent-context orientation pack. Zero LLM tokens; runs on
every commit and merge.

**Twelve skills** — six process (delivery loop, peer review, spec-driven
artifacts, task breakdown, gap analysis, knowledge base) and six ergonomics
(orientation, change-impact analysis, flow tracing, safe schema change, event
contract change, aegis-help).

**Eight agents** — daedalus (build), asclepius (diagnose), hephaestus (migrate),
argus (review), metis (decide and record), themis (audit against spec), hermes
(document), pythia (index).

**Ops** — git hooks, GitLab CI with a shared index artifact, corruption
auto-recovery, log rotation, Workspace Trust gating, and pluggable everything:
graph engines, indexer passes, MCP tools, seam extractors, doc generators,
insight providers.

**Tests** — 63 assertions per runtime edition, run on every push across
ubuntu + windows × node + python.
