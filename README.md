# CodePair

A hybrid **local-host collaborative IDE**. One machine (the **Host**) runs a small daemon
that exposes one or more real project directories and a real terminal to a browser UI.
Other people (**Remote Clients**) open a link, authenticate with a session token, and edit
the Host's actual files, watch terminals run on the Host machine, and talk over WebRTC.

Nothing is simulated: files are read and written on the Host's disk, the terminal is a
`node-pty` shell process, collaboration is a real Yjs CRDT over authenticated WebSockets,
and calls use the browser's native `RTCPeerConnection`. There is no cloud service in
between — your browser talks straight to the Host.

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

## Highlights

- **Real files, real terminal** — edits land on the Host's disk (debounced, atomic
  writes); the terminal is an actual shell on the Host with a scrubbed environment.
- **Collaborative editing** — one Yjs document per file; concurrent edits interleave and
  converge, coloured remote cursors, presence avatars, external file changes are merged.
- **Calls** — microphone, camera and screen share over a peer-to-peer WebRTC mesh with
  signalling relayed by the Host; media is only requested when you press the button.
  The panel minimizes to a pill or maximizes (capped at half the screen), an active
  screen share always gets a full-width featured tile, and every participant's video or
  screen can be sent fullscreen from a button on the tile itself. The owner — or a
  connection granted `call.moderate` — can ask a participant to mute, spotlight a tile,
  or remove someone from the call without closing their editor. Everyone can raise a
  hand. Mute is advisory: the target's own client disables its track, and "Muted by host"
  appears only after that local track is off.
- **Sandboxed paths** — every client-supplied path passes lexical *and* realpath
  containment checks; sensitive names (`.git`, `node_modules`, `.env*`, keys) are hidden.
- **Path access rules** — per-session `hidden` / `r` / `rw` glob rules, enforced at one
  choke point across the tree, search, reads, mutations and document sockets; built-in
  secret defaults stay hidden until the Host explicitly confirms unhiding.
- **Join approval (lobby)** — every guest token waits in a queue until the Host admits it
  as editor, viewer, or interview candidate, denies it, or lets it expire; the Host can
  lock the room and kick a tab at any moment. `--no-lobby` restores the old "open the link
  and you are in" flow.
- **Multiple rooms per daemon** — the default room keeps its original startup link; the
  loopback Host API can create additional rooms at other canonical roots. Each room owns
  its tokens, lobby, invites, root, documents, PTYs and signalling, and a room selector is
  never a credential.
- **Interview profile** — an admin-created interview room adds a consent-gated candidate
  seat, a seeded writable `solution/` folder, bounded integrity signals, data-only replay,
  and a Docker-only candidate terminal that fails closed with `4403` when Docker or the
  image is unavailable. Ordinary editor/viewer terminals remain host PTYs.
- **Expiring invite links and live token rotation** — the Host console mints expiring,
  limited-use editor/viewer/candidate links; each redemption becomes a real token and
  still waits in the lobby. Rotating a role revokes that role's pending invites and stops
  its old token for new connections, while existing sockets keep working.
- **Tunnel status at a glance** — the Host console reports whether a tunnel is configured
  and running, shows the public URL with a QR code when live, and says whether
  `cloudflared` is installed. It never downloads or executes a fetched binary.
- **Loopback Host console** — a separate admin listener (own token, its own port) serves
  `/host`: a scrollable control room with the live queue over SSE, admit/deny, kick and room
  lock, project switch, live rule editor, invite links, role-token rotation and tunnel
  status. None of it exists on the guest port.
- **Token auth everywhere** — a random 256-bit token per start, checked on every HTTP
  route and every WebSocket upgrade; the token travels in the URL fragment, never in
  query strings or logs.
- **Mobile-friendly** — drawer file tree, overlay terminal, touch-sized controls down to
  320px viewports, QR code in the Share dialog for joining from a phone.
- **Offline-capable LAN** — the UI, fonts, Monaco workers and xterm are bundled locally;
  no internet required.

## Quick start

```bash
npm install                # workspaces: server + client (builds node-pty)

# Development: Vite for the UI, tsx for the daemon
npm run dev                # both at once (server link points at the Vite origin)
# or separately:
npm run dev -w server -- --root ~/code/project --host 0.0.0.0
npm run dev -w client                       # http://localhost:5180

# Production: build the UI into client/dist, then serve it from the daemon
npm run build
npm start -- --root ~/code/project --host 0.0.0.0
```

