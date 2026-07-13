---
name: feature-delivery-loop
description: Agile iterative delivery workflow — implement features in small increments, building, testing, and writing unit tests each cycle until the Definition of Done is met, and keeping markdown documentation in sync with the code. Use this skill for ANY feature work, story, or ticket implementation, whenever the user asks to "implement", "build", "add a feature", "work on this story", or when a task will change code that has documentation. Also use when resuming a partially complete feature.
---

# Feature Delivery Loop

Deliver features the agile way: in small vertical increments, each one built,
tested, and documented before moving to the next. The unit of progress is a
**passing increment**, never a pile of untested code. This loop continues —
iteration after iteration — until the Definition of Done is fully satisfied.

## Phase 0: Frame the story

If the `spec-driven-artifacts` skill is available, run its SPECIFY → PLAN →
TASKS phases first: the acceptance criteria live in spec.md, the slicing in
tasks.md, and each loop iteration below updates tasks.md checkboxes, appends
to review.md, and adds a changes.md entry. The loop is the IMPLEMENT phase of
that artifact system.

Before the first increment:

1. Write the story goal as acceptance criteria — concrete, testable statements
   ("Given/When/Then" works well). These are the exit condition for the loop.
2. Slice the work into increments of a few hours each, each one **vertical**
   (a thin slice of working behavior — endpoint + logic + test) rather than
   horizontal (all models, then all services, then all UI). Vertical slices
   keep every iteration shippable and reveal integration problems early.
3. Identify the build and test commands for this repo now (check package.json
   scripts, Gradle/Maven tasks, CI config, conventions docs) — you'll run them
   every iteration.

## The iteration loop

Repeat until all acceptance criteria pass:

```
1. PICK      — take the next increment (riskiest/most uncertain first)
2. TEST      — write or extend unit tests for the increment's behavior
               (before or alongside the code; the test defines "works")
3. IMPLEMENT — smallest change that makes those tests pass
4. BUILD     — run the real build (compile/typecheck/lint). Broken build =
               stop and fix before anything else
5. VERIFY    — run the new tests AND the affected existing suites;
               fix regressions immediately, while context is fresh
6. REVIEW    — run a peer-level review of this increment's changes using
               the peer-code-review skill (all four passes: logic, spec &
               architecture, security, standards). Fix every BLOCKER and
               MAJOR finding now, each through its own fix→build→test→
               re-review mini-cycle. The iteration cannot end with open
               blockers or majors
7. DOCUMENT  — sync any markdown affected by this increment (see below)
8. ASSESS    — check acceptance criteria: which now pass? what did this
               iteration teach? re-slice remaining work if needed
```

Rules of the loop:
- **Never carry a red state into the next iteration.** Build failures and test
  failures are fixed inside the iteration that caused them.
- **Each iteration ends in a commit-worthy state**: builds clean, tests green,
  docs true. If interrupted, the work is still usable.
- **Re-plan cheaply.** If an iteration reveals the slicing was wrong, change
  the plan and say so in one line. Plans serve the loop, not vice versa.
- **Stuck for 2-3 attempts on the same failure?** Stop repeating; shrink to a
  minimal reproduction, question your assumptions one by one, or re-slice
  around the obstacle.

## Unit testing standards

- Every increment adds or extends unit tests using the repo's existing
  framework and conventions (JUnit/Jest/Vitest/etc. — match what's there).
- Cover: the happy path, the boundary conditions the acceptance criteria
  imply, and the error paths you implemented. A feature without error-path
  tests is half-tested.
- Tests assert behavior, not implementation details — they should survive a
  refactor that preserves the contract.
- If code is hard to unit test, that's design feedback: refactor for
  testability inside the iteration rather than skipping the test.

## Documentation sync (every iteration, not at the end)

After each increment, update whichever of these the change touched:

- **README.md** — setup steps, commands, feature lists, usage examples
- **docs/** and module-level .md files — behavior descriptions, API docs,
  architecture notes affected by the change
- **CHANGELOG.md** — if the repo keeps one, add the entry now (under an
  Unreleased heading), not from memory at release time
- **`.github/knowledge/` module files** — public surface, dependencies, or
  gotchas that changed (see the codebase-orientation skill for format)
- **Config/env samples** (.env.example, config templates) — new settings

Rules: update only docs the change makes stale — don't rewrite for style.
If docs and code disagree, code wins and the doc gets fixed. If a doc for a
significant new feature doesn't exist, create a minimal honest one rather
than leaving the feature undocumented. Never document behavior you haven't
verified this iteration.

## Definition of Done

The loop exits only when every box checks:

- [ ] All acceptance criteria demonstrably pass (name the test or command per criterion)
- [ ] Build/typecheck/lint clean
- [ ] New unit tests written; new + affected existing suites green
- [ ] Feature exercised end-to-end once as a user would (not just unit level)
- [ ] Peer-level review completed on the full change set with zero open BLOCKER/MAJOR findings; MINOR follow-ups listed in the report
- [ ] All affected markdown updated (README/docs/CHANGELOG/knowledge base)
- [ ] No debug prints, dead code, or commented-out experiments left behind

Report at the end: iterations taken, criteria→evidence mapping, tests added,
review verdict with findings fixed vs deferred, docs touched, and anything
deliberately deferred (with why).
