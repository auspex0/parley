# Permissions, modes and trust boundaries

What each agent is allowed to do, when Parley changes it, and where the real boundaries are. See [SECURITY.md](../SECURITY.md) for the threat model and vulnerability reporting.

## Talk vs Work rooms 🔨

Every room has a mode (toggle in the header).

**Talk** is the default: conversational behavior and conservative room defaults, with explicit per-seat permission overrides still active.

**Work** lets agents act in the shared workspace — Claude defaults to `--permission-mode acceptEdits`, Codex to the `workspace-write` sandbox, and timeouts stretch to at least 15 minutes. A loud amber banner marks work rooms, and it remains visible in Talk when a seat has a write/full-access override; the sidebar tags work rooms 🔨.

Switching modes restarts any seat whose effective permission changes, then re-briefs it from the transcript.

### Activity lines

In work rooms (and any time an agent uses tools), its actions render as small inline lines in the chat — "✏️ Write server.js", "▶ npm test", "⚠ exited 1" — parsed live from both CLIs' JSON streams. Long consecutive action bursts collapse into an expandable chat row, and long rooms initially show their latest messages with a **Show earlier** row. No diff viewers or file panels: the chat is the interface, your editor is the viewer.

Activity lines are also relayed to the other agent as context, which is what makes lurk-review work.

### `@both` in work rooms is a discussion, not a work order

The table talks; a named agent works. For a `@both` message in a 🔨 room, Parley tells both agents to read and reply without making changes. The whole exchange it spawns (hops, chimes) inherits that instruction, the route hint shows "· discussion (no edits)", and the message is marked 💬.

Parley requests Claude's `plan` mode and, if its structured Full-access setting is configured, does not reuse the bypass-enabled native session. Codex resumes the room's existing sandboxed thread, so **its no-edit scope is a workflow instruction rather than an independent OS-level boundary.** Tag one agent when you want implementation.

## Claude permission modes

Claude's settings card offers:

- **room default** (stored as the legacy value `auto`) — Claude's own default in Talk, `acceptEdits` in Work
- **plan** — read & propose only
- **accept edits** — ordinary project edits are auto-accepted; protected paths and commands may still prompt
- **Full access** — `bypassPermissions`

Full access bypasses Claude's ordinary permission prompts and checks, and the process may reach anything available to your OS account — not only the linked project. Claude Code 2.1.126+ can include protected paths such as `.git`; explicit ask/deny rules, managed policy, OS permissions and Claude's hard safety circuit breakers may still restrict actions. Claude recommends bypass only inside an isolated container or VM; see [Claude's permission-mode guide](https://code.claude.com/docs/en/permission-modes). Enabling it through Room Settings asks for deliberate confirmation, leaves a transcript note and starts Claude fresh.

A non-bypass `--permission-mode` in Extra CLI args still overrides the dropdown; confirmation follows the *effective* mode, so removing a Plan override cannot silently activate Full access.

Ordinary Claude turns use the selected mode, including explicit agent handoffs and pair-worker turns. For protected discussion, reviewer and listener turns, Parley strips per-room permission overrides and requests Plan; when Parley's Full-access setting is configured, it also starts those turns outside the bypass-enabled native session and re-briefs the next ordinary turn from room history.

Parley records the permission provenance of each saved Claude session and discards a mismatched or legacy session on load rather than resuming it under a different permission setting.

## When a settings change takes effect

Changing Codex's sandbox, Claude's effective permission mode, the room mode, or the project link restarts the affected native session when required. Parley handles the reset and re-briefing from room history.

Such a change **saves immediately, even mid-answer.** The boundary is the CLI run, not the reply: a process that has already launched keeps the flags it started with and Parley says so, but the session it produces is discarded rather than resumed, and everything launched afterwards — the next turn, or an automatic retry if that reply loses its session — uses the new settings.

Settings only ever *loosen* on that boundary, never the no-edit one: once an exchange has taken on the `@both` discussion scope it keeps it to the end, so relaxing the room afterwards can't widen a delivery, follow-up or Retry that belongs to it. Only seats the change actually affects are reset.

Two changes still wait for the work to finish:

- an **active pair cycle** — worker and reviewer must judge the same work under the same settings
- the **project link** — it waits for the whole exchange, not just for a busy agent. A follow-up turn between agents launches a new process, and one exchange must not span two working directories, so the change is refused until the chain that would spawn it has finished.

## Security posture

- The server binds to **`127.0.0.1` only**. The local API requires a fresh in-memory token embedded in the served page and rejects foreign browser origins. This prevents blind/cross-origin web pages from driving your agents; like any loopback web app, it is not an OS security boundary against another process already running as your user.
- **Permissions are conservative in Talk rooms by default.** Claude runs in print mode with its normal CLI permissions and Codex uses the `read-only` sandbox. Work mode intentionally changes those defaults so the selected agent can edit the workspace. A structured Full-access choice exists for each provider (`bypassPermissions` for Claude, `danger-full-access` for Codex); both should be treated as **host-level trust, not project-level trust**.
- **Reviewer, listener and `@both`-discussion turns** run read-only where the provider can enforce it: Claude is switched to Plan and kept out of any bypass-enabled session. Codex's equivalent separation happens inside its existing sandboxed thread, so it is a workflow instruction rather than an independent OS-level boundary.
- **Extra CLI args are validated.** Raw `--dangerously-*`, `--allow-dangerously-*` and raw Claude `--permission-mode bypassPermissions` arguments are rejected, so Room Settings stays the visible, warned route to elevation. Other extra args are passed to the provider and may alter Parley's selected permission or sandbox flags — only add arguments you understand and trust.
- Your provider/user settings, hand-edited local configuration and custom command wrappers are trusted local inputs outside Parley's guardrails; Parley's validation governs what Parley itself passes to the CLIs.
- Parley does not inspect, copy or persist provider credentials; the CLIs use their own authentication and inherited process environment.
- Prompts are passed over stdin and child processes are spawned without a shell, so message text is not evaluated as a shell command by Parley.
- Room transcripts and activity lines can contain source code, prompts, local paths and CLI error output. Review and redact them before attaching them to a public issue.
