---
name: complex-task-breakdown
description: A structured method for planning, decomposing, and executing complex or multi-step tasks reliably. Use for multi-step work that is NOT feature implementation (research, analysis, operational tasks), when the user asks for a plan or breakdown without implementing yet, or when a previous attempt failed or produced incomplete results. For work that will change code, use feature-delivery-loop instead — it embeds this discipline.
---

# Complex Task Breakdown

This skill turns big, fuzzy tasks into a sequence of small, verifiable steps. Follow it whenever a task cannot be completed correctly in a single short pass. The core insight: errors on complex tasks almost always come from skipping understanding, doing too much at once, or never verifying. This procedure blocks all three failure modes.

## The workflow

Work through these five phases in order. Do not skip Phase 1 or Phase 4 — they are where most quality is won or lost.

### Phase 1: Understand before acting

Before writing any code or producing any output:

1. **Restate the goal in one sentence.** What does "done" look like? If you cannot state it crisply, the task is not yet understood.
2. **List what you know and what you don't.** Write out the concrete facts given (inputs, constraints, formats, environment) and the open questions.
3. **Resolve unknowns cheaply.** Read the relevant files, run a quick command to inspect state, or check documentation BEFORE planning. Never plan around a guess you could verify in 10 seconds.
4. **State your assumptions explicitly.** For anything you can't verify, write "Assuming X because Y." If an assumption is risky and the user is available, ask one focused question. Otherwise proceed and flag it in the final answer.

### Phase 2: Decompose into a plan

Break the task into subtasks and write the plan down (in a scratch note, todo list, or comment block) before executing.

Rules for good decomposition:

- **Each subtask should be independently verifiable.** "Write the parser" is verifiable (it parses the sample input). "Make progress on the feature" is not.
- **Each subtask should be small** — roughly something completable in one focused pass. If a subtask description contains "and", consider splitting it.
- **Order by dependency, then by risk.** Do the subtask most likely to reveal a problem with the whole approach EARLY, not last. If the risky part fails, you've wasted nothing.
- **Include a verification step for every subtask**, not just at the end.
- **Cap the plan at 3-7 subtasks.** If you need more, group them into phases and decompose only the current phase in detail. Plans decay; don't over-plan far-future steps.

Plan format:

```
GOAL: <one sentence>
ASSUMPTIONS: <bulleted, only the risky ones>
PLAN:
1. <subtask> — verify by: <check>
2. <subtask> — verify by: <check>
3. ...
```

### Phase 3: Execute one subtask at a time

- Work on exactly one subtask. Resist doing "a little of step 3" while on step 1 — interleaving is the main source of half-finished work.
- After completing a subtask, **run its verification check immediately.** Do not batch verification to the end.
- If verification fails, fix it now, while context is fresh. Do not move on with a known-broken step.
- After each subtask, briefly note: what changed, what was verified, what's next. This keeps you oriented and makes the work auditable.

### Phase 4: Verify the whole

Individual steps passing does not mean the task is done. Before declaring completion:

1. **Re-read the original request.** Check every explicit requirement against what you produced. It is very common to satisfy the plan but miss a requirement the plan dropped.
2. **Test end-to-end**, not just piece-by-piece: run the full program, render the full document, trace the complete workflow.
3. **Actively look for what's wrong.** Ask: "If a careful reviewer wanted to reject this work, what would they point at?" Check edge cases: empty input, boundary values, the error path.
4. **Check for collateral damage:** did any change break something that previously worked?

### Phase 5: Report

In the final answer: state what was done, how it was verified, any assumptions made, and anything explicitly left out or still uncertain. Never claim untested things work. "Implemented and tested X; Y is implemented but untested because Z" is a good report. Silent gaps are not.

## When you get stuck

If a subtask fails repeatedly (2-3 attempts on the same error):

1. **Stop repeating the same fix.** A third identical attempt will not work.
2. **Shrink the problem.** Build the smallest possible reproduction of the failure. Most "impossible" bugs become obvious at minimal scale.
3. **Question an assumption.** List the things you believe are true about the failing step, and verify each one directly. The bug usually lives in a belief you never checked.
4. **Consider a different route.** Return to the plan: is there another decomposition that avoids this subtask entirely?
5. **If truly blocked, say so** — report what was tried, what was ruled out, and your best hypothesis. A precise "stuck" report is far more useful than thrashing.

## When to adjust the plan

Plans are instruments, not contracts. Revise the plan when:

- A subtask reveals the approach is wrong (revise early, cheaply — this is why risky steps go first).
- The task turns out simpler than expected (collapse steps; don't perform ceremony).
- New requirements emerge mid-task (update the GOAL line first, then the steps).

When you revise, say so briefly: "Revising plan: step 3 is unnecessary because X."

## Calibration: how much process to use

- **Trivial task (one obvious step):** skip this skill. Just do it.
- **Moderate task (2-4 steps, low ambiguity):** lightweight version — one-line goal, mental plan, verify at the end.
- **Complex task (many steps, ambiguity, unfamiliar territory, or prior failed attempt):** full workflow, written plan, per-step verification.

The written plan is cheap insurance. When in doubt, write it.
