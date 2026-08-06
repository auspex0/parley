# How the room behaves

Routing, delivery, the context protocol, lurk mode, agent-to-agent hops and pair sessions. This is the detailed reference; the [README](../README.md) has the short version.

## Talking to the table

| You type | What happens |
|---|---|
| `@claude <text>` | Goes to Claude only |
| `@codex <text>` | Goes to Codex only |
| `@both <text>` | Goes to both **in parallel**; replies stream in as they complete |
| `<text>` (no tag) | Goes to whoever you last addressed (routing hint shows the target) |

You can also pick the target with the chips above the composer, but only explicit `@tags` route from the text: a leading tag is stripped from a single-agent message, a tag can appear anywhere ("hey @codex, thoughts?"), and tagging both names in one message routes to both. Plain names such as "Claude, do X" do not change the route. Text tags beat the selected chip; after a tagged message is accepted, the chip follows the server-resolved target so the next untagged message does not accidentally keep an older destination. The `→` hint next to the chips previews the resolved target before you send, and typing `@` pops up an autocomplete.

## Lanes and delivery

Each agent has its own **lane**: a message dispatches immediately if *its* target is free, even while the other agent works. Tag them separately back-to-back and they genuinely work in parallel — your explicit per-agent addressing is the consent for that (`@both` in work rooms stays discussion-only).

Everything you send is accepted the moment you send it — it appears in the conversation straight away, in the order you sent it, and only its *delivery* waits for a busy agent (⏳ badge, delivered in order). `@both` is delivered per lane too: the free agent answers immediately and the busy one receives the same message when it finishes, badged "⏳ delayed". Sent while both are busy, each answers as it frees rather than both waiting for the slower one.

Your message is never posted twice, and the exchange it triggers still runs once, after both have replied. Splitting never reorders anything: a held half joins the back of that agent's own lane, so a message you sent earlier is still answered first. Everything you send outranks agent-to-agent follow-ups, so the agents can't answer each other before they answer you; and a late agent that has already read the early one's reply isn't asked about it a second time.

Pair turns are the exception — they need both agents in one configuration, so the *cycle* waits as a unit; the mode change and the task itself still land the moment you send them. An agent never runs two calls at once.

While anything is running you can always see **what each agent is answering**: a clickable quote header sits inside the live reply and stays there once the reply lands, so scrollback keeps the reference. Click it to expand earlier history if needed, scroll the original message into view and highlight it. If the live reply is scrolled off-screen, a compact strip above the composer says the same thing instead (two rows, then "+N more").

### The queue

The **⏳ queued** badge opens the queue itself. One card per *dispatch* — the batch of deliveries one send created — showing which agents are responding and which are waiting, with their positions; clicking a card jumps to the message that produced it. Its ✕ cancels everything that dispatch still has waiting without touching anything already running, and "Cancel all queued" is there for the blunt version.

### Cancelling — withdrawal, not deletion

Cancelling withdraws the *delivery*, not the durable room record: the message was accepted the moment you sent it and remains part of the room's history, but the withdrawn seat receives none of its content. From then on Parley stops putting it in front of the agent it was withdrawn from — not in that turn's prompt, not in any later one, not in the history replayed after a session reset, and not as a native image or staged file. That agent is told only that a message was sent and cancelled; an agent that *did* receive it keeps it in full and is told who missed it. Stop everything drops the queue on the same terms. If a later retry of that turn re-delivers the message, its withheld markers are cleared — the seat then receives it in full, and later deltas stop describing it as withheld.

This is about what Parley sends, not a secrecy guarantee. The message is still in `transcript.md`, and every agent is told where that file is — a work-mode agent that goes looking can read it, exactly as it can read anything else in the room. Per-seat transcript privacy would be a different feature; if you need a message to be unreadable rather than undelivered, start a fresh conversation.

### Stop is four intentions, not one button

**Stop** is four separate intentions rather than one button and a guess: stop a named agent's current response, stop the current responses but keep queued work, cancel the queue but let the running responses finish, or stop everything — responses, pair cycle, hops, lurkers and queue. Each click names the response it meant, so a click that lands after that response has already ended does nothing rather than killing the next one, and it never reports an error you would answer by clicking again.

