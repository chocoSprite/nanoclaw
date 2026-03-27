# NanoClaw Architecture Document

## 1. 프로젝트 개요

NanoClaw는 AI 에이전트(Codex)를 컨테이너에서 격리 실행하는 개인용 AI 어시스턴트 시스템이다. 단일 Node.js 프로세스로 동작하며, 메시징 채널(WhatsApp, Telegram, Discord, Slack, Gmail)을 통해 사용자와 소통한다.

**핵심 철학:**
- 코드베이스가 충분히 작아서 전체를 이해할 수 있을 것
- OS 수준의 컨테이너 격리 (애플리케이션 레벨 권한 체크가 아닌)
- 설정 파일 대신 코드 변경으로 커스터마이즈
- 스킬(Skill) 기반 확장 — 기능 추가가 아닌 코드 변환

**기술 스택:**
- Runtime: Node.js 22+ (ESM)
- Language: TypeScript (strict)
- Database: SQLite (better-sqlite3)
- Container: Docker / Apple Container
- Agent SDK: `@openai/codex-sdk`
- Credential Proxy: OneCLI Agent Vault
- Logging: Pino
- Validation: Zod

---

## 2. 시스템 아키텍처

### 2.1 고수준 데이터 흐름

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Channels    │────>│   SQLite     │────>│  Poll Loop   │────>│  Container       │
│  (WhatsApp,  │     │  (messages,  │     │  (2초 간격)   │     │  (Codex Agent)   │
│  Telegram,   │     │  groups,     │     │              │     │                  │
│  Discord...) │     │  tasks)      │     │              │     │  ┌────────────┐  │
│              │<────│              │<────│              │<────│  │ Agent SDK  │  │
└─────────────┘     └─────────────┘     └──────────────┘     │  │ + MCP      │  │
                                                              │  │ + Browser  │  │
                                                              │  └────────────┘  │
                                                              └──────────────────┘
```

### 2.2 프로세스 구조

```
Host (단일 Node.js 프로세스)
├── Channel Connectors (WhatsApp/Telegram/Discord/Slack/Gmail)
├── Message Polling Loop (2초 간격)
├── GroupQueue (동시 컨테이너 관리, 최대 5개)
├── IPC Watcher (1초 간격, 파일시스템 기반)
├── Task Scheduler (60초 간격)
├── Remote Control (비활성 — Codex에 동등 기능 없음)
└── OneCLI SDK (credential proxy 연동)

