# AEGIS — Setup

Three roles below: **maintainer** (does this once), **each developer**
(5 minutes), and **daily use**. Then: how to distribute this toolkit to
other teams.

---

## Part 1 — Maintainer: one-time setup for your repo

**1. Get the toolkit onto your machine** (see Part 4 for hosting it) and run
the installer from your project repo's root:

```bash
cd ~/code/your-project
bash ~/downloads/aegis-toolkit/install.sh                    # Node edition (default — fits a TS team; needs Node >=18)
bash ~/downloads/aegis-toolkit/install.sh --runtime=python   # Python edition (needs Python 3.10+)
```

Both editions are functionally identical (same DB schema, same 15 MCP tools (workspace-wide),
same SCIP support) — pick whichever runtime your team already has. The Node
edition's deps install via `npm install` inside `.ariadne/`; Python's via pip.

The installer copies in (skipping anything that already exists):
- `.github/skills/` — complex-task-breakdown, spec-gap-analysis, codebase-orientation, feature-delivery-loop, peer-code-review, spec-driven-artifacts
- `.github/agents/` — daedalus, themis, pythia
- `.github/copilot-instructions.md` — appends the routing section
- `.ariadne/` — MCP server, indexers, scripts
- `.vscode/mcp.json` — MCP server registration
- `gitlab-ci-aegis.yml` — CI job to merge into your pipeline

It also installs the dependencies, builds the initial index, and wires the
git hooks for your clone.

**2. Adjust the CI job.** Open `gitlab-ci-aegis.yml`, fix the two ADJUST
markers (your tsconfig directory; your Gradle/Maven root), then merge the
`aegis-index` job into your `.gitlab-ci.yml`.

**3. Commit and merge to your default branch:**

```bash
git add .github .ariadne .vscode .gitignore .gitlab-ci.yml
git commit -m "Add AEGIS: skills, agents, ariadne MCP"
```

Once merged, CI builds the first shared compiler-grade index.

**4. Create one team access token** (GitLab → Project → Settings → Access
tokens → scope `read_api`) OR tell the team to install `glab` and run
`glab auth login`. Either lets `pull-index.sh` fetch the CI-built index.

---

## Part 2 — Each developer (5 minutes, per clone)

```bash
cd ~/code/your-project && git pull

# 1. git hooks + dependencies + local index (auto-detects Node/Python edition)
bash .ariadne/install-hooks.sh

# 3. pull the shared compiler-grade index from CI
glab auth login          # once — or: export GITLAB_TOKEN=<team token>
bash .ariadne/pull-index.sh
```

Then in VS Code:
1. Open the repo → open `.vscode/mcp.json` → click **Start** above the server
   (or Command Palette → *MCP: List Servers* → ariadne → Start).
2. Open Copilot Chat, switch to **Agent mode**, click the tools icon,
   confirm the `ariadne` tools are checked.
3. Sanity check — ask: *"Call index_status and module_map"*.

Windows note: use Git Bash for the shell steps, and change `"python3"` to
`"python"` in `.vscode/mcp.json`.

---

## Part 3 — Daily use

Mostly: nothing. The routing in copilot-instructions makes Copilot use the
graph tools and knowledge base automatically. The hooks keep your local
index fresh on every commit.

Things you do explicitly:
- **Pick an agent for big tasks**: `daedalus` (build features
  end-to-end), `themis` (audit code vs specs, fix gaps). Select via the
  agent dropdown in VS Code / `/agent` in Copilot CLI.
- **Force a skill** when you want the full procedure: `/complex-task-breakdown`,
  `/spec-gap-analysis`.
- **Refresh the shared index** after big merges: `bash .ariadne/pull-index.sh`.
- **If results look stale**: ask Copilot to run `index_status`; if
  `fresh: false`, it can call `reindex`.
- **First time in an unfamiliar area?** Run the `pythia` agent once
  to (re)generate the prose knowledge base in `.github/knowledge/`.

---

## Part 4 — Distributing this toolkit to others

The toolkit is just files — host it anywhere people can clone from.

### Option A: GitLab (your home turf)

