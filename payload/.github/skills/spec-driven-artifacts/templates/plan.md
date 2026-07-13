# Implementation Plan: [NAME]
Feature ID: [NNN] | Spec: ./spec.md | Status: Draft | Date: [DATE]

## Technical Context
Languages/frameworks: [...]  |  Affected modules: [from module_map/knowledge base]
Integration points: [...]     |  Data stores: [...]
Unknowns investigated: [link research.md or "none needed"]

## Constitution Check
<!-- Verify against docs/constitution.md BEFORE designing. -->
| Principle | Compliant? | Notes/justification |
|-----------|-----------|---------------------|
| [each principle] | ✅/⚠️ | [⚠️ requires written justification here or a plan change] |

## Architecture Decisions
<!-- One block per significant decision. Rejected alternatives are mandatory. -->
### AD-1: [decision]
- **Choice**: [what]
- **Because**: [why — tie to requirements/constraints]
- **Rejected**: [alternative] — [why not]
- **Blast radius**: [modules/files affected; from blast_radius if available]

## Design
- Component/flow outline: [which layers change and how data moves; diagrams welcome]
- Contracts: [new/changed API signatures, events, schemas — or link contracts/]
- Error-handling strategy: [where failures are caught, what the user sees]
- Testing strategy: [unit/integration/e2e split; what proves each FR]

## Phases
1. **Phase 1 — [name]**: [scope] → proves [FR-xxx...]  (riskiest first)
2. **Phase 2 — [name]**: [...]

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation / early-warning |
|------|-----------|--------|---------------------------|

## Review Checklist (complete before TASKS)
- [ ] Constitution check passed or justified
- [ ] Every AD lists a rejected alternative
- [ ] Every FR is covered by the design and a test type
- [ ] Riskiest work is in the earliest phase
