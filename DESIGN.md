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
