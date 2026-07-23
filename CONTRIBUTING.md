# Contributing to AEGIS

Thanks for looking under the hood. This project has a few disciplines that keep
it trustworthy; PRs that follow them merge fast.

## Setup and tests

```
git clone https://github.com/rehanraza786/aegis && cd aegis
python3 tests/run_tests.py --runtime node      # needs Node >= 18
python3 tests/run_tests.py --runtime python    # needs Python >= 3.10
```

The suite builds a six-repo fixture workspace and asserts ~150 behaviors end to
end per runtime; CI runs both runtimes on Linux and Windows. **Green on both
runtimes is the bar for every PR** — there is no such thing as a node-only or
python-only change to the engine.

## The parity contract

`payload/ariadne-node/` and `payload/ariadne-python/` are twin editions of the
same engine sharing one SQLite file format — the DB is the product's real
interface. Any change to extraction, schema, budgeting, or tool behavior lands
in BOTH editions in the same PR, with the same semantics (the suite's registry
and behavior checks will catch most drift, but write both on purpose, not
because the tests forced you). Comments like "mirror of kafka.mjs" mark the
pairs.

## Adding a seam extractor (the most-wanted PR)

The pattern that has worked, end to end:

1. Write the extraction in the relevant pair (`kafka.*` / `db.*` / `http.*`),
   or as a file-scoped extension (`{ fn, files: /\.go$/ }`) if it's
   framework-specific enough to stay optional — see EXTENDING.md.
2. Gate it: broker/library extraction must be gated on evidence the library is
   present in the file, so `.publish(` in ordinary code never becomes a
   phantom queue.
3. Preserve provenance: rows land in the native tables with `source='static'`,
   the `system` column set for messaging, and honest `resolved`/`via` values.
   Never guess — unresolvable expressions are gaps, not facts.
4. Add fixture files to `tests/run_tests.py::make_fixture` and checks that
   assert the rows (see the "non-JVM seams" section for the shape).
5. Update the README's stack section only to what is now actually true.

## Style, commits, PRs

Match the file you're editing; both editions favor small, dense, commented-when-
subtle code. Commit messages explain the WHY in the body (read `git log` for
the house voice). One logical change per commit. PRs get a description of what
behavior changed and how the suite proves it.

## Extension approval, versions, releases

`.ariadne/extensions/` changes in fixtures must be re-approved in tests (the
trust gate is part of the product). The payload version lives in THREE places
that the suite pins equal: `payload/ariadne-node/package.json`,
`payload/ariadne-python/pyproject.toml`, and the top entry of `CHANGELOG.md` —
bump all three together. Tags (`vX.Y.Z`) must match those manifests or the
publish workflow refuses.