The daemon prints a link containing the access token. Opening it stores the token in
`sessionStorage`; the URL fragment is cleared immediately, so the token never travels in
query strings, `Referer` headers or access logs.

## CLI flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--root <dir>` | cwd | Directory exposed by this session |
| `--host <host>` | `127.0.0.1` | `0.0.0.0` for LAN access |
| `--port <port>` | `7420` | Guest listener (and tunnel target) |
| `--admin-port <port>` | `port + 1` | Loopback-only Host console port, bound to `127.0.0.1` regardless of `--host` |
| `--mode <mode>` | `read-write` | `read-only` makes the primary token a viewer: no writes, deletes or terminal |
| `--token <token>` | random per start | Primary token: **owner**, or **viewer** with `--mode read-only`. 16–512 bytes, URL-safe |
| `--editor-token <token>` | — | Extra token with editor access |
| `--viewer-token <token>` | — | Extra token with view-only access |
| `--no-lobby` | lobby on | Admit every authenticated guest immediately; lobby actions then return `409 LOBBY_DISABLED` |
| `--lobby-timeout <seconds>` | `120` | Pending request lifetime, 1–3600; an unanswered request expires and may retry |
| `--no-terminal` | terminal on | Explicit Host opt-out of remote shells |
| `--interview-sandbox` | off | Enable the Docker-only candidate terminal. Requires Docker; no fallback to a host PTY |
| `--interview-sandbox-image` | `node:22-bookworm-slim` | Image for the candidate sandbox. Inspected, never pulled |
| `--rule <glob>=<access>` | — | Path rule (`hidden`, `r`, `rw`), repeatable up to 50, validated at startup |
| `--confirm-unhide` | off | Required when a `--rule` lifts a built-in secret default |
| `--tunnel <provider>` | off | `cloudflare` or `ngrok` public tunnel |
| `--ice-servers <json>` | Google STUN | JSON `RTCIceServer[]`, max 8 entries |
| `--allow-origin <origin>` | — | Extra origin allowed to open WebSockets |
| `--dev-client <url>` | — | Vite origin used in the printed link and origin check |
| `--quiet` | off | Less startup output |

Environment equivalents: `CODE_PAIR_MODE`, `CODE_PAIR_TOKEN`, `CODE_PAIR_PORT`,
`CODE_PAIR_ADMIN_PORT`, `CODE_PAIR_HOST`, `CODE_PAIR_ALLOW_ORIGINS`, `CODE_PAIR_DEV_CLIENT`,
`CODE_PAIR_TERMINAL=off`, `CODE_PAIR_TUNNEL`, `CODE_PAIR_ICE_SERVERS`,
`CODE_PAIR_MAX_FILE_BYTES`, `CODE_PAIR_SAVE_DEBOUNCE_MS`, `CODE_PAIR_IGNORE`,
`CODE_PAIR_INTERVIEW_SANDBOX_IMAGE`, `CODE_PAIR_CLIENT_DIST`.

## Roles and tokens

Every token maps to exactly one role, and the role decides what that session may do:

| Role | Capabilities | Can do |
| --- | --- | --- |
| `owner` | `fs.read`, `fs.write`, `fs.delete`, `term.use`, `call.join`, `call.moderate` | everything except administration |
| `host` | `session.admin` | the Host console only; never a guest listener |
| `editor` | `fs.read`, `fs.write`, `fs.delete`, `term.use`, `call.join` | edit, delete, terminal, calls |
| `viewer` | `fs.read`, `call.join` | read files, receive live edits, join calls |
| `candidate` | `fs.read`, `fs.write`, `call.join` | interview rooms only: write inside the candidate folder, no delete, no host terminal |

- `--token` keeps its historical meaning: the **owner** in `read-write`, a **viewer** when
  `--mode read-only` is set.
- `--editor-token` and `--viewer-token` add roles to the same session. The daemon prints one
  link per token, labelled with the role it grants.
- Tokens must be distinct; the daemon refuses to start when two roles share one.
- `--no-terminal` still wins over every role: no token gets a shell.
- A viewer's edits are dropped server-side and the UI explains why, but their cursor and
  presence still reach everyone else.
- **A seat can only narrow.** When the Host admits an editor token as a viewer, effective
  capabilities are the intersection of token and seat, so that tab keeps reading but its
  writes are refused. A viewer token can never be admitted as an editor (`ROLE_CEILING`).
- **The owner token never waits.** It bypasses the lobby and the lock, and its connection
  id can never be borrowed by a guest.
