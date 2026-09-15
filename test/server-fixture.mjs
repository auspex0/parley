import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-cli.mjs");

// Every test owns a server, home and room tree. Provider commands are configured
// before sending, and the server cannot inherit a real provider token or PATH.
export async function isolatedServer({ env: overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parley-browser-"));
  const home = path.join(root, "home");
  const rooms = path.join(root, "rooms");
  fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32"
      ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32")] : ["/usr/bin", "/bin"])].join(path.delimiter),
    FAKE_DELAY_MS: "100", PARLEY_PAIR_SAFETY: "4", PARLEY_HOP_SAFETY: "4", PARLEY_SEAT_WAIT_MS: "2500", ...overrides,
  });
  const proc = spawn(process.execPath, [path.join(here, "..", "parley.mjs"), "--no-open", "--port", "0", "--root", rooms], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  let api;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (api && proc.exitCode === null) {
      const listed = await api("GET", "/api/rooms").catch(() => null);
      for (const room of listed?.data.rooms || []) {
        await api("POST", "/api/stop", { room: room.name || room, scope: "all" }).catch(() => {});
      }
    }
    if (proc.exitCode === null) {
      // Provider work was stopped through the test server above. Terminate our
      // own child directly; shelling out to taskkill is unnecessary here.
      proc.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => proc.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    // This exact path was created above; never delete an externally supplied root.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { console.warn(`Test fixture cleanup left ${root}: ${error.code}`); }
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server readiness timed out:\n${log}`)), 15_000);
      const append = (chunk) => {
        log += chunk.toString();
        const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      proc.stdout.on("data", append); proc.stderr.on("data", append);
      proc.once("error", (error) => { clearTimeout(timer); reject(error); });
      proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}):\n${log}`)); });
    });
    const html = await fetch(url).then((res) => res.text());
    const token = /name="parley-token" content="([^"]+)"/.exec(html)?.[1];
    const protocol = /name="parley-runtime-protocol" content="([^"]+)"/.exec(html)?.[1];
    if (!token || !protocol) throw new Error("Served page omitted runtime handshake metadata");
    api = async (method, route, body) => {
      const res = await fetch(url + route, {
        method, signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "X-Parley-Token": token, "X-Parley-Runtime-Protocol": protocol },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, data: await res.json() };
    };
    const room = (name) => api("GET", `/api/room?name=${encodeURIComponent(name)}`).then((res) => res.data);
    const configure = async (name, config = {}) => {
      const before = await room(name);
      const agents = Object.fromEntries(before.room.seats.map((seat) => [seat, { command: fake, lurk: false, ...config.agents?.[seat] }]));
      // Existing suites exercise the compatibility contract explicitly. Strict
      // tests opt in; production new-room defaults are verified separately.
      const configured = await api("POST", "/api/config", { room: name, config: { accounting: "exchanges", hopBudget: 0, pairRounds: 2, ...config, agents } });
      assert.equal(configured.status, 200, JSON.stringify(configured.data));
      const after = await room(name);
      assert(after.room.seats.every((seat) => after.room.cfg.agents[seat].command === fake));
    };
    await configure("default");
    return { url, api, room, configure, close, log: () => log, root: rooms };
  } catch (error) { await close(); throw error; }
}
