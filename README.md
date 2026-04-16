# NanoClaw

내 Claude/Codex 기반 개인 비서. Slack·Gmail 메시지를 받아 Apple Container 안에서 에이전트를 돌리고 응답을 돌려보낸다.

## 한 줄 구조

```
채널 → SQLite → 폴링 루프 → Apple Container (Claude/Codex SDK) → 응답
```

단일 Node.js 프로세스. 채널은 시작 시 self-register 하고 크리덴셜 있는 놈만 붙는다. 에이전트는 요청마다 새 Apple Container VM에서 실행되고 명시적으로 마운트한 디렉터리만 본다. 그룹별 메시지 큐 + 글로벌 동시성 제한. IPC 는 파일시스템 기반.

## 이 포크에 붙어있는 것

- **Slack 이중봇** — 패트(`@패트`) + 매트(`@매트`). 각각 독립 Socket Mode 앱, 같은 채널에 두 봇이 공존
- **Gmail** — 도구 전용 또는 풀채널 (incoming email → 에이전트 트리거)
- **Dual SDK** — Claude Agent SDK + Codex SDK, 봇 아이덴티티별로 라우팅
- **그룹 격리** — 각 그룹의 `CLAUDE.md` 메모리·세션·파일시스템은 완전 분리, 컨테이너 마운트 단위로 잠김
- **메인 채널 관리자** — self-chat 에서 그룹 등록·제거, 크로스그룹 태스크 스케줄
- **스케줄 태스크** — cron / interval / once. 에이전트 전권으로 실행되고 결과를 그룹에 메시지로 보낼 수도, 조용히 끝낼 수도 있음
- **OneCLI Agent Vault** — outbound HTTPS 중간에서 크리덴셜 주입. 컨테이너 안엔 실토큰이 안 들어감
- **whisper-cpp 로컬 전사** — Slack 음성/오디오를 `ggml-large-v3-turbo` 로 로컬 전사 후 에이전트에 텍스트로 넘김
- **Ollama MCP** — `/add-ollama-tool` 로 로컬 모델 MCP 붙이기 (선택)
- **Context compaction** — `/compact` 로 긴 세션 압축
- **DB 자동 백업** — `store/messages.db` 매일 06시 launchd, 14일 보관

## 주요 그룹 레이아웃

| 그룹 | 용도 |
|---|---|
| `slack_main` | 나와의 self-chat, 모든 admin 조작 |
| `slack_agent-tasks_*` | 업무 관리 (1SW / ADCHAIN / MYB) |
| `slack_agent-news_*` | RSS 뉴스 토론 (패트 08시 수집, 매트 09시 큐레이션) |
| `slack_agent-board_*` | 프로젝트 보드 (1차 개인 / 2차 공유) |
| `slack_agent-diary_*` | 일기 |
| `slack_agent-labs_*` | 자력 개발·배포 샌드박스 (full clone + gh/bun, PR → 패트 머지 → Vercel/맥미니 자동 배포) |
| `slack_*_pat` / `slack_*_mat` | 그룹별 패트/매트 라인 |

그룹 폴더 명명 규칙은 `_pat` / `_mat` 접미사로 봇 식별. `slack_main` 만 예외.

## 주요 파일

| 파일 | 역할 |
|------|------|
| `src/index.ts` | 오케스트레이터 — 상태·메시지 루프·에이전트 호출 |
| `src/channels/registry.ts` | 채널 self-register 레지스트리 |
| `src/channels/slack.ts`, `slack-mat.ts` | Slack 패트/매트 봇 |
| `src/router.ts` | JID → 소유 채널 해결 |
| `src/ipc.ts` | IPC 감시 + 태스크 처리 |
| `src/group-queue.ts` | 그룹별 큐 + 글로벌 동시성 제한 |
| `src/container-runner.ts` | Apple Container 에이전트 스폰 |
| `src/container-runtime.ts` | 컨테이너 런타임 바인딩 |
| `src/task-scheduler.ts` | 스케줄 태스크 실행 |
| `src/transcribe.ts` | whisper-cpp 오디오 전사 |
| `src/db.ts` | SQLite 작업 |
| `groups/{folder}/CLAUDE.md` | 그룹별 메모리 (격리) |
| `container/skills/` | 에이전트 컨테이너 안에 로드되는 스킬 |

## 사용

각 그룹에서 트리거 워드로 호출:

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

## 커스터마이즈

설정 파일 대신 소스 수정으로 커스터마이즈한다. Claude Code 한테 뭘 원하는지 말하면 코드를 직접 고친다.

- "트리거 워드 `@Bob` 으로 바꿔"
- "응답 세 줄 이하로 유지해"
- "아침에 인사하면 브리핑 붙여줘"

가이드가 필요하면 `/customize`.

## 개발

```bash
npm run dev          # hot reload 실행
npm run build        # TS 컴파일
./container/build.sh # 에이전트 컨테이너 리빌드
```

### 커밋 전 필수 3체크

husky 폐기, 자동 훅 없음. 커밋 직전 아래 세 개 **순서대로 전부 통과** 시킨 뒤에만 commit.

```bash
npm run format:fix
npx eslint src/ --max-warnings 0   # errors + warnings 모두 0
npx vitest run
```

활성 lint 룰은 `eslint.config.js` 참조. `any` 금지 (`@typescript-eslint/no-explicit-any: error`), catch-all 허용 (`no-catch-all/no-catch-all: off`), catch 에서 재throw 시 `cause` 필수 (`preserve-caught-error: error`).

### 서비스 관리 (launchd)

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # 재시작
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### 컨테이너 빌드 캐시

Apple Container 빌드킷이 context 를 공격적으로 캐싱한다. `--no-cache` 만으로는 COPY 스텝 무효화가 안 됨. 진짜 clean rebuild 가 필요하면 builder prune 후 `./container/build.sh`.

## 요구사항

- macOS + [Apple Container](https://github.com/apple/container) — 런타임은 `container` CLI 하드코드
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [OneCLI](https://github.com/onecli/onecli) — 크리덴셜 게이트웨이
- `whisper-cpp` + `ggml-large-v3-turbo.bin` — Slack 오디오 전사용
- Slack Socket Mode 앱 2개 (패트·매트 각각, `chat:write` · `channels:history` · `files:write` 등)
- GCP OAuth 크리덴셜 — Gmail

## 문서

- [docs/SPEC.md](docs/SPEC.md) — 아키텍처 상세
- [docs/SECURITY.md](docs/SECURITY.md) — 보안 모델 + 신뢰 경계
- [docs/SDK_DEEP_DIVE.md](docs/SDK_DEEP_DIVE.md) — Claude Agent SDK 내부
- [docs/APPLE-CONTAINER-NETWORKING.md](docs/APPLE-CONTAINER-NETWORKING.md) — macOS 26 vmnet NAT·DNS 설정
- [docs/DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md) — 디버깅 체크리스트

## 출처 / 라이센스

원 저작물: [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), MIT License.

이 포크는 원본에서 분기 후 패트/매트 이중봇·Codex SDK·OneCLI·whisper-cpp·맞춤형 그룹 구조 등으로 독립 진화했고 upstream 머지는 더 이상 수행하지 않는다. 원본의 MIT 권리 고지는 [LICENSE](LICENSE) 참조.

MIT.
