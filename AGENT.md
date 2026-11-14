# CodePair

A hybrid **local-host collaborative IDE**. One machine (the **Host**) runs a small
daemon that exposes one or more real project directories and a real terminal to a
browser UI. Other people (**Remote Clients**) open a URL, authenticate with a session
token, and edit the Host's actual files, watch terminals run on the Host machine, and
talk over WebRTC.

Nothing is simulated: files are read and written on the Host's disk, the terminal
is a `node-pty` shell process, collaboration is a real Yjs CRDT over authenticated
WebSockets, and calls use the browser's native `RTCPeerConnection`.

Current release: **v0.8.0** (tag `v0.8.0`) adds coturn-compatible time-limited TURN
credentials; the existing STUN/static `--ice-servers` configuration is unchanged.

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

## Repository layout

| Path | Purpose |
| --- | --- |
| `server/src/index.ts` | CLI entry point, tunnel lifecycle, signals (banner lives in `banner.ts`) |
| `server/src/banner.ts` | `buildBanner()`: startup banner, terminal-bypass warning, LAN/tunnel links |
| `server/src/config.ts` | Flag/env parsing, token and room-id generation, ICE/TURN config, eager TURN validation |
| `server/src/server.ts` | Express app, all HTTP routes, WebSocket upgrade routing |
| `server/src/security/auth.ts` | Constant-time token compare, bearer header, WS subprotocol, origin check |
| `server/src/security/pathGuard.ts` | Lexical **and** realpath containment for every path |
| `server/src/security/glob.ts` | Compiled, iterative glob matcher for access rules |
| `server/src/security/accessPolicy.ts` | Rules, validation, default-secret floor, `resolve`/`effective`, `AccessView` |
| `server/src/security/principal.ts` | Roles → capabilities; `host` is the only `session.admin` holder |
| `server/src/files/fileService.ts` | Tree, read, search, create, rename, delete, ignored names |
| `server/src/files/policyFileService.ts` | The single policy choke point: tree/search/read/mutate/`documentAccess`, `canonicalTarget` |
| `server/src/session/session.ts` | One root: files, policy, document hub, terminal, lobby, invites, `access(principal)`; signalling lives on the room |
| `server/src/session/sessionManager.ts` | Root-switch close codes/types and the single-session lifecycle reused by the registry |
| `server/src/rooms/roomRegistry.ts` | Default + additional rooms, each with its own session, tokens, lobby and signalling; serialized create/switch/delete and unique canonical roots |
| `server/src/lobby/lobby.ts` | Waiting room: queue, timeout, 50-pending cap, lock, kick, seat roles |
| `server/src/lobby/connections.ts` | Room-scoped connection-id claims and live sockets, so one kick/delete reaches every surface without cross-room leakage |
| `server/src/lobby/principal.ts` | Seat ∩ token capability intersection |
| `server/src/invites/invites.ts` | Per-session expiring/limited-use invites, fail-closed redeem, rate limiting, soft failure-tracker cap |
| `server/src/tunnelStatus.ts` | Tunnel status snapshot and provider-CLI detection; no downloads or subprocesses |
| `server/src/admin/adminApp.ts` | Loopback Host console: `/host` page, default + room-scoped routes, SSE, lobby/kick, state, folder list, root switch, policy, invites, token rotation, moderator grants, tunnel status |
| `server/src/documents/documentHub.ts` | One Yjs doc per file, sync protocol, presence, debounced persistence |
| `server/src/terminal/terminalService.ts` | PTY sessions, input/resize handling, shutdown; candidate branch is sandbox-only |
| `server/src/terminal/interviewSandbox.ts` | Injectable Docker probe, fixed sandbox invocation and candidate-folder normalization |
| `server/src/interview/interviewStore.ts` | Candidate consent map, bounded integrity event ring and replay payload |
| `server/src/terminal/shellEnv.ts` | Minimal scrubbed environment + generated rc files |
| `server/src/signaling/signalingHub.ts` | Room-scoped offer/answer/candidate relay plus live-socket moderator grants, mute requests, spotlight, hand raise and call-only removal |
| `server/src/webrtc/turnCredentials.ts` | coturn REST credential minting: `<expiry>:<label>` + base64 HMAC-SHA1, random per call |
| `server/src/tunnel.ts` | `cloudflared` / `ngrok` child process, URL discovery, teardown |
| `client/src/App.tsx` | Session lifecycle, layout, tabs, tree state, shortcuts |
| `client/src/lib/docProvider.ts` | Authenticated Yjs provider (sync + awareness + save) |
| `client/src/lib/connection.ts` | Per-tab connection id (`sessionStorage`) and rotation |
| `client/src/components/LobbyScreen.tsx` | Waiting / denied / expired / removed / locked / full screens |
| `client/src/components/ConsentScreen.tsx` | Candidate consent gate before any lobby request; neutral decline path |
| `client/src/lib/integrity.ts` | Candidate client-reported integrity batches; no content or pixels |
| `client/src/host/*`, `client/host.html` | Host console UI: separate Vite entry, responsive page-level control room served only by the admin listener |
| `client/src/lib/calls.ts` | Peer mesh, media state, screen share, moderation actions and "muted by host" handling |
| `client/src/components/*` | IDE chrome: TopBar, FileTree, EditorPane, TerminalPanel, CallDock, dialogs |
| `server/test/*` | 236 Vitest tests: sandboxing, policy, API, admin, capabilities, lobby, invites, rooms, doc sync, terminal, signalling, interview safety and TURN credentials |
| `REPORT.md` | Final implementation report: verified features, tests, limitations, remaining work |
| `e2e/browser.mjs` | Two-client headless-Chrome test of the real UI |