1. Create a project, e.g. `yourgroup/aegis-toolkit`, visibility **internal**
   (whole org) or public.
2. Push this toolkit directory to it.
3. Anyone installs with:
   ```bash
   git clone https://gitlab.yourco.com/yourgroup/aegis-toolkit.git /tmp/ct
   cd ~/code/their-project && bash /tmp/ct/install.sh
   ```
4. Ship updates by tagging releases (`git tag v0.2.0 && git push --tags`);
   users re-clone and re-run — the installer never clobbers modified files.

### Option B: GitHub (widest reach)

1. Create a public repo, push the toolkit.
2. Mark it a **Template repository** (Settings → check "Template repository")
   so others can click **Use this template** to fork their own copy.
3. Create a **Release** and attach a zip — non-git users can just download.
4. One-liner install for users:
   ```bash
   git clone https://github.com/you/aegis-toolkit.git /tmp/ct \
     && cd your-project && bash /tmp/ct/install.sh
   ```
5. GitHub-only bonus for the skills: they can also be installed individually
   with GitHub CLI — `gh skill install you/aegis-toolkit <skill-name>`
   (requires the skills to sit in a `skills/` dir at repo root; keep a copy
   there if you want this path). You can also submit them to the community
   `github/awesome-copilot` collection.

### Option C: both

Push to GitLab as the source of truth; add a GitHub remote and
`git push github main` to mirror. GitLab can also do this automatically:
Settings → Repository → Mirroring repositories.

### What travels where — compatibility matrix

| Component | GitHub-hosted repo | GitLab-hosted repo |
|---|---|---|
| Skills, agents, copilot-instructions | ✅ | ✅ (read locally by VS Code/CLI) |
| Ariadne MCP server + hooks | ✅ | ✅ (host-agnostic) |
| Shared index CI | use the GitHub Actions variant* | ✅ gitlab-ci-aegis.yml |
| Copilot cloud agent / PR review | ✅ | ❌ (GitHub-hosted features) |

*If a downstream team is on GitHub, tell them to ask Copilot to convert
`gitlab-ci-aegis.yml` to a GitHub Actions workflow — it's a 1:1 mapping
(checkout, setup-node/java/python, same script lines, upload-artifact).

---

## Troubleshooting

- **"Index not found"** → `python3 .ariadne/indexer.py --full`
- **`find_references` says SCIP not ingested** → normal until the first CI
  run completes and you `pull-index.sh`; regex tools work meanwhile.
- **Hooks not firing** → hooks are per-clone; re-run `install-hooks.sh`.
  Check `.ariadne/index.log` for errors.
- **MCP server won't start on Windows** → Python edition: `python` vs `python3` in mcp.json. Node edition: ensure `node` is on PATH for VS Code (restart after installing Node).
- **`better-sqlite3` build errors on npm install** → it ships prebuilt binaries for Node 18/20/22 on all platforms; if you're on an exotic Node version, switch to an LTS release.
- **Two devs committed at once / hook overlap** → safe: a lockfile serializes indexer runs; the loser exits cleanly and the next commit catches up.
- **pull-index.sh auth errors** → token needs `read_api`; self-managed
  GitLab behind SSO may require `glab auth login --hostname gitlab.yourco.com`.

---

## VS Code extension distribution (.vsix)

The `extension/` folder contains a packaged VS Code extension that bundles the
whole payload. To rebuild after changing the toolkit:
```bash
cd extension && cp -r ../payload . && npm i -D @vscode/vsce && npx vsce package --allow-missing-repository
```

**Distribute internally (no marketplace account needed):**
- Attach the `.vsix` to a GitLab release; devs install via
  `code --install-extension aegis-toolkit-0.1.0.vsix` or VS Code →
  Extensions → `...` menu → *Install from VSIX*.

**Publish publicly:** create a publisher at marketplace.visualstudio.com (set
the real `publisher` id in extension/package.json), then `npx vsce publish`.
For an open ecosystem also publish to open-vsx.org (`npx ovsx publish`).

What the extension does: one-command install of skills/agents/Ariadne into the
current workspace, automatic MCP registration of Ariadne with Copilot (VS Code
≥1.99 via the MCP server definition provider API; older versions use the
generated `.vscode/mcp.json`), plus commands for reindex, index status, and
pulling the team-shared CI index.

