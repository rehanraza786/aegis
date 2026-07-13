---
name: flow-tracing
description: Follow a request, event, or piece of data end-to-end through the whole stack — frontend call, REST endpoint, service logic, Kafka topic, consumer, database write — using the graph seams rather than guesswork. Use when asked how something works end to end, when documenting a flow, and especially when debugging "X happened but Y never did" (an event that never arrives, a row that never appears, a UI that shows stale data). Produces a traced path with every hop cited, and for debugging, a ranked list of where the chain breaks.
---

# Flow Tracing

Follow the data. Most "it doesn't work" bugs in a distributed Spring/Kafka system
are a break in a chain of hops, and the graph knows every hop. Tracing beats
guessing, and it beats reading source files in the hope of stumbling on the seam.

Two modes. Decide which you're in, and say so.

- **Explain mode** — "how does an order get from the button to the database?"
- **Debug mode** — "the order was placed but billing never charged it."

They share the same trace; debug mode adds a break analysis at the end.

## The trace

Work forwards from the entry point, or backwards from the missing result —
backwards is usually faster when debugging, because the last successful hop is
known.

**Hop 1 — Entry.** How does the flow start?
- UI/frontend → `http_map <path>` gives the caller site *and* the Spring endpoint
  it lands on. If the call appears under "unmatched calls", the frontend is
  calling something that doesn't exist in the indexed workspace: that is either
  an external API or your bug, and it's a strong finding either way.
- Scheduled/triggered → `search_code` for `@Scheduled`, `@EventListener`, etc.
- Consumed event → `message_flow <topic>` gives the consumer.

**Hop 2 — Through the service.** `file_outline` on the controller/listener to see
its methods, then `find_callees` to walk down into the service layer. Do not read
whole files; walk the call graph. Use `find_references` when you need certainty
about which implementation actually runs.

**Hop 3 — Out again.** At each service, ask what it emits:
- `message_flow` — does it publish? To what topic? Which consumers pick it up
  (possibly in another repo)?
- `db_map <table>` — does it write? Which access site, read or write?
- `http_map` — does it call another service?

**Hop 4 — Repeat** for each downstream consumer until the flow terminates (a
database write, a response, a dead end).

**Hop 5 — Check the rules.** `decisions` — is there an ADR governing this flow?
A flow that contradicts a standing decision is a finding, whether or not it's the
bug you were sent to find.

## Output: explain mode

A Mermaid `sequenceDiagram` plus a numbered walkthrough where **every hop cites
`path:line`**. Services are participants. Kafka hops are async arrows (`-)`).
Database writes are notes. Anything you could not verify from a tool result is a
dashed arrow labeled "unverified" — never a solid line.

Save it to `docs/flows/<name>.md` if the user wants it kept (that's Hermes's
house style; match it).

## Output: debug mode

Trace first, then:

```
## Where the chain can break

Confirmed hops (verified from the graph):
1. web-app/src/api/orders.ts:12 → POST /api/orders → OrderController.java:24  ✓
2. OrderPublisher.java:6 publishes orders.created  ✓
3. BillingListener.java:3 consumes orders.created  ✓
4. …

Suspects, most likely first:
1. <hop> — <why it's suspect, what evidence would confirm it, how to check>
2. …

Not the problem (ruled out, with evidence):
- <hop> — <why it's ruled out>

Blind spots — the graph cannot see these, check them by hand:
- Consumer group config / offsets / rebalancing
- Serialization mismatches between producer and consumer payload classes
- Transaction boundaries: was the DB write committed before the event published?
  (Ask whether an outbox pattern is in use — if events are sent inside a
  transaction that later rolls back, the graph looks perfect and the system is
  still broken.)
- Topics or SQL assembled at runtime — check `message_flow` for
  `unresolved_expressions`
- Anything outside the indexed workspace
```

## Rules

- **Never invent a hop.** If the graph doesn't show a link, say the link is
  unverified and explain what you'd need to confirm it. A plausible-looking
  sequence diagram with a fabricated arrow is worse than no diagram.
- **Orphan warnings are gold when debugging.** "Consumed but no producer found"
  on the topic you're chasing is very often the entire answer.
- **State the direction you traced.** Backwards from the missing result is a
  different (and usually better) search than forwards from the trigger.
- Keep the suspect list ranked and short. Five ranked suspects beat twenty
  possibilities.