## Running it

```bash
npm install                 # workspaces: server + client (builds node-pty)

# Development: Vite for the UI, tsx for the daemon
npm run dev -w server -- --root ~/code/project --host 0.0.0.0
npm run dev -w client                     # http://localhost:5180

# Or both at once (server link already points at the Vite origin)
npm run dev

# Production: build the UI into client/dist, then serve it from the daemon
npm run build
npm start -- --root ~/code/project --host 0.0.0.0
```

The daemon prints a link containing the access token. Opening that link stores the
token in `sessionStorage`; the URL fragment is cleared immediately and the token
never travels in query strings, Referer headers or access logs.

### CLI flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--root <dir>` | cwd | Directory exposed by this session |
| `--host <host>` | `127.0.0.1` | `0.0.0.0` for LAN access |
| `--port <port>` | `7420` | Guest listener (tunnel target) |
| `--admin-port <port>` | `port + 1` | Loopback-only Host console; bound to `127.0.0.1` regardless of `--host` |
| `--mode <mode>` | `read-write` | `read-only` disables writes **and** the terminal server-side |
| `--token <token>` | random per start | Primary token: **owner** (or **viewer** with `--mode read-only`). 16–512 bytes, URL-safe |
| `--editor-token <token>` | — | Extra token with editor access |
| `--viewer-token <token>` | — | Extra token with view-only access |
| `--no-lobby` | lobby on | Admit every authenticated guest immediately; lobby actions return `409 LOBBY_DISABLED` |
| `--lobby-timeout <seconds>` | `120` | Pending request lifetime, 1–3600 |
| `--no-terminal` | terminal on | Explicit Host opt-out of remote shells |
| `--interview-sandbox` | off | Docker-only candidate terminal; no host fallback |
| `--interview-sandbox-image` | `node:22-bookworm-slim` | Inspected locally, never pulled |
| `--rule <glob>=<hidden\|r\|rw>` | — | Path rule, repeatable up to 50, validated at startup |
| `--confirm-unhide` | off | Required when a `--rule` lifts a built-in secret default |
| `--tunnel <provider>` | off | `cloudflare` or `ngrok` |
| `--ice-servers <json>` | Google STUN | JSON `RTCIceServer[]`, max 8 entries |
| `--turn-secret <secret>` | — | coturn `static-auth-secret`; prefer env. Requires `--turn-urls` |
| `--turn-urls <url,url>` | — | `turn:`/`turns:` URLs for fresh per-session credentials |
| `--turn-credential-ttl <seconds>` | `3600` | Minted credential lifetime, 1–86400 |
| `--allow-origin <origin>` | — | Extra origin allowed to open WebSockets |
| `--dev-client <url>` | — | Vite origin used in the printed link and origin check |
| `--quiet` | off | Less startup output |

