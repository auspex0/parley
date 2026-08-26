# Reference

Rooms, configuration, attachments, slash commands and housekeeping.

## CLI flags

```
parley [--port N] [--root DIR] [--no-open] [--version] [--help]
```

- `--port N` — default `4141`, auto-increments if taken (up to 20 tries). `--port 0` asks the OS for any free port.
- `--root DIR` — where room folders live, default `~/.parley`.
- `--no-open` — don't launch a browser.
- `--version`, `-v` — print the version and exit.
- `--help`, `-h` — print usage and exit.

After updating, restart the running Parley process before reloading the page — builds pin the UI to the backend that served it, and an older server meeting a newer page blocks its controls and shows a persistent **Restart Parley** warning instead of silently mixing runtime versions. The current source uses internal runtime protocol **10**, covering generalized causal-attention and relay-cap state, recovered Wake/Retry integration, and incremental reply streaming. That number is a stale-tab compatibility fence, not Parley's package version or a public API version.

## The room folder

Each room is a folder under `~/.parley/<room>/`:

```
room.json        config (see below)
state.json       sessions, per-agent cursors, per-seat sleep and persisted lurk catch-up/outcome state
events.jsonl     machine-readable transcript and delivery/causal-answer receipts (source of truth)
transcript.md    human-readable transcript (what "Download transcript" serves)
workspace/       shared folder; both agent CLIs run with this as cwd
```

## Config (`room.json`, editable in the UI)

```json
{
  "defaultAgent": "claude",
  "hopBudget": -1,
  "pairRounds": 0,
  "timeoutMs": 900000,
  "agents": {
    "claude": { "provider": "claude", "command": "claude", "model": null, "permissionMode": "auto", "extraArgs": [] },
    "codex":  { "provider": "codex",  "command": "codex",  "model": null, "sandbox": "read-only", "extraArgs": [] }
  }
}
```

