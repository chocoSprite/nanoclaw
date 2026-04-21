# nanoclaw-dashboard 재작성 로드맵 (2026-04-19 확정)

**결정**: 서버 유지·개선 + 프론트 재작성 (옵션 A 하이브리드)
**배경**: 기존 대시보드 (7뷰, 집계 중심, polling-only) 불만족 원인 = "지금 뭐 하고 있어" 에 답 못함. 스택 문제 아님, 정보 아키텍처 문제
**실행 환경**: Mac mini @ 집, Tailscale 접근 (CLI/Slack 알림이 부족해서 웹으로 만든 것)
**경로**: `/Users/jhheo/Documents/Projects/nanoclaw-dashboard/`

## Why (판단 근거)
- **Why**: 서버 `dashboard-service.ts`(462줄) + `debug-service.ts` + `onecli-service.ts` + `shared/contracts.ts`(225줄) + `scripts/bootstrap.sh`/`run.sh`/fixture 모드 는 자산. 맥미니 read-only 마운트 해결, OneCLI CRUD, pino 파싱 엣지케이스 다 녹아있음 — 재발명 낭비
- 반면 `src/App.tsx` 51KB/1524줄 단일 파일 + 풀링 스토어 + 탭 6개(집계 중심) 는 부채. 리팩터 비용 > 재작성 비용, 이벤트 스트림 도입 시 스토어 모델 자체가 달라짐
- **How to apply**: 대시보드 개선 작업 시 서버는 확장하고 프론트는 신설 디렉토리에 새로 짠다. 옛 UI 는 옆에 유지하면서 superset 되면 폐기

## 자산 (유지)
- `server/dashboard-service.ts` — SQLite 쿼리 + 헬스 계산
- `server/debug-service.ts` — pino JSON+pretty 혼재 파싱
- `server/onecli-service.ts` — 시크릿/에이전트 CRUD
- `shared/contracts.ts` — 타입 정돈됨
- `scripts/bootstrap.sh` + `run.sh` — 공유 소스 → 머신로컬 runtime 복사 (read-only 마운트 해결)
- `scripts/export-review-fixtures.sh` + fixture 모드 — 리뷰 환경 native module 없이 실행
- `.env` 이중화 (shared example vs 머신로컬 runtime)
- Read-only DB 접근 원칙

## 부채 (버림)
- `src/App.tsx` 51KB 단일 파일
- 탭 6개 구조 (overview/groups/automation/sessions/debug/onecli) — 재설계
- `src/index.css` 15KB 수제 — Tailwind/shadcn 생태계로 이전
- Polling-only 데이터 패턴 — WebSocket 추가

## 로드맵 (우선순위)

### 서버 확장
1. `src/ipc.ts`(NanoClaw 본체) 에 이벤트 훅 추가 → 대시보드 서버로 fan-out
2. `server/events-service.ts` + `/ws` 엔드포인트 신설 (`ws` 패키지, socket.io 불필요)
3. `shared/contracts.ts` 확장: `LiveToolCallEvent`, `SessionEvent`, `ContainerRuntimeState`
4. `docker inspect` / `podman inspect` 래퍼로 런타임 fact (mounts/skills/CLAUDE.md path) 노출
5. `store/messages.db` 에 **FTS5 virtual table** 추가 + `/api/sessions/search`

### 프론트 재작성
- 신설 경로: `web/` (기존 `src/` 는 `src-legacy/` 로 리네임 대기)
- 스택: **Vite + React 19 + Tailwind v4 + shadcn/ui + react-router-dom + TanStack Query + `useSyncExternalStore` for WS**
- 참고: Hermes `/web/src/pages/*.tsx` 옆에 띄워놓고 베끼기 (동일 스택)
- 페이지 순서 재설계: **Live → Status → Groups → Sessions → Automation → Config/OneCLI**

### 페이지 우선순위 (P0 부터 구현)
- **P0 LivePage** — OpenClaw `logs.tail` + Hermes ToolCallBlock 합성. 그룹별 "마지막 tool call 카드"(함수명+인자+경과시간, >60s 빨간 펄스) + IPC 이벤트 스트림. 이게 "지금 뭐 하고 있어" 를 해소하는 단 하나의 기능
- **P1 Status banner** — 최상단 영구 빨간 배너 (crash loop / OneCLI 401/403 / 5분+ pending / scheduled task 실패). 클릭 → 해당 그룹 필터
- **P2 Groups 런타임 inspector** — DB 상태 + 실제 컨테이너 런타임 fact (mounts/skills/CLAUDE.md path+diff/세션 모델/컨텍스트 토큰 게이지). Hermes SkillsPage 의 Switch UX 차용해 스킬 enable/disable
- **P3 Sessions FTS5 검색** + 메모리(MEMORY.md) 인덱스 포함 — NanoClaw 특유 가치
- **P4 Automation Cron CRUD** — Trigger Now / Pause / Resume / Delete + run history stderr
- **P5 Obsidian integration** — 그룹 카드에서 `02_Identity`/`08_Learnings/nanoclaw/groups/<g>.md` 바로 링크. 인시던트는 `08_Learnings/nanoclaw/incidents/YYYY-MM-DD.md` 로 append. NanoClaw 특유

### 전환 전략
1. 새 `web/` 가 P0 LivePage + P1 Status 만으로도 옛 UI 못하던 걸 함 → 즉시 체감 가치
2. 옛 `src/` 는 계속 돌면서 Groups/Sessions 탭 비교 레퍼런스
3. 새 UI 가 superset 된 시점에 `src/` → `src-legacy/` 리네임, `web/` → `src/` 승격
4. `dist/` 빌드 출력 경로 불변 → `scripts/start.sh`/`run.sh`/배포 스크립트 수정 최소

## 성공 기준
- "지금 뭐 하고 있어?" 질문이 사용자가 나한테 오지 않고 LivePage 에서 즉시 해소
- Hang 이 발생하면 Status banner 에 자동 포착, 원인 그룹이 한 번의 클릭으로 드러남
- 브라우저만으로 CLAUDE.md / 스킬 / 마운트 inspect 가능

## 2026-04-19 후속 구체화 (P0 착수 시점)

**옵션 A 하이브리드** 를 다음과 같이 확정:

- **서버는 별도 프로세스 아님 — NanoClaw 본체에 embed**. 이유: Hermes/OpenClaw 둘 다 단일 프로세스, `state.registeredGroups`/`GroupQueue`/`logger` 에 직접 접근 가능, Tailscale bind 지점 한 군데로 족함. `dist/` 단일.
- **이벤트 전달 = in-process EventEmitter → WebSocket**. 파일 IPC (기존 `src/ipc.ts`) 는 agent↔host 방향만 유지, host 내부 fan-out 은 새 `src/agent-events.ts` 버스. 파일/소켓 IPC 안 씀.
- **레포 통합**: 기존 `Projects/nanoclaw-dashboard/` 폐기 후보. `nanoclaw/web/` 로 편입 (npm workspaces). 프론트 재작성은 `web/` 백지에서 시작, 옛 `src/` 이식 안 함.
- **모듈 경계 불변**: `rm -rf src/dashboard && npm run typecheck && npm test` 통과해야 함. 그래서 `src/agent-events.ts` 는 `src/dashboard/` **밖**에 둠 (본체 공용).
- **에러 격리 3단**: A(startup try/catch) / B(`runInIsolation` 핸들러 래퍼) / C(http/ws error 핸들러). `uncaughtException` 은 logger 소유.
- **P0 스코프 = β**: 카드당 "현재 tool 이름" 1줄. **Claude 그룹**은 tool_use, **Codex 그룹**은 status 라이프사이클만 (SDK 한계 — tool_use 미노출). 등록된 모든 그룹 항상 표시 (idle 회색).
- **agent-runner 수정 허용**: `container/agent-runner/src/{claude,codex}-adapter.ts` 에 새 EVENT_V1 마커 (`---NANOCLAW_EVENT_V1_START---`) 를 통해 이벤트 emit. 기존 OUTPUT 마커와 공존. 이미지 rebuild 불필요 (entrypoint 가 매 run tsc 재컴파일).

### 산출물 (이 세션에서 생성)
- **플랜 파일**: `/Users/jhheo/.claude/plans/cozy-sauteeing-tome.md` — 9 steps (Step 0 DB 백업 → Step 8 E2E+production). 다음 세션에서 재개 시 읽을 것.
- **롤백 스냅샷**: `store/backups/messages-pre-dashboard-embed.db` — 14일 rotation 에 살아남도록 태그만 붙인 불변 스냅샷. P0 완료 후 1~2주 유지 후 삭제.