Environment equivalents: `CODE_PAIR_MODE`, `CODE_PAIR_TOKEN`, `CODE_PAIR_PORT`, `CODE_PAIR_ADMIN_PORT`,
`CODE_PAIR_HOST`, `CODE_PAIR_ALLOW_ORIGINS`, `CODE_PAIR_DEV_CLIENT`,
`CODE_PAIR_TERMINAL=off`, `CODE_PAIR_TUNNEL`, `CODE_PAIR_ICE_SERVERS`,
`CODE_PAIR_TURN_SECRET`, `CODE_PAIR_TURN_URLS`, `CODE_PAIR_TURN_CREDENTIAL_TTL`,
`CODE_PAIR_MAX_FILE_BYTES`, `CODE_PAIR_SAVE_DEBOUNCE_MS`, `CODE_PAIR_IGNORE`,
`CODE_PAIR_INTERVIEW_SANDBOX_IMAGE`, `CODE_PAIR_CLIENT_DIST`.

## Authentication model

* The token is `crypto.randomBytes(32).toString('base64url')` — 256 bits of entropy,
  regenerated on every start unless `--token` is supplied. It dies with the process.
* HTTP: `Authorization: Bearer <token>` on every `/api/*` route except `/api/health`.
  Comparison hashes both sides with SHA-256 and uses `timingSafeEqual`.
* WebSockets: browsers cannot set headers, so the client offers subprotocols
  `["codepair", token]` and the server always selects `codepair`. The token never
  appears in the URL, so it cannot leak into logs or `Referer`.
* Origin checks run on every upgrade (`isOriginAllowed`): the request `Origin` host
  must match the `Host` header or an explicitly allowed origin. Non-browser clients
  may omit `Origin` and still need a valid token.
* **Rooms and tokens.** Each room owns a `TokenStore`. `X-CodePair-Room` on HTTP and
  `?room=` on WebSockets only select it; the bearer token is always validated against that
  room. A missing selector means the default room, and a connection id claimed by one room
  is `403 ROOM_MISMATCH` in another.
* `read-only` mode is enforced on the server (`requireWrite`, terminal handshake
  rejection, read-only doc connections refuse Yjs updates) — not by hiding buttons.
* **Roles vs. the admin listener.** Guest roles are `owner`, `editor`, `viewer` and the
  additive `candidate` role (interview rooms only); since 0.3.2 the owner no longer carries
  `session.admin`. The admin listener's single grant is
  the `host` role (`session.admin` only), so a guest token can never administer the
  session and the admin token can never read a file.
* **Host console:** a second `http.Server` on `127.0.0.1:<admin-port>`, with a fresh token
  printed once in the `#admin=` fragment. Requests must carry that bearer token, a
  loopback `Host` header, no cross-origin `Origin` and no forwarding headers; responses are
  `no-store`. None of its routes exist on the guest listener; `/host` is served only there.
* **SSE exception:** `GET /admin/api/events` also accepts `?token=`, because `EventSource`
  cannot set headers. It is per-route middleware; every other admin route reads only
  `Authorization`, and the admin token still cannot touch the guest port.
* **Invites and rotation.** `POST /api/invites/:id/redeem` is the one unauthenticated guest
  API route: it exchanges a 144-bit invite id for the role's current token, then the guest
  still enters the lobby. Invites expire, have a use cap, and share one byte-identical
  `404 INVITE_INVALID` for unknown/expired/exhausted/revoked. The Host console can rotate
  `owner`, `editor`, `viewer` or `candidate`; the old token fails new HTTP and WebSocket connections,
  that role's live invites are revoked, and existing sockets stay connected.

## Join lobby

One `Lobby` per room (`server/src/lobby/lobby.ts`), reset by that room's `switchRoot`.

* **Admission.** `POST /api/lobby/join` queues a connection id (client-generated per tab,
  16–64 chars) with a display name and the token's role. `GET /api/lobby/status` is the
  read-only poll; both are reachable while waiting. Every other guest `/api/*` route
  requires an admitted seat. The owner token bypasses the lobby and the lock entirely.
* **Realtime.** The doc, terminal and signal upgrades check the seat before upgrading. A
  refusal completes the upgrade and closes with `4425` and a reason; kick closes live
  sockets with `4429`.
