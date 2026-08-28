# Changelog

Notable changes per published version. Dates are release dates on npm.

## 1.2.0 — unreleased

Durability, the settled interaction fixes, a third provider, and the first pass
at cost visibility.

- **Survives what it used to die from.** A CLI that exits while Parley is still writing its prompt, a torn `state.json`, or a disk error in a background exchange each used to take down the whole server and orphan every running agent. Prompt writes, room state, attachment downloads and the detached exchange chains are now individually fault-tolerant, and agent processes are killed on every exit path rather than only on Ctrl+C.
- **Stop stops.** With one seat replying and nothing queued, the ■ button stops that response on the first click instead of opening a chooser; the ▾ beside it keeps every deliberate scope. The menu no longer rearranges itself under the cursor while it is open.
- **A message says what happened to it.** Discarded and interrupted messages keep their place, dim, and carry a per-seat status line — including a Retry for a delivery that never arrived. A stopped response is now a distinct, durable fact rather than reading as "never seen".
- **The queue can be held.** ⏸ pauses delivery without dropping, reordering or abandoning anything; work sent while held joins the queue; ▶ releases it in order.
- **Ask again and Redirect.** Every message carries a ↪ that asks about *that* message. On a busy seat, "Stop current & ask now" is one atomic request pinned to the response you were looking at, so nothing can slip in between the stop and the ask.
- **A third seat: Gemini.** Seats and providers are now separate, so a seat can be named anything and two seats can share one provider (Claude vs Claude). Existing rooms migrate by gaining one field and renaming nothing.
- **Knows what it costs and what it needs.** New rooms start with a bounded hop budget; the seat pill carries this conversation's token total; and a first-run doctor reports a missing *or unauthenticated* CLI with the fix, instead of failing on your first message.
- **Streaming costs what it should.** Live replies are broadcast as increments rather than resending the whole reply on every token.
- **A token diet, measured.** A burst of messages sent while a seat is busy now merges into one provider turn instead of one call each; a lurking seat's ~900-byte instruction block, the hop ground rules and a long room note are sent once per session and reminded thereafter (control tokens preserved verbatim); per-tool activity lines coalesce in the peer's delta; a Full-access lurker's reactions coalesce into catch-ups instead of resetting its session per exchange; and stopping a response also stops the peer's lurk on that exchange.
- **Faster where it is felt.** A corrupted or restored state file recovers each seat's read position from its delivery receipts instead of re-sending the entire room history as one prompt; state.json is no longer rewritten for every tool action; contended agent handoffs wake on events instead of polling; streaming long replies no longer rebuilds the whole live bubble every 90 ms; paging through scrollback prepends instead of re-rendering everything; and receipt dots refresh through indexes rather than linear scans, so a long room stays smooth during activity.
- **Accessible, and no longer dark-only.** Screen readers hear the transcript, menus and room actions work from the keyboard, the settings dialog traps focus, narrow windows keep their room navigation, and there is a light theme. Code blocks are syntax-highlighted.
- `--version`, a troubleshooting section in the README, and this changelog.

## 1.1.0 — 2026-08-10

- Guaranteed lurk catch-up: a listener that was busy when an exchange finished gets one coalesced catch-up rather than silently missing it.
- Causal agent relay: charged vs structural requests, free answer returns, and hop budgets persisted per user-message root so Wake and Retry resume the same budget.
- Per-message hop control in the composer, including Solo, with sticky per-room shortcuts.
- Image paste, drag-and-drop and a draft gallery in the composer.

## 1.0.2 — 2026-08-08

- Published under `parley-room` after the `@auspex0` scope was retired.

## 1.0.1

- First public release.
