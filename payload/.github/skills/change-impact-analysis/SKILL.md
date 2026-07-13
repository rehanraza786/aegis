---
name: change-impact-analysis
description: Work out exactly what a proposed change will affect BEFORE writing any code — across code dependencies, Kafka topics, database schema, HTTP contracts, and standing architectural decisions. Use before modifying anything shared (a service, an entity, a DTO, a topic payload, an endpoint, a table), when estimating a change, when asked "what will this break", or as the first step of any non-trivial implementation. Produces a written impact assessment with a risk-ordered checklist.
---

# Change Impact Analysis

The purpose of this skill is to make the failure mode of AI-assisted
development — confidently changing something whose consequences you cannot see —
structurally impossible. Run this BEFORE the first edit, not after the tests go
red.

The output is an assessment, not code. Do not start implementing partway through.

## Procedure

**Step 1 — Name the target precisely.** A file, a class, a method, a table, a
topic, or an endpoint. If the request is vague ("change how orders work"), narrow
it with `find_symbol` / `search_code` first, and state what you settled on.

**Step 2 — Code impact.**
- `blast_radius <file>` — every file that transitively depends on it. This is
  the outer bound of what can break at compile time.
- `find_callers <symbol>` — direct callers of the specific thing you're touching.
- `find_references <symbol>` — the compiler-grade version (SCIP). Use this rather
  than `find_callers` whenever you are about to claim something is or isn't used.
  The AST call graph is name-matched and will lie to you at the margins.
- `hotspots` — if the target appears here, treat the whole change as high-risk
  and say so.

**Step 3 — Contract impact.** Any of these that apply. Do not skip them because
"it's just a rename" — renames are exactly what break contracts.

- **Kafka.** `message_flow <topic>` if the change touches an event, a payload
  class, or a producer/consumer. Serialization changes are breaking changes for
  every consumer in the list, including consumers in repos you are not looking at.
- **Database.** `db_map <table>` if the change touches an entity, a repository, a
  query, or a column. The changeset history tells you what shaped the table; the
  access list tells you every site that will need to keep working.
- **HTTP.** `http_map <path>` if the change touches a controller, a DTO used in a
  response, or a client call. The callers list includes the frontend — a field
  removed from a response is a frontend bug you can see from here.

**Step 4 — Decision impact.** `decisions target:<the thing>` — is there a
standing ADR governing this area? If your proposed change contradicts one, STOP
and surface the conflict. Do not quietly violate a recorded decision; either the
decision is wrong (and should be superseded via `save_decision`) or the change
is wrong. That is a human's call, and you must ask for it.

**Step 5 — Test impact.** `search_code` for the target's name in test files. A
change with no corresponding test change is either untested or about to break a
test suite; both are worth saying.

**Step 6 — Write the assessment.**

## Output: the impact assessment

```
## Impact: <the change>

**Target.** <exactly what is being changed, path:line>

**Blast radius.** <N> dependent files. Direct callers: <list with path:line>.
<If the target is a hotspot, say so loudly.>

**Contracts affected.**
- Kafka: <topic> — consumers: <who, where>. Breaking? <yes/no, why>
- Database: <table> — access sites: <who, where>. Migration needed? <yes/no>
- HTTP: <METHOD /path> — callers: <who, where, incl. frontend>. Breaking? <yes/no>
- None, if none. Say "none", don't omit the heading.

**Decisions.** <ADR-nnn mandates X — this change is consistent / IN CONFLICT>

**Risk.** LOW / MEDIUM / HIGH, and the single sentence that justifies it.

**Checklist to do this safely** (ordered — the order matters):
1. …
2. …

**What I could not determine.** <dynamic topic names, runtime SQL, gateway
rewrites, external consumers outside the workspace — name them explicitly>
```

## Rules

- **Risk is earned, not guessed.** HIGH means a hotspot, a cross-repo contract,
  or a schema change. LOW means a leaf with no dependents. If you can't justify
  the rating in one sentence, you haven't done the analysis.
- **Cross-repo consumers are the standard trap.** The workspace graph covers the
  repos that are indexed. If a topic or an endpoint might have consumers outside
  the workspace, say so — silence here reads as "nothing else uses it", which is
  a claim you have not verified.
- **"What I could not determine" is mandatory.** Static analysis cannot see
  runtime-assembled topics, SQL, or URLs. An assessment that omits this section
  is overclaiming.
- Never begin implementing inside this skill. Deliver the assessment; let the
  human choose to proceed.
