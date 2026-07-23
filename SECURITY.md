# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security →
"Report a vulnerability"). If that's unavailable, open an issue that says only
"security report, requesting contact" without details, and the maintainer will
arrange a channel. Please allow up to 14 days for triage before any disclosure.

## Supported versions

The latest release line only. The payload-copy install model means fixes reach
workspaces when they update (`AEGIS: Update Workspace Payload`, or a package
upgrade for `aegis-ariadne` installs) — please mention in reports whether the
issue affects vendored copies, the published packages, or both.

## Threat model, in brief

- **No network egress by design.** The indexer, server, docgen, and graph view
  make zero network calls; dependency pins exist specifically to keep it that
  way (see PRIVACY.md for the audited list of exceptions: package install and
  the opt-in CI index pull / enrichment).
- **Workspace extensions are code.** `.ariadne/extensions/` executes inside the
  indexer, the MCP server, and git hooks — which is why execution is gated on
  the sha256 allowlist in `.ariadne/extensions.lock` (committed, PR-reviewed).
  Bypassing or weakening that gate is in scope for reports.
- **The MCP server trusts its workspace.** It reads the index and workspace
  files of the repo it is pointed at; it is not designed to be exposed to
  untrusted MCP clients or run against repos you wouldn't build locally.
- **Generated artifacts are data, not code** — assertions, insights, and
  decisions are JSON/markdown ingested with parameterized SQL; injection
  through them is in scope for reports.
