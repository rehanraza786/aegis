# Feature Specification: [NAME]
Feature ID: [NNN] | Status: Draft | Created: [DATE] | Input: "[original request]"

## Overview
[2-4 sentences: the problem, who has it, what changes for them when this ships. WHAT and WHY only — no tech choices, file names, or code anywhere in this document.]

## User Stories
<!-- Priority P1 = must ship, P2 = should, P3 = nice. Each story independently testable. -->
### US-1 (P1): [title]
As a [actor], I want [capability], so that [benefit].
**Why this priority**: [one line]
**Acceptance scenarios**:
1. **Given** [initial state], **When** [action], **Then** [observable outcome]
2. **Given** [...], **When** [...], **Then** [...]

### US-2 (P2): [title]
[...]

## Functional Requirements
<!-- Each one testable: a test could pass or fail it. Cite the story it serves. -->
- **FR-001** (US-1): System MUST [specific, verifiable behavior]
- **FR-002** (US-1): System MUST [...]
- **FR-003** (US-2): System SHOULD [...]
- **FR-004**: [NEEDS CLARIFICATION: e.g. auth method not specified — SSO, email/password, token?]

## Edge Cases & Error Handling
- What happens when [boundary: empty input, max size, concurrent update, downstream timeout]?
- **FR-E01**: On [failure mode], system MUST [required behavior, including user-visible message class]

## Non-Functional Requirements
- **NFR-001**: [performance target / load]  - **NFR-002**: [security/compliance constraint]  - **NFR-003**: [accessibility, i18n, observability]

## Key Entities
<!-- Domain data this feature touches: name, what it represents, key relationships. No schemas. -->
- **[Entity]**: [description]

## Out of Scope
- [Explicitly excluded, so nobody "helpfully" builds it]

## Dependencies & Assumptions
- Depends on: [feature/service/decision]
- Assumes: [assumption + what happens if wrong]

## Open Clarifications
<!-- Mirror of all [NEEDS CLARIFICATION] markers above. Empty = ready for PLAN phase. -->
| # | Question | Blocking FR | Resolution |
|---|----------|-------------|------------|

## Review Checklist (complete before PLAN)
- [ ] No implementation details (tech, files, code)
- [ ] Every FR testable and traceable to a story
- [ ] All ambiguities marked, none silently guessed
- [ ] Edge cases and error behavior specified
- [ ] Out-of-scope stated
