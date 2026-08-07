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

Parley assigns provenance rather than trusting message text to look like a header: each relayed entry starts with a server-authored speaker label, and every later physical line starts with `|`. CR/LF and the Unicode physical-line separators are normalized before framing. A pasted `user (to you): ...` line or `[End of room activity]` inside someone else's multiline reply therefore remains visibly part of that reply instead of becoming new user authority or closing the block. The same framing is used for live deltas, recovered history, attachments, hop triggers and pending Pair questions.

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

A free-text `lurkPrompt` overrides the preset's intervention criteria. Parley's silence protocol remains structural: when those criteria do not call for an interjection, the lurker must still return exactly `[pass]`, so custom wording cannot turn a silent pass into transcript output.

Lurkers deliberately respect your explicit constraints — if you demand "just yes or no," they won't pile on; they intervene when something consequential is left standing, like a risky plan mentioned in passing that the addressed agent didn't touch.

**Lurk-as-reviewer** is the flagship combination: a work room where one agent codes and the other lurks. The lurker sees every action, may read workspace files to verify, and interjects only when it has something real — a bug, a risk, a better approach. Continuous unprompted code review.

## Agent-to-agent hops & right of reply

If an agent explicitly @mentions the other in a reply ("@codex what do you think?"), the other qualifies for a response whether lurk is enabled or not. A soft direct address without the tag ("Codex, what do you reckon?") also qualifies when Codex is lurking, or when your original message addressed `@both`; ordinary prose such as "give Codex write access" does not. Markdown emphasis around a tag is transparent — `**@codex**` calls exactly like `@codex`.

A busy target waits for its current lane to finish instead of silently losing the call. `maxHops` limits these agent-triggered follow-ups per user message (Settings, default 0 = until the conversation settles), with a high emergency safety stop for accidental ping-pong. Separately, a lurker's spoken chime-in always earns the other agent one reply back, never counted against this budget.

Chains end at the configured budget, when a reply triggers nothing, on `[pass]`, on Stop/provider failure, or at the emergency stop. Pair-review turns remain governed by the pair loop rather than ordinary hops.

**Scheduling details.** An explicit agent handoff waits for the target's current turn. A scheduled lurk check is skipped when that listener is occupied by another lane, and it catches up via its next delta instead.

## Pair mode 🔁

`/pair start @agent [task]` turns the mode on and it *stays* on: from then on every message you send is done by the worker and then reviewed by the other agent, which reads files to verify claims and either approves — which is what ends a cycle — or gives feedback that triggers a fix round. The reviewer reports feedback and does not make the fix itself.

**Approval is a token, not a vibe.** The reviewer approves by replying `[approve]` as the exact first line; anything after that line is shown as non-blocking notes and does not trigger another round. Ordinary prose — including a bare "Approved." — is treated as feedback and starts a fix round: control tokens fail closed, so chatty language can never end a review by accident. The reviewer is told to withhold approval only for blockers (incorrectness, safety, a violated requirement, a regression, missing verification) and to approve correct work even when it would have chosen a different approach.

**Either agent can escalate to you.** When a genuine user decision blocks progress — a missing choice, an evidence conflict, an irreducible tradeoff — the worker or reviewer replies `[needs-user]` followed by the question, why it matters, and each option with its consequence. The cycle pauses with a ⏸ note and pair mode stays on. Your next pair-routed message starts a new pair root carrying your answer as ordinary room context; an explicitly tagged aside does not supersede the pending decision. The question is recorded durably and replayed to a fresh session after a restart. A `[needs-user]` with no question attached is malformed and is treated as ordinary prose.

**A `[pass]` or empty response never ends a cycle.** A reviewer that passes on reviewing (or returns no review), or a worker that passes on working/fixing (or returns nothing), pauses the cycle with an explicit note — nothing is approved, nothing silently evaporates, and a successful empty invocation is not mislabeled as a provider failure. **A failed or unavailable review likewise pauses the cycle and is never treated as approval.**

**There's no round limit by default:** you asked the two of them to work something out, so they keep going until the reviewer is satisfied, and a high safety stop still catches two agents that never converge. Set "Pair review rounds per message" in Settings if you want a hard stop — Settings updates a room-default pair mode for its next message (a cycle already running finishes with the cap it started with), while a number written directly in `/pair start 3 @claude …` remains that mode's explicit override. If the reviewer still isn't satisfied when the cap is reached, the note says so and offers **Continue →**, which hands the outstanding review back to the worker for another round rather than making you type a nudge.

