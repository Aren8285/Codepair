# CodePair

A hybrid **local-host collaborative IDE**. One machine (the **Host**) runs a small daemon
that exposes a real project directory and a real terminal to a browser UI. Other people
(**Remote Clients**) open a link, authenticate with a session token, and edit the Host's
actual files, watch terminals run on the Host machine, and talk over WebRTC.

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
  screen can be sent fullscreen from a button on the tile itself.
- **Sandboxed paths** — every client-supplied path passes lexical *and* realpath
  containment checks; sensitive names (`.git`, `node_modules`, `.env*`, keys) are hidden.
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
| `--editor-token <token>` | — | Extra token with editor access (no `session.admin`) |
| `--viewer-token <token>` | — | Extra token with view-only access |
| `--no-terminal` | terminal on | Explicit Host opt-out of remote shells |
| `--tunnel <provider>` | off | `cloudflare` or `ngrok` public tunnel |
| `--ice-servers <json>` | Google STUN | JSON `RTCIceServer[]`, max 8 entries |
| `--allow-origin <origin>` | — | Extra origin allowed to open WebSockets |
| `--dev-client <url>` | — | Vite origin used in the printed link and origin check |
| `--quiet` | off | Less startup output |

Environment equivalents: `CODE_PAIR_MODE`, `CODE_PAIR_TOKEN`, `CODE_PAIR_PORT`,
`CODE_PAIR_ADMIN_PORT`, `CODE_PAIR_HOST`, `CODE_PAIR_ALLOW_ORIGINS`, `CODE_PAIR_DEV_CLIENT`,
`CODE_PAIR_TERMINAL=off`, `CODE_PAIR_TUNNEL`, `CODE_PAIR_ICE_SERVERS`,
`CODE_PAIR_MAX_FILE_BYTES`, `CODE_PAIR_SAVE_DEBOUNCE_MS`, `CODE_PAIR_IGNORE`,
`CODE_PAIR_CLIENT_DIST`.

## Roles and tokens

Every token maps to exactly one role, and the role decides what that session may do:

| Role | Capabilities | Can do |
| --- | --- | --- |
| `owner` | `fs.read`, `fs.write`, `fs.delete`, `term.use`, `call.join`, `session.admin` | everything |
| `editor` | `fs.read`, `fs.write`, `fs.delete`, `term.use`, `call.join` | edit, delete, terminal, calls |
| `viewer` | `fs.read`, `call.join` | read files, receive live edits, join calls |

- `--token` keeps its historical meaning: the **owner** in `read-write`, a **viewer** when
  `--mode read-only` is set.
- `--editor-token` and `--viewer-token` add roles to the same session. The daemon prints one
  link per token, labelled with the role it grants.
- Tokens must be distinct; the daemon refuses to start when two roles share one.
- `--no-terminal` still wins over every role: no token gets a shell.
- A viewer's edits are dropped server-side and the UI explains why, but their cursor and
  presence still reach everyone else.

## Host console (admin API)

The Host can move the session to another project at runtime through a separate,
loopback-only listener. It is a different `http.Server`, bound to `127.0.0.1` on
`--admin-port` no matter what `--host` says, and none of its routes exist on the
guest port (the guest app answers `/admin/*` with a 404).

- Its token is generated fresh on every start (`crypto.randomBytes(32)`, base64url) and
  printed once, on the `Host console:` banner line, inside the `#admin=` fragment. It is
  never returned in a response body.
- A request must carry that token as `Authorization: Bearer …`, a `Host` header of
  `127.0.0.1:<admin-port>` or `localhost:<admin-port>`, no `Origin` unless it is that same
  loopback origin, and no `X-Forwarded-For` / `X-Forwarded-Host` / `Forwarded` /
  `CF-Connecting-IP` / `X-Real-IP`. Responses are `no-store` and never CORS.
- Guest tokens are rejected on this listener and the admin token is rejected on the guest
  listener. Every route requires the `session.admin` capability.

