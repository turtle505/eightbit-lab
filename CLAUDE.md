# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

8-bit Lab (`eightbit-lab`): a local web app that runs several Claude Agent SDK sessions ("employees") in parallel and shows them as a pixel-art office. The manager (user) gives instructions, assigns task cards, approves tool calls, and tracks remote GPU jobs. UI text, prompts and README are in Korean — keep new user-facing strings in Korean.

## Commands

```bash
npm run dev          # backend (tsx watch, :8787) + Vite frontend (:5173, proxies /ws) → http://localhost:5173
npm run build        # vite build web → dist/
npm start            # backend serves dist/ + websocket → http://127.0.0.1:8787
npm test             # vitest run (server/test/units.test.ts)
npx vitest run -t "parsers"   # run a single describe/it by name
npm run typecheck    # tsc --noEmit over server, web, shared
```

No compile step for the server: it runs TypeScript directly via `tsx`, and imports use explicit `.ts` extensions (`allowImportingTsExtensions`). Persistence uses the built-in `node:sqlite` (`DatabaseSync`), so a recent Node is required. Auth comes from the local `claude` CLI login (Pro/Max subscription) — there is no API key.

## Architecture

**Single protocol file.** `shared/protocol.ts` defines every type that crosses the wire: `Snapshot`, `ServerMsg` (server→browser), `ClientMsg` (browser→server). Adding a feature typically means: add a message variant here → handle it in the `handle()` switch in `server/src/index.ts` → send it from `web/src/main.ts` / UI code.

**Backend data flow.**
- `server/src/index.ts` wires everything: loads config, constructs `Store`, `PermissionBroker`, `ServerRegistry`, `AgentManager`, `RoutineScheduler`, `UsageMonitor`; serves `dist/` and the `/ws` WebSocket. New clients get a full `snapshot`; afterwards only incremental messages.
- `server/src/bus.ts` is a global EventEmitter; anything calling `bus.send(msg)` is broadcast to all browsers. Components never talk to sockets directly.
- `server/src/db.ts` (`Store`): SQLite at `data/office.db` — tasks, per-employee sessions/cost/cwd, logs, routine state, jobs. Tests use `new Store(':memory:')`.

