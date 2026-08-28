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

Everything you send is accepted the moment you send it — it appears in the conversation straight away, in the order you sent it, and only its *delivery* waits for a busy agent (⏳ badge, delivered in order). `@both` is delivered per lane too: the free agent answers immediately and the busy one receives the same message when it finishes, badged "⏳ delayed". Sent while both are busy, each answers as it frees rather than both waiting for the slower one. Provider turns remain atomic: a reply that lands while its sibling is still generating is not injected into that running prompt. Once both initial `@both` turns have succeeded, Parley delivers each sibling reply to the other at the next safe boundary; a cancelled, sleeping or failed half is not resurrected by that rule.

**A burst becomes one turn.** Several messages sent to one seat while it is busy used to run one provider call each, back to back — and every call after the first was a near-pure re-ask, because the previous turn's delta had already delivered the later messages. When the seat frees, the ready burst now merges into a single turn shaped exactly like Wake & deliver: the newest message is the root, the earlier ones sit above it in the delta at their real positions, and a note asks for one reply covering all of them. Each message keeps its own ⏳ cancel while it waits; @both halves, pair turns and redirects never merge.

Your message is never posted twice, and the exchange it triggers still runs once, after both have replied. Splitting never reorders anything: a held half joins the back of that agent's own lane, so a message you sent earlier is still answered first. Everything you send outranks agent-to-agent follow-ups, so the agents can't answer each other before they answer you; and a late agent that has already read the early one's reply isn't asked about it a second time.

**Wake & deliver and Retry recover the original exchange, not just one provider call.** The recovery attempt rejoins the same causal request/answer scheduler and keeps that root's snapshotted relay policy. For `@both`, a newly successful recovered half is delivered structurally to a sibling only when that sibling has its own successful direct reply to this exact user root. A high cursor or unrelated later turn is not enough evidence: a failed or stopped half is never resurrected as an automatic sibling call. A recovered single-seat exchange follows a different rule: enabled lurk runs at the safe boundary even if the addressed provider failed, passed or produced no bubble, matching ordinary live fan-out. Explicit Stop ends the chain instead and records `stopped` for eligible listeners. If the listener is busy, Parley persists a catch-up obligation naming the recovered root explicitly.

Pair turns are the exception — they need both agents in one configuration, so the *cycle* waits as a unit; the mode change and the task itself still land the moment you send them. An agent never runs two calls at once.

While anything is running you can always see **what each agent is answering**: a clickable quote header sits inside the live reply and stays there once the reply lands, so scrollback keeps the reference. Click it to expand earlier history if needed, scroll the original message into view and highlight it. If the live reply is scrolled off-screen, a compact strip above the composer says the same thing instead (two rows, then "+N more").

### The queue

The **⏳ queued** badge opens the queue itself. One card per *dispatch* — the batch of deliveries one send created — showing which agents are responding and which are waiting, with their positions; clicking a card jumps to the message that produced it. Its ✕ discards everything that dispatch still has waiting without touching anything already running, and "Discard all queued" is there for the blunt version.

### Holding the queue ⏸

**Pause** holds the queue without dropping any of it. Nothing new starts, responses already running finish normally, and the queue keeps its exact contents and order — the badge switches to **⏸ held** and cards read "held #2" rather than "queued #2". Anything you send while it is held joins the queue too, so pause-then-compose works: line up three messages, read what came back, then release them. **Resume** starts everything whose seat is free, in order.

The hold is about *your* work, not the agents'. Hops, a live lurker's right of reply and causal answers between the agents are unaffected — a paused delivery stops competing for the seat, so an agent follow-up is not left waiting on a seat nobody is going to claim. A lurk catch-up owed to a held seat becomes a persisted obligation that runs on resume, exactly as it would behind a busy seat.

Pause is deliberately not saved across a restart: there would be no queue behind it, and it would silently swallow the first thing you sent. It is also armed rather than counted — pausing an empty queue is allowed and holds whatever you send next, which is why the badge stays visible saying so.

### Discarding — withdrawal, not deletion

