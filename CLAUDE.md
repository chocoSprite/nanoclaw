# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/SPEC.md](docs/SPEC.md) for architecture details. Subproject design doc: [docs/DASHBOARD_DESIGN.md](docs/DASHBOARD_DESIGN.md) (web/ rebuild 서사).

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

## Secrets / Credentials

- **Claude SDK**: macOS keychain (`security find-generic-password -s "Claude Code-credentials"`) 의 OAuth 토큰을 컨테이너 env 로 직접 주입 (`src/container-credentials.ts`). 만료 시 `claude setup-token`.
- **Codex SDK**: 호스트 `~/.codex/auth.json` 을 그룹별 sessions dir 에 mtime 비교 복사 후 `/home/node/.codex/` 마운트 (`src/container-mounts.ts`). ChatGPT bearer 토큰 직접 사용.
- **Slack / 기타 채널 토큰**: `.env` (호스트 프로세스 전용, 컨테이너 진입 0).
- OneCLI 게이트웨이 통합은 2026-04-25 부로 제거됨.

## Channels & Groups

- Folder convention: pat-bot groups → `_pat` suffix, mat-bot groups → `_mat` suffix. `slack_main` is the only exception. Old `_dev` / `_review` suffixes are retired (2026-04-15 migration).
- Env vars follow the same identity-based naming: `SLACK_PAT_*` / `SLACK_MAT_*`, never role-based (`SLACK_REVIEW_*` is dead).
- Channel registry truth lives in `store/messages.db` (`registered_groups`). Docs drift — query the DB when verifying current state.
- JID prefixes: `slack:` (pat lane) / `slack-mat:` (mat lane) — migration 11 renamed `slack-review:` → `slack-mat:`.
- Renaming a group folder: see [docs/GROUP_RENAME.md](docs/GROUP_RENAME.md) for the 7-point DB/filesystem sync checklist.

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
npm run format:fix            # prettier --write "src/**/*.ts"
npx eslint src/ --max-warnings 0   # 0 errors + 0 warnings 필수
npx vitest run                # 전체 테스트 통과 필수
```

세 가지 중 하나라도 실패하면 원인 고친 뒤 다시 돌리고, 그래도 실패하면 커밋 안 한다.
변경 파일이 `src/` 밖(예: docs, config)이어도 관행상 셋 다 돌려 상태를 깨끗이 유지.

현재 활성화된 lint 룰 (`eslint.config.js`):
- `preserve-caught-error: error` — catch 블록에서 새 Error 던질 때 `cause`로 원본 연결
- `@typescript-eslint/no-unused-vars: error` — `_` 접두사는 허용
- `@typescript-eslint/no-explicit-any: error` — `any` 금지 (의도적이면 `unknown` + 타입가드)
- `no-catch-all/no-catch-all: off` — catch-all 스타일 허용 (디자인 선호 이슈로 끔)

운영 룰:
- `npm run format:fix` 결과 없음 = 좋음 (변경점 없음)
- `eslint` 에 새 error/warning 나오면 그 파일 수정 → 룰 완화 금지 (룰 바꾸려면 별도 논의)
- 테스트 실패하면 코드 고치거나 테스트 반영 — skip/xdescribe 로 우회 금지

### Gotcha: direct `registered_groups` UPDATE needs a restart

`state.registeredGroups` 는 startup 시 DB 를 **한 번만** 읽어 in-memory Map 에 로딩. 이후 `sqlite3 ... UPDATE` 로 `container_config` / `sdk` / `trigger_pattern` 등을 직접 고치면 다음 컨테이너 spawn 도 **여전히 old 설정**으로 돈다. 반드시 `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (또는 `systemctl --user restart nanoclaw`) 로 재시작.

**예외**: 대시보드 `PATCH /api/groups/:jid` 경로(모델 전환, 세션 리셋)는 `reloadGroupState()` 를 호출하므로 재시작 없이 hot reload. 새 컬럼을 대시보드 편집기에 추가할 때는 `src/dashboard/services/groups-editor-service.ts::patchModel` 패턴을 그대로 따라가면 됨.

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
