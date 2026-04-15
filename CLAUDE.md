# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/SPEC.md](docs/SPEC.md) for architecture details.

## Quick Context

Single Node.js process with skill-based channel system. Channels (Slack, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Resolves the owning channel for a JID |
| `src/formatting.ts` | Message formatting helpers (escape, format, strip, outbound) |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Three types of skills exist in NanoClaw:

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-slack`, `/add-gmail`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Pre-Commit (MUST)

커밋 직전에 아래 세 가지를 **순서대로 전부 통과**시킨 뒤에만 `git commit` 한다.
husky 같은 자동 훅 없이 운영되므로, 이 책임은 전적으로 Claude(나) 에게 있다.

```bash
npm run format:fix     # prettier --write "src/**/*.ts" — 포맷 자동 정리
npx eslint src/        # 0 errors 필수 (warnings 는 차단 아님)
npx vitest run         # 전체 테스트 통과 필수
```

세 가지 중 하나라도 실패하면 원인 고친 뒤 다시 돌리고, 그래도 실패하면 커밋 안 한다.
변경 파일이 `src/` 밖(예: docs, config)이어도 관행상 셋 다 돌려 상태를 깨끗이 유지.

운영 룰:
- `npm run format:fix` 결과 없음 = 좋음 (변경점 없음)
- `eslint` 에 새 error 나오면 그 파일 수정 → 룰 완화 금지 (룰 바꾸려면 별도 논의)
- 테스트 실패하면 코드 고치거나 테스트 반영 — skip/xdescribe 로 우회 금지

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