Container (Docker/Apple Container, 각 호출마다 생성)
├── agent-runner (index.ts) — Codex SDK 실행
├── ipc-mcp-stdio (MCP Server) — 태스크/메시지 IPC
├── agent-browser (Chromium) — 웹 자동화
└── container skills (.codex/skills/)
```

---

## 3. 소스 파일 구조 및 역할

### 3.1 Host 측 (src/)

| 파일 | 줄 수 | 역할 |
|------|------|------|
| `index.ts` | ~720 | **오케스트레이터**. main() 진입점, 채널 연결, 메시지 루프, 에이전트 실행, 상태 관리 |
| `config.ts` | ~94 | 환경변수/설정값. 트리거 패턴, 경로, 타임아웃, 타임존 |
| `db.ts` | ~720 | **SQLite 데이터 레이어**. 스키마, CRUD, 마이그레이션 (JSON→SQLite) |
| `container-runner.ts` | ~737 | **컨테이너 실행기**. 볼륨 마운트 구성, 프로세스 생성, 스트리밍 출력 파싱 |
| `container-runtime.ts` | ~100 | 컨테이너 런타임 추상화. Docker CLI 래핑, 고아 컨테이너 정리 |
| `group-queue.ts` | ~365 | **동시성 관리**. 그룹별 큐, 최대 컨테이너 제한, 재시도, drain 로직 |
| `router.ts` | ~53 | 메시지 포맷팅 (XML), 아웃바운드 라우팅, 채널 찾기 |
| `ipc.ts` | ~465 | **IPC 감시자**. 파일시스템 폴링으로 컨테이너↔호스트 통신 (태스크, 메시지, 그룹 등록) |
| `task-scheduler.ts` | ~285 | **스케줄러**. cron/interval/once 태스크 실행, 다음 실행 시간 계산 |
| `channels/registry.ts` | ~29 | 채널 팩토리 레지스트리 (자동 등록 패턴) |
| `channels/index.ts` | ~12 | 배럴 파일 — 설치된 채널을 import하면 자동 등록 |
| `types.ts` | ~109 | 타입 정의. RegisteredGroup, NewMessage, ScheduledTask, Channel 인터페이스 |
| `mount-security.ts` | ~419 | **마운트 보안**. 외부 allowlist 기반 추가 마운트 검증 |
| `sender-allowlist.ts` | ~129 | 발신자 허용 목록. 그룹별 trigger/drop 모드 |
| `remote-control.ts` | ~225 | 원격 제어 (no-op — Codex에 동등 기능 없음) |
| `group-folder.ts` | ~45 | 그룹 폴더 경로 검증 (경로 탈출 방지) |
| `env.ts` | ~43 | .env 파서 (process.env 오염 방지) |
| `logger.ts` | ~17 | Pino 로거 + uncaught exception 핸들링 |
| `timezone.ts` | - | IANA 타임존 검증 및 로컬 시간 포맷팅 |

### 3.2 Container 측 (container/)

| 파일 | 역할 |
|------|------|
| `Dockerfile` | node:22-slim 기반, Chromium + agent-browser + codex CLI 설치 |
| `build.sh` | 컨테이너 이미지 빌드 스크립트 |
| `agent-runner/src/index.ts` | **컨테이너 진입점**. stdin으로 입력 수신, Codex SDK 실행, IPC 메시지 폴링, 스트리밍 출력 |
| `agent-runner/src/ipc-mcp-stdio.ts` | **MCP 서버** (7개 도구). send_message, schedule_task, list_tasks, pause/resume/cancel_task, register_group |
| `skills/agent-browser/` | 브라우저 자동화 스킬 |
| `skills/capabilities/` | 에이전트 기능 설명 스킬 |
| `skills/slack-formatting/` | Slack 포맷팅 스킬 |
| `skills/status/` | 상태 확인 스킬 |

### 3.3 데이터 디렉토리

```
nanoclaw/
├── store/messages.db          # SQLite 데이터베이스
├── data/
│   ├── ipc/{group}/           # 그룹별 IPC 네임스페이스
│   │   ├── messages/          # 컨테이너→호스트 메시지
│   │   ├── tasks/             # 컨테이너→호스트 태스크 명령
│   │   ├── input/             # 호스트→컨테이너 후속 메시지
│   │   ├── current_tasks.json # 태스크 스냅샷 (읽기 전용)
│   │   └── available_groups.json
│   ├── sessions/{group}/      # 그룹별 Codex 세션
│   │   ├── .codex/            # Codex 설정 + 스킬
│   │   └── agent-runner-src/  # 그룹별 agent-runner 복사본
│   └── remote-control.json    # 원격 제어 상태
├── groups/
│   ├── global/AGENTS.md       # 전역 메모리 (모든 그룹에 읽기 전용, CLAUDE.md fallback)
│   ├── main/AGENTS.md         # 메인 그룹 메모리
│   └── {group-name}/
│       ├── AGENTS.md          # 그룹별 메모리
│       ├── logs/              # 컨테이너 실행 로그
│       └── conversations/     # 아카이브된 대화
└── ~/.config/nanoclaw/
    ├── mount-allowlist.json   # 마운트 보안 (프로젝트 외부)
    └── sender-allowlist.json  # 발신자 허용 목록 (프로젝트 외부)
```

---

## 4. 핵심 메커니즘 상세

### 4.1 메시지 처리 파이프라인

```
1. Channel receives message
   └─> onMessage callback
       └─> Sender allowlist check (drop mode)
       └─> storeMessage() → SQLite

2. Poll loop (매 2초)
   └─> getNewMessages() — lastTimestamp 이후 메시지 조회
   └─> 그룹별 분류
   └─> 트리거 패턴 체크 (@Andy)
   └─> 활성 컨테이너 있으면 → queue.sendMessage() (IPC 파일로 전달)
   └─> 없으면 → queue.enqueueMessageCheck()

3. GroupQueue
   └─> 동시 컨테이너 제한 (MAX_CONCURRENT_CONTAINERS = 5)
   └─> processGroupMessages() 호출
       └─> getMessagesSince(lastAgentTimestamp) — 누적된 컨텍스트 포함
       └─> formatMessages() — XML 형식으로 변환
       └─> runAgent() → runContainerAgent()

