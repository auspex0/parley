import { execFile } from "node:child_process";

// Claude Code on macOS keeps its login in the Keychain, not a file, so the
// doctor's file check misses it. `claude auth status` is local (no model call)
// and knows every place Claude keeps a login. Only `loggedIn` is read; the rest
// of its output (email, organisation) is discarded. Resolves true, false, or
// null when it cannot tell (an older CLI without the subcommand, a timeout).
export function claudeLoggedIn(spec) {
  return new Promise((resolve) => {
    execFile(spec.cmd, [...spec.pre, "auth", "status", "--json"],
      { timeout: 5000, windowsHide: true },
      (_err, stdout) => {
        try { const { loggedIn } = JSON.parse(stdout); resolve(typeof loggedIn === "boolean" ? loggedIn : null); }
        catch { resolve(null); }
      });
  });
}
