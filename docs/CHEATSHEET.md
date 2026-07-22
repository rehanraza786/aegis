# AEGIS cheat sheet

Pin this. It is the whole thing.

## You don't learn tool names. You just ask.

| Say this to Copilot | You get |
| --- | --- |
| "I'm new here, how does billing work?" | Orientation brief: structure, seams, risks, standing decisions |
| "What breaks if I change OrderService?" | Impact across code, Kafka, DB, HTTP, and any ADR that governs it |
| "X happened but Y never did" | Traced hops with file:line, ranked suspects, honest blind spots |
| "Add a column to payments" | Liquibase changeset → entity → every access site → verified against the graph |
| "Publish an event when an order ships" | Topic from config (never a literal), consumers checked, correlation verified |
| "Why do we use Kafka, still current?" | The ADR, what superseded it, what's in force now |
| "We just decided X, record it" | A numbered ADR, written and indexed |
| "Why can't the graph resolve this topic?" | Where it's blind, and how to teach it |

## Hand off bigger work

```
@daedalus    build a feature end to end        @argus       review a diff before merge
@asclepius   something's broken, diagnose it  @metis       weigh a design choice, record the ADR
@hephaestus  rename / migrate, no behavior     @themis      does the code match the spec?
             change                            @hermes      document a flow
                                               @pythia      refresh the knowledge base
```

## Commands (Command Palette → "AEGIS")

Install into Workspace · Rebuild Index · Index Status · Pull Team Index ·
Open Graph View (visualize & annotate) · Generate Flow Docs & Progress Report ·
Enrich Insights via Copilot · Update Workspace Payload

**Graph View**: the map, live. Warnings are badged, test usage is dimmed, asserted
edges are dashed. The *Gaps* panel is a worklist: every card is a place the graph
needs a human — fill one in (with evidence) and every agent gets smarter, with
your answer recorded as `asserted:human`, PR-reviewable, and auto-staled if the
code changes.

## Two rules worth remembering

1. **Never hardcode a Kafka topic literal.** Constant or config key. The graph will tell you if you did.
2. **Every schema change goes through Liquibase.** `db_map` shows drift; "no drift warning" is verification, "it compiles" is not.

## When something looks wrong

`index_status`, is the graph fresh? (Hooks refresh on *commit*, not on save.)
`graph_gaps`, what static analysis couldn't resolve, and why.
A topic looks orphaned but a test uses it? By design: `message_flow` / `db_map` / `http_map` topology is production-only, test usage is listed separately and labeled `[TEST]`.
Ask: *"aegis isn't working"*, the aegis-help skill diagnoses it.
