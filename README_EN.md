# dsh-dashboard

A workbench plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) web interface: adds a sidebar, a bottom panel, and a set of file/task tool surfaces to the session view. Single package with host/client halves, organized per the official DSH plugin conventions; the host source is never modified.

**Capabilities**: file management, editing with multi-format preview, embedded browser, real terminal, Git panel, background-task view, and a `ctx.dashboard` service through which third-party plugins register extension pages and file viewers.

Derived from [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (forked at v0.10.3) and evolved independently since; the upstream integration docs continue in this repo's [AGENTS.md](./AGENTS.md).

<div align="center">

<a href="./README.md">中文</a> · English

</div>

## Overview

The DSH session view natively provides a conversation stream and a trajectory column; long-running tasks leave workspace files without a surface for viewing, editing, and cross-referencing. This plugin mounts a VSCode-style workbench to the right of the session view: the sidebar and the bottom panel each hold an independent tab system with pane splitting and drag support; all state (layout, panes, tabs, panel toggles) is persisted per session.

Technical approach:

- **No host intrusion.** The plugin ships as an independent npm package referenced by the profile and mounts through the cordis patch mechanism; DSH source is untouched and its build is never depended on.
- **Host/client halves.** The host half serves session-scoped HTTP/WebSocket APIs (filesystem, git, pty, media routes), all behind the same trust fence as the host's `/api`; the client half attaches to the UI through the slot mechanism.
- **On-demand loading.** Heavy dependencies (Univer, docx-preview, pptx-renderer, CodeMirror, xterm) are chunked per feature and served through the plugin's own route on first use; the core bundle is ~325KB.

See the releases page for a demo video and screenshots.

## Features

### Files and editing

- **Explorer**: lazy-loading directory tree (root = session cwd); click opens the file in the sidebar; a hover button at end of line inserts an `@file` reference into the composer; right-click copies relative/absolute paths.
- **Edit and preview**: CodeMirror 6 multi-language syntax highlighting with Ctrl/Cmd+S atomic save; inline preview for images, Markdown (preview/edit toggle), HTML (sandboxed iframe, relative resources loadable), PDF, Word, Excel, and PowerPoint; unsaved drafts survive tab switches.

### Workbench

- **Pane system**: drag tabs to split/merge panes (cross-panel dragging supported); dividers adjust ratios; the two panels share a corner with bidirectional resize.
- **Bottom panel**: a second workbench isomorphic to the sidebar, squeezing only the middle agent output area; when the sidebar is collapsed it extends across the conversation and trajectory columns; the first expand can auto-open a terminal (disableable in settings).
- **Composer collapse**: the input card folds into a single line — "+ attach" and the permission chip (icon-only) on the left, a single-line input in the middle (growing line-by-line as content wraps, then scrolling internally past the expanded-state cap), and the expand button, model selector, context-occupancy ring, and send on the right. The fold animates (box-height FLIP with fades), honors the reduced-motion preference, and persists.
- **Session isolation**: layout/pane/tab/panel state persisted per session in localStorage; stale state is purged automatically.

### Extension surfaces

- **Browser**: embedded browsing tabs (multiple), back/forward/refresh; content renders in an opaque-origin sandboxed iframe (see Security); the UI shows sandbox status live; sites refusing embedding (X-Frame-Options) get a reason panel.
- **Terminal**: xterm.js + node-pty real shell (max 3 UI instances per session), tab keep-alive with reconnect/replay; optionally injects 8 `terminal_*` tools for the model.
- **Git panel**: real diffs and diff tabs, lazy-loaded history, stage/discard/commit/revert/cherry-pick.
- **Background tasks**: the main session's full agent topology with click-through to execution records; the same page aggregates the current tree's background jobs (type badges + exit codes; live output is a non-consuming peek that does not disturb the model's `job_output`; force-kill after a confirmation step).
- **Mobile**: below a 768px viewport only the sidebar remains; bottom-panel tabs merge into its tab strip presented as a full-width drawer.

### Platform services

- **`ctx.dashboard` service**: third-party plugins register sidebar pages (tabs) and file viewers; the 7 built-in tabs and 9 viewers register through the same service. Renamed with the package in v0.10.4 — the legacy `ctx.betterSidebar` id still resolves as a compatibility alias, so existing consumers need no changes.
- **Declarative settings**: the settings page renders a registry-driven feature inventory (each item toggleable); feature-level secondary settings edit in a native dialog.
- **i18n**: UI copy follows the DSH language setting (zh/en); the host preference takes priority over the browser language and switches live.

## Installation (from source)

Built and installed from source. Prerequisites: DSH installed (`dsh web` boots), Node.js ≥ 20, pnpm ≥ 10.

```sh
# 1. Clone and build
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git ~/Code/dsh-dashboard
cd ~/Code/dsh-dashboard && pnpm install && pnpm build

# 2. Allow node-pty / protobufjs build scripts (pnpm 11 blocks them by default; skip on pnpm 10)
cd ~/.dsh/profiles/web && pnpm approve-builds --all

# 3. Point the dependency at the local clone (package.json dependencies)
#    "dsh-dashboard": "link:/home/you/Code/dsh-dashboard"

# 4. Append the mount line (cordis.patch.yml)
#    - insert:
#        - id: dashboard
#          name: 'dsh-dashboard'

# 5. Install and restart
pnpm install
```

Restart DSH and hard-refresh (Cmd/Ctrl+Shift+R) afterwards.

Update: `git pull && pnpm install && pnpm build`, then restart DSH (client-only changes need only a hard-refresh).

<details>
<summary>Windows (PowerShell) equivalent</summary>

```powershell
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git ~/Code/dsh-dashboard
cd ~/Code/dsh-dashboard; pnpm install; pnpm build

cd ~\.dsh\profiles\web
pnpm approve-builds --all
# package.json dependencies: "dsh-dashboard": "link:<absolute path of the clone>"
# cordis.patch.yml append:
#   - insert:
#       - id: dashboard
#         name: 'dsh-dashboard'
pnpm install
```

Quote the link: value if the path contains spaces. Restart DSH, then hard-refresh.

</details>

<details>
<summary>npm channel (upstream published the old name; this repo is not on npm)</summary>

The upstream [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) publishes `dsh-better-sidebar` to npm; this repo (renamed to dsh-dashboard) is **not published to npm** — install from source. The one-click scripts (`scripts/install.sh` / `scripts/install.ps1`, written for the npm channel) remain in the repo for reference or for use after publishing yourself.

</details>

<details>
<summary>Troubleshooting</summary>

| Symptom | Cause and fix |
|---|---|
| `Ignored build scripts` | pnpm 11 blocked build scripts. Run `pnpm approve-builds --all`. |
| `minimum release age` / version < 24h | pnpm blocks dependency versions younger than 24 hours. Add the package under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, or wait. |
| "profile directory not found" | Run `dsh web` once to initialize `~/.dsh/profiles/web`. |
| Two sidebars on the page | Double mount: duplicate hand-written insert lines in `~/.dsh/profiles/web/cordis.patch.yml` (e.g. the upstream legacy `id: better-sidebar` alongside `id: dashboard`) — delete the redundant one. |
| Terminal fails on Windows | `node-pty` relies on prebuilt binaries; install a build toolchain (VS Build Tools) if none matches your Node version. Mainstream versions are covered. |
| No bash / curl on Windows | Use the PowerShell equivalent steps, or install Git Bash / WSL. |

</details>

<details>
<summary>Development</summary>

Clone, then `pnpm install && pnpm build`; daily loop with `pnpm watch` (tsdown incremental) + `pnpm test`. Keep the profile dependency as a `link:` to your working tree during development; client-only changes take effect on hard-refresh, host-half changes need a DSH restart.

</details>

<details>
<summary>Install via plugin-registry (either this or the main flow)</summary>

Prerequisite: DSH with [plugin-registry](https://github.com/dsh-external/plugin-registry) integrated (`dsh registry` available). **Enabling both channels double-mounts** (the Node half loads twice; the page gets two sidebars).

```sh
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git && cd dsh-dashboard
pnpm install && pnpm build
node scripts/package-registry.mjs   # assemble the registry/ staging (manifest + artifacts + README; not committed)
dsh registry install ./registry     # install (disabled by default)
dsh registry enable dsh-external/dsh-dashboard
```

Update: `git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`. Remove the other channel's mount before switching.

</details>

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Save edits | `Ctrl/Cmd + S` |
| Git commit | `Ctrl + Enter` |
| Close tab | Middle mouse button |
| Split / merge panes | Drag tab to pane edge / middle |
| Reference file in composer | Hover the `@file` button at end of line |
| Copy file path | Right-click row → copy relative/absolute path |

## Service: registering pages and file viewers

Since v0.4.0 the plugin exposes the `ctx.dashboard` service (renamed with the package in v0.10.4; the legacy `ctx.betterSidebar` id still resolves as a compatibility alias), through which third-party plugins register sidebar pages and file viewers:

```ts
import type {} from 'dsh-dashboard'  // triggers the ctx.dashboard type merge
export const inject = ['dashboard']  // the legacy 'betterSidebar' alias also works
export function apply(ctx: Context) {
  ctx.effect(() => ctx.dashboard.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

Full integration docs (`TabDescriptor` / `FileViewerDescriptor` field definitions, matching algorithm, HMR lifecycle, declarative settings): see [`AGENTS.md`](./AGENTS.md).

## Development and build

```sh
pnpm install      # @deepseek-ai/* published to npm (^0.1.0-rc.6), resolves directly
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest (includes the manifest consistency guard; build first)
pnpm watch        # tsdown --watch
```

**Architecture**: a single npm package with host/client halves. The host half (`src/index.ts`) serves `/sidebar/api/*` JSON APIs, the `/sidebar/file` media route, the `/sidebar/html` preview route, and the `/sidebar/ws/terminal` WebSocket (filesystem / git / pty / preview — all session-scoped behind the trust fence); the client half (`src/client/index.tsx`) owns the portal sidebar, views, and interception; state persists per session in localStorage. Runtime has no dependency on npm or a source checkout (`@deepseek-ai/*` comes from the web profile).

## Security

- Routes sit behind the Host-header trust fence (same as `/api`); `fs.write` is atomic; media/preview routes serve only files inside the session cwd; git only shells out to the CLI and never sets identity.
- HTML preview and browser tab content render in **opaque-origin sandboxed iframes**: no `allow-same-origin` / `allow-top-navigation`, `no-referrer`, all permission policies disabled; the `/sidebar/html` route adds a CSP `sandbox` plus size/path bounds; the address bar rejects `javascript:` / `data:` / `file:` and local addresses such as localhost.
- The UI shows sandbox status live (red warning when off) and can temporarily unlock the current page; the settings page can disable the sandbox per feature (off by default with a warning) — when off, content shares the UI's origin; recommended only for fully trusted content.

## Known limitations

- Git has no push/pull/fetch; no file watcher (manual refresh); tool-inline file-open buttons cannot be intercepted.
- Dragging a terminal tab to another pane remounts it (the shell restarts).
- `.xlsx` preview does not preserve cell styles (SheetJS community edition); Office/PPTX preview inlines into the client bundle (~23MB), slower on first load.
- The browser sandbox has no login state and third-party cookies are restricted; some sites need popup login; sites refusing embedding via `X-Frame-Options` / `frame-ancestors` (e.g. arxiv.org) show a reason panel (with "Open in browser"); in-iframe navigation does not enter the back stack.
- HTML preview renders the saved file (not unsaved drafts).
- No bottom panel on mobile (<768px): entering a narrow viewport merges its tabs into the sidebar once; the desktop bottom panel is wide-viewport only.

## Platform support

Windows / Linux / macOS (Linux validated daily; the rest covered by unit tests). `node-pty` prefers prebuilt binaries; otherwise a build toolchain is required (Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT).

## License

MIT (see [LICENSE](./LICENSE)).