Each reply shows its **output tokens** (and Codex's reasoning tokens) in the message meta — flip the reasoning-effort setting and watch the numbers move; that's ground truth from the CLI, not model self-reporting.

## What each agent sees

When you message an agent, it receives everything that happened in the room since its own last turn — your messages to the other agent, and the other agent's replies — inside a `[Room activity]` block, then your message. Its own private context lives in its native CLI session, so history is never resent wholesale.

**Token frugality is the default:** tagging one agent costs *nothing* for the other — the untagged agent isn't invoked at all, and catches up for free the next time you talk to it.

### Receipt dots (who was listening)

Under every message, one dot per other participant shows how they experienced it:

- **solid** — heard live (addressed, or lurked and chimed in)
- **faded solid** — lurked but had nothing to add
- **outlined** — caught up later via the delta (tooltip says at which turn)
- **dim outline** — hasn't seen it yet
- **red outline** — you cancelled that delivery before the agent saw it

Powered by an audience snapshot stamped on each user message, append-only delivery receipts in `events.jsonl`, and persisted per-seat withdrawal state — no extra model calls.

## Lurk mode 👂

Opt-in per agent, per room (the 👂 on each agent's pill; config key `agents.<name>.lurk`). A lurking agent overhears every exchange it wasn't addressed in: after the addressed agent replies, the lurker is invoked with the delta and may chime in (marked "👂 chimed in") or silently pass (a brief "listened — nothing to add" whisper). Costs one extra call to the lurking agent per message — that's the trade for real-time awareness and unprompted interjections.

Whether a lurker speaks is its own model's judgment — there is no mechanical trigger — so Settings gives each agent a dial (`lurkStyle`):

- **`quiet`** — interjects only for outright problems: an uncorrected error, something about to break.
- **`balanced`** (default) — adds real disagreements, critical caveats and needs the exchange left unmet.
- **`vocal`** — adds better approaches and useful additions; only small talk stays silent.

A free-text `lurkPrompt` overrides the preset entirely if you want your own criteria.

Lurkers deliberately respect your explicit constraints — if you demand "just yes or no," they won't pile on; they intervene when something consequential is left standing, like a risky plan mentioned in passing that the addressed agent didn't touch.

**Lurk-as-reviewer** is the flagship combination: a work room where one agent codes and the other lurks. The lurker sees every action, may read workspace files to verify, and interjects only when it has something real — a bug, a risk, a better approach. Continuous unprompted code review.

## Agent-to-agent hops & right of reply

If an agent explicitly @mentions the other in a reply ("@codex what do you think?"), the other qualifies for a response whether lurk is enabled or not. A soft direct address without the tag ("Codex, what do you reckon?") also qualifies when Codex is lurking, or when your original message addressed `@both`; ordinary prose such as "give Codex write access" does not.

A busy target waits for its current lane to finish instead of silently losing the call. `maxHops` limits these agent-triggered follow-ups per user message (Settings, default 0 = until the conversation settles), with a high emergency safety stop for accidental ping-pong. Separately, a lurker's spoken chime-in always earns the other agent one reply back, never counted against this budget.

Chains end at the configured budget, when a reply triggers nothing, on `[pass]`, on Stop/provider failure, or at the emergency stop. Pair-review turns remain governed by the pair loop rather than ordinary hops.

**Scheduling details.** An explicit agent handoff waits for the target's current turn. A scheduled lurk check is skipped when that listener is occupied by another lane, and it catches up via its next delta instead.

## Pair mode 🔁

`/pair start @agent [task]` turns the mode on and it *stays* on: from then on every message you send is done by the worker and then reviewed by the other agent, which reads files to verify claims and either replies `[approve]` — which is what ends a cycle — or gives feedback that triggers a fix round. The reviewer reports feedback and does not make the fix itself. **A failed or unavailable review pauses the cycle and is never treated as approval.**

**There's no round limit by default:** you asked the two of them to work something out, so they keep going until the reviewer is satisfied, and a high safety stop still catches two agents that never converge. Set "Pair review rounds per message" in Settings if you want a hard stop — Settings updates a room-default pair mode for its next message (a cycle already running finishes with the cap it started with), while a number written directly in `/pair start 3 @claude …` remains that mode's explicit override. If the reviewer still isn't satisfied when the cap is reached, the note says so and offers **Continue →**, which hands the outstanding review back to the worker for another round rather than making you type a nudge.

A banner shows who's working and who's reviewing, with an End button; `/pair end` does the same. Ending the mode while a cycle is working lets that cycle finish from its original worker/reviewer snapshot; **Stop** aborts it. Explicitly tagging someone (`@codex what do you think?`) is the escape hatch for a normal aside without triggering a review. Everything renders as ordinary chat turns with 🔁 badges, and the mode survives a restart.

Parley requests Plan for Claude reviewers and isolates them from a Parley-configured Full-access session; Codex reviewer separation is a workflow instruction rather than a separate OS sandbox. See [permissions.md](permissions.md).
