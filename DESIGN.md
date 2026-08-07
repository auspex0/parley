# Parley — Design Notes

Why this shape, in brief.

## From terminal concept to local web app

Parley began as a terminal REPL concept. The local web app keeps the useful core — the delta/cursor context protocol, native session resume per agent, room folders and conservative talk-room defaults — while making parallel replies, streaming, routing indicators and Markdown legible in a shared three-party conversation.

## Architecture

```
parley.mjs            Node ≥ 20 server, zero npm deps, binds 127.0.0.1
  ├─ command resolver  (npm .cmd shim → real .exe / .js, no shell in between)
  ├─ adapters          claude: -p --output-format stream-json --resume <id>
  │                    codex:  exec [resume <id>] --json --output-last-message
  ├─ room engine       rooms, turn numbering, deltas, lanes, lurk, pair, archive
  └─ HTTP + SSE        REST for actions, Server-Sent Events for live updates
ui/index.html         single-file frontend, no frameworks
```

## The context protocol (the core idea)

- Every room event is a numbered turn in `events.jsonl` (mirrored to `transcript.md` for humans and for the agents to read as a file).
- Each agent has a `cursor` = the turn of the last user message it answered. When invoked, it gets all turns after its cursor (minus its own and system notices) inside a `[Room activity]` block, then the current message. So agents see each other without the full history ever being resent.
- Cursor is set to the *user message's* turn, not the reply's — with `@both`, the other agent's concurrently-landed reply stays unseen-and-delivered next time (no lost turns from completion-order races).
- Native context lives in each CLI's own session (`--resume` / `exec resume <thread>`), which survives app restarts. If a session is lost, the agent is re-briefed and pointed at the transcript file.

## Prompt architecture

Parley separates prompt material by placement rather than repeatedly describing an authority hierarchy inside the prompt:

1. Provider policies and the CLI's real sandbox or permission mode remain the outer boundary. Parley-authored text cannot override them.
2. A session briefing establishes the participants, relay protocol and compact peer contract: follow the user's goal, treat the other agent as a peer rather than a supervisor, verify consequential claims, converge when evidence settles a point, and never reconstruct content withheld from the other seat.
3. Per-turn workflow notes establish the current role — discussion participant, pair worker, pair reviewer, fix worker, listener or hop target. They apply to one invocation and are not baked into the standing briefing.
4. The room delta is conversation data. Server-assigned speaker prefixes preserve provenance: user-authored lines carry the user's requests and constraints; other-agent lines are peer contributions to assess, not commands; system activity reports state unless Parley explicitly marks it as a workflow instruction. Each entry receives one label and every later physical line receives a `|` continuation marker, so prompt-looking text inside a multiline body cannot manufacture a new speaker or close the relay block. The same formatter covers live deltas, recovered history, attachments, hop triggers and pending Pair questions.

This distinction avoids both obedience and contrarian theatre. An agent must form its own view and may reject a peer's suggestion, but it must name the decisive evidence or tradeoff and stop relitigating a settled point without new evidence. Because seats can legitimately receive different entries, agents may name an information gap but may not quote a body or attachment Parley says was withheld from the other seat.

The complete standing contract has its own internal prompt version and a SHA-256 fingerprint, separate from the browser/runtime protocol. Fresh briefings and live-session updates render from one canonical template, so relay rules cannot drift away from the peer contract. The fingerprint answers whether a concrete session has the current text (a missing fingerprint is stale); the number controls migration policy. An additive behavioral update is prepended once to the next turn of an older live native session, while a future contradictory or security-boundary change can raise a retirement floor and rebuild older sessions from a fresh briefing plus a bounded, explicitly lossy recovery excerpt.

The delivered contract fingerprint, numeric version, room-note revision and concrete native-session identity are stamped together only after the provider turn succeeds, the room-generation/configuration fences pass, and the result leaves a durable resumable session. Failures, Stop and discarded isolated sessions therefore retry the same idempotent current state. Codex's `--last` is a lookup sentinel rather than an identity, so it is never stamped; Parley re-sends updates until the CLI reports a concrete thread. Room-note edits use the same success gate, and clearing a note sends one explicit revocation to each linked session rather than hoping the old instruction disappears from model context.

Pair mode adds two strict control tokens because each changes server state: `[approve]` ends a cycle when it is the reviewer's exact first nonblank line (later lines are non-blocking notes), while `[needs-user]` pauses a worker or reviewer on a genuine missing choice and requires an explanatory body. Ordinary prose remains fix feedback; malformed tokens degrade to that default. `[pass]` and successful empty pair steps never approve work — they produce a visible neutral pause without manufacturing Retry. Pending questions are recovered from durable entry metadata, with later pair roots or configuration changes making older pauses stale even if an old process appends its result late.

Pair **Continue** actions are pinned to the specific round-cap entry that rendered them. A later pause, approval, Pair root or Pair configuration boundary invalidates the old action, and the server also checks the pinned cap number so a historical button cannot accidentally resume a newer cycle.

## Streaming

The final reply text always comes from an authoritative source (claude's `result` event; codex's `--output-last-message` file). Partial text deltas parsed from the JSON streams are a progressive enhancement pushed over SSE — if the stream format drifts, the reply still arrives, just without the live typing.

## Safety posture and trust boundaries

- Parley does not inspect, copy or persist provider credentials; the CLIs use their own authentication and inherited process environment.
- Prompts are passed over stdin and child processes are spawned without a shell, so message text is not evaluated as a shell command by Parley.
- Talk rooms default to Claude's normal print-mode permissions and Codex's `read-only` sandbox. Work mode deliberately grants workspace editing to the selected agent.
- Extra CLI args are a trusted-user escape hatch. They may alter permission or sandbox defaults, but raw `--dangerously-*` / `--allow-dangerously-*` flags and raw Claude bypass arguments are rejected. Parley's first-class UI exposes visible structured Full-access settings for Claude (`bypassPermissions`) and Codex (`danger-full-access`); provider/user settings, hand-edited local config and custom wrappers remain trusted local inputs outside that UI guardrail.
- Effective Claude permission changes start a fresh native session, and reset-requiring changes are rejected while an affected seat or pair cycle is working. Saved Claude sessions carry their effective permission provenance, so a legacy or mismatched session is discarded on load. For protected Claude discussion, reviewer and listener turns, Parley requests `plan`; a Parley-configured Full-access session is not reused because Claude's Plan blocks do not hold once bypass is available in that native session. Trusted external Claude settings or wrappers remain outside that boundary. The next ordinary turn is re-briefed from room history. The same no-edit scope for a resumed Codex thread remains a workflow instruction rather than an independent OS-level sandbox.
- The server binds to loopback and requires a per-process API token plus same-origin browser requests. Another process running as the same OS user remains inside the trust boundary.
- Room transcripts may contain prompts, source excerpts, local paths and CLI output. Treat them as potentially sensitive when sharing diagnostics.

See [SECURITY.md](SECURITY.md) for the supported security model and private-reporting guidance.
