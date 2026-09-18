# Remaining work

Updated 2026-09-18 against `main` at `437c36f` (`v1.2.0`) and the
current local changes. `parley-room@1.2.0` is published; its README and
current screenshots are on `main`. Those release tasks are complete.

This is an unfinished-work list, not blanket implementation permission.
**Partial** means code exists but the whole item is not complete;
**proposed** means the design or product choice still needs agreement;
**verify** means a report needs evidence, not that a current bug is proven.
Do not infer release status from a local patch.

Completed items have been removed from this queue. Historical specifications
and verification records are in
[planned-work-history.md](planned-work-history.md); released changes belong in
[CHANGELOG.md](../CHANGELOG.md).

## Finish the current session work

- **Partial, uncommitted — Claude permission-aware session reuse.** The current
  patch records the permission scope actually used, retains consecutive Plan
  sessions, checks saved configuration provenance on load, and retires a
  session when the next turn needs a different effective permission mode. It
  includes `test/claude-sessions.mjs` and related smoke/documentation changes.
  It still resets on `acceptEdits → Plan → acceptEdits`; it does not implement
  complete project/model/sandbox/effective-configuration comparison.
- **Verify against the real Claude CLI before release.** Check consecutive Plan
  reuse and reload, normal-work/protected-discussion transitions, actual write
  refusal during protected turns, restoration of configured work behavior, and
  fresh-session isolation across Full-access boundaries. Include failure,
  missing-session recovery, hand-edited configuration, and settings changes
  while a turn is running. Fake argv tests cannot prove real CLI enforcement.
- Run the focused session suite and the full regression/package checks on the
  final patch, review the diff, then commit and release only after approval.
  The green `1.2.0` tests do not validate these later local changes.

## Execution boundaries — proposed, not implemented

- **Explicit control of autonomous delegation.** Default to no provider-created
  Agent/Workflow/subagent launches unless enabled for the room or explicitly
  authorized for the task. Define enforcement for work, protected discussion,
  lurk, Pair and recovery. Verify the real provider tool names and restrictions;
  prompt text alone is not enforcement. Expose the effective policy and record
  child launches and available usage.
- **Protected discussion without unintended planning workflows.** Investigate
  Plan-mode instructions that encourage planning or delegation. Preserve write
  protection while evaluating a narrower read-only discussion profile. Do not
  replace Plan with a weaker mode merely to reduce prompt size. Test tools and
  writes with the real CLI, not only its arguments.
- **Inherited MCP and connectors.** Decide a per-room opt-in or capability
  profile and show which external tools are available. The adapter currently
  adds no `--disallowedTools` or `--strict-mcp-config` restriction; that does
  not prove every inherited connector is usable, or that unauthorized access
  occurred. Verify each CLI mechanism before claiming isolation, and distinguish
  user-level configuration from guarantees Parley itself enforces.

## Token efficiency, latency and reliability

Preserve a measurement-first approach. Provider-native token and cost figures
are not a cross-provider subscription percentage. Use fake providers for
correctness and obtain authorization for additional real-provider experiments.
Priority: false-retry prevention and attachment replay, with usage/timing
visibility alongside them; then deadlines, configuration-aware reuse, and
oversized backlogs.

- **Structured missing-session detection.** Resume recovery can match provider
  phrases in combined output; quoted assistant or tool text can therefore be
  mistaken for a missing session when another failure occurs. Prefer structured
  error events or narrowly validated terminal stderr. Add adversarial quoted-text
  tests; authentication, quota, transport and tool failures must not become fresh
  retries merely because their output contains a matching phrase.
- **Attachment delivery ledger.** Track which attachment IDs each concrete
  native session has received. `stageProviderInputs` can replay root attachments
  on later causal turns; previews allow 128 KiB per file and 256 KiB per
  invocation. Use compact references where valid, but resend after session
  replacement, explicit reattachment, or genuine need for bytes. Account for
  withdrawals and temporary paths that may no longer exist.
- **Complete per-attempt usage and timing.** Persist available input,
  cached-input, cache-creation, output and reasoning counts, including failed or
  stopped attempts. Include Claude model/subagent usage, native turns, cost and
  delegation counts where exposed, without double-counting parent and child
  totals. Distinguish unavailable from zero. Show session reuse/reset reason and
  automatic-turn owner; separate prompt preparation, provider time and observable
  tool time where possible.
- **Investigate the reported 106.8-second documentation edit.** The report showed
  2,977 output tokens (325 reasoning), two searches and an edit. Search exit 1
  normally means no match; visible activity labels do not locate the latency.
  Use ordinary telemetry first. Do not assume lowering effort, adding finish
  instructions, a small-task mode or a hard deadline fixes this example.
- **Honest timeout controls.** `seatTimeout` raises Work turns to at least 15
  minutes and deep-effort turns to at least 30. Separate a user hard deadline
  from recommended provider timeout; expose the effective value before launch
  and preserve clear Stop/deadline outcomes. Never silently extend a hard limit.
- **Partial — reset only on effective execution changes.** Finish the broader
  project/model/sandbox/configuration comparison beyond the permission patch.
  Retain fail-closed behavior for genuine changes, unknown provenance and
  in-flight configuration races. Establish safe CLI resume behavior before
  optimizing resets.