### 진행 체크포인트 (2026-04-19 compact 직전)
- ✅ **Step 0** DB 백업
- ✅ **Step 1** 워크스페이스: `web/` 스캐폴드 (Vite 7 + React 19 + Tailwind v4 + shadcn utils + router + TanStack Query), 루트 `package.json` workspaces + express/ws
- ✅ **Step 2** 이벤트 코어: `src/agent-events.ts` (스키마 + `InProcessEventBus` + `agentEvents` 싱글톤) + `src/dashboard/{events,event-bus,isolation,throttle}.ts`. 테스트 12개
- ✅ **Step 3** 어댑터+서비스: `src/dashboard/adapters/{state,queue}-adapter.ts` + `live-state.ts` + `services/groups-service.ts`. 테스트 7개
- ✅ **Step 4** HTTP+WS: `src/dashboard/{config,router,server,ws-hub,index}.ts`. `src/index.ts::main()` 에 `startDashboard({agentEvents, queue})` 호출 추가. 플래그 `DASHBOARD_ENABLED=1`/`DASHBOARD_PORT=3030`. 32 client cap, 30s heartbeat. **라이브 스모크 통과** (`/api/health`, `/api/groups/live`, WS upgrade + snapshot frame)
- ✅ **Step 5** agent-runner emit: `container/agent-runner/src/shared.ts` 에 `EVENT_V1` 마커 + `writeEvent` + `createEventEmitter`. claude-adapter 는 status.started/tool.use/tool.result/status.ended 모두, codex-adapter 는 status.\* 만 (SDK 한계)
- ✅ **Step 6** 호스트 파서: `src/marker-parser.ts` (OUTPUT+EVENT 동시 지원 `StreamMarkerParser`) → `src/container-runner.ts` 배선. host-side `container.spawned`/`container.exited` emit. 테스트 10개. **라이브 E2E 통과** (bus.emit → throttle → WS broadcast 확인)
- ✅ **Step 7** 프론트 P0 LivePage: `web/src/contracts.ts` (schema mirror) + `lib/{api,ws-client,live-store}.ts` + `pages/LivePage.tsx` + `components/GroupLiveCard.tsx`. TanStack Query `/api/groups/live` + WS 병합, `useSyncExternalStore` store, 1/2/5/15s 재접속 backoff, 60s > 빨간 펄스
- ✅ **Step 8** Production 배선: `server.ts` 에 app-level Layer C 추가 (router 내부 final handler 는 등록 순서 뒤 throw 못 잡음 → JSON 500 을 보장하기 위해 이동). launchd plist 에 `DASHBOARD_ENABLED=1` + `DASHBOARD_PORT=3031` 추가 (3030 은 agent-board/apps/api bun 이 선점중). `launchctl unload+load` 필요 (kickstart 만으로는 plist 리로드 안 됨). **Live production 확인**: PID 87600 이 env 들고 부팅 → `:3031` bind → 등록된 Slack 그룹 전체가 `/api/groups/live` 에 나옴, SPA `/`·`/live` 200

### 구현 중 결정된 세부사항 (플랜과 다른 부분)
- **marker-parser 위치**: 플랜은 `src/container-runner.ts` 안에 쓰는 것이었으나, 테스트 용이성 + `rm -rf src/dashboard` 불변 유지 위해 `src/marker-parser.ts` 로 분리. 테스트는 플랜대로 `src/dashboard/__tests__/marker-parser.test.ts`
- **`src/agent-events.ts` 가 authoritative 스키마**, `src/dashboard/events.ts` 는 re-export + WS 프레임 타입만. 원래 플랜은 dashboard/events.ts 가 authoritative 였음
- **WS 프레임 현재 상태**: `snapshot` + `event` 만. `roster` 는 Step 7 에서 추가 예정 (그룹 등록 변경 시 broadcast)
- **Throttle 은 1Hz 가 아니라 "same toolName 1s 내 skip"** — 다른 toolName 연속이면 즉시 통과. status/container 항상 통과. 플랜 워딩 ("1 Hz cap") 이 오해소지 있어 throttle.ts 상단 주석으로 명확화
- **vite 중복 dedupe**: web workspace 의 vite 를 `^7` 로 올려야 루트 (vitest 가 끌고 오는) vite 와 dedupe 됨. `^6` 이면 tsc -b 가 Plugin 타입 mismatch 냄
- **prettier 자동 배선 안 함**: husky 없음 (기존 NanoClaw 정책). 커밋 전 수동 `format:fix && eslint --max-warnings 0 && vitest` 가 CLAUDE.md 게이트

### P0 완료 후 접근 정보 (2026-04-19)
- Dashboard port: **3031** (3030 은 agent-board/apps/api bun 이 점유)
- 맥미니 @ 집, Tailscale 로 `http://<mac-mini-tailscale-ip>:3031/` 접근. `/live` 가 LivePage
- launchd plist: `~/Library/LaunchAgents/com.nanoclaw.plist` + 템플릿 `launchd/com.nanoclaw.plist` 둘 다 env 추가됨
- plist 변경 후 반영은 `launchctl unload && launchctl load` (kickstart 만으로는 env 리로드 안 됨 — 함정)
- 사전 DB 백업 스냅샷 `store/backups/messages-pre-dashboard-embed.db` — P0 안정화 1~2주 후 삭제 가능

### P1+ 로 남긴 것 (플랜에 명시)
- Overview/Activity/Sessions/OneCLI/Debug 탭 (기존 dashboard-service.ts 이식)
- FTS5 검색 (P3) — messages + MEMORY 동시 검색
- Cron CRUD (P4), Obsidian integration (P5)
- Codex 의 item.completed 텍스트 사후 파싱해서 tool.use 추정 (SDK 한계 우회)
- WS `roster` 프레임 실제 broadcast — 현재 스키마만 존재, 송신 로직 없음. 그룹 등록/삭제 이벤트 생기면 활성화
- `src/channels/slack.test.ts` pre-existing TS2571 에러 (main baseline). `npm run build` 는 `--skipLibCheck` 로 통과 못 함, eslint+vitest 는 통과. 프로덕션 배포 시 `tsc --build` 가 test 파일 건너뛰게 tsconfig 정리 필요

### 2026-04-20 P0+ Shell 확장 (commit 6f429d9)
사용자 피드백 "그룹 라이브 하나만이라 대시보드답지 않다" 로 shell 추가.
Hermes 는 실제 뜯어봤을 때 **topbar-only + 가로 탭** 이었음 — 레퍼런스 메모는 있었지만 구성만 참고하고 **디자인은 독자적** (neutral dark + shadcn 톤 + 모바일 first). brutalist/uppercase 안 씀.

**결정 근거 (사용자 선택)**:
- 네비게이션 = **사이드바 + shadcn Sheet** (데스크톱 고정, 모바일 햄버거 drawer). 바텀내비 안 씀 (페이지 5~7개로 늘어나면 한계)
- 알림 slot = **TopBar 벨 뱃지 + 드롭다운**. 고정 배너/토스트 안 씀 (아이폰 세로공간 비용)
- KPI 상단 스트립 = **안 둠**. 그룹 카드 자체가 시각적 답이고 수치는 나중 Analytics 가치
- 다국어 = **안 씀** (한국어 하드코딩, i18n 레이어 제거)
- 테마 토글 = **없음** (다크 only)

**파일 구조**:
- `web/src/index.css` — Tailwind v4 `@theme` 블록, ~20 semantic color token (success/warning/info/destructive + muted-foreground 등), safe-area inset, prefers-reduced-motion
- `web/src/components/ui/` — 9개 (button · card · badge · input · separator · skeleton · scroll-area · sheet · dropdown). **Radix 의존성 0**, cva + clsx + tailwind-merge 로만 구현. Sheet 은 Escape + 백드롭 클릭, Dropdown 은 click-outside 자체 핸들링
- `web/src/layout/{AppShell,Sidebar,TopBar}.tsx` — lg 경계로 사이드바↔Sheet 전환, NAV_ITEMS 배열 하나가 두 곳 공유
- `web/src/pages/PlaceholderPage.tsx` — Automation/Health/Logs 3개 route 에 사용. "준비중" 대신 **"이 페이지가 담을 것" 체크리스트** 로 기대치 세팅

