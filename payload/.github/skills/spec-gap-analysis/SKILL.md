---
name: spec-gap-analysis
description: Systematic method for comparing a codebase against its specifications (PDF, Markdown, or other docs) to find gaps in logic, flow, and features. Use this skill whenever the user asks to audit code against a spec, check whether requirements are implemented, find missing features, verify a PRD/design doc/API spec against the implementation, review whether flows match documented behavior, or asks "what's missing" or "does the code do what the docs say." Trigger even if the user only says "analyze the codebase against these docs."
---

# Spec Gap Analysis

Compare what the documentation says the system should do against what the code actually does, and produce an evidence-backed gap report. The discipline that makes this work: **never claim a gap or a match without citing evidence from both sides** — a spec location AND a code location (or a verified absence in code).

## The workflow

### Phase 1: Ingest the specs

1. **Inventory every spec document.** List all PDFs, .md files, READMEs, API docs, and inline design comments in scope. Ask the user if it's unclear which documents are authoritative when they conflict.
2. **Extract text from PDFs** before analysis. Use a text extractor (e.g., `pdftotext file.pdf file.txt` or Python `pypdf`); for scanned PDFs, use OCR. Never analyze a PDF you haven't actually read — page count and extracted length should be sanity-checked (a 40-page spec yielding 200 words means extraction failed).
3. **Build a requirements inventory.** Walk each document and extract every testable statement into a numbered list. Capture:
   - `REQ-ID` (assign one, e.g., R-014)
   - The requirement, quoted or tightly paraphrased
   - Source: document + section/page
   - Type: feature, behavior/logic rule, flow/sequence, constraint (perf, security, validation), or error handling
   - Priority signal if stated (MUST/SHOULD/MAY, "critical", etc.)

   Don't skip requirements buried in prose, diagrams described in text, tables, or examples — examples in specs are requirements in disguise (they define expected input/output behavior).

### Phase 2: Map the codebase

1. **Get oriented before searching.** Read the repo structure, entry points, routing/dispatch layer, and module boundaries. Note the languages and frameworks in play.
2. **Build a feature map:** for each major module/endpoint/command, note in one line what it does. This map is what you'll match requirements against.
3. **Locate cross-cutting machinery** early: validation layers, auth middleware, error handlers, feature flags, config. Many "missing" requirements actually live in these shared layers — check them before declaring a gap.

### Phase 3: Trace each requirement

For each requirement in the inventory, determine its status by locating the implementing code:

- **IMPLEMENTED** — code found that satisfies it. Record file(s) + line ranges or function names.
- **PARTIAL** — some of it exists; state precisely which part is missing (e.g., "retry exists but max-attempts limit from spec §4.2 is not enforced").
- **DIVERGENT** — code exists but behaves differently than specified. Quote both sides. This is a logic gap and is usually more dangerous than a missing feature.
- **MISSING** — no implementing code found after a genuine search (searched for the domain terms, synonyms, and adjacent modules — not just one grep).
- **UNVERIFIABLE** — can't be determined from static reading (e.g., depends on external service behavior or runtime config). Say so; don't guess.

For **flow requirements** (sequences, state machines, multi-step processes), don't just check that each step exists — trace the actual order and transitions in code and compare against the documented flow. Flow gaps hide in: steps executed in the wrong order, missing rollback/compensation paths, skipped validation between steps, and unhandled intermediate states.

For **logic requirements**, check boundary conditions specifically: off-by-one on limits the spec states, inclusive vs. exclusive ranges, null/empty handling the spec mandates, and default values (spec default vs. code default is a classic silent divergence).

### Phase 4: Reverse pass — code without spec

Run the comparison in the other direction: significant code behavior with no spec coverage (undocumented endpoints, hidden flags, side effects). These are either missing documentation or scope creep — flag them in their own section. This pass often surfaces the most surprising findings.

### Phase 5: Report

Produce the report using this structure:

```
# Gap Analysis: <project> vs <specs>

## Summary
- N requirements analyzed | X implemented | Y partial | Z divergent | W missing | V unverifiable
- Top 3-5 highest-risk findings, one line each

## Critical gaps (divergent logic + missing MUSTs)
For each: REQ-ID, spec quote + location, code evidence + location,
impact, and a suggested fix direction.

## Partial implementations
Same evidence format; state exactly what remains.

## Flow gaps
Documented flow vs. actual flow, shown side by side.

## Missing features (lower priority)

## Undocumented behavior (code without spec)

## Unverifiable items & assumptions

## Full traceability table
| REQ-ID | Requirement (short) | Source | Status | Code location | Notes |
```

Severity ordering: divergent logic > missing MUST > flow gaps > partial > missing SHOULD/MAY > documentation gaps.

## Rules of evidence

- Every finding cites spec location AND code location (or the searches performed that came up empty).
- Distinguish "not implemented" from "I didn't find it." If the codebase is large, state which areas you actually examined.
- Quote the spec exactly for DIVERGENT findings — paraphrase hides the divergence.
- Never mark IMPLEMENTED from a function name alone; read the body. Names lie.
- If spec documents contradict each other, report the contradiction as its own finding rather than silently picking one.

## Phase 6 (optional): Remediation

If the task includes fixing the gaps, not just finding them: order fixes by severity and dependency; look for shared root causes behind multiple gaps; for DIVERGENT findings, confirm the spec (not the code) is the correct side before changing behavior — stale specs are common. Implement one gap at a time using the codebase's existing patterns, and close each gap with a test that encodes the requirement itself (it should fail on the old code and pass on the new; use the spec's own examples as test cases). Re-run the trace for each fixed REQ-ID and update the traceability table with fresh evidence. Never mark a gap closed without a verification you actually ran.

## Scaling to large codebases

If the repo or spec set is too large for one pass, decompose by spec section or by module (use the complex-task-breakdown approach if available): analyze each slice fully, keep the running traceability table as the shared state, and merge at the end. Never sample randomly — cover slices completely so "missing" claims stay trustworthy.