## Exposing the .vsix from your GitHub repository

1. Push this toolkit repo to GitHub — `.github/workflows/release-vsix.yml` is already in place. (GitLab ignores the .github directory, so mirroring is safe.)
2. Tag a release: `git tag v0.1.0 && git push --tags` — the workflow builds the
   `.vsix` and attaches it to a public Release automatically.
3. Anyone can then install it from your repo's **Releases** page:
   download → `code --install-extension aegis-toolkit-*.vsix`
   (or VS Code → Extensions → ⋯ → Install from VSIX).
4. Add a README badge/link so it's visible:
   `[![Get the extension](https://img.shields.io/github/v/release/YOU/aegis?label=AEGIS%20vsix)](https://github.com/YOU/aegis/releases/latest)`
5. Optional wider reach: publish to the VS Code Marketplace (`vsce publish`,
   needs a free publisher account) and open-vsx.org (`ovsx publish`) so users
   can install by searching "AEGIS" — see PRIVACY.md; the extension contains
   no telemetry either way.


## Switching graph engines

AEGIS's skills and agents are graph-engine-agnostic. The engine is selected in
`aegis.json` at the repo root (created by the installer):

```bash
bash install.sh --engine=ariadne          # default: built-in, SCIP, CI sharing
bash install.sh --engine=codebase-memory  # external: DeusData/codebase-memory-mcp
bash install.sh --engine=code-graph       # external: @sdsrs/code-graph
bash install.sh --engine=custom           # bring your own; edit aegis.json mcp command/args
```

What changes per engine: the MCP server registered with Copilot (via
aegis.json → the extension provider or .vscode/mcp.json), and the tool-hint
paragraph appended to copilot-instructions. External engines manage their own
indexes, so .ariadne/, git hooks, and the aegis-index CI job are skipped.
Switching later: edit `graphEngine` (and `mcp.command/args`) in aegis.json,
update the "Codebase graph engine" section of copilot-instructions, and reload
VS Code. Defaults for external engines' launch commands are best-effort — verify
against each engine's README and adjust aegis.json accordingly.


## AST engine
Ariadne now extracts symbols via WASM tree-sitter (Node edition) /
tree-sitter-language-pack (Python edition) for Java, TypeScript/TSX,
JavaScript, and Python: exact symbol locations regardless of formatting,
class-nesting (`UserService.findById`), and a heuristic call graph powering
two new tools — `find_callers` and `find_callees`. No native binaries in the
Node edition's parser (WASM), so it runs in locked-down devpods. If the AST
engine can't load, indexing falls back to the regex extractors automatically
and logs a warning; other languages always use regex. Compiler-grade
resolution still comes from the SCIP layer (`find_references`).

