# NanoClaw

내 Claude/Codex 기반 개인 비서. Slack·Gmail 메시지를 받아 Apple Container 안에서 에이전트를 돌리고 응답을 돌려보낸다.

## Overview

단일 Node.js 프로세스가 orchestrator 역할을 한다. Channel 은 시작 시 self-register 하고 credentials 있는 놈만 붙는다. Agent 는 요청마다 새 Apple Container VM 에서 실행되고 명시적으로 mount 한 디렉터리만 본다. 그룹별 message queue + 글로벌 concurrency 제한. IPC 는 filesystem 기반.

## Architecture

```
Channel → SQLite → polling loop → Apple Container (Claude/Codex SDK) → Response
```

Container 는 ephemeral — 메시지 끝나면 종료되고 다음 요청에 새로 뜬다. 파일 기반 IPC 로 container 안의 agent 가 host 로 outbound message / scheduled task 작업을 보낸다. 한 그룹에 여러 메시지가 몰리면 per-group queue 가 직렬화하고, 전체 동시 실행 개수는 `MAX_CONCURRENT_CONTAINERS` 로 제한.

## What's Included

- **Slack 이중봇** — 패트(`@패트`) + 매트(`@매트`). 각각 독립 Socket Mode 앱, 같은 channel 에 두 봇이 공존
- **Gmail** — tool-only 또는 full channel (incoming email → agent trigger)
- **Dual SDK** — Claude Agent SDK + Codex SDK, 봇 identity 별로 routing
- **Group isolation** — 각 그룹의 `CLAUDE.md` memory · session · filesystem 은 완전 분리, container mount 단위로 잠김
- **Main channel admin** — self-chat 에서 group 등록·제거, cross-group task scheduling
- **Scheduled tasks** — cron / interval / once. Agent 전권으로 실행되고 결과를 그룹에 메시지로 보낼 수도, silent 로 끝낼 수도 있음
- **OneCLI Agent Vault** — outbound HTTPS 중간에서 credentials 주입. Container 안엔 real token 이 안 들어감
- **Local audio transcription** — Slack 음성/오디오를 `whisper-cpp` + `ggml-large-v3` 로 로컬 transcribe 후 agent 에 텍스트로 넘김
- **Ollama MCP** — `/add-ollama-tool` 로 로컬 모델 MCP 붙이기 (선택)
- **Context compaction** — `/compact` 로 긴 session 압축
- **DB auto-backup** — `store/messages.db` 매일 06시 launchd, 14일 보관

## Group Layout

| Group | 용도 |
|---|---|
| `slack_main` | 나와의 self-chat, 모든 admin 조작 |
| `slack_agent-tasks_*` | 업무 관리 (1SW / ADCHAIN / MYB) |
| `slack_agent-news_*` | RSS 뉴스 토론 (패트 08시 수집, 매트 09시 큐레이션) |
| `slack_agent-board_*` | 프로젝트 보드 (1차 개인 / 2차 공유) |
| `slack_agent-diary_*` | 일기 |
| `slack_agent-labs_*` | 자력 개발·배포 sandbox (full clone + gh/bun, PR → 패트 merge → Vercel / 맥미니 auto-deploy) |
| `slack_*_pat` / `slack_*_mat` | 그룹별 패트/매트 lane |

Group 폴더 naming 규칙은 `_pat` / `_mat` 접미사로 bot identity 식별. `slack_main` 만 예외.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator — 상태·message loop·agent 호출 |
| `src/channels/registry.ts` | Channel self-register registry |
| `src/channels/slack.ts`, `slack-mat.ts` | Slack 패트/매트 bot |
| `src/router.ts` | JID → owning channel resolution |
| `src/ipc.ts` | IPC watcher + task processing |
| `src/group-queue.ts` | Per-group queue + global concurrency cap |
| `src/container-runner.ts` | Apple Container agent spawn |
| `src/container-runtime.ts` | Container runtime bindings |
| `src/task-scheduler.ts` | Scheduled task executor |
| `src/transcribe.ts` | whisper-cpp audio transcription |
| `src/db.ts` | SQLite operations |
| `groups/{folder}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Agent container 안에 로드되는 skill |

## Usage

각 그룹에서 trigger word 로 호출:

```
@패트 매일 아침 9시에 오늘 캘린더 요약해줘
@매트 매주 금요일에 지난 7일 git log 리뷰해서 drift 정리해줘
@매트 매일 오전 8시에 HN AI 뉴스 큐레이션해줘
```

메인 채널(self-chat)에서만 가능한 것:

```
@패트 list all scheduled tasks across groups
@패트 pause the Monday briefing task
@패트 add group "Family Chat"
```

## Customization

Config 파일 대신 소스 수정으로 커스터마이즈한다. Claude Code 한테 뭘 원하는지 말하면 코드를 직접 고친다.

- "트리거 워드 `@Bob` 으로 바꿔"
- "응답 세 줄 이하로 유지해"
- "아침에 인사하면 브리핑 붙여줘"

가이드가 필요하면 `/customize`.

## Development

```bash
npm run dev          # hot reload
npm run build        # TS 컴파일
./container/build.sh # agent container rebuild
```

### Pre-commit (MUST)

husky 폐기, 자동 hook 없음. Commit 직전 아래 세 개 **순서대로 전부 통과** 시킨 뒤에만 `git commit`.

```bash
npm run format:fix
npx eslint src/ --max-warnings 0   # errors + warnings 모두 0
npx vitest run
```

활성 lint 룰은 `eslint.config.js` 참조. `any` 금지 (`@typescript-eslint/no-explicit-any: error`), catch-all 허용 (`no-catch-all/no-catch-all: off`), catch 에서 re-throw 시 `cause` 필수 (`preserve-caught-error: error`).

### Service Management (launchd)

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Container Build Cache

Apple Container 빌드킷이 build context 를 공격적으로 caching 한다. `--no-cache` 만으로는 COPY 스텝 invalidation 이 안 됨. 진짜 clean rebuild 가 필요하면 builder prune 후 `./container/build.sh`.

## Requirements

- macOS + [Apple Container](https://github.com/apple/container) — runtime 은 `container` CLI 하드코드
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [OneCLI](https://github.com/onecli/onecli) — credentials gateway
- `whisper-cpp` + `ggml-large-v3.bin` + `ggml-silero-v6.2.0.bin` (VAD) — Slack audio transcription
- Slack Socket Mode 앱 2개 (패트·매트 각각, `chat:write` · `channels:history` · `files:write` 등)
- GCP OAuth credentials — Gmail

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — architecture 상세
- [docs/SECURITY.md](docs/SECURITY.md) — security model + trust boundary
- [docs/SDK_DEEP_DIVE.md](docs/SDK_DEEP_DIVE.md) — Claude Agent SDK 내부
- [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md) — macOS 26 vmnet NAT · DNS 설정
- [docs/DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md) — debugging checklist

## Attribution & License

원 저작물: [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), MIT License.

이 포크는 원본에서 분기 후 패트/매트 dual bot · Codex SDK · OneCLI · whisper-cpp · 맞춤형 group 구조 등으로 독립 진화했고 upstream merge 는 더 이상 수행하지 않는다. 원본의 MIT 권리 고지는 [LICENSE](LICENSE) 참조.

MIT.
