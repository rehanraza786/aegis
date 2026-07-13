---
name: graph-augmentation
description: Close the gaps that static analysis cannot close — resolve runtime-assembled Kafka topics, dynamic SQL, gateway-rewritten routes, and other blind spots by reading the code, working out the answer, and recording it in the graph with evidence. Use when graph_gaps reports unresolved expressions or unexplained orphans, when a tool says "no producer found" for something you know exists, or when investigating why the graph disagrees with reality. This is how the graph gets better instead of staying wrong.
---

# Graph Augmentation

The graph is built by parsers. Parsers cannot evaluate code — they can only read
it. So a topic assembled at runtime (`PREFIX + "." + env`), a table name built by
string concatenation, or a route rewritten by a gateway is invisible to it, and
shows up as a gap.

You *can* evaluate code. You can read the constant, find the config value, follow
the profile, and work out what the expression actually resolves to. That knowledge
is worth having permanently, rather than being rediscovered by every developer and
every session.

This skill is how you put it into the graph — carefully, with evidence, and
without ever contaminating parsed facts with inferred ones.

## The non-negotiable rule

**An asserted fact is never presented as a parsed fact.** Everything you record is
tagged with its author and shows up in every tool as
`[ASSERTED by <author> — derived, not parsed]`. Never work around this. The entire
value of the graph is that a developer can trust it; the moment an inference is
laundered into "the graph says so", that trust is gone and the tool is worse than
nothing.

Assert what you can *defend*. If you are not sure, say so and leave the gap open —
an honest gap is more useful than a confident wrong edge.

## Procedure

**1. Ask the graph where it is blind.** `graph_gaps` returns its own to-do list:

- `unresolved_topic_expressions` — a partial like `orders.created.{?}` means the
  parser resolved the prefix from a constant but could not evaluate the rest.
- `topics_produced_but_never_consumed` / `consumed_but_never_produced` — a dead
  topic, a counterpart in a repo that is not indexed, or a dynamic handler.
- `tables_accessed_but_undefined` — DRIFT. Could be a missing changelog, a table
  from another service, or a genuine bug.
- `endpoints_with_no_caller` — dead route, an external consumer, or a gateway
  rewrite the parser cannot see.

**2. Investigate the actual code.** Open the file at the reported line. Follow the
constants, the config files, the profiles, the build. Use `search_code` and
`find_symbol` rather than guessing. Work out what the expression evaluates to *at
runtime* — that is the thing the parser could not do and you can.

**3. Decide whether you actually know.** Three honest outcomes:

- **You know.** The constant is right there, the config key resolves, the answer is
  unambiguous. Assert it with `confidence: high`.
- **You are fairly sure.** One plausible reading, but it depends on an environment
  or a value you cannot see. Assert with `confidence: medium|low` and *say so in the
  evidence*.
- **You cannot tell.** Say that, and leave the gap. Do not guess. A wrong edge is
  worse than a missing one, because it will be trusted.

**4. Record it with `assert_edge`.** Evidence is mandatory and it must be specific:
quote the code, name the constant, name the config key. "It looks like the orders
topic" is not evidence. This is what a reviewer will read:

> "Topic is `PREFIX + "." + env`. PREFIX is a `static final` = "orders.created"
> (line 4). `env` is the Spring profile; in production that is `prod`, so the
> runtime topic is `orders.created.prod`."

The assertion goes into `docs/graph-assertions.json` — a git-committed, reviewable
file, exactly like an ADR. It is *not* a hidden side-channel. Your team reviews it
in a pull request, and can delete an entry they disagree with.

**5. Reindex and check.** The assertion enters the graph tagged as asserted. Confirm
the gap actually closed — the orphan warning should disappear, and `message_flow` (or
`db_map` / `http_map`) should now show your edge, labelled.

**6. Watch for staleness.** Each assertion stores the hash of the file it was derived
from. If that file changes, the assertion is flagged STALE — because the reasoning
may no longer hold. Re-verify rather than assuming it still stands.

## What to assert, and what not to

**Assert:** runtime-assembled topic and table names you traced to their constants
and config; endpoints reachable only through a gateway rewrite you found in config;
producers or consumers wired reflectively or through a framework the parser does not
model.

**Do not assert:** anything you inferred from naming alone ("it's called
`OrderProcessor`, so it probably consumes `orders.created`"); anything whose evidence
you cannot point at with a `path:line`; anything you would not defend in code review.
And never assert to make a warning go away — an orphan topic is often a *real bug*,
and silencing it is the worst possible outcome.

## Report

```
## Graph gaps addressed

**Investigated.** <N> gaps from graph_gaps.

**Asserted.**
- <kind> <subject> @ <path:line> — <what it resolves to>, confidence <high|med|low>
  evidence: <the constant/config/profile chain that proves it>

**Left open, deliberately.**
- <gap> — <why I could not determine it; what a human would need to check>

**Real bugs found.** <orphan topics or drift that turned out to be genuine defects —
these are the best possible outcome of this exercise, and should not be quietly
asserted away>
```
