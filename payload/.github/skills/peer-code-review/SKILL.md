---
name: peer-code-review
description: Rigorous peer-level code review — the same depth a strong senior engineer applies to a pull request. Covers coding standards, code smells, logic inconsistencies, adherence to spec, adherence to architecture, best practices, and security. Use whenever reviewing a diff, PR, or freshly written increment of code; ALSO use as the review gate inside iterative feature development (the feature-delivery-loop skill calls this every iteration). Trigger on "review this", "check my code", "PR review", or before declaring any implementation done.
---

# Peer Code Review

Review code the way a rigorous senior peer does. The procedure below is
deliberately explicit and mechanical — follow it exactly, in order, without
skipping passes. The structure IS the review quality: work the checklists,
demand evidence for every finding, and run the self-check before reporting.
Do not freestyle.

## Ground rules (read before every review)

- **Every finding needs three parts**: location (`path:line`), the concrete
  problem, and a specific fix. A finding you cannot express with all three
  parts is a hunch — verify it or drop it.
- **Read the actual code, not the diff hunks alone.** For each changed
  function, open enough surrounding context to know what the change really
  does. Diff-only reviews miss broken invariants.
- **Report what IS wrong, not what MIGHT be nicer.** Style preferences that
  the repo's own conventions don't mandate are nits at most, or silence.
- **Use the graph tools if available** (ariadne MCP): `blast_radius`
  on changed files tells you what else to inspect; `find_references` verifies
  claims like "nothing else calls this"; `file_outline` gives structure
  without token-heavy reads.

## Pass 0: Establish context (do not review yet)

1. What is this change supposed to do? Read the ticket/spec/story and the
   acceptance criteria. If none exist, infer intent from the code and state
   your inference explicitly — findings about "adherence to spec" are only as
   good as your understanding of the spec.
2. Read the repo's conventions: lint configs, existing patterns in
   neighboring files, `conventions.md`/knowledge base if present. THE REPO'S
   idioms are the standard — not your favorites.
3. List the changed files and classify each: core logic / API surface /
   config / tests / docs. Higher-risk classes get deeper passes.

## Pass 1: Correctness & logic (the pass that matters most)

For each changed function/block, verify mechanically:

- [ ] **Boundaries**: off-by-one, inclusive vs exclusive ranges, empty
      collections, zero/negative numbers, null/undefined/None on every input
- [ ] **Branch completeness**: does every if/switch handle the else/default?
      Is early-return logic consistent (no dead branches, no fallthrough)?
- [ ] **Error paths**: what happens when the call fails, times out, returns
      partial data? Are exceptions caught at the right level — and never
      swallowed silently?
- [ ] **State & concurrency**: shared mutable state, check-then-act races,
      async operations whose results arrive after state changed, missing
      awaits, resource cleanup on failure paths (finally/defer/try-with)
