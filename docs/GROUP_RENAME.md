# Renaming a Group Folder

`groups/{name}` 폴더 리네임은 단순한 `mv` 가 아니다. DB · 파일시스템 · OneCLI 세 계층에 흩어진 7개 지점을 순서대로 동기화해야 in-memory stale 없이 정착한다. 빠뜨리기 쉬운 항목(★)은 실제로 빠졌던 지점.

## Prerequisite

- 서비스 중단: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` (macOS) 또는 `systemctl --user stop nanoclaw`.
- 실행 중 컨테이너 `container kill` — bind mount 꼬임 방지. 이 상태에서 아래 단계 진행.
- `store/messages.db` 백업 (UPDATE 실패 시 롤백).

## The 7 touch points

1. **`registered_groups.folder`** — UNIQUE 컬럼. 리네임의 primary key.
2. **`registered_groups.name` ★** — session-reset / Recovery 로그에서 `group.name` 을 사용. folder 와 동기화 안 하면 UI 에 old name 누수.
3. **`scheduled_tasks.group_folder`** — 예약 태스크 연결이 끊기면 스케줄러가 silently skip.
4. **`sessions.group_folder`** (PK) — 세션 이력 유지.
5. **`groups/{old}/` → `groups/{new}/`** — `.gitignore` 됐으므로 일반 `mv`, `git mv` 아님.
6. **`data/ipc/{old}/`** — 실행 중 컨테이너의 bind mount. 반드시 컨테이너 종료 후.
7. **`data/sessions/{old}/ ★`** — Codex 세션 + agent-runner-src 저장소. 초기 체크리스트에서 빠지기 쉬움.

추가로: **OneCLI agent identifier** 는 불변이라 리네임 자체가 불가능. `onecli agent create` (new) → `set-secrets` → `delete` (old) 3단계로 재생성. 상세는 `reference_onecli_gateway.md`.

## Restart and verify

- 빌드 + 서비스 재시작: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.
- in-memory `state.registeredGroups` 는 startup 시 DB 를 한 번만 읽는다 — 재시작 전엔 DB UPDATE 가 반영되지 않는다.
- 재시작 로그에서 `NanoClaw running` 타임스탬프 확인.
- **Backlog 주의**: 그룹별로 쌓여 있던 메시지가 한꺼번에 처리되면서 `MAX_CONCURRENT_CONTAINERS=5` 에 걸려 일부 그룹이 waitingGroups 에 갇힐 수 있음. 한 번 더 kickstart 하면 풀림.

## No-ops (영향 없는 항목)

- `router_state` — JID 기반 (`slack:CHAN_ID`), 폴더명과 무관.
- `messages`, `chats` — `chat_jid` 기반.
- `task_run_logs` — `task_id` FK 기반.
- Slack channel ID — 불변.
- launchd plist — 경로 템플릿만 사용, 그룹명 하드코딩 없음.

## Env var rename in tandem

봇 identity 변경 (pat ↔ mat, dev → pat 통일 등) 을 같이 한다면:

- `src/channels/{file}.ts` 에서 `readEnvFile([...])`, `botTokenKey`, `appTokenKey`, `triggerName` 전수 치환. 예: `SLACK_REVIEW_*` → `SLACK_MAT_*` 시 `slack-review.ts` 4곳.
- `.env` 키 갱신. OneCLI vault 사용 중이면 거기도 확인.

## History

- 2026-04-15: `_dev` / `_review` / 무접미사 → `_pat` / `_mat` 통일 작업에서 이 체크리스트가 정착. `name` 컬럼 · `data/sessions` · OneCLI identifier 가 당시 초안에서 빠져 있었고 운영 중 발견.
