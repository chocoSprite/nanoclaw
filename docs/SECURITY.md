# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation

NanoClaw 는 SDK 별 최소 주입 원칙으로 자격 증명을 다룬다.

**Claude SDK 컨테이너**:
- 호스트 `applyCredentialArgs()` 가 macOS keychain 의 `Claude Code-credentials` 에서 OAuth 토큰을 읽어 `CLAUDE_CODE_OAUTH_TOKEN` env 한 개만 주입.
- 토큰은 컨테이너 env 에만 존재 — 디스크에 안 씀, `.env` 에 안 씀.
- Keychain 접근은 호스트 사용자 권한이 필요하므로 컨테이너 내부에서 추출 불가.

**Codex SDK 컨테이너**:
- 호스트 `~/.codex/auth.json` (ChatGPT bearer 토큰) 을 그룹별 sessions dir 에 mtime 비교 복사 후 `/home/node/.codex/auth.json` 으로 마운트.
- 각 그룹이 독립 사본을 가지므로 cross-group 토큰 유출 없음.
- 토큰 만료 시 호스트 `~/.codex/auth.json` 갱신 → 다음 spawn 때 자동 sync.

**기타 채널 토큰** (Slack pat/mat, Gmail, …):
- 호스트 `.env` 에서 호스트 프로세스만 읽음. 컨테이너 mount 에서 `.env` 는 entrypoint 의 `mount --bind /dev/null` 로 가려짐.
- 어떤 토큰도 컨테이너 args 나 env 로 전달되지 않음.

**NOT Mounted:**
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Per-SDK credential injection (Claude keychain / Codex mount) │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls authenticated by injected token (Claude OAuth / Codex bearer) │
│  • Channel tokens (.env) never enter container                   │
└──────────────────────────────────────────────────────────────────┘
```