**모바일 원칙 (실측 확정)**:
- 기본 single col → `sm:` 2열 → `xl:` 3열 (이전 `lg:` 3·4열은 데스크톱 과다)
- 터치 타겟 h-11 (44px) — HIG 권장
- Safari Tailnet (`100.117.197.64:3031`) 에서 확인 완료 — 사용자 "이걸 원했어"

**다음 후보 (우선순위 미확정)**:
- Automation 실구현 — scheduled_tasks DB + run history
- Health 실구현 — P1 Status banner 의 backend probe (crash loop / OneCLI 401 / pending lag / slack socket)
- Logs 실구현 — pino+pretty 파서 (기존 nanoclaw-dashboard/server/debug-service.ts 의 재작성 필요)
- Live 페이지 자체 개선 (ToolCallBlock 이식 등)

어느 걸 먼저 할지는 **다음 세션에 사용자와 논의** 해서 결정 — 이번 세션 교훈: 플랜 6단계 혼자 밀지 말고 작은 단위로 같이 검증

### 2026-04-20 A 트랙 완료 (R1 + R2a 배포, Health 폐기 확정)

논의 결과 로드맵을 **A 트랙 (Automation + Logs + 부가)** 로 압축. Health 는 다른 페이지와 겹침 커서 폐기 — OneCLI 에러는 벨 드롭다운으로, 나머지는 Live/Automation/Logs 에 분산.

A 트랙 플랜 문서: `/Users/jhheo/.claude/plans/cozy-sauteeing-tome.md` (이전 P0 플랜 덮어씀)

**확정 결정사항 (논의 박제)**:
- 순서: R1 Automation → R2a Logs 기반 → R2b Derived 신호 → 부가
- Logs 포맷: **logger JSON 전환** (pino 호환). 터미널은 `npm run tail` 로 pino-pretty 파이프 — 사용자는 맥미니 터미널 거의 안 붙음
- Automation Create/Update **제외** (Slack 트리거로만 유지). Delete / Trigger Now / Pause / Resume 만 제공
- 파괴적 UI: **shadcn Dialog 스타일 커스텀 모달** (메모리 `feedback_destructive_modal_ux.md` 별도 박제)
- /health route 제거는 부가 단계. 사이드바에서도 "soon" 으로 숨김

**완료 상태 (2026-04-20 기준)**:
- ✅ **R1 Automation** (`97a89bc`) — `/api/automation/tasks` + runs + pause/resume/trigger/delete. AutomationPage (expand → 최근 10회 run history, Trigger/Delete 는 모달). task-scheduler 가 `automation.task.run_*` 이벤트 emit
- ✅ **R2a Logs 기반** (`c7dd20e`) — `src/logger.ts` JSON 출력. `npm run tail` 스크립트. `src/dashboard/services/logs-service.ts` (reverse-chunk readRecent + chokidar openStream). `/api/logs/recent` + WS `{type:'log'}` 프레임. LogsPage (필터 + live tail + detail overlay)
- ✅ **tsconfig 빌드 수정** (`fe36716`) — `src/**/*.test.ts` exclude. `npm run build` 동작
- ✅ **Sidebar 활성화** (`b9cbc8a`) — Automation/Logs 나브 disabled 해제. Health 만 "soon" 유지
- ✅ **UI polish** (`fec3525`) — CardContent pt-0 기본값 제거 (shadcn 관례라 CardHeader 없는 페이지에서 top 여백 증발했던 것). Automation 카드 PC 레이아웃 재설계 (group·status·actions 한 줄 + 일정/다음/마지막 KV 그리드). cron 표현 자연어 변환 (`0 */6 * * *` → "6시간마다", 매일/매주/매월 대응). raw cron 삭제

**프로덕션 배포 상태 (2026-04-20 10:20)**:
- launchd 재기동 (PID 54699 @ :3031), `launchctl unload + load` 방식. kickstart 만으로 plist env/코드 리로드 안 됨 함정은 여전
- 대시보드 주소: Tailnet `http://<mac-mini>:3031/` — live / automation / logs 3개 동작
- 테스트 483개 (automation-service 8 + logs-service 8 신규 포함)

**이번 세션 교훈 (중복 박제)**:
- Health / Automation / Logs probe 는 데이터 소스 겹침이 많음. 사용자 논의로 **Health 폐기 + 벨 드롭다운으로 흡수** 결정. 플랜만 보고 무작정 밀면 안 되는 케이스
- `CardContent` default 에 pt-0 숨어있던 shadcn 관례 때문에 `<Card><CardContent>...` 쓰는 페이지 전부 top 여백 없었음. 커스텀 시 디폴트 점검 필수
- cron raw 문법은 대시보드에서 **숨김 대상**. 사람 눈에 띄는 건 "6시간마다 (30분)" 같은 자연어만. cronstrue 같은 dep 안 쓰고 `humanizeCron()` 소형 함수로 주요 패턴 (every minute / every N min / every N hour / daily / weekly / monthly) 커버 — 그 외는 raw fallback

**다음 세션 재개 포인트**:
- (해결됨 2026-04-20) R2b + 부가 완료 — 아래 "A 트랙 완전 종료" 섹션 참고
- (해결됨 2026-04-20) B 트랙 완료 — 커밋 `e19d69c`. 아래 "B 트랙 완료" 섹션 참고
- (해결됨 2026-04-20) C 트랙 완료 — 커밋 `113ceeb`/`24bbfd1`/`c126ed3`. 아래 "C 트랙 완료" 섹션 참고
- (해결됨 2026-04-20) mat_config DB 읽기 fix — 커밋 `56ad8d4`. 아래 "잡다 fix" 섹션 참고
- (해결됨 2026-04-20) Codex per-group 모델 전환 — 커밋 `5438088`. 아래 "잡다 fix" 섹션 참고
- (해결됨 2026-04-20) 전사 observability — 커밋 `51b7d6d`. 아래 "전사 observability" 섹션 참고
- (해결됨 2026-04-21) Codex 토큰 누적 카운트 버그 — 커밋 `3240fc0`. 아래 "2026-04-21 3-PR" 섹션 참고
- (해결됨 2026-04-21) GroupDetailPage 필드 누락 (Scope B) — 커밋 `c0f085c`. 아래 "2026-04-21 3-PR" 섹션 참고
- (해결됨 2026-04-21) Codex 윈도우 상수 교정 — 커밋 `04354b4`. 아래 "2026-04-21 3-PR" 섹션 참고
- (해결됨 2026-04-21) matConfig/review_config 전면 제거 + migration #13 — 커밋 `fb4883a`. 아래 "matConfig 전면 삭제" 섹션 참고
- 남은 로드맵: Sessions FTS5 · Obsidian 링크 · pat/mat follow-up (container assistantName per-lane / prefix fallback 제거)

### 2026-04-20 A 트랙 완전 종료 — R2b + 부가 (3 PR)

사용자 논의로 3 Phase 분할 (P0 cleanup → P1 backend → P2 frontend). 각 PR 독립 머지 가능하도록 P1 backend 만 머지돼도 프론트가 WS 신프레임을 silent drop 하게 설계. E2E 실측 검증 완료.

**완료 커밋**:
- ✅ **P0 `ab4708e`** — pending lag 배지 + /health 제거. `GroupState.pendingSinceTs` (ms epoch) 신설. 빈→pending 전환 지점 3곳에 if-not-set 가드, `runForGroup` 진입 시 null 리셋. `LiveGroupState` 에 `pendingSinceTs` 필드 추가 → `web/src/components/GroupLiveCard.tsx` 가 `useElapsedFromMs` 로 매 초 tick (서버가 이벤트 안 보내도 클라가 갱신). `/health` 라우트+사이드바+PlaceholderPage 모두 삭제, `*` 와일드카드로 `/live` 리다이렉트
- ✅ **P1 `7c379c3`** — `log_signals` 테이블 + 마이그레이션 #12 (partial unique index on `(kind, COALESCE(group_folder,''))` WHERE active). `src/dashboard/services/log-signals-service.ts` 가 **logs-service.subscribe + agentEvents.on('container.exited') 이중 구독**. 감지 3종: oauth_failure (msg `/\b40[13]\b/`) · crash_loop (in-memory `Map<group, number[]>` ring) · upstream_outage (단일 ring, multi-group, groupFolder=null). REST `/api/logs/signals` + `POST /:id/dismiss`. WS `{type:'signal', status:'active'|'resolved', signal}`. sweep `setInterval` 기본 5분 + `.unref()`. 임계치 env 튜닝 (`SIGNAL_*`). 10 단위 테스트 (detectors + windowing + upsert + dismiss + isolation + partial index)
- ✅ **P2 `e58e385`** — `web/src/lib/signals-store.ts` (useSyncExternalStore + `Map<id, LogSignal>`, 독립 WsClient). TopBar NotificationBell 실구현 (kind 아이콘 KeyRound/AlertTriangle/CloudOff, count 배지 `9+` cap, X 버튼 dismiss 낙관적 삭제). LogsPage `?signalId=` deep-link → group filter 자동 세팅 + level=error. destructive Card 배너 위 `[상세][무시]` 버튼, 상세는 Dialog 오버레이. AppShell `useEffect` 로 `signalsStore.start/stop` 라이프사이클

