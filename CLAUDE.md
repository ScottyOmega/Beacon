# Workflow: publishing changes

This repo is public on GitHub (`ScottyOmega/Beacon`) so others can install the
packaged extension. The user has pre-authorized the following as a standing
instruction: whenever a change adds or modifies a tool/feature, automatically
commit, push, and cut a new GitHub release — no need to ask for confirmation
first, as long as the change is a normal feature/fix and introduces no
secrets.

After a feature change is made and verified (`node --check index.js` passes):

1. Bump the `version` in `manifest.json` (patch for fixes, minor for new tools).
2. Validate and repack:
   ```
   npx @anthropic-ai/mcpb validate manifest.json
   npx @anthropic-ai/mcpb pack . ynab-mcp.mcpb
   ```
3. `git add` the changed source files (never `node_modules/`, never the
   `.mcpb` — both are gitignored) and commit with a message describing the
   change.
4. `git push`.
5. `gh release create vX.Y.Z ynab-mcp.mcpb --title vX.Y.Z --notes "..."`
   matching the manifest version, describing what changed.

Before committing, double-check `git status`/`git diff` for anything that
looks like a secret (there should never be a token or `.env` file in this
repo — the YNAB token is entered by the user directly into Claude's extension
settings UI, never written to disk here).
