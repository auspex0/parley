# Planned work and implementation record

> **Status, 2026-08-27.** Packages 2, 3, 4 and 5 shipped on the
> `audit-remediation` branch, together with the crash-proofing, streaming and
> release-hygiene work from the codebase audit, seat/provider decoupling plus a
> Gemini adapter, and an accessibility pass. Package 7's image paste and
> chip-follow items shipped earlier and the entries below are stale. Package 8's
> module boundaries remain open; the only item from the audit's plan not built
> is the just-in-time permission bridge (see the note at the end of Package 9).

Everything here was settled or recorded in room conversation between 2026-08-06 and
2026-08-10. It is written down because the design lives across hundreds of chat messages
and a bounded recovery excerpt does not survive a session reset. Packages still carrying
a **settled** or **noted** status have not been implemented; a package marked **built**
has, and says where its code lives.

This file is contributor-facing. It is not linked from the README and is not in the npm
payload (`files` in `package.json` ships `parley.mjs`, `ui/`, `README.md`, `LICENSE`
only), so nothing here can be mistaken for a shipped feature.

Line references are against `main` at the time of writing and should be treated as
starting points, not addresses.

Status legend:

| | |
|---|---|
| **Settled** | Both seats converged, design closed, ready to implement as written. |
| **Agreed, unspecced** | Direction agreed; detail still to be worked out. |
| **Noted** | Observed and parked; no decision taken. |
| **Built** | Implemented as written; kept here as the design record. “Built in the working tree” is still uncommitted and unshipped unless a commit or release is named explicitly. |

---

## Package 1 — Sleep seat (built, 2026-08-09)