- [ ] **Contract consistency**: does the function do what its name, types,
      and doc comment claim? Do all callers still hold after this change
      (verify with the graph engine's references tool, not assumption)?
- [ ] **Data handling**: unit mismatches, timezone/locale assumptions,
      integer division, float equality, mutation of inputs the caller reuses

Trace at least one realistic input end-to-end through the changed code path,
and one failure input. Write down what actually happens — do not "it looks
fine" your way past this.

## Pass 2: Spec & architecture adherence

- [ ] Map each acceptance criterion / spec requirement to the code that
      satisfies it. Anything unmapped is a finding (missing or divergent —
      quote both sides for divergent).
- [ ] Does the change live in the right layer/module? (Business logic in a
      controller, DB access from a UI component, and similar layer violations
      are architecture findings even when the code "works".)
- [ ] Does it follow the codebase's established patterns for this kind of
      thing (error handling style, DTO shapes, naming, dependency direction)?
      Deviating from an established pattern needs justification.
- [ ] Blast radius: run the graph engine's blast-radius/impact tool on changed shared files; inspect at
      least the direct dependents for broken assumptions.
- [ ] Duplication: does this reimplement something that already exists?
      (search_code/find_symbol before assuming it doesn't.)

## Pass 3: Security (run every time, not just "security-relevant" changes)

- [ ] **Injection**: any string concatenated into SQL/HTML/shell/paths/
      queries? (Parameterized queries, encoders, allowlists expected.)
- [ ] **Input validation at trust boundaries**: every external input
      (HTTP params, file contents, env, messages) validated for type, size,
      range before use
- [ ] **AuthN/AuthZ**: new endpoints/actions — who can call this? Is the
      authorization check present, and at the server, not just the UI?
      Object-level checks (can user A fetch user B's record by changing an id)?
- [ ] **Secrets & sensitive data**: hardcoded credentials/tokens, secrets in
      logs or error messages, sensitive fields returned in API responses that
      shouldn't be, PII written to logs
- [ ] **Unsafe patterns**: eval/deserialization of untrusted data, disabled
      TLS verification, weak/homemade crypto, predictable randomness for
      tokens, path traversal on user-supplied filenames, SSRF via
      user-supplied URLs
- [ ] **Dependencies**: new packages — are they real, maintained, and needed?
      (Typosquats and abandoned packages are findings.)

## Pass 4: Standards, smells & tests

- [ ] Lint/format clean by the repo's own tooling (run it; don't eyeball)
- [ ] Smells that matter: functions doing multiple unrelated things, deep
      nesting hiding logic, magic numbers where the spec names a constant,
      copy-paste blocks diverging by one line, dead code, misleading names
- [ ] Tests: do the new/changed tests actually assert behavior (not just
      "no throw")? Do they cover the error paths from Pass 1? Would they
      fail if the logic regressed? Any test deleted or weakened to pass?
- [ ] Docs: anything this change made stale (README, API docs, CHANGELOG,
      knowledge base)?

## Severity rubric (assign one to every finding)

- **BLOCKER** — incorrect behavior, security vulnerability, data loss risk,
  spec violation on a MUST. Do not proceed until fixed.
- **MAJOR** — logic gap on realistic inputs, architecture violation,
  missing error handling on likely failures, missing authz. Fix in this
  iteration.
- **MINOR** — smells, weak tests, naming, small deviations from conventions.
  Fix if cheap, otherwise note for follow-up.
- **NIT** — optional polish. Never block on nits; batch them.

## Self-check before reporting (mandatory)

1. Re-read each finding: does it have path:line + problem + fix? Drop or
   verify anything that doesn't.
2. For each BLOCKER/MAJOR: did I confirm it against the actual code (not the
   diff snippet alone)? Could the surrounding code already handle it?
3. Did I complete ALL FOUR passes, or did I stop after finding a few issues?
   (Finding 3 issues early is not a completed review.)
4. Am I flagging anything purely because I'd have written it differently?
   Remove those.

## Output format

```
## Review: <change description>
Verdict: APPROVE | APPROVE-WITH-MINORS | REQUEST-CHANGES
Passes completed: context, logic, spec/arch, security, standards

### Blockers (N)
1. path:line — problem — evidence — suggested fix
### Major (N) ... ### Minor (N) ... ### Nits (N)

### Spec coverage
criterion → satisfied by path:line | MISSING | DIVERGENT

### What I verified and how (commands run, paths traced)
### What I could not verify (and why)
```

## Fix-in-lockstep protocol (when review is part of the delivery loop)

When this review runs inside the feature-delivery-loop iteration:
1. Review only the current increment's changes (plus their blast radius).
2. Fix all BLOCKER and MAJOR findings **inside the same iteration** — each
   fix goes through the same mini-cycle: fix → build → run tests → re-review
   the fixed lines. The iteration does not end with open blockers/majors.
3. MINOR findings: fix now if <5 minutes, otherwise add to a tracked
   follow-up list included in the final report. NITs are batched to the end.
4. Re-run the relevant review passes on your own fixes — fixes introduce
   bugs at the same rate as any other code.
