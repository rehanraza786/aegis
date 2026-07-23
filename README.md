# AEGIS

<img src="assets/aegis-logo-256.png" alt="AEGIS" width="110" align="right">

Agentic Engineering Guardrails & Intelligence System. A local codebase graph, a set of MCP tools, and a handful of skills and agents that make GitHub Copilot behave like it actually knows your repositories.

Built for a specific kind of codebase: Java/Kotlin on Spring Boot, TypeScript/React on the front end, Kafka between services, Liquibase for schema, Lombok everywhere, several repos open in one VS Code workspace, GitLab CI. If that describes you, most of this works out of the box. If it doesn't, the extraction layers are pluggable and the rest still applies.

MIT licensed. Runs entirely on your machines. No telemetry, no accounts, no API keys required.

---

## The problem this solves

Copilot in agent mode is capable but blind. Ask it "what breaks if I change `OrderService.findById`?" and it will grep, open six files, follow imports by hand, spend several thousand tokens, and give you an answer that's *probably* right. Ask it "who consumes `payments.completed`?" and it can't answer at all, because the producer says `kafkaTemplate.send(PAYMENTS_TOPIC, ...)`, the constant lives in another class, the consumer resolves the topic from `${app.kafka.payments-topic}` in a YAML file, and the two services are in different git repos.

So it guesses. And you find out in review.

AEGIS indexes all of that up front, statically and deterministically, in about a second, and serves it to Copilot over MCP. The assistant asks one question, gets an exact answer with file paths and line numbers, and spends its tokens on the actual work instead of on reconnaissance.

---

## What it looks like

Real output from `message_flow`, on a three-service workspace:

```
orders.created       producers: order-service/…/OrderPublisher.java:6  (via ORDERS_TOPIC)
                     consumers: billing-service/…/BillingListener.java:3
                                shipping-service/…/ShippingListeners.java:3

payments.completed   producers: billing-service/…/BillingListener.java:8
                                  (via app.kafka.payments-topic)
                     consumers: shipping-service/…/ShippingListeners.java:3

audit.events         ⚠ produced but no consumer found in the indexed workspace
returns.requested    ⚠ consumed but no producer found in the indexed workspace
```

The producer used a `static final String`. The consumer used a YAML placeholder. They're in different repos. It correlated them anyway, and flagged two topics nobody had noticed were orphaned.

`db_map` does the same across Liquibase and JPA:

```
payments          schema:  create [carol:010] → alter [carol:011]
                  entity:  PaymentEntity   (order-service/…/PaymentEntity.java:8)
                  access:  [write] PaymentDao.java:5   (JdbcTemplate.update)
                           [read]  PaymentDao.java:7   (JdbcTemplate.query)

legacy_invoices   ⚠ DRIFT: accessed by code but no Liquibase changeset defines it
order_audit       ⚠ defined in changelog but no code access found
```

That first drift warning is the bug that bites you in staging. It's now a tool call.

---

## Install

```
code --install-extension aegis-toolkit-0.1.0.vsix
```

Grab the `.vsix` from the Releases page, or use VS Code: Extensions -> `...` -> *Install from VSIX*.

Open your workspace. One repo or a folder of repos both work. The extension offers to set itself up; accept, and approve the terminal step, which builds the index and installs git hooks. Then open Copilot Chat in agent mode.

Requirements: git, and either Node ≥18 or Python ≥3.10. VS Code ≥1.99 registers the MCP server automatically.

There is a shell installer too, plus configuration and CI wiring, in [SETUP.md](SETUP.md).

**Not on VS Code?** The engine installs like any package, for any MCP client:

```
npx aegis-ariadne            # Node edition MCP server — run from your workspace root
uvx aegis-ariadne            # Python edition (locked-down environments)
aegis-ariadne-index --full   # build/refresh the index; -docgen for the generated docs
```

Point Claude Code, Cursor, Zed, or anything else that speaks MCP at that command; the index, config, and extensions still live in your workspace's `.ariadne/`. The vsix flow vendors the same files instead of installing them — both stay supported.

---

## Using it

**Nobody on your team needs to learn a tool name.** That is the whole design goal. They ask questions in English; the routing in `copilot-instructions.md` picks the right skill, which runs the right sequence of graph lookups. You type the left column. The right column is just what happens.