- **Call moderation is scoped.** The owner holds `call.moderate`. The Host can grant it to
  a live editor or viewer signal connection in one room; the grant is lost when that signal
  socket closes and never becomes part of the role.
- **Candidate is not a narrow editor.** It has `fs.read` and `fs.write`, but no `fs.delete`
  or `term.use`. The interview room's access policy makes only `solution/` writable for
  every role, so the candidate can write there and read the task elsewhere. Its terminal is
  a separate Docker-sandbox path, never the host PTY.

## Join lobby

Guest tokens ask once per browser tab. The client generates a per-tab connection id
(`sessionStorage`, sent as `X-CodePair-Connection` on HTTP and `?cid=` on WebSocket
upgrades), shows a waiting screen, and polls `/api/lobby/status` while the Host decides in
the console:

- **Pending** — up to 50 requests are queued; the 51st is refused with `429 LOBBY_FULL`
  rather than silently dropped. An unanswered request expires after `--lobby-timeout`
  (default 120 s) and may ask again.
- **Admitted** — the tab gets a seat. Every guest `/api/*` route except `/api/health`,
  `/api/session` and `/api/lobby/*` now requires that seat. Document, terminal and
  signalling sockets are checked at upgrade time; a refusal completes the upgrade and
  closes with **4425** and a reason, so the app can tell "ask the Host" from "that file is
  gone".
- **Denied / removed** — terminal for that connection id: reconnecting with it is refused.
  "Ask again" clears the id and queues as a new request; a reload does the same.
- **Locked** — new requests are refused (`LOBBY_LOCKED`); already-admitted tabs keep
  working, and the Host's own token still enters.
- **Kicked** — the Host closes every socket for that tab with **4429** and makes the
  request terminal. A retry on the same id is refused; clearing the id queues again.
- **Fails closed** — a missing, malformed or unrecognized connection id is never admitted.

`--no-lobby` skips all of this: joins are admitted immediately, no connection id is
required on any surface, and lobby actions answer `409 LOBBY_DISABLED`. The lobby is per
room, so a root switch resets only that room's queue.

## Rooms

The daemon starts with one **default room** at `--root`, using the tokens supplied by the
CLI. The loopback Host API can create more rooms at other canonical directories; there is
no `--rooms` flag and no room-creation route on the guest listener. A room owns its session,
root, token store, lobby, invites, document hub, PTYs and signalling hub.

- **Fresh credentials.** A new room receives new owner/editor/viewer tokens, returned once
  in the creation response; an interview room also receives a candidate token. Existing
  tokens cannot be revealed again; rotate the role in that room instead.
- **Selector, not credential.** Guest HTTP requests may send
  `X-CodePair-Room: <roomId>`; WebSockets and share links use `?room=<id>` and
  `/room/<id>`. Omitting the selector targets the default room. The bearer token is always
  checked against the selected room's token store, so a token from room A is `401` in
  room B.
- **No cross-room reuse.** A connection id is claimed by the first room it uses. Presenting
  it to another room is `403 ROOM_MISMATCH` on HTTP and on the WebSocket upgrade.
- **Room-local lifecycle.** Root switches, lobby queues, invites, document and terminal
  sockets, and calls are scoped to one room. Two rooms cannot share a canonical root.
  Deleting a room closes its document, terminal and signal sockets with `4412`, ends its
  Host-console event stream and releases its claims. The default room cannot be deleted
  (`409 DEFAULT_ROOM`).
- **Moderation scope.** A moderation grant belongs to one live signal socket in one room.
  It is lost when that socket closes, even when the same connection id reconnects. The
  current Host console UI drives the default room; room orchestration is API-only.

## Path access policy

Every session starts with the built-in secret patterns hidden, whatever the Host’s rules
say. Rules only ever narrow access: the result is the most restrictive of the rule and the
token’s capabilities, so `rw` never gives a viewer a write it did not already have.

| Access | Effect |
| --- | --- |
| `hidden` | Invisible: omitted from the tree, never matched or descended into by search, `404 NOT_FOUND` on read (byte-identical to a missing file), document socket refused with `404` |
| `r` | Readable and watchable; edits are refused with the usual `denied` meta |
| `rw` | Read and write, still limited by the token’s capabilities |

Matching is case-insensitive on NFC-normalised, `/`-separated project-relative paths:

| Pattern | Matches |
| --- | --- |
| `notes.md` | that basename at any depth |
| `docs/**` | `docs` itself and everything beneath it |
| `config/*.json` | one level under `config` (a pattern containing `/` is anchored at the root) |
| `*.pem` | any basename ending in `.pem`; `*` matches a leading dot too |
| `?` | exactly one character that is not `/` |

The first matching host rule wins. Paths are decided twice — as requested and as their
canonical target (existing segments are `realpath`’d) — and the stricter result applies, so
a visible-named symlink to a hidden file is hidden. Canonicalisation is best effort and not
atomic: like the path guard, it is check-then-act, so a path swapped between the check and
the file operation is outside what this layer can promise. Hard links are indistinguishable
from ordinary files and are not detected.

**The defaults are a floor.** A path matching a built-in secret stays `hidden` even under a
host rule that allows it, until the Host confirms unhiding. Confirmation is per PUT: it
applies only to the request that carries `confirmUnhide: true` (or `--confirm-unhide` at
startup), is echoed by every `GET`/`PUT`, and resets on the next PUT that omits it and on
every root switch. A rule that would lift a default without confirmation is refused with
`UNHIDE_SECRET` (startup: `ConfigError`), so a typo like `**=rw` cannot quietly expose
`.env`.

**Live changes never drop accepted work.** A PUT flushes pending debounced saves first,
holds incoming document frames while the rules are installed, then replays those frames in
arrival order under the new access: an edit to a file whose access did not change still
lands and reaches other clients; an edit the new access forbids is answered with `denied`
and never reaches disk. An open document that becomes hidden is closed with `4403`; the app
closes its tab and shows one toast, reopening the tab re-arms that notice.

**The terminal bypasses all of this.** A shell runs as the Host user with the project’s
permissions, so `cat .env` works even though the editor cannot open it. When any role has a
shell, the startup banner says so and `GET /admin/api/state` reports
`terminalBypassesRules: true`; `--no-terminal` removes both the shell and the warning.

## Interview rooms

An interview room is a normal room with an additive profile. Create one through the
loopback admin API (the room routes are room-scoped; the console UI still drives the
default room):

```json
POST /admin/api/rooms
{ "path": "/path/to/project", "profile": "interview", "candidateDir": "solution" }
```

The response includes the four tokens once, including `candidate`. Creating the room
seeds `<root>/solution/` (a directory only; task files are whatever the Host put in the
root) and installs policy rules that keep `solution` and `solution/**` writable for every
role in that room, with everything else read-only. The owner of an interview room is also
read-only outside `solution/` by design.

### Consent is a hard gate

A candidate's first `/api/session` response carries the server's consent manifest. The
client shows that list and does not ask the lobby to join until the candidate accepts.
`POST /api/lobby/join` requires `{ "consent": true }` for a candidate; without it the
request is `403 CONSENT_REQUIRED` and no lobby entry, document update, snapshot or
integrity event exists. Declining is a neutral dead end: no request is sent and nothing is
logged. The accepted scope is server-owned, so the UI cannot narrow the notice it shows
while logging more.

Accepted signals are deliberately small and reviewable, never an automated verdict:

- document updates as typed/paste-sized character counts with the path and connection id;
- content snapshots per file, capped at 256 snapshots and 4 MB with explicit truncation
  flags;
- visibility changes, window blur/focus, fullscreen enter/exit, paste size/target path, and
  the browser-reported `displaySurface` when the candidate shares a screen (`monitor`,
  `window`, `browser` or `unknown`).

Paste content, editor text and screen pixels are never sent. The candidate sends batches to
`POST /api/integrity` (authenticated, candidate-only, consent-gated, at most 100 events per
request); the store keeps at most 2,000 events. The event ring, snapshots and replay payload
are bounded, and the interviewer can read the data-only replay at
`GET /admin/api/rooms/:roomId/replay`. This iteration has no scrubber UI. Signals are
client-reported and a modified client can stop sending them, so they are evidence for a
human to review, not tamper-proof detection or proof of cheating.

### Candidate terminal is Docker-only and fail-closed

With `--interview-sandbox`, startup runs `docker version` and `docker image inspect` for
the configured image. It never builds, pulls or installs anything. If the probe fails, the
candidate terminal closes with **4403** and a sandbox-specific reason; **no host PTY is
spawned and no fallback exists**. Non-candidate terminals are unchanged.

When available, the candidate shell is an ephemeral container with:

- `--network none`, `--rm`, `--interactive`, `--tty`;
- `--cpus 1`, `--memory 512m`, `--pids-limit 128`;
- `--cap-drop ALL`, `--security-opt no-new-privileges`, a non-root `--user`;
- `--workdir /workspace`, the project root mounted `:ro`, and only
  `<root>/solution` mounted `:rw` at `/workspace/solution`;
- the project root mounted read-only at `/workspace`, a `--tmpfs /tmp` with `HOME=/tmp`, and the image's `/bin/sh -l`.

The image must already exist on the Host. The Host can opt into the feature without Docker
being installed; candidates simply get the closed terminal until Docker and the image are
available.

## Host console (admin API)

The Host can move the session to another project at runtime through a separate,
loopback-only listener. It is a different `http.Server`, bound to `127.0.0.1` on
`--admin-port` no matter what `--host` says, and none of its routes exist on the
guest port (the guest app answers `/admin/*` with a 404).

The console is a page-level control room: waiting-room and in-session activity come first,
then **Access & distribution** with the invite composer, role tokens and tunnel status. It
stacks at narrow widths, scrolls instead of clipping fixed-height tool panels, and keeps
the admin token in that tab.

- Its token is generated fresh on every start (`crypto.randomBytes(32)`, base64url) and
  printed once, on the `Host console:` banner line, inside the `#admin=` fragment. It is
  never returned in a response body.
- A request must carry that token as `Authorization: Bearer …`, a `Host` header of
  `127.0.0.1:<admin-port>` or `localhost:<admin-port>`, no `Origin` unless it is that same
  loopback origin, and no `X-Forwarded-For` / `X-Forwarded-Host` / `Forwarded` /
  `CF-Connecting-IP` / `X-Real-IP`. Responses are `no-store` and never CORS.
- Guest tokens are rejected on this listener and the admin token is rejected on the guest
  listener. Every route requires the `session.admin` capability.
- The console UI is served at `/host` (and `/host/`) **only on this listener**; the guest
  port answers `404`. Opening the printed `#admin=` link stores the admin token in that
  tab's `sessionStorage`, away from the guest app.
- `GET /admin/api/events` is the one route that also accepts `?token=`, because
  `EventSource` cannot set headers. It is a per-route middleware, not a global query-token
  fallback: every other admin route still reads only `Authorization`.

| Route | Purpose |
| --- | --- |
| `GET /admin/api/state` | active session (`id`, `roomId`, `rootName`, `rootPath`, `createdAt`) and open handle counts |
| `GET /admin/api/fs/list?path=&showHidden=0\|1` | folder picker: directories only, realpath'd, hidden excluded by default, 500-entry cap |
| `POST /admin/api/session/root` | `{ "path": "…", "confirmBroad": false }` → switches the project root |
| `GET /admin/api/policy` | current `rules`, the built-in `defaults`, `confirmUnhide`, `terminalBypassesRules` |
| `PUT /admin/api/policy/rules` | `{ "rules": [{ "pattern": "…", "access": "hidden\|r\|rw" }], "confirmUnhide": false }` → validates, flushes open documents, applies, echoes `rules`/`confirmUnhide`/`affected` |
| `GET /admin/api/lobby` | live snapshot: `enabled`, `locked`, `pending`, `admitted` |
| `POST /admin/api/lobby/:id/admit` | `{ "role": "editor" \| "viewer" \| "candidate" }` → admits one pending request with that seat; a candidate token can only be seated as candidate |
| `POST /admin/api/lobby/:id/deny` | refuses one pending request; that connection becomes terminal |
| `POST /admin/api/lobby/lock` | `{ "locked": true \| false }` → refuse or resume new joins |
| `POST /admin/api/connections/:connectionId/kick` | closes that tab's doc/terminal/signal sockets with `4429` and makes its request terminal |
| `GET /admin/api/invites` | live and exhausted invites, with role, expiry, `maxUses` and `usedCount` |
| `POST /admin/api/invites` | `{ "role": "editor\|viewer\|candidate", "ttlMinutes": 5\|null, "maxUses": 1\|null }` → mints a 144-bit invite id |
| `POST /admin/api/invites/:id/revoke` | revokes one invite; redeeming it then fails closed |
| `GET /admin/api/tokens` | which roles (`owner`, `editor`, `viewer`, `candidate`) have a token configured |
| `POST /admin/api/tokens/:role/rotate` | returns a new token once; old token fails new requests, the role's live invites are revoked, existing sockets continue |
| `GET /admin/api/tunnel` | `configured`, `provider`, `running`, `publicUrl`, `cloudflaredInstalled`, `installInstructions` |
| `GET /admin/api/events?token=…` | default room SSE: an opening `snapshot` event, then `lobby` on every change, with a 15 s heartbeat |
| `GET /admin/api/rooms` | rooms with root, creation time, default flag and admitted participant count |
| `POST /admin/api/rooms` | `{ "path": "…", "confirmBroad": false, "profile": "interview", "candidateDir": "solution" }` → creates a room and returns its tokens once (four for an interview room) |
| `DELETE /admin/api/rooms/:roomId` | closes a non-default room and its sockets with `4412` |
| `GET /admin/api/rooms/:roomId/replay` | data-only interview replay: events, typed/paste sizes, bounded content snapshots and truncation flags |
| `GET /admin/api/rooms/:roomId/events?token=…` | room-scoped SSE `snapshot` and `lobby` events |
| `POST /admin/api/rooms/:roomId/moderators` | `{ "connectionId": "…" }` → grants `call.moderate` to a live signal connection |