Discarding withdraws the *delivery*, not the durable room record: the message was accepted the moment you sent it and remains part of the room's history, but the withdrawn seat receives none of its content. The message keeps its place in the thread, dims, and grows a **Discarded before delivery · Retry** line — that Retry re-delivers it to the seat that missed it, at the tail of that seat's lane, so it cannot overtake anything you sent since. From then on Parley stops putting it in front of the agent it was withdrawn from — not in that turn's prompt, not in any later one, not in the history replayed after a session reset, and not as a native image or staged file. That agent is told only that a message was sent and cancelled; an agent that *did* receive it keeps it in full and is told who missed it. Stop everything drops the queue on the same terms. If a later retry of that turn re-delivers the message, its withheld markers are cleared — the seat then receives it in full, and later deltas stop describing it as withheld.

This is about what Parley sends, not a secrecy guarantee. The message is still in `transcript.md`, and every agent is told where that file is — a work-mode agent that goes looking can read it, exactly as it can read anything else in the room. Per-seat transcript privacy would be a different feature; if you need a message to be unreadable rather than undelivered, start a fresh conversation.

### Ask again and Redirect ↪

Every message carries a **↪** that asks about *that* message. Pick a seat, optionally type an instruction, and choose what to do with it. With the seat free there is one action, **Ask now**. With it busy there are two that genuinely differ: **Queue after current**, which waits its ordinary turn and leaves everything already queued in place, and **Stop current & ask now**, which ends the response on screen and puts your message next.

Leaving the instruction empty is **Ask again** — the message reads "Continue responding to this message." rather than being blank, so a transcript read months later still shows what happened. Either way the result is a real user message with a **↪ asking about** header pointing at the message it came from; nothing is silently attributed to you that you did not cause.

The quoted message is restaged into that turn's prompt, so the seat can answer even if the message is far back in its context — or gone entirely after a session reset. A message that was discarded for that seat stays discarded: it sees the reference and your instruction, never the withheld body.

**Stop current & ask now is one request, not two.** A Stop click followed by a Send leaves a gap in which the killed response finishes and the queue starts something else. Here the stop is pinned to the response you were actually looking at, and the redirect is placed in the same tick — so the stopped reply's last words are always ordered before your redirect, and the follow-ups it would have triggered are cancelled with it. Work you queued earlier is not flushed; it simply waits behind the redirect, and its card says **↪ next** so the reordering is visible rather than mysterious. If the response finished between your click and the request landing, nothing is killed and your message is next in line.

### Stop is four intentions, not one button

**Stop** is four separate intentions rather than one button and a guess: stop a named agent's current response, stop the current responses but keep queued work, cancel the queue but let the running responses finish, or stop everything — responses, pair cycle, hops, lurkers and queue. Each click names the response it meant, so a click that lands after that response has already ended does nothing rather than killing the next one, and it never reports an error you would answer by clicking again.

**The ■ button acts; the ▾ beside it chooses.** When one seat is replying and nothing is queued — the ordinary case — ■ stops that response on the first click, and the follow-ups it would have triggered stop with it. It widens only when a single click genuinely cannot answer the question: two seats running, work still queued, or a pair cycle in flight all open the chooser instead. The ▾ opens that same chooser whenever you want it, which is where per-seat stops live. An open menu is a snapshot: rows never reorder under your cursor, and work that finishes while you are aiming goes grey in place rather than vanishing.

