# Parley — Design Notes

Why this shape, in brief.

## From terminal concept to local web app

Parley began as a terminal REPL concept. The local web app keeps the useful core — the delta/cursor context protocol, native session resume per agent, room folders and conservative talk-room defaults — while making parallel replies, streaming, routing indicators and Markdown legible in a shared three-party conversation.

## Architecture

```
parley.mjs            Node ≥ 20 server, zero npm deps, binds 127.0.0.1
  ├─ command resolver  (npm .cmd shim → real .exe / .js, no shell in between)
  ├─ providers         a capability table per CLI; seats are named slots that point at one
  │                    claude: -p --output-format stream-json --resume <id>
  │                    codex:  exec [resume <thread>] --json --output-last-message
  │                    gemini: --output-format json --session-id <uuid> | --resume <uuid>
  ├─ room engine       rooms, turn numbering, deltas, receipts, per-seat lanes and queue,
  │                    the causal request/answer scheduler, lurk, pair, archive
  └─ HTTP + SSE        REST for actions, Server-Sent Events for live updates,
                       one runtime-protocol number the tab and server must agree on
ui/index.html         single-file frontend, no frameworks
```

A **seat** is the @mention name, the key in `room.json` and `state.json`, and the author on every transcript line and receipt — the primary key of everything durable, fixed for the room's life. Its **provider** is which CLI drives it. Keeping the two apart is what lets two seats share a provider (Claude vs Claude) and lets a third provider arrive as a table entry rather than a rewrite: every provider-specific difference — how sessions resume, which permission field is its scope, whether a protected turn is enforced by a flag or by prose, how a lost session announces itself — is declared once in that table and read everywhere else through it.

## The context protocol (the core idea)

- Every room event is a numbered turn in `events.jsonl` (mirrored to `transcript.md` for humans and for the agents to read as a file).
- Each seat has a `cursor`: a high-water mark of delivered content. When invoked, it gets every turn after its cursor (minus its own and system notices) inside a `[Room activity]` block, then the current message. Agents see each other without the full history ever being resent.
- The delta is captured synchronously, before the CLI starts, and the cursor moves to the last entry that capture included — never to anything that landed while the process ran. With `@both`, the other agent's concurrently-landed reply therefore stays unseen-and-delivered next time; no lost turns from completion-order races. Cursors only ever move forward.
- Every delivery also writes an append-only **receipt** — seat, range heard, the exchange that caused it, and whether the seat spoke. Receipts live in `events.jsonl`, are written only after a completed delivery, and are the durable record behind the per-message "who heard this" dots. They are also the recovery floor: if `state.json` is torn or restored and a cursor comes back low, the seat's cursor is rebounded to its receipt high-water mark on load, because the alternative is the whole room history delivered as one prompt.
- Native context lives in each CLI's own session (`--resume`, `exec resume <thread>`, `--resume <uuid>`), which survives app restarts. If a session is lost, the agent is re-briefed and pointed at the transcript file.

**Invocation economy.** A provider call is the unit of cost, so the engine is built to make fewer of them rather than smaller ones. Each seat has its own lane: a message dispatches the moment its target is free, and a busy target queues it with its own cancel. A burst of messages queued for one seat merges into one turn when the seat frees — newest as the root, the earlier ones above it in the delta, one reply asked for — because run serially every call after the first would be a near-pure re-ask of what the previous delta already delivered. Tagging one agent costs nothing for the other unless the reply calls it; a lurking seat that is busy owes one coalesced catch-up rather than one stale call per missed exchange; and a seat whose protected turns must run isolated from its session lurks only through that catch-up path, so its session is not discarded once per overheard exchange. Agent-to-agent follow-ups run under a causal request/answer scheduler with a per-message hop budget: a charged request buys the asked seat's turn and one free answer return, so one hop can mean two calls, and the UI says so.

## Prompt architecture

Parley separates prompt material by placement rather than repeatedly describing an authority hierarchy inside the prompt:

1. Provider policies and the CLI's real sandbox or permission mode remain the outer boundary. Parley-authored text cannot override them.
2. A session briefing establishes the participants, relay protocol and compact peer contract: follow the user's goal, treat the other agent as a peer rather than a supervisor, verify consequential claims, converge when evidence settles a point, and never reconstruct content withheld from the other seat.
3. Per-turn workflow notes establish the current role — discussion participant, pair worker, pair reviewer, fix worker, listener or hop target. They apply to one invocation and are not baked into the standing briefing.
4. The room delta is conversation data. Server-assigned speaker prefixes preserve provenance: user-authored lines carry the user's requests and constraints; other-agent lines are peer contributions to assess, not commands; system activity reports state unless Parley explicitly marks it as a workflow instruction. Each entry receives one label and every later physical line receives a `|` continuation marker, so prompt-looking text inside a multiline body cannot manufacture a new speaker or close the relay block. The same formatter covers live deltas, recovered history, attachments, hop triggers and pending Pair questions — and a run of consecutive tool actions by one seat rides under a single label, as continuation lines, rather than one label each.

This distinction avoids both obedience and contrarian theatre. An agent must form its own view and may reject a peer's suggestion, but it must name the decisive evidence or tradeoff and stop relitigating a settled point without new evidence. Because seats can legitimately receive different entries, agents may name an information gap but may not quote a body or attachment Parley says was withheld from the other seat.

