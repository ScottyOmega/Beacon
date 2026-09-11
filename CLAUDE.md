# Workflow: publishing changes

This repo is public on GitHub (`ScottyOmega/Beacon`) so others can install the
packaged extension. The user has pre-authorized the following as a standing
instruction: whenever a change adds or modifies a tool/feature, automatically
commit, push, and cut a new GitHub release — no need to ask for confirmation
first, as long as the change is a normal feature/fix and introduces no
secrets.

After a feature change is made and verified (`node --check index.js` passes):

1. Bump the `version` in `manifest.json` (patch for fixes, minor for new tools).
2. Update the tools table (and any other relevant section) in `README.md` to
   match — don't let it drift out of sync with `manifest.json`.
3. Validate and repack:
   ```
   npx @anthropic-ai/mcpb validate manifest.json
   npx @anthropic-ai/mcpb pack . ynab-mcp.mcpb
   ```
4. `git add` the changed source files (never `node_modules/`, never the
   `.mcpb` — both are gitignored) and commit with a message describing the
   change.
5. `git push`.
6. `gh release create vX.Y.Z ynab-mcp.mcpb --title vX.Y.Z --notes "..."`
   matching the manifest version, describing what changed.

Before committing, double-check `git status`/`git diff` for anything that
looks like a secret (there should never be a token or `.env` file in this
repo — the YNAB token is entered by the user directly into Claude's extension
settings UI, never written to disk here).

## After a release: remind about Glama

The server is also listed at glama.ai
(https://glama.ai/mcp/servers/ScottyOmega/Beacon), which is a separate
requirement for staying listed on the `punkpeye/awesome-mcp-servers` GitHub
list (PR #14190) — their bot requires a passing Glama score badge. Glama does
**not** auto-sync with GitHub. After cutting a new GitHub release, remind the
user to manually, at https://glama.ai/mcp/servers/ScottyOmega/Beacon/admin:

1. Repository → Request re-sync (pulls latest README/description).
2. Dockerfile → click **Build** (not "Build & Release" — that one skips
   asking for a version). Once it succeeds, click **Make Release** next to
   that specific build in "Recent Tests" and enter the version manually so it
   matches the GitHub release (e.g. `1.10.0`, not an arbitrary default like
   `1.10.1`).
3. Placeholder parameters field: `{"YNAB_ACCESS_TOKEN": "dummy-placeholder-token"}`
   — needed because the env schema marks the token required, even though the
   server itself starts fine without one.

This requires Scott's own login (Glama has no CLI/OAuth-token flow like `gh`
does for GitHub), so it's a step to prompt him to do, not something to
automate.
