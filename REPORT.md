# CodePair — Implementation Report

Version 0.5.0 · macOS arm64 · Node v22.21.1 · npm 10.9.4

Base report written at 0.2.0; §1 and §3 are kept current, and the addendum at the end
records each iteration (0.3.x: host console API, host principal, path policy; 0.4.0: join
lobby, kick/lock, Host console UI; 0.5.0: expiring invites, live token rotation, tunnel
status/QR).

This report states what was built, what was actually verified (and how), what
was not verified, and what remains. Nothing below is claimed as working on the
basis of UI existing; every "verified" item was exercised against real files,
real processes, or real browser clients.

---

## 1. Deliverables

| Deliverable | Status | Where |
| --- | --- | --- |
| Host daemon and CLI | Built, verified | `server/src/index.ts`, `server/src/config.ts` |
| Secure filesystem API | Built, verified | `server/src/security/pathGuard.ts`, `server/src/files/fileService.ts` |
| Real remote terminal | Built, verified | `server/src/terminal/terminalService.ts`, `shellEnv.ts` |
| Responsive React + TS IDE | Built, verified | `client/src/*` |
| Monaco integration | Built, verified | `client/src/lib/monaco.ts`, `components/EditorPane.tsx` |
| Yjs collaboration + presence | Built, verified | `server/src/documents/documentHub.ts`, `client/src/lib/docProvider.ts` |
| WebRTC signalling | Built, verified at signalling layer | `server/src/signaling/signalingHub.ts`, `client/src/lib/calls.ts` |
| WebRTC media (voice/video/screen) | Implemented, **not** verified end-to-end | `client/src/lib/calls.ts`, `components/CallDock.tsx` |
| LAN connectivity | Built, verified | `server/src/index.ts` (`--host 0.0.0.0`) |
| Public tunnel | Implemented, **not** verified | `server/src/tunnel.ts` |
| Session URL + dynamic QR | Built, verified | `components/Dialogs.tsx` (`ShareDialog`) |
| Loopback Host console API | Built, verified | `server/src/admin/adminApp.ts` |
| Host principal split (`host` vs. guest roles) | Built, verified | `server/src/security/principal.ts`, `server/src/server.ts` |
| Join lobby (queue, lock, kick, seat ceiling) | Built, verified | `server/src/lobby/*`, `client/src/components/LobbyScreen.tsx` |
| Host console UI (`/host`) | Built, verified | `client/src/host/*`, `client/host.html`, `server/src/admin/adminApp.ts` |
| Per-session path access policy | Built, verified | `server/src/security/accessPolicy.ts`, `glob.ts`, `files/policyFileService.ts` |
| Expiring / limited-use invite links | Built, verified | `server/src/invites/invites.ts`, `server/src/admin/adminApp.ts` |
| Live role-token rotation | Built, verified | `server/src/security/auth.ts`, `server/src/admin/adminApp.ts` |
| Tunnel status + QR in Host console | Built; status verified, no live tunnel placed | `server/src/tunnelStatus.ts`, `client/src/host/HostQr.tsx` |
| Automated tests | 206 server + 28 committed browser checks | `server/test/*`, `e2e/browser.mjs` |
| Installation / environment docs | Written | `CLAUDE.md` |
| This report | Written | `REPORT.md` |

---

## 2. Architecture as built

```
Host machine                                    Remote clients
┌──────────────────────────────────────┐        ┌──────────────────┐
│ Express + ws (server/)               │  HTTP  │ React app        │
│  /api/*      file system API         │◀──────▶│  FileTree        │
│  /ws/doc     Yjs sync per file       │   WS   │  Monaco + Yjs    │
│  /ws/terminal one PTY per tab        │◄──────▶│  xterm.js        │
│  /ws/signal  WebRTC signalling       │        │  CallDock        │
│  node-pty, PathGuard, DocumentHub    │        │  (desktop/mobile)│
└──────────────────────────────────────┘        └──────────────────┘
```

* **One process, no external services.** The daemon owns the HTTP server, the
  three WebSocket endpoints, the PTYs and the tunnel child process. There is no
  database: file contents on the Host are the source of truth.
* **One Yjs document per file**, created lazily on first connection, torn down
  after the last client leaves (15 s idle).
* **The token is the only credential**, generated per start with
  `crypto.randomBytes(32)`, compared in constant time, never placed in a URL
  query string (it rides in the WebSocket subprotocol instead).

