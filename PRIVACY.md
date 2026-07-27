# Privacy

AEGIS runs on your machines. This file says exactly where everything it produces
lives, and exactly what talks to the network, so you can check rather than trust.
Every claim here is meant to survive a grep. If one does not, that is a bug, and
I would rather hear about it than have you assume the rest is true.

## Where everything lives

| What | Where | Committed? |
|---|---|---|
| The graph (`index.db`, plus its WAL, log, and lock) | `.ariadne/` | No. Gitignored, per clone, rebuildable. |
| SCIP compiler indexes (`*.scip`) | build workspace, or the CI job | No, and they never leave your CI. |
| Cached insight summaries | inside `index.db` | No. Local, and only exist if you turn enrichment on. |
| Graph assertions | `docs/graph-assertions.json` | Yes, deliberately. Reviewed in PRs like any other change. |
| Decisions (ADRs) | `docs/adr/` | Yes. That is the whole point of them. |
| Knowledge base (Delphi) | `.github/knowledge/` | Yes by default. Gitignore it if you would rather it stayed per machine. |
| Specs, plans, tasks, reviews | `docs/features/` | Yes. |
| Generated docs | `docs/generated/` | Your choice. Gitignored by default, since they regenerate on every commit. |
| Extension state | VS Code globalState | Local. It stores one flag: whether you have seen the setup prompt. |

The graph is a local SQLite file. The MCP server talks to your editor over stdio
and does not bind a port, so there is nothing listening and nothing to reach.
The graph view is a VS Code webview whose Content-Security-Policy is
`default-src 'none'` with nonce-gated scripts and resources pinned to the
extension's own `media/` directory — it cannot fetch, beacon, or open a socket
even if handed hostile content. One honest footnote: the Node edition's
`node_modules` VENDORS the MCP SDK, whose optional HTTP/SSE transports pull in
packages like `express` and `eventsource` as transitive dependencies. AEGIS
never constructs those transports — the code is inert on disk, only the stdio
transport is ever instantiated, and the suite's egress gate (below) would fail
if that changed.

## What talks to the network

Three things, and only three.

**1. Installing dependencies.** `npm install` or `pip install` pulls public packages
from the standard registries when you set the toolkit up. If you are air gapped, vendor
them or point at an internal mirror.

**2. `pull-index.sh`.** Downloads the index your own CI built, from your own GitLab or
GitHub. No third party is involved. The CI job itself also pulls packages and, if you
enable the SCIP step, downloads `coursier` from GitHub to run `scip-java`.

**3. Enrichment, which is off unless you turn it on.** This is the only part of AEGIS
that can send anything to a model API, and it is worth being precise about it:

- It runs only if you set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or invoke it through
  Copilot. With no key set, `enrich` refuses to run and says so.
- What it sends is a prompt pack built from the graph: symbol names, topic names, table
  names, endpoint paths. A kilobyte or two. It does not send file contents.
- `enrich.mjs` and `enrich.py` are the only files in the toolkit that call `fetch` or an
  HTTP endpoint. They reach `api.anthropic.com` or `api.openai.com`, or whatever you
  point `OPENAI_BASE_URL` at.
- Point `OPENAI_BASE_URL` at a local model (Ollama, llama.cpp, vLLM) and even this sends
  nothing off the machine.

There is no telemetry, no analytics, no update check, no crash reporting, and no
usage counter. Not disabled by default: absent. There is nothing to opt out of.

## What about Copilot itself

When you use the graph tools in Copilot Chat, the conversation goes to GitHub under
your existing Copilot agreement, exactly as it already does for every file you have
open. AEGIS does not add a data path, and it does not intercept one.

If anything, it reduces what gets sent: an assistant that can ask `blast_radius` a
question does not need to page six files into its context to guess at the answer.

The "Enrich Insights via Copilot" command works the same way. It goes through VS Code's
Language Model API, inside your Copilot session, using seats you already pay for. No
API key, and no new destination.

Decision capture (`save_decision`) and graph assertions (`assert_edge`) are pure local
file writes. The tools themselves call no model.

## Check it yourself

The point of this file is that you should not have to take my word for it.

    # Every network call in the toolkit. You should see enrich (opt-in) and
    # pull-index (your own CI), and nothing else.
    grep -rn "fetch(\|https://\|curl " payload/ariadne-node/*.mjs payload/ariadne-python/*.py payload/*.sh

    # Every hit lands in exactly four files: enrich.mjs and enrich.py (the
    # opt-in enrichment CLI, covered above), pull-index.sh (your own CI), and
    # install-hooks.sh — a nodejs.org link inside an error message telling you
    # to go install Node. If a hit appears in ANY other file, that is a bug.
    #
    # You do not have to run this by hand: the self-test suite opens with an
    # egress gate (tests/run_tests.py) that sweeps payload/ AND extension/
    # (vendored webview bundles included) for network-capable primitives and
    # FAILS if anything outside enrich.*/pull-index.sh matches — plus checks
    # that both servers construct only the stdio transport and that the
    # webview CSP still reads default-src 'none'. "Code never leaves the
    # machine" is a CI assertion, not a promise.

    # What the extension imports. vscode, fs, path, child_process (to run the
    # indexer in a terminal), and os (for a temp file during Copilot enrichment).
    grep -n "require(" extension/extension.js

    # The server binds nothing. It is stdio only.
    grep -rn "listen(\|createServer\|bind(" payload/ariadne-node/server.mjs

If you find something this file does not account for, that is a bug worth reporting.