State, policy, lobby, kick, invite, token-rotation and root-switch routes also exist under
`/admin/api/rooms/:roomId/…` for a specific room; moderator grants are room-scoped only.
`GET /admin/api/fs/list` stays a daemon-level folder picker. The console UI currently drives
the default room.


### Invite links and token rotation

The invite link is built from the guest origin (`http://127.0.0.1:<port>/room/<id>#invite=<id>`)
and redeems through the one intentionally unauthenticated API route,
`POST /api/invites/:id/redeem`. Redemption returns `{ token, role }` and grants no seat by
itself: the new token still enters the normal lobby. Invite ids are 18 random bytes
(144 bits), URLs stay in the fragment, and the client redeems each id at most once per
tab even under React StrictMode.

- A role with no configured token cannot mint an invite (`409 ROLE_NOT_CONFIGURED`); owner
  invites are refused.
- At most 50 live invites exist per room (`429 INVITE_LIMIT`); TTL is at most seven
  days and `maxUses` at most 1000.
- Ten failed redeems against one id in a rolling 60 s window block that id for 60 s
  (`429 INVITE_RATE_LIMITED`). The failure tracker is capped at 256 ids; blocked entries
  are never evicted, and a fresh id is still tracked when every slot is blocked (a
  deliberate soft cap). `usedCount` increments only on a successful redeem.
- Unknown, expired, exhausted and revoked invites all return the same byte-identical
  `404 INVITE_INVALID` body.
- Rotation returns the new token once in the Host console. It replaces the old token for
  new HTTP requests and WebSocket upgrades, revokes every live invite for that role, and
  leaves already-open sockets alone.

Switching validates the path first, builds the new session before touching the old one, swaps
atomically, then disposes the old one: dirty documents are flushed to their **old** absolute
paths, external-change pollers stop, every PTY is killed and its rc directory removed, and
document/terminal sockets close with code `4410` while signalling stays connected.

The filesystem root, the home directory and its parents, and `~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config` are always refused: with home as the root, those credential directories are
ordinary files that every guest could read. System directories (`/etc`, `/usr`, `/bin`,
`/sbin`, `/var`, `/System`, `/Library`, `/private`, `/dev`, `/proc`, matched exactly after
realpath) are refused unless the request sets `"confirmBroad": true`.

The lobby is rebuilt for the new root (pending requests and timers are dropped), while a
kick still reaches a tab's sockets through the daemon-level connection registry.

Guest tabs are not left silently broken: every document and terminal socket closes with
`4410`, the app shows one toast — "The host switched to a different project. Reload to
continue." — plus a warning to copy unsaved work when a tab has edits, and a reload lands in
the new project.

## How to use

### Host (the machine running the project)

1. Install once: `npm install` (Node 20+).
2. Start the host on the folder you want to share:
   `npm start -- --root ~/code/my-project` (add `--host 0.0.0.0` for phones/other machines).
3. Copy the printed link — it contains the token — and the matching QR code in the
   app's Share dialog. That link is the whole session.
4. Share it out of band (message it directly). Anyone who opens it joins as a collaborator.
5. Stop with `Ctrl+C`. The token dies with the process and everyone is disconnected.

Handy flags: `--mode read-only` (guests can read and watch, no edits or terminal),
`--no-terminal` (editing without remote shells), `--port 7420` (when the port is taken).

### Remote users (everyone else)

1. Open the link the Host sent — laptop or phone; on a phone, scan the QR code from the
   Host's Share dialog.