Implemented as specified below. User-facing behaviour is documented in
[conversation.md](conversation.md#sleeping-a-seat-); the runtime protocol went 5 → 6 with
it, as this package's release-plan row predicted. Where it lives: `isAsleep` /
`refuseIfAsleep` / `noteSleepSkip` and the `SEAT_ASLEEP` sentinel next to the turn engine,
`sleepSeat` / `wakeSeat` / `takeQueuedForSeat` beside the lane queue, `POST
/api/seat/sleep`, and the `seat sleep & wake` section of `test/smoke.mjs`. Two details
were settled during implementation rather than here: sleep survives **Archive & start
fresh** (a provider quota is not a property of the conversation), and skip entries join
cancellation notices as the second class of system entry that reaches agents in their
delta — without that, none of the "silence is not agreement" reasoning below actually
reaches the other seat.

**The problem.** A rate-limited seat can still be invoked. `findHopTarget`
(`parley.mjs:2231`) returns an explicit `@tag` target with no lurk check — lurk only
gates the *soft* plain-name path six lines below. So turning lurk off does not protect a
limited seat: the moment the other agent writes `@claude` in a reply, a hop fires and the
room eats a 429.

**Shape.** A per-seat, per-room *state* — not a lurk setting and not Stop.

- **Manual only.** No 429 parsing, no timers, no automatic state changes. Adapter
  failures already surface to the user (ordinary and hop turns show the error; only
  *lurk* errors are demoted to a whisper, `parley.mjs:2196-2208`), so the user sees the
  429 and decides. Auto-sleep was explicitly rejected by the user, and separately
  deferred by Codex on the grounds that the adapters have CLI exit codes and stderr text,
  not a stable provider-independent rate-limit signal.
- **Stored in `room.state.agents[x]`, not `room.cfg`.** `lurk` lives in `cfg.agents[x]`
  and persists via `saveConfig` (`parley.mjs:1333`) because it is a *preference*. Sleep
  is a *condition* — temporary, externally caused, not part of how the seat is
  configured. `room.state.agents[x]` already persists per-agent cursors, so sleep
  survives restarts for free without polluting the seat's configured identity. Carries an
  optional reason ("usage limit").
- **One authoritative gate at the launch function; filters at the edges for UX.** There
  are five distinct ways a seat gets invoked: direct dispatch (`3016`), the hop drain
  (`3132-3145`), the lurk chime (`3154-3162`), the chime's right-of-reply hop
  (`3170-3175`), and enqueue/retry (`3457-3488`). The tag-vs-lurk hole above exists
  precisely because the check sits per-path instead of at the choke point. Refusal is
  authoritative inside the launch function; early filters exist only so the UI can give
  fast, legible feedback instead of queueing a run that later fails.
- **Nothing is silently dropped.** The skip must `appendEntry(..., kind: "system")`, not
  just `broadcast`. There is already a skip channel —
  `broadcast(room, { type: "lurk", agent, spoke: false, skipped: true })` at `3141`,
  `3156`, `3172` — reuse it for the UI, but do not stop there. A sleeping seat has no
  automatic later invocation, so reusing an ephemeral skip would produce false
  consensus: the other agent's own lurk prompt says silence "will be read as agreement
  with what was said." **Later superseded for occupied lurkers too:** Package 10 records
  a persisted, coalesced catch-up obligation instead of accepting “the delta catches it
  up later” as sufficient. The delta preserves content, but only an invocation fulfils
  the promise that lurk actually overhears it.
- **Routing.** ~~Directly addressing a sleeping seat is rejected *before* a user entry is
  created.~~ **Superseded during implementation:** the message is now *held* instead of
  refused. Refusing meant the user had to hold the request themselves and re-send it
  later, at which point the room had no record that they had ever asked. Holding keeps
  the transcript honest about when the request was made, and lets the seat answer it in
  one turn on wake with the later traffic still in its real position, so it can tell a
  stale request from a live one. Only a **pair turn** still refuses, because pair mode
  has no single seat to hold the work for. `@both` still splits: the awake seat is
  delivered to and the sleeping seat's copy is held.
  Held-for-seat needed **no new state** — it is `deltaEntries` past the seat's cursor
  filtered by the `meta.audience.asleep` the split already wrote — so it survives
  restarts for free and clears itself when a turn advances the cursor.
- **Pair mode pauses** rather than substituting or continuing with the sleeping role.
- **Sleep applies to future launches only.** Stopping current work stays a separate
  explicit action. Mostly moot in the motivating case — a 429 means the turn already
  failed — but "let it finish, then no more" is the least surprising behaviour when a
  seat is slept mid-work for other reasons.
- **Queued deliveries for a seat being slept are cancelled immediately**, with one
  consolidated system note. Do not let them wait and then fail after the active turn
  ends.
- **Wake does not replay and does not cursor-jump.** Missed messages are never re-queued
  as tasks; the cursor stays where it was, so the seat's next deliberate delivery runs
  once and receives the intervening history as normal context. Cursor-preservation is
  load-bearing for the skip notices: if the other seat tagged it three times while it
  slept, the transcript holds three `not delivered` entries, and a cursor jump would
  throw away exactly those — the seat would wake with no idea it had been asked anything.
- **Wake shows what is pending** — "Wake Claude — 14 entries pending" — labelled as
  *context* pending, not as a predictable token cost. This is the one place the size of
  the first wake turn is knowable in advance, and that turn is the largest in the room
  arriving right after the quota event that caused the sleep.
  **Extended during implementation:** the pill also shows how many of those entries are
  messages *addressed to that seat* (`asleep · 3 held · 14 pending`). Held is a subset of
  pending and must never be rendered as if the two sum. Unlike `pending`, the held count
  is **not** gated on being asleep — after **Wake only** the seat is awake and those
  messages are still undelivered, so hiding the count then would be a lie the user cannot
  see through.
- **Wake is two actions when anything is held**, chosen from a small menu rather than a
  `confirm()`: **Wake & deliver** answers everything held in one turn, **Wake only**
  leaves it as ordinary context. The choice has three outcomes counting "not now", which
  is one more than a confirm dialog can express — its Cancel would have to double as one
  of the two wakes. Wake & deliver preflights (`pairActive`/`seatOccupied`) *before*
  clearing sleep, so a refusal leaves the held work provably still held. **Extended in
  protocol 9:** every Wake & deliver attempt rejoins the original root's causal
  request/answer coordinator. An already-successful direct-root `@both` sibling receives
  a successfully recovered half structurally; failure and Stop never qualify a missing half
  for that sibling relay. Independently, a recovered single-seat attempt honors enabled lurk
  after it settles even on failure, `[pass]` or no bubble, persisting an explicit-root
  catch-up when the listener is busy. Explicit Stop ends the chain and records the terminal
  listener disposition instead of launching downstream work.
  Per-message discard of a held message is **not** in this package — it belongs with
  Package 3's queue controls, which already own the discard vocabulary. Wake only is the
  escape hatch until then.
- **Sleep and wake entries are symmetric.** Both persisted, not just broadcast; otherwise
  a restart leaves a transcript showing a seat going quiet and never explaining why it
  started talking again.

---

## Package 2 — Chronological message status (SHIPPED 2026-08-27)

Today a cancelled text message's bubble vanishes and is replaced by floating system
pills; image messages keep their bubble, so the two behave differently. The record model
is: **the message is permanent; its delivery state is changeable.**

- Every accepted message keeps its bubble in chronological position, dimmed, with an
  inline per-seat status chip: `Cancelled before delivery`, `Cancelled for Codex`,
  `Delivered to Claude · Cancelled for Codex`. Readable text, no heavy strikethrough.
- Floating cancellation pills leave the normal UI; their durable records stay for agent
  context and auditing.
- The original bubble stays the quote/jump target.
- **Two dot states, distinct and both persisted:** red = *never delivered*; amber =
  *response interrupted*. Red already exists (`cancelledDeliveries` is documented at
  `parley.mjs:214` as "seats whose delivery of it was cancelled **before it ran**", and
  its only writer is fed queued deliveries). Amber is purely additive — today stopping an
  active run leaves no per-message trace at all — and reusing red for it would violate an
  invariant the code states explicitly.
- **Amber is superseded, never cleared.** It is a fact about a message/seat pair, not
  live lifecycle state. It resolves only when that seat *completes* a run explicitly
  rooted in that message (Ask again, or a Redirect quoting it). If the replacement run is
  stopped too, amber stays. Merely appearing in a later turn's context bundle never
  resolves it — that rule was proposed, tested against how the room actually works, and
  withdrawn, because every later turn carries the message in context, so it would
  degenerate to "amber clears on the next completed turn, whatever it is about."

---

## Package 3 — Queue pause / resume / discard / retry (SHIPPED 2026-08-27)

- **Global Pause/Resume for pending user deliveries only.** The drain loop checks a
  `queuePaused` flag; in-flight responses finish; nothing is lost. It does not freeze
  pair, hop or lurker chains — those have stop scopes.
- **`✕` means Discard, never Pause.** Explicit `⏸`/`▶` controls if a hold is wanted;
  overloading one button with a mode change is how misclicks happen.
- **Discarded messages stay in the timeline** as `Discarded before delivery · Retry`.
  That single change is what makes `✕` low-stakes.
- **Per-seat Retry for any discarded source message**, joining the **queue tail**,
  reusing the original bubble, never duplicating it.
- **No per-message hold in v1.** The queue is deliberately one arrival-ordered list so a
  later message cannot overtake an earlier one (`parley.mjs:2674`). A held message either
  blocks everything behind it — which is just queue pause — or gets skipped, which breaks
  ordering.
- **Vocabulary is fixed:** *discarded* while queued, *stopped* while active, *withheld*
  from the seat that never received it. The stop menu's "cancel queued" should read
  "discard queued" to match.

Implementation note settled after a disagreement: arbitrary Retry is **not** free.
`handleRetry` (`parley.mjs:2915`) already resolves the authoritative transcript entry by
`n` (`:2923`) and `clearWithdrawals(room, n, seats)` (`:2887`) is already message- and
seat-scoped — so the resolver exists. What does not exist is the dispatch shape: current
Retry launches straight into seats and 409s unless every seat is idle (`:2933-2937`).
Arbitrary retry must instead be a normal enqueue — fresh `queueGroupId`, tail of the
lane, no idle requirement — with per-seat eligibility read from `cancelledDeliveries[n]`
rather than `lastUser.done`, which also prevents double-delivering to a seat that already
received the message.

---

## Package 4 — Ask again and Redirect (SHIPPED 2026-08-27)

`↪ Ask…` on any user *or* agent message. If the target is idle it dispatches; if busy,
offer **Queue after current** or **Stop current & ask now**.

One shared low-level primitive, roughly
`dispatchFromSource(sourceN, seats, instruction, priority, clearWithdrawal)`, with **two
user-facing semantics that must not be merged**:

| | Bubble | Position | Clears |
|---|---|---|---|
| **Retry delivery** | reuses the original | queue tail | withdrawal markers for seats that never received it |
| **Ask again** | new quoting bubble | normal | supersedes amber on completion |
| **Redirect** | new quoting bubble | head-of-lane *only* when paired with an atomic Stop | supersedes amber on completion |

Rules:

- **Stop + redirect is one atomic server request pinned to the visible `runId`** — never
  a client-side Stop followed by a Send, or the old run can finish and a new one start
  between the two calls.
- **Head-of-lane has exactly one producer** in the whole system: the stop-and-ask
  variant. `priority` is not a free parameter — Retry is always tail, and an idle-seat
  redirect is immediate anyway. This keeps queue reasoning honest.
- **Existing queued work stays behind the redirect.** Nothing is flushed.
- **Source text and attachments are explicitly restaged** — the agent may have that
  message far back in context, or after a reset not at all. Reuses the existing
  quoted-context staging, so this is reuse, not new machinery.
- "Ask now" bypasses a globally paused queue *for that dispatch only*.
- **Ask again is Redirect with a default instruction**, not a third code path. It renders
  a quote-only bubble carrying something like *"Continue responding to this message"* —
  never a literally empty user bubble — so the chronological cause is auditable.
- Redirecting during a pair cycle quietly ends the incomplete cycle, performs the one
  direct-seat turn, and leaves pair mode enabled afterwards.
- Late output from the aborted run is already handled: epoch fencing means it cannot land
  after the redirect.

---

## Package 5 — Stop-button semantics (SHIPPED 2026-08-27)

Not a correctness bug — the user's own verdict was *"un-granular behavior, not urgent"* —
but it is decided and it is two clicks on the highest-frequency action in the app.

**Today.** `parley.mjs:1636` sets `working: !!room.pairActive || room.exchanges > 0`, so
`working` is true for *any* ordinary exchange. `ui/index.html:1801` ORs that with a busy
seat, so one agent replying makes ■ open a chooser instead of stopping. Worse, in the gap
between a reply and the hop it triggers (`busy` empty, `working` true) the identical
button silently escalates to stop-everything-plus-queue (`ui/index.html:2544`), which
clears pending deliveries and records withdrawals (`parley.mjs:3529-3537`). The blast
radius of one click flips on sub-second timing the user cannot see.

**Settled fix.** The primary click stops what is visible, semantically:

- **One busy seat, no queue** → run-pinned `active` stop. This halts the run *and its
  chain* (`run.chain.halted = true`, `parley.mjs:3520`), which a `seat` stop deliberately
  does not (`3482-3495`). That is the honest fix; the earlier proposal to predict
  chaining from `lurk`/pair settings was wrong and was withdrawn — an explicit `@seat` in
  an agent's reply hops unconditionally (`findHopTarget`, `2174-2177`).
- **Two or more busy seats, or queued work, or a pair cycle** → chooser.
  `stopIsChoice = busy.length > 1 || queued > 0 || !!workingPair`. All fields the summary
  already sends; **no server change**.
- **Working gap, no busy seat** → keep today's `all`. With no runs, `pinnedRuns` is empty
  and `handleStop` bails at `parley.mjs:3511-3513` with `stale: true` having touched
  nothing, deliberately; only the room-wide `stopEpoch++` in the `all` branch halts a
  pending hop. Existing behaviour there is already correct.
- The concurrent-exchange case (one seat busy, another exchange in a hop gap) does *not*
  reopen the chooser. The primary stops only the visible run; the other chain is
  independent work the user asked for, and the button stays on screen because it is gated
  on `summary.working` (`ui/index.html:1809`), so the room is never falsely announced as
  quiet. Click 1 stops what you can see; click 2 stops the rest.
- **Always-visible arrow/menu** keeps the deliberate scopes reachable — notably
  seat-only, which becomes otherwise unreachable under the new predicate. Deferrable if
  needed; the semantic fix is ~3 lines plus tests.
- `test/smoke.mjs:1175-1182` asserts the *old* rule as intended behaviour and must be
  rewritten as part of this, not patched around.

---

## Package 6 — Mention parsing and final-hop warning (built 2026-08-10)

Implemented and shipped in PR #4. The routing mask lives beside `findHopTarget`, and the
per-turn warning is composed at the hop launch site.
The broader budget vocabulary and composer control that made the warning user-selectable
are recorded separately in Package 11.

In the user's stated priority order:

1. **Ignore `@mentions` inside code fences, inline code and blockquotes.** Must be a
   detection-only mask over a *copy* — the transcript and prompt text stay untouched — and
   the mask must **preserve newlines**, not collapse spans, because the soft pass anchors
   on `(?:^|[\n.!?]\s+)`; welding the line after a fence onto the line before it can
   create or destroy a vocative boundary. Sanitize once, then run both the explicit and
   soft passes over that copy. This is a real behaviour change, not a pure bugfix:
   someone occasionally backticks a name while genuinely meaning to tag.
2. **Final-hop warning.** `HOP_INSTRUCTION` used to be static while the counter lived only
   inside the relay loop. The launch site now composes the turn-specific instruction:
   finite budgets say how many handoffs remain, the last permitted invocation says it is
   final, and an `∞` exchange gets the same terminal pressure on the implicit emergency
   safety edge without a noisy countdown on every earlier leg. The relay still enforces
   the limit; this is guidance, not authority.

Already shipped, listed only so it is not re-opened: emphasis-wrapped tags
(`**@codex**`) were fixed in `fb1ee48` by adding `*_~` to the leading boundary class.

---

## Package 7 — Parked UI issues (noted, 2026-08-06)

Observed live, never triaged:

- A stopped stream may leave a partial response bubble.
- A transient usage-limit error entry stays visible after a Retry succeeds, instead of
  resolving or disappearing.
- The seat-timeout message advises "raise Timeout in Settings," which is actively wrong
  advice when the real cause is an unauthenticated CLI. One sentence; post-launch polish.
- Image paste is unimplemented — no paste handler in `ui/index.html`, and `/api/message`
  carries `{room, text, target}` only. A feature, not a regression. Both CLIs accept image
  file paths, so paste → save under the room folder → pass path is a viable design.
- The target chip stays on `@both`: `state.chip` only changes on chip click. An inline
  `@claude` beats the chip server-side (`resolveTarget`, "text-derived target beats the
  chip") but never writes back to the chip UI — so the next *untagged* message still
  routes to both.

---

## Package 8 — Consolidation (agreed, explicitly post-launch)

Both seats agreed this is real and that none of it gates a launch, because none of it is
visible to a first-time user. Order:

1. Clean and gitignore transient test/browser artifacts (`.tmp-smoke-run-*`,
   `.tmp-browser-check`).
2. Split tests into a fast tier and the full fake-CLI smoke tier; extract setup helpers.
   `test/smoke.mjs` is larger than the app it tests, and a multi-minute local loop is too
   slow to be the default edit-test cycle.
3. Establish module boundaries — prompt/session delivery, pair state machine, room
   persistence/routing — before necessarily moving files. `parley.mjs` is past the size
   where one person holds it in their head.
4. Finish any remaining UI performance work and add a repeatable large-room benchmark.
   Pagination fixed initial load, but deep jumps or fully expanding history can still
   restore the whole transcript DOM.

---

## Package 9 — Backlog (noted, 2026-08-09)

Raised in room conversation, no design taken. **Not `1.1.0` scope** — listed so they stop
living only in chat.

- **Refresh the provider model catalog without restarting Parley.** `providerCatalog()`
  memoises into `catalogCache` (`parley.mjs:175`) for the life of the process, so when the
  Codex CLI rewrites `~/.codex/models_cache.json` — a new model, an updated reasoning
  level — the picker keeps offering the old list until Parley is restarted. Only the
  `codex` seat is affected; `PROVIDERS.claude.models` (`parley.mjs:116`) is a static alias
  list because Claude Code publishes no equivalent catalog. Undecided: explicit refresh
  control vs. TTL vs. invalidate-on-settings-open, and whether a seat mid-run should ever
  see the list change under it.
- **Longer-term room memory / decision ledger.** A durable record of what a room settled,
  so a design does not exist only as ~200 chat messages that a session reset truncates —
  the same gap this file was hand-written to cover. Undecided at every level: what earns a
  ledger entry, who writes it, whether it feeds back into agent context, and how it stays
  honest when the room later reverses itself.

---

## Package 10 — Guaranteed lurk catch-up (built 2026-08-10)

Implemented and shipped in PR #4.

**The bug.** The audience snapshot already recorded that a seat was selected to lurk, but
the fan-out checked `seatOccupied` only once, after the addressed exchange finished. A
seat that was running or still had user work in its lane received only an ephemeral
`skipped` event. Becoming free a moment later did not re-fire the lurk. Its unchanged
cursor meant a future turn could eventually include the missed text, but if no future
trigger arrived there was no invocation at all — weaker than the UI promise that a
lurking seat “overhears every exchange.”

**Built shape.** Occupancy delays a selected lurk instead of discarding it:

- **One persisted obligation per seat.** `state.agents[seat].pendingCatchUp` records the
  first unseen entry, the latest entry to cover, and the exchange root. Further misses
  extend the range instead of creating N model calls. It survives a restart.
- **Not a user-lane item.** The obligation stays outside `room.pending`, whose ordering is
  reserved for work the user explicitly asked for. It runs only after every accepted
  user exchange, Pair cycle and queued delivery has settled and the seat is free. User
  work therefore always wins.
- **One full-delta attempt.** The listener sees the whole chronological delta rather than
  a frozen, stale slice for each missed exchange. User roots whose accepted audience
  selected this seat to lurk are marked actionable; protocol-9 recovery may also attach an
  explicit root when a held/retried single-seat exchange first becomes eligible for lurk at
  delivery time. Solo and otherwise-unselected traffic remains context-only, so it can prove
  that a concern became stale without becoming a reason to interject. A normal successful
  turn that already advances the seat's cursor through the recorded range supersedes the
  obligation before it launches.
- **One attempt, no retry loop.** Speaking and `[pass]` both advance the cursor and write
  the ordinary lurk receipt. Before launch, sleep or disabling lurk cancels the pending
  obligation and records why; an already-running catch-up follows Sleep's ordinary
  future-launch rule and may finish unless stopped. Provider failure or Stop ends an
  attempt without moving the cursor and records a durable, bounded `lurkOutcomes` range
  for the receipt UI. A later deliberate turn can still heal the gap. An obligation
  extended while an attempt is running keeps its newer tail. Archive & start fresh clears
  it with the old conversation.
- **Visible truth.** The seat pill and receipt dot distinguish “catch-up queued” from
  “hasn't seen this yet”; after a terminal outcome they say why it did not run. A later
  receipt or cursor advance outranks that historical outcome, so status repairs itself
  without destructive cleanup.
- **One structurally terminal closure.** If the delayed listener speaks, the other seat gets
  one read-only right of reply after its user lane clears, and that answer returns once to
  the original lurker. Both deliveries are outside `hopBudget`; the answer return is final
  and is never scanned for another automatic tag, so catch-up cannot create a ping-pong loop.

This supersedes Package 1's earlier rationale that an occupied lurker could simply be
skipped because “the delta catches it up later.” Delta delivery preserves the text, but
without a later invocation it does not preserve the promise to overhear.

---

## Package 11 — Per-message hop control and Solo (built 2026-08-10)

The base implementation shipped in PR #4. The composer control was then revised from a
one-message override to a sticky per-room browser-session shortcut: it can shorten or suppress
agent debate across several messages without editing the room's persisted default.

- **Unambiguous room config.** New `hopBudget` uses one vocabulary: `-1` means `∞` / until
  settled under the emergency safety ceiling, `0` means no charged agent-to-agent requests,
  and any positive whole number is an exact charged-launch limit. Settings accepts any safe integer,
  while the compact composer offers sticky per-room shortcut choices through `8`. The old `maxHops` key used `0` for “until settled”; a
  new key makes migration idempotent, translating legacy zero to `hopBudget: -1` and
  preserving the old meaning for older clients that still submit `maxHops`. `pairRounds`
  is deliberately unchanged: Pair cycles consult it and never `hopBudget`.
- **Sticky shortcut, snapshotted per message.** The control beside the composer offers
  **Room default**, **Solo**, `∞`, and `0`–`8`. Its choice remains selected across sends and
  reloads for that room during the current browser session; switching rooms restores that room's
  own shortcut. Each accepted user entry stores an immutable policy snapshot, so changing Settings
  or the composer shortcut cannot rewrite a queued or running exchange; taskless Pair start/end
  controls carry no relay policy.
- **Server-authoritative counting.** Models do not count their own tags. The relay charges
  only a charged request invocation it actually launches: the user's initial addressed turn is free; an
  asleep target or a late seat that already read the trigger spends nothing; a launched
  call that later fails still spends one. Package 12 adds structural requests and one free
  answer return per launched request; neither increments this counter. At the cap, the target
  is not invoked, but the triggering reply remains in the transcript and reaches it later as ordinary context.
- **Durable per-root accounting.** Charged launches are persisted in `state.json` by the
  original user entry, so Wake & deliver and Retry resume the already-spent count instead of
  granting the same question a fresh budget. `relayUsage` is execution history rather than a
  second transcript: it retains the newest 200 inactive charged roots plus any older root that
  is still active, held or retryable, bounding growth without evicting an unresolved cap.
- **Guidance and live feedback.** Finite charged turns are told how many handoffs remain,
  and the `∞` path gets the same warning at the emergency
  safety edge. A live **Hops used · limit** counter beside the composer reports launched
  charged requests against the latest active exchange's starting snapshot—not the shortcut currently
  selected for later messages—and the capped transcript note distinguishes an intentional
  limit from the safety stop.
- **Solo is not budget zero.** `0` still permits a configured lurker's structural right of
  reply, successful `@both` sibling attention, and answer returns already owed. Solo suppresses
  both lurk and agent handoffs so exactly one
  selected seat responds. It is rejected for `@both` and Pair turns. The other seat is
  excluded from reacting, not from history: it can still read the message in a later
  delta, and no lurk catch-up obligation is created for the deliberate exclusion.
- **Separate accounting domains.** A lurker's spoken chime-in earns the other seat one
  bounded right of reply outside `hopBudget`. Under Package 12, the answer returns to the
  live lurker once for free and any speech from that floor becomes the next charged request.
  A delayed coalesced catch-up remains terminal because there is no one original message
  budget to resume. Pair review/fix rounds remain governed by `pairRounds`.

The runtime protocol moved 6 → 7 with the shipped implementation because room
summaries now expose catch-up status, terminal lurk outcomes and live hop progress, while
accepted user entries carry their immutable relay policy. That internal stale-tab fence
is not a package semver decision.

---

## Package 12 — Generalized causal attention relay (built, merged in PR #5 `c79af51` 2026-08-25; protocol 9)

**A request is delivered when eligible. Every launched request earns one free answer return.
New speech from that floor becomes the next budgeted request. A structural terminal is the
only deliberate exception.**

The package began with a lurk-specific defect: a listener could raise an issue, the other
seat could answer, and the listener would never receive that answer. The same missing edge
then appeared in an ordinary hop — A called B, B answered without tagging A back — and in
concurrent `@both` replies whose bubbles landed in transcript order even though both provider
turns used the earlier user-message snapshot. A lurk-only closure fixed one symptom; protocol
9 expresses the common causal rule.

**The contract remains hybrid.** Prompt text cannot deliver an answer to a seat that was
never invoked, while the server cannot decide whether a delivered answer deserves speech:

- **The server owns** immutable turn boundaries, causal ancestry, user-lane priority, cursor
  truth, deduplication, request accounting, answer return, caps and structural termination.
- **The agent owns** relevance and whether speaking adds value. `[pass]` is always legal,
  including when another agent explicitly requested attention.
- **Tags request; they do not self-route.** A tag raises salience, but the server decides
  whether the request is charged, structural, already delivered, capped or terminal.

**Never inject into a running provider turn.** Each turn keeps the delta snapshot accepted
at launch. Activity that lands while it is running stays behind the cursor until a safe
boundary. This is why an `@both` reply can appear above its sibling in the transcript without
having been in that sibling's prompt; screen position is not delivery evidence.

### Protocol-9 request/answer model

The causal coordinator (`parley.mjs:3439-3676`) drains two explicit work lists for live and
recovered roots:

- A **request** is an agent entry owed to one peer. **Charged** requests are explicit agent
  calls and implicit continuations spoken from a returned causal answer; they consume one
  `hopBudget` unit only when the target launches. **Structural** requests are safe-boundary
  delivery between successful initial `@both` siblings and a live lurker's one right of
  reply; their existing shape bounds them, so they survive a zero/exhausted hop budget.
- An **answer return** is owed once to the immediate caller of every successfully launched
  request that produced a real reply entry. `deliverCausalAnswer` (`parley.mjs:4284-4366`)
  performs that return read-only and without charging the budget. An explicit tag in the
  answer raises salience but does not charge the same delivery twice.
- If the answer-return turn says `[pass]`, the exchange settles. If it speaks, that entry
  becomes the next **charged continuation** to the agent who supplied the answer; no new
  `@tag` is required. That next request, if launched, earns its own free answer return.

The finite accounting rule is therefore: **one counted hop can mean up to two provider
invocations** — the charged request and its free answer return. Speech from that floor needs
the next hop. `-1` still uses the emergency safety ceiling; `0` blocks every new charged
request but not a structural request or an answer already owed by a request that launched.

**Eligibility stays narrow.** A single-addressed initial reply that neither tags nor calls
the other seat does not wake that unrelated peer; otherwise lurk and Solo would lose their
meaning and every one-seat answer would cost another call. By contrast, after both initial
`@both` provider turns succeed, each reply is delivered to its sibling exactly once at the
safe boundary, even at `hopBudget: 0`. A cancelled, sleeping or failed half is not resurrected
under the sibling rule, because that would bypass withdrawal or become an automatic retry.

**Wake/Retry recovery rejoins, rather than bypasses, the coordinator.**
`startRecoveredDelivery` (`parley.mjs:3691-3802`) launches the still-eligible half under the
original user entry, relay-policy snapshot and persisted charged-use count, then feeds successful
replies into the same request/answer queues. Recovery therefore resumes the root's remaining
budget rather than restarting its counter:

- For a recovered `@both` half, structural sibling delivery requires a durable successful
  agent entry whose `replyTo` is this exact user root. A high cursor is deliberately
  insufficient: unrelated later work must not make a failed or stopped direct half look
  successful and resurrect it as an automatic call.
- For a recovered single-seat root, enabled lurk is evaluated at the post-attempt safe
  boundary whether the addressed provider spoke, returned `[pass]`, failed or produced no
  bubble. A free listener runs then; an occupied listener receives the usual
  persisted, coalesced catch-up with the recovered root explicitly attached as actionable.
  This matches ordinary live lurk fan-out and closes the audience-snapshot gap created when
  the original message was held before lurk selection. Explicit Stop ends the chain instead
  and records `stopped` for eligible listeners; it never launches downstream work.
- A failed recovered launch creates no reply entry, no sibling qualification and no
  answer-return obligation, but it does not suppress that single-seat lurk fan-out.
  Recovery is one deliberate user action, never a general automatic-retry license.
- Initial providers for one `@both` root may overlap, but causal settlement is serialized by
  that root. The later boundary re-reads exact direct-root replies and cursor-deduplicates both
  directions, so Wake cannot make two valid siblings miss each other or let two coordinators
  spend the same remaining hop.
- An explicit recovered-root catch-up carries a per-root revision. Re-opening that same root
  while an older catch-up is in flight survives the older attempt even when the numeric delta
  range did not grow; only the revision actually attempted is retired.

**Live lurk uses the same model.** A spoken chime creates one structural right-of-reply
request; its answer returns to the lurker once for free. If the lurker speaks from that
answer floor, the speech is the next charged continuation rather than an unbounded free leg.

**Delayed coalesced lurk catch-up stays structurally terminal.** `pendingCatchUp` may merge
several roots and therefore has no single original `hopBudget` to resume. Its spoken catch-up
gets one structural, read-only right of reply and one read-only answer return to the original
lurker (`parley.mjs:4486-4633`). That answer return is terminal: tags remain visible text but
schedule nothing, and there is no fourth leg. This is a deliberate exception, not an
accidental missing delivery.

**Cursor truth and status are load-bearing.** Before a request or answer return launches,
the coordinator rechecks whether another full-delta turn already carried the entry. A
successful delivery, `[pass]`, sleep skip, Stop, provider failure or aborted seat wait is
handled once rather than automatically retried. `cappedTargets` records the exact charged
requests that could not launch; cursor reconciliation runs before the durable cap entry, so
the transcript never says an entry was withheld after another delivery already carried it.
Generic `causalAttention` metadata and closure receipts distinguish a free answer return
from a charged hop. Terminal delayed-catch-up bubbles say the structural chain ended instead
of falling through to “hasn't seen this yet.”

The initial lurk-only closure draft moved runtime protocol 7 → 8. Generalizing its metadata,
cap state and UI contract to live causal requests and recovered Wake/Retry roots moves the
current working tree 8 → 9.
These are stale-tab fences, not package-semver events.

**Verification pinned in the smoke suite:**

- a charged request's untagged answer returns once to its caller for free;
- a tagged answer uses that same free return rather than being charged twice;
- speech from the answer floor becomes a charged continuation without an `@tag`;
- the final charged request still earns its answer return, while further speech stops at cap;
- `hopBudget: 0` blocks a new charged request but not structural sibling/lurk delivery;
- a single-seat untagged reply does not wake an unrelated non-lurking peer;
- successful concurrent `@both` siblings each receive the other exactly once at a safe boundary;
- Wake & deliver and Retry rejoin the causal scheduler under the original root policy;
- a recovered root resumes its durable charged-use count rather than receiving a fresh hop budget;
- a recovered `@both` half reaches an already-successful direct-root sibling, but never a
  failed or stopped half or a seat qualified only by an unrelated high cursor;
- a recovered single-seat attempt runs enabled lurk after failure, `[pass]` or no bubble,
  or persists an explicit-root catch-up when that listener is busy; explicit Stop instead
  ends downstream work and records the terminal disposition;
- `[pass]`, failure, Stop, sleep, wait abort and cursor supersession do not create retries;
- live and delayed causal answer turns remain read-only in Work rooms; and
- delayed catch-up's terminal answer can never create another automatic leg.

---

## Release plan

**Where the code actually is.** `parley-room@1.0.2` is the published latest, and its
`gitHead` (`804b692`) is on `main` — so the lineage trap that applied to `1.0.1` is gone
and `git log 804b692..main` is now an honest read of what is unreleased. Blob hashes stay
the reliable test if that ever stops being true.

**Recommended sequence:**

1. **`1.0.2` — shipped 2026-08-08 (`804b692`), patch, metadata only.** The npm page was
   showing a *broken image*: the published README referenced `docs/parley-demo.gif` by
   relative path, npm resolves relative paths against the default branch, and that file
   was deleted in `735b0b8`. The republish fixed the images and the tarball is now five
   files. Kept here for the record — nothing in this step is outstanding.
2. **`1.1.0` — minor, the feature batch above.** Packages 1, 6, 10 and the base Package 11
   implementation shipped in PR #4 (`5021b3a`); Package 11's sticky per-room shortcut
   follow-up and Package 12's generalized causal relay shipped in PR #5 (`c79af51`,
   merged 2026-08-25). The remaining Packages 2–5 work remains open. Package 11 replaces
   room config `maxHops` with `hopBudget`, but it is a
   backward-compatible migration rather than a break: legacy rooms are rewritten on
   load (`maxHops: 0` keeps its old “until settled” meaning as `hopBudget: -1`) and older
   clients posting `maxHops` retain the legacy semantics. No room on disk stops loading
   and no CLI flag is removed. That remains a minor under semver.
3. **Not a major.** `2.0.0` should be reserved for something that actually breaks a user:
   a room-state format that old versions cannot read, a renamed CLI flag, a changed
   default permission scope. Nothing here does that. The internal runtime protocol moved
   5 → 6 for Sleep, 7 shipped in PR #4 for catch-up and relay progress, and 9 shipped in
   PR #5 for generalized causal-attention, cap and answer-return state;
   that is a stale-tab reload fence, not a semver event — the two numbers are unrelated
   and should stay that way.

**Sequencing.** Treat 1–5 as a shared **1.1 milestone**, not an indivisible release.
Packages 6, 10 and 11 are a coherent relay/lurk slice already built beside Sleep in the
working tree. Nothing should be held hostage to scope growth in a later package.

| Stage | Contents | Notes |
|---|---|---|
| 1 | ~~Sleep (1)~~ **built**, durable status model (2), stop-button semantics (5) | Sleep landed first and depended on nothing in package 2, as predicted — its skip is its own `appendEntry`, and the existing `broadcast(… skipped: true)` sites covered the UI half. **Runtime protocol 5 → 6 landed with it**, for exactly the predicted reason: the summary now carries each seat's sleep state, and its pending-backlog count while asleep. Package 5 depends on nothing at all and is ~3 lines plus a rewrite of `test/smoke.mjs:1175-1182`; it goes early because it is the highest-frequency interaction in the app and is otherwise the first thing to slip. |
| 2 | `dispatchFromSource` (4), queue controls (3), Ask again / Redirect (4) | The single-head-of-lane-producer invariant must be enforced **when the primitive lands**, not retrofitted after Retry is already calling it. Packages 3 and 4 are the ones that render into package 2's amber and per-seat status. |
| 3 | ~~Mention masking and final-hop warning (6)~~ **shipped in PR #4**, parked UI items (7) | The unrelated parked UI set can still slip without cost. |
| Relay/lurk extension | ~~Guaranteed lurk catch-up (10), per-message hop control and Solo (11 base)~~ **shipped in PR #4**; Package 11 sticky shortcut follow-up and generalized causal attention (12) **built, uncommitted** | Runtime protocol 6 → 7 shipped with Packages 10–11 because summaries added catch-up/outcome/progress state. Package 12's initial closure receipt used 8; the generalized charged/structural request and answer-return scheduler moves the current working tree to 9. |

If stage 2 or the remaining stage-3 UI work grows, the completed built slices can still
ship as `1.1.0` and the rest move to `1.2.0`. Nothing in Packages 3–5 or 7 needs to change
for the shipped Packages 1, 6, 10 and 11 to stand on their own. Package 12 is a later
relay/lurk extension and does not gate that shipped slice.


## Package 13 — Just-in-time permission approval (agreed, unspecced)

**Problem.** Work rooms force a standing grant: a seat runs under one permission
mode chosen at launch, so an action outside it is auto-denied mid-turn with no
way to approve it. The only lever is widening the standing grant, which
permissions.md correctly calls host-level trust. Just-in-time approval would let
the conservative default hold while still allowing the occasional write.

**Why it is not built yet.** Each provider exposes a different mechanism —
Claude Code wants an MCP tool named through `--permission-prompt-tool`, Gemini
has policy files, Codex has an approval policy — so the honest version means
Parley hosting an MCP server, which is real surface area for a zero-dependency
two-file app. More decisively, none of it can be exercised by the fake CLI: the
harness has no notion of a permission prompt, so the whole path would ship
untested against a protocol only the real CLIs speak. That is the same class of
risk the fake-CLI contract job in Package 8 exists to address, and this should
wait for it.

**Shape when picked up.** A `permissionRequests` capability per provider, an
in-chat approve/deny entry kind that blocks the turn, and a fake-CLI directive
that can request permission so the flow is testable before it is trusted.