The complete standing contract has its own internal prompt version and a SHA-256 fingerprint, separate from the browser/runtime protocol. Fresh briefings and live-session updates render from one canonical template, so relay rules cannot drift away from the peer contract. The fingerprint answers whether a concrete session has the current text (a missing fingerprint is stale); the number controls migration policy. An additive behavioral update is prepended once to the next turn of an older live native session, while a future contradictory or security-boundary change can raise a retirement floor and rebuild older sessions from a fresh briefing plus a bounded, explicitly lossy recovery excerpt.

The delivered contract fingerprint, numeric version, room-note revision and concrete native-session identity are stamped together only after the provider turn succeeds, the room-generation/configuration fences pass, and the result leaves a durable resumable session. Failures, Stop and discarded isolated sessions therefore retry the same idempotent current state. Codex's `--last` is a lookup sentinel rather than an identity, so it is never stamped; Parley re-sends updates until the CLI reports a concrete thread. Room-note edits use the same success gate, and clearing a note sends one explicit revocation to each linked session rather than hoping the old instruction disappears from model context.

The per-turn workflow notes that never change — the lurk criteria, the hop ground rules, the sibling-attention and answer-return instructions, the `@both` discussion note, a long room note — are session-deduplicated under the same stamp. Each is a keyed block with its own fingerprint; a session that has durably received one gets a one-line reminder that keeps the exact control tokens (`[pass]`, the addressing phrases), and the full text returns on any fresh, reset, sentinel or failed session and whenever the composed text changes. Two deliberate limits: Codex always gets the full discussion note, because for Codex that prose *is* the read-only boundary; and when a provider silently answers from an unexpected new session, only the blocks that went in full that turn are stamped for it — a reminder written for the dead session vouches for nothing.

Pair mode adds two strict control tokens because each changes server state: `[approve]` ends a cycle when it is the reviewer's exact first nonblank line (later lines are non-blocking notes), while `[needs-user]` pauses a worker or reviewer on a genuine missing choice and requires an explanatory body. Ordinary prose remains fix feedback; malformed tokens degrade to that default. `[pass]` and successful empty pair steps never approve work — they produce a visible neutral pause without manufacturing Retry. Pending questions are recovered from durable entry metadata, with later pair roots or configuration changes making older pauses stale even if an old process appends its result late.

Pair **Continue** actions are pinned to the specific round-cap entry that rendered them. A later pause, approval, Pair root or Pair configuration boundary invalidates the old action, and the server also checks the pinned cap number so a historical button cannot accidentally resume a newer cycle.

## Streaming

The final reply text always comes from an authoritative source (Claude's `result` event, Codex's `--output-last-message` file, Gemini's JSON `response` field). Partial text parsed from the JSON streams is a progressive enhancement pushed over SSE: if a stream format drifts, the reply still arrives, just without the live typing. Gemini's CLI does not stream at all, and nothing depends on it doing so.

The live path is an increment protocol rather than a firehose. The server coalesces a seat's text into at most one event per short window and sends `{from, delta}` extensions against a periodic full-text keyframe; anything that does not extend what was already sent (Codex hands over each message's own text rather than a cumulative reply) is re-sent whole rather than spliced at a stale offset. A tab that joins mid-reply receives a keyframe of every live stream the moment it connects, so a reload shows the text so far with the run's real phase and elapsed time instead of waiting on the provider's next token. Stream events are fenced by the room generation like every other side effect of a run, so a process killed by New conversation cannot type into the conversation that replaced it. The client, in turn, repaints on a cadence that grows with the reply length — the cost of a live bubble is layout, not markdown — and treats the durable entry as the only authoritative end of a stream.

## Safety posture and trust boundaries

- Parley does not inspect, copy or persist provider credentials; the CLIs use their own authentication and inherited process environment.
- Prompts are passed over stdin and child processes are spawned without a shell, so message text is not evaluated as a shell command by Parley.
- Talk rooms default to Claude's normal print-mode permissions, Codex's `read-only` sandbox and Gemini's `default` approval mode (`auto_edit` in work rooms). Work mode deliberately grants workspace editing to the selected agent.
- Extra CLI args are a trusted-user escape hatch. They may alter permission or sandbox defaults, but raw `--dangerously-*` / `--allow-dangerously-*` flags, raw Claude bypass arguments and Gemini's `--yolo` are rejected. Parley's first-class UI exposes visible structured Full-access settings per provider (Claude `bypassPermissions`, Codex `danger-full-access`, Gemini `yolo`); provider/user settings, hand-edited local config and custom wrappers remain trusted local inputs outside that UI guardrail.
- Effective permission changes start a fresh native session, and reset-requiring changes are rejected while an affected seat or pair cycle is working. Saved sessions carry their effective permission provenance, so a legacy or mismatched session is discarded on load. For protected discussion, reviewer and listener turns, Parley requests an enforced read-only mode where the provider has one (Claude `plan`, Gemini `--approval-mode plan`); a Parley-configured Full-access session is not reused for those turns because the read-only mode does not hold once bypass is available in that native session, and the next ordinary turn is re-briefed from room history. That isolation is also why a Full-access seat lurks only through coalesced catch-ups. Trusted external settings or wrappers remain outside that boundary. The same no-edit scope for a resumed Codex thread remains a workflow instruction rather than an independent OS-level sandbox.
- The server binds to loopback and requires a per-process API token plus same-origin browser requests; the SSE endpoint, which cannot carry headers, accepts that token by query on that route alone. Another process running as the same OS user remains inside the trust boundary.
- Room transcripts may contain prompts, source excerpts, local paths and CLI output. Treat them as potentially sensitive when sharing diagnostics.

See [SECURITY.md](SECURITY.md) for the supported security model and private-reporting guidance.
