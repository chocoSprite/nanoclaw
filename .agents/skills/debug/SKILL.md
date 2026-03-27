---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                      │ runs Codex SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.codex/ ──> /home/node/.codex/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.codex/` (not `/root/.codex/`) for session resumption to work.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Codex sessions** | `~/.codex/projects/` | Codex session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Codex process exited with error"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure OneCLI has an OpenAI secret registered:
```bash
onecli secrets list  # Should show an OpenAI secret
# If not, register: onecli secrets create --name OpenAI --type api_key --value YOUR_KEY --host-pattern api.openai.com
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Runtime note:** Environment variables passed via `-e` may be lost when using `-i` (interactive/piped stdin).

**Workaround:** Authentication is handled by OneCLI proxy — no API keys are passed directly to containers. The OneCLI gateway intercepts HTTPS requests and injects credentials at request time.

To verify OneCLI is reachable from the container:
```bash
echo '{}' | docker run -i \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'curl -s http://host.docker.internal:10254/api/health'
```

### 3. Mount Issues

**Container mount notes:**
- Docker supports both `-v` and `--mount` syntax
- Use `:ro` suffix for readonly mounts:
  ```bash
  # Readonly
  -v /path:/container/path:ro

  # Read-write
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (managed by OneCLI)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global AGENTS.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing WhatsApp messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: WhatsApp groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / Codex process exited with error

If sessions aren't being resumed (new session ID every time), or Codex exits with an error when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.codex/`. Inside the container, `HOME=/home/node`, so it looks at `/home/node/.codex/`.

**Check the mount path:**
```bash
# In container-runner.ts, verify mount is to /home/node/.codex/, NOT /root/.codex/
grep -A3 "Codex sessions" src/container-runner.ts
```

**Verify sessions are accessible:**
```bash
docker run --rm --entrypoint /bin/bash \
  -v ~/.codex:/home/node/.codex \
  nanoclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.codex/ 2>&1 | head -5
'
```

**Fix:** Ensure `container-runner.ts` mounts to `/home/node/.codex/`:
```typescript
mounts.push({
  hostPath: codexDir,
  containerPath: '/home/node/.codex',  // NOT /root/.codex
  readonly: false
});
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Codex directly:
```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  codex -p "Say hello" --approval-policy never
'
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## SDK Options Reference

The agent-runner uses these Codex SDK options:

```typescript
const codex = new Codex({
  config: {
    mcp_servers: { nanoclaw: { command: 'node', args: [mcpServerPath], env: { ... } } },
    instructions: buildInstructions(containerInput),
  },
});

const thread = codex.startThread({
  workingDirectory: '/workspace/group',
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  networkAccessEnabled: true,
  webSearchEnabled: true,
});
```

**Important:** `approvalPolicy: 'never'` and `sandboxMode: 'danger-full-access'` are required for automated execution inside containers.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
docker builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
docker images

# Check what's in the image
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Codex version ==="
  codex --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Codex sessions are stored per-group in `data/sessions/{group}/.codex/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.codex/` (NOT `/root/.codex/`)

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.codex/

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Authentication configured (OneCLI)?"
onecli secrets list 2>/dev/null | grep -qi "openai" && echo "OK" || echo "MISSING - register OpenAI secret: onecli secrets create --name OpenAI --type api_key --value YOUR_KEY --host-pattern api.openai.com"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n4. Container image exists?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.codex" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /home/node/.codex/, not /root/.codex/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