Full detail lives in [CLAUDE.md](CLAUDE.md).

---

## 3. Tests executed

### Server suite — 206 tests, all passing

```
✓ test/admin.test.ts       (26)  loopback guards, token separation, root switch, route audit, rotation, tunnel
✓ test/api.test.ts         ( 9)  auth, CRUD, read-only enforcement, error codes
✓ test/capabilities.test.ts(24)  role gates, host principal refused on guest routes
✓ test/docSync.test.ts     ( 6)  convergence, awareness, offline sync, external edits, conflicts
✓ test/pathGuard.test.ts   (28)  traversal, symlinks, NUL bytes, absolutes, Windows forms
✓ test/policy.test.ts      (38)  matcher, floor, validation, choke point, live changes, 4403
✓ test/principal.test.ts   ( 9)  role matrix; owner never has session.admin
✓ test/session.test.ts     (21)  session lifecycle, switch/dispose, flush-to-old-root
✓ test/signaling.test.ts   ( 5)  room isolation, payload caps, rate limits
✓ test/terminal.test.ts    ( 4)  read-only / --no-terminal / unauthenticated rejection, real PTY
✓ test/twoLaptop.test.ts   ( 2)  same-region typing bursts, reconnect convergence
✓ test/lobby.test.ts       (19)  queue, timeout, cap, lock, kick, seat ceiling, SSE, flags
✓ test/invites.test.ts     (15)  TTL, use caps, fail-closed errors, rate limit, tracker cap/soft cap
```

Notable security assertions:

* Unauthenticated `/api/*` → 401; wrong token on any WS upgrade → 401.
* `../../etc/passwd`, encoded traversal, absolute paths, NUL bytes, symlink
  escapes → `PATH_ESCAPE` / `INVALID_PATH`, 400–403, with no server paths leaked.
* `--mode read-only` blocks every mutating route server-side, drops Yjs updates
  with a `denied` control message, and closes the terminal with 4403.
* `--no-terminal` closes `/ws/terminal` with 4403.
* Signalling relays only within the session's room; SDP capped at 100 kB,
  candidates at 4 kB, max 32 peers.

### Browser harness — 28 checks, all passing

`e2e/browser.mjs` drives two real Chrome contexts (plus a mobile-sized page)
with real keystrokes. Verified end to end:

| Check | Evidence |
| --- | --- |
| Session shell renders | project name, room id, connection state in DOM |
| Editor loads Host file | Monaco buffer equals the file on disk |
| Typing edits the document | keystrokes change the shared Yjs doc |
| Edit persisted to Host | file on disk contains the typed marker |
| Second client joins | presence avatar appears |
| Remote edit arrives | client A sees client B's text |
| Remote cursor + name tag | `yRemoteSelectionHead-*` decoration and CSS label render |
| Simultaneous typing | both clients converge, no characters lost |
| Terminal runs a real command | `node --version` → `v22.21.1` from the Host |
| Unauthenticated API rejected | 401 |
| Path traversal rejected | 403 `PATH_ESCAPE` |
| Host creates a one-use invite | 201 with a 144-bit id, role `editor`, `maxUses: 1` |
| Invite redeems into the lobby and is admitted | guest reaches the workspace; fragment is cleared |
| One redemption records one use | `usedCount = 1` under React StrictMode |
| Reused invite is refused | the invite error screen appears, not a second seat |
| Share dialog | QR code + session link present |
| Mobile layout (390×844) | no overflow, drawer collapsed, minimap disabled, no off-screen controls |
| Landscape (844×390) | no overflow, editor usable |
| Console / page errors | none while editing |

A separate temporary headless-Chrome pass (lobby enabled, not committed as a test) covered
the 0.4.0 flow: guest waiting room → Host console pending card over SSE → admit as editor →
guest enters the workspace → kick → removed screen → lock → next guest sees the locked
screen. 6/6 checks passed.

### Build and static checks

* `npm run typecheck` → 0 (server + client)
* `npm run build` → 0 (Vite client bundle + tsup server bundle)

### Mutation checks (0.3.2 access policy)

Each mutation was applied to a backed-up file, the suite run, the file restored, and the
SHA-256 compared before/after (all four restored byte-identically):