**E2E 실측 검증 (launchd PID 5071 @ :3031)**:
```bash
printf '{"level":50,"time":%d,"pid":1,"msg":"slack auth_test returned 401","group":"slack_main"}\n' "$(date +%s000)" >> logs/nanoclaw.log
```
→ 파일 append → chokidar → logs-service → log-signals-service → DB upsert → WS broadcast → 벨 count=1, dropdown 카드 렌더. 2번째 inject 시 같은 id, count=2 (upsert bump). Dismiss 버튼 → dismissed_at 세팅 + 벨에서 사라짐

**구현 중 플랜과 다른 세부사항** (중요):
- **감지 소스 이원화 필수** — container.exited 는 agent 이벤트라 logs-service 스트림 밖. log-signals-service 는 **logs + agentEvents 둘 다 구독**. 원래 플랜은 logs-only 로 오해했음. 다음 "새 signal kind 추가" 시 동일 주의
- **index.ts wiring 순환 의존** — hub 가 server 필요, router 가 signalsService 필요, signalsService.onSignalChange 가 hub 필요. 해결: `let hub: WsHub | null = null;` + signalsService 가 `hub?.broadcastFrame` 으로 deferred 참조, 이후 hub 할당 → `logSignalsService.start()`. `stop()` 에서는 const 로 캡처 (strict null)
- **partial unique index** 는 "안전망" 이고 실제 de-dup 은 SELECT→UPDATE/INSERT 명시적 분기. better-sqlite3 동기라 race 없음
- **scope 키 확인** — 구현 전 걱정한 것보다 단순. 현재 host logger 가 찍는 구조화 필드는 `scope` 위주이고 401/403 문자열은 msg 자체에 나옴. `/\b40[13]\b/` 매치로 충분
- **프론트 WsClient 3개** (live-store · LogsPage · signals-store) — 각 스토어가 독립. 같은 프레임을 서버가 3번 broadcast. 대역폭 낭비이지만 MVP 범위. 멀티플렉서 리팩토링은 후속
- **iOS Safari Dropdown trigger** 는 `<button>` 로 교체해서 focus 안정화 (`<span>` 이면 탭 안 먹힘)

**확정된 기본 임계치** (launchd env 안 건드리면):
- `SIGNAL_CRASH_LOOP_WINDOW_SEC=300 / COUNT=3`
- `SIGNAL_UPSTREAM_WINDOW_SEC=120 / COUNT=5`
- `SIGNAL_AUTO_RESOLVE_HOURS=24`
- `SIGNAL_SWEEP_INTERVAL_MS=300_000`

보수적이라 첫 주는 벨 조용할 가능성 높음. false-positive 나오기 시작하면 각 CONF 올리고 launchd plist 재적용 (`unload + load`)

**배포 절차 확정**:
1. `npm run build` (backend tsc — 빼먹으면 dist/ stale, 새 엔드포인트 404)
2. `cd web && npm run build` (번들 해시 갱신, 브라우저 Cmd+Shift+R)
3. `launchctl unload + load ~/Library/LaunchAgents/com.nanoclaw.plist` (kickstart 만으론 코드 리로드 안 됨은 이미 박제된 함정)

### 이번 세션 추가 교훈 (2026-04-20)
- **3 PR 분할 vs 1 PR** — 사용자가 "같이 진행" 요청해도 독립 머지 가능성은 유지. P0 는 완전 독립, P1 은 프론트 없이도 CLI/curl 로 스모크 가능. 리뷰/롤백 편의 크게 향상
- **프로덕션 배포 시 backend build 까먹기 쉬움** — dist/ 가 stale 이면 launchd 재기동해도 구버전 실행. 이번 세션 `/api/logs/signals` 첫 호출 404 로 확인. 앞으로는 `npm run build + cd web && npm run build` 묶음이 "배포 준비" 체크리스트
- **WS 신프레임 타입 무해 추가** — live-store onFrame switch 는 default 없어서 모르는 프레임 silent drop. 새 프레임 타입 추가해도 기존 store 들이 안 터짐. WsMessage union 확장이 안전한 이유

### Step 7 구현 요약 (LivePage)
- **web/src/contracts.ts**: 서버 `src/dashboard/events.ts` + `src/agent-events.ts` 의 mirror. path alias 아닌 복붙 (web tsconfig 격리 유지)
- **web/src/lib/ws-client.ts**: `WebSocket` 래퍼, backoff `[1s, 2s, 5s, 15s]`, onFrame/onStatus 콜백
- **web/src/lib/live-store.ts**: `Map<jid, LiveGroupState>` + `useSyncExternalStore`. 리듀서는 `src/dashboard/live-state.ts` 와 1:1 미러. snapshot/event/roster 3종 프레임 처리. 모르는 jid 이벤트는 drop
- **web/src/pages/LivePage.tsx**: TanStack Query 로 `/api/groups/live` 초기 hydrate → WS 가 덮어씀. 등록된 모든 그룹 grid 렌더, 비어있으면 "등록된 그룹 없음"
- **web/src/components/GroupLiveCard.tsx**: 그룹명/SDK 배지/상태 dot/currentTool(null→"idle" italic)/elapsed 초. idle 은 `opacity-50`, running & 60s+ 는 `animate-pulse text-rose-400`
- **WsStatusBadge**: 헤더 우측에 ws 상태 (connecting/open/closed/error) 배지

### Step 7 중 마주친 이슈 & 해결
- React 19 에서 `JSX.Element` 글로벌 네임스페이스 제거됨 → 반환 타입 제거 (인퍼런스)
- `tsc -b` (dist build) 가 container-runner 에서 `OUTPUT_START_MARKER` 미import 감지 → marker-parser 에서 import 추가
- `isolation.ts` 의 `out as Promise<unknown>` 캐스트가 TS5.9 strict 에서 `T → Promise` 직접 캐스트 거부 → `as unknown as Promise<unknown>` 2-hop
- pre-existing `src/channels/slack.test.ts` TS2571 에러는 main baseline 부터 존재, CLAUDE.md 게이트는 eslint+vitest 이므로 tsc build 실패해도 통과 대상. 단 dist 배포 시 `--skipLibCheck` 만으로 안 되고 test 파일을 exclude 해야 함 (Step 8 에서 고려)

### Why (embed 결정 근거)
- **Why**: 별도 프로세스는 `state.registeredGroups` 를 DB 재조회/snapshot 으로 복제해야 하고, WS 이벤트 전달도 HTTP/unix socket 한 홉 추가. 리소스 낭비. Hermes/OpenClaw 도 동일 프로세스 패턴.
- **How to apply**: 앞으로 대시보드 관련 "프로세스 분리하면 안 돼?" 질문 오면, embed 가 이미 합의된 방향이고 근거는 위에 있음을 답. 분리 이점 (독립 재시작 등) 은 `runInIsolation` 3단 격리로 대체 확보.

### 2026-04-20 B 트랙 완료 (Groups 편집기 커밋 `e19d69c`)

스코프 재정의된 대로 `/groups` 리스트 + `/groups/:jid` 상세로 장착. Hermes inspector 는 폐기 유지.

**확정 UX (첫 구현에서 변경)**:
- 처음 한 페이지 그리드로 만들었다가 사용자 피드백으로 **리스트 → 상세 2단계** 로 재구성. 이유 = "그 그룹에 더 디테일한 정보가 늘어날 수 있어서". 그리드로 재현 시 이 판단 뒤집지 말 것
- 상세 페이지는 Section 컴포넌트로 분할 (식별 / 모델 / 파일 / 스킬 / 세션) — 향후 필드 추가 자리
- TanStack Query `['groups', 'editor']` 캐시 공유로 리스트↔상세 왕복 추가 fetch 0
- 파괴적 액션 (세션 리셋) 만 `ui/Dialog` 로 감싸짐. 모델 dropdown 은 즉시 commit + invalidate