* **Seat ceiling.** The Host grants `editor`, `viewer` or (for an interview room)
  `candidate`; effective capabilities are `seatPrincipal(token, seat)`, an intersection. A
  viewer token cannot be admitted as an editor and a candidate token can only be seated as
  candidate (`403 ROLE_CEILING`); an editor admitted as viewer keeps `fs.read` but loses
  writes.
* **States.** `waiting` expires after `--lobby-timeout` (default 120 s) and may retry;
  `denied` and `removed` are terminal per connection id; `locked` refuses new joins but
  leaves admitted tabs alone. The 51st pending request is refused (`429 LOBBY_FULL`).
* **Owner id.** An admitted connection id marked `owner` is refused to guests, so a guest
  can never borrow the Host tab's seat. A connection id authenticates nothing on its own:
  the bearer token is always checked first, and seat capabilities only narrow it.
* **`--no-lobby`.** Joins are admitted immediately, no id is required on any surface, and
  lobby actions throw `409 LOBBY_DISABLED`.

## Invites and token rotation

`InviteStore` (`server/src/invites/invites.ts`) is per room, so a room root switch starts
with no invites. An invite holds only `{ id, role, expiresAt, maxUses, usedCount }` — never
a token value. The token is looked up when the link is redeemed, and the new token still
has to pass the lobby.

* **Minting.** `POST /admin/api/invites` accepts `editor`/`viewer`/`candidate`, an optional TTL
  (1–10080 minutes) and an optional use cap (1–1000). Owner cannot be invited, and a role
  with no configured token is refused (`409 ROLE_NOT_CONFIGURED`). At most 50 live invites
  exist at once (`429 INVITE_LIMIT`).
* **Redeeming.** `POST /api/invites/:id/redeem` is unauthenticated by design and returns
  only `{ token, role }`. It increments `usedCount` on success. A session that redeems once
  under React StrictMode still records one use; the client keeps a per-tab in-flight cache
  keyed by invite id.
* **Fails closed.** Unknown, expired, exhausted and revoked invites all produce the same
  `404 INVITE_INVALID` body. Ten failures against one id in a rolling 60 s window block
  that id for 60 s (`429 INVITE_RATE_LIMITED`).
* **Tracker cap.** Up to 256 ids keep failure history. Eviction skips currently blocked
  ids; when every entry is blocked the cap is soft — a new id is still tracked and may
  briefly push the map to 257. Dropping a fresh guess would leave it unrate-limited, which
  is the worse failure mode.
* **Rotation.** `POST /admin/api/tokens/:role/rotate` installs a new token, explicitly
  calls `revokeForRole(role)` for non-owner roles, and returns the token once. The old token
  is 401 for new HTTP requests and WebSocket upgrades; sockets that are already open keep
  working.

## Interview profile

An interview room is an ordinary room with an additive `candidate` seat. Create it through
the room-scoped admin API (the `/host` UI still drives the default room):

```json
POST /admin/api/rooms
{ "path": "/path/to/project", "profile": "interview", "candidateDir": "solution" }
```

Creation seeds the candidate directory and installs room policy rules: `solution` and
`solution/**` are `rw`, `**` is `r` for every role in that room. The candidate directory is
realpath-checked; a symlink resolving outside the room is rejected (`400
INVALID_CANDIDATE_DIR`) because Docker resolves bind-mount sources on the Host. The room
returns a fourth, candidate token in addition to owner/editor/viewer.

`candidate` has exactly `fs.read`, `fs.write` and `call.join` — no `fs.delete` and no
`term.use`. The lobby ceiling allows a candidate token to be seated only as `candidate`;
an editor/viewer attempt is `403 ROLE_CEILING`.

### Consent and integrity data

`POST /api/lobby/join` requires `{ "consent": true }` for a candidate (`403
CONSENT_REQUIRED` otherwise). No lobby entry, document update, snapshot or integrity event
exists before acceptance, and declining starts nothing. The manifest lives in
`server/src/interview/interviewStore.ts` and is returned in the candidate `/api/session`
payload; the client renders that exact list before joining.