## Kafka message-flow correlation
Ariadne correlates inbound/outbound Kafka handling across Java/Kotlin modules
via the `message_flow` MCP tool: each topic's producers and consumers with
file:line, resolved through three mechanisms — string literals, static-final
constants (`ORDERS_TOPIC`), and `${...}` placeholders looked up in flattened
application.yaml/.properties. Orphans are flagged (produced-but-never-consumed
and vice versa), and unresolvable dynamic expressions are listed rather than
dropped. Detected patterns: @KafkaListener(topics=...), consumer.subscribe(...),
*template/*producer .send(topic,...), new ProducerRecord<>(topic,...).
Limitations: static analysis within the indexed workspace — topics built by
runtime string concatenation and cross-repo flows aren't visible (pair with
Confluent Stream Lineage or Springwolf AsyncAPI docs for runtime/spec views);
Spring Cloud Stream function bindings not yet parsed.

## Database & Liquibase correlation
The `db_map` MCP tool correlates every table with (a) the Liquibase changesets
that shaped it — XML, YAML, and formatted-SQL changelogs, each op tagged with
its author:id — and (b) every code site touching it: JPA @Entity/@Table
mappings (camelCase→snake_case default naming handled), Spring Data
repositories (via their entity generic), @Query (both native SQL and JPQL
resolved through the entity map), and JdbcTemplate calls with literal or
constant SQL, each tagged read/write. Two drift warnings: code accessing a
table no changelog defines, and tables defined but never accessed.
Limitations: static analysis — dynamically built SQL, Querydsl/Criteria API,
custom @Table naming strategies, and cross-repo schemas aren't resolved;
derived query methods (findByStatus...) attribute to the repository's entity
table, not per-method.

## Multi-repo workspace mode
Ariadne now indexes an entire VS Code workspace of repos as one graph. Root
discovery order: ARIADNE_ROOTS env (comma-separated paths — the extension sets
this automatically for multi-root workspaces) → the current git repo → child
git directories of the cwd (a parent folder holding your repos). Paths are
stored repo-prefixed (order-service/src/...), incremental indexing stamps and
diffs per repo, and Kafka/DB correlation works across repos — a producer in
one repo matches a consumer in another. The index lives in
$ARIADNE_HOME/.ariadne (defaults to the first root). Git hooks remain
per-repo; a commit in any repo refreshes only that repo's slice.

Also: Querydsl access detection (Q-classes resolved through the
entity map, read/write from surrounding context), custom naming strategies
via `tableNameOverrides` in .ariadne/config.json ({"OrderEntity": "ord_orders"}),
and PDF documents (specs, ADR exports) extracted into the full-text index so
search_code and the Themis gap analysis can cite them.

## Generated documentation & progress reporting
`docgen` (node .ariadne/docgen.mjs / python3 .ariadne/docgen.py) produces five
artifacts in docs/generated/ deterministically — zero LLM tokens — on every CI
merge (wired into the aegis-index job, published as artifacts, with an optional
commented block to auto-commit them back):
- architecture.md — module map + Mermaid dependency flowchart + hotspot list
- message-flows.md — Kafka topology diagram + per-topic sites + orphan warnings
- data-map.md — tables ↔ services Mermaid + Liquibase changeset history + drift
- PROGRESS.md — manager/PO report: overall %, Mermaid pie, per-feature table
  (status, %, tasks, FRs, open clarifications, last review verdict) — computed
  from docs/features/*/ artifacts, so it's true whenever the delivery loop runs
- agent-context.md — the ~100-line orientation pack agents read FIRST
  (copilot-instructions now routes there), listing modules, topics, tables,
  high-risk files, the cheapest-first lookup order, and standing rules

Hermes (new agent) writes what scripts can't: narrative flow docs with Mermaid
sequence diagrams in docs/flows/, every arrow backed by a tool result.

## HTTP seam
`http_map` correlates Spring endpoints (@RestController + class-level
@RequestMapping prefixes combined with @Get/Post/Put/Delete/Patch/RequestMapping)
with every caller: TS/React fetch and axios (string + template literals +
concatenated paths via a dynamic-tail wildcard), Java RestTemplate, WebClient,
and FeignClient interfaces. Paths normalize so {id}, :id, and ${expr} all
match. Orphan endpoints and unmatched outbound calls (external APIs) are
listed. docgen emits docs/generated/http-map.md with the cross-stack Mermaid
diagram. Limits: dynamic path construction beyond simple concatenation,
gateway rewrites/base-path config, and GraphQL are not modeled.

## Checksum-based incremental caching
Every indexed file stores its SHA-1 **of the raw bytes** plus size and mtime.
Two-tier skip on every run: (1) size+mtime identical → skipped without even
reading the file; (2) stat changed but checksum identical (touch, fresh clone,
CI checkout) → skipped after a cheap hash, **before** any extraction — so a
PDF seen once is never text-extracted again unless its bytes actually change.
Changed MDs and code reindex exactly themselves. `--full` is now *refresh*
semantics (prune removed files, skip unchanged — cheap enough to run anywhere);
`--rebuild` forces a from-scratch reindex (schema upgrades, suspected corruption).
One-time note upgrading from ≤2.0: hashes migrate to raw-byte semantics, so each
file re-hashes once on its first stat change. Automation is therefore complete:
git hooks per commit (incremental + docgen for either runtime) and the CI job
per merge (index + SCIP + docgen + shared artifacts) — no manual steps.

