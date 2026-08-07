# Reference

Rooms, configuration, attachments, slash commands and housekeeping.

## CLI flags

```
parley [--port N] [--root DIR] [--no-open]
```

- `--port N` — default `4141`, auto-increments if taken.
- `--root DIR` — where room folders live, default `~/.parley`.
- `--no-open` — don't launch a browser.

After updating, restart the running Parley process before reloading the page — builds pin the UI to the backend that served it, and an older server meeting a newer page blocks its controls and shows a persistent **Restart Parley** warning instead of silently mixing runtime versions.

## The room folder

Each room is a folder under `~/.parley/<room>/`:

```
room.json        config (see below)
state.json       session ids + per-agent cursors
events.jsonl     machine-readable transcript (source of truth)
transcript.md    human-readable transcript (what "Download transcript" serves)
workspace/       shared folder; both agent CLIs run with this as cwd
```

## Config (`room.json`, editable in the UI)

```json
{
  "defaultAgent": "claude",
  "timeoutMs": 900000,
  "agents": {
    "claude": { "command": "claude", "model": null, "permissionMode": "auto", "extraArgs": [] },
    "codex":  { "command": "codex",  "model": null, "sandbox": "read-only", "extraArgs": [] }
  }
}
```

- **`model`** overrides the CLI's default model (`--model` / `-m`) and **`effort`** sets reasoning effort (claude `--effort`, codex `model_reasoning_effort`). Both are **free-text comboboxes**, and the suggestions are discovered rather than hardcoded: Codex maintains `~/.codex/models_cache.json`, so Parley lists exactly the models your CLI knows about and the reasoning levels each supports — new OpenAI models appear without a Parley update. Claude Code keeps no such list, so its suggestions are static aliases (`opus`, `sonnet`, …) plus the effort levels including `ultracode`. Anything you type is passed straight through; an unrecognized value simply comes back as the CLI's own error in the chat.
- **`command`** lets you point a seat at a different binary or path.
- **`lurk`** / **`lurkStyle`** / **`lurkPrompt`** — see [conversation.md](conversation.md#lurk-mode-).
- **`permissionMode`** (Claude) and **`sandbox`** (Codex) — see [permissions.md](permissions.md).

## Rooms and seats

A room seats **exactly two agents**, chosen when you create it (the "+" form is pre-filled with Claude + Codex — change either dropdown if you want a different pair). Seats are fixed for the room's lifetime; pills, chips, @mentions, colors and settings all follow the chosen pair. Existing rooms just work — no migration. A room's two seats must be different providers.

### Linked project folders 📁

Point a room at a real project — **Browse…** in Settings ("Project folder") opens your OS's own folder picker, or link one while creating the room ("📁 Link a project folder…" in the + form). Both agents then work and read *there* instead of the room's sandbox, and automatically pick up the project's `CLAUDE.md` / `AGENTS.md`.

The sidebar footer names the folder the room actually works in, so you can always see whether it's a real project or the room's sandbox. If that folder is inside a Git repository, a muted line beneath it reads `⑂ branch` — or `⑂ abc1234 (detached)` when HEAD is on no branch — so you can tell at a glance which branch the agents are about to write in. A *linked worktree* adds its own name (`⑂ side-branch · wt-alpha`); an ordinary checkout doesn't, since that would only repeat the folder name above. It reads `.git` directly (no `git` subprocess), refreshes when the room state changes or the window regains focus, and shows nothing at all when the folder isn't a repo or HEAD can't be read — it never guesses a branch. Linked rooms show 📁 in the sidebar; flipping one to 🔨 work mode asks for explicit confirmation, since agents can then edit the real files. Changing the link resets both agents' sessions (the transcript keeps the room history). Blank = the room's own sandbox.

### Housekeeping

Hover a room in the sidebar for ✎ (rename) and ✕ (delete) — they act on that room, not whichever one you're viewing. The same two live in Settings for the current room, next to "Archive & start fresh".

Renaming is live: the page follows the new name without reloading and the transcript is untouched (for a sandbox room the workspace moves with it, so agents start a fresh session and get the conversation replayed; a linked room keeps its sessions since the working directory doesn't move).

Deleting moves the room folder to `~/.parley/.trash/<name>-<timestamp>/`, so it's recoverable — restore or clear it with your file manager; Parley deliberately ships no trash UI. A **linked project folder is never touched** by a delete: only Parley's own folder for the room goes. The `default` room is the permanent landing room and cannot be deleted; use **New conversation** to archive and empty it. Rooms are only created when you explicitly create one, so a deleted room stays deleted.

## Attachments

Paste PNG, JPEG, GIF, or WebP images into the composer, use the paperclip, or drag files anywhere onto the Parley window to attach images, patches, logs, documents, and other files.

| Limit | Value |
|---|---|
| Attachments per message | 8 |
| Images per message | 4 |
| Per file | 5 MB |
| Total per message | 6 MB |

Parley validates and stores private canonical copies inside the room; images render inline, while other files appear as named download cards. Images use each CLI's native image input. Small text-like files are also included directly in the prompt, and complete file bytes are exposed only through a disposable per-turn staging directory so an agent never receives write access to the authoritative upload.

Attachment-only messages work too, Retry reuses the same stored bytes, and a failed send keeps the drafts ready to resend.

## Slash commands

| Command | What it does |
|---|---|
| `/pair start [rounds] @agent [task]` | Start a pair session — see [conversation.md](conversation.md#pair-mode-) |
| `/pair end` | End pair mode |
| `/note <text>` | Set the room note; no text clears it |
| `/summarize` | Recap of decisions and open questions |
| `/help` | List commands |

**Room note** (`/note <text>`, or Settings) is a standing instruction both agents see at the top of every prompt — project context, conventions, tone. It survives session resets and reaches both agents regardless of when their sessions started.

## Elsewhere in the UI

Live "thinking…" indicators and streamed reply text; markdown rendering with copy-able code blocks; multiple rooms in the sidebar, each with its own config, sessions and transcript; **New conversation** to archive the transcript and reset both agents' sessions; a **Retry** button on failed turns; hover any message for a copy button; very long replies collapse with "Show more"; the tab title shows ● when replies land while you're in another window; and one click to **download the room transcript as Markdown** or **open the shared workspace folder**.

## Adding a provider

Parley's two seats can host any CLI coding agent. To add one: write a `send(room, opts)` adapter in [parley.mjs](../parley.mjs) with the same contract as `claudeSend`/`codexSend` (read your config from `room.cfg.agents.<yourname>`, return `{ text, sessionRef, resetSession?, usage? }`), add it to the `adapters` map, and describe it in the `PROVIDERS` registry (label, avatar, color, default seat config, settings fields). The seat picker, settings UI, routing and receipts pick it up automatically.

Parley doesn't require your CLI to support session resume — the room's delta protocol and inline history replay can carry a stateless CLI.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