After admission, candidate updates are recorded with path, connection id and typed/paste
character counts; snapshots are content-bearing. Bounds: 2,000 events, 2,000 updates, 256
snapshots, 4 MB snapshot total, explicit truncation flags. `POST /api/integrity` is
authenticated, candidate-only, consent-gated, and accepts at most 100 events per batch.
`GET /admin/api/rooms/:roomId/replay` is admin-only and returns the data-only replay.
Integrity signals are client-reported; they are review evidence, never a tamper-proof
detector.

### Candidate terminal

`--interview-sandbox` enables the Docker probe at startup: `docker version`, then `docker
image inspect` for `--interview-sandbox-image` (default `node:22-bookworm-slim`). CodePair
never pulls, builds or installs. When available, the candidate branch spawns only
`docker run` with `--rm --interactive --tty --network none --cpus 1 --memory 512m
--pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --user 1000:1000
--workdir /workspace`, a `/tmp` tmpfs with `HOME=/tmp`, the project root mounted `:ro`, and
only `<root>/solution` mounted `:rw`.

If the probe fails, the candidate terminal closes with `4403` and a sandbox-specific reason;
no host PTY is spawned and there is no fallback. Non-candidate terminals keep the existing
host `term.use` path. The Docker-available path is covered with an injected spawn seam and
exact argv assertions; no image is pulled by the test suite.

## Filesystem sandboxing

`PathGuard.resolve()` applies two independent checks to every client-supplied path:

1. **Lexical** — rejects non-strings, NUL bytes, absolute paths, Windows drive
   prefixes, backslash separators and any `..` segment; then verifies
   `path.relative(root, resolved)` does not escape the canonical root.
2. **Physical** — resolves the realpath of the target (or its nearest existing
   ancestor, for creates) and requires it to stay inside the canonical root. This
   blocks symlink escapes that look lexically safe.

The project root is canonicalised once at start-up and can never be renamed or
deleted. `DEFAULT_IGNORED` hides `.git`, `node_modules`, `dist`, `.env*`, keys and
similar sensitive names from the tree and search. Server errors return codes such
as `PATH_ESCAPE` and `INVALID_PATH` without absolute server paths.

**Known residual risk:** a symlink swapped between the check and the file operation
(TOCTOU) is not fully eliminated. For a hard guarantee, run the daemon under a
dedicated user in a container; the app-level guard is a strong filter, not a kernel
boundary.

## Path access policy

`AccessFileService` (`server/src/files/policyFileService.ts`) is the **only** place guest
policy is decided. Every HTTP file route and the `/ws/doc` upgrade build one per request
from `session.access(principal)`; `FileService` stays policy-free and only accepts an
optional decider. It can add refusals on top of `PathGuard`, never remove one.

* **Resolution** — `AccessPolicy.resolve(requested, canonical)` is the stricter
  (`hidden < r < rw`) of the two paths. Each path: built-in default floor, then host rules
  (first match wins), then the default, then `rw`. `effective()` intersects with the
  principal's capabilities, so a rule narrows but never widens.
* **Matcher** (`glob.ts`) — case-insensitive, NFC-normalised, `/`-relative; `*` excludes
  `/` and matches a leading dot, `**` crosses `/`, `?` is one non-`/` char; a pattern
  without `/` matches the basename at any depth, one with `/` is anchored; `dir/**` also
  covers `dir`. Compiled once, iterative with a single backtrack point (hostile patterns
  stay linear-ish; a 4 kB path against `a*a*a*a*a*a*a*b` is asserted under 50 ms).
* **Floor** — the 19 built-in defaults (`DEFAULT_SECRET_RULES`) stay hidden under any host
  rule until that PUT confirms (`confirmUnhide: true`) or the daemon starts with
  `--confirm-unhide`. Confirmation is per PUT, echoed by GET/PUT, and resets on the next
  PUT that omits it and on every root switch. `rulesUnhideDefaults()` refuses a rule that
  would lift a default (400 `UNHIDE_SECRET`; `ConfigError` at startup).
* **Surfaces** — tree omits hidden entries (they do not consume the 4000-entry cap);
  search never matches or descends into them; read returns the same `404` body as a missing
  file (name decision before any `fs` call, then canonical); create/rename/delete return
  `403` and a directory rename is refused if any descendant's decision would change
  (`assertSubtreeStable`, ≤4000 entries); the doc upgrade is rejected `404` before the
  file is read.