### Maven note
scip-java autodetects Maven from the root pom.xml (multi-module included) — the
CI job needs no changes for Maven; it just requires a JDK in the image. pom.xml
files are themselves indexed (config), so search_code finds dependency and
module declarations.

## Lombok support
Three layers make Lombok-heavy codebases first-class:
1. Entity detection parses the full annotation block before each class, order-
   independently — @Table before @Entity under a stack of Lombok annotations
   resolves correctly (this was a latent bug for annotation-stacked entities).
2. Generated members are synthesized into the symbol graph: @Getter/@Setter/
   @Data/@Value/@Builder produce getX/setX/isX (booleans)/builder()/build()
   entries tagged "[Lombok-generated]", nested under their class — so
   find_symbol, file_outline, and find_callers resolve members that don't
   exist in source. static final constants are excluded.
3. Compiler-grade truth still comes from SCIP: scip-java runs inside your
   Maven build where Lombok's annotation processor executes, so
   find_references covers generated members exactly.
Not modeled: @Delegate, @With, @FieldNameConstants, and log.* calls from
@Slf4j appear as ordinary call noise.

## Self-test suite, Windows, and pass scoping
**Self-tests:** `python3 tests/run_tests.py --runtime node|python` builds a
4-repo fixture workspace and asserts 30 behaviors end-to-end (AST nesting,
Lombok synthesis, Kafka placeholder resolution, Liquibase changesets, drift,
HTTP seam matching, PDF FTS, checksum caching, scoped passes, docgen output,
hook installation). `.github/workflows/test.yml` runs the suite on every push
across a matrix of ubuntu + windows × node + python; the badge goes green on your first push.

**Windows:** setup is now cross-platform — `node .ariadne/setup.mjs` (or
`python .ariadne/setup.py`) installs hooks in every workspace repo, writes
gitignores, and builds the initial index on Windows/mac/Linux; the extension
uses these instead of bash and passes env through VS Code's terminal API
(PowerShell-safe). Hook bodies are POSIX sh, which Git-for-Windows executes
with its bundled shell. The .sh installers remain for mac/Linux/Git-Bash CLI use.

**Pass scoping:** the Kafka/DB/HTTP/Lombok passes now cache per-file constants
and entity maps (keyed by content hash) and, on incremental runs, re-extract
rows only for repos with changes — logged as "Passes scoped to N/M repos".
A semantic change to any application config, constant, or entity mapping
automatically widens back to a full pass, so cross-repo correlation can never
go stale.


## LLM semantic layer
`node .ariadne/enrich.mjs` (or `python3 .ariadne/enrich.py`) applies an LLM on
top of the graph: per-module and per-hotspot-file insight summaries built from
graph-derived prompt packs (outlines, callers, topics, tables, endpoints — not
raw files), stored hash-keyed in the index and served to agents via the new
`explain` MCP tool (with staleness flags) plus docs/generated/insights.md.
Token economics: each target costs tokens exactly once per content change —
CI re-runs are near-free. Providers: Anthropic, any OpenAI-compatible endpoint
(set OPENAI_BASE_URL to a local Ollama/vLLM for fully-offline enrichment), or
--provider mock (deterministic, used by the self-tests). Opt-in and off by
default; the CI job runs it only when a key variable is present. This is the
one feature with an LLM in the write path — everything else stays deterministic.

## Copilot insights, plugin architecture, and updates
**Copilot as the insight provider:** `AEGIS: Enrich Insights via Copilot` runs
the enrichment loop through VS Code's Language Model API against your existing
Copilot subscription — consent-prompted, no API keys, hash-cached like every
provider. Under the hood it's `enrich --plan` → Copilot → `enrich --apply`, so
any external driver can implement the same loop. Additionally the new
`save_insight` MCP tool lets any agent persist synthesized understanding
directly ("study the billing module with the graph tools, then save_insight"),
served back by `explain` with automatic staleness.

**Plugin architecture:** indexer passes, MCP tools, doc generators, insight
providers, skills, and agents are all drop-in extensible — see EXTENDING.md.
A working TODO-scanner sample (pass + tool, both editions) ships in
payload/extensions-samples/ and is exercised by the self-test suite.