| Mutation | Red assertion |
| --- | --- |
| `dir/**` no longer covers `dir` itself (`glob.ts`) | `covers the directory itself with dir/**`; all three role tests list `.aws` |
| canonical-path stricter check removed (`accessPolicy.ts`) | `hides a visible-named symlink that points at a secret`; symlinked-ancestor mutation returns 201 instead of 403 |
| flush before install removed (`documentHub.ts`) | `flushes pending edits before a read-only rule applies`; both frame-queue tests fail their flush precondition |
| default-secret floor removed (`accessPolicy.ts`) | floor unit test, the `docs/**` integration test, and the four-surface probe: tree lists `.env`, search returns it, file read is 200, socket opens |

### Mutation checks (0.4.0 lobby)

| Mutation | Red assertion |
| --- | --- |
| seat ceiling removed (admission no longer intersects token caps) | `expected 200 to be 403` |
| kick close code changed `4429` → `4425` (`connections.ts`) | `doc is closed with 4429: expected 4425 to be 4429` |
| lobby shared across roots instead of rebuilt (`sessionManager.ts`) | `admissions belong to the old root: expected [ { …(4) } ] to deeply equal []` |

All three restored byte-identically (SHA-256 compared before/after).

### Mutation checks (0.5.0 invites and rotation)

Each mutation was applied to a backed-up file, the covering test was run, and the file was
restored; the SHA-256 of both files matched the backups after the run.

| Mutation | Red assertion |
| --- | --- |
| `maxUses` check removed (`invites.ts`) | `Expected the invite operation to fail.` — exhausted invite redeemed twice |
| revoked invite gets its own message (`invites.ts`) | `This invite was revoked.` did not equal the shared `INVITE_INVALID` message |
| `revokeForRole` call removed from rotation (`adminApp.ts`) | `expected 200 to be 404` — a pre-rotation invite still redeemed |
| eviction no longer skips blocked ids (`invites.ts`) | `expected +0 to be 10` — the blocked id was evicted |
| all-blocked overflow drops the new id (`invites.ts`) | `expected +0 to be 1` — fresh id was not tracked |

---

## 4. Real bugs found by testing, and how they were fixed

1. **`Invoking deltaDecorations recursively` under concurrent typing.**
   `y-monaco` renders remote selections by calling `editor.deltaDecorations()`
   synchronously inside awareness events; two clients typing at once re-enter
   Monaco and it throws. The binding is now text-only, and `EditorPane` renders
   remote selections itself, coalesced into one animation frame with tracked
   decoration ids.
2. **xterm dispose race under React StrictMode.** Disposing a terminal that had
   already been opened left a queued render callback that threw on the disposed
   core. `TerminalPanel` now defers `open()` by one frame and cancels it on
   cleanup.
3. **Signalling rate-limit ordering.** The per-peer rate limit ran before the
   join, closing every new peer with 4429. Moved after.
4. **`INVALID_PATH` mapped to the wrong status** (403 instead of 400).
5. **No external-change detection (missing feature).** A file edited outside
   CodePair while open was silently overwritten on the next debounced save.
   `DocumentHub` now polls each open file's inode/mtime/size: clean documents
   merge the outside edit into the shared doc and notify clients; documents with
   unsaved local edits keep their content, leave the Host copy alone, and warn —
   neither side is silently discarded.