Each reply shows its **output tokens** (and Codex's reasoning tokens) in the message meta — flip the reasoning-effort setting and watch the numbers move; that's ground truth from the CLI, not model self-reporting.

## What each agent sees

Parley assigns provenance rather than trusting message text to look like a header: each relayed entry starts with a server-authored speaker label, and every later physical line starts with `|`. CR/LF and the Unicode physical-line separators are normalized before framing. A pasted `user (to you): ...` line or `[End of room activity]` inside someone else's multiline reply therefore remains visibly part of that reply instead of becoming new user authority or closing the block. The same framing is used for live deltas, recovered history, attachments, hop triggers and pending Pair questions.

When you message an agent, it receives everything that happened in the room since its own last turn — your messages to the other agent, and the other agent's replies — inside a `[Room activity]` block, then your message. Its own private context lives in its native CLI session, so history is never resent wholesale.

**Token frugality is the default:** tagging one agent costs *nothing* for the other when the addressed agent's reply does not call it — a single-seat, untagged reply does not wake an unrelated peer. The peer catches up from its cursor the next time it has a real delivery. The deliberate exceptions are `@both` sibling attention, a live lurker's right of reply, and causal answers owed to the caller of an agent request.

### Receipt dots (who was listening)

Under every message, one dot per other participant shows how they experienced it:

- **solid** — heard live (addressed, or lurked and chimed in)
- **faded solid** — lurked but had nothing to add
- **pending** — selected to lurk, but occupied; one catch-up is queued behind user work
- **outlined** — caught up later via the delta (tooltip says at which turn)
- **dim outline** — hasn't seen it yet
- **red outline** — you cancelled that delivery before the agent saw it
- **amber outline** — the agent *did* receive it and you stopped its response part-way

Powered by an audience snapshot stamped on each user message, append-only delivery receipts in `events.jsonl`, and persisted per-seat withdrawal, interruption, catch-up, causal-answer and terminal-outcome state. The dot reflects the latest truth: a later successful delivery supersedes an earlier queued or failed lurk, while cap and terminal copy distinguish a deliberate stop from an answer still owed.

Red and amber are the two halves of the same fact, and both outrank every receipt. Red says the agent never saw the message; amber says it saw it and you cut the answer short. Neither resolves on its own — every later turn carries the message in context, so nothing but that same seat completing a run rooted in that same message clears it. Retry, Wake & deliver and a fresh explicit ask all count; an unrelated later exchange does not.

### A message says what happened to it

A message whose delivery you cancelled, or whose response you stopped, keeps its place in the thread and stays the quote and jump target — the record does not move or disappear. It dims, and grows a small per-seat status line underneath: **Cancelled before delivery**, **Delivered to Claude · Cancelled for Codex**, **Response stopped before it finished**. The old floating cancellation pill is gone from the timeline; the record itself is unchanged and still reaches the agents and `transcript.md`, it just no longer explains itself from somewhere further down the page.

## Lurk mode 👂

Opt-in per agent, per room (the 👂 on each agent's pill; config key `agents.<name>.lurk`). A lurking agent overhears every exchange it wasn't addressed in: after the addressed agent replies, the lurker is invoked with the delta and may chime in (marked "👂 chimed in") or silently pass (a brief "listened — nothing to add" whisper). Normally that costs one extra call to the lurking agent per message — that's the trade for real-time awareness and unprompted interjections.

If the listener is occupied — either running a turn or already owing user-addressed work in its lane — the lurk is delayed, not discarded. Parley persists one coalesced obligation per seat outside the user queue, extends it across further missed exchanges, and waits until every accepted user exchange and queued delivery has settled. User work therefore always wins. The listener then gets one full-delta catch-up, with the missed exchanges in their real chronological order, rather than one stale call per message. Roots that actually selected the seat to lurk are marked actionable; later Solo and otherwise-unselected messages remain visible as context for deciding whether an issue became stale, but cannot themselves trigger an interjection. Any ordinary successful invocation that has already advanced its cursor past the obligation supersedes the catch-up automatically.

The obligation survives a restart and is attempted once. A successful spoken response or `[pass]` advances the cursor and writes the ordinary receipt. A spoken catch-up earns the other seat one bounded, read-only right of reply; if that seat speaks, its answer is delivered once back to the original lurker as a read-only **causal closure**. The closure may answer or `[pass]`, but it is terminal: tags in it schedule nothing and there is no fourth leg. Before launch, putting the seat to sleep or turning lurk off cancels the obligation and records why; if the catch-up is already running, Sleep's ordinary future-launch rule lets that turn finish unless you Stop it. Provider failure or Stop ends the attempt without advancing the cursor and leaves a durable outcome for the receipt dot. There is no automatic retry loop, though a later deliberate delivery can still catch the seat up from the unchanged cursor. **Archive & start fresh** clears the obligation with the rest of the old conversation.

A seat with **Full access** that also lurks is a special case: its protected listener turns must run isolated from its native session, so live lurking would discard the session on every overheard exchange and force a full re-brief on every turn of that seat. Those lurks therefore ride the catch-up machinery instead — several overheard exchanges coalesce into one delayed reaction — and a room notice says so when the combination is enabled. Separately, stopping a seat's response now also stops the other seat's lurk on that exchange: there is no answer left to react to, and the extra call would land exactly when quota is the concern.

Whether a lurker speaks is its own model's judgment — there is no mechanical trigger — so Settings gives each agent a dial (`lurkStyle`):

- **`quiet`** — interjects only for outright problems: an uncorrected error, something about to break.
- **`balanced`** (default) — adds real disagreements, critical caveats and needs the exchange left unmet.
- **`vocal`** — adds better approaches and useful additions; only small talk stays silent.

A free-text `lurkPrompt` overrides the preset's intervention criteria. Parley's silence protocol remains structural: when those criteria do not call for an interjection, the lurker must still return exactly `[pass]`, so custom wording cannot turn a silent pass into transcript output.

Lurkers deliberately respect your explicit constraints — if you demand "just yes or no," they won't pile on; they intervene when something consequential is left standing, like a risky plan mentioned in passing that the addressed agent didn't touch.

**Lurk-as-reviewer** is the flagship combination: a work room where one agent codes and the other lurks. The lurker sees every action, may read workspace files to verify, and interjects only when it has something real — a bug, a risk, a better approach. Continuous unprompted code review.

## Sleeping a seat 😴

A rate-limited seat can still be invoked — by you, by a queued delivery, or by the other agent writing `@claude` into a reply. Sleep is the per-seat, per-room switch that stops all of it: the 😴 on the seat's pill, or `/sleep @agent [reason]` when the reason is worth recording (`/wake @agent` brings it back).

Sleep is **manual only**. Parley never infers it from a provider error — the CLIs report exit codes and stderr text, not a stable rate-limit signal — and the failure is already in front of you, so you decide.

- **Nothing launches that seat.** One authoritative gate sits at the turn-launch functions rather than per route, so every path is covered: your message, the held half of a split `@both`, an explicit `@tag` from the other agent, a soft direct call, a scheduled lurk check, Retry, and a pair step.
- **Your messages are held, not refused.** Sending to a sleeping seat lands the message in the thread where you sent it, marked `📥 held until wake`, and it is delivered when you wake the seat — so you never have to keep the request in your head and re-send it later. `@both` splits: the awake seat answers now, the sleeping seat's copy waits. A held message launches *nobody*, including the other seat as a lurker.
- **What the agents do while asleep is dropped, and said so.** An `@tag` from the other agent, a lurk check or a pair step is skipped and recorded as not delivered — those go stale, and replaying them on wake would produce a burst of invocations. The other agent's lurk instruction reads silence as agreement, so an unrecorded skip would manufacture consensus. Both agents see these notices in their delta.
- **Pair mode pauses.** It never substitutes the awake seat for the sleeping role or runs a cycle with half of it missing. A cycle already in flight finishes the step it is on, then pauses with nothing approved.
- **Future launches only.** A response already running finishes; Stop remains the separate explicit action. Deliveries the lanes still owe that seat are cancelled immediately, in one consolidated note, rather than waiting to fail later.
- **Waking asks what to do with what is held.** With nothing held, the 😴 is a plain toggle. With messages waiting it opens a two-way menu: **Wake & deliver** answers all of them in *one* turn, rooted at the newest, with the earlier ones and everything that happened in between still in their real positions — so the seat can tell a stale request from a live one and say where later context overtook it. The recovery attempt then rejoins the root's causal relay: a successful recovered `@both` reply reaches an already-successful direct-root sibling structurally, while a single-seat recovery gets its configured lurk pass even when the addressed attempt failed, passed or produced no bubble (or a persisted catch-up if the listener is busy). Explicit Stop ends the chain and records why instead of spawning downstream work. **Wake only** wakes the seat and leaves held messages as ordinary context; it launches no relay. Clicking elsewhere cancels.
- **Waking replays nothing on its own.** The cursor does not move, so everything said while the seat slept — including every "not delivered" entry — is still ahead of it and arrives as ordinary context on its next deliberate delivery. A cursor jump would throw away exactly the record of having been asked. The pill shows the backlog (`asleep · 3 held · 14 pending`) because this is the one moment the size of a turn is knowable before it runs. The held count is a *subset* of pending, not an addition to it, and it stays visible after **Wake only** until a turn actually delivers those messages.
- **Both edges are persisted**, not merely broadcast — otherwise a restart would leave a transcript where a seat goes quiet and later starts talking again with nothing explaining either.

Sleep lives in `state.json` beside the per-seat cursors, not in `room.json` beside `lurk`: it is a temporary, externally caused *condition*, not part of how the seat is configured. So it survives restarts, and it survives **Archive & start fresh** — a rate-limited account does not become invocable again because you archived a conversation.

## Agent-to-agent hops & right of reply

The live relay is a causal **request/answer scheduler**. A request is an agent-produced entry that Parley owes to one peer:

- **Charged requests** are an explicit agent `@tag` and any continuation spoken from a returned causal answer. They spend `hopBudget` when the target is actually launched.
- **Structural requests** are the safe-boundary delivery between two successful initial `@both` replies and a live lurker's one right of reply. Their shape already bounds them, so they do not spend `hopBudget`.

A single-addressed reply that neither tags nor otherwise calls the peer creates no request. That boundary keeps ordinary one-seat work quiet instead of turning every agent utterance into a two-seat call. Markdown emphasis around a real tag is transparent — `**@codex**` calls exactly like `@codex` — while ordinary prose such as "give Codex write access" does not.

Mentions inside fenced code, inline code and blockquotes are examples, not routing. Parley masks those regions only in a detection copy, preserving every newline; the transcript and prompt remain untouched. This also prevents a pasted `@codex` example from consuming a handoff.

The server, not the model, owns the counter. `hopBudget` is snapshotted when each user message is accepted, and charged usage is persisted against that user-message root. Wake & deliver and Retry therefore resume the root's already-spent count and remaining budget instead of minting a fresh allowance. The bounded execution-history map retains the newest 200 inactive roots with charged usage, plus any older root that is still active, held or retryable, so state stays bounded without erasing an unresolved exchange's cap:

- **`-1` / `∞`** — follow up until the exchange settles, still fenced by the emergency safety stop.

A new room starts at **3** rather than ∞. One charged hop can mean two provider calls, so an unlimited default let a first cross-tagged exchange spend a dozen before anyone had a feel for what a hop costs; ∞ is one click away in the composer control and in Settings, and rooms created before this keep whatever they had.
- **`0`** — launch no charged requests; structural requests and answers already owed still run.
- **positive integer** — launch at most that many charged requests. Settings accepts any safe whole number; the compact composer control offers quick values through `8`.

The initial agent response is not a hop. A charged request spends one hop only when Parley launches its target: an asleep target or a late target whose cursor already covers the request spends nothing, while a launched call that later fails still spends one. Structural requests remain eligible even at budget zero.

Every launched request that produces an answer earns one free, read-only **answer return** to its immediate caller. If that return says `[pass]`, the chain settles. If it speaks, that speech becomes the next charged request to the agent who supplied the answer — no new `@tag` is required, and an explicit tag does not charge the same return twice. Consequently one counted hop can launch up to two provider turns: the charged request itself and its uncharged answer return. Further speech must spend the next hop.

At the cap, Parley does not launch the next charged request. Its text is already in the transcript and reaches that seat as ordinary context on a later deliberate turn; a durable system line records what was not delivered. Cursor reconciliation happens before that line is written, so a structural or full-delta delivery that already carried the entry cannot leave a false cap notice. The live counter beside the composer reports charged launches in the latest active exchange, and each launched charged request is told how many remain; the relay remains authoritative if the model ignores the hint.

The composer control is a sticky shortcut: **Room default**, **Solo**, `∞`, or `0`–`8`. Its choice remains selected across sends and page reloads for that room during the current browser session; switching rooms restores that room's own shortcut. Every accepted user message still receives its own immutable policy snapshot. **Solo** requires one ordinary addressee, suppresses both lurk and agent-to-agent handoffs for that message, and is rejected with `@both` or a Pair turn. It controls reaction, not later visibility: the other seat can still read that transcript entry in a future delta.

The live status beside it belongs to the exchange already running, not to the shortcut for later messages. For example, **Hops used 3 · limit ∞** means three charged requests have launched in an exchange that started under `∞`; selecting `3` while it runs affects subsequent accepted messages and cannot retroactively rewrite that exchange.

A busy request target waits for its lane instead of losing the call, but never interrupts a provider turn already in progress. Successful initial `@both` replies are each structural requests to their sibling at that safe boundary, even with `hopBudget: 0`; this is how the slower-looking transcript order is reconciled with what each atomic prompt actually contained.

The same coordinator owns recovered work from **Wake & deliver** and **Retry**. It resumes the original root's budget snapshot **and durable charged-use count** rather than inventing a new exchange contract or resetting its cap. A recovered `@both` reply structurally reaches an earlier sibling only when that sibling's durable agent entry replies directly to the same user root; cursor position alone cannot qualify it, so provider failure or Stop is never turned into an implicit retry. Independently, every recovered single-seat attempt follows the room's current enabled-lurk contract after the attempt settles — success, `[pass]`, provider failure or no bubble — and an occupied listener gets one persisted catch-up whose actionable roots explicitly include the recovered user entry. Explicit Stop ends the chain and records a terminal listener outcome instead.

Causal settlement is serialized per original root: overlapping live and recovered `@both` halves cannot miss one another or spend the same remaining hop. A recovered single-seat catch-up versions its explicit root, so an older in-flight catch-up cannot erase a newer attempt for that same root.

Live lurk participates in the same scheduler: a spoken chime earns the other agent one structural right of reply, that answer returns to the lurker once for free, and anything the lurker then says is an ordinary charged continuation. **Delayed, coalesced lurk catch-up is intentionally different.** It may combine several roots and has no single original budget to resume, so its spoken catch-up gets one structural right of reply and one terminal answer return. That final turn is read-only, its tags schedule nothing, and its bubble and receipt say the chain deliberately ended rather than pretending another automatic delivery is owed.

Pair review is governed only by `pairRounds`, never by `hopBudget`. Live chains also end on `[pass]`, Stop/provider failure, a charged cap, or the emergency safety stop.

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

**Static instruction blocks are session-deduplicated.** The lurk criteria, the hop ground rules, the @both discussion note and a long room note are byte-identical on every turn of a live session, and used to be re-sent in full each time — the lurk block alone is ~900 bytes on the highest-frequency invocation Parley generates. A session that has durably received one now gets a one-line reminder that preserves the exact control tokens ([pass], the addressing phrases); the full text still goes on every fresh or reset session, on sentinel sessions, after a failed turn, and whenever the composed text changes (a lurkStyle edit, a new room note revision). Codex keeps the full discussion note every time: its @both no-edit boundary is enforced by the prose itself rather than by a CLI flag. Short room notes are also always sent in full — staying in the model's face is worth more than the bytes.

**Prompt versioning.** Fresh briefings and resumed-session updates come from the same canonical standing-contract template. A numeric version controls migration policy, while a content fingerprint detects changed text (and treats a missing legacy fingerprint as stale). A live session with either mismatch gets a one-time `[Update to your standing instructions]` block containing the complete contract. Version, fingerprint and concrete native-session identity are recorded only after that turn durably succeeds — a failed or stopped turn re-sends the update next time, exactly as the delivery cursor re-sends the room delta. Codex's `--last` fallback is not a durable identity, so updates repeat until a concrete thread id is reported. A future *contradictory* change can instead retire outdated sessions outright (they re-brief from the transcript); that retirement floor ships dormant.

**Room-note lifecycle.** An active room note remains visibly framed as current user-authored instruction on every turn. Edits and clears increment a durable room revision, and each concrete seat session records the exact revision it successfully received. Clearing sends that session one explicit “no room note is active” revocation; failure or Stop leaves the old revision in place so the revocation is retried, while a later success prevents it repeating forever. A reset session receives only the current note state and binds it to its new native-session identity.

**Session recovery** replays a bounded history excerpt inline and says so honestly: the excerpt is not proof that omitted matters were undecided; withheld bodies and attachment metadata remain omitted while a generic withdrawal notice preserves chronology; and when pair mode is on the briefing adds the deterministic pair state — roles, rounds, and any pending `[needs-user]` question, mined from the durable transcript record rather than duplicated into a second store. A `[pass]` pause is reported as "paused, no question pending", never as a pending decision.