| Route | Purpose |
| --- | --- |
| `GET /admin/api/state` | active session (`id`, `rootName`, `rootPath`, `createdAt`) and open handle counts |
| `GET /admin/api/fs/list?path=&showHidden=0\|1` | folder picker: directories only, realpath'd, hidden excluded by default, 500-entry cap |
| `POST /admin/api/session/root` | `{ "path": "…", "confirmBroad": false }` → switches the project root |

Switching validates the path first, builds the new session before touching the old one, swaps
atomically, then disposes the old one: dirty documents are flushed to their **old** absolute
paths, external-change pollers stop, every PTY is killed and its rc directory removed, and
document/terminal sockets close with code `4410` while signalling stays connected.

The filesystem root, the home directory and its parents, and `~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config` are always refused: with home as the root, those credential directories are
ordinary files that every guest could read. System directories (`/etc`, `/usr`, `/bin`,
`/sbin`, `/var`, `/System`, `/Library`, `/private`, `/dev`, `/proc`, matched exactly after
realpath) are refused unless the request sets `"confirmBroad": true`.

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

1. **Holding a token grants that token's role** — `owner` and `editor` may edit and, unless
   `--no-terminal`, run commands as the Host user; `viewer` may only read. Share tokens out
   of band; rotate by restarting the daemon (or passing different `--token` values). The
   client drops the stored token on a 401.
2. **HTTP auth**: every `/api/*` route except `/api/health` requires
   `Authorization: Bearer <token>`; comparison hashes both sides with SHA-256 and uses
   `timingSafeEqual`.
3. **WebSockets**: the token is sent as a subprotocol (`["codepair", token]`), so it
   never appears in the URL. Origin is checked on every upgrade.
4. **Path sandboxing**: `PathGuard` rejects `..`, absolute paths, NUL bytes and symlink
   escapes with independent lexical and `realpath` checks. Errors never leak absolute
   server paths.
5. **Terminal**: the PTY gets a scrubbed environment (no daemon credentials), generated
   rc files hide host history and refuse `cd` out of the root. This is *not* an OS
   sandbox — a determined operator can still reach anything the Host user can. For hard
   isolation, run the daemon in a container or keep the session `read-only`.
6. **Prefer `read-only`** for demos and public tunnels, a VPN over a public tunnel, and
   HTTPS (the built-in tunnel provides it) so tokens and media never cross plaintext.

No CSRF tokens are needed: state-changing routes require a bearer token a cross-site
page cannot read, and JSON bodies require a CORS preflight.

## Known issues

- **Concurrent typing at the same spot can briefly interleave** — when two people type
  the same line region at once, CRDT ordering may briefly place their characters in a
  different order (it can look like content shifted by a line while one side is still
  catching up). Both views settle as soon as both clients sync, and no content is
  duplicated or lost: two-client stress tests (same-region typing bursts, mid-typing
  disconnects, reconnects during the other's typing) all converge and persist correctly.
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
  and are not permanent — the URL dies with the process.
- **Windows is unverified**: symlink checks and shell rc generation are written for POSIX
  shells.
- **Java/C/C++ diagnostics are not provided** — Monaco ships syntax colouring but no
  language server; TypeScript/JavaScript, JSON, CSS and HTML get full bundled workers.

## Testing

```bash
npm run typecheck     # tsc for server + client
npm test              # Vitest: sandboxing, API, doc sync, terminal auth, signalling
npm run build         # Vite client build + server tsc
```

Browser-level checks live in `e2e/`:

```bash
cd e2e && npm install          # puppeteer-core
node browser.mjs               # two real Chrome clients; see file header for env vars
node devices.mjs               # cross-device layout audit (phone → wide desktop)
node probe.mjs                 # geometry dump at small viewports (diagnostic)
```

`browser.mjs` exercises file loading, concurrent edits converging, presence, remote
cursors, a real shell, 401s, path-traversal rejection, the Share QR code and the mobile
layout. `devices.mjs` checks overflow, off-screen controls and tap-target sizes across
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
