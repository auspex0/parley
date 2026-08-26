# Changelog

Notable changes per published version. Dates are release dates on npm.

## 1.2.0 — unreleased

Durability, the settled interaction fixes, and the first pass at cost visibility.

- **Survives what it used to die from.** A CLI that exits while Parley is still writing its prompt, a torn `state.json`, or a disk error in a background exchange each used to take down the whole server and orphan every running agent. Prompt writes, room state, attachment downloads and the detached exchange chains are now individually fault-tolerant, and agent processes are killed on every exit path rather than only on Ctrl+C.
- **Stop stops.** With one seat replying and nothing queued, the ■ button stops that response on the first click instead of opening a chooser. The menu also stops rearranging itself under the cursor while it is open.
- **Message status, queue controls and Redirect.** Every message carries a durable delivery status; queued work can be paused, resumed and discarded per lane; and a running turn can be redirected to the other seat in one atomic action.
- **Streaming costs what it should.** Live replies are broadcast as increments rather than resending the whole reply on every token.
- `--version`, a troubleshooting section in the README, and a changelog.

## 1.1.0 — 2026-08-10

- Guaranteed lurk catch-up: a listener that was busy when an exchange finished gets one coalesced catch-up rather than silently missing it.
- Causal agent relay: charged vs structural requests, free answer returns, and hop budgets persisted per user-message root so Wake and Retry resume the same budget.
- Per-message hop control in the composer, including Solo, with sticky per-room shortcuts.
- Image paste, drag-and-drop and a draft gallery in the composer.

## 1.0.2 — 2026-08-08

- Published under `parley-room` after the `@auspex0` scope was retired.

## 1.0.1

- First public release.
