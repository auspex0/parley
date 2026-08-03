---
name: Bug report
about: Something in Parley doesn't behave as documented
labels: bug
---

**What happened / what you expected**

**Steps to reproduce**
1.
2.

**Environment**
- OS:
- Node version (`node -v`):
- `claude --version`:
- `codex --version`:
- Room mode (talk / work), seats, lurk on or off:

**Anything in the chat or console?**
Parley surfaces CLI failures as `⚠` messages in the room — paste the text if
there is one. Browser console errors and the terminal output of `node
parley.mjs` help too.

> Before posting, remove API keys, tokens, session IDs, private source code,
> personal paths/usernames, and unrelated transcript content. Parley does not
> need your provider credentials to diagnose a bug. Report security issues
> privately as described in the [security policy](https://github.com/auspex0/parley/blob/main/SECURITY.md).

**Does `npm test` pass?**
It runs against fake CLIs, so a failure there points at Parley itself rather
than your agent setup.