2. Paste the token if the access screen appears. It is stored in that tab only; closing
   the tab forgets it.
3. Pick a file in the explorer, or press `Ctrl/⌘+P` to search by name.
4. Edit — changes reach everyone in a moment and are written to the Host's disk. Coloured
   cursors are other people.
5. Use the terminal with `Ctrl/⌘+\`` — it runs on the Host, so `npm run dev`, `python`,
   etc. work as if you were sitting there.
6. Talk over a call with the video button: microphone, camera and screen sharing all
   start only when you press them.

Saving is automatic shortly after you stop typing; `Ctrl/⌘+S` forces it now. Deleting or
renaming asks for confirmation, and open tabs follow the file. Download exports a copy of
the current file. On a phone the explorer opens from the menu icon and the terminal
slides up as an overlay.

### Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Quick open | `Ctrl` / `⌘` + `P` |
| Toggle terminal | `Ctrl` / `⌘` + `` ` `` |
| Save now | `Ctrl` / `⌘` + `S` |
| Close dialog or drawer | `Esc` |

## Security model (read before sharing a link)

1. **Holding a token grants that token's role** — since 0.4.0 a guest token alone is not
   enough: it must also be admitted by the Host unless the daemon runs with `--no-lobby`,
   and the seat can only narrow that role. `owner` and `editor` may edit and, unless
   `--no-terminal`, run commands as the Host user; `viewer` may only read. Share tokens out
   of band. Rotate a role in the Host console: new HTTP/WebSocket connections must use the
   new token, the old one answers 401, pending invites for that role are revoked, and
   already-open sockets keep working. The client drops a stored token on a 401.
2. **HTTP auth**: every `/api/*` route except `/api/health` requires
   `Authorization: Bearer <token>`; comparison hashes both sides with SHA-256 and uses
   `timingSafeEqual`.
3. **WebSockets**: the token is sent as a subprotocol (`["codepair", token]`), so it
   never appears in the URL. Origin is checked on every upgrade.
4. **Path sandboxing**: `PathGuard` rejects `..`, absolute paths, NUL bytes and symlink
   escapes with independent lexical and `realpath` checks. Errors never leak absolute
   server paths. On top of it, the path access policy can only narrow what a role may
   reach; hidden paths are indistinguishable from missing ones (`404 NOT_FOUND`).
5. **Terminal**: the PTY gets a scrubbed environment (no daemon credentials), generated
   rc files hide host history and refuse `cd` out of the root. This is *not* an OS
   sandbox — a determined operator can still reach anything the Host user can, including
   files the access policy hides from the editor. For hard isolation, run the daemon in a
   container or keep the session `read-only`.
6. **Interview candidate terminal**: when enabled, it is the one terminal path that is not
   a host PTY. It runs only inside Docker with `--network none`, dropped capabilities,
   no-new-privileges, a non-root user, resource caps, the project root mounted read-only and only the
   candidate folder writable. If Docker or the image is unavailable the candidate terminal
   closes with 4403; there is no host fallback. The container is still a Docker boundary,
   not a guarantee against a Docker daemon misconfiguration — keep the image minimal and
   the Host's Docker installation patched.
7. **Prefer `read-only`** for demos and public tunnels, a VPN over a public tunnel, and
   HTTPS (the built-in tunnel provides it) so tokens and media never cross plaintext.

**Room selection is not authentication.** `X-CodePair-Room` / `?room=` only chooses which
room's token store checks the bearer token. A token from another room is `401`, and a
connection id claimed by one room is rejected in another.

**Call moderation is advisory for audio.** A host mute request asks the target's own client
to disable its track; it is not a server-side remote mute. Removing someone from a call
closes only their signal socket and does not revoke editing or terminal access.

No CSRF tokens are needed: state-changing routes require a bearer token a cross-site
page cannot read, and JSON bodies require a CORS preflight.

## Known issues

- **Concurrent typing at the same spot can briefly interleave** — when two people type
  the same line region at once, CRDT ordering may briefly place their characters in a
  different order (it can look like content shifted by a line while one side is still
  catching up). Both views settle as soon as both clients sync, and no content is
  duplicated or lost: two-client stress tests (same-region typing bursts, mid-typing
  disconnects, reconnects during the other's typing) all converge and persist correctly.
- **Call moderation UI was not exercised by the browser harness** — the signalling
  protocol is covered by server tests; the participant drawer is typechecked and builds,
  but its visual interaction was not part of the 28-check run.
- **Room browser coverage is server-side** — the 28-check browser run used the default
  room; multi-room isolation is covered by the room integration tests.
- **Camera/mic/screen share over LAN** — browsers require a *secure context*
  (HTTPS or `localhost`) for `getUserMedia` and `getDisplayMedia`. In development
  mode, Vite now serves HTTPS with a self-signed certificate automatically, so
  LAN users connecting via `https://<lan-ip>:5180` get full media access. Accept
  the self-signed certificate warning in your browser on first visit. For
  production builds, put the daemon behind an HTTPS reverse proxy or use
  `--tunnel cloudflare`/`--tunnel ngrok` for automatic HTTPS.
  Set `CODE_PAIR_NO_SSL=1` to disable the self-signed cert if you only use
  localhost.
- **Calls between different networks fail without TURN** — the default ICE config is
  Google STUN only. Supply TURN via `--ice-servers` for reliable cross-NAT calls:

```bash
CODE_PAIR_ICE_SERVERS='[
  {"urls":"stun:stun.l.google.com:19302"},
  {"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}
]' npm start -- --root . --host 0.0.0.0
```

- **Public tunnels require the provider CLI** (`cloudflared` or `ngrok`) to be installed
  and are not permanent — the URL dies with the process. The Host console detects an
  installed `cloudflared`, shows the configured/running state and a QR for a live public
  URL, and prints provider instructions; CodePair never downloads or executes a fetched
  binary.
- **Windows is unverified**: symlink checks and shell rc generation are written for POSIX
  shells.
- **Access-policy limits**: hidden means hidden from the app, not from a shell (the
  terminal runs as the Host user; `--no-terminal` removes that path). Canonical-path
  checks are best effort and check-then-act, and hard links are indistinguishable from
  ordinary files, so they are not detected. The client's `4403` tab-close/toast path is
  covered by unit and server tests only, not by the browser harness.
- **Java/C/C++ diagnostics are not provided** — Monaco ships syntax colouring but no
  language server; TypeScript/JavaScript, JSON, CSS and HTML get full bundled workers.

## Testing

Currently 226 server tests (16 files) and 28 browser checks. The suite covers the original
single-room behavior plus room creation, selector-vs-credential isolation, cross-room
connection ids, room invites, scoped root switches, deletion teardown, call moderation
(grants, mute relay, spotlight, hand raise and call-only removal), and the interview
profile (candidate policy, consent gate, bounded integrity data, replay, role ceiling,
symlink escape, and the Docker-only fail-closed terminal). The committed browser run
covers file loading, concurrent edits, presence, remote cursors, terminal, 401 and
traversal rejection, the share QR, mobile and landscape layout, one-use invite redemption,
and root switching. Set `CODE_PAIR_ADMIN_TOKEN` to include the admin-driven invite and
root-switch checks. The temporary 13-check interview browser pass is described in
`REPORT.md` but is not committed to `e2e/browser.mjs`.

```bash
npm run typecheck     # tsc for server + client
npm test              # Vitest: sandboxing, API, doc sync, terminal auth, signalling
npm run build         # Vite client build + server tsc
```

Browser-level checks live in `e2e/`:

`browser.mjs` drives the guest app against a running daemon; use an owner link or an
admitted lobby session. Set `CODE_PAIR_ADMIN_TOKEN` for the root-switch and invite checks.

```bash
cd e2e && npm install          # puppeteer-core
node browser.mjs               # two real Chrome clients; see file header for env vars
node devices.mjs               # cross-device layout audit (phone → wide desktop)
node probe.mjs                 # geometry dump at small viewports (diagnostic)
```

`browser.mjs` exercises file loading, concurrent edits converging, presence, remote
cursors, a real shell, 401s, path-traversal rejection, the Share QR code, the mobile
layout, and one-use invite redemption under StrictMode. `devices.mjs` checks overflow, off-screen controls and tap-target sizes across
11 viewports.

## Platform notes

- Node 20+ (developed on Node 22, macOS arm64). `node-pty` is a native module;
  `scripts/postinstall.mjs` survives a failed rebuild and the daemon reports a
  terminal-unavailable capability instead of crashing.
- LAN access: use `--host 0.0.0.0` — the daemon lists every non-internal IPv4 address
  with a ready-to-open link, and warns that anyone on the network with the link has the
  access you granted. Open the port in your firewall.
- Keep TURN credentials out of the UI: they are returned by `/api/session` only to
  authenticated clients.

## License

MIT
