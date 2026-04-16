# NanoClaw

A Claude-powered personal assistant that routes Slack and Gmail messages to agents running in isolated Apple Container sandboxes.

## What It Does

Messages arrive on a connected channel (Slack, Gmail). The orchestrator polls a SQLite queue, spawns an agent container with the group's memory and allowed mounts, streams the conversation into Claude Agent SDK (or Codex SDK), and sends the response back through the owning channel. Each group has isolated memory, sessions, and filesystem.

## Philosophy

- **Small enough to understand.** One Node.js process, a handful of source files under `src/`. Read the file you're curious about — that's the authoritative spec.
- **Secure by isolation.** Agents run inside Apple Container VMs with only explicitly mounted directories visible. Bash is safe because it runs inside the container, not on the host.
- **Credentials never reach the container.** [OneCLI's Agent Vault](https://github.com/onecli/onecli) intercepts outbound HTTPS and injects credentials at the gateway — agents can't read real tokens from env, files, or `/proc`.
- **Customization = code changes.** No configuration sprawl. Want different behavior? Edit the code. The codebase is small enough to make changes safely.
- **Skills over features.** Operational workflows (`/setup`, `/debug`, `/customize`) are [Claude Code skills](https://code.claude.com/docs/en/skills) that guide tasks rather than being hardcoded.

## What It Supports

- **Slack channels** — Dual-bot setup (`@패트` / `@매트`) via Socket Mode. Add with `/add-slack`.
- **Gmail** — As a tool (read/send/search/draft) or a full channel (emails can trigger the agent). Add with `/add-gmail`.
- **Dual SDK** — Claude Agent SDK and Codex SDK side by side, selectable per bot identity.
- **Isolated group context** — Each group has its own `CLAUDE.md` memory, sessions, and filesystem, mounted into a fresh container per invocation.
- **Main channel admin** — Your private channel (self-chat) registers/removes groups and schedules cross-group tasks.
- **Scheduled tasks** — Cron, interval, and one-time jobs that run a full Claude/Codex agent in the group's context.
- **Web access** — `WebSearch` and `WebFetch` tools inside the container.
- **Local audio transcription** — Slack voice messages are transcribed locally via `whisper-cpp` before reaching the agent.
- **Ollama MCP** — Optional local-model MCP server via `/add-ollama-tool`.
- **Context compaction** — `/compact` forwards the SDK's built-in compaction for long sessions.

## Usage

Talk to the assistant with the trigger word (default `@패트` or `@매트`):

```
@패트 send me an overview of today's work calendar every weekday morning at 9am
@패트 review the git history for the past week each Friday and summarize drift
@매트 매일 오전 8시에 HN AI 뉴스 큐레이션해줘
```

From the main channel you can manage groups and tasks:

```
@패트 list all scheduled tasks across groups
@패트 pause the Monday briefing task
@패트 add group "Family Chat"
```

## Customizing

NanoClaw has almost no configuration files. Tell Claude Code what you want and it modifies the source:

- "Change the trigger word to `@Bob`"
- "Keep responses under three sentences"
- "Add a greeting when I say good morning"

Or run `/customize` for guided changes.

## Requirements

- macOS with [Apple Container](https://github.com/apple/container) (the runtime is hardcoded to the `container` CLI)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [OneCLI](https://github.com/onecli/onecli) for credential vaulting
- `whisper-cpp` + `ggml-large-v3-turbo.bin` (for Slack audio transcription)
- Slack Socket Mode app with bot + app-level tokens
- GCP OAuth credentials for Gmail

## Getting Started

```bash
cd nanoclaw
claude
```

Inside the Claude Code prompt, run `/setup`. It walks through Node.js, Apple Container, OneCLI, channel skills (`/add-slack`, `/add-gmail`), launchd service install, and verification.

## Architecture

```
Channels → SQLite → Polling loop → Apple Container (Claude/Codex SDK) → Response
```

Single Node.js process. Channels self-register at startup — the orchestrator connects whichever have credentials. Agents execute in fresh Apple Container VMs with filesystem isolation. Only mounted directories are accessible. Per-group message queue with global concurrency control. IPC via filesystem.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel self-registration registry |
| `src/channels/slack.ts`, `slack-mat.ts` | Slack pat/mat bots |
| `src/router.ts` | Resolves owning channel for a JID |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/group-queue.ts` | Per-group queue with global concurrency |
| `src/container-runner.ts` | Spawns agents in Apple Container |
| `src/container-runtime.ts` | Container runtime bindings |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/transcribe.ts` | whisper-cpp audio transcription |
| `src/db.ts` | SQLite operations |
| `groups/{folder}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers |

See [docs/SPEC.md](docs/SPEC.md) for full architecture details, [docs/SECURITY.md](docs/SECURITY.md) for the security model, [docs/SDK_DEEP_DIVE.md](docs/SDK_DEEP_DIVE.md) for Agent SDK internals, and [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md) for macOS 26 vmnet setup.

## Debugging

Ask Claude Code directly: "Why isn't the scheduler running?" "What's in the recent logs?" That's the AI-native approach. Or run `/debug` for a guided checklist, or skim [docs/DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md).

## License

MIT