- **Bound oversized context and backlog delivery.** Add a prompt-size ceiling,
  byte/token estimates, activity consolidation and durable bounded catch-up
  summaries. Preserve unresolved requests, decisions and withholding boundaries.
  Replace broad advice to “consult the transcript” with targeted retrieval by
  message, decision or bounded range.

## Product backlog

- **Requested, not built — Advanced Custom accounting.** Keep Automatic turns
  as the everyday default. Make category counting configurable for sibling
  delivery, explicit calls, listening, answer returns, follow-ups, catch-ups and
  recovery. Uncounted means neither disabled nor authorized. Snapshot policy at
  acceptance; add a durable independent safety ceiling counting every automatic
  start. Update prompts, estimates and explanations; test zero/all-free cases,
  catch-up sponsorship, Retry/Wake/restart and safety exhaustion. Do not restore
  legacy Extra exchanges as a selectable mode.
- **Source-linked decisions panel.** Track proposed, agreed,
  implementation-approved, implemented, verified and superseded states, linked
  to their source messages. Define who records and revises decisions and how they
  affect context. Agent agreement is not user authorization; avoid a new summary
  model call after every exchange.
- **Long-room navigation.** Search or filter by participant, root request,
  failure and decision; optional chronological exchange collapsing and selective
  transcript export. Existing export and pagination are not missing features.
- **Model-catalog refresh.** Replace process-lifetime `catalogCache` with an
  explicit refresh or invalidation policy. Account for provider-specific
  discovery, and never silently change an active run's model.
- **Crash-recovery journal.** Add durable attempt UUIDs and pending intents,
  reconciliation against terminal artifacts, and idempotent “outcome unknown”
  notices. Never automatically replay work of uncertain completion. Measure
  persistence overhead before choosing scoped or universal coverage.
- **Just-in-time permission approval.** Investigate supported provider-specific
  mechanisms and whether a bridge is needed. Bind approval to the exact action
  and run; fail safely on denial, cancellation, timeout and restart. Extend the
  fake harness first, then validate real integrations.
- **Conversation-quality evaluation.** Evaluate representative transcripts for
  redundant agreement, recap and low-value automatic turns. Improve prompts or
  routing from evidence without adding a judge call to every response.
- **Token or monetary budgets.** Define how incomplete telemetry,
  provider-specific units, estimates and hard limits behave before presenting
  anything as a spending guarantee.
- **Non-image clipboard files.** The paste handler currently filters for images;
  picker and drag/drop support do not cover OS clipboard file paste. Support
  available non-image file payloads or explain the limitation visibly. Preserve
  ordinary text paste and test browser/OS payload differences.

## Maintenance and verification

- **Partial — server module boundaries.** Continue separating prompt/session
  delivery, Pair state, persistence/routing and provider/HTTP concerns where
  useful. Keep the scheduler cohesive, zero runtime dependencies and one startup
  command. The UI split, helper modules, test tiers/fixtures and benchmark already
  exist and are not implementation tasks again.
- **Measured large-room optimization.** The repeatable 6,000-entry benchmark
  exists. Profile deep navigation and full expansion before choosing more work;
  historical timings are not current guarantees.
- **Verify historical stopped-stream behavior.** Reproduce unintended stale
  partial bubbles on the current build, distinguishing them from intentionally
  preserved interrupted output. Successful Retry error resolution is implemented
  and is no longer an open bug.
- **Verify timeout/auth advice.** Adapters still advise raising “Timeout” in
  Settings. Reproduce a missing-login case and distinguish it from a genuine
  timeout before changing diagnostics.
- **Verify the environment-dependent smoke fixture.** A September 15 restricted
  runner report described a temp-folder/outside-Git assumption. Reproduce there
  and make the fixture self-contained if still present. The isolated `1.2.0`
  release run passed **836 smoke checks and 13 browser tests** with the complete
  `test:all`; that historical report is not an outstanding release failure, and
  the release result does not certify the current local patch.
- **Real cross-platform CLI validation.** Exercise actual providers on macOS and
  Linux. Fake-provider CI and real Windows use do not establish native CLI
  behavior elsewhere.
- **Dormant instruction dispatch.** `dispatchFromSource` accepts an `instruction`
  parameter but rejects it as unimplemented. Audit callers, then remove the
  unused surface or implement it only for an agreed real use case.

## Optional repository and launch housekeeping

- Audit local and remote branches for merged or patch-equivalent work before
  proposing deletion. Branch names alone are not proof; deletion needs approval.
- Check the reported missing `v1.1.0` tag. Restore it only if the exact published
  source is established; do not tag an approximate commit for completeness.
- Review ignored README drafts, diagnostics and old demo media for optional
  cleanup. They are not shipped-package defects; preserve originals unless
  removal is requested.
- If a Reddit launch is wanted, prepare a current short video and post copy. The
  `1.2.0` Work/lurk/discussion screenshots are complete; assess existing video
  candidates before claiming no demo exists. No external posting is authorized
  by this roadmap.
