# Setup

The README covers what AEGIS does and how a developer uses it day to day. This file
covers running it: installing, wiring up CI, configuring it, and the handful of
things that are specific to a Java/Spring stack.

## Requirements

Git, and one of Node 18+ or Python 3.10+. VS Code 1.99 or newer registers the MCP
server with Copilot automatically; older versions fall back to a generated
`.vscode/mcp.json`, which works but needs a click to start the server.

The two runtime editions are at feature parity. Node is somewhat faster. Python has
no native dependencies, which matters if your environment blocks them: if
`better-sqlite3` will not build, or a binary dies with `bus error`, install with
`--runtime=python` and it will work.

## Installing

Most people should use the extension. Run **AEGIS: Install into Workspace** from the
command palette, or accept the prompt when you open a workspace that has not been set
up. It copies the skills, agents, and the Ariadne server in, then offers to run the
terminal step that builds the index and installs git hooks.

If you would rather do it from a shell, or you are scripting it:

    bash install.sh                      # defaults: Ariadne, Node edition, hooks on
    bash install.sh --runtime=python     # no native dependencies
    bash install.sh --engine=code-graph  # use an external graph server instead
    bash install.sh --no-hooks           # skip the git hooks
    bash install.sh --no-graph           # skills and agents only, no graph server

Both paths are idempotent and neither overwrites a file you have edited.

## What lands in the repo

    .ariadne/                   the server, the indexer, and index.db (gitignored)
    aegis.json                  which graph engine backs the tools
    .github/skills/             twelve skills
    .github/agents/             eight agents
    .github/knowledge/          the prose knowledge base (Delphi), if you build one
    .github/copilot-instructions.md   gets a routing section appended
    docs/adr/                   decisions, once you start recording them
    docs/features/              spec, plan, tasks, review per feature
    docs/generated/             regenerated on every commit and merge (gitignore it)
    gitlab-ci-aegis.yml         the CI job, to merge into your pipeline

The index is a local build artifact and is gitignored. Everything else is text you
review in pull requests like any other change.

## Git hooks

The setup step installs `post-commit`, `post-merge`, and `post-checkout` hooks in
every repo in the workspace. They run an incremental index and regenerate the docs in
the background, so they never block a commit. A one-file change takes a few hundred
milliseconds.

They refresh on commit, not on save. Uncommitted work is not in the index, which is
worth knowing when an answer looks stale.

## CI, and sharing one index across the team

Merge the `aegis-index` job from `gitlab-ci-aegis.yml` into your pipeline. On merges
to the default branch it builds the index, runs `scip-typescript` and `scip-java` for
the compiler-grade layer, generates the docs, and publishes `.ariadne/index.db` and
`docs/generated/` as artifacts. It caches the index between runs, so each pipeline
only reindexes what the merge actually changed.

Teammates then pull that artifact instead of building it locally:

    bash .ariadne/pull-index.sh          # or the "AEGIS: Pull Team Index" command

This matters mostly because of SCIP. The AST index builds in seconds on any machine,
but `scip-java` compiles your project, and nobody wants to do that on their laptop to
get better autocomplete for an AI. Build it once in CI, share the result.

Two blocks in the job are commented out until you want them. One commits
`docs/generated/` back to the branch so the docs are visible in the repo rather than
only in artifacts. The other runs the enrichment pass, and is guarded on an API key
being present, so it stays inert unless you opt in.

The job needs a JDK in the image for `scip-java`, which autodetects both Maven (a root
`pom.xml`) and Gradle (`build.gradle` or `.kts`, using `./gradlew` when present).
Nothing else to configure for either build system.

## Configuration

**`aegis.json`** at the repo root picks the graph engine:

    { "graphEngine": "ariadne" }

Set it to `codebase-memory`, `code-graph`, or `custom` (with an `mcp` block giving the
command and args) to run an external MCP graph server instead. The skills and agents
do not care which engine answers; swapping is a one line edit and a reload.

