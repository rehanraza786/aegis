# Project Constitution
<!-- The non-negotiables. Every plan.md is checked against this. Keep short: 5-9 principles. Amendments require team agreement and a version bump. -->
Version: 1.0 | Ratified: [DATE]

## Principles
1. **Tests are not optional** — every behavior change ships with unit tests; every bug fix ships with a regression test that failed before the fix.
2. **[Architecture rule]** — e.g. business logic never lives in controllers/components; dependencies point inward.
3. **[Security baseline]** — e.g. all external input validated at the boundary; no secrets in code or logs; authz enforced server-side.
4. **[Simplicity]** — no speculative abstraction; three strikes before generalizing.
5. **[Observability]** — e.g. every new failure path logs actionably.
6. **Docs move with code** — a change that makes documentation false must fix the documentation in the same change.
7. **[Team-specific rule]**

## Quality gates (apply to every merge)
- Build/lint/typecheck clean · new + affected tests green · peer review with zero open BLOCKER/MAJOR · docs synced
