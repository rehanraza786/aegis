# AEGIS

A local codebase graph, a set of MCP tools, and a handful of skills and agents that make GitHub Copilot behave like it actually knows your repositories.

Built for Java/Kotlin on Spring Boot, TypeScript/React, Kafka, Liquibase, Lombok, and multi-repo VS Code workspaces. Everything runs on your machine. No telemetry, no accounts, no API keys required.

## What it does

Copilot in agent mode is capable but blind. Ask "who consumes `payments.completed`?" and it can't answer, because the producer uses a constant, the consumer resolves the topic from a YAML placeholder, and the two services live in different repos. So it guesses, and you find out in review.

AEGIS indexes all of that up front — statically, in about a second — and serves it to Copilot over MCP. It correlates Kafka producers with consumers across repos, maps Liquibase changesets to the code that touches each table (flagging schema drift), matches React `fetch`/`axios` calls to the Spring endpoints they hit, synthesizes Lombok's generated members, and answers "what breaks if I change this?" with exact file paths and line numbers.

It then generates architecture docs, flow diagrams, and a stakeholder progress report from the same graph — deterministically, with zero LLM tokens.

## Getting started

1. Run **`AEGIS: Install into Workspace`** from the Command Palette (or accept the prompt when you open a workspace).
2. Approve the terminal step. It builds the index and installs git hooks.
3. Open Copilot Chat in agent mode. The tools are already there.

Then just ask questions: *"What breaks if I change OrderService?"* · *"Who consumes payments.completed?"* · *"Which frontend code calls /api/orders?"* · *"Why did we choose Kafka — is that still current?"*

You don't need to learn the tool names. Twelve skills encode the right sequence for you, and Copilot picks them up from how you phrase the request:

- *"I'm new here, how does billing work?"* → an orientation brief
- *"What breaks if I change this?"* → cross-seam impact analysis (code, Kafka, DB, HTTP, and any ADR that governs it)
- *"The order was placed but billing never charged it"* → traces the hops and ranks where the chain broke
- *"Add a column to payments"* → Liquibase changeset first, then the entity, then verified against the graph
- *"Publish an event when an order ships"* → no hardcoded topics; consumers checked before the payload changes

For bigger work, hand off to an agent:

`@daedalus` build a feature end to end · `@asclepius` something is broken, diagnose it · `@hephaestus` rename/extract/migrate without changing behavior · `@argus` peer-level review · `@metis` weigh a design choice, then record the ADR · `@themis` audit code against specs · `@hermes` flow documentation · `@pythia` knowledge base.

## Commands

Install into Workspace · Install Skills & Agents Only · Rebuild Index · Index Status · Pull Team Index · Generate Flow Docs & Progress Report · Enrich Insights via Copilot · Update Workspace Payload.

## Requirements

git, and either Node ≥18 or Python ≥3.10 (the Python edition is pure-stdlib and runs in locked-down environments where native binaries are blocked). VS Code ≥1.99 registers the MCP server automatically; older versions fall back to a generated `.vscode/mcp.json`.

## Settings

- `aegis.runtime` — `node` or `python`.
- `aegis.autoRegisterAriadne` — hand the graph server to Copilot automatically.

MIT licensed. Full documentation, extension points, and the self-test suite are in the repository.
