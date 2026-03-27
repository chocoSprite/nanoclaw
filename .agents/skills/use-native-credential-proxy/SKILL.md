---
name: use-native-credential-proxy
description: Replace OneCLI gateway with the built-in credential proxy. For users who want simple .env-based credential management without installing OneCLI. Reads API key from .env and injects into container API requests.
---

# Use Native Credential Proxy

This skill replaces the OneCLI gateway with NanoClaw's built-in credential proxy. Containers get credentials injected via a local HTTP proxy that reads from `.env` — no external services needed. Uses OpenAI API for model inference.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/credential-proxy.ts` is imported in `src/index.ts`:

```bash
grep "credential-proxy" src/index.ts
```

If it shows an import for `startCredentialProxy`, the native proxy is already active. Skip to Phase 3 (Setup).

### Check if OneCLI is active

```bash
grep "@onecli-sh/sdk" package.json
```

If `@onecli-sh/sdk` appears, OneCLI is the active credential provider. Proceed with Phase 2 to replace it.

If neither check matches, you may be on an older version. Run `/update-nanoclaw` first, then retry.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/native-credential-proxy
git merge upstream/skill/native-credential-proxy || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/credential-proxy.ts` and `src/credential-proxy.test.ts` (the proxy implementation)
- Restored credential proxy usage in `src/index.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, `src/config.ts`
- Removed `@onecli-sh/sdk` dependency
- Restored `CREDENTIAL_PROXY_PORT` config (default 3001)
- Restored platform-aware proxy bind address detection
- Reverted setup skill to `.env`-based credential instructions

If the merge reports conflicts beyond `package-lock.json`, resolve them by reading the conflicted files and understanding the intent of both sides.

### Update main group AGENTS.md

Replace the OneCLI auth reference with the native proxy:

In `groups/main/AGENTS.md`, replace:
> OneCLI manages credentials (including OpenAI auth) — run `onecli --help`.

with:
> The native credential proxy manages credentials (including OpenAI auth) via `.env` — see `src/credential-proxy.ts`.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/credential-proxy.test.ts src/container-runner.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup Credentials

Tell the user to get an API key from https://platform.openai.com/api-keys if they don't have one.

Add it to `.env`:

```bash
# Add to .env (create file if needed)
echo 'OPENAI_API_KEY=<key>' >> .env
```

**If the user's response happens to contain a key** (starts with `sk-` or looks like a token): write it to `.env` on their behalf as `OPENAI_API_KEY`.

**Optional:** If the user needs a custom API endpoint, they can add `OPENAI_BASE_URL=<url>` to `.env` (defaults to `https://api.openai.com`).

## Phase 4: Verify

1. Rebuild and restart:

```bash
npm run build
```

Then restart the service:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`
- WSL/manual: stop and re-run `bash start-nanoclaw.sh`

2. Check logs for successful proxy startup:

```bash
tail -20 logs/nanoclaw.log | grep "Credential proxy"
```

Expected: `Credential proxy started` with port and auth mode.

3. Send a test message in the registered chat to verify the agent responds.

4. Note: after applying this skill, the OneCLI credential steps in `/setup` no longer apply. `.env` is now the credential source.

## Troubleshooting

**"Credential proxy upstream error" in logs:** Check that `.env` has a valid `OPENAI_API_KEY`. Verify the API is reachable: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer test" | head`.

**Port 3001 already in use:** Set `CREDENTIAL_PROXY_PORT=<other port>` in `.env` or as an environment variable.

**Container can't reach proxy (Linux):** The proxy binds to the `docker0` bridge IP by default. If that interface doesn't exist (e.g. rootless Docker), set `CREDENTIAL_PROXY_HOST=0.0.0.0` as an environment variable.

**API key invalid (401 errors):** Generate a new key at https://platform.openai.com/api-keys and update `OPENAI_API_KEY` in `.env`.

## Removal

To revert to OneCLI gateway:

1. Find the merge commit: `git log --oneline --merges -5`
2. Revert it: `git revert <merge-commit> -m 1` (undoes the skill branch merge, keeps your other changes)
3. `npm install` (re-adds `@onecli-sh/sdk`)
4. `npm run build`
5. Follow `/setup` step 4 to configure OneCLI credentials
6. Remove `OPENAI_API_KEY` from `.env`
