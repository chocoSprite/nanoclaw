# Brainstorm: Codex 토큰 주입을 Claude 와 추상화 대칭화

> ⚠️ **ARCHIVED (2026-04-27)** — 사용자 4계명 우선순위 (일관성 > 단순 > 보안 > 삽질 그만) 재평가 결과, 본 wedge (base64-env-tmpfs) 는 계명 2, 4 정면 위반으로 폐기. 진행 결정은 [2026-04-27-codex-mount-mtime.md](2026-04-27-codex-mount-mtime.md) (mtime host-wins 5줄 wedge) 참조. 본문은 "왜 이쪽으로 안 갔는지" 판단 history 로 보존.

**상태:** Draft (Spike #1 완료, 2026-04-26)
**날짜:** 2026-04-26
**작성:** /brainstorm
**다음 단계:** `/plan-spec` 또는 직접 구현 시작

> **이번 wedge (1줄):** Codex SDK 토큰 주입을 mount 방식에서 **base64-encoded auth.json env + 컨테이너 entrypoint 작성 + tmpfs `CODEX_HOME`** 으로 바꿔 Claude 와 추상화 대칭화. 디스크 사본 N개 제거, mtime 동기화 trick 제거, refresh 는 codex CLI 자체 내장 메커니즘 활용.

---

## ⚠️ Open Questions — Spike 결과 + 잔여

### Spike #1, #2 (2026-04-26 완료)

codex CLI binary `strings` 분석 + `codex login --help` 결과:

| 질문 | 답 |
|---|---|
| Codex SDK 가 OAuth bearer 를 직접 env 변수로 받느냐? | **❌ No.** ChatGPT bearer 를 `CODEX_AUTH_TOKEN` 같은 형태로 직접 받는 변수 없음. `codex login` 옵션은 `--with-api-key` (stdin, 사용 금지) + `--device-auth` (interactive) 만. |
| 우회 경로 있느냐? | **✅ Yes.** `CODEX_HOME` env 로 codex 가 읽는 `~/.codex` 디렉토리 위치 override 가능. 그 디렉토리 안 `auth.json` 만 있으면 됨 → tmpfs + entrypoint 작성으로 디스크 사본 0 가능. |
| Codex CLI 가 명시적 refresh 명령을 주느냐? | **❌ No.** `codex login --refresh` 같은 명령 없음. **하지만 codex CLI 자체가 OAuth refresh 메커니즘 내장** (`https://auth.openai.com/oauth/token` 호출, `CODEX_REFRESH_TOKEN_URL_OVERRIDE` env 로 override 가능). 즉 호스트 별도 refresh 흐름 불필요. |

**결론:** 단순 env 토큰 주입은 불가능하지만, `CODEX_HOME` + entrypoint 작성 + 자동 refresh 활용으로 **wedge motivation 은 그대로 달성 가능**.

### 잔여 Open Questions

| # | 항목 | 상태 |
|---|---|---|
| 1 | **호스트 토큰 stale 처리** | 컨테이너 안 codex 가 refresh 한 갱신된 토큰을 호스트 `~/.codex/auth.json` 에 어떻게 역전파? 옵션: (a) 컨테이너 종료 시 IPC 로 호스트에 emit, (b) 호스트가 spawn 직전 dummy `codex` 호출로 자체 refresh 트리거, (c) host-side cron 주기 refresh. 별건 결정. |
| 2 | **Claude OAuth 토큰의 실제 lifetime** | long-lived 가정 검증 (P1, 가정 깨지면 별건 brainstorm) |
| 3 | **`config.toml` 처리** | 시크릿 아님. `CODEX_HOME` 으로 가면서 같은 디렉토리에 entrypoint 가 함께 작성, 또는 별도 read-only mount. |

---

## ✅ 확정된 결정

- **Claude 쪽 (`src/container-credentials.ts`) 손대지 않음.** spawn 때 keychain 매번 읽고 env 한 개로 주입하는 현행이 모범답안. 변경하면 그 자체가 리그레션 위험.
- **외부 vault (HashiCorp Vault / 1Password / age-encrypted file) 안 함.** 호스트 측만 보호 강화하고 컨테이너 안 노출은 그대로 — 이번 동기 (운영 신뢰성 + 미감) 와도 보안 동기 (LLM 가시권) 둘 다 충족 못함. ROI 나쁨. `project_secret_management_design.md` 평가 그대로 유지.
- **채널 토큰 (.env) 영역은 이번 변경 범위 밖.** 호스트 프로세스 전용, 컨테이너 진입 0 (entrypoint 가 `mount --bind /dev/null` 로 가림). 재설계 필요 없음.
- **일관성 = "추상화 일관성"** (둘 다 env 주입 인터페이스). "메커니즘 일관성" (둘 다 long-lived setup token) 은 Codex bearer 토큰 종류 자체가 달라 불가능.
- **Codex 인증 라우트 = ChatGPT 구독 (OAuth bearer) only.** API Key 라우트 (`CODEX_API_KEY`/`OPENAI_API_KEY`) 는 옵션으로도 검토 안 함 — 비용 모델 변경이라 영구 거부 (`feedback_codex_no_api_key.md`).
- **시크릿 주입 메커니즘 = 옵션 A (In-memory injection)**: 호스트가 `~/.codex/auth.json` 내용을 base64-encode 하여 env (예: `NANOCLAW_CODEX_AUTH_JSON`) 로 컨테이너에 주입 → entrypoint 가 디코드 후 tmpfs `/tmp/codex-home/auth.json` 작성 → `CODEX_HOME=/tmp/codex-home` env 로 codex CLI 가 거기 읽음. **디스크 사본 N개 제거. mtime 동기화 trick 제거.**
- **부분 mount 유지** (auth.json 만 env 화, 나머지 파일은 영속성 위해 bind mount): `CODEX_HOME=/tmp/codex-home` 은 tmpfs base. 그 안의 `sessions/` 만 호스트 `data/sessions/<group>/.codex/sessions/` 와 bind mount 해서 codex thread persistence 보존. `config.toml` 은 호스트에서 read-only mount 또는 entrypoint 가 작성. `auth.json` 만 tmpfs 에 평문 (컨테이너 종료 시 자동 소거).
- **Refresh 책임 = codex CLI 자체에 위임.** orchestrator 의 401 detect / 재시작 layer 불필요. codex 가 컨테이너 안에서 OAuth refresh 자동 처리 (`https://auth.openai.com/oauth/token`).
- **Broker pattern (옵션 B) 안 함.** LLM 가시권 0 까지 잡는 강한 옵션이지만 보안이 부산물이라 daemon 추가 비용이 더 큼. 보안이 1순위로 올라오면 별건.

---

## 1. 무슨 기능인가 (한 단락)

OneCLI 제거 (2026-04-25, 커밋 `c1ed2e6`) 후 시크릿 모델이 두 갈래로 갈라져 있다. Claude 는 keychain → `CLAUDE_CODE_OAUTH_TOKEN` env 한 줄로 깨끗한데, Codex 는 호스트 `~/.codex/auth.json` → `data/sessions/<group>/.codex/auth.json` 그룹별 평문 사본 N개 → 컨테이너 마운트 라는 3-hop. 이 mount 흐름이 mtime 비교 로직 (`src/container-mounts.ts:131-137`) 으로 그룹별 fork 발산까지 일으키며 GPT-5.5 사건의 `models_cache.json` stale 박제와 동형 메커니즘을 갖고 있어, 운영 신뢰성과 코드 미감 둘 다 흔들고 있다. 이 작업은 Codex 의 토큰 주입을 Claude 와 동일한 env 인터페이스로 맞추되, Codex bearer 토큰의 짧은 lifetime 을 위해 "401 → 호스트 refresh → 컨테이너 재시작" 이라는 refresh layer 를 Codex 쪽에만 추가한다.

---

## 2. 흐름 (백엔드 전용)

**Spawn 시 (정상 — Codex):**

```
container-runner spawnContainer(group, sdk='codex')
  → applyCredentialArgs(args, name, sdk='codex')
      → fs.readFile(~/.codex/auth.json) 동기 읽기
      → base64 encode
      → args.push('-e', 'NANOCLAW_CODEX_AUTH_JSON=<b64>')
      → args.push('-e', 'CODEX_HOME=/tmp/codex-home')
  → buildVolumeMounts() — codex 그룹의 .codex/ 통째 마운트 제거.
                            대신 부분 mount:
                              - data/sessions/<group>/.codex/sessions/  →  /tmp/codex-home/sessions/  (thread persistence)
                              - host config.toml staging dir            →  /tmp/codex-home/config.toml  (read-only)
                              - skills/ 는 별도 mount 또는 entrypoint 동기화
                            (auth.json 은 절대 mount 하지 않음 — env 로만)
  → docker/podman run --env ... + mounts
컨테이너 entrypoint (in-container):
  → mkdir -p /tmp/codex-home  (tmpfs base, 위 bind mount 들이 hang)
  → echo "$NANOCLAW_CODEX_AUTH_JSON" | base64 -d > /tmp/codex-home/auth.json
  → chmod 600 /tmp/codex-home/auth.json
  → unset NANOCLAW_CODEX_AUTH_JSON  (env 안에 raw token 흔적 제거)
  → exec node dist/index.js  (codex CLI 는 CODEX_HOME 으로 /tmp/codex-home 읽음)
```

**Spawn 시 (Claude — 현행 유지):**

```
applyCredentialArgs(args, name, sdk='claude')
  → keychain → CLAUDE_CODE_OAUTH_TOKEN env 한 개  (변경 없음)
```

**Codex 토큰 refresh 흐름 (codex CLI 자체):**

```
컨테이너 안 codex CLI call → access token 만료 detect
  → codex 가 자체적으로 https://auth.openai.com/oauth/token 호출 (refresh)
  → /tmp/codex-home/auth.json 갱신 (tmpfs)
  → call retry, 사용자에겐 노출 0
```

**컨테이너 종료 시:**

```
컨테이너 stop / kill
  → tmpfs base 소거 (auth.json 사라짐, refresh 된 access token 유실)
  → bind mount 된 /tmp/codex-home/sessions/ 는 호스트 dir 에 그대로 보존 (thread persistence ✓)
  → bind mount 된 /tmp/codex-home/config.toml 는 호스트 read-only 라 영향 없음
  → (Open Question #1) 갱신된 토큰을 호스트로 어떻게 역전파할지 결정 필요
```

**Claude 토큰 만료 흐름 (현행 유지):**

```
컨테이너 Claude SDK call → 401
  → 컨테이너 실패 + 사용자 알림
  → 사용자 호스트에서 `claude setup-token` 수동 갱신
  → 다음 spawn 때 자동 반영
```

분기 케이스:
- **정상**: env 한 번 주입, codex CLI 가 알아서 refresh 처리.
- **호스트 토큰 stale (Codex)**: 호스트 `~/.codex/auth.json` 의 access token 이 이미 만료 → 컨테이너 안에서 codex 첫 호출 시 즉시 refresh → 정상 동작 (refresh token 만 살아있으면 무중단).
- **Refresh token 도 만료**: 호스트 `~/.codex/auth.json` 의 refresh token 까지 만료 (장기 미사용) → 컨테이너 안 codex refresh 도 실패 → 사용자에게 명시적 에러 + 호스트에서 `codex login` 재실행 요청.
- **Claude 만료**: 사용자 수동 개입 (long-lived 가정상 빈도 매우 낮음).

---

## 3. 왜 만드나

**해결하는 페인 — 운영 신뢰성:** GPT-5.5 사건 (2026-04-25, 커밋 `4bb5364` + `2ffda44`) 에서 `data/sessions/<group>/.codex/models_cache.json` 의 `client_version: 0.117` 이 박제된 채로 server 가 5.5 거부 — 캐시 파일 삭제로 해결한 사례. mtime 비교 기반 디스크 동기화 흐름 자체가 stale 박제를 일으킬 수 있다는 사실 신호. 같은 흐름에 사는 `auth.json` 도 잠재적으로 동형 위험.

**해결하는 페인 — 코드 미감:** Claude 는 spawn 마다 keychain 1줄 → env 1개로 끝. Codex 는 mtime 비교 + 그룹별 사본 + 양방향(?)성을 가장한 단방향 동기화 + Apple Container 의 file mount 미지원 우회까지 — 같은 "토큰 주입" 이라는 한 일에 비대칭 두 메커니즘. 신규 SDK 추가 시 어느 쪽을 모방할지 매번 결정 부담.

**왜 지금:** GPT-5.5 사건이 트리거. 5일 전 `project_secret_management_design.md` 에서 "노출면 좁아 yagni" 결론냈지만, 그건 **보안 위험** 평가였고 **운영 신뢰성** 평가는 누락됨. 동기 분리 후 재평가 필요.

**대상 사용자 (백엔드):** orchestrator (호스트 nanoclaw 프로세스) + agent-runner (컨테이너) + 운영자 (사용자 본인). 최종 사용자는 latency 변화로 간접 영향만.

**그 외 영향:** 마이그레이션 중 codex 사용 그룹이 일시 토큰 재발급 필요할 수 있음 (단, 호스트 `~/.codex/auth.json` 보존되면 무중단 가능).

---

## 4. 이번 스프린트 Wedge (가장 작은 가치 있는 버전)

**들어가는 것:**
- `applyCredentialArgs()` 에 codex 분기 추가 — 호스트 `~/.codex/auth.json` 읽어서 base64 인코딩 후 `NANOCLAW_CODEX_AUTH_JSON` env 주입 + `CODEX_HOME=/tmp/codex-home` env 추가.
- 컨테이너 `entrypoint.sh` 에 codex 분기 추가 — base64 디코드 → tmpfs 작성 → env 안 raw 토큰 unset → 정상 진입.
- `buildVolumeMounts()` 에서 codex 분기 재구성:
  - **삭제**: `data/sessions/<group>/.codex/` 통째 mount → `/home/node/.codex/` (현재 [container-mounts.ts:153-157](src/container-mounts.ts:153))
  - **추가**: `data/sessions/<group>/.codex/sessions/` → `/tmp/codex-home/sessions/` (thread persistence 보존)
  - **추가**: 호스트 `~/.codex/config.toml` staging copy → `/tmp/codex-home/config.toml` (read-only, 호스트 mtime 비교 복사 유지 또는 entrypoint 가 env 받아 작성)
  - **추가** (필요 시): `skills/` 별도 mount 또는 entrypoint 동기화
- `data/sessions/*/.codex/auth.json` 정리 (백업 후 삭제) — sessions/ 디렉토리 자체는 보존 (thread persistence).
- 1개 그룹 (가장 활발한 codex 그룹) 에서 1-2일 dry-run 후 전체 롤아웃.

**일부러 빼는 것:**
- **Orchestrator 측 401 detect / 재시작 layer** — codex CLI 자체가 OAuth refresh 처리. nanoclaw 가 모방할 필요 없음.
- **Broker socket pattern (옵션 B)** — 보안이 1순위 동기로 올라오면 가야 하지만 지금은 부산물. 추가 daemon = 추가 failure point.
- **Claude 쪽 refresh layer** — long-lived 가정 깨지면 별건 brainstorm.
- **자동 토큰 회전 (proactive refresh, 주기적 갱신)** — codex CLI 의 lazy refresh 로 충분.
- **그룹별 토큰 차등 정책** (그룹마다 다른 codex 계정 등) — yagni. 모든 그룹 동일 호스트 토큰 공유.
- **Refresh 된 토큰의 호스트 역전파** — Open Question #1 로 분리. 첫 wedge 에서는 매 spawn 마다 호스트 토큰 다시 주입 + codex 가 컨테이너 안에서 lazy refresh. 호스트 stale 화는 사용자가 호스트에서 가끔 codex 쓰면 자연 해결.

**배포 가능 시점 추정:** 구현 1-2일 + dry-run 1-2일 + 전체 롤아웃 0.5일 ≈ **3-5일** (Spike 끝나서 단축).

---

## 5. 백엔드 스캐폴딩 힌트

> `/plan-spec` 로 넘어갈 때 참고. 확정 스펙 아님.

- **변경 파일 (예상):**
  - [src/container-credentials.ts](src/container-credentials.ts) — codex 분기 추가 (auth.json 읽기 + base64 + env 주입)
  - [src/container-mounts.ts](src/container-mounts.ts) — codex 분기 재구성: `.codex/` 통째 mount 제거 + `sessions/` bind mount 추가 + `config.toml` 별도 처리
  - `container/entrypoint.sh` (또는 컨테이너 진입 스크립트) — base64 디코드 + tmpfs 작성 + raw 토큰 env unset
  - **변경 필요 없는 영역**: `src/ipc.ts`, `src/container-runner.ts` 의 refresh-related 로직 (codex CLI 가 알아서 처리)
- **새 인터페이스 없음** — 기존 `applyCredentialArgs()` 시그니처 유지, 내부 codex 분기만 확장.
- **테스트 후보:**
  - `applyCredentialArgs` codex 분기 unit test — fixture host auth.json 으로 base64 인코딩 검증.
  - entrypoint 의 디코드 + tmpfs 작성 + chmod 600 검증 (integration).
  - `data/sessions/*/.codex/` 미참조 회귀 테스트 (마이그레이션 후 절대 안 만들어지는지).

---

## 6. Edge case + 미리 떠오른 리스크

**Edge case:**
- **호스트에 `~/.codex/auth.json` 이 없는 환경** (codex 한 번도 안 쓴 dev machine): codex 사용 그룹 spawn 시 명시적 에러 + 사용자에게 `codex login` 요청.
- **호스트 access token 만료, refresh token 살아있음**: 컨테이너 안 codex 가 첫 호출 시 자동 refresh → 무중단. (가장 흔한 케이스)
- **호스트 refresh token 까지 만료** (장기 미사용): 컨테이너 안 codex refresh 도 401 → 사용자에게 명시적 알림 + 호스트에서 `codex login` 재실행.
- **컨테이너 안에서 토큰 갱신 후 컨테이너 종료**: tmpfs 라 갱신본 유실. 다음 spawn 때 호스트 토큰 다시 주입 → codex 가 또 refresh → access 갱신. **refresh token 은 보통 longer-lived 라 무한 refresh 사이클은 안 일어나지만**, refresh 빈도가 비정상으로 높으면 OpenAI rate limit 우려 (Open Question #1 의 동기).
- **base64 토큰이 너무 큼**: linux env 한계 ~128KB, auth.json ~5KB → base64 ~7KB. 여유 충분.
- **Thread resume 시 sessions 디렉토리 비어있음**: `sessions/` bind mount 가 빠지면 `codex.resumeThread(sessionId)` 가 [codex-adapter.ts:96](container/agent-runner/src/codex-adapter.ts:96) 의 catch 절에서 fallback to startThread → 매번 fresh thread → 대화 연속성 깨짐. **wedge 의 부분 mount 가 이걸 막아야 함.**
- **첫 마이그레이션 시 sessions/ 보존**: 기존 `data/sessions/*/.codex/auth.json` 만 삭제하고 `sessions/` 디렉토리는 그대로 두기. 통째 삭제 안 됨 (회귀).

**기술 리스크:**
- **`CODEX_HOME` env override 가 실제로 작동 안 하는 케이스**: strings 분석 기반이라 실제 검증 필요. **첫 구현 단계에서 즉시 테스트** — `CODEX_HOME=/tmp/test-codex codex login status` 로 호스트에서 확인 가능. 작동 안 하면 wedge 재검토 (broker pattern 또는 mount 유지).
- **Apple Container 의 mount 제약**: `config.toml` 별도 처리 시 file mount 미지원이라 staging dir 통한 directory mount 필요. 또는 entrypoint 가 `config.toml` 도 env 로 받아 작성. `sessions/` bind mount 는 directory 라 OK.
- **tmpfs base 와 bind mount 의 마운트 순서**: `/tmp/codex-home` 이 tmpfs 인 상태에서 `/tmp/codex-home/sessions/` 에 bind mount 가 가능한지 컨테이너 런타임마다 다를 수 있음 (Apple Container 의 VirtioFS 가 tmpfs subdir 에 bind mount 허용하는지 검증 필요). 안 되면 `CODEX_HOME` 자체를 tmpfs 가 아닌 일반 directory mount 로 바꿔야 함 (디스크 사본 다시 생기지만 entrypoint 가 spawn 시 매번 덮어쓰면 stale 위험은 없음).
- **entrypoint 가 base64 디코드 후 raw 토큰 env unset 못하는 경우**: bash `unset` 은 현재 process scope 만 — exec 직전 unset 후 실행 자식 프로세스에는 안 보임. 검증 필요.

**운영 리스크:**
- **Refresh 빈도가 운영 부담을 만드는 경우**: codex CLI 가 매 spawn 마다 refresh 시도하면 OpenAI rate limit 또는 부하. Open Question #1 (호스트 역전파) 으로 완화 가능 — 하지만 첫 wedge 에는 미포함.
- **마이그레이션 중 토큰 손실**: 기존 `data/sessions/*/.codex/auth.json` 삭제 전 백업 필수. 호스트 토큰보다 그룹 토큰이 더 새것이었던 그룹 (mtime fork 의 부작용) 은 마이그레이션 직후 호스트 `codex login` 한 번 필요할 수 있음.

---

## 7. /brainstorm 이 push 한 것

- **"Codex/Claude OAuth 가 mount 방식이라 애매"** → push 후: **"보안 vs 운영 신뢰성 두 동기 분리. 사용자 답에서 운영 신뢰성 + 미감이 본체, 보안은 부산물로 확정."** (이 분리가 doc 의 "왜" 와 "안 함 (vault)" 결정 둘 다 잡음.)
- **(클로드 첫 reframe) "Codex mount 는 양방향 흐름"** → push 후: **"정확히는 그룹별 fork 단방향. 호스트→그룹만 mtime 비교 복사, 컨테이너→그룹 갱신은 그룹 안에서만 살아남음."** (코드 [container-mounts.ts:131-137](src/container-mounts.ts:131) 재확인 후 정정.)
- **"Codex 도 env 주입화 = 일관성"** → push 후: **"일관성에 두 의미. '추상화' (env 인터페이스) 는 가능, '메커니즘' (long-lived 토큰) 은 Codex bearer 토큰 종류 자체가 달라 불가능. Codex 만 refresh layer 추가가 진짜 추상화 일관성의 모습."** (Claude 의 refresh 모델 확인 후 토큰 종류 차이 발견.)
- **"단순 mount 가 아닌 무언가"** → push 후: **"옵션 4개 (호스트 주기 / broker / lazy 교체 / 검토) 중 옵션 3 (lazy 교체) 가 운영 신뢰성 + 미감 동기에 가장 정렬. 보안이 1순위 신호 보이면 옵션 2 (broker) 로 전환 가능."** (사용자 동기와 옵션 매핑 명시.)
- **(Spike #1 후) "401 detect → orchestrator refresh → 재시작" 흐름 추가 필요** → push 후: **"불필요. codex CLI 자체가 OAuth refresh 메커니즘 내장 (`https://auth.openai.com/oauth/token` 호출). nanoclaw 가 모방하면 코드 중복 + race 리스크. wedge 단순화."** (codex binary strings 분석 후 정정.)
- **"Codex 토큰을 env 한 줄로 주입"** → push 후: **"단순 토큰 env 변수 없음. 대신 `CODEX_HOME` override + base64-encoded auth.json env + entrypoint 가 tmpfs 작성. 결과는 동등 (디스크 사본 0, mtime trick 0) 이지만 메커니즘은 다름 — 정직한 묘사."** (`codex login --help` + binary strings 검증 후.)
- **"`.codex/` mount 통째 제거"** → push 후: **"통째 제거 시 `sessions/` 같이 사라져 thread persistence 회귀. 정확히는 'auth.json 만 env 화, `sessions/` 는 별도 bind mount 유지'. wedge 의 부분 mount 모델로 정밀화."** (codex-adapter 의 resume 흐름 재확인 후 함정 발견.)

---

## 8. Open Questions (별건 결정 또는 다음 단계)

- **호스트 토큰 stale 처리 (위 Open Question #1).** 첫 wedge 에서는 미포함 — 매 spawn 마다 호스트 토큰 주입 + codex lazy refresh. 호스트 stale 누적 시 별건 (옵션: IPC 역전파 / spawn-pre dummy refresh / cron).
- **마이그레이션 단계** — 1인 fork 라 운영 부담만 보고 결정. wedge 에서 "1개 그룹 dry-run → 전체" 가정.
- **`config.toml` 의 처리 방식** — entrypoint 작성 vs read-only directory mount vs env 주입. 시크릿 아니라 큰 결정 아님. 가장 단순한 후보: 호스트 `~/.codex/config.toml` 을 staging dir 에 복사 후 디렉토리 mount (현재 mtime 비교 흐름의 일부 살림).
- **`history.jsonl` / `skills/` 처리** — `history.jsonl` 은 codex CLI 의 shell history. 영속성 필요 없으면 tmpfs OK. `skills/` 는 [container-mounts.ts:142-152](src/container-mounts.ts:142) 의 `container/skills/` 동기화 흐름 — entrypoint 가 build 시 cp 로 옮기거나 별도 read-only mount.
- **`sessions/` bind mount 가 tmpfs subdir 에 가능한지 런타임 검증** (위 기술 리스크 항목). 안 되면 `CODEX_HOME` 자체를 일반 mount 로 변경하고 entrypoint 가 `auth.json` 을 매 spawn 시 덮어쓰는 형태 (디스크 평문 1개 다시 생기지만 stale 박제는 없음).
- **Multi-account codex 시나리오** — 그룹별 다른 ChatGPT 계정. yagni, 팀 확장 시 재검토.
- **운영자 알림 채널** — refresh token 만료 / `codex login` 재실행 필요 시 사용자에게 어디로 알림? Slack `slack_main`? — 별건 brainstorm.

---

## 부록: 원답 (참고용)

<details>
<summary>brainstorm 답변 원본</summary>

**Q1+Q2 (트리거 = User Pain + Why Now 통합):**
> "실제 사건 본 후, 코드 품질·미감"
>
> (옵션 4가지 중 "디스크 평문 사본 N개", "LLM 가시권 평문" 직감 두 개는 안 골랐고, 실신호 + 미감 두 개를 골라 동기를 보안에서 운영 신뢰성으로 재정의.)

**Q3 (Smallest Version):**
> "사실 클로드와 대칭화가 된다면 일단은 베스트라고 생각해"
>
> (사용자 명시 입장. wedge 의 entry condition 이 됨.)

**Q4 (User Segment) — 백엔드 전용이라 정책 깊이로 치환:**
> 사용자 답: "방금질문 클로드는 어떤대"
>
> (클로드한테 옵션 4개 추천 묻는 형태로 진행. 옵션 3 추천 + 이유 설명.)

**Q5 (Hidden Policy) — refresh 주체 결정:**
> 사용자 답: "1번가봐야지"
>
> (옵션 1 = 추상화 일관성. env 주입 + Codex 만 refresh layer 추가. 메커니즘 일관성은 토큰 종류 다름 이유로 포기. **Spike #1 결과 후 변경**: refresh layer 자체 불필요, codex CLI 가 자체 처리.)

**Spike #1 후 추가 결정:**
> 사용자 답: "당연 라우트B 라우트A는 절대 선택안하니까 메모리깊이 박아둬 언급도하지마" (2026-04-26)
>
> (Codex 인증은 ChatGPT 구독 OAuth 라우트 only. API Key 라우트 영구 금지. `feedback_codex_no_api_key.md` 저장.)

> 사용자 답: "ㅇㅇ" (옵션 A 진행 동의)
>
> (In-memory injection — base64 + entrypoint + tmpfs `CODEX_HOME` 흐름 확정.)

</details>