**시그니처 컬러 (중요)**:
- 봇 역할 팔레트를 SDK 팔레트와 **분리** 필수. 처음에 pat=info/mat=warning 쓰다가 `codex=warning` 과 겹쳐 mat ↔ codex 색 혼동
- 최종 결정:
  - **패트 `#F8D95E`** (황금)
  - **매트 `#E25845`** (주황/빨강)
- `web/src/components/ui/badge.tsx` 에 `pat`/`mat` variant 로 박아둠 — 다른 페이지에서도 `<Badge variant="pat">` 으로 재사용

**botRole 유도 = 폴더 suffix**:
- `folder.endsWith('_mat')` → mat, `_pat` → pat, `isMain=true` → main, 그 외 → solo
- 원래 `matConfig` 로 pat 판정하려 했으나 **`src/db.ts::getRegisteredGroup` / `getAllRegisteredGroups` 가 row destructuring 에서 `mat_config` 컬럼을 빼먹는 pre-existing 버그** 때문에 matConfig 가 런타임에 항상 undefined. 폴더 suffix 가 안전하고 메모리 `feedback_group_naming_convention.md` 네이밍 룰과도 일치
- DB 읽기 버그 자체는 B 트랙 범위 밖으로 미수정. 고치려면 3~5줄 (row 타입에 `mat_config: string | null` 추가 + JSON.parse). 다른 트랙에서 mat 페어링 기능 확장할 때 같이 처리

**리로드 훅 = 이번 트랙의 핵심 인프라**:
- `src/group-state.ts::reloadGroupState()` 신설 → `state.registeredGroups = getAllRegisteredGroups()`
- `src/db.ts::updateGroupModel(jid, model)` 타겟 UPDATE (`setRegisteredGroup` 은 read-upsert 라 mat_config 날림 → 회피)
- 대시보드 PATCH → DB UPDATE → reloadGroupState → 다음 spawn 자연 반영
- 채널/스케줄러/ipc 가 `() => state.registeredGroups` 콜백 구조라 fan-out 자동. 별도 신호 emit 불필요
- **`feedback_registered_groups_restart.md` 에 박제된 "DB 직접 UPDATE 하면 재시작 필수" 함정은 대시보드 경유 편집에 한해 해결됨**. 외부 스크립트로 DB 직접 건드리는 경우는 여전히 함정 유효

**Codex 모델 표시**:
- `~/.codex/config.toml` 의 `model = "gpt-5.4"` 값을 프론트 상수 `CODEX_DEFAULT_MODEL_DISPLAY` 로 하드코딩. "—" 대신 실제 값 노출
- Codex CLI 업그레이드로 기본 모델 바뀌면 이 상수 업데이트 + 프론트 rebuild + `~/.claude/...` 메모리도 갱신
- 더 정확히 하려면 백엔드가 TOML 파싱해서 내려주는 방식 (~30 LOC) — 현재는 실용성 대비 과잉이라 보류

**다음 후보 (B 트랙 후 남은 덩어리)**:
- C 트랙: Live 페이지 확장 (ToolCallBlock, 컨텍스트 토큰 게이지, 현 세션 상세)
- Sessions FTS5 검색 — 여전히 킵 (우선순위 미정)
- Codex per-group 모델 전환 (SDK 지원함, wiring만 필요)
- mat_config DB 읽기 버그 수정 (3~5줄)
- Obsidian 링크 (P5 원래 플랜)
- `scope` 필드 기반 oauth_failure 감지 정밀화

### 2026-04-20 B 트랙 재정의 (Hermes inspector 접근 폐기 → Groups 편집기)

당초 B 트랙은 Hermes 패턴을 베껴 "Groups 런타임 inspector" (DB config vs 컨테이너 런타임 fact diff) 로 잡았으나 NanoClaw 컨테이너 수명 특성 재검토 후 폐기:

**왜 inspector 가치 없는가**:
- NanoClaw 컨테이너는 **메시지마다 spawn→exit** (수 초~수 분). Hermes/OpenClaw 같은 long-lived agent loop 아님
- 마운트/스킬/CLAUDE.md/모델은 모두 **spawn args 또는 spawn-time 파일 read** 로 결정 → DB 설정 변경 후 다음 메시지가 오면 자연 반영
- 따라서 "런타임 drift" 가 구조적으로 발생할 창이 거의 없음. diff UI 는 노이즈
- drift 가 실제 발생하는 유일한 케이스 = **DB 직접 UPDATE 후 인메모리 리로드 미실시** (이미 `feedback_registered_groups_restart.md` 에 박제) — 이건 diff 보여주기보다 **"대시보드에서 DB 수정 → 리로드 트리거"** 로 근본 해결

**재정의된 B 트랙 = Groups 편집기 페이지 단일** (inspector 아님):
- 페이지 신설 (`/groups` 가칭). DB 의 registered_groups + session 조인 뷰
- 보여주는 것: 그룹명/JID/채널/SDK/봇역할, 현재 모델, 활성 스킬, CLAUDE.md 경로, 세션 상태
- 컨트롤: 스킬 toggle · 모델 전환 · 세션 리셋(기존 "세션초기화" 재사용) · 그룹 enable/disable
- **인메모리 리로드 트리거 필수** — DB UPDATE 후 state.registeredGroups 리로드 시그널 (위 함정 회피)
- 파괴적 컨트롤은 커스텀 Dialog 승인 (`feedback_destructive_modal_ux.md`)

**의도적으로 빼는 것** (이 트랙 범위 밖):
- Hermes 식 런타임 inspector / 마운트 실측 / 파일 diff — spawn 모델에 불필요
- 컨텍스트 토큰 게이지 → C 트랙 (Live 페이지 "현 세션 상세" 확장) 으로 이관
- Sessions FTS5 검색 → **킵. 별도 트랙으로 대기** (과거 탐색 테마는 Live 상세화/Obsidian 과 묶이거나 독립 트랙)

**역할 분리 (최종)**:
- Groups 페이지 = **세팅 에디터** (정적 설정, 다음 spawn 에 자연 적용)
- Live 페이지 = **현 세션 상태** (현재 tool 1줄, 후속 확장으로 컨텍스트 게이지/세션 상세)
- 중복 없음

**Why (이 결정)**: Hermes 참조는 유용하지만 NanoClaw 컨테이너 spawn 모델에 맞게 재설계 필수. 참조 = 베끼기 아님. 사용자와의 대화에서 "세션은 라이브로 만족, groups 는 세팅 편집 집중, 컨테이너가 새로뜰 때 적용" 으로 명확화됨

**How to apply**: B 트랙 착수 시 plan 모드로 진입 → Groups 편집기 페이지만 스코프. inspector/diff 얘기 나오면 이 메모리 가리키며 접근 폐기 근거 제시

### 2026-04-20 C 트랙 완료 (Live 페이지 확장, 3 PR)

사용자 논의로 4 덩어리 중 Obsidian 제외 → 3 PR 분할 (①→②→③). 각 독립 머지, 프로덕션 배포 완료.

**완료 커밋**:
- ✅ **PR1 `113ceeb`** — ToolCallBlock 히스토리. `LiveGroupState` 에 `recentTools: RecentToolCall[]` + `sessionId: string | null` 추가. 서버 `LiveJidState` 리듀서 + 클라 `live-store` 미러. `tool.use` 에서 unshift (cap 5), `tool.result` 는 toolUseId 매칭 엔트리에 isError 스탬프. `status.started` 에서 reset, `container.exited` 에선 유지 (다음 세션까지 display). 카드 하단에 `<ToolCallHistory>` (함수명 + inputSummary 80자 truncate + ok/error dot). running 중인 첫 row 는 `animate-pulse`. 9 테스트
- ✅ **PR2 `24bbfd1`** — 토큰 게이지. 새 `session.usage` 이벤트 신설. Claude `claude-adapter.ts:285` `msg.usage: NonNullableUsage` 에서 emit. Codex `codex-adapter.ts` switch 에 `turn.completed` case 신설해서 `event.usage: { input_tokens, cached_input_tokens, output_tokens }` emit. `/compact` 는 `runCompact` 별도 경로라 제외. is_error 턴에도 emit (토큰 이미 소비). `web/src/lib/context-window.ts` 에 `WINDOW_BY_MODEL` (Claude 200k 전역, Codex 400k 기본) + `totalContextTokens = input + cacheRead + cacheCreation`. `<TokenGauge>` 가로 progress 바, 80% warning / 95% destructive animate-pulse. 4 테스트 추가
- ✅ **PR3 `c126ed3`** — 세션 상세 Drawer. 순수 프론트. 카드 래퍼 `<button onClick={() => setSelectedJid(g.jid)}>` + `<SessionDetailDrawer>` 렌더. 우측 `<Sheet side="right" className="max-w-sm">` (기본 `max-w-[320px]` 는 tailwind-merge 로 오버라이드, 모바일 사이드바 Sheet 은 영향 없음). Section 4개: 현재 상태 · 최근 tool (truncate 없음) · 토큰 breakdown (showBreakdown=true → 입력/출력/캐시 read/write/모델) · 세션 식별 (sessionId + JID). 헤더에 `<Link to="/groups/:jid">` "그룹 상세 보기 →" 점프 링크. 매 렌더 `groups.find(jid)` 로 live-store 최신 상태 반영, roster 에서 사라지면 자동 닫힘