* **Live changes** — `DocumentHub.applyPolicy`: set a frame gate, `flush()` every open
  document, `policy.setRules()`, `enforce()`, release the gate, replay held frames in
  arrival order under the new access. Hidden connections close with `4403`; a downgraded
  connection is `revoked` (frames get `denied`, never re-upgraded). An unaffected file's
  frames still reach disk and other clients.
* **Limits to state plainly** — canonicalisation is check-then-act (`canonicalTarget`
  realpaths existing segments), so a path swapped mid-flight is out of scope; hard links
  are not detected; and a shell bypasses the policy entirely, which is why the banner and
  `terminalBypassesRules` say so.

## Host console API

| Route | Purpose |
| --- | --- |
| `GET /admin/api/state` | session (`id`, `rootName`, `rootPath`, `createdAt`), open counts, `terminalBypassesRules` |
| `GET /admin/api/fs/list?path=&showHidden=` | folder picker (directories only, realpath'd, 500-entry cap) |
| `POST /admin/api/session/root` | `{ path, confirmBroad? }` → atomic switch; dirty docs flush to old paths, PTYs die, sockets close `4410` |
| `GET /admin/api/policy` | `rules`, `defaults`, `confirmUnhide`, `terminalBypassesRules` |
| `PUT /admin/api/policy/rules` | `{ rules, confirmUnhide? }` → validate, flush, apply, echo `rules`/`confirmUnhide`/`affected` |
| `GET /admin/api/lobby` | `enabled`, `locked`, `pending`, `admitted` snapshot |
| `POST /admin/api/lobby/:id/admit` | `{ role: "editor" \| "viewer" \| "candidate" }` |
| `POST /admin/api/lobby/:id/deny` | terminal refusal for that connection |
| `POST /admin/api/lobby/lock` | `{ locked: boolean }` |
| `POST /admin/api/connections/:connectionId/kick` | close doc/terminal/signal with `4429`, mark removed |
| `GET /admin/api/invites` | live and exhausted invites (`id`, `role`, `expiresAt`, `maxUses`, `usedCount`) |
| `POST /admin/api/invites` | `{ role, ttlMinutes?, maxUses? }` → new invite; 50-live cap |
| `POST /admin/api/invites/:id/revoke` | revoke one invite |
| `GET /admin/api/tokens` | configured roles |
| `POST /admin/api/tokens/:role/rotate` | return a new token; invalidate the old one for new connections and revoke role invites |
| `GET /admin/api/tunnel` | `configured`, `provider`, `running`, `publicUrl`, `cloudflaredInstalled`, `installInstructions` |
| `GET /admin/api/events?token=` | default-room SSE `snapshot` + `lobby` events, 15 s heartbeat |
| `GET /admin/api/rooms` | rooms, roots, creation time, default flag, admitted count |
| `POST /admin/api/rooms` | `{ path, confirmBroad? }` → create a room; returns its tokens once |
| `DELETE /admin/api/rooms/:roomId` | close a non-default room; sockets close `4412` |
| `GET /admin/api/rooms/:roomId/events?token=` | room-scoped SSE |
| `POST /admin/api/rooms/:roomId/moderators` | grant `call.moderate` to a live signal connection |
| `GET /host` | the console UI (admin listener only; 404 on the guest port) |

State, policy, lobby, kick, invites, token rotation and root-switch routes also exist under
`/admin/api/rooms/:roomId/…`; moderator grants are room-scoped only. Room
creation/management is API-only; the console UI still drives the default room.

Roots that are the filesystem root, the home directory (or its parents), `~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.config` are refused; system directories need `confirmBroad`.

## Host console UI

`client/src/host/main.tsx` is a separate Vite entry loaded only by `/host` on the admin
listener. `HostApp` is a page-level control room, not a fixed-height dashboard: a sticky
status bar, waiting-room and in-session activity first, then an **Access & distribution**
section with a wide invite composer, role tokens and public-tunnel status. It stacks below
1100 px and the page scrolls instead of clipping nested tool panels. The admin token is
read from the `#admin=` fragment into that tab's `sessionStorage`; all requests go through
`hostApi.ts`. There is no start/stop tunnel control and no auto-download. `HostQr` uses the
existing `qrcode` renderer for a live public URL only.

## Terminal isolation — read this before sharing a link

The terminal is privileged remote code execution on the Host. What is implemented:

* **Explicit consent:** the terminal is only created when the Host does not pass
  `--no-terminal` and the session is not read-only; the startup banner says so.
* **Scrubbed environment:** the PTY does not inherit the server's environment. It
  gets a minimal allow-list (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TERM`, …),
  so credentials in the daemon's env do not leak into `env` in the shell.
* **Generated rc files** (mode `0600` in a private temp dir) restore normal prompt
  behaviour, hide host shell history, and wrap `cd`/`pushd` to refuse leaving the
  project root.
* **Limits:** 64 KiB max input message, socket payload caps, one PTY per tab, all
  PTYs killed on session close or shutdown.

What this is **not**: an OS sandbox. `cd` restrictions are UX guidance; a determined
operator can still use absolute paths, `python -c`, or `$(...)` to reach anything
the Host user can. The actual boundary is "authenticated = trusted operator".
For real isolation, run the whole daemon as an unprivileged user inside a container
with only the project mounted, or keep the session read-only.

## Collaborative editing

* One Yjs `Text` document per file, created by `DocumentHub` on first connect.
* Initial content comes from **the file on disk**, inserted at `INIT_ORIGIN` so it is
  not rebroadcast. A file change on disk (external editor) is picked up by the
  watcher and merged through the same doc instead of overwriting live editors.
* Saves are debounced (`CODE_PAIR_SAVE_DEBOUNCE_MS`, default 300 ms) and written
  atomically (temp file + rename) so a crash cannot truncate a file. `Ctrl/Cmd+S`
  sends an explicit `flush` and gets a `saved` ack with a timestamp.
* Read-only connections can receive updates but their updates are dropped and
  answered with a `denied` control message. A policy downgrade (`rw` → `r`) revokes write
  on that live socket the same way; a policy hide closes it with `4403`.
* A rule change holds incoming document frames between the flush and the install and
  replays them afterwards, so accepted edits are never dropped; a frame the new access
  forbids is answered `denied` and never reaches disk.
* Presence uses Yjs awareness: name, colour and Yjs relative selections (they
  survive concurrent edits). Idle docs close after their last client leaves, and
  awareness ids are removed on disconnect.
* Remote cursors are **not** delegated to `y-monaco`'s selection rendering: that
  path calls `editor.deltaDecorations()` synchronously inside awareness events and
  throws `Invoking deltaDecorations recursively` when two people type at once. The
  binding handles text only; `EditorPane` renders remote selections itself, coalesced
  into one animation frame with trackable decoration ids.
* Concurrent typing at the same offset interleaves characters — that is Yjs
  semantics, not corruption. Nothing is lost and both sides converge.

## WebRTC

* `/ws/signal?room=<roomId>` resolves one room and validates its token; each room has its
  own `SignalingHub`. Messages are relayed only between sockets in that room, with SDP
  capped at 100 kB and candidates at 4 kB, max 32 peers.
* The owner can moderate; the Host can also grant `call.moderate` to a live editor/viewer
  connection. The grant lives in the room's signal hub and is revoked when that socket
  closes. Mute is a relayed request, not a server-side track change; spotlight and hand
  raise broadcast to the room; remove-from-call closes only the signal socket with `4430`
  and leaves the target's document and terminal connected.
* `client/src/lib/calls.ts` maintains a full mesh: each peer gets one
  `RTCPeerConnection` with audio/video/screen tracks, and the "polite peer" rule
  (lower client id) resolves offer glare.
* Media is only requested when the user activates mic, camera or screen share —
  opening the call panel alone captures nothing.
* Default ICE config is Google's public STUN server. **Cross-NAT calls will fail
  without TURN.** Supply static TURN via `--ice-servers`, or configure coturn's
  REST API:

```bash
CODE_PAIR_TURN_SECRET='<static-auth-secret>' \
CODE_PAIR_TURN_URLS='turn:turn.example.com:3478' \
npm start -- --root . --host 0.0.0.0
```

  `parseConfig` and `createCodepairServer` both reject a secret without at least
  one valid `turn:`/`turns:` URL before either listener binds. The shared secret
  is never returned or logged; `/api/session` receives a fresh HMAC-SHA1-signed
  username and credential per request, valid for `--turn-credential-ttl` seconds.

Keep TURN credentials out of the UI: static and minted credentials are returned by
`/api/session` only to authenticated clients, which mirrors how any client that may
call needs them. The raw coturn shared secret is server-only and never reaches the
client. Minting is in `server/src/webrtc/turnCredentials.ts`; `/api/session` mints once
per request and appends one TURN entry to `config.iceServers`.

Startup fails with `ConfigError` when `--turn-secret` is present without a valid
`--turn-urls` entry. This check is in `parseConfig()` and again at the first line of
`createCodepairServer()`; neither listener is bound on failure.

## Networking

* **LAN** (`--host 0.0.0.0`): the daemon lists every non-internal IPv4 address with
  a ready-to-open link, and warns that anyone on the network with the link has the
  access granted. Open the port in the Host firewall.
* **Public** (`--tunnel cloudflare|ngrok`): the provider CLI is spawned directly, the
  public HTTPS URL is scraped from its output, and it is torn down on exit. Tunnel
  credentials live in the CLI's own config and are never read by CodePair. Requiring
  the CLI to be installed is deliberate: tunnel providers' TOS and auth models stay
  in their own tooling.
* Public links are **not** permanent and are printed with a warning. Authentication
  is identical on LAN and public URLs.

## Scripts

```bash
npm run typecheck     # tsc for server + client
npm test              # Vitest: 236 tests — sandbox, policy, API, admin, lobby, invites, rooms, moderation, interview, doc sync, terminal, TURN
npm run build         # Vite client build + tsup server bundle
npm run dev           # tsx watch server + Vite client
```

Browser-level verification (two real Chrome clients, real keystrokes):

```bash
cd e2e && npm install          # puppeteer-core
node browser.mjs               # running daemon + Chrome, see file header; set CODE_PAIR_ADMIN_TOKEN for admin checks
```

It checks file loading from disk, typing that lands on the Host disk, presence,
remote cursor labels, concurrent edits converging with nothing lost, a real shell
running `node`, 401 for unauthenticated API calls, traversal rejection, the share
dialog's QR, mobile and landscape layout, one-use invites, and — when
`CODE_PAIR_ADMIN_TOKEN` is set — two root switches and the invite/admit flow. The
28-check run uses the built guest app against one room; multi-room isolation is covered
by server tests.

## Platform notes

* Node 20+ (developed on Node 22, macOS arm64). `node-pty` is a native module;
  `scripts/postinstall.mjs` survives a failed rebuild and the daemon reports a
  terminal-unavailable capability instead of crashing.
* Java/C/C++ diagnostics are not provided: Monaco ships syntax colouring for those
  languages but no language server. TypeScript/JavaScript, JSON, CSS and HTML get
  the full bundled Monaco workers (autocomplete, diagnostics).
* Windows: symlink checks and shell rc generation are written for POSIX shells;
  treat Windows as unverified.

## Security assumptions to state out loud

1. Holding the token ≈ permission to edit the project and, unless `--no-terminal`,
   to run commands as the Host user.
2. Share tokens and invite links out-of-band. Rotate a role in the Host console; the old
   token fails new connections, the role's pending invites are revoked, and existing
   sockets continue. The client drops a stored token on a 401 and asks again.
3. Prefer `read-only` for demos and public tunnels; prefer a VPN over a public tunnel.
4. The daemon is HTTP by default. For public use put it behind the tunnel's HTTPS
   (or a reverse proxy) so tokens and media never cross plaintext networks.
5. No CSRF tokens are needed: state-changing routes require a bearer token that a
   cross-site page cannot read, and JSON bodies require a CORS preflight.
6. The path access policy hides files from the app, not from a shell: a terminal client
   runs as the Host user and can read anything that user can. `--no-terminal` and
   read-only sessions are the only way to close that gap.
7. Hidden is not a permission: a hidden path is invisible (`404`/omitted/`4403`), and the
   default secret floor applies per session, resetting on every root switch.
8. Room selection is not authentication: a token from room A is rejected in room B, and a
   connection id claimed in one room cannot be replayed in another.
9. Call moderation is advisory for audio. A mute request is fulfilled by the target's own
   client; call removal closes only the signal socket and does not revoke file or terminal
   access.
