---
name: event-contract-change
description: Add, change, or consume a Kafka event correctly — topic naming and configuration conventions, producer and consumer wiring, payload compatibility, and verification that producers and consumers actually correlate. Use whenever a change involves publishing a new event, consuming an existing one, altering an event payload class, or renaming a topic. Trigger on "publish an event", "new topic", "listen for", "@KafkaListener", or any change to a class that is serialized onto a topic.
---

# Event Contract Change

A Kafka topic is a contract between services that may live in different repos,
be owned by different people, and deploy on different days. The graph can see all
of them; use it, and follow the conventions this codebase already has rather than
inventing new ones.

**The rule that overrides everything: topic names come from configuration or from
a shared constant. Never hardcode a topic string literal in a new producer or
consumer.** A hardcoded literal is invisible to configuration, unchangeable per
environment, and the single most common thing an assistant gets wrong here.

## Step 1 — Establish the current truth

- `message_flow` with no arguments — the whole topology (on large systems this
  is a summary with the complete warning lists; query per topic for sites,
  that's deliberate). Learn the naming convention in use (`orders.created`,
  `payments.completed` — noun.past-tense is typical) and follow it. A new topic
  that doesn't match the house convention is a review finding.
- `message_flow <topic>` if the topic already exists — who produces it, who
  consumes it, and how each one resolves the name (a literal, a constant, or a
  `${config.key}` placeholder). Match whatever mechanism is already in use.
- `decisions target:<topic>` — is there an ADR governing this flow? ("All
  inter-service communication via Kafka", "commands are Kafka-only, queries may
  use HTTP.") Check before you propose an HTTP call instead, or vice versa.

## Step 2 — Wire the producer

- Resolve the topic name the way the codebase does: a `static final String`
  constant, or a `${app.kafka.<name>-topic}` placeholder backed by an entry in
  `application.yaml`. If you add a config key, add it to **every** service's
  config that needs it — a producer and a consumer resolving the same logical
  topic from different keys is a bug the graph will show you as two separate
  topics.
- Publish through the existing mechanism (`KafkaTemplate`, or whatever the module
  already uses — check with `search_code` rather than assuming).
- Consider the transaction boundary. If the event announces a database change,
  publishing inside the transaction that writes it means a rollback can leave an
  event claiming something that never happened. Whether this codebase uses an
  outbox is a question for `decisions` — if it does, use it; if it doesn't, and
  the flow is important, say that the risk exists rather than papering over it.

## Step 3 — Wire the consumer

- `@KafkaListener(topics = "${…}")` with the same resolution mechanism, plus the
  correct `groupId`. A wrong or duplicated group id changes delivery semantics
  and is invisible in code review.
- Idempotency: consumers get redelivered messages. If handling the same event
  twice would double-charge someone, say so and handle it.

## Step 4 — Payload compatibility (the part that breaks production)

If you are changing an existing event's payload class, `message_flow <topic>`
lists **every consumer** — including ones in repos you weren't looking at.

- **Adding an optional field** — generally safe.
- **Removing or renaming a field** — breaking for every consumer on that list.
  Deploy order matters: consumers tolerate the new shape first, producers change
  second.
- **Changing a type** — breaking. Treat as remove-plus-add.

Never assume you are the only consumer. That is what the list is for.

## Step 5 — Verify with the graph (not optional)

Reindex, then `message_flow <topic>`:

- The producer and the consumer must both appear under the **same topic**. If they
  appear under two different topics, the names don't actually match — usually a
  typo in a config key, and you have just saved yourself a very confusing
  afternoon.
- **"produced but no consumer found"** — expected if the consumer lives outside
  the indexed workspace; a bug otherwise. State which you believe it is, and why.
- **"consumed but no producer found"** — the mirror image, same reasoning.
- Anything under `unresolved_expressions` means the topic name is assembled at
  runtime and static analysis can't see it. Fix it by hoisting to a constant or a
  config key.

## Step 6 — Report

```
## Event contract: <topic>

**Topic.** <name> — resolved via <constant | ${config.key}> in <file>
**Producer.** <path:line>
**Consumers.** <path:line, each — including other repos>
**Payload.** <class> — change: <added/removed/renamed field, type>
**Compatibility.** safe / breaking — <and the deploy order if breaking>
**Verification.** message_flow shows producer + consumer correlated on <topic>. ✓
**Decisions.** <governing ADR, and whether this is consistent with it>
```

## Rules

- No hardcoded topic literals in new code. Constant or config key.
- Add the config key to every service that needs it, not just the one you're in.
- Consult the consumer list before changing a payload. Every name on it is a
  service you can break.
- Re-run `message_flow` afterwards and confirm the two sides correlate under one
  topic. "The code looks right" is not verification.
