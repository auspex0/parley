# Contributing to Parley

Thanks for looking. Parley is small on purpose, and staying small is the point
of the project — please read the shape below before a big PR.

## Running it

```bash
node parley.mjs
```

No install step or build is required to run Parley; it has zero runtime dependencies.
Use Node ≥ 20 with supported provider CLIs installed and authenticated through their
normal setup. Browser tests use development-only dependencies.

## Running the tests

```bash
npm ci
npx playwright install chromium
npm run test:unit
npm run test:retry
npm run test:provenance
npm run test:smoke
npm run test:browser
npm run test:sequences
npm run bench
```

Use focused unit/Retry/provenance checks while developing. The smoke suite remains
available as `npm test`; browser tests supplement its fake-DOM probes with actual
Chromium interaction. Seeded scheduler sequences and reproducible benchmarks are separate
commands so measured performance work does not inflate every focused edit cycle. Report
the commands and current results you ran, including benchmark environment and seed.

The smoke suite ([test/smoke.mjs](test/smoke.mjs)) boots a real server against a
fake agent CLI ([test/fake-cli.mjs](test/fake-cli.mjs)) that speaks the supported wire
protocols. So it exercises routing, the delta protocol, session resume, per-seat
flags, lurk and right of reply, hops, pair sessions, per-agent lanes, queueing,
work mode and activity lines — **without a provider login and without spending a
token.** CI runs it on Linux, Windows and macOS, across Node 20, 22 and 24.

The fake is driven by directives in the prompt, which makes new tests short to
write. Common directives include `SAY:`, `RECALL`, `ARGS`, `TAG:`, `WRITE:`,
`CHIME`, `NEEDSFIX`, `SHOWCASE`, `NEVERHAPPY`, `SLEEP:`, `FAILONCE:`, `FAILONCESEAT:`, `RESUMEERROR`,
`MISSINGSESSION`, `SPAWNCHILD:`, `REVIEWFAILONCE`, `FIXFAILONCE`, `REVIEWFAIL`
and `FAIL`; the complete, current list is documented at the top of
[test/fake-cli.mjs](test/fake-cli.mjs). `ARGS` is especially handy: the fake
replies with its own argv, so a test can assert that a flag actually reached
the CLI.

Please add a case for behaviour you change. If a bug was worth fixing, it's
worth a line in the suite.

## The shape of the project

The single entrypoint remains [parley.mjs](parley.mjs). Focused modules in `lib/`
hold budget policy, dynamic prompts, causal scheduling and client-asset snapshots.
The UI separates [markup](ui/index.html), [styles](ui/styles.css) and
[JavaScript](ui/app.js). All three are captured together at server startup;
versioned asset URLs prevent a running page from mixing source revisions.

Extract cohesive provider, persistence and HTTP boundaries when they help; avoid
splitting a scheduler into many mutually dependent fragments. Keep mechanical
extraction separate from behavior changes and verify `npm pack --dry-run` includes
every runtime module and client asset.

Two rules follow from it:

1. **Keep startup simple.** One command; no framework, bundler, database or runtime
   dependencies. Test tooling may be development-only. Prefer importing helpers in
   focused tests over extracting fragments from source text; retain DOM probes where
   DOM lifetime itself is the behavior under test.
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

A *provider* is a CLI harness that Parley drives: Claude Code, Codex and Gemini
CLI today. Parley never calls a model API itself; it launches the harness, gives
it a prompt on stdin, and reads what it prints. A room seats two providers, and
a seat's provider is `room.cfg.agents.<seat>.provider`.

Adding one means writing an **adapter** and a **registry entry**. Most of it is
filling in blanks. Three parts need real care, because getting them wrong
produces an adapter that seems to work in ordinary chat and then fails in pair
or lurk mode.

Use `geminiSend` and the `gemini` entry in `PROVIDERS` as your template. They
were written against the current capability model from the start, and their
comments record which CLI behaviours were verified rather than assumed.

### The three parts that need care

**1. The final answer must come from an authoritative source.** The text you
pass to `onStream` is only for the live bubble. The `text` you return is what
gets saved, relayed to the other agent, and checked for control tokens such as
`[approve]` and `[pass]`, so it must be the CLI's own final answer, not text
reassembled from stream fragments. Each existing adapter has one source it
trusts:

- Claude: the final `result` event of `--output-format stream-json`.
- Codex: the file it writes for `--output-last-message <path>`, with the last
  streamed `agent_message` as a fallback.
- Gemini: the `response` field of `--output-format json`.

Find the equivalent in your CLI before writing anything else.

