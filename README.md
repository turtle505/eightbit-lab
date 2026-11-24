**English** | [한국어](README.ko.md)

# 🧬 8-bit Lab

`eightbit-lab` — a pixel-art office of AI agents you hand research and day-to-day work to.

An **AI agent office** for protein-structure deep-learning research. It runs several Claude Code agents (employees) in parallel,
and in a pixel-art game office you watch their status while giving instructions, approving actions and managing remote GPU jobs.

## Running

```bash
npm install
npm run dev          # backend (8787) + frontend (5173) together → http://localhost:5173
# or deployment mode
npm run build && npm start   # → http://127.0.0.1:8787
```

Authentication reuses this Mac's `claude` CLI login (Pro/Max subscription). Data is stored in `data/office.db` (SQLite).

## Usage

| What you want | How |
|---|---|
| Give an instruction | Click an employee (or number keys 1–5) → type the instruction in the input box at the bottom |
| Assign a task | Add a card on the task board → drag the card onto an employee in the office (or use the card's dropdown) |
| Approve | The employee raises a hand with a `!` → approve/deny in the yellow approval panel |
| Check results | When a task finishes, its card moves to "Review"; expand `Report`, check it, then "Done" |
| Today's to-dos | `✅ Today's to-dos` panel: check, edit (double-click), add (＋, ↳) and delete checkboxes of your Obsidian daily note. Changes go straight into the note file, and edits made in Obsidian show up within a few seconds (requires the `obsidian` setting in `office.local.yaml`) |
| Report feed | `📨 Reports` box: whenever a report file is saved or modified, or a run finishes, it stacks up at the bottom like a chat (Markdown) |
| Re-read reports | `Reports` tab at the top: browse .md files under `workspaces/<employee>/reports/` as a folder tree, with unread counts. `?view=reports` opens it in its own window |
| Stop / new session | `Stop` and `New session` in the employee panel (sessions continue by default) |
| Scheduled work | Routine panel: `+ New routine` to add, edit, delete (with confirmation), enable/disable, `Run now` — or just ask the assistant |
| Switch views | `Game / Console / Reports` buttons at the top right, or <kbd>`</kbd> (last view is remembered; `?view=console` opens it directly) |

**Subscription usage**: the top bar shows your Claude subscription's **session (5-hour) and weekly usage %** and reset times (plus per-model weekly limits if any). Refreshed every 3 minutes, when an employee finishes work, and on click. It queries through an empty session that uses no tokens; since this is an experimental SDK API, it may show "Usage —" if that changes. The per-employee figure is not a % of the limit but **that employee's share of the whole office's usage**.

**Console view**: a work-oriented view of the same data as the game, as tables. Employee table (status, current activity, task, session, cumulative usage), task table (change status/assignee in place, expand a row to see the instruction and report), activity feed across all employees (filter by employee), approval requests (always shown).
Shortcuts: <kbd>1</kbd>–<kbd>5</kbd> select employee · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>/</kbd> instruction input · <kbd>a</kbd>/<kbd>d</kbd> approve/deny the first approval request · <kbd>Esc</kbd> deselect.

Character states: ☕ lounge = idle · typing at the desk = working (monitor colour: blue editing / green running commands / sky blue web research) ·
`...` = thinking · hand raised with `!` = waiting for approval · walking to the server room = remote GPU work · sparkle = done.

## Configuration

**Put personal settings in `config/<name>.local.yaml`** (not committed to git). They are layered on top of the default files.
`office.local.yaml` overrides key by key; for the employee, routine and server lists, entries with the same `id` (`name` for servers) are overridden and new ones are added.
Anything that shouldn't be public — research repo paths, servers, personal routines — goes into `.local.yaml`.

```yaml
# example config/office.local.yaml
researchRepo: ~/research/my-protein-model
maxConcurrent: 4
```

- `config/office.yaml` — number of employees working at once (`maxConcurrent`, subscription rate-limit protection), model, research repo path
  - If you set `researchRepo`, the model/data engineers each get a **git worktree** of that repo (branch `office/<id>`) and work without conflicts
  - If empty, everyone works in `workspaces/shared`
- `config/roles.yaml` — employee definitions: role prompt, tools allowed without approval (`autoAllow`), character colours
- `config/routines.yaml` — initial scheduled routines (5-field cron, this Mac's local time, only run while the backend is up). Imported into the DB on first run; later changes are made through the UI/assistant
  - Default: weekdays 09:00 morning briefing, weekdays 18:00 evening daily report (on) · Fri 17:00 weekly review, weekdays 08:30 Obsidian daily note (off)
- `config/servers.local.yaml` — GPU servers (copy `servers.example.yaml`, excluded from git). Each server has `type: ssh | slurm`
  - `ssh_host` is a `~/.ssh/config` alias and **must connect without a password (key auth)**
  - Employees use servers through the `mcp__lab__*` tools (list_servers, gpu_status, submit_job, job_status, tail_log, cancel_job, fetch_results)
  - When a job finishes, the employee who submitted it is notified automatically and reports the results

### Language

- Set `language: ko` or `language: en` in `config/office.local.yaml` (default `en`). It sets the language of the UI and the language agents report in.
- The `KO/EN` button in the header switches it at runtime; the choice is remembered and takes precedence over the config file.
- Agents always get English prompts; only the language they report in follows this setting.
- Existing logs and feed entries stay in the language they were written in.
- Routines already stored in the DB are not retranslated (`config/routines.yaml` only seeds ids the DB hasn't seen).

## Employee sessions

Each employee keeps **one open** Claude Code session, and instructions are pushed into it. A new process is not started for each instruction.

- Only the first instruction is slow (process start, session load, MCP connection). After that it starts right away — measured on assistant 2: **49.6 s → 1.0 s**.
- An instruction sent while the employee is working is handled **as soon as the current turn ends** (the turn is not cut short).
- After `sessionIdleMinutes` (default 30) without work the session closes, and the next instruction reopens it, **resuming the conversation**.
- **Stop** cuts only the current turn and keeps the session alive. To clear the context too, use the **New session** button.
- Sessions that are merely open and idle don't count towards `maxConcurrent` (employees working at once). Only employees currently in a turn count.
- The employee panel and console table show `🟢 session open` / `⚪ session idle`.

## Project sessions

In the **Projects** tab, pick a host and a folder, and a Claude Code session opens in that folder. One project can run several sessions, independent of each other
(the same as `ssh <host>`, `cd ~/project/<name>` and starting several `claude`s).

- The folder **must already exist**. The office doesn't create it. The input lets you pick a subfolder of that host's `projectRoot`.
- Each session can have a **name** (empty = "Session N"). Rename it later with the same ✏️ button as employees.
- Each session has its own log and input box. Like employees, sessions persist, and approval cards and the lab-server guard apply the same way.
- By default a session lives **only in the tab**. Press **"Bring to office"** and it gets a free desk and appears as a character in the game view; take it out and the desk is returned.
  You only bring in what you want to see, so even with many sessions open, the office shows just the ones you picked.
  Declaring it as an employee in `roles.yaml` with `host` + `cwd` still works too.
- Sessions don't appear on the task board or in assignee dropdowns. Finished work shows up in the report feed (📨).
- Sessions of the same project share a shirt colour family, so they group at a glance.
- Closing a session discards its conversation (the folder's files stay). Archiving a project closes all its sessions.
- They use the subscription, so they count towards `maxConcurrent` as well.

## Running sessions on other machines / moving the backend

List machines under `hosts` in `config/office.local.yaml` and give an employee or project `host: <id>`, and its Claude Code session runs on that machine.

```yaml
hosts:
  - { id: desktop, name: "🖥 desktop", ssh: local, projectRoot: "~/project" }
  - { id: gpu1, name: "🧮 gpu1", ssh: gpu1, projectRoot: "~/project", claudePath: "/home/me/.local/bin/claude" }
```

- `ssh: local` = the machine the backend runs on. Anything else is an alias from `~/.ssh/config` (key auth required).
- **Connections per minute**: `sshPerMinute` (default 5). For a per-server value, set `sshPerMinute` on the `hosts` entry (`0` = no limit for that server).
  **The `ssh`, `scp` and `rsync` that employees run through Bash share the same limit** — over it, the call is denied right away without even an approval card, and the employee is told to retry in a few seconds.
  The host badge shows `ssh per minute 3/5` as a tooltip, and above 80% of the limit a visible `⏳ 4/5` appears.
- (What follows are the mechanisms that actually enforce that limit)
- **Connection limit details**: `sshPerMinute` (default 5). Caps the ssh/scp the office opens to one host at that many per minute.
  Health checks and GPU polling skip the round when over (one skipped round doesn't mark the server as down), and opening a session waits until a slot frees up.
  `ssh`/`scp` that employees run directly through Bash go through a manager approval card every time anyway.
- **Mind the connection count**: shared servers sometimes ban clients that open ssh/scp too often. So **short, frequent commands** such as health checks, folder listings and GPU polling
  **share one ssh connection per host** (`ControlMaster`, sockets in `data/ssh/`). Sessions deliberately use their own connections — so one dropping doesn't take the rest down with it.
  **A host's health is checked only once, at startup.** While it stays reachable, it isn't poked periodically — an idle server gets zero connections.
  (Only after a failed connection does it retry with growing intervals; it also re-checks when opening a session and via the ↻ button in the employee panel.
  The trade-off is that the badge can go stale: if a server goes down, you won't know until something uses it.)
- **Use an absolute path for `claudePath`**: non-interactive ssh usually doesn't put `~/.local/bin` on PATH.
- Each machine needs its own claude CLI install and subscription login. It's checked with `claude --version` every 30 seconds, and sessions don't start on a dead machine.
- A session ID only means something on the machine that holds its history. If you move an employee to another machine or **move the backend itself**, it automatically starts in a new session.
- Remote sessions can't read attachments (the files are on the backend's disk). `mcp__lab__fetch_results` also downloads to the backend's disk.

**To move the backend to a server**: `git clone` → `npm ci` → `npm run build` → see `deploy/eightbit-lab.service`.
rsync `data/office.db` and `workspaces/` and tasks, routines and attachments carry over (attachment paths are stored relative to `workspaceRoot`).
In that server's `servers.local.yaml`, set itself to `ssh_host: local` so it doesn't go through ssh.
To keep using the Obsidian to-do panel, sync the vault to that server (Syncthing etc.) and point `obsidian.vault` at the copy.
**Don't run it on the Mac and the server at the same time** — routines would run twice.

## Access lock (`authToken`)

Put a token in `config/office.local.yaml` and the office is locked. Leave it empty and it isn't (at startup it prints a warning along with a token you could use).

```yaml
authToken: "a-long-random-string-here"
```

- **Browser**: enter it once on first visit and it's remembered in a cookie (HttpOnly, SameSite=Strict).
- **Scripts / curl**: the `X-Office-Token: <token>` header.
- Checked on both the WebSocket and `/api`; both sides are hashed before comparison, so neither length nor timing leaks.

**Why it's needed**: the backend listens only on loopback, but anyone who can SSH into that machine can reach the port.
If `authorized_keys` holds several keys, "people who can log in to the server" and "people who can control the employees" become the same group. The token separates the two.

## Access scope

The backend binds only to `127.0.0.1`, and accepts browser requests **only when the Origin is the office itself or the vite dev server (5173)** (both WebSocket and `/api`).
CORS doesn't apply to WebSockets, so without this check any web page the manager has open could attach to `ws://127.0.0.1:8787/ws` and instruct employees or click approvals on their behalf.

## Attachments

Pick or drag-and-drop files onto 📎 in the task form (`Attach` in the console) or onto an employee's instruction box to attach them (50 MB per file).
Files are stored in `workspaces/attachments/<date>/`, and a list of `#id name (size, type): absolute path` is appended to the assigned employee's instruction. Every employee session can read this folder.

- csv, txt, json, images (png/jpg/gif/webp) and pdf are read as is. The local model (assistant 2) can read images too.
- For docx, doc, rtf, odt and html, macOS `textutil` makes a `.txt` conversion next to the upload and its path is given as well. xlsx is read by the employee with pandas/openpyxl.
- The lead hands received attachments to the assignee via `attachments: [id]` in `create_task`. The 📎 link on a task card opens the original.
- Uploads not attached to a task or instruction are deleted after 24 hours.

## Permissions: auto mode / ask for approval

- Employees work in **🤖 auto mode** by default. Tools the model classifier deems safe run right away; only unclear ones come up as approval cards.
  Switch per employee with the `🤖 Auto` / `✋ Ask` button in the employee panel's title bar (applies from the next instruction). The default is `permissionMode` in `office.yaml`.
- **Calls that reach a lab server always show an approval card, even in auto mode** (`submit_job`/`cancel_job`/`fetch_results`, and Bash commands containing `ssh`, `scp`, `rsync` or `sftp`).
  This is so that, even if an employee falls for hidden instructions while reading the web or papers, a single classifier decision can't run commands on a GPU server.
  Read-only tools (`gpu_status`, `job_status`, `tail_log`) stay automatic, and listing something exactly in `autoAllow` or an approved skill's `office-allow` makes it an exception.
- If you tick **🔒 Require approval** on a task card, that task asks for approval for every tool outside `autoAllow`, even if the assignee is in auto mode.
  The lead hands off work involving deletion/overwriting, git push, cancelling or bulk-submitting GPU jobs, or sending data outside with `requireApproval: true`.

## Employees

| id | Seat | What they do |
|---|---|---|
| `lit` | row 1 | Paper and web research |
| `eval` | row 1 | Metric computation and interpretation, figures and reports |
| `aide1` | row 1 | Research aide — no speciality, takes whatever is handed over |
| `aide2` | row 2 | Research aide |
| `sec` | row 2 | Routines, office tools, organising reports |
| `exec` | row 2 (👑) | Lead engineer — does implementation, data and analysis directly, submits GPU jobs, and hands out work |

The six employees fill a 3-column, 2-row grid; project sessions brought into the office sit from the row below (the room grows as rows are added).

The **`common:`** block at the top of `roles.yaml` is prepended to every employee's prompt (project sessions included) —
shared rules such as honest reporting, reading before changing, lab server etiquette and report format are managed in one place.

If you remove a role from `roles.yaml`, task cards assigned to that person don't disappear; they **return to unassigned** (those in progress go back to to-do).

## The assistant (Hana)

Reception seat next to the manager's desk. Sees the whole office through the `mcp__office__*` tools:
`office_status` (staff, jobs, servers), `list_tasks`, `office_activity` (per-employee activity over the last N hours), `list_routines`, `create_routine`/`update_routine`/`delete_routine` (routine management), `create_task` (delegate to another employee).
Delegation and routine changes **need manager approval** by default, and deleting a routine shows an extra confirmation dialog when approved.

### Routine = one skill run
Tell the assistant "I want a routine that does X every Friday at 5" and, after asking a few questions to pin it down,
she uses `list_skills` / `save_skill` to create an **office skill** (`workspaces/office-skills/skills/<name>/SKILL.md`, not in git) and registers a routine that runs it.
Skills are loaded into every employee session as `office:<name>`.
Tools listed in the skill frontmatter's `office-allow` (e.g. `Bash(python3 "/path/script.py"*)`) run without approval **only in routines that run that skill**.
This applies only while the file content is exactly what the manager approved; if the file changes, the routine panel shows `⚠️ Needs re-approval`. Reports are saved in `workspaces/secretary/reports/`.

Employee sessions don't see claude.ai integrations (Gmail, Google Calendar, etc.). What they can use are local plugin MCPs (PubMed, bioRxiv, etc.) and skills (daily-note, etc.).

## Assistant 2 (Mini) — local model

Where Hana works on the Claude subscription, assistant 2 works on an **Ollama model on the desktop GPU** (uses no subscription quota; seated by the server room's glass wall).
It's for light work such as checking status, summaries and notes, and has no web search (WebSearch).

- List the Ollama server under `providers` in `config/office.local.yaml`, add `provider: <id>` to an employee definition, and that employee runs on the local model.
  ```yaml
  providers:
    - { id: desktop, name: "🖥 desktop", kind: ollama, ssh_host: desktop, remotePort: 11434, localPort: 11435, model: "qwen3.5:9b" }
  ```
- The backend opens the `ssh -L 11435:127.0.0.1:11434 desktop` tunnel itself and checks its health every 30 seconds. Ollama only needs to listen on desktop's 127.0.0.1.
- Claude Code's system prompt and tool definitions alone exceed 20k tokens, so give **Ollama a context of 64k or more**: `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`.
- Change the model from the dropdown in the employee panel (the list of models installed on desktop). The choice is saved in the DB.
- Provider employees don't count towards `maxConcurrent` (the subscription concurrency limit), and each provider runs one at a time.
- Only `kind: ollama` is supported for now. Other backends (e.g. Codex) can be added by adding a `kind` and attaching a runner to AgentManager.

## Structure

```
shared/protocol.ts        server↔browser message types
server/src/agents/        AgentManager (Agent SDK sessions, concurrency queue), status mapping, worktree
server/src/permissions/   approval broker (canUseTool → UI)
server/src/compute/       ssh / slurm adapters, server polling and job tracking
server/src/mcp/           lab tools for agents (GPU servers), office tools (for the assistant)
server/src/routines.ts    scheduled routine scheduler (cron.ts)
web/src/game/             canvas pixel-art office (original sprites drawn in code)
web/src/ui/               shared panels (panels.ts), console view (console.ts), view switching (view.ts)
```

`npm test` — unit tests · `npm run typecheck` — type check

## License

MIT