**Updates:** `AEGIS: Update Workspace Payload` overwrites AEGIS-managed files
from the installed extension version while preserving aegis.json,
.ariadne/config.json, your extensions/, the index, and Delphi knowledge —
solving the "install once, stuck forever" upgrade gap.


## Gradle, Kotlin AST, and seam extractors
**Gradle:** scip-java autodetects Gradle (build.gradle/.kts, using ./gradlew if
present) exactly as it does Maven — the CI job needs no changes beyond a JDK.
build.gradle and *.kts files are indexed, so search_code finds dependency
declarations.

**Kotlin:** first-class AST via the tree-sitter Kotlin grammar in both
editions — classes/objects, methods nested under their class, and call-graph
edges (fun handle -> repo.find), same as Java. .kts covered. All the
regex-based seams (Kafka/DB/HTTP annotations) already matched Kotlin syntax.

**Seam extractors (pluggable gap-5):** `.ariadne/extensions/*.extract.*`
modules export per-hook functions whose rows are inserted into the NATIVE
graph tables — so a house framework's messaging or routing shows up in
message_flow/db_map/http_map, docgen diagrams, and orphan warnings with zero
core changes. A working Spring Cloud Stream extractor ships as the sample and
runs in the self-test suite; gateway rewrites, gRPC service maps, and GraphQL
resolvers follow the same ~30-line pattern.


