# Contributing to Parley

Thanks for looking. Parley is small on purpose, and staying small is the point
of the project — please read the shape below before a big PR.

## Running it

```bash
node parley.mjs
```

No install step, no build, no dependencies. Use Node ≥ 20 with the `claude` /
`codex` CLIs installed and authenticated through their normal provider setup.

## Running the tests

```bash
npm test
```

The smoke suite ([test/smoke.mjs](test/smoke.mjs)) boots a real server against a
fake agent CLI ([test/fake-cli.mjs](test/fake-cli.mjs)) that speaks both wire
protocols. So it exercises routing, the delta protocol, session resume, per-seat
flags, lurk and right of reply, hops, pair sessions, per-agent lanes, queueing,
work mode and activity lines — **without a provider login and without spending a
token.** CI runs it on Linux, Windows and macOS, across Node 20, 22 and 24.

The fake is driven by directives in the prompt, which makes new tests short to
write. Common directives include `SAY:`, `RECALL`, `ARGS`, `TAG:`, `WRITE:`,
`CHIME`, `NEEDSFIX`, `SHOWCASE`, `NEVERHAPPY`, `SLEEP:`, `FAILONCE:`, `RESUMEERROR`,
`MISSINGSESSION`, `SPAWNCHILD:`, `REVIEWFAILONCE`, `FIXFAILONCE`, `REVIEWFAIL`
and `FAIL`; the complete, current list is documented at the top of
[test/fake-cli.mjs](test/fake-cli.mjs). `ARGS` is especially handy: the fake
replies with its own argv, so a test can assert that a flag actually reached
the CLI.

Please add a case for behaviour you change. If a bug was worth fixing, it's
worth a line in the suite.

## The shape of the project

Two files do everything: [parley.mjs](parley.mjs) (server: adapters, room
engine, HTTP + SSE) and [ui/index.html](ui/index.html) (the whole frontend).
That's deliberate — Parley runs on top of your existing CLI logins, so being
auditable in an afternoon matters more than architectural elegance.

Two rules follow from it:

1. **If a feature doesn't fit in those files, it probably doesn't ship.** No
   framework, no bundler, no database, no runtime dependencies.
2. **Agent capability, yes; UI chrome, no.** Agents may read, write and run
   commands. But their actions render as inline chat lines — not a diff viewer,
   file tree, or embedded terminal. The chat is the interface; the user's editor
   is right next door and is better at being an editor.

Other standing decisions: exactly two seats per room (right of reply and the
pair-review workflow depend on it); loopback binding only; and Parley does not
read, store or forward credentials. Extra CLI args remain a trusted-user escape
hatch, but raw `--dangerously-*` / `--allow-dangerously-*` flags and raw Claude
bypass arguments are rejected. Parley's first-class UI exposes host-level Full
access through visible structured Room Settings choices. For protected Claude
discussion, reviewer and listener turns, Parley requests `plan` and does not
reuse a Parley-created bypass-enabled native session. Provider/user settings,
trusted hand-edited config and custom wrappers remain outside those guardrails.

## Adding an agent provider

A room can seat any two providers. To add one:

1. Write an adapter in `parley.mjs` next to `claudeSend` / `codexSend`. Signature
   is `async send(room, { prompt, briefing, onStream, onActivity, discussion, readOnly })`,
   returning `{ text, sessionRef, resetSession?, usage? }`; read your seat's config from
   `room.cfg.agents.<name>` and throw `AdapterError` with a readable message on
   failure. Call `onStream(partialText)` for live typing and
   `onActivity(label)` for tool use, if the CLI reports them.
2. Register it in the `adapters` map and add an entry to `PROVIDERS` (label,
   avatar letter, color, description, default seat config, which settings fields
   the UI should show, and the reasoning-effort choices, if any).

That's it — the seat picker, settings cards, colors, routing, receipts and pair
sessions pick it up automatically. Your CLI doesn't need to support session
resume: the room's delta protocol and inline history replay can carry a
stateless CLI.

Add fake-CLI coverage for the new protocol if you can, and say in the PR which
platform and CLI version you tested against.

## Reporting things

Issue templates are in place for bugs and features. If `npm test` fails on a
clean checkout, that's a Parley bug, not your setup — please say so in the
report. Redact credentials, session IDs, personal paths and private transcript
content before posting. Vulnerabilities should follow [SECURITY.md](SECURITY.md)
rather than a public issue.