**확정된 설계 결정 (박제)**:
- **PR 분할 3개** — A 트랙 3 PR 패턴 반복. 각 독립 머지/롤백 가능
- **recentTools / lastUsage server+client 이중 미러** — snapshot 프레임이 새 WS 접속자 hydrate, reconnect 안전
- **세션 경계 = status.started** — recentTools + lastUsage 둘 다 reset. container.exited 에선 유지 (다음 세션 오기 전까지 "뭘 하다 끝났는지" 보여줌)
- **tool.result 매칭** — toolUseId 매칭 우선, 없으면 최신(idx=0) entry 에 fallback. 매칭 실패해도 silent (no-op 아닌 fallback)
- **inputSummary redaction 없음** — Tailnet 전용 대시보드라 PII 리스크 작음. 카드 80자 truncate, Drawer 는 원문 전체
- **Codex 토큰 게이지 가능** (기존 메모리 오류 수정) — `@openai/codex-sdk` `turn.completed.usage` 공식 API. 과거 "Codex usage 불가" 는 틀렸음. `project_dual_sdk.md` 2026-04-20 업데이트로 이미 반영
- **/compact 제외** — `runQuery` 와 `runCompact` 별도 메서드라 자연 분리. 둘 다 `msg.type==='result'` 히트하지만 emit 은 `runQuery` 에만. 코드 경로 공유 아니므로 미래 리팩터 때 주의
- **Codex model null 허용** — `ContainerInput.model` null 이면 이벤트에 model 필드 안 실음 → `getWindowForModel(undefined, 'codex')` = 400k fallback. 게이지 % 정확, breakdown tooltip 만 모델 이름 미표시. 수용
- **Sheet className override** — `max-w-sm` 를 `className` prop 으로 넘겨 tailwind-merge 로 `max-w-[320px]` 대체. 다른 Sheet 사용처 영향 0. 새 size prop 안 만듦
- **카드 전체 클릭** — `<button>` 로 카드 감싸기. 현재 카드 내부 인터랙티브 요소 없어 stopPropagation 불필요. 향후 카드 안에 버튼 추가 시 주의

**E2E 실측 검증 (launchd 재기동 후 `:3031/api/groups/live`)**:
- 모든 그룹 응답에 `recentTools: []`, `sessionId: null`, `lastUsage: null` 기본값 포함 확인
- Claude/Codex 그룹 트리거 시 카드에 tool 히스토리 누적 + 턴 끝에 게이지 렌더 (배포 후 사용자 실제 트리거로 검증 필요)

**배포 순서 (반복 체크리스트)**:
1. `npm run build` (백엔드 dist — 새 엔드포인트/프레임 스키마 생겼을 때 까먹으면 stale dist 실행)
2. `cd web && npm run build` (번들 해시)
3. `launchctl unload + load ~/Library/LaunchAgents/com.nanoclaw.plist`

**다음 후보 (C 트랙 후 남은 것)**:
- Sessions FTS5 검색 — 우선순위 미정 (메모리 `project_memory_search_consolidation_gaps.md` 참고)
- Obsidian 링크 — C 트랙에서 빠짐. Groups 상세 페이지에 mini-PR 로 붙이는 게 자연스러움
- 컨텍스트 윈도우 상수 실측 보정 — Codex GPT-5.4 가 정말 400k 인지 배포 후 실제 게이지 % 관찰로 확인. 틀리면 `DEFAULT_WINDOW.codex` 조정
- **Codex 토큰 게이지 숫자 이상** (2026-04-20 발견) — 스크린샷에서 `meeting_notes_mat` 가 `12.3M / 400k (100%)` 찍힘. Codex `turn.completed.usage.input_tokens` 가 턴별인지 누적인지 재확인 필요. 윈도우 상수 문제와 별개
- **GroupDetailPage 필드 누락** (2026-04-20 발견, 착수 전 세션 종료) — `GroupEditorView` (backend+frontend) 가 `RegisteredGroup` 일부만 노출. 누락: `containerConfig.additionalMounts` (유저가 꼽은 **마운트 리스트**), `matConfig` (pat→mat 페어링 — matFolder/maxRounds/enabled), 그리고 부가 3건 (timeout/requiresTrigger/added_at). 회귀 아니라 `e19d69c` initial scope 한계. 다음 세션 범위 A(마운트+페어링) 또는 B(+부가3건) 결정 필요. 읽기전용만 노출

### 2026-04-20 잡다 fix 2건 (mat_config + Codex 모델)

**mat_config DB 읽기 fix (커밋 `56ad8d4`)**:
- 실측 결과 메모리 기록 일부 틀림 — `getAllRegisteredGroups` 는 이미 정상, `getRegisteredGroup` 만 row 타입 + 리턴에서 mat_config 누락이었음
- 프로덕션 영향은 잠재적 (현재 `getRegisteredGroup` 호출처가 테스트만). read-modify-write 체인 쓰는 코드 추가될 때 함정 제거 목적
- `updateGroupModel` 독스트링에서 "getRegisteredGroup 이 mat_config 못 본다" 경고 완화. groups-editor-service 의 deriveBotRole 주석에서 pre-existing bug 언급 제거 (folder suffix 컨벤션만 근거로 남김)
- `src/db.test.ts` 에 matConfig round-trip 테스트 2개 추가

**Codex per-group 모델 전환 (커밋 `5438088`)**:
- 설계 세부는 `project_dual_sdk.md` 참고 (2026-04-20 "Codex per-group 모델 전환 완료" 섹션)
- 요약: codex-adapter threadOpts.model 조건부 spread + backend/frontend 양쪽 whitelist `['gpt-5.4', 'gpt-5', 'o3']` + 공통 `<ModelSelect sdk .../>` 컴포넌트 + `PatchError` 에서 `not_claude` 폐기
- E2E smoke 통과: invalid 모델 400 / whitelisted 200 / null 리셋 200. 프로덕션 DB 원상복구 확인
- **이번 세션 교훈**: 메모리 박제한 "버그" 가 실측 시 사라져있을 수 있음. PR 착수 전 항상 Grep/Read 로 현재 상태 재확인. 이번 mat_config 는 절반만 진짜였고 나머지 절반은 이미 고쳐져 있었음

## Related
- reference_dashboards_hermes_openclaw.md — 참고 구현 실측 자료
- reference_obsidian_vault.md — P5 Obsidian integration 경로 근거
- project_memory_search_consolidation_gaps.md — FTS5 는 P3 와 연동 (messages + MEMORY 동시 검색)
- feedback_destructive_caution.md — P2 런타임 inspector 에서 스킬 on/off 는 변경 작업이므로 승인 플로우 필요
- reference_onecli_gateway.md — OneCLI 탭 유지 근거

### 2026-04-20 전사 observability (커밋 `51b7d6d`)

사용자가 "전사 중인지 멈춘 건지 대시보드에서 확인 안 된다" 피드백 → LivePage 관찰 사각지대 제거.

**배경**:
- WhisperX 는 호스트 subprocess (컨테이너 아님) → LiveGroupState / agent-events 체계 밖
- 기존 LogsPage 에는 `"Starting audio transcription"` 한 줄만. 이후 수십 분간 조용 → 사용자에게 "실패 or hang or 진행 중" 구분 안 됨
- 최초 증상: 사용자가 회의록 mp3 (23분) 올림 → 20분+ "멈춘 것 같다" 문의 → 실제로는 pyannote diarization + CPU-only inference + RAM 병목으로 25분 걸려 정상 완료

