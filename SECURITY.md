# Security Policy

Parley drives local coding-agent CLIs, can spend usage on the accounts already configured in those CLIs, and can modify files whenever configured room/seat permissions allow it. Security reports are welcome.

## Supported versions

Security fixes target the latest published version on npm (`parley-room`) and the latest commit on `main`. Older versions are not patched — upgrade to the current release. Run `parley --version` to see which version you have.

## Reporting a vulnerability

Please do **not** publish exploit details, tokens, transcripts or private source code in a GitHub issue.

Use [GitHub's private vulnerability reporting form](https://github.com/auspex0/parley/security/advisories/new) if it is available for the repository. If it is unavailable, open a minimal issue asking the maintainer for a private contact channel, without including vulnerability details.

Include, through the private channel:

- the affected commit or version;
- the operating system and Node version;
- a concise impact statement and reproduction steps;
- whether exploitation requires a malicious web page, local process, room participant or project file; and
- a suggested fix, if you have one.

Remove provider credentials, CLI session identifiers, personal paths and unrelated conversation content from every report.

## Security model

- The HTTP server binds to `127.0.0.1`. Mutating API calls require a fresh in-memory token embedded in the served page, and foreign browser origins are rejected.
- This protects against ordinary cross-origin web requests; it is not an OS security boundary against another process already running as the same user.
- Parley does not inspect or persist provider credentials. Claude Code and Codex authenticate through their own CLIs and inherit the launching user's process environment.
- Talk rooms use conservative defaults. Work mode defaults the selected agent to command/edit permissions, while explicit seat overrides may narrow or widen them. Linking a real project changes the working directory, but is not an OS sandbox.
- Room Settings deliberately exposes host-level Full access for trusted local use: Claude's `bypassPermissions` and Codex's `danger-full-access`. Claude Full access bypasses its ordinary permission prompts and checks and can use the launching account's filesystem, inherited credentials and network outside the linked project. Claude Code 2.1.126+ can include protected paths such as `.git`; older versions may still prompt there. Claude recommends bypass only in an isolated container or VM. OS permissions, managed provider policy, explicit ask/deny rules and the CLI's own hard circuit breakers may still restrict an action.
- Enabling effective Claude Full access through Room Settings requires confirmation. Both enabling and disabling it record a transcript audit note and start a fresh native session. Any reset-requiring config change is rejected while an affected seat or pair cycle is working, so an old turn cannot reattach its prior session afterward. Saved Claude sessions also carry their effective permission provenance; a mismatched or legacy session is discarded on load.
- Extra CLI args are passed to the selected provider and should be treated as trusted local configuration. Parley rejects raw `--dangerously-*` / `--allow-dangerously-*` flags and raw Claude `--permission-mode bypassPermissions` arguments; Room Settings is Parley's supported, warned UI route to Claude bypass. Provider/user settings files, hand-edited trusted local configuration and custom command wrappers remain outside this UI guardrail and inside the trusted-local boundary.
- For protected Claude discussion, reviewer and listener turns, Parley requests `plan` and does not reuse a Parley-created bypass-enabled session. Trusted external Claude settings or wrappers remain outside that boundary. Ordinary explicit handoffs and pair-worker turns are not protected and inherit Full access when it is enabled. The same no-edit roles on a resumed Codex thread are workflow instructions, not independent OS-level isolation.
- Transcripts, activity lines and CLI errors can contain prompts, source excerpts and local paths. Treat room folders and exported transcripts as potentially sensitive.

Parley is designed for one trusted local user. Multi-user hosting, credential sharing and tenant isolation are outside the supported threat model.
