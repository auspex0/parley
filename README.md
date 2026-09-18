# Parley

**Claude Code and Codex in one chat room — and they can overhear each other.**

[![CI](https://github.com/auspex0/parley/actions/workflows/ci.yml/badge.svg)](https://github.com/auspex0/parley/actions/workflows/ci.yml)
![deps: zero](https://img.shields.io/badge/deps-zero-brightgreen)
![node: ≥20](https://img.shields.io/badge/node-%E2%89%A520-blue)
[![license: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)

Most multi-agent tools are work queues — worktrees, kanban boards, parallel terminals. Parley is a *conversation*: one local page, one shared thread, two agents who hear each other. `@claude`, `@codex`, `@both` — or just type, and it goes to whoever you were last talking to. Ask Claude something, then ask Codex what it thinks of the answer; they agree, disagree, and build on each other in one thread.

It drives the **official Claude Code and Codex CLIs through your existing CLI logins**. No API key, no proxy; Parley never reads or stores provider credentials — if a CLI isn't authenticated, you see its own error in the chat.

**Note**: The screenshots and demos below show an earlier version. The current interface, labels, and turn-budget controls have changed. The current npm package is also behind this GitHub version.

![Parley: only @codex is addressed, but Claude — lurking — chimes in to correct an over-cautious claim, and Codex agrees](https://raw.githubusercontent.com/auspex0/parley/9146b95ded06d8a1a939546bac1688b19da68463/docs/parley-lurk.png)

*A real run. Only `@codex` was addressed. Claude was lurking, judged the answer more pessimistic than the facts warranted, and said so unprompted — then Codex read the correction and agreed.*

![Parley: one @both message; Codex argues for repo-relative paths, Claude argues the two failure modes are not symmetric](https://raw.githubusercontent.com/auspex0/parley/9146b95ded06d8a1a939546bac1688b19da68463/docs/parley-both.png)

*`@both` puts one question to each seat. Here they disagreed — Codex preferring relative paths, Claude arguing the two failure modes aren't symmetric — and settled it in the same thread.*

## Lurk mode 👂

An agent can stay in earshot while you talk to the other one, and interject **only when it has something real** — an uncorrected error, a disagreement, a risk you glossed over. Otherwise it stays quiet.

Point that at a work room and you get continuous, unprompted code review: one agent codes while the other watches activity, checks the workspace, and speaks up when something is actually wrong. If the listener is busy, Parley lets your work finish first and gives it one coalesced catch-up rather than dropping the opportunity. That delayed catch-up has a bounded ending, so it cannot become an after-hours agent loop.

Whether it speaks is the model's own judgment — there is no keyword trigger. A per-agent dial sets the bar: `quiet` (only outright problems), `balanced` (adds real disagreements and critical caveats), `vocal` (adds better approaches too). Or write your own criteria.

## Get started

You need **Node.js ≥ 20** and the two official CLIs, each installed and authenticated: `claude` (Claude Code) and `codex` (OpenAI Codex). Parley shells out to them under your existing logins.

Try it without installing anything:

```bash
npx parley-room
```

Or install it for good:

```bash
npm install -g parley-room
parley
```

The npm package is `parley-room`; `parley` on npm is unrelated. The command remains `parley`.

The UI opens automatically at a loopback URL, normally `http://127.0.0.1:4141`. Flags: `--port N` (`--port 0` picks any free port), `--root DIR`, `--no-open`, `--version`, `--help`.

Or run from source — there are no runtime dependencies:

```bash
git clone https://github.com/auspex0/parley.git
cd parley
npm test     # optional: real server, fake agents — no login, no tokens spent
npm start    # `npm link` here gives you the global `parley` command
```

Two notes at the door:

- **Platform honesty:** developed and used daily on **Windows 11** against both real CLIs. Windows, Linux and macOS are all CI-tested, but only Windows has real-world mileage — open an issue if something's off.
- Windows works natively: Parley resolves npm `.cmd` shims to the real binaries rather than going through a shell. After updating, restart Parley before reloading the page.

### If something doesn't work

| Symptom | What it means |
|---|---|
| A seat shows **not found** | `claude` or `codex` isn't on Parley's `PATH`. Hover the pill for the exact resolver error. Install the CLI, then restart Parley — `PATH` is read at launch. |
| A seat replies with a login or auth error | The CLI itself isn't signed in. Run `claude` or `codex` once in a terminal, complete the login, then come back. Parley never handles credentials. |
| `Failed to start: EADDRINUSE` | Something else holds port 4141 and the next 20 ports. Use `--port 0` for any free port. |
| The page says the runtime protocol doesn't match | Parley was updated under a page that's still open. Reload the tab. |
| Windows: the folder picker seems to do nothing | It can open behind the browser. Look for **Parley — Choose a project folder** in the taskbar. |

Your rooms, transcripts and settings live in `~/.parley` (override with `--root`). To remove Parley entirely: `npm uninstall -g parley-room`, then delete that folder — it also holds `~/.parley/.trash`, where deleted rooms go.

## How you talk to it

| You type | What happens |
|---|---|
| `@claude <text>` | Claude only |
| `@codex <text>` | Codex only |
| `@both <text>` | Both, **in parallel** — replies stream in as they land |
| `<text>` | Whoever you last addressed |

Each agent has its own **lane**: tag them back-to-back and they genuinely work at the same time. Everything you send is accepted and posted the instant you send it — only *delivery* waits on a busy agent (⏳ badge, delivered in order). The badge opens the queue — one card per *dispatch*, the batch of deliveries one send created — and its ✕ withdraws whatever that dispatch still has waiting.

**Stop is scoped.** With one agent replying and nothing queued, ■ stops that response and its pending follow-ups. When two seats, queued work or Pair mode make that ambiguous, it opens a chooser: stop one response, active responses, queued work, or everything. Each click is pinned to the response you meant, so it cannot kill work that began after you clicked.

**Token-frugal by default.** Tagging one agent costs nothing for the other when the addressed reply does not call it; a single-seat, untagged reply never wakes an unrelated peer. That peer catches up from its cursor on its next real delivery. A live session gets only its unseen delta, a fresh or recovered one gets a single bounded briefing — history is never resent wholesale.

## The rest of it

- **Automatic turns** — For ordinary use, leave the room default alone: new rooms allow four extra agent turns after the replies you asked for. Choose **Solo** for one selected responder, `0` to keep things to the initial replies, a number for a tighter cap, or **Until settled** for a longer discussion with a visible safety stop. Each message keeps the rule it started with through Retry or Wake; Pair rounds are separate. See [the full conversation-accounting reference](docs/conversation.md#automatic-turns-new-rooms).
- **Pair mode 🔁** — `/pair start @claude build X`: one agent works, the other reviews by actually reading the files, then approves or sends it back for a fix round. A failed review is never treated as approval.
- **Sleep a seat 😴** — hit a usage limit? Sleep that seat and the other keeps working. Nothing launches it — not your message, not a queued delivery, not an `@tag` from the other agent — until you wake it. Your requests are held in their original place and autonomous skips are recorded, so silence is never read as agreement. Waking alone replays nothing; if held requests exist, **Wake & deliver** handles them together in one turn, then rejoins the same causal scheduler as a live exchange. A recovered `@both` half reaches a sibling only when that sibling previously completed this exact user root; structural sibling delivery never auto-revives a failed or stopped half. A recovered single-seat exchange still honors enabled lurk, persisting catch-up when the listener is busy.
- **Talk rooms and work rooms 🔨** — Talk is conversational with conservative permissions. Work lets agents edit files and run commands, rendered as inline chat lines (`✏️ Write server.js`, `▶ npm test`, `⚠ exited 1`) — the chat is the interface, your editor is the viewer. `@both` in a work room is a discussion, not a work order.
- **Linked project folders 📁** — point a room at a real project; both agents work there and pick up its `CLAUDE.md` / `AGENTS.md`.
- **Attachments 📎** — paste, drag or clip in images, patches, logs and docs; images use each CLI's native image input.
  *Personal highlight: that little attachment paperclip. Shoutout to Codex.*
- **Receipt dots** — under every message: who heard it live, who lurked it, who is queued to catch up, who caught up later, where a causal answer was returned, and where a cap or structural terminal deliberately ended the exchange — including deliveries you cancelled and terminal lurk outcomes.
- **Per-reply token counts** — output (and Codex reasoning) tokens straight from the CLI, not model self-reporting.
- **Two seats, extensible providers** — adding another CLI agent is one adapter function and a registry entry.

## Why you can trust it

**A small local application.** One Node entrypoint ([parley.mjs](parley.mjs)), focused [runtime modules](lib/), and plain [HTML](ui/index.html), [CSS](ui/styles.css), and [JavaScript](ui/app.js). Zero runtime dependencies, no database and no build step. Browser-testing tools are development dependencies.

- Binds **`127.0.0.1` only**, with a per-process token embedded in the served page and origin checks, so no random web page can drive your agents. Like any loopback app, that's not a boundary against another process already running as you.
- **Conservative by default.** Talk rooms run Claude with its normal print-mode permissions and Codex in the `read-only` sandbox. Work mode loosens that only for the agent you name; Full access for either provider is host-level trust and sits behind a deliberate confirmation.
- Reviewer, listener and discussion turns run read-only **where the provider can enforce it** — Claude is switched to Plan and kept out of any bypass-enabled session. Codex's equivalent lives inside its existing sandboxed thread, so it's a workflow instruction, **not an OS-level boundary**.

`npm test` boots a real server against fake agent CLIs and exercises routing, the delta protocol, sessions, lurk, hops, pair, lanes, work mode, seat sleep and cancellation — no provider login, no tokens spent. CI runs it on Ubuntu, Windows and macOS, Node 20, 22 and 24.

## Docs

| | |
|---|---|
| [docs/conversation.md](docs/conversation.md) | Routing, lanes and delivery, the queue, scoped stop and cancellation, lurk mode, hops, pair sessions |
| [docs/permissions.md](docs/permissions.md) | Talk vs work, Claude's permission modes, when a settings change takes effect, security posture |
| [docs/reference.md](docs/reference.md) | CLI flags, room folders, config, attachments, slash commands, adding a provider |
| [DESIGN.md](DESIGN.md) | Why it's shaped this way |
| [SECURITY.md](SECURITY.md) | Threat model and vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running the tests, sending a patch |
| [docs/planned-work.md](docs/planned-work.md) | The roadmap — what's settled, what's parked, and why |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

> Parley is a personal, local tool. Use only accounts and CLI access you're authorized to use, and follow the providers' current terms. Do not share credentials or resell access. A hosted multi-user service is outside its threat model.

MIT.