**`.ariadne/config.json`** tunes the indexer and the size of tool results:

    {
      "skipDirs": ["node_modules", "target", "dist", "build"],
      "aliasPrefixes": ["@/", "~/"],
      "extraExtensions": [".vue"],
      "maxFileBytes": 1000000,
      "chunkLines": 60,
      "tableNameOverrides": { "OrderEntity": "ord_orders" },

      "maxToolRows": 50,
      "maxToolBytes": 24000,
      "summaryThreshold": 40,
      "maxDiagramNodes": 30,
      "maxDocItems": 60
    }

The last five control how much a tool is allowed to return. Past
`summaryThreshold` items, an unscoped `message_flow`, `db_map`, or `http_map` returns
a summary with the complete warning lists rather than an exhaustive dump. Everything
is capped at `maxToolRows` and `maxToolBytes` regardless. Warnings are always kept
first and are never dropped by truncation, so a truncated result has not hidden a
drift or an orphan from you.

**VS Code settings:** `aegis.runtime` (`node` or `python`) and
`aegis.autoRegisterAriadne`.

**Environment:** `ARIADNE_ROOTS` (comma separated repo paths, which the extension sets
for you in a multi-root workspace), `ARIADNE_HOME` (where `.ariadne/` lives), and for
enrichment, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AEGIS_MODEL`.

## Notes for a Spring stack

**Custom naming strategy.** If you use a Hibernate `PhysicalNamingStrategy`, the
indexer cannot execute your Java to work out what a table is called. Declare the
mappings once in `tableNameOverrides` and the data map will resolve correctly.

**Spring profiles are flattened.** Every `application-*.yaml` merges into one map, so
if a topic or table name differs per profile, the correlation can pick the wrong one.
Worth knowing before you trust a result that looks odd.

**Spring Cloud Stream** functional bindings are not handled by the core, but a working
extractor ships in `payload/extensions-samples/`. Copy it into `.ariadne/extensions/`
and functional `@Bean Consumer`/`Supplier` beans start showing up in `message_flow`
like any other producer or consumer. The same thirty-line shape covers a gateway that
rewrites paths, gRPC, or GraphQL. See EXTENDING.md.

**Lombok** is handled: entity detection reads the whole annotation block, so `@Table`
above `@Entity` under a stack of `@Getter @Setter @Builder` resolves correctly, and
the members Lombok generates at compile time are synthesized into the graph so
`find_symbol` can see them.

## Updating

**AEGIS: Update Workspace Payload** copies a newer version of the skills, agents, and
server over the installed ones, and refreshes their dependencies. It preserves
`aegis.json`, `.ariadne/config.json`, your extensions, the index, and the knowledge
base. Rebuild the index afterwards if the schema changed.

## Running the tests

    python3 tests/run_tests.py --runtime node
    python3 tests/run_tests.py --runtime python

Each builds a six repo fixture workspace from scratch and asserts around seventy
behaviors end to end. CI runs both against ubuntu and windows on every push.

## Troubleshooting

**The tools do not appear in Copilot.** Check you are on VS Code 1.99 or newer, then
check the workspace is trusted. AEGIS deliberately will not auto-register a server
from an untrusted workspace, because that would mean running whatever code a freshly
cloned repo happened to contain.

**Answers look stale.** Call `index_status`. If it reports `fresh=false`, either the
hooks are not installed (look for `.git/hooks/post-commit`) or the work is not
committed yet. **AEGIS: Rebuild Index**, or `reindex` from chat.

**A tool says there is no data for a layer.** The index predates that capability.
Rebuild it: `node .ariadne/indexer.mjs --rebuild`, or the palette command.

**npm cannot build `better-sqlite3`, or a binary dies with `bus error`.** Your
environment is blocking native code. Reinstall with `--runtime=python`, which has none.

**`database is locked`.** Two indexers raced. The lock clears itself after ten
minutes; delete `.ariadne/.index.lock` if you are impatient.

**A Kafka topic does not correlate.** Run `graph_gaps`. If it appears under
`unresolved_topic_expressions`, the name is assembled at runtime and static analysis
cannot evaluate it. Either hoist it to a constant or a config key, or have the
assistant work it out and record the answer with `assert_edge`.

**A table shows as DRIFT but you know the changelog exists.** It is probably in a repo
that is not part of the indexed workspace, or the changeset uses a Liquibase feature
the parser does not cover. `db_map` shows you what it did find.

Logs are in `.ariadne/index.log`, rotated at 5 MB.