A banner shows who's working and who's reviewing, with an End button; `/pair end` does the same. Ending the mode while a cycle is working lets that cycle finish from its original worker/reviewer snapshot; **Stop** aborts it. Explicitly tagging either seat — including the current worker (`@claude quick aside`) — is the escape hatch for a normal aside without triggering a review or superseding a pending user decision. Everything renders as ordinary chat turns with 🔁 badges, and the mode survives a restart.

A historical **Continue** action is not timeless: it is pinned to the exact round cap that rendered it. Parley rejects it after a pause, approval, newer Pair root or Pair reconfiguration, so an old button cannot resume different work by accident.

Parley requests Plan for Claude reviewers and isolates them from a Parley-configured Full-access session; Codex reviewer separation is a workflow instruction rather than a separate OS sandbox. See [permissions.md](permissions.md).

## How the prompts are built

Parley composes each agent's context from layers with different authority, and the layering is **structural rather than narrated** — where a piece of text is delivered says what it is, so prompts never have to plead about who outranks whom:

- **The briefing** (once per native session) carries the standing rules: who the participants are, how messages are relayed, and the peer contract — follow the user's goal, treat the other agent as a peer rather than a supervisor, verify consequential claims, don't manufacture disagreement, don't relitigate settled points without new evidence, and don't reproduce content Parley says was withheld from the other seat. A fresh session composes the current contract at call time.
- **Per-turn role notes** (the pair worker/reviewer/fix notes, the lurk instruction, the discussion note) apply to exactly one turn and are appended to that turn's prompt, never baked into the briefing.
- **The relayed delta** carries conversation content: user-authored lines convey requests and constraints, other-agent lines are peer contributions to evaluate, and system lines report room state unless explicitly marked as a workflow instruction. Server-assigned entry labels plus `|` continuation markers keep those roles intact even when a body contains prompt-looking prefixes of its own.

Provider security policies and actual sandbox or permission restrictions remain above every Parley-authored layer; prompt wording cannot weaken those boundaries. See [DESIGN.md](../DESIGN.md#prompt-architecture) for the internal composition and versioning rationale.

**Pair control tokens** are line-exact and read from the first nonblank line of a reply: `[approve]` (reviewer only — ends a pair cycle; trailing lines are non-blocking notes) and `[needs-user]` (worker or reviewer — pauses the cycle on a genuine user decision; requires the question as a body). `[pass]` is the canonical whole reply for a lurker or hop target staying silent; in a pair cycle it pauses rather than approves. Its parser still tolerates legacy surrounding punctuation, but every prompt instructs the exact token. A malformed pair token degrades to ordinary prose — a sentinel only ever adds control flow, never a stuck room.

**Prompt versioning.** Fresh briefings and resumed-session updates come from the same canonical standing-contract template. A numeric version controls migration policy, while a content fingerprint detects changed text (and treats a missing legacy fingerprint as stale). A live session with either mismatch gets a one-time `[Update to your standing instructions]` block containing the complete contract. Version, fingerprint and concrete native-session identity are recorded only after that turn durably succeeds — a failed or stopped turn re-sends the update next time, exactly as the delivery cursor re-sends the room delta. Codex's `--last` fallback is not a durable identity, so updates repeat until a concrete thread id is reported. A future *contradictory* change can instead retire outdated sessions outright (they re-brief from the transcript); that retirement floor ships dormant.

**Room-note lifecycle.** An active room note remains visibly framed as current user-authored instruction on every turn. Edits and clears increment a durable room revision, and each concrete seat session records the exact revision it successfully received. Clearing sends that session one explicit “no room note is active” revocation; failure or Stop leaves the old revision in place so the revocation is retried, while a later success prevents it repeating forever. A reset session receives only the current note state and binds it to its new native-session identity.

**Session recovery** replays a bounded history excerpt inline and says so honestly: the excerpt is not proof that omitted matters were undecided; withheld bodies and attachment metadata remain omitted while a generic withdrawal notice preserves chronology; and when pair mode is on the briefing adds the deterministic pair state — roles, rounds, and any pending `[needs-user]` question, mined from the durable transcript record rather than duplicated into a second store. A `[pass]` pause is reported as "paused, no question pending", never as a pending decision.