**2. Sessions: resume them, and recognize when one is gone.** Return the
session id as `sessionRef`; Parley stores it and gives it back on the next turn
through `room.state.agents[seat].sessionRef`, and sends only what the seat has
not heard yet. If your CLI lets you choose the id (Gemini's `--session-id`),
mint it yourself so you know it before the process says anything. Then:

- Declare `capabilities.sessions: "resume"`. A CLI without resume works too:
  declare `"none"` and the room's history replay carries it.
- When a resume fails because the session no longer exists, throw
  `AdapterError(message, { resumeFailed: true })`. Parley clears the session,
  starts a fresh one and catches the seat up from room history. Put the error
  shapes that mean "session gone" in `resumeLostPatterns`.
- If your CLI can only resume "the most recent session" rather than a named
  one, list that value in `sentinelSessionRefs` and return
  `sentinelThread: true`, as Codex does for `--last`. Parley never treats a
  sentinel as proof that a specific session holds the briefing.

**3. Read-only turns must actually be read-only.** Some turns may read files
but must not write them: the pair-mode reviewer, a lurking listener, and
`@both` discussion in a work room. Parley signals these with `discussion` or
`readOnly` in the adapter options. Your adapter must switch the CLI into its
real read-only mode for those turns: `--permission-mode plan` for Claude,
`--approval-mode plan` for Gemini. Also strip any user Extra CLI argument that
would reopen write access for that turn (see `withoutArgWithValue`).

Then tell Parley how strong the guarantee is:

- `protectedTurnEnforced: true` only if the CLI itself blocks writes in that
  mode. If read-only rests only on Parley's prompt instruction, leave it unset.
  That is Codex's position on a resumed thread, and `docs/permissions.md` says
  so; do the same for your CLI rather than overclaiming.
- If a full-access session cannot be safely downgraded mid-session, set
  `isolateProtectedTurn` so protected turns run in a separate session, as
  Claude does for `bypassPermissions`.
- Set `sessionScope` to the permission setting baked into a session, so a
  session created under looser rules is never silently resumed under stricter
  ones, and `fullAccessScope` to the value that means full access.

### The rest of the adapter

The signature is:

```js
async function yourSend(room, {
  seat, prompt, briefing, onStream, onActivity,
  discussion, readOnly, images = [], inputDir = null, allowEmpty = false,
}) { … return { text, sessionRef, emptyReply, usage?, resetSession?, sentinelThread? }; }
```

- **Configuration:** read `room.cfg.agents[seat]`, never a hard-coded seat
  name. Two seats may share one provider.
- **Launching:** use `resolveCommand(cfg.command)` and `runCli(...)`. They
  handle npm `.cmd` shims on Windows, the workspace folder (`workDir(room)`),
  the timeout (`seatTimeout(room, seat)`), Stop, and process cleanup. Send the
  prompt on stdin; Windows truncates long command lines.
- **Briefing:** `briefing` is non-empty text for a fresh session and `null`
  for a resumed one. Use the CLI's system-prompt option if it has one;
  otherwise prepend it to the prompt, as Gemini does.
- **Live output:** call `onStream(textSoFar)` with the whole reply so far if
  the CLI streams text, and `onActivity(label)` for tool use, such as
  `"✏️ Edit booking.ts"`. Both are optional; Gemini does neither.
- **Errors:** throw `AdapterError` with a message a user can act on. Pass
  `{ stopped: true }` when `runCli` reports the user stopped it. Cover timeout,
  launch failure and non-zero exit, and include the tail of stderr.
- **Empty replies:** if the answer is empty and `allowEmpty` is false, throw;
  otherwise return `text: ""` with `emptyReply: true`.
- **Usage:** return `usage: { out, reasoning? }` if the CLI reports tokens.
- **Images:** honor `images` natively if the CLI supports them, up to
  `capabilities.nativeImageBytes`, and add `inputDir` to the CLI's readable
  paths. Parley stages disposable copies there.

### The registry entry

Add the adapter to the `adapters` map wrapped in `briefedAdapter(...)`, and add
an entry to `PROVIDERS` with:

- `label`, `sub`, `desc`, `avatar` and `color` for the UI;
- `defaults` for a new seat and `fields` for which settings the seat card shows;
- `models` and `efforts` as free-text suggestions, if the CLI has them;
- `capabilities` as described above, plus `extraArgsIssue(args)` to reject
  flags in Extra CLI args that bypass Parley's warned Full-access setting,
  `sessionFixedFields` for settings baked in when a session starts, and
  `resetOnRoomModeChange` if switching Talk/Work must start a fresh session.

Also add an `AUTH_HINTS` entry naming where the CLI keeps its login, so the
first-run check can say "installed but not signed in" instead of failing on the
user's first message.

The seat picker, settings cards, colours, routing, receipts, lurk and pair
mode then pick the provider up automatically.

### Testing it

`test/fake-cli.mjs` impersonates the real CLIs so the suite runs with no login
and no tokens. It picks a protocol from its arguments, the way the real CLIs
are invoked, and its replies are driven by directives in the prompt (`SAY:`,
`SAWWHAT`, `TAG:` and others, documented at the top of the file). Teach it your
CLI's output format, point a seat's `command` at it in `test/smoke.mjs`, and
cover at least: a reply, a resumed session, a lost session, a read-only turn,
an empty reply and a Stop. In the PR, say which platform and real CLI version
you tested against.

## Reporting things

Issue templates are in place for bugs and features. If `npm test` fails on a
clean checkout, that's a Parley bug, not your setup — please say so in the
report. Redact credentials, session IDs, personal paths and private transcript
content before posting. Vulnerabilities should follow [SECURITY.md](SECURITY.md)
rather than a public issue.