- **`model`** overrides the CLI's default model (`--model` / `-m`) and **`effort`** sets reasoning effort (claude `--effort`, codex `model_reasoning_effort`). Both are **free-text comboboxes**, and the suggestions are discovered rather than hardcoded: Codex maintains `~/.codex/models_cache.json`, so Parley lists exactly the models your CLI knows about and the reasoning levels each supports — new OpenAI models appear without a Parley update. Claude Code keeps no such list, so its suggestions are static aliases (`opus`, `sonnet`, …) plus the effort levels including `ultracode`. Anything you type is passed straight through; an unrecognized value simply comes back as the CLI's own error in the chat.
- **`command`** lets you point a seat at a different binary or path.
- **`lurk`** / **`lurkStyle`** / **`lurkPrompt`** — see [conversation.md](conversation.md#lurk-mode-).
- **`hopBudget`** controls **charged request launches** per user message: `-1` means until settled (with the emergency safety stop), `0` means no charged launches, and any positive integer is an exact limit. Explicit agent calls and continuations spoken from a returned answer are charged; safe-boundary `@both` sibling delivery and a live lurker's right of reply are structural and do not consume the counter. Every launched request that produces an answer also earns one free, read-only return to its immediate caller, so one counted hop can mean up to two provider invocations. Charged usage is durable per user-message root: Wake & deliver and Retry resume the already-spent count, while `state.json` keeps the newest 200 inactive charged roots plus any older root that is still active, held or retryable. Rooms written with the legacy `maxHops` key are migrated on load; its old `0 = until settled` becomes `hopBudget: -1`. Settings accepts any safe whole number; the sticky per-room composer shortcut deliberately offers only quick overrides through `8` without editing `room.json`. See [Agent-to-agent hops & right of reply](conversation.md#agent-to-agent-hops--right-of-reply) for the full scheduler.
- **`pairRounds`** is separate from `hopBudget`: `0` means review until approved, while a positive value caps Pair fix/review rounds.
- **`permissionMode`** (Claude), **`sandbox`** (Codex) and **`approvalMode`** (Gemini) — see [permissions.md](permissions.md).
- **`provider`** names the CLI that drives the seat (`claude`, `codex`, `gemini`). It defaults to the seat's own name and is fixed once the room exists — changing it by hand orphans that seat's session.

## Rooms and seats

A room seats **exactly two agents**, chosen when you create it (the "+" form is pre-filled with Claude + Codex — change either dropdown if you want a different pair). Seats are fixed for the room's lifetime; pills, chips, @mentions, colors and settings all follow the chosen pair. Existing rooms just work — no migration. The two seats need different *names*, but they may run the same provider: see [Seats and providers](#seats-and-providers).

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
| `/sleep @agent [reason]` | Stop launching that seat — see [conversation.md](conversation.md#sleeping-a-seat-) |
| `/wake @agent` | Bring it back; nothing is replayed |
| `/summarize` | Recap of decisions and open questions |
| `/help` | List commands |

**Room note** (`/note <text>`, or Settings) is a standing instruction both agents see at the top of every prompt — project context, conventions, tone. It survives session resets and reaches both agents regardless of when their sessions started.

## Elsewhere in the UI

Live "thinking…" indicators and streamed reply text; markdown rendering with copy-able code blocks; multiple rooms in the sidebar, each with its own config, sessions and transcript; **New conversation** to archive the transcript and reset both agents' sessions; a **Retry** button on failed turns; hover any message for a copy button; very long replies collapse with "Show more"; the tab title shows ● when replies land while you're in another window; and one click to **download the room transcript as Markdown** or **open the shared workspace folder**.

The hops control beside the composer is a sticky per-room browser-session shortcut: Room default, Solo, `∞`, or `0`–`8`. The selected policy survives page reloads and is snapshotted onto every accepted user message until the user changes it; taskless `/pair start` and `/pair end` controls carry no relay policy. Solo permits exactly one selected responder for a message, so it cannot be combined with `@both` or a Pair turn; the suppressed seat can still receive the message later as ordinary transcript context. While an exchange is active, the adjacent **Hops used · limit** status shows server-counted **charged request launches** against that exchange's immutable starting budget. Structural requests and the one free answer return owed by each launched request do not increment it. Changing the shortcut never rewrites a running or queued exchange.

**Wake & deliver and Retry reuse the original user entry, its relay-policy snapshot and its durable charged-use count.** The recovery attempt rejoins the same protocol-9 causal scheduler as live work with the original root's remaining budget; it does not reset the cap. A successful recovered `@both` half structurally reaches only a sibling with a successful direct reply to that exact root; a cursor advanced by unrelated work cannot resurrect a failed or stopped half. A recovered single-seat attempt honors enabled lurk after it settles even if the addressed provider failed, passed or produced no bubble, and a busy listener receives a persisted catch-up obligation carrying that root explicitly. Explicit Stop ends the chain and records the terminal disposition instead of launching lurk. **Wake only** launches nothing and therefore creates none of these relay obligations.

Causal settlement is serialized per original root, so overlapping live/recovered `@both` halves cannot miss one another or double-spend. Explicit recovered-root catch-up obligations are versioned, which prevents an older in-flight attempt from erasing a newer attempt for the same user message.

## Seats and providers

A room has two **seats**. A seat's **id** is its @mention name, its key in `room.json` and `state.json`, and the author on every transcript line and receipt — it is the primary key of everything durable in the room, so it is fixed for the room's life. Its **provider** (`agents.<id>.provider`) says which CLI drives it.

The id defaults to the provider name, which is why every room created before the two were separate keeps working: it gains one field and renames nothing. Two seats may share a provider as long as their names differ, so a Claude-vs-Claude room (say `alpha` and `beta`, one on Opus and one on Sonnet) is an ordinary room.

Seat names are lowercase letters, numbers and dashes, up to 20 characters, and cannot be `both`, `user`, `system`, `all` or `none` — those would collide with routing or with Parley's own voices in the transcript.

```jsonc
"agents": {
  "alpha": { "provider": "claude", "model": "opus", ... },
  "beta":  { "provider": "claude", "model": "sonnet", ... }
}
```

## Adding a provider

Parley's two seats can host any CLI coding agent. To add one: write a `send(room, opts)` adapter in [parley.mjs](../parley.mjs) with the same contract as `claudeSend`/`codexSend` (read your config from `room.cfg.agents.<yourname>`, return `{ text, sessionRef, resetSession?, usage? }`), add it to the `adapters` map, and describe it in the `PROVIDERS` registry (label, avatar, color, default seat config, settings fields). The seat picker, settings UI, routing and receipts pick it up automatically.

Parley doesn't require your CLI to support session resume — the room's delta protocol and inline history replay can carry a stateless CLI.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
