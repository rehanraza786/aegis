# Tasks: [NAME]
Feature ID: [NNN] | Plan: ./plan.md | Updated: [DATE — bump on every change]

Legend: [ ] todo · [~] in progress · [x] done · [!] blocked · [P] = parallelizable with siblings

## Phase 1: [name]
- [ ] **T001** (FR-001) Write failing unit tests for [behavior]
      Files: `src/.../X.test.ts` | Verify: tests exist and fail for the right reason
- [ ] **T002** (FR-001) Implement [specific change]
      Files: `src/.../X.ts` | Verify: T001 tests pass; build clean
- [ ] **T003** [P] (FR-002) [...]
      Files: [...] | Verify: [...]
- [ ] **T004** (Phase gate) Iteration review via peer-code-review; fix BLOCKER/MAJOR
      Verify: review.md entry appended with verdict; zero open blockers/majors

## Phase 2: [name]
- [ ] **T005** ...

## Completion
- [ ] **T900** All spec acceptance scenarios pass end-to-end (list command/evidence per scenario)
- [ ] **T901** Full affected test suites green; lint clean
- [ ] **T902** Docs synced (README/docs/CHANGELOG/knowledge base) — list files touched
- [ ] **T903** Final whole-changeset review; artifacts reconciled with reality

## Task log
<!-- One line when a task completes or blocks: T00x — outcome/blocker — date -->
