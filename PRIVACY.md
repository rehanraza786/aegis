# AEGIS Data Locality & Privacy

AEGIS is local-first by design. This document states exactly where every
artifact lives and what network calls exist, so you can verify the claims.

## Everything AEGIS produces stays on your machines / in your repo

| Artifact | Location | Leaves your control? |
|---|---|---|
| Ariadne code graph (`index.db` + WAL/log/lock) | `.ariadne/` — **gitignored**, per-clone | Never. Local SQLite; MCP over stdio to your own editor process only. |
| SCIP compiler indexes (`*.scip`) | repo working dir / CI job workspace | Never leaves your GitLab/GitHub infrastructure. |
| Delphi knowledge base | `.github/knowledge/` — committed to **your** repo by default | Only to your own repo. Add it to `.gitignore` if you prefer per-machine. |
| Spec/plan/tasks/review artifacts | `docs/features/` in your repo | Your repo only. |
| Team-shared index | CI job artifact in **your** GitLab/GitHub project | Your CI storage only. |
| Extension state | VS Code globalState (a "shown the welcome prompt" flag) | Local. |

## Network calls — complete list

- **Dependency installation only**: `npm install` / `pip install` fetch public
  packages (better-sqlite3, MCP SDK, protobuf) from the standard registries.
  Air-gapped teams can vendor these or use an internal mirror.
- **`pull-index.sh`**: talks exclusively to *your* GitLab/GitHub instance to
  download *your* CI artifact. No third parties.
- **That's all.** No telemetry, no analytics, no update pings, no external
  APIs. The MCP server binds to nothing — it's stdio, spawned by your editor.
- Model traffic (Copilot itself) is governed by your GitHub Copilot
  subscription and settings, not by AEGIS. AEGIS reduces what needs to be
  sent by answering structural questions locally.

## The ONE opt-in exception: LLM enrichment

`enrich.mjs` / `enrich.py` is the only AEGIS component that can send data to an
LLM API — and only graph-derived prompt packs (symbol names, topic/table/endpoint
lists, ~1-2 KB each), never raw file contents. It is OFF by default: it runs only
if you explicitly set ANTHROPIC_API_KEY or OPENAI_API_KEY (locally or in CI).
For zero-egress enrichment, point OPENAI_BASE_URL at a local model server
(Ollama, llama.cpp, vLLM) — then even this feature never leaves your machines.
Everything else in this document remains true unconditionally.

## Decision memory (Mnemosyne) and privacy

Decision capture is pure local file I/O: `save_decision` writes ADR markdown
into YOUR repo and updates the local index — no model call is made by the tool
itself. When Copilot uses these tools in chat, the reasoning happens inside
your existing Copilot session (governed by your GitHub agreement, same as all
your editor context); AEGIS adds no additional data path.

## Verifying

grep the codebase: the only `fetch`/`curl`/http usage is in `pull-index.sh`
(your own CI) and the CI job (package downloads). The extension's only
imports are `vscode`, `fs`, and `path`.
