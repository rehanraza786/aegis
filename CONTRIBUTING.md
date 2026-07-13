# Contributing to AEGIS

**Run the suite before and after your change** — it is the contract:

    python3 tests/run_tests.py --runtime node
    python3 tests/run_tests.py --runtime python

PRs must be green on the full matrix (ubuntu + windows × node + python).
Both runtime editions ship at parity: a change to one indexer/server/docgen
needs its twin. New graph capabilities should come with (a) a fixture addition
in tests/run_tests.py and (b) a SETUP.md section. Prefer extensions
(.ariadne/extensions/, see EXTENDING.md) for framework-specific extraction;
core PRs are for cross-cutting capability. No telemetry, ever — see PRIVACY.md;
anything that could send data anywhere must be opt-in and documented there.
