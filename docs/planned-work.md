# Planned work — decided, not yet built

Everything here was settled in room conversation between 2026-08-06 and 2026-08-08 and
has **not** been implemented. It is written down because the design lives across ~200
chat messages and a bounded recovery excerpt does not survive a session reset.

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

---

## Package 1 — Sleep seat (settled, 2026-08-08)

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
  `3156`, `3172` — reuse it for the UI, but do not stop there. That busy-skip
  deliberately writes nothing to the thread because the comment at `3155` is right: the
  seat is merely busy and *"the delta catches it up later."* A sleeping seat has no
  later. Reusing the busy path as-is produces false consensus: the other agent's own lurk
  prompt says silence "will be read as agreement with what was said."
- **Routing.** Directly addressing a sleeping seat is rejected *before* a user entry is
  created. `@both` delivers to the awake seat and records the sleeping-seat skip.
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
- **Sleep and wake entries are symmetric.** Both persisted, not just broadcast; otherwise
  a restart leaves a transcript showing a seat going quiet and never explaining why it
  started talking again.

---

## Package 2 — Chronological message status (settled, 2026-08-06)

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

## Package 3 — Queue pause / resume / discard / retry (settled, 2026-08-06)

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

## Package 4 — Ask again and Redirect (settled, 2026-08-06)

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

## Package 5 — Stop-button semantics (settled, 2026-08-07)

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

## Package 6 — Mention parsing and hop budget (agreed, deferred by the user 2026-08-07)

In the user's stated priority order:

1. **Ignore `@mentions` inside code fences, inline code and blockquotes.** Must be a
   detection-only mask over a *copy* — the transcript and prompt text stay untouched — and
   the mask must **preserve newlines**, not collapse spans, because the soft pass anchors
   on `(?:^|[\n.!?]\s+)`; welding the line after a fence onto the line before it can
   create or destroy a vocative boundary. Sanitize once, then run both the explicit and
   soft passes over that copy. This is a real behaviour change, not a pure bugfix:
   someone occasionally backticks a name while genuinely meaning to tag.
2. **Final-hop warning.** `HOP_INSTRUCTION` is a static const and the `hops` counter never
   leaves `drainMentions` (`parley.mjs:3067`), so this is plumbing, not a string edit:
   compute the terminal condition at the call site and thread it through `runHopTurn`.
   The cap check at `3082` fires *before* the hop and returns, so the correct site is
   `3087`, where `hops + 1 >= maxHops` means "this invocation is the last permitted one."
   Terminal wording, not advisory. Agreed it fires on the implicit safety cap too
   (`maxHops = configuredHops || HOP_SAFETY_HOPS`, `3065`) — the hop genuinely is the last
   one either way, and staying silent would make the prompt lie by omission exactly where
   a runaway chain most needs the pressure.

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

## Release plan

**Where the code actually is.** `parley-room@1.0.1` already contains the prompt contract,
pair escalation, the flicker repair, scrollback pagination and the branch chip. The
published `gitHead` (`27b77dd`) is on a separate lineage from `main` after a rebase, so
`git log 27b77dd..main` *looks* like unreleased code and is not — blob hashes are the
honest test: `parley.mjs` and `ui/` are byte-identical between the published tarball and
`main`. The only real diff against what is published is `README.md` and `package.json`.

**Recommended sequence:**

1. **`1.0.2` — patch, metadata only.** The live npm page currently shows a *broken image*:
   the published README references `docs/parley-demo.gif` by relative path, npm resolves
   relative paths against the default branch, and that file was deleted in `735b0b8`. The
   fix is a publish, not cleanup. Bundle the README wording already agreed, and the
   `oxipng`/`pngquant` pass on the two ~750 KB stills. Deferred by the user on 2026-08-08
   — "we'll bump when there is actually something important" — so this rides along with
   whatever lands next rather than shipping alone.
2. **`1.1.0` — minor, the whole feature batch above.** Packages 1–5 are additive: new
   seat state, new queue controls, new per-message actions, corrected stop semantics. No
   config key changes meaning, no CLI flag is removed, no room on disk stops loading.
   That is a minor under semver, and bundling them is right because they interlock —
   Redirect creates exactly the amber state Package 2 defines, Sleep reuses the skip
   channel Package 2 makes durable, and Package 3's retry and Package 4's redirect share
   one dispatch primitive.
3. **Not a major.** `2.0.0` should be reserved for something that actually breaks a user:
   a room-state format that old versions cannot read, a renamed CLI flag, a changed
   default permission scope. Nothing here does that. The internal runtime protocol *will*
   need a bump (5 → 6) because packages 2–4 change client-visible payload shapes, but
   that is a stale-tab reload, not a semver event — the two numbers are unrelated and
   should stay that way.

**Sequencing.** Treat 1–5 as a shared **1.1 milestone**, not an indivisible release.
Nothing here should be held hostage to scope growth in the packages after it.

| Stage | Contents | Notes |
|---|---|---|
| 1 | Sleep (1), durable status model (2), stop-button semantics (5) | Sleep depends on nothing in package 2 — its skip is its own `appendEntry`, and the existing `broadcast(… skipped: true)` sites cover the UI half. Package 5 depends on nothing at all and is ~3 lines plus a rewrite of `test/smoke.mjs:1175-1182`; it goes early because it is the highest-frequency interaction in the app and is otherwise the first thing to slip. **Runtime protocol 5 → 6 lands here** — Sleep alone changes the summary payload (seat state for the edge filters and the Sleep/Wake control), so the bump is certain regardless of what else ships in this stage. |
| 2 | `dispatchFromSource` (4), queue controls (3), Ask again / Redirect (4) | The single-head-of-lane-producer invariant must be enforced **when the primitive lands**, not retrofitted after Retry is already calling it. Packages 3 and 4 are the ones that render into package 2's amber and per-seat status. |
| 3 | Mention masking and final-hop warning (6), parked UI items (7) | Small, independent, can slip without cost. |

If stage 2 or 3 exposes unresolved behaviour, release the completed stage-1 work as
`1.1.0` and move the rest to `1.2.0`. Nothing in packages 3–6 needs to change if it slips
a release.