**Agents (`server/src/agents/manager.ts`).** Each role in `config/roles.yaml` becomes an `Employee` with an inbox. `instruct()` queues work; `pump()` enforces a global `maxConcurrent` (subscription rate-limit protection) via a FIFO — it counts employees *mid-turn*, not open sessions. Each employee keeps **one long-lived `query()`** (`LiveSession`) whose prompt is a `MessageQueue` (push-driven async iterable): `openSession()` builds it once (resuming the stored session id, `claude_code` preset + role prompt), `consume()` streams `SDKMessage`s into status/log updates, and each `result` ends one turn (`e.endTurn`). So only the first instruction pays process start / MCP connect; measured 49.6s → 1.0s. `stop()` calls `q.interrupt()` and keeps the session; `resetSession()` closes it and drops the id; an idle session closes after `office.sessionIdleMinutes` and the next instruction resumes it. Per-turn state (`extraAllow`, permission mode) is read from `e.current` rather than closed over, and `setPermissionMode()` switches a 🔒 turn. `total_cost_usd` is cumulative per session, so only the delta is billed (a resumed session's first result is the baseline). Tests inject `queryFn`. `status.ts` maps tool names to character states (typing/running/researching/remote) shown in the game. When a run tied to a task finishes, the task moves to `review` with the last assistant text as `result`.

**Lab-server guard.** `needsLabApproval()` (manager.ts) flags `mcp__lab__submit_job`/`cancel_job`/`fetch_results` and any Bash command with an `ssh`/`scp`/`rsync`/`sftp` command word. A `PreToolUse` hook (`onFailure: 'block'`) turns those into `permissionDecision: 'ask'` so they reach the approval card even in auto mode, unless the exact tool/command is in the role's `autoAllow` or an approved skill's `office-allow`. Read-only lab tools are unaffected.

**Auth (`auth.ts`).** `office.authToken` (empty = off, with a startup warning) gates the WebSocket (`verifyClient`) and every `/api` route but `/api/login`. Browsers POST the token to `/api/login` and get an HttpOnly SameSite=Strict cookie; scripts send `X-Office-Token`. `tokenMatches` hashes both sides before `timingSafeEqual`, so length and content don't leak. Unauthenticated page loads get `loginPage()` with 401.

**Origin checks.** `allowedOrigin()` (`origin.ts`, no side effects so tests can import it) gates both `/api` and the WebSocket (`verifyClient`): loopback host, port = backend or 5173, or no Origin at all (curl/local script). WebSockets bypass CORS, so without this any page the user opens could drive the office.

**Permissions.** Each employee runs in `auto` (SDK `permissionMode: 'auto'`: a classifier approves tool calls and only unclear ones reach `canUseTool`) or `ask` (`'default'`). The setting is DB `employee_perm` (UI toggle, `setPermission`) > role `permissionMode` > `office.permissionMode` (default auto), applied from the next run. A task with `requireApproval` (🔒, set in the task form or by `create_task`) always runs as `ask` — `effectivePermission` only tightens. An agent resuming an old session may not see a new MCP tool parameter (deferred tool schemas are cached in the session) until its session is reset. `canUseTool` auto-allows tools matching the role's `autoAllow` (exact name, or a server prefix like `mcp__office` covering `mcp__office__*` — see `isAutoAllowed`). Everything else goes to `PermissionBroker`, which emits an `approval` message and blocks until the UI answers or the run is aborted.

**Workspaces (`agents/workspace.ts`).** Role `cwd` wins; else if `researchRepo` is unset, everyone shares `workspaces/shared`; else `useWorktree` roles get a git worktree `workspaces/wt-<id>` on branch `office/<id>` of the research repo.

**In-process MCP servers (`server/src/mcp/`).** `labTools` (`mcp__lab__*`, every employee): GPU server listing, job submit/status/tail/cancel/fetch, backed by `compute/`. `officeTools` (`mcp__office__*`, only roles with `officeTools: true`, i.e. the secretary): office status, tasks, activity, routines, `create_task` delegation. `officeTools` reaches back into the app through the `OfficeApi` object that `index.ts` assigns to `agents.officeApi`.

**Hosts (`hosts.ts`).** `office.hosts` lists machines sessions can run on. `ssh: local` is the backend's own machine (SDK spawns normally); anything else is an ssh alias and `Host.spawner()` returns a `spawnClaudeCodeProcess` that runs `ssh -T <alias> 'cd <dir> && exec env K=V … <claude> <args>'` — `-T` because a tty corrupts stream-json, only `CLAUDE_*`/`ANTHROPIC_*` forwarded, `claudePath` absolute because non-login ssh lacks `~/.local/bin`. MCP servers, `canUseTool` and hooks still run in the backend and ride the same pipe. `sessions.hostId` (`sessionHostId()`, which tags local sessions `backend:<hostname>`) stops a session id being resumed on a machine that never recorded it. Remote sessions get no `additionalDirectories`.

**Compute (`server/src/compute/`).** A server with `ssh_host: local` uses `localExec` instead of `sshExec` (and `fetch_results` uses `cp`), for when the backend runs on that machine. `ServerRegistry` polls servers from `servers*.yaml` and tracks jobs through an adapter per `type: ssh | slurm` (shells out to `ssh <alias>`; key auth required). `onJobFinished` re-instructs the submitting employee to report results.

**Other backend pieces.** `routines.ts` + `cron.ts`: in-house 5-field cron (local time) that calls `agents.instruct`. Routine definitions live in the DB `routines` table (soft-deleted via `deletedAt`); `config/routines*.yaml` only seeds ids never stored before. They are created/edited/deleted from the UI (`saveRoutine`/`deleteRoutine`) or by the secretary (`mcp__office__create/update/delete_routine`, never auto-allowed; deleting asks for a second `confirm()` via `confirmApprove`).

**Office skills (`skills.ts`).** Routines normally run a skill instead of a long prompt: the secretary distills the manager's request into `workspaces/office-skills/skills/<name>/SKILL.md` (`save_skill`), a local plugin named `office` that every session loads via `query({ plugins })`, so it is invoked as `office:<name>`. A skill's `office-allow` frontmatter (exact tool names or `Bash(<prefix>*)`, see `matchesRule` — commands with shell metacharacters never match) is auto-allowed only during routine runs of that skill (`instruct(..., { extraAllow })`), and only while the file's sha256 matches the manager-approved one in `skill_approvals`; an edited skill needs re-approval in the routine panel. `usage.ts`: polls subscription usage (5-hour / weekly %) via an experimental Agent SDK call using an empty session; it must degrade to "unavailable" rather than throw.

**Providers (`providers.ts`).** A role with `provider: <id>` runs on a non-Claude backend from `office.providers` instead of the subscription. Only `kind: ollama` exists: `OllamaLink` keeps an `ssh -N -L localPort:127.0.0.1:remotePort <ssh_host>` tunnel (restart with backoff) and health-checks `/api/version` + `/api/tags` every 30 s (`provider` message). The run is the same `query()` with `env` from `ollamaEnv()` (Anthropic-compatible base URL, every model alias → the chosen model; env replaces process.env, so it spreads it) and no office-skills plugin. Provider employees bypass `maxConcurrent` with one slot per provider (`nextRunnable`), don't add to cost, and the model picked in the UI is stored in `provider_models`. A new backend kind needs its own runner, not just env.

**Frontend (`web/`, vanilla TS + Vite, no framework).** `main.ts` owns the WebSocket, a single `UIState`, and applies `ServerMsg`s then calls `renderAll()`. Three views over the same state: the canvas game (`game/office.ts`, sprites drawn in code in `game/sprites.ts`), the table-based console (`ui/console.ts`), and the reports browser (`ui/reports.ts`, styled as console via `body.view-console.view-reports`). `ui/panels.ts` holds shared panels; `ui/view.ts` switches views by physically moving shared panel elements (`approvals`, `employee`, `routines`, `jobs`, `report-feed`) into `[data-slot]` containers of the active view (the reports view has no slots). Markdown goes through `ui/markdown.ts` (`marked` + `DOMPurify`) — never insert agent text as HTML any other way.

**Today's to-dos (`obsidian.ts`, `todos.ts`, `ui/todos.ts`).** With `obsidian.vault` set (in `office.local.yaml`), today's daily note is parsed (`parseDaily`: Schedule / Active Project / Study sections → `**project**` blocks → `- [ ]` items with `↻N` carry markers, tab-indented children and description bullets) and polled every 3 s. Edits are single-line ops (`applyTodoOp`: toggle / edit / add / delete) that carry the line number *and* its original text, so anything changed meanwhile in Obsidian is refused instead of overwritten; writes go through tmp + rename and keep the file's line endings.

**Attachments (`attachments.ts`).** The browser uploads raw bytes to `POST /api/upload?name=` (requires `X-Office-Upload: 1`; a non-localhost `Origin` is refused) → `workspaces/attachments/<date>/<id>-<safeName>`, plus a `textutil` `.txt` for docx/rtf/…; `GET /api/attachments/<id>` serves them (only DB ids). `createTask`/`instruct` carry `attachmentIds`; tasks link files through `task_attachments` (shared across tasks, e.g. when the lead forwards them via `create_task.attachments`). `attachmentBlock()` appends the absolute paths to the prompt, and every session gets the folder via `additionalDirectories`. Uploads never linked or used are deleted after 24 h. Vite proxies `/api` in dev.

**Reports.** `reports.ts` scans `.md` files under `workspaces/<desk>/reports` (+ `office.reportDirs`) every 5 s; the browser can only `getReport` paths from the last scan. New/changed files and every finished run (`runFinished` bus event from `AgentManager`, labelled via `instruct(..., { label })`) become `feed` rows (DB) shown in the `📨 보고` panel (`ui/feed.ts`); edits to the same file within 10 min update its card instead of adding one.

## Config

`config/*.yaml` are committed defaults. Personal settings go in git-ignored `config/<name>.local.yaml`, layered by `config.ts`: `office.local.yaml` overrides keys; employee/routine/server lists merge by `id` (servers by `name`) via `mergeByKey`. Real server definitions belong in `servers.local.yaml` (copy from `servers.example.yaml`). Never put research repo paths, hosts, or personal routines into the committed files. `data/` and `workspaces/` are runtime state and git-ignored.