| You say | What happens |
| --- | --- |
| *"I'm new here, how does billing work?"* | Reads the generated docs and the graph, hands you an orientation brief: structure, seams, load-bearing files, standing decisions |
| *"What breaks if I change `OrderService`?"* | Impact analysis across code, Kafka, the database, HTTP, plus any ADR that governs it. Stops and tells you if your change contradicts a recorded decision |
| *"The order was placed but billing never charged it"* | Traces the hops with `path:line` at each one, ranks where the chain broke, and names the blind spots it *can't* see (transaction boundaries, serialization mismatches) rather than pretending |
| *"Add a `refunded_at` column to payments"* | Liquibase changeset first, then the entity, then every access site, then re-checks the graph, because "no drift warning" is verification and "it compiles" isn't |
| *"Publish an event when an order ships"* | Won't hardcode a topic literal. Resolves it from config, checks who consumes the payload before changing it, then confirms producer and consumer correlate |
| *"Why do we use Kafka here, is that still current?"* | Queries the temporal decision memory. Tells you what ADR-007 said, that ADR-012 superseded it in June, and what's in force now |
| *"We just decided to use an outbox, record it"* | Writes a numbered, formatted ADR into `docs/adr/` and indexes it on the spot |
| *"Why can't the graph resolve this topic?"* | Shows you exactly where static analysis is blind, and lets you teach it the answer with evidence |

That is the whole interface. There is a one-page [cheat sheet](docs/CHEATSHEET.md) your team can pin. Everything below this line is reference: useful when you want it, unnecessary to get started.

### Handing off bigger work

For anything longer than a question, address an agent by name. There are eight, and deliberately no more: an agent earns an `@name` only when the work runs long *and* its stance would conflict with another's. (A reviewer must be adversarial; a builder must be constructive. You don't want those in one head.)

| Agent | For |
| --- | --- |
| **`@daedalus`** | Build a feature end to end, spec, plan, then iterate until done. *Adds behavior.* |
| **`@asclepius`** | Something's broken. Reproduces first, forms competing hypotheses, tries to *disprove* the leading one, fixes the cause rather than the symptom |
| **`@hephaestus`** | Rename, extract, migrate, deprecate. *Preserves behavior exactly*, builds its inventory from compiler-grade references rather than grep, and refuses to leave the codebase half-migrated |
| **`@argus`** | Review a diff before merge. Four mandatory passes; every finding cites `path:line`, names the problem, proposes the fix |
| **`@metis`** | Weigh a design choice against what the codebase actually *is*, then write the ADR, so the reasoning outlives whoever made it |
| **`@themis`** | Audit the code against the spec, the PDFs, the ADRs. Report gaps with evidence |
| **`@hermes`** | Document a flow, with Mermaid diagrams where every arrow traces to a tool result |
| **`@pythia`** | Build and refresh the prose knowledge base |

---

# Reference

## Skills

Twelve of them, in `.github/skills/`. They follow the open Agent Skills format, so they work in Copilot, Claude Code, and anything else that reads the standard. **You don't invoke them; Copilot picks them up from how you phrase a request.** You *can* force one (`/change-impact-analysis`) when you want the full procedure rather than a conversation.

**Understand**: `codebase-orientation` (the cheapest-first lookup ladder, ending in a written brief) · `flow-tracing` (follow a request or event hop by hop; debug mode ranks suspects)

