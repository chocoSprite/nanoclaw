# 토큰 lifecycle: mount 단순화 + 만료 알림 정책

**상태:** Active
**날짜:** 2026-04-27
**대체:** [2026-04-26-codex-token-symmetry.md](2026-04-26-codex-token-symmetry.md) (archived)
**다음 단계:** 직접 구현 (Wedge 1 = 5줄, Wedge 2 = 중간 변경)

> **이번 brainstorm 두 wedge:**
> 1. **Codex mount mtime → host-wins 단방향** ([container-mounts.ts:131-137](../../src/container-mounts.ts:131) 5줄을 1줄로). 그룹별 토큰 fork 발산만 차단.
> 2. **401 류 (사용자 수동 간섭 필요한 인증 에러) detect → retry 0 회 + `slack_main` 알림 1회 (debounce).** Codex (앞으로 변경 후) 와 Claude (현재) 양쪽 공통.

---

## 사용자 4계명 평가 (2026-04-27)

| 계명 | 평가 |
|---|---|
| 1. Claude 와 일관성 | 토큰 종류 자체가 다름 (Claude=long-lived bearer 가정, 실제 access token ~8h, Codex=OAuth pair + 파일 기반). 메커니즘 일치 영구 불가능. **단, 401 알림 정책은 두 SDK 공통 추상화 가능 → 운영 흐름 일관성 ✓**. |
| 2. 단순함 | Wedge 1 = 5줄 줄어듦. Wedge 2 = error path 한 군데에 if 분기 + 알림 발송 호출 추가. 둘 다 OpenAI 공식 패턴 위반 0. |
| 3. Claude 와 보안 비슷 | 토큰 종류 차이는 영구 격차 (사용자가 부산물 평가). Wedge 2 는 보안과 무관. |
| 4. 삽질 그만 | Wedge 1 회귀 위험 ≈ 0. Wedge 2 의 알림 발송은 기존 outbound 흐름 활용 (신규 SDK 통합 없음). |

원 wedge (base64-env-tmpfs) 는 폐기 — [archived doc](2026-04-26-codex-token-symmetry.md) 참조.

---

## Wedge 1 — Codex mount mtime → host-wins 단방향

### 변경

[src/container-mounts.ts](../../src/container-mounts.ts) 의 codex 분기 안 mtime 비교 블록:

```typescript
// before (5줄):
const hostMtime = fs.statSync(hostFile).mtimeMs;
const groupMtime = fs.existsSync(groupFile)
  ? fs.statSync(groupFile).mtimeMs
  : 0;
if (hostMtime > groupMtime) {
  fs.copyFileSync(hostFile, groupFile);
}

// after (1줄):
fs.copyFileSync(hostFile, groupFile);
```

`for (const file of ['auth.json', 'config.toml'])` 루프 안 해당 블록만 교체.

### 효과