**구현 (C+B 조합)**:
- `src/transcription-events.ts` — 전용 in-process bus (AgentEventV1 에 태울 수 없음 — groupFolder 없음)
- `src/transcribe.ts` 에 `queued/started/progress/completed/failed` emit + 기존 10s throttle 재활용한 `logger.info` 병행 (LogsPage 도 관찰 가능)
- `src/dashboard/services/transcription-service.ts` — 활성/대기/최근완료(30s retain) 스냅샷 유지, bus 구독, onChange 콜백으로 WS broadcast
- REST `GET /api/transcription/active` + WS frame `{type:'transcription', snapshot}`
- `web/src/components/TranscriptionBanner.tsx` — LivePage 상단에 렌더: mic-pulse active row (stage · MM:SS · 경과), 대기 count, 완료/실패 flash (~30s fade)
- `web/src/lib/transcription-store.ts` — useSyncExternalStore + 독립 WsClient (signals-store 패턴 미러)
- AppShell 에서 mount/unmount 라이프사이클

**확정된 설계 결정 (박제)**:
- 전용 bus 분리 (agent-events 안 탐) — 전사는 group 소속 없으므로
- 서버/클라 미러 + REST hydrate → WS update 패턴 (signals-store 복사)
- terminal retain 30s — "완료" flash 보이고 사라지도록. 영구 히스토리는 별 페이지로 후속 (현재 범위 밖)
- logger.info + event emit 이중 — LogsPage 는 기존 로그 관찰자용, banner 는 실시간 구조화 view 용
- 테스트: `src/dashboard/__tests__/transcription-service.test.ts` 6건 (state machine / pruning / race / onChange)

**알게 된 것 (전사 성능 병목)**:
- M4 Pro 48GB 에서 pyannote + whisperx CPU 전환, 23분 오디오 = 25분 처리 (1.1× 실시간)
- RSS 7~8GB, 시스템 전체 RAM 33G used / 14G unused → swap 발생 → CPU 12% 로 보이지만 실은 I/O wait
- `transcribe.ts:32-34` 주석 "12분 오디오 = 35분 처리" 와 일치
- 후속 가능 최적화: MPS 백엔드 / pyannote max_speakers / int8 compute_type. 이번 PR 범위 밖

**배포**: launchd unload+load → PID 96729 @ :3031, `/api/transcription/active` 신규 엔드포인트 빈 snapshot 반환 확인

### 2026-04-20 LivePage 가독성 (커밋 `8d3dca4` + `9cfeb9d`)

**배경**: 13그룹 중 12 idle → running 1개가 묻힘. 사용자 피드백 "IDLE 이랑 돌아가는거 섹션 나눠야하나"

**확정된 결정 (박제)**:
- **탭 방향** 선택 — "섹션 헤더 분리" 대신 **상단 필터 탭** (`[전체 13] [실행중 1] [대기 12] [에러 0]`). 기존 `X개 그룹 · Y개 동작중` 상태줄 대체. 탭 자체가 카운트 요약 역할. `StatusFilterTabs` + `countByStatus` + `FilteredEmptyState` 로 LivePage 내 로컬 컴포넌트 (shadcn tabs 미설치 — 단일 사용처라 인라인 유지)
- **카드 크기 2차 수정** — 1차 커밋 `8d3dca4` 에서 `h-52 overflow-hidden` 로 전부 통일했는데 idle 카드 대부분이 ~70px 콘텐츠 + ~140px 빈공간 → 모바일 스크롤 지옥. 2차 커밋 `9cfeb9d` 에서 status 별 분기:
  - idle = `h-14` 단일 row (dot + 이름 + SDK 배지, folder/`idle` 문구 제거, opacity-70)
  - running/error = `h-52` 유지 (tool history + gauge 보여야 의미 있음)
- **grid row 정렬 자연스러움** — 단일 `grid` 안에서 카드 height 가 달라도 row 내부에서만 align 이라 모바일 1열 스크롤 정돈됨. `xl:grid-cols-3` 에서도 running 끼리 / idle 끼리 자연스럽게 섞임. CSS `order` 로 running 자동 상단 정렬은 **안 적용** (탭 필터가 그 역할 대신)
- **에러 탭 유지** — `containerStatus='error'` 는 `status.ended outcome=error` 경로에서 실재 (live-state.ts:82). 0 일 때도 탭 표시 (상태 파악 목적)
- **필터 URL 미동기화** — React state 만. 리프레시 시 '전체' 로 리셋. URL search param 까지 가는 가치 없다고 판단

**이번 세션 교훈 (2차 커밋 발생 이유)**:
- 1차 "전부 같은 높이 고정" 제안은 머리 속 모델만 따지면 맞았는데 실제 idle:running 콘텐츠 분량 차이 (70px vs 260px) 를 과소평가. **스크린샷 보기 전엔 카드 내부 콘텐츠 무게 감 잡기 어려움** → UI 수정은 실제 프로덕션 데이터로 직접 확인 후 판단하는 2-pass 가 안전. 이번엔 사용자가 스크린샷 주셔서 빠르게 교정됨
- "C+B 하이브리드" (idle compact + running detailed) 가 처음 제안이었는데 사용자가 "필터 탭으로 가자" 해서 C 만 먼저. 1차 결과 보고 나서 B 를 살려서 최종 = 탭 + compact idle 조합

### 2026-04-21 3-PR (Codex 토큰 버그 + GroupDetail 필드 + 윈도우 상수)

C 트랙 종료 후 남은 3건을 독립 PR 3개로 분할 머지. 플랜: `~/.claude/plans/cosmic-juggling-ocean.md`

**완료 커밋** (로컬 main 에 순차 커밋 → push, 리뷰봇 PR 없음):
- ✅ **PR1 `3240fc0`** fix(codex): emit per-turn usage delta instead of cumulative thread totals
- ✅ **PR2 `c0f085c`** feat(groups): surface mounts, mat pairing, and metadata on detail page
- ✅ **PR3 `04354b4`** fix(web): correct Codex context window constants to match GPT-5.4 / o3 specs

**PR1 — Codex 누적값 버그 (2 bug stack)**:
1. `turn.completed.usage` 가 JSONL 스트림에서 **스레드 누적값** — openai/codex#17539. 인터랙티브 CLI 의 `ThreadTokenUsage.last` (턴별) 는 `codex exec --experimental-json` 직렬화 시 누락. 증상 = `meeting_notes_mat` 카드 `12.3M / 400k (100%)`
2. `web/src/lib/context-window.ts::totalContextTokens` 가 `input + cacheRead + cacheCreation` 합산 (Anthropic disjoint-subsets 전제). Codex 의 `cached_input_tokens` 는 `input_tokens` 의 **breakdown** (subset) 이라 더하면 2× — promptfoo/promptfoo#7546 동일 버그

**Fix 설계**:
- `container/agent-runner/src/codex-usage.ts` 신규 — 순수 `codexUsageDelta(cumulative, prev)` 헬퍼. 테스트 용이성 + adapter 얇게
- adapter 에 `private lastUsage` baseline 보유. `thread.started` + `resumeThread` fallback 에서 `null` 리셋. `Math.max(0, …)` 로 counter regression 방어
- adapter 가 **Codex 에서만 `cacheReadTokens` 방출 안 함** — `inputTokens` 가 이미 cache-inclusive 이므로 web 합산 정합성 유지. Claude 는 그대로
- doc cross-ref: `claude-adapter.ts`, `agent-events.ts::SessionUsageEvent`, `context-window.ts::totalContextTokens` — 비대칭 이유 명시

**PR2 — GroupDetailPage Scope B**:
- `GroupEditorView` 5필드 확장: `additionalMounts`, `matConfig`, `addedAt`, `requiresTrigger`, `containerTimeout`. DB 는 이미 surface (56ad8d4), view 레이어만 좁았음
- `web/src/contracts.ts` 에 `AdditionalMount`/`MatConfig` shape mirror (repo 관례는 duplication)
- 3 Section 추가: 마운트(ro/rw 배지) · 페어링(matConfig 있을 때만) · 메타(addedAt/requiresTrigger/timeout). 기존 `<Section>`/`<KV>`/`<Badge>` 재사용 + `MountRow`/`formatAddedAt` 로컬 헬퍼

**PR3 — 윈도우 상수 교정**:
- 400k 는 생뚱맞은 임의값. `DEFAULT_WINDOW.codex` 272k (GPT-5.4 standard) + `WINDOW_BY_MODEL`: gpt-5.4=272k / gpt-5=512k / o3=200k
- Extended 1M window (`~/.codex/config.toml::model_context_window` opt-in) 은 **auto-detect 안 함** — 해당 봇만 수동 오버라이드 필요. 상단 주석 명시