4. Container 실행
   └─> stdin에 JSON 입력 전달
   └─> stdout에서 OUTPUT_MARKER 쌍 파싱 (스트리밍)
   └─> 결과를 채널로 전송
   └─> 세션 ID 업데이트
```

### 4.2 컨테이너 격리 모델

각 에이전트 호출은 새 컨테이너를 생성한다:

**Main 그룹 마운트:**
```
/workspace/project (ro)  ← 프로젝트 루트 (읽기 전용)
/workspace/project/.env  ← /dev/null로 섀도잉 (시크릿 차단)
/workspace/group         ← groups/main/ (읽기/쓰기)
/home/node/.codex       ← 그룹별 세션 디렉토리
/workspace/ipc           ← 그룹별 IPC 네임스페이스
/app/src                 ← agent-runner 소스 (커스터마이즈 가능)
```

**일반 그룹 마운트:**
```
/workspace/group         ← groups/{name}/ (읽기/쓰기)
/workspace/global (ro)   ← groups/global/ (전역 메모리, 읽기 전용)
/home/node/.codex       ← 그룹별 세션 디렉토리
/workspace/ipc           ← 그룹별 IPC 네임스페이스
/app/src                 ← agent-runner 소스
/workspace/extra/*       ← 추가 마운트 (allowlist 검증 필수)
```

**보안 계층:**
- 컨테이너는 마운트된 경로만 접근 가능
- .env 파일은 /dev/null로 섀도잉
- OneCLI 게이트웨이가 HTTPS 트래픽 가로채 크레덴셜 주입
- 마운트 allowlist는 프로젝트 외부(`~/.config/nanoclaw/`)에 저장 → 에이전트가 변조 불가
- 그룹별 IPC 네임스페이스 → 크로스그룹 권한 상승 방지
- non-root 사용자(node)로 실행

### 4.3 IPC (Inter-Process Communication)

호스트↔컨테이너 간 통신은 **파일시스템 기반**:

```
호스트 → 컨테이너:
  /workspace/ipc/input/*.json  (후속 메시지)
  /workspace/ipc/input/_close  (종료 신호)

컨테이너 → 호스트:
  /workspace/ipc/messages/*.json  (메시지 전송 요청)
  /workspace/ipc/tasks/*.json     (태스크 CRUD 명령)
```

**IPC Watcher** (호스트, 1초 폴링):
- 각 그룹의 IPC 디렉토리를 스캔
- 메시지 요청 → 권한 확인 후 채널로 전송
- 태스크 명령 → DB 업데이트 (생성/수정/삭제/일시정지/재개)
- 그룹 등록 → main 그룹만 허용

**MCP 서버** (컨테이너 내부):
- `send_message` — 즉시 메시지 전송
- `schedule_task` — 반복/일회 태스크 예약
- `list_tasks` — 현재 태스크 목록 조회
- `pause_task` / `resume_task` / `cancel_task` — 태스크 관리
- `register_group` — 새 그룹 등록 (main만)
- `update_task` — 기존 태스크 수정

### 4.4 세션 관리

- 각 그룹은 독립적인 Codex SDK 세션을 유지
- 세션 ID는 SQLite에 저장
- 컨테이너가 새 세션을 시작하면 `newSessionId`가 호스트로 전달
- 세션 컴팩션 시 PreCompact 훅이 대화를 `conversations/` 디렉토리에 아카이브
- Codex가 `.agents/skills/` 및 AGENTS.md를 자동 발견하여 instructions로 로드

### 4.5 스케줄링 시스템

```
Scheduler Loop (60초 간격)
├── getDueTasks() — next_run <= now인 태스크 조회
├── queue.enqueueTask() — GroupQueue에 등록
└── runTask()
    ├── runContainerAgent() — 전체 에이전트 실행
    ├── 스트리밍 결과 → 채널로 전송
    ├── logTaskRun() — 실행 기록
    └── computeNextRun() — 다음 실행 시간 계산
        ├── cron: CronExpressionParser로 다음 시간
        ├── interval: 스케줄 시간 기준 드리프트 방지
        └── once: null (완료)
```

**Script 지원:** 태스크에 bash 스크립트를 첨부하면 에이전트 실행 전에 먼저 실행. `{ "wakeAgent": false }` 반환 시 에이전트 호출 생략 (조건부 실행).

### 4.6 채널 시스템

**자동 등록 패턴:**
```typescript
// 각 채널 모듈이 import 시 자동 등록
registerChannel('whatsapp', (opts) => { ... });

// channels/index.ts (배럴)에서 import
// 스킬이 채널을 추가하면 이 파일에 import 추가

// index.ts에서 모든 등록된 채널 순회하며 연결
for (const channelName of getRegisteredChannelNames()) {
  const channel = factory(channelOpts);
  if (!channel) continue; // 크레덴셜 없으면 스킵
  await channel.connect();
}
```

**Channel 인터페이스:**
```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;    // JID가 이 채널에 속하는지
  disconnect(): Promise<void>;
  setTyping?(jid, isTyping): Promise<void>;  // 선택적
  syncGroups?(force): Promise<void>;          // 선택적
}
```

### 4.7 GroupQueue 동시성 관리

```
GroupQueue
├── activeCount: 현재 실행 중인 컨테이너 수
├── MAX_CONCURRENT_CONTAINERS: 5 (환경변수로 조정 가능)
├── waitingGroups[]: 슬롯 대기 중인 그룹
│
├── enqueueMessageCheck(groupJid)
│   ├── 활성 컨테이너 있음 → pendingMessages = true
│   ├── 슬롯 초과 → waitingGroups에 추가
│   └── 여유 있음 → runForGroup() 즉시 실행
│
├── enqueueTask(groupJid, taskId, fn)
│   └── 태스크는 메시지보다 우선순위 높음
│
├── sendMessage(groupJid, text)
│   └── 활성 컨테이너에 IPC 파일로 후속 메시지 전달
│
├── closeStdin(groupJid) → _close 센티넬 작성
├── notifyIdle(groupJid) → 대기 중 태스크 있으면 즉시 종료
│
└── drainGroup(groupJid) — 컨테이너 종료 후
    ├── 대기 태스크 → runTask()
    ├── 대기 메시지 → runForGroup()
    └── 없으면 → drainWaiting() (다른 그룹 슬롯 해제)

재시도: 지수 백오프 (5s, 10s, 20s, 40s, 80s), 최대 5회
```

---

## 5. 보안 모델

### 5.1 격리 계층

| 계층 | 메커니즘 |
|------|----------|
| 프로세스 | 에이전트는 Docker/Apple Container 안에서 실행 |
| 파일시스템 | 마운트된 경로만 접근 가능, .env 섀도잉 |
| 크레덴셜 | OneCLI 게이트웨이가 요청 시점에 주입, 컨테이너는 raw key 미보유 |
| 마운트 보안 | 외부 allowlist(`~/.config/nanoclaw/`)로 검증, 차단 패턴(.ssh, .aws 등) |
| IPC 권한 | 그룹별 네임스페이스, main만 크로스그룹 통신 가능 |
| 발신자 제어 | sender-allowlist로 트리거 가능 사용자 제한 |
| 그룹 폴더 | 정규식 검증 + 경로 탈출 방지 |

### 5.2 Main 그룹 특권

- 전역 메모리(`groups/global/AGENTS.md`) 쓰기
- 모든 그룹의 태스크 조회/관리
- 새 그룹 등록
- 다른 그룹용 태스크 예약
- 프로젝트 루트 읽기 전용 접근
- 원격 제어 세션 시작/종료

---

## 6. 데이터 모델 (SQLite)

### 6.1 테이블 구조

```sql
-- 채팅방 메타데이터
chats (jid PK, name, last_message_time, channel, is_group)

-- 메시지 (등록된 그룹만)
messages (id+chat_jid PK, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message)

-- 예약 태스크
scheduled_tasks (id PK, group_folder, chat_jid, prompt, script,
                 schedule_type, schedule_value, context_mode,
                 next_run, last_run, last_result, status, created_at)

-- 태스크 실행 기록
task_run_logs (id PK, task_id FK, run_at, duration_ms, status,
               result, error)

-- 라우터 상태 (last_timestamp, last_agent_timestamp)
router_state (key PK, value)

-- Codex 스레드 ID
sessions (group_folder PK, session_id)

-- 등록된 그룹
registered_groups (jid PK, name, folder UNIQUE, trigger_pattern,
                   added_at, container_config, requires_trigger, is_main)
```

### 6.2 커서 기반 메시지 추적

- `lastTimestamp`: 전역 — 마지막으로 "확인한" 메시지 타임스탬프
- `lastAgentTimestamp[chatJid]`: 그룹별 — 마지막으로 에이전트에 전달한 메시지 타임스탬프
- 에러 시 `lastAgentTimestamp` 롤백하여 재처리 가능 (단, 이미 사용자에게 전송된 경우 중복 방지를 위해 롤백 안함)

---

## 7. 의존성 분석

### 7.1 Host 의존성 (6개)
```
@onecli-sh/sdk   — OneCLI 크레덴셜 프록시 SDK
better-sqlite3   — SQLite 동기 바인딩
cron-parser      — cron 표현식 파싱
pino + pino-pretty — 구조화된 로깅
yaml             — YAML 파싱 (설정용)
zod              — 런타임 타입 검증
```

### 7.2 Container 의존성 (4개)
```
@openai/codex-sdk             — OpenAI Codex Agent SDK
@modelcontextprotocol/sdk      — MCP 서버 프레임워크
cron-parser                    — cron 검증
zod                            — MCP 도구 스키마
```

### 7.3 Container 이미지 포함
```
node:22-slim + chromium       — 런타임 + 브라우저
agent-browser                 — 브라우저 자동화 CLI
@openai/codex                 — Codex CLI (Rust binary)
```

---

## 8. 확장 포인트

### 8.1 채널 추가
1. `src/channels/` 에 새 채널 모듈 생성
2. `registerChannel()` 호출로 팩토리 등록
3. `channels/index.ts`에 import 추가
4. Channel 인터페이스 구현 (connect, sendMessage, ownsJid 등)

### 8.2 컨테이너 스킬 추가
1. `container/skills/{name}/SKILL.md` 생성
2. 빌드 시 각 그룹의 `.codex/skills/`로 복사됨
3. 에이전트가 자동으로 스킬 발견 및 실행

### 8.3 MCP 도구 추가
1. `container/agent-runner/src/ipc-mcp-stdio.ts`에 `server.tool()` 추가
2. 호스트 측 `ipc.ts`의 `processTaskIpc()`에 핸들러 추가

### 8.4 추가 마운트
1. `~/.config/nanoclaw/mount-allowlist.json`에 허용 경로 추가
2. 그룹의 `containerConfig.additionalMounts`에 마운트 설정
3. 컨테이너 내 `/workspace/extra/`에 마운트됨

---

## 9. 런타임 흐름 요약

### 9.1 시작 시퀀스
```
main()
├── ensureContainerSystemRunning()  — Docker 확인, 고아 컨테이너 정리
├── initDatabase()                  — SQLite 초기화 + 스키마 + 마이그레이션
├── loadState()                     — 커서, 세션, 등록 그룹 로드
├── ensureOneCLIAgent()             — 모든 그룹의 OneCLI 에이전트 확인
├── restoreRemoteControl()          — 이전 원격 제어 세션 복구
├── 채널 연결                        — 등록된 모든 채널 순회, 크레덴셜 있는 것만 연결
├── startSchedulerLoop()            — 60초 폴링 시작
├── startIpcWatcher()               — 1초 폴링 시작
├── queue.setProcessMessagesFn()    — 메시지 처리 함수 등록
├── recoverPendingMessages()        — 크래시 복구
└── startMessageLoop()              — 2초 폴링 시작 (메인 루프)
```

### 9.2 종료 시퀀스
```
SIGTERM/SIGINT
├── queue.shutdown()    — shuttingDown 플래그, 컨테이너는 자연 종료까지 대기
└── 각 채널 disconnect()
```

---

## 10. 설계 특성 및 트레이드오프

| 설계 결정 | 장점 | 트레이드오프 |
|-----------|------|-------------|
| 단일 프로세스 | 단순, 이해 용이 | 수직 확장 한계 |
| 파일시스템 IPC | 간단, 디버깅 쉬움 | 폴링 지연 (500ms~1s) |
| 컨테이너/호출 생성 | 완전 격리, 상태 잔류 없음 | 콜드 스타트 오버헤드 |
| SQLite 단일 DB | 트랜잭션 보장, 백업 쉬움 | 동시 쓰기 제한 |
| 커서 기반 메시지 추적 | 크래시 복구 가능 | 엣지 케이스 복잡 |
| 스킬 기반 확장 | 코어 최소 유지 | 채널마다 별도 브랜치 관리 |
| OneCLI 프록시 | 시크릿 격리 | 외부 의존성 |
| XML 메시지 포맷 | 구조화된 컨텍스트 | 모델의 XML 파싱에 의존 |