**Post-report addendum (2026-11-05):** two-laptop stress tests added in
`server/test/twoLaptop.test.ts` (same-region typing bursts, mid-typing
disconnects, reconnects during the other's typing) — CRDT converges with no
duplicated or lost content; the transient "off by one line" symptom is CRDT
interleaving explained in the README. Call-panel maximize (half-screen cap),
per-tile fullscreen, featured full-width screen-share row, toast/pill overlap
and status-bar touch-target fixes shipped the same day.

---

## 5. Known limitations

**Not verified in this environment**

* **Public tunnel** (`--tunnel cloudflare|ngrok`): `cloudflared` is installed on this
  machine, and the Host console's detection/status path was exercised, but no live tunnel
  process or public URL was placed. The code still spawns the provider CLI, scrapes its
  HTTPS URL, and tears it down on exit; there is no auto-download or fetched-binary run.
* **WebRTC media**: voice/video/screen tracks and the peer mesh are implemented
  and the signalling relay is tested, but a real two-device media call was not
  placed. Cross-NAT calls additionally require TURN, which is not configured
  here (only Google STUN).
* **Windows**: the symlink checks and generated shell rc files assume POSIX
  shells. Treat Windows as unverified.

**Lobby (0.4.0)**

* Lobby state lives in memory for one session: requests do not survive a daemon restart,
  and a root switch intentionally starts with an empty queue.
* A connection id is a per-tab seat handle, not a credential: the bearer token is always
  required first, the seat only narrows it, and an owner-marked id is refused to guests.
  Guessing another admitted guest's id would inherit that seat's narrowed capabilities.
* The guest lobby screens and `/host` console were exercised through DOM assertions in
  headless Chrome; there was no human visual/typography review, and no multi-device or LAN
  run of the lobby.

**Invites, token rotation and tunnel status (0.5.0)**

* Invites and rotated token state are in memory for one session; a daemon restart loses
  pending invites and replaces every token (the client drops a 401 and asks again).
* Rotation intentionally does not close sockets that are already open; only the next HTTP
  request or WebSocket upgrade must present the new token.
* Tunnel status is a read-only snapshot. There is no start/stop tunnel control in the Host
  console, and no auto-download of `cloudflared`; the operator starts the daemon with
  `--tunnel` as before.
* A live public tunnel and QR were not exercised because no tunnel URL existed; the QR
  renderer is the same tested `qrcode` path used by the guest Share dialog.

**Access policy — deliberate limits (0.3.2)**

* A hidden file is hidden from the app, not from a shell: terminal clients run as the Host
  user. `--no-terminal` and read-only sessions are the only way to remove that path.
* Canonical-path checks are best effort and check-then-act (TOCTOU), consistent with
  `PathGuard`; a path swapped between check and use is outside the guarantee.
* Hard links are indistinguishable from ordinary files, so they are not detected.
* The client's `4403` handling (close the tab, one toast per path, re-arm on reopen) is
  covered by unit/server tests and code review only — the browser harness has no
  admin-driven mid-session hide scenario.

**Platform realities**

* **Java / C / C++** get Monaco syntax highlighting only — no language server,
  so no diagnostics or autocomplete. TypeScript/JavaScript, JSON, CSS and HTML
  get the full bundled Monaco workers (autocomplete + diagnostics).
* **Java (`javac`) is not installed** on this machine, so the documented
  `javac Main.java` workflow could not be exercised end to end. The terminal is
  a real PTY, so it will work wherever a JDK exists.

**Security posture — read before sharing a link**

* The terminal is **not** an OS sandbox. The environment is scrubbed and `cd` is
  restricted to the project root, but an authenticated client still holds the
  Host user's privileges: absolute paths, `python -c` and `$(...)` all work. The
  real boundary is "authenticated = trusted operator". For stronger isolation,
  run the daemon as an unprivileged user in a container with only the project
  mounted, or use `--mode read-only`.
* Holding the token equals permission to edit the project and (unless
  `--no-terminal`) to run commands as your user.
* A TOCTOU window between the realpath check and the file operation is not
  fully eliminated.
* The daemon is plain HTTP by default; put it behind a tunnel's HTTPS or a
  reverse proxy for public use.

---

## 6. Remaining work

1. **Verify a real WebRTC call** between two physical devices on a LAN, and
   configure TURN for cross-NAT use.
2. **Verify a public tunnel** end to end once `cloudflared` or `ngrok` is
   installed and authenticated.
3. **Conflict resolution UI.** Today a colliding external edit keeps the local
   version and warns; there is no three-way merge view or "reload from disk"
   action.
4. **File-tree auto-refresh.** The tree refreshes on demand and on mutation;
   watching the whole tree for external changes is not implemented (only open
   documents are watched).
5. **Language servers for Java/C/C++** (e.g. via a generic LSP client) if those
   languages matter to you.
6. **Windows support**, principally path canonicalisation and shell detection.
7. **Host console UI — delivered in 0.4.0.** `/host` now drives the admin API (live lobby
   over SSE, admit/deny, kick, lock, project switch, policy editor). Still missing: a
   preset/per-role policy editor (item 8).
8. **Policy editor / presets.** Rules are set via `--rule` or the admin API; `/host` can
   edit the live list, but there are no saved presets or per-role rule sets yet.
9. **Sandboxed terminal** (see §8.2) — the one change that would make hidden paths hidden
   from shells too.

---

## 7. How to reproduce the verification

```bash
npm install
npm run typecheck      # 0
npm test               # 206 passing
npm run build          # 0

# Terminal 1 — Host daemon
npm run dev -w server -- --root /path/to/project --no-lobby   # browser.mjs assumes open joins
# Terminal 2 — UI
npm run dev -w client            # http://localhost:5180

# Terminal 3 — browser harness (needs Chrome + puppeteer-core)
cd e2e && npm install
CODE_PAIR_URL='http://localhost:5180/room/<id>#token=<token>' \
CODE_PAIR_PROJECT=/path/to/project \
CODE_PAIR_FILE='README.md' \
CODE_PAIR_TOKEN='<token>' \
node browser.mjs                 # 28 checks
```

---

## 8. Roadmap — taking CodePair live (plan only, nothing implemented yet)

Note added 2026-11-05. This section is a written plan, not a report of shipped
work. The milestone order can be re-cut later.

### 8.1 Access from anywhere (WAN), not just the same network

**Current state:** the daemon binds a port (LAN or loopback). `--tunnel
cloudflare|ngrok` exists but shells out to a CLI we don't install, is ephemeral,
and effectively demands read-only mode because a public URL exposes the token.

**Plan (in order of preference):**

1. **Managed tunnel, polished.** Auto-detect or auto-download `cloudflared`, run
   it as a managed child process instead of requiring a manual install, surface
   the HTTPS URL + QR on the host console, tear down on daemon exit. Keep the
   token in the URL fragment only; add a "rotate token" action that re-keys the
   daemon without dropping clients (server holds valid old + new during
   rotation). Cheapest credible "works from a café" path.
2. **Self-hosted relay (`relayd`).** A small Node service on a VPS: the host
   daemon connects *out* to `wss://relay/<roomId>` (no port forwarding,
   survives NAT/firewalls); remote clients connect to the same relay and get
   piped per-room to the origin host. The relay stays a dumb encrypted pipe:
   the token check and all file/terminal/doc logic stay on the host, so the
   relay never holds credentials. This is the first-class "works from anywhere"
   feature we own end to end.
3. **WebRTC data channels** as a bonus path (files/terminal/docs over P2P once
   both sides have a rendezvous + STUN/TURN), with the relay as fallback when
   P2P is blocked. Do last — highest complexity, needs congestion/reliability
   tuning.
4. **TURN for calls.** Cross-NAT calls need TURN (README documents the env
   var). Operate a `coturn` next to the relay (or use a managed service) and
   inject it by default whenever the relay is active.

**Milestone check:** a remote joins with no port forwarding and valid TLS; the
token can be rotated live; TURN credentials never reach the client UI.

### 8.2 Sandboxed / safeguarded terminal

**Current state:** terminal is a real `node-pty` shell as the host user with a
scrubbed env and generated rc files. Deliberately *not* a security boundary —
anyone with the token can do anything the host user can (§5 "Security posture").

**Plan (containment, not command filtering):**

1. **Container-per-session (target).** When a terminal tab opens, the daemon
   spins a container (Docker/Podman; Apple container on macOS) with `--root`
   bind-mounted read-write at a fixed path (e.g. `/ws`), no network
   (`--network none` or a per-profile allowlist), a non-root user mapped to the
   host UID for file ownership, CPU/memory caps (cgroups or `--ulimit`), no
   privilege escalation, and a fresh HOME so host history never leaks. New
   flag: `--terminal-sandbox docker|podman|off` with runtime auto-detect and
   `off` as the default whenever no runtime is present. The stream plumbing is
   unchanged — the PTY inside the container simply replaces the host PTY, and
   the same sandbox serves long-running commands (`npm run dev` inside `/ws`).
2. **OS-sandbox fallback (no container runtime).** Linux: `bubblewrap`/
   `nsjail` namespaces + seccomp (user namespaces mean no root needed). macOS:
   a `sandbox-exec` seatbelt profile `(deny default)` + `allow file-write*`
   scoped to the root as a stopgap (deprecated but functional).
3. **Policy layer independent of backend:** idle-shell timeout, workspace-only
   HOME, deny `sudo`/mount escapes by construction, per-session scrollback log
   the host console can page through, a "kill shell" button in the host UI,
   per-session resource caps.
4. **Failure philosophy:** with no sandbox backend the terminal stays off by
   default; enabling an unsafe shell requires an explicit one-time host
   consent, and read-only invite links always carry `terminal: off`.

**Milestone check:** a remote can `rm -rf /` (or `curl` out, or write outside
`/ws`) in the session and the only casualty is the container.

### 8.3 Rooms like Google Meet

**Current state:** one room per daemon launch; the call is a P2P mesh with
signalling relayed by the host; no lobby, no moderation, no chat.

**Plan:**

1. **Server-side room registry** in the daemon (rooms outlive the current
   single-room model): roomId → participants (presence, roles
   host/presenter/guest), join/leave events, live roster delivered by the
   signalling hub.
2. **Lobby & admission:** host approves joins from a waiting screen; a locked
   room blocks new joins; media permission is requested via the lobby rather
   than auto-granted.
3. **Moderator controls (host):** mute anyone (server-enforced track disable
   via signalling), spotlight/pin a participant, lock the room, end the call
   for everyone, kick, and host-transfer on exit.
4. **In-call surfaces:** participant drawer (roles + device states), pinned
   speaker view (dominant-audio detection is already feasible client-side),
   hand raise, ephemeral emoji reactions (awareness messages), call chat
   (signalling-relayed, not persisted).
5. **Scale path:** keep the mesh to ~6 participants; consider an SFU (or a
   self-hosted one like LiveKit) only when actual user counts demand it.

**Milestone check:** a two-device call covers Meet's core loop: lobby → admit →
grid → spotlight/mute/kick → host transfer → lock.

### 8.4 Separate host and joiner UI

**Current state:** one SPA, identical for host and remote guests.

**Plan:**

1. **Role-aware session claims.** The host console link (`/host#…`) and the
   invite link (`/room/<id>#…`) carry different capability tokens; the server
   already distinguishes host and guests internally — surface that.
2. **Host console (`/host`):** project picker, mode/terminal/sandbox toggles
   (calls into §8.2), connection roster (who is in and from where), terminal
   audit view, room lock/kick, live token rotation, and per-session stats.
   Backed by an admin API guarded by a root-derived admin token — never the
   guest token.
3. **Joiner UI (`/room/<id>`):** today's app minus host-only affordances, plus
   mode-specific panels from §8.5.
4. **Single SPA, gated components:** the layout branches on
   `role = 'host' | 'guest'` from `/api/session`; we do not fork a second app.
   Every host-only call is verified server-side by token grade, so UI gating
   is cosmetic.

**Milestone check:** a guest poking at `/host` gets nothing (no admin API,
wrong token type); the host sees who is connected without opening a second
browser tab.

### 8.5 Work modules (use-case profiles with their own UI/UX)

**Idea:** CodePair becomes a shell around interchangeable *profiles*. A profile
is a server-enforced permissions matrix plus a UI layout; the client only
renders what the server allows.

| Profile | Audience | Server posture | UI shape |
| --- | --- | --- | --- |
| **Pair coding** (current) | 2–3 trusted people | read-write, terminal on | editor + terminal + call |
| **Remote work** | owner's other machines / clean setups | read-write for the host role only, screen-share-centric | workspace dock layout, host desktop screen share (`getDisplayMedia` on the host), terminal gated to the host role |
| **Interview** | interviewer + candidate | candidate read-only in a seeded folder, no terminal (or §8.2-sandboxed only), no deletion | low-chrome editor, interview timer, question/notes pane, interviewer side panel, call dock visible |
| **System sharing / presentation** | viewer-only audiences | no filesystem at all, no terminal | full-bleed screen-share grid + chat — a kiosk that ignores the IDE furniture |
| **Teaching / class** | 1 teacher, N students | per-guest read-only or a personal scratch directory each | roster + moderator controls, spotlight, "follow the teacher" view-sync |

**Implementation shape:**

1. **Profile registry on the server:** `profiles.ts` exporting
   `{ id, permissions: { files: 'rw' | 'ro' | 'none', terminal, download,
   call, chat } , defaults }`, attached at session (later per-room) creation
   via `--profile interview`. The existing `--mode` / `--no-terminal` flags
   fold into this matrix, and `/api/session` ships the effective permissions
   so the UI can trim itself.
2. **Mode-aware client:** a `ProfileProvider` picks the layout and lazy-loads
   the module's feature strips (interview clock, kiosk grid, roster) so the
   pair-coding bundle doesn't grow.
3. **Per-room profiles (phase 2)** once §8.3's room registry exists — one
   daemon hosts several rooms with different postures at once.
4. **Authoritative server:** all mode enforcement stays server-side (path
   guard flags, terminal gating, call scope); the UI is cosmetic only.

### 8.6 Suggested build order

1. **§8.1 tunnel polish + §8.2 container sandbox** — "can I bring a stranger in
   safely from anywhere" gates everything else.
2. **§8.4 host/joiner split** — Meet-style moderation UI (§8.3) needs the host
   console to live in.
3. **§8.3 Meet-style rooms** — registry, lobby, moderation, chat.
4. **§8.5 profiles** — interview mode first (tightest real use-case), then
   system-sharing kiosk, then teaching.
5. **§8.1 deep track (self-hosted relay, P2P data channels, TURN)** —
   continuous work, sized against how much the managed tunnel gets used.

**Open question to settle early:** which sandbox runtime is acceptable on the
macOS host (Docker Desktop presence vs Apple container vs seatbelt/bubblewrap
fallback) — that decision decides how much of §8.2 lands in phase 1 vs phase 2.

---

## 9. Addendum — iterations 0.3.1 and 0.3.2 (2026-11-09)

### 0.3.1 — per-session root + loopback admin API

* `Session`/`SessionManager` split: the daemon owns a *current* session (root, files, hub,
  PTYs, signalling), not a set of module globals. Root switches build the new session
  first, swap atomically, then dispose the old one — dirty documents flush to their **old**
  absolute paths, PTYs die, document/terminal sockets close `4410`, signalling stays up.
* A second, loopback-only `http.Server` on `--admin-port` with its own token, Host-header /
  Origin / forwarding-header guards, `no-store` responses, and routes that do not exist on
  the guest listener: `GET /admin/api/state`, `GET /admin/api/fs/list`,
  `POST /admin/api/session/root`.
* Root validation refuses the filesystem root, the home directory and its parents,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`; system directories need `confirmBroad`.

### 0.3.2 — host principal + path access policy

* **Principal split.** `host` is the admin listener's role and holds `session.admin`
  only; `owner` keeps every guest capability and never administers. Guest tokens are 401 on
  the admin listener; the admin token is 401 on the guest listener and cannot open a file.
* **Policy.** Per-session rules (`hidden`/`r`/`rw`, glob) enforced at one choke point
  (`AccessFileService`) for tree, search, read, create/rename/delete and the `/ws/doc`
  upgrade; built-in secret defaults are a floor until an explicit `confirmUnhide` on that
  PUT (or `--confirm-unhide`), and confirmation resets on the next unconfirmed PUT and on
  `switchRoot`.
* **Live changes.** `applyPolicy` gates frames, flushes every open document, installs the
  rules, enforces them (`4403` for hidden, revoke write for `r`), releases the gate and
  replays held frames in order: unaffected edits still land, forbidden ones are answered
  `denied` and never reach disk.
* **Verified.** 164/164 server tests, typecheck 0, build 0, 24/24 browser checks, plus the
  four mutation checks in §3. No new dependencies; Yjs merge/sync/poll, WebRTC, CSS,
  tunnel and the 0.3.1 admin-listener guards were not touched.

### 0.4.0 — join lobby, kick/lock, Host console UI

* **Join lobby.** `POST /api/lobby/join` / `GET /api/lobby/status` queue a per-tab
  connection id; every other guest `/api/*` route now needs an admitted seat. The doc,
  terminal and signal upgrades admit at upgrade time and refuse by completing the upgrade
  and closing `4425`; kick closes live sockets `4429`. Pending entries cap at 50
  (`429 LOBBY_FULL`) and expire after `--lobby-timeout` (default 120 s).
* **Seats.** Effective capabilities are the intersection of token and granted seat
  (`seatPrincipal`); a viewer token cannot be admitted as editor (`ROLE_CEILING`), and an
  editor admitted as viewer loses writes. The owner token bypasses lobby and lock; its
  connection id is refused to guests.
* **Host console UI.** A second Vite entry (`client/host.html`) served only by the
  loopback listener at `/host`; the admin token arrives in the `#admin=` fragment and lives
  in that tab's `sessionStorage`. It renders the queue from
  `GET /admin/api/events` (SSE with `?token=`, the only query-token route), and calls
  admit/deny/lock/kick/policy/root-switch.
* **Session lifecycle.** The lobby is per session and rebuilt on `switchRoot`; a
  daemon-level `ConnectionRegistry` keeps kick effective after a switch.
* **Flags.** `--no-lobby` (immediate admission; lobby actions `409 LOBBY_DISABLED`) and
  `--lobby-timeout <seconds>` (1–3600, default 120).
* **Verified.** 183/183 server tests (12 files, 19 new lobby tests), typecheck 0, build 0,
  24/24 committed browser checks with `--no-lobby`, 6/6 lobby/host-console browser checks
  (temporary script), and the three mutation checks above. No new dependencies; PathGuard,
  0.3.2 policy logic, Yjs internals, WebRTC payloads, 0.3.x admin guards and `tunnel.ts`
  were not touched.

### 0.5.0 — expiring invites, live rotation, tunnel status (2026-11-10)

* **Invites.** Per-session `InviteStore` with 144-bit URL-safe ids, optional TTL (1–10080
  minutes), optional use cap (1–1000), a 50-live-invite cap (`429 INVITE_LIMIT`), revocation,
  and `usedCount` incremented only on success. `POST /api/invites/:id/redeem` exchanges an id
  for the role's current token; the guest still passes the lobby. Unknown, expired,
  exhausted and revoked invites all return the same `404 INVITE_INVALID` body.
* **Redeem hardening.** Ten failures against one id in a rolling 60 s window block it for
  60 s (`429 INVITE_RATE_LIMITED`). The failure tracker holds up to 256 ids and evicts only
  unblocked entries. When every tracked id is blocked, the cap is soft: I chose **(a) a new
  id is still tracked and its failures count**, temporarily reaching 257, because silently
  dropping fresh guesses would create an unrate-limited window (the one outcome the review
  explicitly rejected). The client also caches a successful redemption per tab, so React
  StrictMode's double effect cannot spend a one-use invite twice.
* **Rotation.** `POST /admin/api/tokens/:role/rotate` returns the new token once, invalidates
  the old token for HTTP and WebSocket upgrades, and explicitly calls
  `revokeForRole(role)` for editor/viewer so pending invites die with the old token.
  Existing open sockets continue. The console's confirmation text is: “Rotating the editor
  token invalidates the old token for new connections. This will also revoke 1 pending
  invite(s) for this role. Existing connections keep working.”
* **Tunnel status.** The Host console shows `configured`, `provider`, `running`,
  `publicUrl`, `cloudflaredInstalled` and installation instructions, and renders the public
  URL's QR when one exists. Detection is filesystem-only; there is no download, subprocess,
  auto-install, or start-tunnel control. Live invites use the server-provided guest origin,
  not the admin origin.
* **Host console layout pass.** The fixed 100dvh console with a nested 42vh tools strip was
  replaced by a page-level scrolling control room: a sticky status bar, room activity
  first, a wide invite composer, and a stacked role-token/tunnel rail. The invite form now
  labels expiry and use limit explicitly, revoking or rotating clears a stale shown link,
  `HostQr` has intrinsic dimensions, and reduced-motion/mobile focus states are included.
  Measured at 1440, 1000 and 390 px with no horizontal overflow; the 5-minute, 1-use invite
  was created through the new form.
* **Deliberate deviations.** `InviteStore.list()` keeps exhausted invites visible (but not
  revoked/expired ones) so the Host can observe the final `usedCount`; the live-invite cap
  still counts only redeemable invites. Version bumped to 0.5.0 in the root/server/client
  manifests and lockfile.
* **Verified.** 206/206 server tests in 13 files (183 baseline + 23), typecheck 0, build 0,
  28/28 committed browser checks including one-use redeem under StrictMode (`usedCount = 1`)
  and reuse refusal, and the five mutation checks above. The committed browser suite predates
  the Host-only layout pass and covers the guest app; the rebuilt Host console was checked
  manually at 1440/1000/390 px with no horizontal overflow. Manual Host-console exercise:
  created a 5-minute, one-use editor invite, captured the count-bearing rotation confirmation,
  rotated editor (old token 401 for a new request, new token 200, invites list empty, the
  already-admitted editor tab still reported Ready), and read the not-configured tunnel
  status with `cloudflared` detected as installed. No new server dependencies. PathGuard,
  FileService policy, Yjs sync internals, WebRTC/signalling payloads, lobby admission/kick/
  lock semantics, 0.3.x admin-listener guards, and `tunnel.ts` spawn/scrape were unchanged.
