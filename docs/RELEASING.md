# Releasing AEGIS

## First push (personal GitHub account)

A personal account works exactly like an organization here — a GitHub repo URL is
`github.com/<owner>/<repo>` either way. Wherever the docs say "owner", use your
username.

1. **Create an empty repo** on GitHub. No README, no `.gitignore`, no license —
   they are already in this bundle and GitHub will refuse to merge otherwise.

2. **Stamp your identity in:**

   ```bash
   bash scripts/prepare-github.sh <your-username>/aegis "Your Name"
   ```

   This rewrites the repo URL in the README and `extension/package.json`, sets the
   extension's `publisher` to your username, and puts your name on the MIT license.

3. **Push:**

   ```bash
   git init
   git add -A
   git commit -m "AEGIS v0.1.0"
   git branch -M main
   git remote add origin git@github.com:<your-username>/aegis.git
   git push -u origin main
   ```

   The push runs `.github/workflows/test.yml` — the full matrix, ubuntu + windows
   × node + python. This is the first time Windows gets verified for real, so
   watch that run.

4. **Cut the release:**

   ```bash
   git tag v0.1.0
   git push --tags
   ```

   `release-vsix.yml` builds the extension from the payload, syncs its version to
   the tag, and attaches `aegis-toolkit-0.1.0.vsix` to a public GitHub Release with
   generated notes.

5. **Install it:**

   ```bash
   code --install-extension aegis-toolkit-0.1.0.vsix
   ```

   Or VS Code → Extensions → `⋯` → *Install from VSIX*.

## Things that specifically bite personal accounts

- **Actions permissions.** If the release job fails with a 403 when uploading the
  asset, go to **Settings → Actions → General → Workflow permissions** and select
  **Read and write permissions**. The workflow already asks for `contents: write`,
  but it cannot exceed the repository's ceiling. Newer repos default to read-only.

- **Public vs private.** Actions minutes are unlimited on public repos and capped
  (2,000/month on the free plan) on private ones. If you keep this private, the
  four-job matrix will consume that budget.

- **The `publisher` field** in `extension/package.json` only has to be a *registered*
  VS Code Marketplace publisher ID if you ever run `vsce publish`. For installing the
  `.vsix` from a GitHub Release it is cosmetic — just the name shown in the Extensions
  panel — which is why the setup script sets it to your username.

## Later releases

```bash
git tag v0.2.0 && git push --tags
```

That is the whole process; the workflow does the rest.

## Optional: the VS Code Marketplace

If you later want people to install by searching rather than downloading a file:
register a publisher at <https://marketplace.visualstudio.com/manage>, put that
publisher ID in `extension/package.json`, then `npx vsce publish`. Mirror it to the
open ecosystem with `npx ovsx publish`. Neither is required — GitHub Releases are a
perfectly normal distribution channel for a tool like this.
