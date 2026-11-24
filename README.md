**English** | [한국어](README.ko.md)

[![CI](https://github.com/turtle505/eightbit-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/turtle505/eightbit-lab/actions/workflows/ci.yml)

# 👾 8-bit Lab

**A pixel-art office where your AI agents work.** 8-bit Lab runs several Claude Code agents ("employees") side by side, and shows them as little characters at their desks. You're the manager: you hand out work, approve anything risky, and read their reports.

**Why not just open a few `claude` terminals?** Because here they work as a team you can manage: one place to approve what they want to do, a board of tasks and who has them, GPU jobs that report back when they finish, and their reports collected in one feed — while you watch the office instead of tabbing between terminals.

It started in a research lab, so it also knows how to submit and watch GPU jobs on remote servers, but nothing assumes a field: tell it what your team works on in one line, and the employees take it from there.

- 🧑‍💻 **Six employees out of the box**: a literature researcher, an evaluation analyst, two research aides, an assistant, and a lead engineer who can hand work to the others.
- 👀 **See what everyone is doing**: who's typing, running commands, searching the web, or waiting for you.
- ✋ **You stay in control**: anything that reaches a remote server always asks first; other unclear actions come to you as approval cards, and a 🔒 task asks for everything (see [Safety](#safety)).
- 📨 **Reports come to you**: finished work and saved report files appear in a chat-like feed.
- ⏰ **Routines**: "every weekday at 9, brief me on new papers". Just ask the assistant.
- 🖥️ **GPU jobs**: submit, watch and fetch jobs on ssh or Slurm servers. The employee who submitted a job reports back when it finishes.
- 🌐 **Korean / English**: switch the whole office with one button.

It runs locally on your machine and uses your own **Claude Pro/Max subscription** through the `claude` CLI login. There's no API key.

> **Status:** a personal project, used daily but young — expect rough edges. It is not affiliated with or endorsed by Anthropic.

---

## Quick start

### What you need

- **Node.js 22.13 or newer** (24 recommended). The app uses the built-in `node:sqlite`, which older versions only offer behind a flag. With nvm, `nvm use` picks the right one (`.nvmrc`); `npm start` refuses older versions with a clear message.
- **Claude Code CLI**, logged in with a Pro or Max plan. Run `claude` once and sign in. Check with `claude --version`.
- macOS or Linux. On macOS, Word/RTF attachments are converted to text automatically.

### Run it

```bash
git clone https://github.com/turtle505/eightbit-lab.git
cd eightbit-lab
npm install
npm run dev
```

Open **http://localhost:5173**. That's it: no config is needed to start.

### Your first five minutes

1. **Click an employee** (or press <kbd>1</kbd>–<kbd>6</kbd>) and type an instruction in the box at the bottom, e.g. *"Find three recent papers on retrieval-augmented generation and summarise them."*
2. Watch them work. The speech bubble shows what they're doing right now.
3. If they **raise a hand with a `!`**, they need your OK: approve or deny in the yellow approval panel.
4. When they finish, the answer lands in the **📨 Reports** feed (and as a desktop notification, if you turn those on).

For bigger jobs, add a **task card** on the board and drag it onto an employee. Finished cards move to *Review* with the report attached.

> 💡 The first instruction to each employee takes a few seconds while their session starts. After that, replies start almost instantly.

---

## Everyday use

| I want to… | Do this |
|---|---|
| Give an instruction | Click an employee (or pick one in the box right under the office) → type and press Enter. <kbd>/</kbd> jumps to the box |
| Assign a task | Add a card on the task board → drag it onto an employee (or pick from the card's dropdown) |
| Approve / deny | Use the yellow approval panel (<kbd>a</kbd> / <kbd>d</kbd> in the console view) |
| Check results | Finished cards move to **Review**: expand **Report**, then mark it **Done** |
| Read old reports | **Reports** tab: every `.md` report as a folder tree, with unread counts |
| Stop someone | **Stop** in the employee panel (ends the current turn, keeps the conversation) |
| Start fresh | **New session** in the employee panel (clears the conversation) |
| Do something later, once | ⏰ in the task form (pick an assignee and a time), or ask the assistant: *"tomorrow at 9, have Ada summarise the new papers"* |
| Schedule recurring work | Routine panel → **+ New routine**, or just ask the assistant |
| Switch views | **Game / Console / Reports / Projects** at the top right, or <kbd>`</kbd> |
| Switch language | The **EN / 한국어** button at the top right |

**Views.** *Game* is the pixel office. *Console* shows the same data as tables: staff, tasks, a combined activity feed and approvals, all driven from the keyboard. *Reports* is a reader for report files. Add `?view=console` or `?view=reports` to the URL to open one directly.

**Keyboard** (console): <kbd>1</kbd>–<kbd>6</kbd> select · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>/</kbd> instruct · <kbd>a</kbd>/<kbd>d</kbd> approve/deny · <kbd>Esc</kbd> deselect.

**What the characters mean**

| You see | It means |
|---|---|
| ☕ In the lounge | Idle |
| Typing at the desk | Working. The monitor is blue when editing, green when running commands, sky blue when on the web |
| `...` | Thinking |
| ✋ Hand up with `!` | Waiting for your approval |
| ✨ Sparkle | Just finished |

**Subscription usage.** The top bar shows your Claude plan's **5-hour and weekly usage** and when each resets. The number in each employee's panel is *their share* of the office's total usage, not a percentage of your limit. If the 5-hour window runs out mid-task, the employee pauses and **picks the work up again by itself** when the window resets. **▶️ Resume now** skips the wait.

---

## Customising

Everything lives in `config/`. **Don't edit the committed files for personal settings.** Put them in `config/<name>.local.yaml` next to them instead. Those files are git-ignored and layered on top:

- `office.local.yaml` overrides keys one by one.
- In the employee, routine and server lists, an entry with the same `id` (servers: `name`) replaces the default, and a new one is added.

```yaml
# config/office.local.yaml (a typical one)
domain: "a computer-vision lab working on video understanding"   # what your team works on, in one line
language: en              # en | ko: UI and the language employees report in
maxConcurrent: 3          # employees working at the same time (protects your subscription's rate limit)
researchRepo: ~/research/my-model   # optional: each engineer gets their own git worktree of this repo
authToken: ""             # optional: lock the office with a password (see "Safety")
```

| File | What it controls |
|---|---|
| `config/office.yaml` | Your field (`domain`), concurrency, model, language, idle timeout, hosts, local models |
| `config/roles.yaml` | The employees: name, role prompt, tools they may use without asking (`autoAllow`), sprite colours |
| `config/routines.yaml` | Starter routines: weekday 09:00 morning briefing, weekday 18:00 evening report, Friday 17:00 weekly review (off) |
| `config/servers.local.yaml` | Your GPU servers (copy `servers.example.yaml`) |

**Workspaces.** With `researchRepo` set, each engineer works in their own git worktree (branch `office/<id>`), so they don't step on each other. Without it, everyone shares `workspaces/shared`. Reports go to `workspaces/<employee>/reports/`.

**The team.**

| id | Who | What they do |
|---|---|---|
| `lit` | Ada | Papers and web research |
| `eval` | Gauss | Metrics, figures, evaluation reports |
| `aide1`, `aide2` | Finn, Mira | Research aides who take whatever is handed over |
| `sec` | Hana | The assistant: routines, office overview, organising reports |
| `exec` | Linus 👑 | Lead engineer: implements, runs GPU jobs and delegates to the others |

**Fitting them to your field.** Setting `domain` is usually enough: every employee's prompt starts with `About this team: <domain>`. To go further — say, the evaluation analyst should know your field's metrics, or the researcher may use a paper-search MCP server you've installed — override that employee in `config/roles.local.yaml`. Entries are merged by `id`, field by field:

```yaml
# config/roles.local.yaml
employees:
  - id: lit
    autoAllow: [Read, Glob, Grep, WebSearch, WebFetch, Write, Edit, TodoWrite, mcp__arxiv]   # + your MCP server
  - id: eval
    systemPrompt: |
      ## Your role: Evaluation Analyst
      You compute and interpret mAP, IoU and per-class recall for our detection models …
```

Under each role, every prompt also gets the shared rules from the `common:` block of `roles.yaml` (report honestly, read before changing, the report format), plus a `servers:` block of remote-server etiquette when you have GPU servers or remote hosts. Removing an employee doesn't lose their task cards; they go back to *unassigned*.

**Language.** Employees always get their instructions in English; only the language they *report* in follows the setting. The header button overrides `language:` and is remembered. Old logs and feed entries keep the language they were written in, and routines already saved aren't retranslated.

**Routines with the assistant.** Tell Hana *"every Friday at 5, summarise what everyone did this week"*. She asks a few questions, then writes the steps down as an **office skill** (`workspaces/office-skills/skills/<name>/SKILL.md`) and schedules a routine that runs it. A skill can list commands it may run without asking (`office-allow`). That only holds while the file is exactly the version you approved: if it changes, the routine panel shows **⚠️ Needs re-approval**. Routines use 5-field cron in the backend machine's local time, and only run while the backend is up.

---

## Optional features

### Codex employees

In an employee panel, choose **Codex** from the engine selector after the employee's current work finishes. The choice persists; switching back to Claude restores that employee's separate Claude conversation. Codex runs through its local app-server with your ChatGPT login, so install the official Codex CLI and run `codex login` on the backend machine. For a remote employee host, install and sign in there too; set `codexPath` to the CLI's absolute path in that host's `office.local.yaml` entry if a non-login SSH shell cannot find it. On a headless host, `codex login --device-auth` is an option. Codex uses the CLI model configured on the host, including when resuming an employee conversation. If the account rejects the default model, set `model = "<supported-model>"` at the top of that host's `~/.codex/config.toml`. Codex uses the same task board, report feed, approval cards, and office/lab tools. In auto mode it accepts routine Codex command and file approvals; SSH/lab access, certain destructive commands, and extra filesystem grants still ask. Its subscription usage is separate from the Claude meter in the header.

<details>
<summary><b>🖥️ GPU servers (submit and track jobs)</b></summary>

Copy `config/servers.example.yaml` to `config/servers.local.yaml` and list your servers. Each one has `type: ssh` or `type: slurm`, plus an `ssh_host` from your `~/.ssh/config`, which **must log in with a key, without a password**. If the backend itself runs on that machine, use `ssh_host: local`.

Employees then get the `mcp__lab__*` tools: `list_servers`, `gpu_status`, `submit_job`, `job_status`, `tail_log`, `cancel_job` and `fetch_results`. Jobs appear in the jobs panel. When a job finishes, the employee who submitted it is told automatically and reports the result.
</details>

<details>
<summary><b>📁 Project sessions (a Claude Code session in any folder)</b></summary>

In the **Projects** tab, pick a host and an existing folder to open a Claude Code session there. It's like `ssh host`, `cd ~/project/x`, `claude`, but with approvals, logs and reports. One project can run several independent sessions.

- Sessions live in the tab. Press **Bring to office** to give one a desk and a character.
- Sessions share the same approval rules and count towards `maxConcurrent`.
- Closing a session discards its conversation; the files stay.
</details>

<details>
<summary><b>🌍 Running sessions on another machine / moving the backend</b></summary>

List machines under `hosts` in `office.local.yaml`, then give an employee or project `host: <id>`:

```yaml
hosts:
  - { id: desktop, name: "🖥 desktop", ssh: local, projectRoot: "~/project" }
  - { id: gpu1, name: "🧮 gpu1", ssh: gpu1, projectRoot: "~/project", claudePath: "/home/me/.local/bin/claude" }
```

- `ssh: local` is the backend's own machine. Anything else is an ssh alias (key auth).
- Each machine needs its own `claude` install and login. Give `claudePath` as an **absolute path**, because non-interactive ssh usually lacks `~/.local/bin`.
- Remote sessions can't read attachments, which live on the backend's disk.
- A conversation only exists on the machine that ran it, so moving an employee starts a new session.

**Shared servers dislike noisy clients**, so the office is careful with ssh:

- Short commands reuse one connection per host.
- A reachable host is checked once and then left alone.
- Each host has a budget of `sshPerMinute` connections (default 5; set per host on its `hosts` entry, `0` = unlimited). Employees' own `ssh`/`scp`/`rsync` count towards it too. Over the budget, the command is refused with a "try again in N seconds" message.
- The host badge shows ⏳ when the budget is nearly spent.

**Moving the backend to a server:** `git clone` → `npm ci` → `npm run build` → see `deploy/eightbit-lab.service`. Copy `data/office.db` and `workspaces/` across to keep tasks, routines and attachments. Don't run two backends at once, or routines will fire twice.

**Updating it later:** `npm run update` on that machine. It checks that no employee is mid-work (a restart would cut them off), then pulls, rebuilds and restarts the systemd service. `npm run update -- --force` skips the check.
</details>

<details>
<summary><b>✅ Today's to-dos from Obsidian</b></summary>

Point the office at your vault and the **✅ Today's to-dos** panel shows the checkboxes in today's daily note. You can tick, edit (double-click), add and delete items. Changes are written straight to the note, and edits made in Obsidian show up within seconds. If the line changed in Obsidian meanwhile, the office refuses your edit rather than overwrite it.

```yaml
obsidian:
  vault: /path/to/vault
  daily: "{YYYY}-{MM}-{DD}.md"     # Obsidian's default; e.g. "Daily/{YYYY}/{YYYY}.{MM}.{DD}.{ddd}.md" for a folder per year
  # sections: [Today, Projects]    # only these "## " headings (default: all of them)
  # schedule: [Schedule, 일정]      # headings whose plain bullets are appointments, shown too
```

Any plain note works: every `- [ ]` under a `## ` heading is shown, grouped by heading, and a note without headings is read as one list. Optionally, a line that is only **bold text** starts a named group inside a section, and a trailing `↻3` on an item is shown as "carried over 3 times".
</details>

<details>
<summary><b>📱 Notifications on your phone</b></summary>

The browser can only notify you while an office tab is open. To hear about approvals, finished work, failed runs, GPU jobs and scheduled starts when you're away, have the office push them to your phone with [ntfy](https://ntfy.sh) (free, no account) or a Slack/Discord webhook:

1. Install the ntfy app and subscribe to a topic with a long random name (e.g. `office-7f3k9q2m`).
2. Add it to `config/office.local.yaml` on the machine running the backend, and restart:
   ```yaml
   notify:
     ntfy: https://ntfy.sh/office-7f3k9q2m
     # webhook: https://hooks.slack.com/services/...   # or/also a Slack/Discord incoming webhook
     # events: [approval, result, error, job, scheduled]
   ```
3. `npm run notify:test`: your phone should buzz.

Nothing is sent while an office tab is in front somewhere (`whenAway: false` to always send). Notifications carry only who and what (for example "✅ Ada: 📋 #12 Summarise the paper"), not the reply, unless you set `preview: true`. **Anyone who knows an ntfy.sh topic can read it**, so treat its name like a password, or self-host ntfy.
</details>

<details>
<summary><b>📎 Attachments</b></summary>

Drop files on 📎 in the task form or on an employee's input box (up to 50 MB each). The employee gets the file paths with the instruction.

- CSV, text, JSON, images and PDF are read directly.
- On macOS, Word, RTF, ODT and HTML files also get a `.txt` conversion.
- Excel files are read with pandas.
- Uploads you never attach to anything are deleted after 24 hours.
</details>

<details>
<summary><b>🦙 An employee on a local model (Ollama)</b></summary>

Any employee can run on an Ollama model instead of your subscription, which is good for light work like summaries and notes. Add the provider in `office.local.yaml`, then point an employee at it in `roles.local.yaml`:

```yaml
# config/office.local.yaml
providers:
  - { id: workstation, name: "🖥 workstation", kind: ollama, ssh_host: workstation, remotePort: 11434, localPort: 11435, model: "qwen3:8b" }
```

```yaml
# config/roles.local.yaml
employees:
  - { id: aide2, provider: workstation }
```

- The office opens the ssh tunnel itself and health-checks it.
- Start Ollama with a **64k+ context** (`OLLAMA_CONTEXT_LENGTH=65536 ollama serve`), because Claude Code's own prompt is over 20k tokens.
- Pick the model from the employee panel.
- These employees don't count towards `maxConcurrent`.
</details>

---

## Safety

Agents can read untrusted web pages and papers, so the office keeps a few guard rails on.

- **Auto mode by default.** Each employee runs in **🤖 Auto**: a classifier approves clearly safe tool calls, and anything unclear becomes an approval card. Switch an employee to **✋ Ask** to approve everything yourself.
- **Lab servers always ask.** Submitting, cancelling or fetching jobs on another machine, and any `ssh`/`scp`/`rsync`/`sftp` command, always show an approval card, even in auto mode. So one hidden instruction in a web page can't run commands on your GPU server. Read-only checks (GPU status, job status, logs) don't ask.
- **🔒 per task.** Tick 🔒 on a task card and that task asks for every tool outside the employee's allow-list.
- **Loopback only.** The backend listens on `127.0.0.1` and refuses browser requests from other origins, so a random web page you have open can't drive the office.
- **Optional password.** Set `authToken` in `office.local.yaml` if other people can log in to the machine. Browsers enter it once and get a cookie; scripts send `X-Office-Token: <token>`.

---

## Troubleshooting

| Problem | Try |
|---|---|
| Usage shows "—" | The usage check uses an experimental API and may be unavailable. Everything else still works |
| An employee shows ⏸ **Usage limit** | Your 5-hour window ran out. They resume by themselves at the shown time, or press ▶️ **Resume now** |
| An employee seems stuck | Open their panel and check the log; **Stop**, then instruct again. **New session** if the conversation went off the rails |
| A host badge says it can't connect | Check `ssh <alias>` works without a password, then press ↻ on the badge |
| New tool or option not picked up | Long-lived sessions cache tool lists: press **New session** |

---

## For developers

```bash
npm run dev         # backend (tsx watch, :8787) + Vite (:5173)
npm run build && npm start   # production: backend serves dist/ on 127.0.0.1:8787
npm test            # unit tests (vitest)
npm run typecheck
```

```
shared/protocol.ts     every message between server and browser
shared/i18n.ts         ko/en switch: tr({ ko, en }), locale helpers
server/src/agents/     AgentManager: one long-lived Agent SDK session per employee, queue, permissions
server/src/compute/    ssh / slurm adapters, server polling, job tracking
server/src/mcp/        tools for agents: lab (GPU servers), office (for the assistant)
web/src/game/          the pixel office (sprites drawn in code)
web/src/ui/            panels, console, reports, projects
```

[CLAUDE.md](CLAUDE.md) explains the architecture in detail. Data lives in `data/office.db` (SQLite) and `workspaces/`; both are git-ignored.

## License

MIT