**Change safely**: `change-impact-analysis` (cross-seam blast radius before any edit) · `safe-schema-change` (Liquibase first, verified with the graph) · `event-contract-change` (no hardcoded topics; consumers consulted before a payload changes) · `feature-delivery-loop` (test → implement → build → verify → *review* → document, per increment) · `spec-driven-artifacts` (the `docs/features/` structure, modeled on GitHub's Spec Kit) · `complex-task-breakdown`

**Verify and improve**: `peer-code-review` (four passes, severity rubric, evidence rule) · `spec-gap-analysis` (requirement tracing) · `graph-augmentation` (teach the graph what parsers can't see) · `aegis-help` (routing, and fixing the toolkit when it's the broken thing)

## Tools

Twenty-four, served over MCP by `ariadne`. You won't type these yourself; they're what the skills call.

**Orient and search**: `context_pack` · `index_status` · `module_map` · `search_code` · `find_symbol` · `file_outline` · `hotspots`

**Structure and impact**: `dependencies` · `blast_radius` · `find_callers` · `find_callees` · `find_references` (SCIP, compiler-grade) · `goto_definition`

**System seams**: `message_flow` (Kafka) · `db_map` (Liquibase ↔ code, with drift) · `http_map` (endpoints ↔ callers)

**Knowledge and memory**: `explain` · `save_insight` · `decisions` · `decision_trace` · `save_decision`

**Improve the graph**: `graph_gaps` · `assert_edge` · `reindex`

Two are worth knowing by name:

**`context_pack`** collapses the whole "orient me on this thing" sequence into one call. Give it a class, method, or file and it returns the outline, callers, blast radius, the Kafka topics / DB tables / HTTP endpoints it touches, the ADRs governing them, and any cached insight, about 900 bytes. Six-plus round trips become one.

**`find_references` is compiler-grade; `find_callers` is a heuristic.** Use the second to explore, the first before claiming anything is or isn't used.

---

## What it understands about your stack

**Symbols and the call graph**: tree-sitter AST for Java, Kotlin, TypeScript, TSX, JavaScript, and Python. Symbols carry their parent class, so `UserService.findById` is distinguishable from every other `findById`. The parser is **WebAssembly**, not a native binary, deliberately: a locked-down devpod refused to execute native tooling (`bus error (core dumped)` on a static binary that worked everywhere else), and a WASM parser has nothing for a sandbox to reject. If it can't load at all, indexing falls back to regex and logs a warning rather than dying.

**Compiler-grade references**: `scip-java` and `scip-typescript` run in CI and their output is ingested into the same database, giving `find_references` real type resolution. That includes Lombok-generated members, since `scip-java` runs inside your Maven or Gradle build where Lombok's annotation processor actually executes. Both build systems are autodetected; it just needs a JDK.

**Kafka**: `@KafkaListener`, `subscribe`, `*Template.send`, `ProducerRecord`. Topic names resolve three ways: string literals, `static final String` constants collected repo-wide, and `${config.key}` placeholders looked up in a flattened parse of every `application*.yaml|properties` in the workspace. That third one is what correlates a producer and consumer when neither mentions the topic literally. What it *can't* evaluate (a topic assembled at runtime) it reports as a gap rather than guessing (see below).

**Database and Liquibase**: changelogs in XML, YAML, and formatted SQL, each op tagged with its `author:changeset-id`. On the code side: JPA `@Entity`/`@Table` (including the camelCase→snake_case default), Spring Data repositories via their entity generic, `@Query` in both flavors, `JdbcTemplate` with literal *or constant* SQL, and Querydsl. Every access tagged read or write. Two drift warnings, and they're why this layer earns its keep: **code touches a table no changelog defines**, and **table defined but never accessed**.

**The HTTP seam**: Spring `@RestController` endpoints with class-level prefixes correctly combined, matched against TypeScript `fetch`/`axios` (literals, template literals, and concatenated paths) and Java `RestTemplate`/`WebClient`/`@FeignClient`. Paths normalize, so `/api/orders/{id}`, `:id`, and `` `${orderId}` `` all correlate.

**Lombok**: entity detection parses the whole annotation block order-independently, so `@Table` above `@Entity` under a stack of `@Getter @Setter @Builder` resolves correctly. (That was a real bug, found the moment someone said "we use Lombok extensively.") The members Lombok generates at compile time don't exist in source, so they're synthesized into the graph: `getX`, `setX`, `isX`, `builder()`, `build()`, each tagged `[Lombok-generated]`.

**Documents**: Markdown, ADRs, and PDFs all land in the full-text index, so a requirement written in a PDF spec is searchable and citable.

**Test code**: classified at index time by path and name (`src/test/`, `*Test.java`, `*.spec.ts`, `__tests__/`, `test_*.py`, and friends; force files either way with `testPathPatterns` / `prodPathPatterns`). Test facts are never dropped, they're *labeled*: the topology in `message_flow`, `db_map`, `http_map`, and the generated diagrams is production-only, and test usage rides alongside tagged `[TEST]`, so an integration test can never silently "cure" an orphan-topic or drift warning. Test method and `it()` names are captured too, which is how `context_pack` can tell you which behaviors are asserted about a target. This is a second provenance axis, orthogonal to the first: `source` records *who* derived a fact (parser vs assistant), `is_test` records *where* the code lives. Upgrading an existing index migrates the classification automatically; run *Rebuild Index* once to backfill the test behaviors immediately.

## Generated documentation

A script (not an agent, not a model) reads the graph and writes `docs/generated/`. Zero tokens, deterministic, safe to run on every merge and every commit.

`architecture.md` (module map, dependency diagram, hotspots) · `message-flows.md` (Kafka topology, orphan warnings) · `data-map.md` (tables ↔ services ↔ changesets, drift) · `http-map.md` (endpoints ↔ callers) · `decisions.md` (active and superseded ADRs) · **`PROGRESS.md`** (the stakeholder report: overall percentage, a pie chart, and a per-feature table, computed from the `docs/features/` artifacts the delivery loop already maintains) · **`agent-context.md`** (the ~30-line orientation pack agents read *first*).

`PROGRESS.md` is exactly as honest as your task hygiene. The system makes truth cheap; it can't make it automatic.

## Decision memory

ADR markdown files in your repos are the source of truth, git-versioned, reviewable, no database to run. A deterministic pass builds a temporal index over them: `decided_at`, `valid_until`, and `superseded_by` derived from `Supersedes:` headers. Decisions are cross-referenced against the live graph, so one that mentions `orders.created` is *linked* to it.

```
decisions(target: "payments")     → every decision governing that table
decisions(as_of: "2026-04-01")    → what was actually in force last April
decision_trace(id: "ADR-007")     → ADR-007 [superseded] → until 2026-06-01
                                     ADR-012 [accepted]  → current
                                     governs: topic:orders.created, table:payments
                                              topic:legacy.events ⚠ no longer exists
```

And the capture side: when you and Copilot settle something in chat, `save_decision` writes a properly numbered ADR and indexes it on the spot. Permanent, versioned, and answerable by whoever inherits the code in three years. No model runs in the write path.

## Teaching the graph what parsers can't see

Parsers read code; they cannot *evaluate* it. So `kafkaTemplate.send(PREFIX + "." + env, o)` is invisible to static analysis, and AEGIS says so rather than guessing, reporting `orders.created.{?}` with `resolved: false`. (It briefly *did* guess: an early version pulled the `"."` out of that expression and recorded a topic literally named `.`. That was a bug. It's now a test.)

An assistant *can* evaluate it, read the constant, follow the config key, check the Spring profile. That knowledge used to be discarded. Now it can be recorded:

```
graph_gaps()   →  orders.created.{?}  at DynamicPublisher.java:6
                  "assembled at runtime, static analysis cannot evaluate it"

assert_edge(topic: "orders.created.prod", direction: "produce", confidence: "high",
            evidence: "PREFIX is a static final = 'orders.created'; env is the Spring
                       profile, 'prod' in production.")

message_flow(topic: "orders.created.prod")
  producers: …/DynamicPublisher.java:6   [ASSERTED by assistant, derived, not parsed]
```

Three properties keep this from becoming a hallucination pipeline. **Provenance is never erased**, a derived fact is labeled everywhere it appears and can never be mistaken for a parsed one. **Assertions are committed and reviewable**, they live in `docs/graph-assertions.json`, versioned in git and reviewed in PRs, exactly like ADRs. **They go stale honestly**, each stores the hash of its evidence file, and is flagged STALE when that file changes.

The `graph-augmentation` skill teaches the discipline, including when *not* to assert: never from naming alone, never without evidence you'd defend in review, and never merely to silence a warning, because an orphan topic is very often a real bug.

## Seeing the graph, and annotating it by hand

*AEGIS: Open Graph View* renders the live graph in VS Code: modules, Kafka topics, and DB tables as an interactive map (rendered locally with a bundled library — nothing leaves your machine), warnings badged on the nodes, test-only usage dimmed, asserted edges dashed. Click anything to jump to its `path:line`.

The part that matters is the **Gaps** panel: every unresolved topic expression, drift table, and orphan is a card with an annotate form. When a human resolves one — reads the code, checks the Spring profile, knows the answer — they type the resolution and the evidence, and it flows through the *same* write paths agents use: notes become insights (served by `explain` and `context_pack`), resolutions become entries in `docs/graph-assertions.json`. Human input gets its own provenance — `asserted:human`, distinct from both parsed facts and model inferences — it is git-versioned and PR-reviewable like every other assertion, and it goes stale honestly when the evidence file changes. Your team's tribal knowledge becomes queryable metadata, and every agent gets smarter the moment someone fills in a card.

The view reads a documented JSON contract (`graph_export`), so an [alternate graph engine](#configuration) that prints the same shape gets the visualization for free. See [EXTENDING.md](EXTENDING.md).

## Semantic insights

The graph tells you what connects to what. It doesn't tell you what a module is *for*. An enrichment pass summarizes each module and hotspot file and **caches the result against a content hash**, so a target costs tokens exactly once per change:

```
Enrichment: 0 generated, 4 cached (hash-unchanged), 0 failed.
```

Four ways to run it: **through Copilot** (`AEGIS: Enrich Insights via Copilot`, using seats you already pay for, no API keys), a **local model** (`OPENAI_BASE_URL` → Ollama/vLLM, zero egress), an **API key**, or **`enrich --plan` / `--apply`** to drive it with anything else. Agents can also write insights directly with `save_insight`. It's **off by default**, and it's the only component with a model in the write path.

---

## Team setup

**Git hooks** (installed by setup) run an incremental index and regenerate docs after every commit, merge, and checkout, in the background, never blocking git.

**CI** does the heavy work once for everyone. `gitlab-ci-aegis.yml` adds a job on default-branch merges: index, then `scip-typescript` and `scip-java` for the compiler-grade layer, then docgen, publishing the index and the docs as artifacts. Teammates run *Pull Team Index* and get the complete graph, SCIP included, in seconds. Nobody builds SCIP locally. The job caches the index between runs, so each pipeline reindexes only what the merge changed.

GitLab is what's wired because that's what this was built for. The job is thirty lines of shell. Details, plus the configuration reference and troubleshooting, are in [SETUP.md](SETUP.md).

## Multi-repo workspaces

Several repos open as one VS Code workspace are indexed as **one graph**. Paths are repo-prefixed, incremental indexing diffs each repo independently, and the correlation passes work *across* repos, since your producer and consumer live in different ones.

## Big codebases and context budget

An index can be gigabytes; that costs nothing, because **the index never enters the model's context**, only tool results do. What *can* flood a context window is a tool that returns everything, so nothing does.

Unscoped correlation queries return the signal, not a dump. On a 120-topic fixture:

```
message_flow  →   1.5 KB   (raw dump would be ~26.8 KB)
db_map        →   0.9 KB
http_map      →   0.7 KB   (raw dump ~14.2 KB)
```

You get counts, the *complete* orphan and drift lists, and the busiest items, with a pointer to query one at a time. **Warnings are kept first and never dropped by truncation**, a truncated result that silently discarded the drift warning would be worse than no result at all. Scoped queries (`message_flow topic:orders.created`) still return everything, as they always did.

Every result is capped anyway (50 rows, 24 KB, reporting `showing X of Y`). `agent-context.md` stays ~30 lines regardless of workspace size. Generated docs past 60 items carry a banner telling agents to query the tool rather than read the file. Tune it all in `.ariadne/config.json`.

## Performance

Measured on a 2,000-file Java repo:

| | before | after |
|---|---|---|
| Cold full index | 6,164 ms | **3,675 ms** |
| Incremental, one code file | 718 ms | **360 ms** |
| Incremental, docs-only commit | 718 ms | **251 ms** |
| Files re-extracted on a one-file change | **all 2,000** | **1** |

That last row is the one that matters. The correlation passes used to re-read every file in a changed *repo*, useless on a monolith, which is one repo. Extraction is now keyed on per-file content hashes: **O(changed), not O(repo)**. A change to a config value or topic constant still widens automatically to a full re-extract, because those alter how every *other* file resolves.

Also: the write path is now a single transaction (it had none, every INSERT was its own fsync), the SQLite pragmas are tuned, and the tree-sitter WASM runtime loads lazily so a docs-only commit doesn't pay for it.

Nothing rebuilds from scratch unless you run `--rebuild`. Every file stores a SHA-1 of its raw bytes plus size and mtime; `--full` is a *refresh* (prune, reindex changed, skip the rest) and reindexes zero files on an unchanged tree. A PDF seen once is never text-extracted again.

## Configuration

**`aegis.json`**: which graph engine backs the tools. Swap Ariadne for an external MCP graph server and the skills and agents don't care; they're engine-agnostic.

**`.ariadne/config.json`**: `skipDirs`, `aliasPrefixes`, `extraExtensions`, `maxFileBytes`, `tableNameOverrides` (for a custom Hibernate naming strategy, the indexer can't execute your Java), `testPathPatterns` / `prodPathPatterns` (regexes that force files into or out of test classification), plus the context-budget knobs (`maxToolRows`, `maxToolBytes`, `summaryThreshold`, `maxDiagramNodes`, `maxDocItems`).

**VS Code**: `aegis.runtime` (`node` | `python`), `aegis.autoRegisterAriadne`.

## Extending it

Every layer is a drop-in file in `.ariadne/extensions/`. No build step, no registry, versioned with your code.

| To add… | Drop in | Contract |
| --- | --- | --- |
| An indexing pass | `*.pass.mjs` / `.py` | `run(ctx)` |
| An MCP tool | `*.tool.mjs` / `.py` | `register({tool, z, withDb})` |
| Extraction for your framework | `*.extract.mjs` / `.py` | `extractors = { kafka, dbAccess, httpEndpoints, httpCalls }` |
| A generated document | `doc-*.mjs` / `.py` | `generate({q, write, …})` |
| An insight provider |, | `enrich --plan` → your model → `enrich --apply` |

The extractor hook is the important one: rows from a custom extractor land in the **native tables**, so a house framework's messaging shows up in `message_flow`, in the diagrams, and in the orphan warnings as if it were built in. A working **Spring Cloud Stream** extractor ships as a thirty-line sample and runs in the test suite. Gateway rewrites, gRPC, and GraphQL follow the same shape. See [EXTENDING.md](EXTENDING.md).

## Two runtimes, and why

The indexer and server exist twice at feature parity: Node and Python. This looks like over-engineering until you meet a locked-down environment. Ours was a devpod that refused to run native binaries, and the Node edition depends on `better-sqlite3`, which is one. The Python edition uses stdlib `sqlite3`, parses with prebuilt wheels, and streams files one at a time. It runs where nothing else will. Node is faster; Python is bulletproof. Both pass the same suite.

## Privacy

The complete list of network calls AEGIS makes: **(1)** `npm install` / `pip install` at setup, **(2)** `pull-index.sh` talking to *your* GitLab for *your* CI artifact. That's it. The MCP server is stdio, it doesn't bind a port. The index is a local SQLite file. Knowledge, specs, and decisions are markdown in your own repos.

The single exception is enrichment, off unless you turn it on, and pointable at a local model so even it never leaves the building. [PRIVACY.md](PRIVACY.md) itemizes it and tells you how to verify by grep rather than by trust.

## Troubleshooting

**Tools don't appear in Copilot.** Check VS Code ≥1.99, then that the workspace is *trusted*. AEGIS deliberately refuses to auto-register a server from an untrusted workspace, since that would mean executing whatever a cloned repo happened to contain.

**Answers look stale.** `index_status` reports freshness. Hooks refresh on commit, not on save, uncommitted work isn't indexed. Run *Rebuild Index*, or `reindex` from chat.

**`bus error (core dumped)`, or npm can't build `better-sqlite3`.** Your environment blocks native binaries. Reinstall with `--runtime=python`.

**A Kafka topic doesn't correlate.** Run `graph_gaps`. If it's under `unresolved_topic_expressions`, the name is assembled at runtime, either hoist it to a constant, or have the assistant resolve it and `assert_edge` the answer.

**A table shows DRIFT but the changelog exists.** It's probably in a repo that isn't in the indexed workspace, or it uses a Liquibase feature that isn't parsed.

Logs are in `.ariadne/index.log`.

## Known limitations

Stated plainly, because you'll find them anyway. This is a 0.1: the mechanisms are tested; coverage of *your* particular dialects is not.

- **Static analysis only.** Anything assembled at runtime is reported as a gap rather than resolved. `assert_edge` exists to close those gaps with evidence, but nothing does it automatically.
- **The call graph is a heuristic.** `find_callers` matches by name. Use `find_references` when you need certainty.
- **AST covers six languages.** Everything else is regex-tier: searchable and outline-able, no call graph.
- **Spring profiles are flattened.** All `application-*.yaml` merge into one map, so profile-specific names can mis-correlate.
- **Gateway rewrites, GraphQL, and gRPC aren't modeled.** All three are good `.extract` extension candidates.
- **Test detection is path- and name-based.** Convention-defying test code needs a `testPathPatterns` entry. The SCIP `SymbolRole.Test` bit isn't ingested yet (the compiler-grade upgrade path), and there is deliberately no `tests_for` tool, `context_pack`, `message_flow`, `db_map`, and `http_map` already answer it.
- **Measured to 2,000 files, not 200,000.** Cold index 3.7 s, incremental 360 ms at that size. The correlation pass holds in-scope file text in memory; that's the first place to look if a much larger codebase drags.
- **Windows is CI-verified, not battle-tested.** The matrix runs `windows-latest` on every push, but nobody has used it in anger there.
- **`PROGRESS.md` reflects your artifacts.** Garbage in, confident garbage out.

## Tests

```bash
python3 tests/run_tests.py --runtime node
python3 tests/run_tests.py --runtime python
```

Builds a six-repo fixture workspace from scratch. Spring services with Kafka, Liquibase in XML and SQL, a Lombok-stacked entity, Spring Cloud Stream bindings, a deliberately dynamic topic, Kotlin, Gradle, a React frontend, and a docs repo with an ADR chain and a PDF, plus a test file for every detection convention, then asserts ~100 behaviors end to end: AST nesting, Lombok synthesis, cross-repo Kafka correlation, schema drift, HTTP seam matching, PDF indexing, checksum caching, scoped extraction, SCIP ingest, decision supersession, context budget with warning survival, test-aware topology (production-only maps, `[TEST]`-labeled usage), graph assertions with provenance, corruption recovery, and an MCP protocol round trip.

CI runs the whole thing on **ubuntu and windows, against both runtimes**, on every push. That matrix is the reason anyone other than the author should trust this.

## FAQ

**Does this replace Copilot?** No. It makes Copilot better at *your* code. It has no model of its own.

**Does it work with Claude, Cursor, anything else?** Yes. `claude mcp add ariadne -- node .ariadne/server.mjs`, or point any MCP client at the stdio server. Skills and agents follow open standards.

**Do we have to change how we write code?** No. It reads what's there. The only optional conventions are the `docs/features/` artifacts (if you want `PROGRESS.md` to mean anything) and ADRs (if you want decision memory).

**What does it cost to run?** Nothing. Indexing, correlation, and all the generated documentation are deterministic scripts. Only enrichment involves a model; it's optional, cached by content hash, and can run on Copilot seats you already have.

**Is it really zero telemetry?** Grep for `fetch(`, `http`, `curl`. You'll find the package installers and `pull-index.sh` talking to your own GitLab. That's all there is.

## The names

Ariadne gave Theseus the thread through the labyrinth, so she's the graph. Argus had a hundred eyes and never slept, so he reviews. Daedalus built the thing in the first place. Asclepius was the physician, so he diagnoses. Hephaestus was the smith: he reforges a thing without changing what it *is*. Metis was good counsel. Themis held the scales. Hermes carried messages. Pythia spoke the oracle's knowledge at Delphi, which is where the knowledge base lives. Mnemosyne was memory itself.

The motto is "Sight beyond sight", which is where the eye on the shield comes from. It is a ThunderCats reference, and it stays a motto and nothing more, for trademark reasons a lawyer would appreciate more than a developer.

---

MIT. Do what you like with it.