**확정된 설계 결정 (박제)**:
- **Option A (adapter 가 normalization)** 선택 — 대안 Option B (web 이 SDK-aware) 는 web 로직 복잡도 ↑. 현재 코드는 Codex 만 cache 필드 안 방출하면 두 SDK 전부 올바르게 합산됨
- **Resume edge 미처리**: 재개 스레드는 CLI 내부 누적값 > 0 상태에서 attach. 첫 delta = 재개-시점 cumulative (한 턴 과다). 자동 보정되므로 주석만, 추가 로직 안 넣음
- **`/compact` 경로 영향 없음** — `runQuery` 만 emit, `runCompact` 는 별도 메서드
- **TokenGauge showBreakdown** 에서 Codex 는 cache 라인 안 뜸 (의도). 정보 손실 수용
- **Scope B > Scope A** — added_at/requiresTrigger/timeout 3필드는 공수 거의 0 (같은 view 매핑 확장). 추가 Section 1개
- **상수 refactor 안 함** — context-window.ts 를 `src/dashboard/` 로 옮기고 vitest 거는 대안 있었으나 ROI 낮아서 web-local 유지 + 수동 검증만

**배포**:
1. `npm run build && cd web && npm run build && launchctl unload+load`
2. PID 40786 @ `:3031`, 스모크 `/api/health` ok, `/api/groups/live`·`/api/groups/editor` 신 필드 전부 내려옴

**실측 미완**:
- PR1 효과 = 다음 Codex 턴부터 확인 가능 (launchd 재기동으로 adapter 교체 완료)
- PR3 정확도 = 24~72h 관찰. 지속 100% 오버슈트 면 `gpt-5.4` 를 1M 로 올리기

**주의사항 (배포 중 발견)**:
- `/api/groups/editor` 응답상 **모든 pat 그룹의 `matConfig` 가 null**. labs/agent-news 등 pat-mat 페어 채널은 실제 작동 중인데 DB `mat_config` 컬럼이 비어있을 가능성. PR2 구현 문제 아님 (DB surface 는 56ad8d4 로 이미 정상). 실운영 영향은 낮음 (pat→mat 자동 cycle 코드가 다른 경로 쓰는지 확인 필요) — 별건 조사 대상

### 이번 세션 교훈 (2026-04-21)
- **PR 3개 동시 개발 → 로컬 순차 커밋 → 한 번에 push** 패턴: context-window.ts 처럼 한 파일에 PR1+PR3 변경 겹쳐있으면 일시적으로 한쪽 revert → 커밋 → 재적용 → 커밋 방식 가능. `git add -p` 인터랙티브라 이 루트가 깔끔
- **계획상 "버그 의심" 이 두 버그 합성으로 드러남** — PR1 조사 중 cumulative 뿐 아니라 double-count 까지 발견. 플랜 단계에서 Plan agent 시키면 web 쪽 promptfoo issue 같은 간접 증거까지 모아옴
- **배포 후 E2E 는 curl 로 즉시 확인 가능** — `/api/groups/editor` 가 새 필드 내려보내는지, `/api/groups/live::lastUsage` 구조 깨지진 않았는지. 브라우저 방문 전에 1분 스모크 추천

### 2026-04-21 matConfig 전면 삭제 (커밋 `fb4883a`)

**배경**: PR2 배포 후 `/api/groups/editor` 응답 관찰 중 "모든 pat 의 matConfig 가 null" 발견. Explore agent 로 전 레포 참조 감사 → **실행 로직은 커밋 `06d5796` (2026-04-02) 에서 이미 삭제됨**. `src/review-cycle.ts` 195줄 전체가 사라졌고, 그 이후 3주간 타입/DB/UI surface 만 유령처럼 남아 있었음. 사용자 결정 "깔끔하게 지우자" 로 전면 정리 착수

**원인 역사**:
- `e32eaf2` (2026-04-02 아침) — `src/review-cycle.ts` 신설, `runReviewCycle()` + VERDICT 파싱 + dev↔review 순환
- `06d5796` (2026-04-02 같은 날) — **`review-cycle.ts` 전체 213줄 삭제**. "Replace auto-review with bot-to-bot free conversation" 로 전환. host-level orchestration 폐기
- `fe0493d` (2026-04-15) — Andy→pat / review→mat 리네임. 이미 빈 껍데기에 이름만 덮음
- 현 프로덕션의 pat+mat 운영은 **2개 별도 Slack 채널 + 각자 봇 등록** 방식 — `matConfig` 는 전혀 필요 없었음

**확정된 설계 결정**:
- **review_config 도 같이 DROP** — migration #11 주석에 "drop deferred to future migration" 의도 명시되어 있었음. 계기 생긴 김에 정리
- **CREATE TABLE 에서 두 컬럼 제거** + **Migration #13 try/catch DROP** — fresh install 은 CREATE TABLE 에 없으니 #5/#11 ADD 후 #13 이 DROP, 기존 install 은 현재 상태에서 #13 이 DROP. 둘 다 같은 경로, try/catch 로 idempotent
- **migrations[0]~[11] 은 절대 건드리지 않음** — user_version index 와 배열 index 일관성 유지 필수. ADD→DROP 패턴이 비효율로 보여도 역사성 유지가 우선
- **SQLite 3.49.x** (better-sqlite3 번들) — DROP COLUMN 3.35+ 필요, 통과
- **단일 커밋** — 파일 10개 98줄 삭제 (141 제거 / 43 추가). 독립 PR 으로 쪼갤 이유 없음 (모두 같은 주제)

**놓치기 쉬웠던 것**:
- `src/group-queue.ts::hasPendingMessages()` — Explore agent 초기 보고에서 "lab-dashboard.ts:58 에서 사용 중이라 함수 자체는 살려야 함" 라고 했으나 실제 검증 시 lab-dashboard 는 `pendingMessages` 필드 직접 참조할 뿐 `hasPendingMessages()` 메서드는 0 call sites. dead method 라 제거 (필드는 보존)
- `src/db.test.ts` 의 `getRegisteredGroup` import — matConfig round-trip describe 블록만 사용하던 것이라 블록 제거 후 unused import 에러 발생 → ESLint 가 잡아줌 (safety net 역할)
- `src/db-migration.test.ts:205,398` — migration #11 테스트가 `mat_config` / `review_config` 컬럼 존재 + 값 전제로 동작. #13 이후엔 존재 안 함. `not.toContain` 으로 뒤집고 SELECT 축소

**검증 (배포 전)**:
- **DB dry-run**: 백업 복사본 `/tmp/dry-run-messages.db` 에 DROP 두 번 실행 → 컬럼 10개 정리 확인, crash 없음
- **DB 수동 백업**: `store/backups/messages-pre-matconfig-drop.db` (1.9M, 롤백용)
- Pre-commit 게이트: format:fix / eslint 0 errors / vitest 551 passed
- Web 타입체크: clean

**배포 결과**:
- launchd reload: PID 78315 @ :3031
- `user_version: 12 → 13` 정상 migration
- `PRAGMA table_info(registered_groups)` → 10 컬럼 (jid/name/folder/trigger_pattern/added_at/container_config/requires_trigger/is_main/sdk/model)
- `/api/groups/editor` 응답에 `matConfig` 키 부재 확인

**이번 세션 추가 교훈**:
- **"아무도 안 쓰는데 왜 있는거야" 질문이 강력한 탐지 프롬프트** — 이 한 문장이 3주간 방치된 dead surface 전면 감사를 유발. PR 개발 중 수상한 패턴 발견하면 "현재 사용처 있나?" 를 먼저 묻는 습관 들일 것
- **Explore agent 의 "함수 사용 중" 주장 검증 필요** — `hasPendingMessages()` 처럼 agent 가 문자열 매치만으로 "사용됨" 결론 내릴 때 있음. `grep -rn <name>(` 으로 직접 확인이 안전
- **Migration drop-column 전 dry-run 은 필수** — 실 DB 백업 → /tmp 에 복사 → DROP 두 번 → 컬럼 확인. better-sqlite3 DROP COLUMN 지원 여부 + 실 데이터에 제약 조건 (FK, 인덱스) 걸림 없는지 한 번에 확인. 이번엔 둘 다 clean 이었지만 sanity check 비용 무시 가능
- **migration idempotency 는 try/catch** — CREATE TABLE 에서 컬럼 뺏으면 fresh install 에선 DROP 할 컬럼 없음 → SQLite 에러. `try { DROP } catch { /* never existed */ }` 패턴이 migrations 전체에서 이미 관례