## Decision memory — Mnemosyne
Gap 6 (Graphiti-style decision memory) implemented with the architecture
inverted for privacy: git-versioned ADR markdown is the source of truth, a
deterministic pass builds a temporal index (decided_at / valid_until /
superseded_by, resolved from Supersedes: headers), and decision→artifact links
are cross-referenced against the live graph (topics, tables, modules). Copilot
is the intelligence layer through three MCP tools, using only your existing
seats: `decisions` (filter by text/target/status, time-travel via as_of),
`decision_trace` (full supersession lineage + drift check — flags decisions
governing topics/tables that no longer exist), and `save_decision` (captures a
choice settled in chat as a numbered ADR file + instant index entry — "we just
decided to use the outbox pattern, record it"). docgen emits decisions.md and
agent-context lists standing decisions so agents implement WITH the decision
record, not against it. No graph database, no extraction API keys, zero egress.

## Production hardening
- **Workspace Trust:** the extension will not auto-register a workspace's MCP
  server, install, or run setup while VS Code is in Restricted Mode; it
  activates automatically when trust is granted. (Extensions in
  .ariadne/extensions/ execute with your privileges by design — review them
  like any code in your repo.)
- **Corruption auto-recovery:** a corrupt index is detected via PRAGMA
  quick_check, moved aside as index.db.corrupt-<ts>, and rebuilt fresh —
  verified by a self-test that feeds the indexer a garbage file.
- **Log rotation:** .ariadne/index.log is truncated to its last 512 KB once it
  exceeds 5 MB, at process start.
- **Updates refresh dependencies:** AEGIS: Update Workspace Payload now runs
  npm install / pip install -r after copying, so new payload versions that add
  libraries don't break until manual intervention.
- **Suite depth:** the self-tests now also cover corruption recovery, the SCIP
  compiler-grade layer (via a generated protobuf fixture asserting a
  cross-stack definition→reference pair), and an MCP smoke test — a real
  protocol round-trip on the node edition (tool inventory + a decisions query)
  and module-surface calls on python. 59 assertions per edition.

Known remaining items (tracked, not blockers): first Windows verification
happens on your GitHub push (matrix is ready); large-repo (100k+ LOC)
benchmarking — note the correlation pass holds changed-scope file texts in
memory; the anthropic/openai HTTP provider paths in enrich are exercised only
by the mock in CI; marketplace publishing; and schema DOWNGRADES require
--rebuild (upgrades migrate automatically).


## Ergonomics skills
Six skills that exist to make the toolkit usable without memorizing twenty-one
tool names. Each encodes a tool sequence plus the house rules for this stack:
codebase-orientation (the cheapest-first lookup ladder), change-impact-analysis
(cross-seam blast radius before any edit, including a decisions check that halts
on conflict), flow-tracing (end-to-end hops, with a debug mode that ranks
suspects and names the blind spots static analysis cannot see),
safe-schema-change (Liquibase first, verify with db_map, no drift = done),
event-contract-change (no hardcoded topic literals, consumers consulted before
a payload change, verified with message_flow), and aegis-help (routing plus
self-diagnosis when the tools misbehave).

They are wired into copilot-instructions, so Copilot reaches for them from the
phrasing of a request without being told. The self-test suite validates every
skill's frontmatter, name/directory agreement, and description quality — twelve
skills, five agents.


## Three more agents
The roster covered building, reviewing, auditing, documenting, and indexing —
but nothing owned the three activities a team actually spends its week on
besides writing new features.

- **asclepius** — diagnosis. Reproduce, map the expected path from the graph,
  walk back to the last known-good hop, form competing hypotheses and try to
  *disprove* the leading one, fix the cause, prove it, then check what else the
  fault was quietly corrupting. Knows the blind spots static analysis has
  (transaction boundaries, serialization mismatches, per-profile config) and
  checks them by hand.
- **hephaestus** — refactoring and migration, behavior-preserving by mandate.
  Inventory from compiler-grade find_references rather than grep; expand /
  migrate / contract as the default strategy; every increment ends green; the
  old surface is deleted only when proven dead; contracts (message_flow, db_map,
  http_map) must be identical before and after. Stops cleanly rather than
  leaving a half-migration.
- **metis** — architecture counsel. Grounds options in the codebase via the
  graph, checks standing ADRs before contradicting them, gives at least two real
  options with costs and blast radius, recommends with the one sentence that
  decides it, states what would change its mind — and then calls save_decision
  so the reasoning survives. This is what makes the decision-memory layer
  actually get used; a capture tool nobody remembers to call is dead weight.

Eight agents total. The count is deliberate: an agent earns an @name only when
the work runs long and its stance would conflict with another agent's.

## Where the graph lives, and what gets reused

The graph is a file: `.ariadne/index.db`. Nothing rebuilds it from scratch
unless you run `--rebuild` explicitly.

- **Locally** it persists across editor restarts, reboots, and chat sessions.
  The MCP server opens it read-only and contains no indexing code at all — it
  cannot build a graph, only read one. Git hooks keep it current incrementally
  (a changed file is tens of milliseconds); `--full` is a refresh, not a
  rebuild, and reindexes zero files on an unchanged tree.
- **Across the team**, CI publishes `.ariadne/index.db` and `docs/generated/`
  as artifacts on every default-branch merge. `pull-index.sh` (or the *Pull Team
  Index* command) fetches it, so a new clone gets the complete graph — SCIP
  layer included, which is the expensive part — in seconds rather than building
  it locally.
- **In CI**, the job now caches the index between runs (`cache.key:
  aegis-index-$CI_DEFAULT_BRANCH`), so each pipeline reindexes only what the
  merge actually changed. A cold or corrupt cache is harmless: the job builds a
  fresh index and carries on.
- **Forever**, in git: the generated markdown, the ADRs (`docs/adr/`), the
  knowledge base, and the feature specs are plain text and committed. They
  outlive the index, the toolkit, and the tooling entirely.


## Context budget on large codebases

The index itself never enters context — only tool results do — so index size is
free. What is not free is a tool that returns everything, so nothing does:

- `message_flow`, `db_map`, and `http_map` called with no filter return a
  **summary** past `summaryThreshold` (40 items): counts, the complete warning
  lists, and the busiest items, plus a pointer to query one item at a time.
  Measured on a 120-topic / 90-table / 150-endpoint fixture: 1.5 KB instead of
  26.8 KB, with every orphan and drift warning preserved.
- **Warnings are kept first and never dropped by truncation.** A truncated dump
  that discarded the drift warning would be worse than useless.
- Every tool result is capped at `maxToolRows` (50) and `maxToolBytes` (24000),
  reporting `showing X of Y` so the model narrows instead of assuming.
- `agent-context.md` stays ~30 lines regardless of workspace size.
- Generated docs past `maxDocItems` (60) carry a banner telling agents to query
  the tool rather than read the file; diagrams cap at `maxDiagramNodes` (30),
  because a 200-node Mermaid chart is unreadable anyway.

All of it is tunable in `.ariadne/config.json`. The self-test suite includes a
scale fixture and asserts summarization, warning survival, and the byte cap.

## Performance and focused context

Measured on a synthetic 2,000-file Java repo:

| | before | after |
|---|---|---|
| Cold full index | 6,164 ms | **3,675 ms** |
| Incremental, 1 code file changed | 718 ms | **360 ms** |
| Incremental, docs-only commit | 718 ms | **251 ms** |
| Files re-extracted for Kafka/DB/HTTP on a 1-file change | **all 2,000** | **1** |

What changed:

- **Transaction batching.** The write path had no `BEGIN`/`COMMIT`, so every INSERT
  was its own fsync. The whole pass is now one transaction (with ROLLBACK on error).
- **SQLite pragmas**: `synchronous=NORMAL` (safe for a rebuildable derived index),
  a 64 MB page cache, in-memory temp store, and a 256 MB mmap.
- **File-level extraction scoping.** The correlation passes used to re-read every
  Java/TS file in a changed *repo* — useless on a monolith, which is one repo. They
  now re-extract only the files whose content hash actually moved, tracked in
  `extract_cache`. A change to a config value, topic constant, or entity mapping
  still widens automatically to a full re-extract, because those can alter how every
  other file resolves. This is the change that matters at 20k files: extraction is
  now O(changed) rather than O(repo).
- **Lazy AST engine.** The tree-sitter WASM runtime (~107 ms) only initializes when
  a file in a parseable language actually changed, so docs-only commits skip it.

For focus:

- **`context_pack`** — one call assembles everything needed to start work on a
  target: outline, callers, blast radius, the Kafka topics / tables / endpoints it
  touches, the ADRs governing those, and any cached insight. Replaces six or more
  round trips with a single sub-1 KB result. Each MCP round trip costs a model turn
  plus the call-and-result tokens, so bundling is a real saving, not a cosmetic one.
- **`search_code` attributes each hit to its enclosing symbol** (`in_symbol:
  "UserService.findById"`), so a result is actionable without opening the file.
  Results are BM25-ranked with FTS5 snippets.


## Graph augmentation (assistant-derived facts)

Static analysis cannot evaluate code, so runtime-assembled topics, tables, and
routes are blind spots. Three tools close the loop:

- **`graph_gaps`** — the graph's own to-do list: unresolved expressions (reported
  as partials like `orders.created.{?}` rather than guesses), orphan topics and
  endpoints, drift tables, each with file:line and why it could not be resolved.