- **그룹별 토큰 fork 발산 차단.** 컨테이너가 그룹 dir 의 `auth.json` 갱신해도 다음 spawn 때 호스트 토큰으로 reset. 호스트가 source of truth, 그룹들은 ephemeral mirror.
- **GPT-5.5 사건의 stale 박제와 무관.** 그건 같은 디렉토리 안 `models_cache.json` (이 mtime 흐름에 안 타는 별도 파일) 이 원인이었음. auth.json 의 mtime 비교는 stale 박제 일으킨 적 없음 — 다만 fork 발산은 가능한 약점.
- **codex 의 자동 refresh 흐름 그대로.** 컨테이너 안 codex 가 access token 만료 시 OAuth refresh → 그룹 dir 안에서 갱신 → 다음 spawn 때 호스트 토큰으로 reset → codex 가 또 refresh. 호스트 stale 처리는 별건 (아래).
- **OpenAI 공식 권장 패턴 유지.** [developers.openai.com/codex/auth/ci-cd-auth](https://developers.openai.com/codex/auth/ci-cd-auth) 의 `docker cp ~/.codex/auth.json` 흐름과 동일.

---

## Wedge 2 — 401 류 detect → retry 중단 + 알림

### 동기

2026-04-27 매트 (Claude SDK) 에서 keychain access token 만료 (~8시간 추정) 후 무한 retry 사이클 발생. 흐름:

```
401 → 5회 retry (5/10/20/40/80s backoff) → max retry 후 drop
  → 다음 메시지 들어오면 또 1번부터 → 무한 루프
```

근본 원인: `container-credentials.ts` 가 `claudeAiOauth.accessToken` 만 env 로 주입하고 refresh token 안 보냄. 컨테이너 안 SDK 가 refresh 못 함. 호스트에서 `claude` 자주 안 쓰면 keychain access token 도 stale → nanoclaw 가 stale 토큰 매번 주입.

매번 사용자가 모니터링하지 않아도 신호 받게 만드는 게 이번 wedge 의 핵심.

### Detect 대상

| SDK | 상태 | Detect 신호 |
|---|---|---|
| Claude | 현재 | stderr 에 `API Error: 401 ... authentication_error` 또는 `Invalid authentication credentials` |
| Codex | 향후 | codex CLI 자체 refresh 실패 후 401 (refresh token 까지 만료한 케이스). `turn.failed` event 의 message 또는 stderr 에 auth error 패턴 |

**비대상** (retry 그대로): 일시 네트워크 에러 / rate limit (429) / 서버 5xx / 컨테이너 spawn 자체 실패.

### 변경 (high-level)

핵심 위치: [src/index.ts](../../src/index.ts) 또는 [src/container-runner.ts](../../src/container-runner.ts) 의 agent error 처리 분기 — 현재 `retryCount` 증가 + `delayMs` backoff 흐름.

```
agent error 받음
  → error message classify
      ├── 401 / auth_error / invalid credentials  →  AUTH_EXPIRED
      ├── 429 / rate limit                         →  RATE_LIMIT (retry OK)
      ├── 5xx / network                            →  TRANSIENT (retry OK)
      └── 그 외                                     →  UNKNOWN (현재 흐름 유지)

if AUTH_EXPIRED:
  retryCount = 0  (강제)
  schedule retry 안 함
  message cursor 그대로 보존 (drop 안 함, 풀린 후 자동 재처리)
  notifyAuthExpired(group, sdk, errorRequestId)
else:
  현재 흐름 유지 (5회 retry / backoff)
```

### 알림 사양

**채널:** `slack_main` (`slack:C0AQFDF3EBS`, codex SDK lane).
**이유:** Claude lane 이 만료된 상태에서 Claude 채널로 알림 보내면 그것도 401. 다른 SDK (codex) lane 의 메인 채널이 안전.

**메시지 형태 후보:**

```
🔴 [{group_name} / {sdk}] 인증 만료
  요청 ID: {request_id}
  복구:
    • Claude: 호스트에서 `claude -p "hi"` 한 번 → `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
    • Codex: 호스트에서 `codex login` 재실행 → kickstart
  복구 후 대기 중인 메시지 자동 재처리됨.
```

**Debounce:** 같은 (group, sdk) 조합으로 5분 내 동일 알림 안 보냄. N개 그룹이 동시에 만료되면 N개 알림 그대로 (그룹별로 따로 알아야 어디 풀렸는지 추적 가능).

**구현 후보 위치:**
- [src/channels/registry.ts](../../src/channels/registry.ts) 또는 채널 outbound 흐름 — `slack:C0AQFDF3EBS` 로 `sendMessage` 호출.
- Debounce 상태는 `state` (in-memory Map) 으로 충분 — 재시작 시 reset OK (재시작 후 다시 만료면 또 알림).

### Edge case

- **알림 발송 자체 실패** (slack 외 SDK 장애): 로그만 남기고 retry 안 함. 사용자가 다른 path 로 알아야 하는 시나리오 — 별건.
- **만료가 nanoclaw 시작 직후** (모든 그룹 동시 401): debounce 가 group 별 separate 라 N개 알림 폭주. 만약 폭주가 거슬리면 group-level → sdk-level debounce 로 격하 (예: "Claude lane 전체 만료" 알림 1개). 첫 wedge 에서는 group-level 유지, 측정 후 결정.
- **사용자가 알림 보고도 갱신 안 하면**: message cursor 보존 상태로 무한 대기. 메시지 큐 적체 — 별건. (현재 behavior 도 dropped 메시지는 영원히 안 옴.)
- **Codex 가 자체 refresh 후 401**: codex CLI 가 refresh 시도했지만 refresh token 도 만료한 케이스. 이건 진짜 사용자 개입 필요 → AUTH_EXPIRED 분류. **transient access token 만료 (codex 가 자체 refresh 로 풀 수 있는)** 와 구분 필요 — codex 의 stderr 패턴으로 구분 가능한지 spike (Open Q).

### Open Questions (Wedge 2 별건)

- **Codex 의 401 vs refresh-자체-실패 구분**: codex CLI 가 자체 refresh 시도 후 그래도 실패하면 어떤 에러 형태로 표면화? `turn.failed` event 또는 stderr 의 정확한 메시지 — codex 그룹 만료 케이스 한 번 발생해야 측정 가능. 임시 대응: 일단 codex 도 401 패턴 detect 하면 AUTH_EXPIRED 분류 (false positive 위험 < 무한 루프 위험).
- **Codex 의 `429 rate limit`**: codex 가 자체 refresh 너무 자주 시도하면 OpenAI rate limit 가능 (Wedge 1 의 호스트 stale 처리 별건과 연관). 429 는 retry OK 분류.

---

## 통합 효과 (두 wedge 합쳐서)

- **그룹별 토큰 fork 발산** = Wedge 1 으로 차단.
- **호스트 stale 만료 누적 → 무한 retry** = Wedge 2 로 즉시 알림 → 사용자 한 번 갱신 → 자동 재처리.
- 사용자 4계명 부분 충족: 일관성 (운영 흐름), 단순 (작은 변경), 삽질 그만 (모니터링 안 해도 신호 받음).
- 보안 격차는 영구 — 토큰 종류 차이의 본질.

---

## 검증

```bash
npm run format:fix
npx eslint src/ --max-warnings 0
npx vitest run
```

테스트 추가 후보:

**Wedge 1**:
- `buildVolumeMounts` codex 분기에서 `data/sessions/<group>/.codex/auth.json` 이 호스트 사본으로 매번 덮어쓰여지는지.
- 그룹 dir 의 auth.json 이 호스트보다 최신일 때도 호스트 사본으로 덮어쓰는지 (host-wins 검증).

**Wedge 2**:
- error message classifier 의 401 패턴 detect (Claude / Codex 둘 다 fixture).
- AUTH_EXPIRED 분류 시 retry 흐름 호출 안 됨 + 알림 발송 호출 됨.
- Debounce 5분 내 같은 (group, sdk) 알림 1회만.
- message cursor 보존 (drop 안 됨) 검증.

---

## 별건 / Open Questions (전체)

- **호스트 토큰 stale 처리** (Wedge 1 후속). codex 자동 refresh 가 매 spawn 마다 일어나면 OpenAI 부하. 옵션:
  - host-side cron 으로 주기적 dummy refresh
  - 컨테이너 종료 시 IPC 로 갱신본 호스트 역전파
  - 첫 wedge 후 측정해서 결정.
- **Claude 의 refresh token 활용** (Wedge 2 의 진짜 근본 fix). `container-credentials.ts` 가 access 외에 refresh token 도 주입 + 컨테이너 안 SDK 가 자체 refresh. 큰 변경 + Claude SDK 의 refresh 지원 확인 필요. 알림 정책으로 일단 lifecycle 관리하고, 빈도 보면서 결정.
- **`OPENAI_API_KEY` 누설 path** — 검증 완료 (2026-04-27): 호스트/`.env`/launchd plist 어디에도 없음, 컨테이너 env 는 명시적 `-e` flag 만. 추가 fix 0.
