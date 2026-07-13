---
name: codebase-orientation
description: Get up to speed on an unfamiliar codebase, repo, module, or service quickly and cheaply, using the AEGIS graph and knowledge base instead of scanning source. Use on a first day, when picking up work in a module you haven't touched, before estimating, when someone asks "how does this system work", or any time you would otherwise start opening files at random to build a mental model. Also covers keeping the knowledge base truthful after you change something. Produces a written orientation brief with structure, seams, risks, and standing decisions.
---

# Codebase Orientation

Build an accurate mental model of a system in a handful of tool calls, without
reading source files. Reading files to orient yourself is the single most
expensive habit an assistant has; this skill replaces it with a fixed lookup
ladder. Follow the ladder in order and stop as soon as the question is answered.

## The ladder (cheapest first — never skip a rung)

1. **`docs/generated/agent-context.md`** — read this first, always. ~100 lines:
   modules, Kafka topics, database tables, REST endpoints, high-risk files,
   standing decisions, house rules. If it exists and is fresh, most orientation
   questions are already answered here.
2. **The other generated docs**, only the one you need:
   `architecture.md` (module map, dependencies, hotspots), `message-flows.md`
   (Kafka), `data-map.md` (schema + drift), `http-map.md` (REST seams),
   `decisions.md` (why things are the way they are).
3. **Graph tools** for anything the docs don't cover — `module_map`,
   `hotspots`, `file_outline`, `find_symbol`, `explain`.
4. **`.github/knowledge/`** (Delphi) — the prose knowledge base, if the repo has one.
   Read `INDEX.md` first (it is a router: project summary, module table, "where to
   find things"), then only the `modules/<module>.md` you need. A few hundred tokens
   here replaces tens of thousands spent rediscovering the same facts from source.
5. **Source files** — last, and only the specific ones the rungs above pointed
   you at. Never browse.

If the generated docs are missing or stale (check the timestamp in their header,
or call `index_status`), say so and offer to run docgen. Do not silently fall
back to reading the whole repo.

## Procedure

**Step 1 — Scope the request.** "Orient me on the billing service" and "how does
this whole system work" need different depths. Decide which, and say which you
chose.

**Step 2 — Structure.** `module_map` for the shape of the workspace (modules,
sizes, languages). `hotspots` for the files everything depends on — these are
where the important abstractions live, and where mistakes are expensive.

**Step 3 — Seams.** Run whichever apply:
- `message_flow` — what events this system publishes and consumes. Note orphan
  warnings; they are usually either dead code or a missing repo in the index.
- `db_map` — what tables it owns, reads, and writes. Note DRIFT warnings.
- `http_map` — what it exposes and who calls it.

These three answer "how does this thing talk to the rest of the world", which is
90% of understanding a service.

**Step 4 — Intent.** `explain <module>` for the cached summary if one exists.
`decisions` for the standing architectural decisions that govern it — read these
before forming opinions, because a design that looks wrong is often a decision
that was made deliberately and is recorded.

**Step 5 — Write the brief.** Do not just dump tool output. Synthesize.

## Output: the orientation brief

```
## <System / module> — orientation

**What it is.** Two or three sentences. Purpose, not implementation.

**Shape.** Modules and how they depend on each other. Where the entry points are.

**How it talks.**
- Publishes / consumes: <topics, with the sites>
- Owns / reads / writes: <tables>
- Exposes / calls: <endpoints>

**Load-bearing code.** The hotspots, and what they're for. Touch these carefully.

**Standing decisions.** ADRs that govern this area, with what they mandate.

**Watch out for.** Drift warnings, orphan topics, unresolved expressions,
anything the graph flagged. These are real findings, not noise.

**Open questions.** What the graph could not tell you and where you'd have to
look. Be explicit rather than guessing.
```

## Keep it truthful

If you change a module's public surface, its dependencies, or the way it works, the
knowledge base and the generated docs are now slightly wrong — and a stale map is
worse than no map, because it will be trusted. Update `.github/knowledge/<module>.md`
in the same change, and re-run docgen (the git hooks do this automatically on commit).
If the knowledge base is missing or badly out of date, say so and offer to run the
pythia agent rather than quietly working around it.

## Rules

- Cite `path:line` for anything specific. An orientation brief without locations
  is a rumor.
- If a drift or orphan warning appears, surface it. You are the first person to
  look at this system with fresh eyes and a map; that is exactly when these get
  caught.
- Never assert that something "isn't used anywhere" without `find_references`
  (SCIP, compiler-grade) — the name-matched call graph over-reports and
  under-reports, and a confident wrong claim here is worse than silence.
- Keep the brief under ~60 lines. Density is the deliverable.