- **`assert_edge`** — records a fact an assistant derived by reading the code, with
  mandatory evidence. Written to `docs/graph-assertions.json` (git-committed,
  reviewed in PRs, exactly like an ADR) and loaded into the graph on the next index.
- Provenance columns on every seam row (`static` vs `asserted:<author>`), surfaced
  in every tool as `[ASSERTED — derived, not parsed]`. Derived facts are never
  silently mixed with parsed ones, and each carries the hash of its evidence file so
  it is flagged STALE when that file changes.

The `graph-augmentation` skill teaches the workflow and, importantly, when not to
assert: never from naming alone, and never to silence a warning, because an orphan
topic is often a genuine bug.

Two real bugs were found building this, both now covered by tests: the Kafka
extractor used to pull a string literal out of a concatenation and record it as a
resolved topic (so `PREFIX + "." + env` became a topic named `.`), and `--rebuild`
cascade-deleted every correlation row without clearing the extraction cache, so the
passes concluded "nothing changed" and rebuilt into an empty graph.


## Skills: twelve, not thirteen

`codebase-knowledge` has been folded into `codebase-orientation`. They both said
"read the knowledge base before you read source", which is exactly the duplication
that makes a toolkit feel heavier than it is. Orientation now owns the full lookup
ladder (agent-context → generated docs → graph tools → knowledge base → source, and
only then) plus the duty to keep the knowledge base truthful after a change.
