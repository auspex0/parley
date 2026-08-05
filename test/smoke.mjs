#!/usr/bin/env node
/**
 * Parley smoke test — boots a real server against fake agent CLIs and drives
 * it over HTTP. No provider login, no tokens, no network. Run: `npm test`.
 *
 * It covers the machinery that's easy to break: routing, the delta protocol,
 * session resume, per-seat flags, receipts, lurk + right of reply, hops and
 * their budget, pair sessions, per-agent lanes, queueing, work mode activity
 * lines, seat selection, and config validation.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "parley.mjs");
const FAKE = path.join(here, "fake-cli.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "parley-smoke-"));

let base = "";
let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TOKEN = ""; // read out of the served page, exactly as the browser does
const RUNTIME_PROTOCOL = "5";

async function api(method, route, body) {
  const res = await fetch(base + route, method === "GET"
    ? { headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL } }
    : {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Parley-Token": TOKEN,
        "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL,
      },
      body: JSON.stringify(body || {}),
    });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Browser fetch implementations may ignore or rewrite Host. Security tests
// need the exact bytes Node sends, so use the raw HTTP client when exercising
// Host/Origin combinations while still connecting to the loopback listener.
function rawStatus(route, { method = "GET", host, origin, token = TOKEN, protocol = RUNTIME_PROTOCOL, body = null } = {}) {
  const target = new URL(base);
  const payload = body === null ? null : JSON.stringify(body);
  const headers = { Host: host || target.host };
  if (origin) headers.Origin = origin;
  if (token !== null) headers["X-Parley-Token"] = token;
  if (protocol !== null) headers["X-Parley-Runtime-Protocol"] = protocol;
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: Number(target.port),
      path: route,
      method,
      headers,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error(`raw request timed out: ${method} ${route}`)));
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const room = (name) => api("GET", `/api/room?name=${encodeURIComponent(name)}`).then((r) => r.data);
const roomStatus = (name) => api("GET", `/api/room?name=${encodeURIComponent(name)}`).then((r) => r.status);
const cfg = (name, config) => api("POST", "/api/config", { room: name, config });
const say = (name, text, target = "auto") => api("POST", "/api/message", { room: name, text, target });

async function useFakes(name) {
  await cfg(name, { agents: { claude: { command: FAKE }, codex: { command: FAKE } } });
}
// `working` matters: between the turns of a pair cycle nobody is busy yet, and
// polling only `busy` would report idle in that gap and read a half-done room.
async function idle(name, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    const d = await room(name);
    if (d.room.busy.length === 0 && !d.room.queued && !d.room.working) return d;
    if (Date.now() > until) throw new Error("timed out waiting for " + name);
    await sleep(120);
  }
}
async function waitRoom(name, predicate, label, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const d = await room(name);
    if (predicate(d)) return d;
    if (Date.now() > until) throw new Error(`timed out waiting for ${name}: ${label}`);
    await sleep(80);
  }
}
async function waitFile(file, label, ms = 10000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for file: ${label}`);
    await sleep(50);
  }
}

// Polling proves the final summary is right; this small SSE tap additionally
// proves clients are actually told about both edges of a multi-step cycle.
async function watchRoomSummaries(name) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?room=${encodeURIComponent(name)}&token=${encodeURIComponent(TOKEN)}&protocol=${encodeURIComponent(RUNTIME_PROTOCOL)}`, {
    signal: controller.signal,
  });
  if (res.status !== 200) throw new Error(`could not watch ${name}: HTTP ${res.status}`);
  const seen = [];
  let readError = null;
  const done = (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const raw = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!raw) continue;
        try {
          const event = JSON.parse(raw);
          if (event.type === "room") seen.push(event.room);
        } catch { /* a malformed frame is not a room summary */ }
      }
    }
  })().catch((e) => { if (!controller.signal.aborted) readError = e; });
  return {
    seen,
    async stop() {
      controller.abort();
      await done;
      if (readError) throw readError;
    },
  };
}

function localStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}
const texts = (d, kind) => d.entries.filter((e) => !kind || e.kind === kind).map((e) => e.text);
const lastAgent = (d, author) => [...d.entries].reverse().find((e) => e.kind === "agent" && (!author || e.author === author));
const argvFrom = (entry) => {
  const text = entry && String(entry.text || "");
  if (!text.startsWith("ARGVJSON ")) return [];
  try { return JSON.parse(text.slice(9)); } catch { return []; }
};
const hasArg = (argv, flag, value) => argv.some((arg, i) =>
  arg === `${flag}=${value}` || (arg === flag && argv[i + 1] === value));
const argValue = (argv, flag) => {
  const inline = argv.find((arg) => String(arg).startsWith(`${flag}=`));
  if (inline) return String(inline).slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 ? String(argv[i + 1] || "") : "";
};

// ---------------------------------------------------------------- boot

const server = spawn(process.execPath, [SERVER, "--no-open", "--port", "0", "--root", ROOT], {
  // low ceilings keep the runaway-guard and abandoned-cycle tests quick
  env: { ...process.env, FAKE_DELAY_MS: "250", PARLEY_PAIR_SAFETY: "4", PARLEY_HOP_SAFETY: "4", PARLEY_SEAT_WAIT_MS: "2500" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

base = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server never reported a URL:\n" + serverLog)), 15000);
  const check = setInterval(() => {
    const m = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(serverLog);
    if (m) { clearInterval(check); clearTimeout(t); resolve(m[1]); }
  }, 100);
});

// A missing desktop opener reports its failure asynchronously on the
// ChildProcess. On POSIX an empty PATH makes both auto-open paths deterministic.
// Windows still locates cmd.exe and powershell.exe through system search paths.
async function checkMissingOpener() {
  if (process.platform === "win32") return;
  const openerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parley-opener-"));
  const emptyPath = path.join(openerRoot, "empty-path");
  fs.mkdirSync(emptyPath);
  const proc = spawn(process.execPath, [SERVER, "--port", "0", "--root", openerRoot], {
    env: { ...process.env, PATH: emptyPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => { log += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { log += chunk.toString(); });

  let openerBase = null;
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(log);
    if (match) { openerBase = match[1]; break; }
    if (proc.exitCode !== null) break;
    await sleep(50);
  }
  await sleep(350);
  const survivedStartup = !!openerBase && proc.exitCode === null;
  ok("a missing startup browser opener does not crash the server", survivedStartup,
    `exit=${proc.exitCode}; ${log.slice(-300)}`);

  let survivedApiOpen = false;
  if (survivedStartup) {
    try {
      const page = await fetch(openerBase + "/").then((r) => r.text());
      const token = (/name="parley-token" content="([^"]+)"/.exec(page) || [])[1] || "";
      const opened = await fetch(openerBase + "/api/open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Parley-Token": token,
          "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL,
        },
        body: JSON.stringify({ room: "default", what: "workspace" }),
      });
      await sleep(350);
      survivedApiOpen = opened.status === 500 && proc.exitCode === null;
    } catch { /* a crash is the behavior under test */ }
  }
  ok("a missing folder opener does not crash the server", survivedApiOpen,
    `exit=${proc.exitCode}; ${log.slice(-300)}`);

  if (proc.exitCode === null) {
    proc.kill();
    await Promise.race([
      new Promise((resolve) => proc.once("close", resolve)),
      sleep(2000),
    ]);
  }
  try { fs.rmSync(openerRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A running backend must never start serving a newer index.html from disk.
// That split previously made a newly added permission control appear to save
// even though the old process did not know how to apply it.
async function checkUiSnapshot() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "parley-ui-snapshot-"));
  const fixtureServer = path.join(fixture, "parley.mjs");
  const fixtureUiDir = path.join(fixture, "ui");
  const fixtureUi = path.join(fixtureUiDir, "index.html");
  fs.mkdirSync(fixtureUiDir, { recursive: true });
  fs.copyFileSync(SERVER, fixtureServer);
  fs.writeFileSync(fixtureUi,
    "<!doctype html><html><head><!--PARLEY_TOKEN--></head><body>startup-ui</body></html>");
  const proc = spawn(process.execPath, [fixtureServer, "--no-open", "--port", "0", "--root", path.join(fixture, "rooms")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => { log += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { log += chunk.toString(); });

  let fixtureBase = null;
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(log);
    if (match) { fixtureBase = match[1]; break; }
    if (proc.exitCode !== null) break;
    await sleep(50);
  }

  let pinned = false;
  if (fixtureBase) {
    try {
      const first = await fetch(fixtureBase + "/").then((r) => r.text());
      fs.writeFileSync(fixtureUi,
        "<!doctype html><html><head><!--PARLEY_TOKEN--></head><body>replacement-ui</body></html>");
      const second = await fetch(fixtureBase + "/").then((r) => r.text());
      pinned = first.includes("startup-ui") && second.includes("startup-ui") && !second.includes("replacement-ui");
    } catch { /* reported below */ }
  }
  ok("the server pins its startup UI instead of mixing runtime versions", pinned, log.slice(-300));

  if (proc.exitCode === null) {
    proc.kill();
    await Promise.race([
      new Promise((resolve) => proc.once("close", resolve)),
      sleep(2000),
    ]);
  }
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function bootAuxServer(entry, root, extraEnv = {}) {
  const proc = spawn(process.execPath, [entry, "--no-open", "--port", "0", "--root", root], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => { log += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { log += chunk.toString(); });

  let auxBase = null;
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(log);
    if (match) { auxBase = match[1]; break; }
    if (proc.exitCode !== null) break;
    await sleep(50);
  }
  if (!auxBase) {
    try { proc.kill(); } catch { /* already gone */ }
    throw new Error(`auxiliary server did not start (exit=${proc.exitCode}): ${log.slice(-500)}`);
  }

  const page = await fetch(auxBase + "/").then((r) => r.text());
  const token = (/name="parley-token" content="([^"]+)"/.exec(page) || [])[1] || "";
  const request = async (method, route, body) => {
    const res = await fetch(auxBase + route, method === "GET" ? {
      headers: { "X-Parley-Token": token, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
    } : {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Parley-Token": token,
        "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL,
      },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const stop = async () => {
    if (proc.exitCode === null) {
      try { proc.kill(); } catch { /* already gone */ }
      await Promise.race([new Promise((resolve) => proc.once("close", resolve)), sleep(2000)]);
    }
  };
  return { proc, request, stop, log: () => log };
}

async function waitAuxRoom(aux, name, predicate, ms = 8000) {
  const until = Date.now() + ms;
  let latest = null;
  while (Date.now() < until) {
    latest = (await aux.request("GET", `/api/room?name=${encodeURIComponent(name)}`)).data;
    if (predicate(latest)) return latest;
    await sleep(80);
  }
  return latest;
}

// A bare command must honor PATH directory order. The npm shim comes first;
// a later executable with the same name must not replace it merely because it
// has an .exe extension.
async function checkWindowsCommandPrecedence() {
  if (process.platform !== "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "parley-path-order-"));
  const early = path.join(fixture, "early");
  const late = path.join(fixture, "late");
  const auxRoot = path.join(fixture, "rooms");
  const command = "parley-path-probe";
  fs.mkdirSync(early);
  fs.mkdirSync(late);
  fs.copyFileSync(FAKE, path.join(early, "fake-cli.mjs"));
  fs.writeFileSync(path.join(early, command + ".cmd"), '@ECHO off\r\n"%dp0%\\fake-cli.mjs" %*\r\n');
  fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"),
    path.join(late, command + ".exe"));

  let aux = null;
  try {
    aux = await bootAuxServer(SERVER, auxRoot, {
      PATH: [early, late, process.env.PATH || ""].join(path.delimiter),
      FAKE_DELAY_MS: "10",
    });
    await aux.request("POST", "/api/rooms", { name: "pathorder" });
    await aux.request("POST", "/api/config", {
      room: "pathorder",
      config: { agents: { claude: { command: FAKE }, codex: { command } } },
    });
    await aux.request("POST", "/api/message", { room: "pathorder", text: "@codex SAY:SHIM_WON", target: "auto" });
    const d = await waitAuxRoom(aux, "pathorder", (roomData) => roomData && roomData.entries.some((e) =>
      (e.kind === "agent" && e.author === "codex") || (e.kind === "system" && e.meta && e.meta.error)));
    const reply = d && [...d.entries].reverse().find((e) => e.kind === "agent" && e.author === "codex");
    const providerError = d && d.entries.find((e) => e.kind === "system" && e.meta && e.meta.error);
    ok("Windows command resolution preserves PATH directory order",
      !!reply && reply.text === "SHIM_WON" && !providerError,
      providerError ? providerError.text : aux.log().slice(-300));
  } catch (e) {
    ok("Windows command resolution preserves PATH directory order", false, e.message);
  } finally {
    if (aux) await aux.stop();
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Node can throw from spawn() synchronously (Windows EPERM is one example).
// Force that edge so it remains a normal provider launch error rather than a
// raw exception escaping the process runner.
async function checkSynchronousSpawnFailure() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "parley-sync-spawn-"));
  const auxRoot = path.join(fixture, "rooms");
  const marker = path.join(fixture, "forced-spawn-error");
  const wrapper = path.join(fixture, "server-wrapper.mjs");
  fs.writeFileSync(marker, "not an executable\n");
  fs.writeFileSync(wrapper, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const realSpawn = childProcess.spawn;
const marker = process.env.PARLEY_SYNC_THROW_MARKER;
childProcess.spawn = function(command, args, options) {
  if (String(command) === marker) {
    const error = new Error("forced spawn EPERM");
    error.code = "EPERM";
    throw error;
  }
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(SERVER).href)});
`);

  let aux = null;
  try {
    aux = await bootAuxServer(wrapper, auxRoot, { PARLEY_SYNC_THROW_MARKER: marker });
    await aux.request("POST", "/api/rooms", { name: "syncspawn" });
    await aux.request("POST", "/api/config", {
      room: "syncspawn",
      config: { agents: { claude: { command: FAKE }, codex: { command: marker } } },
    });
    await aux.request("POST", "/api/message", { room: "syncspawn", text: "@codex hello", target: "auto" });
    const d = await waitAuxRoom(aux, "syncspawn", (roomData) => roomData && roomData.entries.some((e) =>
      e.kind === "system" && e.meta && e.meta.agent === "codex" && e.meta.error));
    const errorEntry = d && [...d.entries].reverse().find((e) =>
      e.kind === "system" && e.meta && e.meta.agent === "codex" && e.meta.error);
    const stillAlive = (await aux.request("GET", "/api/rooms")).status === 200 && aux.proc.exitCode === null;
    ok("synchronous spawn failures become actionable provider errors",
      stillAlive && !!errorEntry && errorEntry.text.includes("could not launch codex") &&
        errorEntry.text.includes("forced spawn EPERM"),
      errorEntry ? errorEntry.text : aux.log().slice(-300));
  } catch (e) {
    ok("synchronous spawn failures become actionable provider errors", false, e.message);
  } finally {
    if (aux) await aux.stop();
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Browse… was dead because every folder-picker failure resolved as "cancelled"
// and the UI does nothing on a cancel. Each way the dialog can end must be
// distinguishable, and a chatty picker must not deadlock on its own stderr.
async function checkFolderPicker() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "parley-pickfolder-"));
  const auxRoot = path.join(fixture, "rooms");
  const picker = path.join(fixture, "fake-picker.mjs");
  const wrapper = path.join(fixture, "server-wrapper.mjs");
  const chosen = path.join(fixture, "chosen-project");
  fs.mkdirSync(chosen);

  // Stands in for powershell/osascript/zenity: a real child with real pipes,
  // so exit codes, stderr pressure and kills behave the way they do in life.
  fs.writeFileSync(picker, `
const mode = process.argv[2];
const chosen = process.argv[3];
if (mode === "ok") { process.stdout.write(chosen + "\\n"); process.exit(0); }
if (mode === "cancel") process.exit(0);
if (mode === "fail") { process.stderr.write("Add-Type : dialog unavailable\\nat line 2\\n"); process.exit(3); }
if (mode === "noisy") {
  process.stderr.write("x".repeat(400000));   // far past the 64 KB pipe buffer
  process.stdout.write(chosen + "\\n");
  process.exit(0);
}
// osascript and zenity report a *user cancel* with a non-zero exit.
if (mode === "maccancel") { process.stderr.write("0:35: execution error: User canceled. (-128)\\n"); process.exit(1); }
if (mode === "macfail") { process.stderr.write("0:0: execution error: no window server (-1728)\\n"); process.exit(1); }
if (mode === "zenitycancel") process.exit(1);
// GTK chatters on stderr during perfectly ordinary runs; exit 1 is still a cancel.
if (mode === "zenitywarncancel") { process.stderr.write("Gtk-Message: Failed to load module \\"canberra-gtk-module\\"\\n"); process.exit(1); }
if (mode === "zenityfail") { process.stderr.write("Gtk: cannot open display\\n"); process.exit(255); }
// Printed a path, then died: not an answer the user confirmed.
if (mode === "printthenfail") {
  process.stdout.write(chosen + "\\n");
  process.stderr.write("picker crashed after printing\\n");
  process.exit(3);
}
if (mode === "printthenhang") { process.stdout.write(chosen + "\\n"); setInterval(() => {}, 1000); }
setInterval(() => {}, 1000); // "hang": wait for the timeout to kill us
`);
  fs.writeFileSync(wrapper, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
// The picker Parley reaches for is chosen by platform, so exercising the macOS
// and Linux cancel conventions means telling the server it is on one.
const forced = process.env.PARLEY_TEST_PLATFORM;
if (forced) Object.defineProperty(process, "platform", { value: forced, configurable: true });
const realSpawn = childProcess.spawn;
const PICKERS = new Set(["powershell.exe", "osascript", "zenity"]);
childProcess.spawn = function(command, args, options) {
  if (!PICKERS.has(String(command))) return realSpawn(command, args, options);
  const mode = process.env.PARLEY_TEST_PICKER || "cancel";
  if (mode === "throw") {
    const error = new Error("forced picker EPERM");
    error.code = "EPERM";
    throw error;
  }
  return realSpawn(process.execPath,
    [process.env.PARLEY_TEST_PICKER_SCRIPT, mode, process.env.PARLEY_TEST_PICKER_PATH], options);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(SERVER).href)});
`);

  // A forced platform only changes which command name is spawned and how a
  // cancel is read. Anything that has to be *killed* runs natively, because
  // killTree's POSIX process-group path can't reap a real Windows child.
  const cases = [
    ["a chosen folder comes back as a path", "ok", null, (d) => d.path === chosen],
    ["a cancelled dialog stays silent", "cancel", null, (d) => d.cancelled === true && !d.error],
    ["a picker that won't spawn reports an error", "throw", null,
      (d) => !d.cancelled && /forced picker EPERM/.test(d.error || "")],
    ["a failing picker reports its exit code and stderr", "fail", null,
      (d) => !d.cancelled && /exit 3/.test(d.error || "") && /dialog unavailable/.test(d.error || "")],
    ["a picker left open times out distinctly", "hang", null,
      (d) => !d.cancelled && /still open/.test(d.error || "")],
    ["heavy stderr doesn't deadlock the picker", "noisy", null, (d) => d.path === chosen],
    ["a macOS cancel is a cancel, not an error", "maccancel", "darwin",
      (d) => d.cancelled === true && !d.error],
    ["a macOS failure is still an error", "macfail", "darwin",
      (d) => !d.cancelled && /no window server/.test(d.error || "")],
    ["a zenity cancel is a cancel, not an error", "zenitycancel", "linux",
      (d) => d.cancelled === true && !d.error],
    ["a GTK warning does not turn a zenity cancel into an error", "zenitywarncancel", "linux",
      (d) => d.cancelled === true && !d.error],
    ["a zenity failure is still an error", "zenityfail", "linux",
      (d) => !d.cancelled && /exit 255/.test(d.error || "")],
    ["a path printed before a crash is not accepted", "printthenfail", null,
      (d) => !d.path && !d.cancelled && /exit 3/.test(d.error || "")],
    ["a path printed before a hang is not accepted", "printthenhang", null,
      (d) => !d.path && !d.cancelled && /still open/.test(d.error || "")],
  ];

  for (const [name, mode, platform, check] of cases) {
    let aux = null;
    try {
      aux = await bootAuxServer(wrapper, auxRoot, {
        PARLEY_TEST_PICKER: mode,
        PARLEY_TEST_PICKER_SCRIPT: picker,
        PARLEY_TEST_PICKER_PATH: chosen,
        PARLEY_PICKER_MS: "1500", // the real 5 min would stall the suite
        ...(platform ? { PARLEY_TEST_PLATFORM: platform } : {}),
      });
      const { data } = await aux.request("POST", "/api/pickfolder", { start: null });
      ok("folder picker: " + name, check(data), JSON.stringify(data));
    } catch (e) {
      ok("folder picker: " + name, false, e.message);
    } finally {
      if (aux) await aux.stop();
    }
  }
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Static picker guarantees stay testable even when a restricted runner skips
// the native lifecycle fixture because it cannot kill the deliberately hung
// fake picker.
function checkFolderPickerSource() {
  // The Windows script's own failure mode: without a terminating preference a
  // broken cmdlet writes to stderr, runs on, and exits 0 — a silent cancel.
  const serverSource = fs.readFileSync(SERVER, "utf8");
  ok("folder picker: the Windows script fails loudly rather than exiting clean",
    serverSource.includes("$ErrorActionPreference = 'Stop'"));
  const popupLookup = serverSource.indexOf("GetWindow(owner, GW_ENABLEDPOPUP)");
  const inputAttach = serverSource.indexOf("AttachThreadInput(popupThread, foregroundThread, true)");
  const popupActivate = serverSource.indexOf("SetForegroundWindow(popup)");
  const popupRaise = serverSource.indexOf("SetWindowPos(popup, HWND_TOPMOST");
  const timerStart = serverSource.indexOf("$timer.Start()");
  const showDialog = serverSource.indexOf("$dlg.ShowDialog($owner)");
  ok("folder picker: the Windows script uses foreground-thread activation with a taskbar fallback",
    popupLookup >= 0 && inputAttach > popupLookup && popupActivate > inputAttach && popupRaise > popupActivate &&
    timerStart >= 0 && showDialog > timerStart && serverSource.includes("$owner.ShowInTaskbar = $true") &&
    serverSource.includes("AttachThreadInput(popupThread, foregroundThread, false)") &&
    serverSource.includes("$timer.Stop(); $timer.Dispose(); $dlg.Dispose(); $owner.Close(); $owner.Dispose()"));
  ok("folder picker: failed foreground activation stops retrying before the five-minute dialog timeout",
    serverSource.includes("$owner.Tag = 0") &&
    serverSource.includes("$owner.Tag = [int]$owner.Tag + 1") &&
    serverSource.includes("[int]$owner.Tag -ge 40"));
}

// The folder dialog is not modal to this page, so the form that opened it can
// be submitted or reset while it is still open. That is a DOM-lifetime problem,
// not a string in the source: it needs the page's own handlers run against a
// document where writing an element's text really does destroy its children.
async function checkFolderPickerUi() {
  const src = fs.readFileSync(path.join(here, "..", "ui", "index.html"), "utf8");
  const body = src.slice(src.indexOf("<script>") + "<script>".length);
  const script = body.slice(0, body.indexOf("// ---------------- boot".replace("----------------", "-".repeat(60))));

  const noop = () => {};
  const byId = new Map();
  const destroyed = new Set();
  class El {
    constructor(id, attrs) {
      this.id = id || null;
      this.attrs = attrs || {};
      this.children = [];
      this.listeners = {};
      this._text = "";
      this.value = ""; this.innerText = ""; this.disabled = false; this.hidden = false; this.files = [];
      this.style = {}; this.dataset = {};
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains: (name) => classes.has(name),
      };
    }
    get textContent() { return this._text; }
    set textContent(v) {
      // The behaviour under test: assigning text replaces every child, so
      // anything still holding one of them by id is holding nothing.
      for (const c of this.children) if (c.id) { byId.delete(c.id); destroyed.add(c.id); }
      this.children = [];
      this._text = String(v);
    }
    get innerHTML() { return this._text; }
    set innerHTML(v) { this.textContent = v; }
    querySelector(sel) {
      const attr = /^\[([^\]=]+)]$/.exec(sel);
      return attr ? (this.children.find((c) => attr[1] in c.attrs) || null) : null;
    }
    querySelectorAll() { return []; }
    appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { this.clicked = (this.clicked || 0) + 1; return this.onclick && this.onclick({ target: this }); }
    removeEventListener() {} setAttribute() {} removeAttribute() {}
    getAttribute() { return null; } closest() { return null; }
    focus() {} blur() {} remove() {} scrollTo() {}
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  }
  const el = (id, attrs) => { const e = new El(id, attrs); if (id) byId.set(id, e); return e; };
  // The picker buttons keep their real shape: a label span the "Choosing…"
  // swap may touch, and — on the new-room button — a live value span that
  // other code writes to while the dialog is open.
  const newRoomProj = el("newRoomProj");
  newRoomProj.appendChild(new El(null, { "data-picker-label": "" }));
  newRoomProj.appendChild(el("newRoomProjVal"));
  el("s_browse").appendChild(new El(null, { "data-picker-label": "" }));
  const chips = ["auto", "claude", "codex", "both"].map((target) => {
    const chip = new El(null); chip.dataset.t = target;
    if (target === "auto") chip.classList.add("active");
    return chip;
  });

  class TestURL extends URL {}
  let blobSeq = 0;
  TestURL.createObjectURL = () => `blob:smoke-${++blobSeq}`;
  TestURL.revokeObjectURL = noop;
  class TestFileReader {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file.data}`;
      queueMicrotask(() => this.onload && this.onload());
    }
  }

  let nextFetch = () => new Promise(() => {}); // a dialog that never comes back
  const windowListeners = {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL: TestURL, URLSearchParams, TextDecoder, AbortController, FileReader: TestFileReader,
    crypto: { randomUUID: () => `draft-${++blobSeq}` },
    fetch: (...a) => nextFetch(...a),
    confirm: () => true, prompt: () => null, alert: noop,
    window: {
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
      removeEventListener() {},
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    history: { replaceState: noop },
    location: { search: "", pathname: "/", href: "http://127.0.0.1/" },
    EventSource: class { constructor() { this.url = ""; } close() {} },
    // The composer strip watches live bubbles for visibility. Nothing in this
    // headless DOM has a layout, so the observer never fires — but it must
    // exist, or the page script dies on the real code path.
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    document: {
      getElementById(id) {
        if (destroyed.has(id)) return null; // destroyed by a textContent write
        if (!byId.has(id)) byId.set(id, new El(id));
        return byId.get(id);
      },
      querySelector(sel) {
        if (sel.includes("parley-token")) return { content: "smoke-token-0123456789abcdef" };
        if (sel.includes("parley-runtime-protocol")) return { content: RUNTIME_PROTOCOL };
        return null;
      },
      querySelectorAll: (sel) => sel === ".chip" ? chips : [],
      createElement: (tag) => { const node = new El(null); node.tagName = String(tag || "").toUpperCase(); return node; },
      createDocumentFragment: () => new El(null),
      addEventListener: noop,
      body: new El(null), head: new El(null), title: "", hidden: false,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${script}
;globalThis.__probe = {
  openPicker: $("newRoomProj").onclick,
  resetForm: $("addRoomBtn").onclick,
  send,
  choose(target) { state.chipRevision++; selectChip(target); },
  get chip() { return state.chip; },
  activeChip() { return ([...document.querySelectorAll(".chip")].find((c) => c.classList.contains("active")) || {}).dataset?.t; },
  get draftCount() { return state.draftImages.length; },
  get draftFileCount() { return state.draftFiles.length; },
  get draftAttachmentCount() { return draftAttachmentCount(); },
  paste(event) { return ($("input").listeners.paste || [])[0](event); },
  chooseFiles(files) {
    const picker = $("fileInput");
    picker.files = files;
    return (picker.listeners.change || [])[0]({ target: picker });
  },
  drag(type, event) { return (globalThis.__windowListeners[type] || [])[0](event); },
  clearDrafts() { clearDraftAttachments(); },
  renderAttachments(entry) {
    const bubble = document.createElement("div");
    renderEntryAttachments(entry, bubble);
    return bubble;
  },
  set text(value) { $("input").value = value; },
  get projectDir() { return newRoomProjectDir; },
  seedRoom(summary, entries, receipts = []) {
    state.summary = summary;
    state.providers = summary.providers || state.providers;
    state.entries = entries || [];
    state.receipts = receipts;
    state.queue = summary.queue || [];
  },
  heard(agent, n) {
    const entry = state.entries.find((candidate) => candidate.n === n);
    return entry ? computeHeard(agent, entry) : null;
  },
  setWithdrawals(map) {
    state.summary.cancelledDeliveries = map;
    refreshHeard(0, Infinity);
  },
  set renderFrom(v) { state.renderFromN = v; },
  get renderFrom() { return state.renderFromN; },
  jumpTo(n) { jumpToEntry(n); },
  queueCards() { return queueGroups(); },
  queuePop() { renderQueuePop(); return $("queuePop").innerHTML; },
  queueBadgeText() { setQueue(state.summary.queued, state.summary.queue, state.summary.queuedDispatches); return $("queueBadge").textContent; },
  stopMenu() { updateBusyUI(); return $("stopMenu").innerHTML; },
  entryQuote(entry) { return entryQuoteHTML(entry); },
};`, Object.assign(sandbox, { __windowListeners: windowListeners }), { filename: "parley-ui.js" });

  const probe = sandbox.__probe;
  const ok200 = (data) => ({
    ok: true, status: 200, statusText: "OK",
    headers: { get: () => RUNTIME_PROTOCOL },
    json: async () => data,
  });

  // Reset the form while the dialog is still open. The button's own contents
  // must survive, or clearing the form dereferences an element that is gone.
  let crash = null;
  const openWhileReset = probe.openPicker();
  try { probe.resetForm(); } catch (e) { crash = e; }
  ok("folder picker UI: resetting the form mid-pick doesn't destroy the button's contents",
    !crash, crash && crash.message);

  // …and the result that finally arrives belongs to a form the user has left.
  let settle;
  nextFetch = () => new Promise((r) => { settle = r; });
  const stale = probe.openPicker();
  await sleep(0);
  probe.resetForm();
  settle(ok200({ path: "D:\\stale-project" }));
  await stale;
  ok("folder picker UI: a result arriving after the form was reset is discarded",
    probe.projectDir === null, String(probe.projectDir));
  await Promise.race([openWhileReset, sleep(0)]);

  // Behavioural, not source-shaped: drive the real functions over seeded state.
  // Both queue rows below come from the *same* message (sourceN 4) via two
  // separate dispatches — the case where matching runs on rootN would let both
  // cards claim one running seat.
  const uiSummary = {
    name: "probe", seats: ["claude", "codex"], busy: ["claude"], working: true,
    queued: 3, queuedDispatches: 2,
    agents: { claude: { cursor: 0 }, codex: { cursor: 0 } },
    cfg: { agents: { claude: {}, codex: {} } },
    providers: {
      claude: { label: "Claude", color: "#c8a2ff", avatar: "C" },
      codex: { label: "Codex", color: "#7fd1b9", avatar: "X" },
    },
    busyInfo: [{
      agent: "claude", runId: "r7", phase: "start", rootN: 4, sourceN: 4, queueGroupId: "d2",
      source: { n: 4, kind: "user", author: "user", ts: "2026-08-05T02:02:00", text: "the original ask" },
    }],
    queue: [
      { seq: 2, kind: "delivery", agents: ["claude"], positions: { claude: 1 }, queueGroupId: "d2",
        sourceN: 4, target: "claude", text: "the original ask", ts: "2026-08-05T02:02:00" },
      { seq: 3, kind: "delivery", agents: ["claude"], positions: { claude: 2 }, queueGroupId: "d3",
        sourceN: 4, target: "both", text: "the original ask", ts: "2026-08-05T02:02:00" },
      { seq: 4, kind: "delivery", agents: ["codex"], positions: { codex: 1 }, queueGroupId: "d3",
        sourceN: 4, target: "both", text: "the original ask", ts: "2026-08-05T02:02:00" },
    ],
  };
  probe.seedRoom(uiSummary, [
    { n: 4, kind: "user", author: "user", target: "claude", ts: "2026-08-05T02:02:00", text: "the original ask", meta: {} },
    { n: 5, kind: "agent", author: "claude", ts: "2026-08-05T02:03:00", text: "answer", meta: { replyTo: 4 } },
  ]);
  const cards = probe.queueCards();
  ok("two dispatches from one message become sibling cards, not one",
    cards.length === 2 && cards[0].groupId === "d2" && cards[1].groupId === "d3" &&
    cards[0].sourceN === 4 && cards[1].sourceN === 4 &&
    cards[0].rows.length === 1 && cards[1].rows.length === 2,
    JSON.stringify(cards.map((c) => ({ id: c.groupId, src: c.sourceN, rows: c.rows.length }))));
  const pop = probe.queuePop();
  ok("…and only the dispatch that owns the run shows it as responding",
    (pop.match(/qp-row running/g) || []).length === 1 &&
    (pop.match(/data-cancel-group="d[23]"/g) || []).length === 2,
    pop);
  ok("the badge counts messages while the lanes count deliveries",
    probe.queueBadgeText() === "⏳ 2 queued", probe.queueBadgeText());
  const menu = probe.stopMenu();
  ok("the Stop menu names each scope and counts messages, not deliveries",
    /data-stop-scope="seat" /.test(menu) && /data-stop-scope="active"/.test(menu) &&
    /Cancel 2 queued messages/.test(menu) && /data-stop-scope="all"/.test(menu), menu);
  ok("a reply that directly follows its source still carries the quote",
    /data-jump-n="4"/.test(probe.entryQuote({ n: 5, kind: "agent", author: "claude", meta: { replyTo: 4 } })));
  probe.renderFrom = 4;
  probe.jumpTo(4);
  ok("the quote jump expands collapsed history before looking for its target",
    probe.renderFrom === null);

  // Behavioural precedence, not a source-order assertion: even a spanning live
  // receipt, an advanced cursor and a busy seat cannot turn a withdrawn message
  // into "heard". Clearing the Retry marker restores the receipt-derived state.
  uiSummary.cancelledDeliveries = { "4": ["claude"] };
  uiSummary.agents.claude.cursor = 9;
  probe.seedRoom(uiSummary, [
    { n: 4, kind: "user", author: "user", target: "claude", ts: "2026-08-05T02:02:00", text: "the original ask", meta: {} },
  ], [{ agent: "claude", from: 0, upTo: 9, turn: 4, mode: "turn", spoke: true, ts: "2026-08-05T02:03:00" }]);
  ok("a withdrawn receipt dot beats live receipt, cursor and busy state",
    probe.heard("claude", 4)?.cls === "withheld", JSON.stringify(probe.heard("claude", 4)));
  probe.setWithdrawals({});
  ok("clearing the withdrawal immediately restores the ordinary receipt dot",
    probe.heard("claude", 4)?.cls === "live", JSON.stringify(probe.heard("claude", 4)));

  // Inline routing wins on the server. Once that answer comes back, the chip
  // must follow it so the next untagged send does not accidentally stay @both.
  let sentBody = null;
  probe.choose("both");
  probe.text = "@claude SAY:SYNC";
  nextFetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return ok200({ ok: true, target: "claude", explicit: true });
  };
  await probe.send();
  ok("target chip: a successful inline @tag follows the server-resolved target",
    sentBody && sentBody.target === "both" && probe.chip === "claude" && probe.activeChip() === "claude",
    JSON.stringify({ sentBody, chip: probe.chip, active: probe.activeChip() }));

  let settleSend;
  probe.choose("both");
  probe.text = "@claude SAY:STALE";
  nextFetch = () => new Promise((resolve) => { settleSend = resolve; });
  const staleSend = probe.send();
  await sleep(0);
  probe.choose("codex");
  settleSend(ok200({ ok: true, target: "claude", explicit: true }));
  await staleSend;
  ok("target chip: an older send response cannot overwrite a newer manual choice",
    probe.chip === "codex" && probe.activeChip() === "codex", probe.chip);

  const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const pastedFile = { name: "clipboard.png", type: "image/png", size: Buffer.from(pngData, "base64").length, data: pngData };
  let prevented = false;
  probe.paste({
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pastedFile }] },
    preventDefault() { prevented = true; },
  });
  ok("image paste UI: an image paste is captured and previewed", prevented && probe.draftCount === 1);
  probe.text = "";
  sentBody = null;
  nextFetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return ok200({ ok: true, target: "codex", explicit: false });
  };
  await probe.send();
  ok("image paste UI: an image-only send carries base64 and clears after success",
    sentBody && sentBody.text === "" && sentBody.images.length === 1 &&
    sentBody.images[0].data === pngData && probe.draftCount === 0,
    JSON.stringify(sentBody));

  probe.paste({
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pastedFile }] },
    preventDefault: noop,
  });
  probe.text = "keep me";
  nextFetch = async () => ({
    ok: false, status: 400, statusText: "Bad Request",
    headers: { get: () => RUNTIME_PROTOCOL }, json: async () => ({ error: "forced failure" }),
  });
  await probe.send();
  ok("image paste UI: a failed send preserves the pasted image for retry", probe.draftCount === 1);
  probe.paste({
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({
      name: "five-megabytes.png", type: "image/png", size: 5 * 1024 * 1024, data: pngData,
    }) }] },
    preventDefault: noop,
  });
  probe.paste({
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({
      name: "over-total.png", type: "image/png", size: 2 * 1024 * 1024, data: pngData,
    }) }] },
    preventDefault: noop,
  });
  ok("image paste UI: aggregate image drafts are capped below Claude's stdin limit",
    probe.draftCount === 2, String(probe.draftCount));
  let textPrevented = false;
  probe.paste({
    clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
    preventDefault() { textPrevented = true; },
  });
  ok("image paste UI: ordinary text paste remains native", textPrevented === false);

  probe.clearDrafts();
  probe.text = "";
  const diffText = "diff --git a/a.txt b/a.txt\n+review me\n";
  const diffData = Buffer.from(diffText).toString("base64");
  const diffFile = {
    name: "review.diff", type: "text/x-diff", size: Buffer.byteLength(diffText), data: diffData,
  };
  let dragPrevented = false;
  const dragTransfer = { types: ["Files"], files: [], dropEffect: "none" };
  probe.drag("dragover", {
    dataTransfer: dragTransfer,
    preventDefault() { dragPrevented = true; },
  });
  let dropPrevented = false;
  probe.drag("drop", {
    dataTransfer: { types: ["Files"], files: [diffFile] },
    preventDefault() { dropPrevented = true; },
  });
  ok("file attachment UI: dragging a file cannot navigate the page and adds the same draft card",
    dragPrevented && dropPrevented && dragTransfer.dropEffect === "copy" &&
      probe.draftFileCount === 1 && probe.draftAttachmentCount === 1);
  probe.clearDrafts();
  let textDropPrevented = false;
  probe.drag("drop", {
    dataTransfer: { types: ["text/plain"], files: [] },
    preventDefault() { textDropPrevented = true; },
  });
  ok("file attachment UI: ordinary text drops retain native textarea behaviour",
    textDropPrevented === false && probe.draftAttachmentCount === 0);

  probe.chooseFiles([diffFile]);
  const draftFileCard = sandbox.document.getElementById("draftImages").children.find((child) =>
    child.className === "draft-file" && child.title === "review.diff");
  const cardReady = probe.draftFileCount === 1 && probe.draftAttachmentCount === 1 &&
    sandbox.document.getElementById("fileInput").value === "" && draftFileCard &&
    typeof draftFileCard.children.at(-1).onclick === "function";
  draftFileCard.children.at(-1).onclick();
  const cardRemoved = probe.draftAttachmentCount === 0;
  probe.chooseFiles([diffFile]);
  ok("file attachment UI: the multiple-file picker adds a removable filename/size card",
    cardReady && cardRemoved && probe.draftFileCount === 1 && probe.draftAttachmentCount === 1,
    JSON.stringify({ files: probe.draftFileCount, total: probe.draftAttachmentCount }));

  sentBody = null;
  nextFetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return ok200({ ok: true, target: "codex", explicit: false });
  };
  await probe.send();
  ok("file attachment UI: a file-only send carries generic base64 separately and clears after success",
    sentBody && sentBody.text === "" && sentBody.images.length === 0 && sentBody.files.length === 1 &&
      sentBody.files[0].name === "review.diff" && sentBody.files[0].mime === "text/x-diff" &&
      sentBody.files[0].data === diffData && probe.draftAttachmentCount === 0,
    JSON.stringify(sentBody));

  probe.chooseFiles([diffFile]);
  probe.text = "keep the file";
  nextFetch = async () => ({
    ok: false, status: 400, statusText: "Bad Request",
    headers: { get: () => RUNTIME_PROTOCOL }, json: async () => ({ error: "forced file failure" }),
  });
  await probe.send();
  ok("file attachment UI: a failed send preserves the chosen file for retry", probe.draftFileCount === 1);

  probe.clearDrafts();
  probe.text = "";
  probe.chooseFiles([{ name: "too-large.bin", type: "application/octet-stream",
    size: 5 * 1024 * 1024 + 1, data: "eA==" }]);
  ok("file attachment UI: each attachment is capped at 5 MB", probe.draftAttachmentCount === 0);
  probe.chooseFiles(Array.from({ length: 9 }, (_, i) => ({
    name: `tiny-${i}.txt`, type: "text/plain", size: 1, data: "eA==",
  })));
  ok("file attachment UI: images and files share an eight-attachment cap", probe.draftAttachmentCount === 8);

  probe.clearDrafts();
  probe.chooseFiles([
    { name: "five.bin", type: "application/octet-stream", size: 5 * 1024 * 1024, data: "eA==" },
    { name: "two.png", type: "image/png", size: 2 * 1024 * 1024, data: pngData },
  ]);
  ok("file attachment UI: images and files share the 6 MB aggregate budget",
    probe.draftFileCount === 1 && probe.draftCount === 0 && probe.draftAttachmentCount === 1);

  probe.clearDrafts();
  probe.chooseFiles(Array.from({ length: 5 }, (_, i) => ({
    name: `image-${i}.png`, type: "image/png", size: 1, data: pngData,
  })));
  ok("file attachment UI: choosing files preserves the four-native-image cap",
    probe.draftCount === 4 && probe.draftFileCount === 0);
  probe.clearDrafts();

  probe.chooseFiles([{ name: "extension-only.png", type: "", size: 1, data: pngData }]);
  probe.text = "extension fallback";
  sentBody = null;
  nextFetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return ok200({ ok: true, target: "codex", explicit: false });
  };
  await probe.send();
  ok("file attachment UI: a supported image extension fills in a missing browser MIME",
    sentBody && sentBody.images.length === 1 && sentBody.images[0].mime === "image/png" && sentBody.files.length === 0,
    JSON.stringify(sentBody));

  let attachmentRequest = null;
  nextFetch = async (url, opts) => {
    attachmentRequest = { url, opts };
    return {
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => RUNTIME_PROTOCOL },
      blob: async () => ({ bytes: diffText }),
    };
  };
  const fileBubble = probe.renderAttachments({ meta: { attachments: [{
    id: "file-ref", kind: "file", name: "review.diff", mime: "text/x-diff", size: Buffer.byteLength(diffText),
  }] } });
  const fileGallery = fileBubble.children[0];
  const fileCard = fileGallery && fileGallery.children[0];
  await fileCard.onclick();
  const download = sandbox.document.body.children.at(-1);
  ok("file attachment UI: transcript file cards download through the authenticated attachment endpoint",
    fileCard && fileCard.className.includes("attachment-file") && attachmentRequest &&
      attachmentRequest.url.includes("/api/attachment?room=default&id=file-ref") &&
      attachmentRequest.opts.headers["X-Parley-Token"] === "smoke-token-0123456789abcdef" &&
      download && download.download === "review.diff" && download.clicked === 1,
    JSON.stringify({ className: fileCard && fileCard.className, request: attachmentRequest && attachmentRequest.url }));

  const imageBubble = probe.renderAttachments({ meta: { attachments: [{
    id: "image-ref", kind: "image", name: "clipboard.png", mime: "image/png", size: 1,
  }] } });
  const imageCard = imageBubble.children[0] && imageBubble.children[0].children[0];
  ok("file attachment UI: transcript images keep their existing image-card rendering",
    imageCard && imageCard.className === "attachment" && imageCard.children[0].tagName === "IMG");
}

async function main() {
  console.log(`\nParley smoke test — server at ${base}\n`);

  console.log("api access");
  const page = await fetch(base + "/").then((r) => r.text());
  const markdownSource = (page.match(/const SENT_A[\s\S]*?\r?\n}\r?\n(?=document\.addEventListener)/) || [])[0];
  let renderMarkdown = null;
  try {
    const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    renderMarkdown = markdownSource ? Function("esc", `${markdownSource}; return renderMD;`)(escapeHTML) : null;
  } catch { /* reported below */ }
  const tableHTML = renderMarkdown && renderMarkdown(
    "| Checkpoint | What must be true | If not |\n|:---|:---:|---:|\n| Day 30 | 8 conversations | Change course |",
  );
  ok("markdown pipe tables render responsively with alignment",
    tableHTML && tableHTML.includes('<div class="md-table-wrap"><table>') &&
    tableHTML.includes('<th class="align-left">Checkpoint</th>') &&
    tableHTML.includes('<th class="align-center">What must be true</th>') &&
    tableHTML.includes('<td class="align-right">Change course</td>'));
  const pipeHTML = renderMarkdown && renderMarkdown(
    "| Value | Code |\n|---|---|\n| one \\| two | `a|b` |",
  );
  ok("markdown tables preserve escaped pipes and inline-code pipes",
    pipeHTML && pipeHTML.includes("one | two") && pipeHTML.includes("<code>a|b</code>") &&
    (pipeHTML.match(/<td /g) || []).length === 2);
  const malformedTableHTML = renderMarkdown && renderMarkdown("| A | B |\n|--|---|\n| one | two |");
  const partialTableHTML = renderMarkdown && renderMarkdown("| A | B |");
  ok("malformed and streaming-incomplete tables remain plain text",
    malformedTableHTML && !malformedTableHTML.includes("<table>") &&
    partialTableHTML && !partialTableHTML.includes("<table>"));
  const safeTableHTML = renderMarkdown && renderMarkdown("| Value |\n|---|\n| <img src=x onerror=alert(1)> |");
  ok("markdown table cells remain HTML-escaped",
    safeTableHTML && safeTableHTML.includes("&lt;img src=x onerror=alert(1)&gt;") && !safeTableHTML.includes("<img"));
  // Agents write numbered steps with a blank line between them; closing the
  // list on that blank line restarted every item at "1.".
  const listHTML = renderMarkdown && renderMarkdown(
    "1. **Adopt.** Say the word.\n\n1. **Buy the domain.**\n   DNS takes a day.\n\n1. **Deploy from main.**",
  );
  ok("blank-line-separated numbered items stay one list and keep counting",
    listHTML && (listHTML.match(/<ol/g) || []).length === 1 &&
    (listHTML.match(/<li>/g) || []).length === 3 &&
    listHTML.includes("DNS takes a day") &&
    renderMarkdown("3. three\n4. four").startsWith('<ol start="3">') &&
    renderMarkdown("- a\n- b\n\nA new paragraph.").endsWith("<p>A new paragraph.</p>"));
  const pairLabelSource = (page.match(/function pairRoundsLabel\(rounds\) \{[\s\S]*?\n\}/) || [])[0];
  let pairLabel = null;
  try { pairLabel = pairLabelSource ? Function(`${pairLabelSource}; return pairRoundsLabel;`)() : null; } catch { /* reported below */ }
  ok("pair banner renders zero rounds as until approved",
    typeof pairLabel === "function" && pairLabel(0) === "until approved" &&
    pairLabel(1) === "up to 1 round per message" && page.includes("pairRoundsLabel(pair.rounds)"));
  ok("model and effort controls reopen the complete suggestion list",
    !page.includes("<datalist id=") && page.includes('class="freecombo-toggle"') &&
    page.includes('setFreeComboOpen(combo, opening, "")'));
  ok("Claude Full access is a warned structured setting",
    page.includes('<option value="bypassPermissions">full access') &&
    page.includes("Give Claude Full access in this room?") &&
    page.includes("Full access includes protected paths such as .git"));
  const stopChoiceSource = (page.match(/const stopIsChoice = [\s\S]*?;\r?\n/) || [])[0];
  let stopChoice = null;
  try { stopChoice = stopChoiceSource ? Function(`${stopChoiceSource}; return stopIsChoice;`)() : null; }
  catch { /* reported below */ }
  // `working` covers ordinary exchanges too, so the remaining half of @both
  // still opens a per-seat chooser; `workingPair` is only wording.
  ok("Stop treats a pair cycle and an ordinary exchange differently",
    typeof stopChoice === "function" &&
    stopChoice({ busy: ["claude"], queued: 0, working: true, workingPair: null }) === true &&
    stopChoice({ busy: [], queued: 0, working: false, workingPair: null }) === false &&
    page.includes('summary.workingPair ? "Stop the pair cycle" : "Stop the exchange"') &&
    !/const choose = active\.length > 1 \|\| state\.summary\.queued > 0/.test(page));
  // The jump is useless precisely when the target sits in collapsed
  // scrollback, so expanding has to come before the lookup, not after it.
  ok("the quote jump expands collapsed history before it looks for its target",
    /function jumpToEntry\(n\) \{\s*\n\s*expandHistory\(\);[\s\S]{0,200}?querySelector/.test(page));
  // Thresholds are ratios of the target, so a reply several viewports tall can
  // never cross 0.5 — the decision has to come from the rects.
  ok("the composer strip measures visibility instead of trusting a ratio",
    page.includes("function measureLiveVisibility()") &&
    page.includes("Math.min(r.height, root.height) * 0.5") &&
    page.includes("if (shown <= 0) state.liveVisible[agent] = false") &&
    !page.includes("intersectionRatio"));
  ok("…and re-measures on scroll, not only when a threshold is crossed",
    page.includes('chatWrap.addEventListener("scroll", scheduleVisibility)') &&
    page.includes("requestAnimationFrame(run)"));
  ok("the strip is capped at two rows plus an overflow row",
    page.includes("const STRIP_ROW_CAP = 2") && page.includes("rows.slice(0, STRIP_ROW_CAP)") &&
    page.includes("+${rest} more"));
  ok("the strip only stands in while the live bubble is off-screen",
    page.includes("info.filter((b) => state.liveVisible[b.agent] === false)"));
  ok("both surfaces render the same provenance rather than duplicating state",
    page.includes("function quoteRefHTML(src)") && page.includes("busyInfoFor(agent)") &&
    page.includes("entryQuoteHTML(e)"));
  // Agreed explicitly: a finished reply keeps the reference in scrollback.
  ok("a finished reply keeps its quote unconditionally",
    !page.includes("answersPrecedingEntry"));
  ok("queue labels count messages while the lanes count deliveries",
    page.includes("summary.queuedDispatches === undefined") &&
    page.includes("${queuedMessages} queued message"));
  ok("a queue card claims only the run its own dispatch owns",
    page.includes("b.queueGroupId === g.groupId"));
  // A later high-water receipt spans a withdrawn entry, so the withheld check
  // has to come before receipts, cursor and busy — not after them.
  ok("a withheld message is drawn as withheld, ahead of every other signal",
    /function computeHeard\(a, e\) \{\s+if \(withheldFrom\(a, e\.n\)\)/.test(page) &&
    page.includes("cancelledDeliveries") && page.includes("hdot.withheld"));
  ok("the live status path keeps a run attached to its dispatch",
    page.includes("queueGroupId: msg.queueGroupId || null"));
  ok("a queue change refreshes the Stop menu that offers to cancel it",
    /function setQueue\([\s\S]*?updateBusyUI\(\);\s*\}/.test(page));
  ok("an active Stop pins the runs that were on screen",
    page.includes('scope === "active"') && page.includes("{ agent: b.agent, runId: b.runId }") &&
    page.includes("...(pinned ? { runs: pinned } : {})"));
  ok("Stop offers each scope explicitly instead of guessing",
    ['data-stop-scope="seat"', 'data-stop-scope="active"',
      'data-stop-scope="queue"', 'data-stop-scope="all"'].every((s) => page.includes(s)) &&
    page.includes("keeps queued work") && page.includes("keeps active responses"));
  ok("a Stop click names the run it meant, and a stale one is silent",
    page.includes("info && info.runId ? { runId: info.runId }") &&
    page.includes("if (r && r.stale) return;"));
  ok("queue cards group by dispatch, not by source message",
    page.includes("item.queueGroupId || `seq:${item.seq}`") &&
    page.includes("data-cancel-group") && page.includes("Cancel all queued"));
  ok("folder picker UI names the taskbar fallback that now exists",
    page.includes("Parley — Choose a project folder") &&
    page.includes("from the taskbar"));
  // A folder dialog outlives the form or room it was opened from.
  ok("both folder pickers drop a result that arrives after they were retired",
    page.includes("pick !== newRoomPick") &&
    page.includes("pick !== settingsPick || state.room !== openedFor"));
  ok("the page blocks controls when an older backend is still running",
    page.includes(`meta name="parley-runtime-protocol" content="${RUNTIME_PROTOCOL}"`) &&
    page.includes("PAGE_RUNTIME_PROTOCOL") && page.includes("Restart Parley"));
  TOKEN = (/name="parley-token" content="([^"]+)"/.exec(page) || [])[1] || "";
  ok("the page carries a session token", TOKEN.length > 20);
  const runtimeResponse = await fetch(base + "/api/rooms", {
    headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("the API identifies its runtime protocol",
    runtimeResponse.headers.get("x-parley-runtime-protocol") === RUNTIME_PROTOCOL);
  const noProtocol = await fetch(base + "/api/rooms", { headers: { "X-Parley-Token": TOKEN } });
  ok("the API refuses an older UI without its runtime protocol", noProtocol.status === 403);
  const staleEvents = await fetch(`${base}/api/events?room=default&token=${encodeURIComponent(TOKEN)}`);
  ok("the event stream refuses an older UI without its runtime protocol", staleEvents.status === 403);
  const staleMutation = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Parley-Token": TOKEN },
    body: JSON.stringify({ room: "default", config: { mode: "work" } }),
  });
  const afterStaleMutation = await api("GET", "/api/room?name=default");
  ok("a stale UI is rejected before its mutation can run",
    staleMutation.status === 403 && afterStaleMutation.data.room.cfg.mode === "talk");
  const noToken = await fetch(base + "/api/rooms", {
    headers: { "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("the API refuses calls without it", noToken.status === 403);
  const queryOnly = await fetch(`${base}/api/rooms?token=${encodeURIComponent(TOKEN)}`, {
    headers: { "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("query-string tokens are reserved for the event stream", queryOnly.status === 403);
  const transcriptQueryOnly = await fetch(`${base}/api/transcript?room=default&token=${encodeURIComponent(TOKEN)}`, {
    headers: { "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("transcript downloads reject query-only authentication", transcriptQueryOnly.status === 403);
  const serverUrl = new URL(base);
  const postWithOrigin = (origin, host = serverUrl.host) => rawStatus("/api/config", {
    method: "POST", host, origin, body: { room: "default", config: {} },
  });
  ok("…and state changes from a foreign origin", (await postWithOrigin("https://evil.example")) === 403);
  ok("…including the right host over the wrong scheme",
    (await postWithOrigin(`https://127.0.0.1:${serverUrl.port}`)) === 403);
  ok("…including the right host on the wrong port",
    (await postWithOrigin(`http://127.0.0.1:${Number(serverUrl.port) + 1}`)) === 403);
  ok("the exact loopback origin is accepted", (await postWithOrigin(base)) === 200);
  ok("the exact localhost alias is accepted",
    (await postWithOrigin(`http://localhost:${serverUrl.port}`, `localhost:${serverUrl.port}`)) === 200);
  ok("either whitelisted Origin is accepted with either loopback Host",
    (await postWithOrigin(`http://localhost:${serverUrl.port}`)) === 200);
  const foreignHost = `evil.example:${serverUrl.port}`;
  ok("API requests with a foreign Host are refused",
    (await rawStatus("/api/rooms", { host: foreignHost })) === 403);
  ok("the public page also refuses a foreign Host",
    (await rawStatus("/", { host: foreignHost, token: null })) === 403);
  ok("…while the page's own calls work", (await api("GET", "/api/rooms")).status === 200);

  await checkMissingOpener();
  await checkUiSnapshot();
  await checkWindowsCommandPrecedence();
  await checkSynchronousSpawnFailure();
  checkFolderPickerSource();
  // Some restricted runners deny terminating the deliberately hung fake
  // native picker. CI and normal `npm test` keep this on; the opt-out lets such
  // a runner execute the rest of the suite without orphaning its fixture.
  if (process.env.PARLEY_SKIP_NATIVE_PICKER !== "1") await checkFolderPicker();
  await checkFolderPickerUi();

  console.log("routing & the delta protocol");
  await useFakes("default");
  const routedMango = await say("default", "@claude SAY:MANGO", "both");
  ok("the message response reports the server-resolved inline target",
    routedMango.status === 200 && routedMango.data.target === "claude" && routedMango.data.explicit === true,
    JSON.stringify(routedMango.data));
  let d = await idle("default");
  ok("addressed agent replies", lastAgent(d, "claude") && lastAgent(d, "claude").text === "MANGO",
    lastAgent(d, "claude") && lastAgent(d, "claude").text);
  ok("user entry records the target", d.entries.some((e) => e.kind === "user" && e.target === "claude"));

  await say("default", "@codex RECALL");
  d = await idle("default");
  ok("other agent receives the delta", (lastAgent(d, "codex") || {}).text?.includes("MANGO"),
    (lastAgent(d, "codex") || {}).text);

  await say("default", "SAY:PLUM"); // bare message → last addressed (codex)
  d = await idle("default");
  ok("bare message follows last-addressed", lastAgent(d).author === "codex" && lastAgent(d).text === "PLUM");

  await say("default", "hey @claude mid-message tag, SAY:KIWI");
  d = await idle("default");
  ok("mid-message @tag routes", lastAgent(d).author === "claude" && lastAgent(d).text === "KIWI");

  await say("default", "@codex SAY:FIG");
  await idle("default");
  await say("default", "claude, SAY:PEAR");
  d = await idle("default");
  ok("a plain leading model name does not route", lastAgent(d).author === "codex" && lastAgent(d).text === "PEAR");

  const beforeDualTag = d.entries.length;
  await say("default", "@claude compare with @codex SAY:DUO");
  d = await idle("default");
  const dualTagReplies = d.entries.slice(beforeDualTag).filter((e) => e.kind === "agent" && e.text === "DUO");
  ok("tagging both model names routes to both", dualTagReplies.length === 2 &&
    ["claude", "codex"].every((a) => dualTagReplies.some((e) => e.author === a)));
  ok("the dual-tag user entry records both", d.entries.slice(beforeDualTag).some((e) => e.kind === "user" && e.target === "both"));

  ok("receipts recorded", (d.receipts || []).length > 0 && d.receipts.every((r) => r.upTo > r.from));

  console.log("\nclipboard image attachments");
  await api("POST", "/api/rooms", { name: "images" });
  await useFakes("images");
  await cfg("images", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const pngBytes = Buffer.from(pngBase64, "base64");
  const pngHash = crypto.createHash("sha256").update(pngBytes).digest("hex");
  const attached = await api("POST", "/api/message", {
    room: "images", text: "@both IMAGEINFO", target: "auto",
    images: [{ name: "..\\clipboard.png", mime: "image/png", data: pngBase64 }],
  });
  ok("image API: a valid image message is accepted", attached.status === 200, JSON.stringify(attached.data));
  let imagesRoom = await idle("images", 30000);
  const imageReplies = imagesRoom.entries.filter((e) => e.kind === "agent" && e.text.startsWith("IMAGEJSON "));
  const parsedImages = imageReplies.map((e) => {
    try { return { author: e.author, images: JSON.parse(e.text.slice("IMAGEJSON ".length)) }; }
    catch { return { author: e.author, images: [] }; }
  });
  ok("image delivery: both native CLIs receive the same bytes",
    parsedImages.length === 2 && parsedImages.every((reply) =>
      reply.images.length === 1 && reply.images[0].size === pngBytes.length && reply.images[0].sha256 === pngHash),
    JSON.stringify(parsedImages));
  ok("image delivery: Claude receives a structured image block and Codex receives --image",
    parsedImages.some((reply) => reply.author === "claude" && reply.images[0].mime === "image/png") &&
    parsedImages.some((reply) => reply.author === "codex" &&
      /parley-codex-input-[^\\/]+[\\/][0-9a-f-]+\.png$/i.test(reply.images[0].path || "")),
    JSON.stringify(parsedImages));
  ok("image delivery: Codex keeps stdin as the prompt instead of consuming '-' as an image",
    parsedImages.some((reply) => reply.author === "codex" && reply.images.length === 1 &&
      reply.images[0].promptOnStdin === true && reply.images[0].path !== "-" && !reply.images[0].swallowedPrompt),
    JSON.stringify(parsedImages));
  const imageEntry = imagesRoom.entries.find((e) => e.kind === "user" && e.text === "@both IMAGEINFO");
  const imageRef = imageEntry && imageEntry.meta && imageEntry.meta.attachments && imageEntry.meta.attachments[0];
  ok("image storage: transcript metadata is safe and does not retain a client path",
    imageRef && imageRef.name === "clipboard.png" && !imageRef.path && !imageRef.data &&
    fs.existsSync(path.join(ROOT, "images", "attachments", `${imageRef.id}.png`)),
    JSON.stringify(imageRef));
  const imageResponse = await fetch(base + `/api/attachment?room=images&id=${encodeURIComponent(imageRef.id)}`, {
    headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  const servedImage = Buffer.from(await imageResponse.arrayBuffer());
  ok("image retrieval: authenticated chat rendering gets exact bytes and MIME",
    imageResponse.status === 200 && imageResponse.headers.get("content-type") === "image/png" &&
    servedImage.equals(pngBytes) && imageResponse.headers.get("x-content-type-options") === "nosniff");
  const imageWithoutToken = await fetch(base + `/api/attachment?room=images&id=${encodeURIComponent(imageRef.id)}`, {
    headers: { "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("image retrieval: attachment bytes require the page token", imageWithoutToken.status === 403);

  const paddedPng = (size) => Buffer.concat([pngBytes, Buffer.alloc(size - pngBytes.length)]);
  const oldLargeBytes = paddedPng(4 * 1024 * 1024);
  const currentLargeBytes = paddedPng(3 * 1024 * 1024);
  const overBudget = await api("POST", "/api/message", {
    room: "images", text: "too many bytes", target: "claude",
    images: [
      { name: "four.png", mime: "image/png", data: oldLargeBytes.toString("base64") },
      { name: "three.png", mime: "image/png", data: currentLargeBytes.toString("base64") },
    ],
  });
  ok("image validation: aggregate bytes stay below Claude's piped-input ceiling",
    overBudget.status === 413 && /6 MB/.test(overBudget.data.error || ""), JSON.stringify(overBudget.data));

  await api("POST", "/api/message", {
    room: "images", text: "@codex SAY:OLDERIMAGE", target: "auto",
    images: [{ name: "older.png", mime: "image/png", data: oldLargeBytes.toString("base64") }],
  });
  await idle("images", 30000);
  const currentLargeHash = crypto.createHash("sha256").update(currentLargeBytes).digest("hex");
  await api("POST", "/api/message", {
    room: "images", text: "@claude IMAGEINFO", target: "auto",
    images: [{ name: "current.png", mime: "image/png", data: currentLargeBytes.toString("base64") }],
  });
  imagesRoom = await idle("images", 30000);
  const budgetReply = [...imagesRoom.entries].reverse().find((e) =>
    e.author === "claude" && e.text.startsWith("IMAGEJSON "));
  const budgetInfo = budgetReply ? JSON.parse(budgetReply.text.slice("IMAGEJSON ".length)) : [];
  ok("image delivery: the current root wins Claude's bounded native-image budget",
    budgetInfo.length === 1 && budgetInfo[0].size === currentLargeBytes.length &&
      budgetInfo[0].sha256 === currentLargeHash,
    JSON.stringify(budgetInfo));

  const beforeBadImage = imagesRoom.entries.length;
  const badImage = await api("POST", "/api/message", {
    room: "images", text: "bad image", target: "claude",
    images: [{ name: "fake.png", mime: "image/png", data: Buffer.from("not a png").toString("base64") }],
  });
  imagesRoom = await room("images");
  ok("image validation: MIME spoofing is rejected without a transcript entry",
    badImage.status === 400 && imagesRoom.entries.length === beforeBadImage,
    JSON.stringify(badImage.data));

  const imageOnly = await api("POST", "/api/message", {
    room: "images", text: "", target: "claude",
    images: [{ name: "only.png", mime: "image/png", data: pngBase64 }],
  });
  imagesRoom = await idle("images", 30000);
  ok("image API: an image can be sent without placeholder text",
    imageOnly.status === 200 && imagesRoom.entries.some((e) =>
      e.kind === "user" && e.text === "" && e.meta && e.meta.attachments && e.meta.attachments.length === 1));

  const retryImage = await api("POST", "/api/message", {
    room: "images", text: "@codex FAILONCE:IMGRETRY IMAGEINFO", target: "auto",
    images: [{ name: "retry.png", mime: "image/png", data: pngBase64 }],
  });
  await idle("images", 30000);
  const retryAccepted = await api("POST", "/api/retry", { room: "images" });
  imagesRoom = await idle("images", 30000);
  const retryImageReply = [...imagesRoom.entries].reverse().find((e) => e.author === "codex" && e.text.startsWith("IMAGEJSON "));
  const retryInfo = retryImageReply ? JSON.parse(retryImageReply.text.slice("IMAGEJSON ".length)) : [];
  const retryRoot = [...imagesRoom.entries].reverse().find((e) =>
    e.kind === "user" && e.text.includes("FAILONCE:IMGRETRY"));
  const retryRef = retryRoot && retryRoot.meta && retryRoot.meta.attachments && retryRoot.meta.attachments[0];
  ok("image Retry: the authoritative user entry reattaches the original image",
    retryImage.status === 200 && retryAccepted.status === 200 && retryRef &&
    retryInfo.some((image) => image.sha256 === pngHash && String(image.path || "").includes(retryRef.id)),
    JSON.stringify({ retry: retryAccepted.data, retryInfo }));

  await api("POST", "/api/rooms", { name: "image-argv" });
  await useFakes("image-argv");
  await cfg("image-argv", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  const imageArgMessage = () => api("POST", "/api/message", {
    room: "image-argv", text: "@codex ARGJSON", target: "auto",
    images: [{ name: "argv.png", mime: "image/png", data: pngBase64 }],
  });
  await imageArgMessage();
  let imageArgRoom = await idle("image-argv", 30000);
  const freshImageArgs = argvFrom(lastAgent(imageArgRoom, "codex"));
  const freshExec = freshImageArgs.indexOf("exec");
  const freshImageFlag = freshImageArgs.lastIndexOf("--image");
  const freshJsonFlag = freshImageArgs.indexOf("--json");
  ok("Codex image argv: fresh exec terminates variadic --image before the stdin prompt",
    freshExec > 0 && freshImageArgs[freshExec + 1] !== "resume" &&
      freshImageArgs[0] === "--add-dir" && freshImageFlag >= 0 &&
      freshImageFlag + 1 < freshJsonFlag && freshImageArgs[freshImageFlag + 1] !== "-" &&
      freshImageArgs.at(-1) === "-",
    JSON.stringify(freshImageArgs));
  await imageArgMessage();
  imageArgRoom = await idle("image-argv", 30000);
  const resumedImageArgs = argvFrom(lastAgent(imageArgRoom, "codex"));
  const resumedExec = resumedImageArgs.indexOf("exec");
  const resumedImageFlag = resumedImageArgs.lastIndexOf("--image");
  const resumedJsonFlag = resumedImageArgs.indexOf("--json");
  ok("Codex image argv: resumed exec keeps the same unambiguous ordering",
    resumedExec > 0 && resumedImageArgs[resumedExec + 1] === "resume" &&
      resumedImageArgs[0] === "--add-dir" && resumedImageFlag >= 0 &&
      resumedImageFlag + 1 < resumedJsonFlag && resumedImageArgs[resumedImageFlag + 1] !== "-" &&
      resumedImageArgs.at(-1) === "-",
    JSON.stringify(resumedImageArgs));

  console.log("\ngeneric file attachments");
  await api("POST", "/api/rooms", { name: "files" });
  await useFakes("files");
  await cfg("files", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  const diffText = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n+ATTACHED_FILE_TOKEN\n";
  const diffBytes = Buffer.from(diffText, "utf8");
  const diffBase64 = diffBytes.toString("base64");
  const diffHash = crypto.createHash("sha256").update(diffBytes).digest("hex");
  const fileMessage = await api("POST", "/api/message", {
    room: "files", text: "@both FILEINFO", target: "auto",
    files: [{ name: "..\\review-α.diff", mime: "text/x-diff", data: diffBase64 }],
  });
  ok("file API: a valid generic attachment is accepted", fileMessage.status === 200,
    JSON.stringify(fileMessage.data));
  let filesRoom = await idle("files", 30000);
  const fileReplies = filesRoom.entries.filter((e) => e.kind === "agent" && e.text.startsWith("FILEJSON "));
  const parsedFiles = fileReplies.map((e) => {
    try { return { author: e.author, files: JSON.parse(e.text.slice("FILEJSON ".length)) }; }
    catch { return { author: e.author, files: [] }; }
  });
  ok("file delivery: both CLIs read identical bytes from isolated staging copies",
    parsedFiles.length === 2 && parsedFiles.every((reply) => reply.files.length === 1 &&
      reply.files[0].size === diffBytes.length && reply.files[0].sha256 === diffHash &&
      !reply.files[0].missing && reply.files[0].addDir === path.dirname(reply.files[0].path)),
    JSON.stringify(parsedFiles));
  ok("file delivery: small text-like files are included directly in the prompt",
    parsedFiles.every((reply) => reply.files[0].inline === true), JSON.stringify(parsedFiles));
  ok("file staging: disposable provider copies are gone after each invocation",
    parsedFiles.every((reply) => !fs.existsSync(reply.files[0].path) &&
      !fs.existsSync(reply.files[0].addDir)), JSON.stringify(parsedFiles));

  const fileEntry = filesRoom.entries.find((e) => e.kind === "user" && e.text === "@both FILEINFO");
  const fileRef = fileEntry && fileEntry.meta && fileEntry.meta.attachments && fileEntry.meta.attachments[0];
  const canonicalFile = fileRef && path.join(ROOT, "files", "attachments", `${fileRef.id}.blob`);
  ok("file storage: only sanitized metadata is retained in the transcript entry",
    fileRef && fileRef.kind === "file" && fileRef.name === "review-α.diff" &&
      fileRef.mime === "text/x-diff" && fileRef.size === diffBytes.length &&
      !fileRef.path && !fileRef.data && canonicalFile && fs.readFileSync(canonicalFile).equals(diffBytes),
    JSON.stringify(fileRef));
  const transcript = fs.readFileSync(path.join(ROOT, "files", "transcript.md"), "utf8");
  ok("file transcript: the durable attachment link is relative",
    transcript.includes(`[Attachment: review-α.diff](attachments/${fileRef.id}.blob)`));

  const fileResponse = await fetch(base + `/api/attachment?room=files&id=${encodeURIComponent(fileRef.id)}`, {
    headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  const servedFile = Buffer.from(await fileResponse.arrayBuffer());
  const disposition = fileResponse.headers.get("content-disposition") || "";
  ok("file retrieval: downloads use exact bytes, an inert MIME, and a safe filename",
    fileResponse.status === 200 && fileResponse.headers.get("content-type") === "application/octet-stream" &&
      servedFile.equals(diffBytes) && fileResponse.headers.get("x-content-type-options") === "nosniff" &&
      disposition.includes("attachment;") && disposition.includes("filename*=UTF-8''review-%CE%B1.diff"),
    JSON.stringify({ status: fileResponse.status, disposition }));
  const fileWithoutToken = await fetch(base + `/api/attachment?room=files&id=${encodeURIComponent(fileRef.id)}`, {
    headers: { "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("file retrieval: generic bytes require the page token", fileWithoutToken.status === 403);

  const beforeBadFile = filesRoom.entries.length;
  const badFile = await api("POST", "/api/message", {
    room: "files", text: "bad file", target: "claude",
    files: [{ name: "bad.txt", mime: "text/plain", data: "not canonical base64" }],
  });
  filesRoom = await room("files");
  ok("file validation: malformed base64 is rejected without a transcript entry",
    badFile.status === 400 && filesRoom.entries.length === beforeBadFile, JSON.stringify(badFile.data));

  const imageInFileField = await api("POST", "/api/message", {
    room: "files", text: "wrong field", target: "claude",
    files: [{ name: "wrong.png", mime: "image/png", data: pngBase64 }],
  });
  ok("file validation: supported images cannot bypass native image validation and limits",
    imageInFileField.status === 400 && /image field/.test(imageInFileField.data.error || ""),
    JSON.stringify(imageInFileField.data));

  const tooManyFiles = await api("POST", "/api/message", {
    room: "files", text: "too many", target: "claude",
    files: Array.from({ length: 9 }, (_, i) => ({
      name: `tiny-${i}.txt`, mime: "text/plain", data: Buffer.from(String(i)).toString("base64"),
    })),
  });
  ok("file validation: images and files share the eight-attachment count cap",
    tooManyFiles.status === 413 && /at most 8/.test(tooManyFiles.data.error || ""),
    JSON.stringify(tooManyFiles.data));

  const mixedBudget = await api("POST", "/api/message", {
    room: "files", text: "mixed budget", target: "claude",
    images: [{ name: "four.png", mime: "image/png", data: oldLargeBytes.toString("base64") }],
    files: [{ name: "three.bin", mime: "application/octet-stream", data: currentLargeBytes.toString("base64") }],
  });
  ok("file validation: images and files share the 6 MB byte cap",
    mixedBudget.status === 413 && /6 MB/.test(mixedBudget.data.error || ""),
    JSON.stringify(mixedBudget.data));

  const fileOnly = await api("POST", "/api/message", {
    room: "files", text: "", target: "claude",
    files: [{ name: "only.txt", mime: "text/plain", data: Buffer.from("only file").toString("base64") }],
  });
  filesRoom = await idle("files", 30000);
  ok("file API: a generic file can be sent without placeholder text",
    fileOnly.status === 200 && filesRoom.entries.some((e) => e.kind === "user" && e.text === "" &&
      e.meta && e.meta.attachments && e.meta.attachments.some((ref) => ref.kind === "file")));

  const retryFile = await api("POST", "/api/message", {
    room: "files", text: "@codex FAILONCE:FILERETRY FILEINFO", target: "auto",
    files: [{ name: "retry.diff", mime: "text/x-diff", data: diffBase64 }],
  });
  await idle("files", 30000);
  const retryFileAccepted = await api("POST", "/api/retry", { room: "files" });
  filesRoom = await idle("files", 30000);
  const retryFileReply = [...filesRoom.entries].reverse().find((e) =>
    e.author === "codex" && e.text.startsWith("FILEJSON "));
  const retryFileInfo = retryFileReply ? JSON.parse(retryFileReply.text.slice("FILEJSON ".length)) : [];
  const retryFileRoot = [...filesRoom.entries].reverse().find((e) =>
    e.kind === "user" && e.text.includes("FAILONCE:FILERETRY"));
  const retryFileRef = retryFileRoot && retryFileRoot.meta && retryFileRoot.meta.attachments &&
    retryFileRoot.meta.attachments[0];
  ok("file Retry: the authoritative user entry restages the original bytes",
    retryFile.status === 200 && retryFileAccepted.status === 200 && retryFileRef &&
      retryFileInfo.some((file) => file.sha256 === diffHash && String(file.path || "").includes(retryFileRef.id) &&
        !fs.existsSync(file.path)),
    JSON.stringify({ retry: retryFileAccepted.data, retryFileInfo }));

  await api("POST", "/api/rooms", { name: "file-argv" });
  await useFakes("file-argv");
  await cfg("file-argv", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  const fileArgMessage = () => api("POST", "/api/message", {
    room: "file-argv", text: "@codex ARGJSON", target: "auto",
    files: [{ name: "argv.diff", mime: "text/x-diff", data: diffBase64 }],
  });
  await fileArgMessage();
  let fileArgRoom = await idle("file-argv", 30000);
  const freshFileArgs = argvFrom(lastAgent(fileArgRoom, "codex"));
  const freshFileExec = freshFileArgs.indexOf("exec");
  const freshInputDir = argValue(freshFileArgs, "--add-dir");
  ok("Codex file argv: fresh exec grants only the disposable staging directory",
    freshFileArgs[0] === "--add-dir" && freshFileExec === 2 &&
      freshFileArgs[freshFileExec + 1] !== "resume" && freshInputDir && !fs.existsSync(freshInputDir),
    JSON.stringify(freshFileArgs));
  await fileArgMessage();
  fileArgRoom = await idle("file-argv", 30000);
  const resumedFileArgs = argvFrom(lastAgent(fileArgRoom, "codex"));
  const resumedFileExec = resumedFileArgs.indexOf("exec");
  const resumedInputDir = argValue(resumedFileArgs, "--add-dir");
  ok("Codex file argv: resume keeps --add-dir in the required global position",
    resumedFileArgs[0] === "--add-dir" && resumedFileExec === 2 &&
      resumedFileArgs[resumedFileExec + 1] === "resume" && resumedInputDir &&
      !fs.existsSync(resumedInputDir), JSON.stringify(resumedFileArgs));
  await api("POST", "/api/message", {
    room: "file-argv", text: "@claude ARGJSON", target: "auto",
    files: [{ name: "claude-argv.diff", mime: "text/x-diff", data: diffBase64 }],
  });
  fileArgRoom = await idle("file-argv", 30000);
  const claudeFileArgs = argvFrom(lastAgent(fileArgRoom, "claude"));
  const claudeInputDir = argValue(claudeFileArgs, "--add-dir");
  ok("Claude file argv: variadic --add-dir is terminated by a known option",
    claudeFileArgs[0] === "-p" && claudeFileArgs[1] === "--add-dir" && claudeFileArgs[2] === claudeInputDir &&
      claudeFileArgs[3] === "--output-format" && claudeInputDir && !fs.existsSync(claudeInputDir),
    JSON.stringify(claudeFileArgs));

  console.log("\nsessions & per-seat flags");
  await say("default", "@claude ARGS");
  d = await idle("default");
  const argsReply = lastAgent(d, "claude").text;
  ok("session is resumed on later turns", /--resume fake-session-/.test(argsReply), argsReply.slice(0, 90));
  await cfg("default", { agents: { claude: { effort: "high" } } });
  await say("default", "@claude ARGS");
  d = await idle("default");
  ok("effort flag reaches the CLI", /--effort high/.test(lastAgent(d, "claude").text));
  await cfg("default", { agents: { claude: { effort: null } } });
  d = await room("default");
  ok("null clears a config field", d.room.cfg.agents.claude.effort === null);

  console.log("\nselective native-session recovery");
  for (const agent of ["claude", "codex"]) {
    const name = `resume-${agent}`;
    await api("POST", "/api/rooms", { name });
    await useFakes(name);
    await say(name, `@${agent} SAY:PRIMED`);
    d = await idle(name);
    const sessionBefore = JSON.parse(fs.readFileSync(path.join(ROOT, name, "state.json"), "utf8"))
      .agents[agent].sessionRef;
    const beforeGeneric = d.entries.length;
    await say(name, `@${agent} RESUMEERROR`);
    d = await idle(name);
    const generic = d.entries.slice(beforeGeneric);
    ok(`${agent}: a generic resumed failure is not retried fresh`,
      generic.some((e) => e.kind === "system" && e.meta && e.meta.error) &&
      !generic.some((e) => e.kind === "agent" && e.text === "UNSAFE_FRESH_RETRY"),
      JSON.stringify(generic.map((e) => ({ kind: e.kind, text: e.text }))));
    const sessionAfterGeneric = JSON.parse(fs.readFileSync(path.join(ROOT, name, "state.json"), "utf8"))
      .agents[agent].sessionRef;
    ok(`${agent}: a generic resumed failure preserves the native session`,
      !!sessionBefore && sessionAfterGeneric === sessionBefore,
      JSON.stringify({ before: sessionBefore, after: sessionAfterGeneric }));

    const beforeMissing = d.entries.length;
    await say(name, `@${agent} MISSINGSESSION`);
    d = await idle(name);
    const recovered = d.entries.slice(beforeMissing);
    const sessionAfterRecovery = JSON.parse(fs.readFileSync(path.join(ROOT, name, "state.json"), "utf8"))
      .agents[agent].sessionRef;
    ok(`${agent}: a recognizable missing session recovers fresh`,
      recovered.some((e) => e.kind === "agent" && e.author === agent && e.text === "SESSION_RECOVERED") &&
      !recovered.some((e) => e.kind === "system" && e.meta && e.meta.error) &&
      !!sessionAfterRecovery && sessionAfterRecovery !== sessionAfterGeneric,
      JSON.stringify(recovered.map((e) => ({ kind: e.kind, text: e.text }))));
  }

  console.log("\nlurk, right of reply & hops");
  await api("POST", "/api/rooms", { name: "lurkroom" });
  await useFakes("lurkroom");
  await cfg("lurkroom", { agents: { codex: { lurk: true } } });
  await say("lurkroom", "@claude SAY:QUIET");
  d = await idle("lurkroom");
  ok("silent lurker adds no entry", !d.entries.some((e) => e.author === "codex" && e.kind === "agent"));
  ok("lurker still advances its cursor", d.receipts.some((r) => r.agent === "codex" && r.mode === "lurk" && r.spoke === false));

  await say("lurkroom", "@claude SAY:CHIME");
  d = await idle("lurkroom");
  const chime = d.entries.find((e) => e.author === "codex" && e.meta && e.meta.lurk);
  ok("lurker chimes in when it has something", !!chime, chime && chime.text);
  ok("chime earns a free right of reply", d.entries.some((e) => e.author === "claude" && e.meta && e.meta.hop));

  await api("POST", "/api/rooms", { name: "hoproom" });
  await useFakes("hoproom");
  let beforeHop = (await room("hoproom")).entries.length;
  await say("hoproom", "@claude TAG:codex");
  d = await idle("hoproom");
  ok("an explicit agent @call responds without lurk mode",
    d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.meta && e.meta.hop));

  beforeHop = d.entries.length;
  await say("hoproom", "@claude SELFTAG:codex");
  d = await idle("hoproom");
  ok("a self-tag before the other agent's tag does not swallow the handoff",
    d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.meta && e.meta.hop));

  beforeHop = d.entries.length;
  await say("hoproom", "@claude CALL:codex");
  d = await idle("hoproom");
  ok("a soft plain-name call stays quiet when neither lurk nor @both applies",
    !d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.kind === "agent"));

  await cfg("hoproom", { agents: { codex: { lurk: true } } });
  beforeHop = d.entries.length;
  await say("hoproom", "@claude CALL:codex");
  d = await idle("hoproom");
  ok("a lurking agent responds to a soft plain-name call",
    d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.meta && e.meta.hop));

  beforeHop = d.entries.length;
  await say("hoproom", "@claude PROSE:codex");
  d = await idle("hoproom");
  ok("an ordinary prose mention does not call a lurking agent",
    !d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.kind === "agent"));

  await cfg("hoproom", { agents: { codex: { lurk: false } } });
  beforeHop = d.entries.length;
  await say("hoproom", "@both CALL:codex");
  d = await idle("hoproom");
  ok("a soft direct call responds inside an @both exchange without lurk",
    d.entries.slice(beforeHop).some((e) => e.author === "codex" && e.meta && e.meta.hop));

  beforeHop = d.entries.length;
  await say("hoproom", "@both ORDERSTART");
  d = await idle("hoproom");
  const orderedExchange = d.entries.slice(beforeHop);
  const orderedInitial = orderedExchange.filter((e) => e.kind === "agent" && !(e.meta && e.meta.hop));
  const orderedHops = orderedExchange.filter((e) => e.kind === "agent" && e.meta && e.meta.hop);
  ok("@both cross-calls follow the replies' visible completion order",
    orderedInitial[0] && orderedInitial[0].author === "codex" &&
    orderedHops[0] && orderedHops[0].author === "claude", JSON.stringify(orderedExchange.map((e) => ({ author: e.author, text: e.text }))));

  await api("POST", "/api/rooms", { name: "busyhop" });
  await useFakes("busyhop");
  await say("busyhop", "@codex SLEEP:1200 SAY:OCCUPIED");
  await say("busyhop", "@claude TAG:codex");
  const waitedHop = await waitRoom("busyhop", (x) =>
    x.entries.some((e) => e.author === "codex" && e.meta && e.meta.hop), "busy target to receive the handoff", 10000);
  ok("an explicit call waits for a busy target instead of being dropped",
    waitedHop.entries.some((e) => e.author === "codex" && e.meta && e.meta.hop));

  beforeHop = d.entries.length;
  await say("hoproom", "@claude PINGPONG");
  d = await idle("hoproom");
  const unlimitedHopEntries = d.entries.slice(beforeHop);
  ok("zero hop limit continues until the emergency ceiling",
    unlimitedHopEntries.filter((e) => e.kind === "agent" && e.meta && e.meta.hop).length === 4);
  ok("an unlimited ping-pong announces its safety stop",
    unlimitedHopEntries.some((e) => e.kind === "system" && /Agent-hop safety stop after 4/i.test(e.text)));

  await cfg("hoproom", { maxHops: 1 });
  beforeHop = d.entries.length;
  await say("hoproom", "@claude PINGPONG");
  d = await idle("hoproom");
  const limitedHopEntries = d.entries.slice(beforeHop);
  ok("a positive hop limit caps the exchange",
    limitedHopEntries.filter((e) => e.kind === "agent" && e.meta && e.meta.hop).length === 1 &&
    limitedHopEntries.some((e) => e.kind === "system" && /Agent-hop budget reached \(1\)/i.test(e.text)));

  // @both used to queue whole whenever either seat was busy, so one slow agent
  // silenced the other. Delivery is now per seat: the free one answers now.
  console.log("\nsplit @both delivery");
  await api("POST", "/api/rooms", { name: "splitboth" });
  await useFakes("splitboth");
  await cfg("splitboth", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitboth", "@codex SLEEP:2500 SAY:SLOWFIRST");
  await waitRoom("splitboth", (x) => x.room.busy.includes("codex"), "codex to start");
  const split = await say("splitboth", "@both SAY:SPLIT");
  ok("a message to both seats is accepted while one is busy",
    split.status === 200 && split.data.ok === true && !split.data.queued,
    JSON.stringify(split.data));
  ok("the busy seat is reported as a deferred delivery",
    Array.isArray(split.data.deferred) && split.data.deferred.join() === "codex",
    JSON.stringify(split.data));
  const early = await waitRoom("splitboth", (x) =>
    x.entries.some((e) => e.author === "claude" && e.text === "SPLIT"), "the free seat to answer first");
  ok("the free seat answers without waiting for the busy one",
    !early.entries.some((e) => e.author === "codex" && e.text === "SPLIT"));
  d = await idle("splitboth", 40000);
  const splitUser = d.entries.filter((e) => e.kind === "user" && e.text === "@both SAY:SPLIT");
  ok("the user's message is recorded exactly once", splitUser.length === 1, String(splitUser.length));
  ok("the one entry still addresses both seats",
    splitUser[0] && splitUser[0].target === "both" &&
    splitUser[0].meta.audience.addressed.join() === "claude,codex",
    JSON.stringify(splitUser[0] && splitUser[0].meta));
  const late = d.entries.find((e) => e.author === "codex" && e.text === "SPLIT");
  ok("the busy seat is delivered to once it frees", !!late);
  ok("a late reply is badged as deferred rather than duplicated",
    !!late && late.meta.deferred === true &&
    d.entries.filter((e) => e.author === "codex" && e.text === "SPLIT").length === 1,
    JSON.stringify(late && late.meta));
  ok("the deferred seat finished after its earlier work",
    !!late && d.entries.findIndex((e) => e.text === "SLOWFIRST") < d.entries.indexOf(late));

  // Splitting must not reorder anything. A seat with a message already queued
  // still answers that message first; splitting only changes *when* each seat
  // is reached, never the order it is reached in.
  await api("POST", "/api/rooms", { name: "splitfifo" });
  await useFakes("splitfifo");
  await cfg("splitfifo", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitfifo", "@codex SLEEP:2500 SAY:FIFOBUSY");
  await waitRoom("splitfifo", (x) => x.room.busy.includes("codex"), "codex to start");
  const aheadOfSplit = await say("splitfifo", "@codex SAY:FIFOQUEUED");
  ok("a direct message to a busy seat is held for that lane",
    aheadOfSplit.status === 200 && (aheadOfSplit.data.deferred || []).join() === "codex",
    JSON.stringify(aheadOfSplit.data));
  const splitPastQueue = await say("splitfifo", "@both SAY:FIFOSPLIT");
  ok("@both still splits when the busy seat has a message queued ahead of it",
    splitPastQueue.status === 200 && !splitPastQueue.data.queued &&
    (splitPastQueue.data.deferred || []).join() === "codex",
    JSON.stringify(splitPastQueue.data));
  await waitRoom("splitfifo", (x) => x.entries.some((e) => e.author === "claude" && e.text === "FIFOSPLIT"),
    "the free seat to answer past the queue");
  d = await idle("splitfifo", 40000);
  const codexLane = d.entries.filter((e) => e.author === "codex" && e.kind === "agent").map((e) => e.text);
  ok("the busy seat answers in the order the user sent, split half last",
    codexLane.join() === "FIFOBUSY,FIFOQUEUED,FIFOSPLIT", JSON.stringify(codexLane));

  // Every accepted turn is appended and snapshotted where the user sent it. A
  // message held as raw text and appended on dispatch would land *after* later
  // messages, and would take the retry slot with it when it did.
  await api("POST", "/api/rooms", { name: "splitorder" });
  await useFakes("splitorder");
  await cfg("splitorder", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitorder", "@codex SLEEP:2500 SAY:ORDERBUSY");
  await waitRoom("splitorder", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("splitorder", "@codex SAY:ORDEREARLY");   // held for codex
  await say("splitorder", "@both SAY:ORDERLATE");     // claude answers now
  const ordered = await room("splitorder");
  const userOrder = texts(ordered, "user");
  // A leading single-seat tag is stripped from the stored text; @both is not.
  ok("a held message keeps its place in the transcript",
    userOrder.join("|") === "SLEEP:2500 SAY:ORDERBUSY|SAY:ORDEREARLY|@both SAY:ORDERLATE",
    JSON.stringify(userOrder));
  ok("the last thing the user sent owns the retry slot",
    ordered.room.lastAddressed === "both", ordered.room.lastAddressed);
  d = await idle("splitorder", 40000);
  ok("every held message was answered",
    ["ORDERBUSY", "ORDEREARLY", "ORDERLATE"].every((t) => texts(d).includes(t)), JSON.stringify(texts(d)));

  // A @both sent while *both* seats are busy still splits: each seat answers as
  // it frees, rather than the pair of them waiting for the slower one.
  await api("POST", "/api/rooms", { name: "splitbothbusy" });
  await useFakes("splitbothbusy");
  await cfg("splitbothbusy", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitbothbusy", "@claude SLEEP:1200 SAY:FASTSEAT");
  await say("splitbothbusy", "@codex SLEEP:3500 SAY:SLOWSEAT");
  await waitRoom("splitbothbusy", (x) => x.room.busy.length === 2, "both seats to start");
  const bothBusy = await say("splitbothbusy", "@both SAY:BOTHBUSY");
  ok("a @both sent while both seats are busy is still accepted, not queued whole",
    bothBusy.status === 200 && !bothBusy.data.queued &&
    (bothBusy.data.deferred || []).slice().sort().join() === "claude,codex",
    JSON.stringify(bothBusy.data));
  const firstFree = await waitRoom("splitbothbusy", (x) =>
    x.entries.some((e) => e.author === "claude" && e.text === "BOTHBUSY"),
    "the first seat to free to answer", 20000);
  ok("the seat that frees first answers without waiting for the other",
    !firstFree.entries.some((e) => e.author === "codex" && e.text === "BOTHBUSY"));
  d = await idle("splitbothbusy", 40000);
  ok("the slower seat still gets the same message, once",
    d.entries.filter((e) => e.author === "codex" && e.text === "BOTHBUSY").length === 1 &&
    d.entries.filter((e) => e.kind === "user" && e.text === "@both SAY:BOTHBUSY").length === 1);

  // Accepted user work outranks agent-to-agent follow-ups. A hop that finds the
  // seat free must still wait for anything the user has queued for it.
  await api("POST", "/api/rooms", { name: "lanepriority" });
  await useFakes("lanepriority");
  await cfg("lanepriority", { maxHops: 4, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("lanepriority", "@codex SLEEP:2000 SAY:LANEBUSY");
  await waitRoom("lanepriority", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("lanepriority", "@codex SAY:USERFIRST");          // queued behind it
  await say("lanepriority", "@claude TAG:codex");             // free seat, hops at codex
  // A waiting hop leaves the room briefly idle between polls, so wait for the
  // hop itself to land rather than for quiet.
  await waitRoom("lanepriority", (x) =>
    x.entries.some((e) => e.author === "codex" && e.meta && e.meta.hop), "the delayed hop to land", 20000);
  d = await idle("lanepriority", 40000);
  const priorityLane = d.entries.filter((e) => e.author === "codex" && e.kind === "agent");
  const userItem = priorityLane.findIndex((e) => e.text === "USERFIRST");
  const hopItem = priorityLane.findIndex((e) => e.meta && e.meta.hop);
  ok("a hop cannot overtake a message the user already queued for that seat",
    userItem >= 0 && hopItem >= 0 && userItem < hopItem,
    JSON.stringify(priorityLane.map((e) => ({ text: e.text, hop: !!(e.meta && e.meta.hop) }))));

  // The deferred seat reads the early seat's reply in its own delta and answers
  // it there. Replaying that same reply as a hop would be one agent answering
  // one message twice.
  await api("POST", "/api/rooms", { name: "splitdup" });
  await useFakes("splitdup");
  await cfg("splitdup", { maxHops: 4, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitdup", "@codex SLEEP:2500 SAY:DUPBUSY");
  await waitRoom("splitdup", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("splitdup", "@both TAG:codex");
  d = await idle("splitdup", 40000);
  const dupLane = d.entries.filter((e) => e.author === "codex" && e.kind === "agent" && e.text !== "DUPBUSY");
  ok("a tag the deferred seat already read in its delta is not replayed as a hop",
    dupLane.length === 1 && !!(dupLane[0].meta && dupLane[0].meta.deferred) &&
    !dupLane.some((e) => e.meta && e.meta.hop),
    JSON.stringify(dupLane.map((e) => ({ text: e.text, hop: !!(e.meta && e.meta.hop), deferred: !!(e.meta && e.meta.deferred) }))));

  // …but suppression is scoped to what that seat actually saw. A reply it has
  // not read still earns the ordinary hop.
  await api("POST", "/api/rooms", { name: "splitunseen" });
  await useFakes("splitunseen");
  await cfg("splitunseen", { maxHops: 4, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitunseen", "@codex SLEEP:2500 SAY:UNSEENBUSY");
  await waitRoom("splitunseen", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("splitunseen", "@both TAG:claude"); // codex's late reply tags claude, who hasn't read it
  d = await idle("splitunseen", 40000);
  ok("a reply the other seat has not read still triggers its hop",
    d.entries.some((e) => e.author === "claude" && e.kind === "agent" && e.meta && e.meta.hop),
    JSON.stringify(d.entries.filter((e) => e.kind === "agent").map((e) => ({ who: e.author, hop: !!(e.meta && e.meta.hop) }))));

  // Stop must close the chain out, not leave it waiting on a turn that will
  // never run — and a pair cycle still claims both seats whole.
  await api("POST", "/api/rooms", { name: "splitstop" });
  await useFakes("splitstop");
  await say("splitstop", "@codex SLEEP:4000 SAY:STOPSLOW");
  await waitRoom("splitstop", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("splitstop", "@both SAY:STOPSPLIT");
  await waitRoom("splitstop", (x) => x.room.queued > 0, "the held delivery to be counted");
  await api("POST", "/api/stop", { room: "splitstop" });
  const afterStop = await idle("splitstop", 15000);
  ok("stop drops a held delivery and releases the room",
    afterStop.room.queued === 0 && afterStop.room.busy.length === 0 &&
    !afterStop.entries.some((e) => e.author === "codex" && e.text === "STOPSPLIT"));

  // Retry launches straight into a seat instead of going through the lane, so
  // it has to refuse while that lane still owes the user something.
  await api("POST", "/api/rooms", { name: "splitretry" });
  await useFakes("splitretry");
  await cfg("splitretry", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("splitretry", "@claude SLEEP:2500 SAY:RETRYBLOCK");
  await waitRoom("splitretry", (x) => x.room.busy.includes("claude"), "claude to start");
  await say("splitretry", "@both FAIL"); // codex's half fails now, claude's is held
  await waitRoom("splitretry", (x) => x.entries.some((e) =>
    e.kind === "system" && e.meta && e.meta.error && e.meta.agent === "codex"), "codex's half to fail");
  const retryBusy = await api("POST", "/api/retry", { room: "splitretry" });
  ok("retry refuses while a lane still owes the user a delivery",
    retryBusy.status === 409, JSON.stringify({ status: retryBusy.status, data: retryBusy.data }));
  d = await idle("splitretry", 40000);
  ok("…and works once that lane is clear",
    (await api("POST", "/api/retry", { room: "splitretry" })).status === 200);
  await idle("splitretry", 40000);

  // Stop all is a line in time. A message sent immediately afterwards must not
  // clear it and let the stopped chain wake up and hop.
  await api("POST", "/api/rooms", { name: "stopresume" });
  await useFakes("stopresume");
  await cfg("stopresume", { maxHops: 4, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("stopresume", "@codex SLEEP:2500 SAY:STOPBUSY");
  await waitRoom("stopresume", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("stopresume", "@claude TAG:codex");   // claude replies, then wants to hop at codex
  await waitRoom("stopresume", (x) => x.entries.some((e) => e.author === "claude" && e.kind === "agent"),
    "claude's reply, so a hop is pending");
  await api("POST", "/api/stop", { room: "stopresume" });
  await say("stopresume", "@claude SAY:AFTERSTOP");  // resets nothing: the stop stands
  d = await idle("stopresume", 40000);
  ok("a message after Stop does not revive the stopped chain's hop",
    !d.entries.some((e) => e.author === "codex" && e.meta && e.meta.hop),
    JSON.stringify(d.entries.filter((e) => e.kind === "agent").map((e) => ({ who: e.author, hop: !!(e.meta && e.meta.hop) }))));
  ok("the message sent after Stop is still answered",
    d.entries.some((e) => e.author === "claude" && e.text === "AFTERSTOP"));

  // A @both in a work room is a discussion. Switching Talk→Work mid-exchange
  // makes that true of an exchange that began without it, and every process
  // launched afterwards must carry the boundary — otherwise it gets work-mode
  // write permissions with nothing holding it back.
  await api("POST", "/api/rooms", { name: "scopeflip" });
  await useFakes("scopeflip");
  // Asserted on Claude: its boundary is a real flag (Plan instead of work-mode
  // acceptEdits), whereas Codex's is a prompt instruction inside its existing
  // sandboxed thread and so leaves no trace in argv.
  await cfg("scopeflip", { mode: "talk", maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("scopeflip", "@claude SLEEP:2500 SAY:SCOPEBUSY");
  await waitRoom("scopeflip", (x) => x.room.busy.includes("claude"), "claude to start");
  await say("scopeflip", "@both ARGJSON");                 // claude's half is held
  await waitRoom("scopeflip", (x) => x.room.queued > 0, "the held half");
  await cfg("scopeflip", { mode: "work" });                // flips the exchange to a discussion
  d = await idle("scopeflip", 40000);
  const heldArgv = argvFrom([...d.entries].reverse()
    .find((e) => e.author === "claude" && e.meta && e.meta.deferred));
  ok("a held @both delivery picks up the no-edit boundary the mode switch created",
    hasArg(heldArgv, "--permission-mode", "plan") &&
    !hasArg(heldArgv, "--permission-mode", "acceptEdits"), JSON.stringify(heldArgv));

  // A pair turn has no half to deliver, so its *cycle* waits — but the command
  // itself is applied and the task appended on acceptance. Queueing the raw
  // text instead left pair mode off (so the next untagged message ran as an
  // ordinary turn) and appended the task after messages sent later.
  // Stop all drops a queued pair cycle. Restoring its root as the retryable
  // turn would rewind Retry past everything the user sent afterwards.
  await api("POST", "/api/rooms", { name: "stoprewind" });
  await useFakes("stoprewind");
  await cfg("stoprewind", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("stoprewind", "@codex SLEEP:3000 SAY:REWINDBUSY");
  await waitRoom("stoprewind", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("stoprewind", "/pair start @claude SAY:PAIRROOT"); // cycle waits for both seats
  await waitRoom("stoprewind", (x) => !!x.room.pair, "pair mode to arm");
  await say("stoprewind", "@codex SAY:REWINDASIDE");          // newer aside, held for codex
  await waitRoom("stoprewind", (x) => x.room.queued >= 2, "both items waiting");
  await api("POST", "/api/stop", { room: "stoprewind" });
  const rewound = await idle("stoprewind", 20000);
  ok("stop leaves the newest turn as the retryable one", rewound.room.canRetry === true);
  const beforeRewindRetry = rewound.entries.length;
  const rewindRetry = await api("POST", "/api/retry", { room: "stoprewind" });
  ok("Retry accepts the newer turn after dropping the queued pair cycle",
    rewindRetry.status === 200, JSON.stringify(rewindRetry.data));
  d = await idle("stoprewind", 30000);
  const rewindFresh = d.entries.slice(beforeRewindRetry);
  ok("Retry after Stop does not rewind to the dropped pair cycle",
    rewindFresh.some((e) => e.author === "codex" && e.text === "REWINDASIDE") &&
    !rewindFresh.some((e) => e.text === "PAIRROOT") &&
    !rewindFresh.some((e) => e.meta && e.meta.pair),
    JSON.stringify(rewindFresh.map((e) => `${e.author}:${e.text}`.slice(0, 60))));
  await say("stoprewind", "/pair end");

  // The same rewind from the other direction: a cycle already running, waiting
  // for a reviewer who is busy in the other lane. Stop must give up quietly —
  // announcing an abandoned cycle and restoring its root would both contradict
  // the user's own Stop and take the retry slot off a newer message.
  await api("POST", "/api/rooms", { name: "stopwait" });
  await useFakes("stopwait");
  await cfg("stopwait", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("stopwait", "/pair start @claude SLEEP:1500 SAY:WAITROOT");
  await say("stopwait", "@codex SLEEP:5000 SAY:SIDEASIDE"); // occupies the reviewer's lane
  await waitRoom("stopwait", (x) => x.entries.some((e) => e.author === "claude" && e.text === "WAITROOT"),
    "the worker to finish, so the cycle waits for the busy reviewer", 25000);
  await waitRoom("stopwait", (x) => x.room.busy.includes("codex"), "the reviewer to still be busy");
  const beforeWaitStop = (await room("stopwait")).entries.length;
  await api("POST", "/api/stop", { room: "stopwait" });
  const quiet = await idle("stopwait", 25000);
  const quietStopEntries = quiet.entries.slice(beforeWaitStop);
  ok("Stop during a pair wait gives up quietly instead of announcing an abandon",
    !quiet.entries.some((e) => e.meta && e.meta.pairAbandoned),
    JSON.stringify(texts(quiet, "system")));
  ok("the interrupted seat is reported as stopped, not failed",
    quietStopEntries.some((e) => e.meta && e.meta.agent === "codex" && e.meta.stopped === true) &&
    !quietStopEntries.some((e) => e.meta && e.meta.agent === "codex" && e.meta.error === true),
    JSON.stringify(quietStopEntries.filter((e) => e.kind === "system")));
  const waitRetry = await api("POST", "/api/retry", { room: "stopwait" });
  ok("Retry is accepted after that Stop", waitRetry.status === 200, JSON.stringify(waitRetry.data));
  d = await idle("stopwait", 30000);
  ok("Retry after that Stop resumes the newer aside, not the stopped cycle",
    d.entries.some((e) => e.author === "codex" && e.text === "SIDEASIDE") &&
    d.entries.filter((e) => e.author === "claude" && e.text === "WAITROOT").length === 1 &&
    !d.entries.some((e) => e.meta && e.meta.pair === "review"),
    JSON.stringify(texts(d)));
  await say("stopwait", "/pair end");

  // Continue restarts a cycle at its fix step. Stopping that fix must not be
  // reported as a failed fix — HOP_FAILED is what an interrupted hop returns,
  // and treating it as failure hands Retry back this cycle's root.
  await api("POST", "/api/rooms", { name: "contstop" });
  await useFakes("contstop");
  await cfg("contstop", { pairRounds: 1, maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("contstop", "/pair start @claude SAY:CONTROOT NEVERHAPPY SLOWFIX");
  await waitRoom("contstop", (x) => x.entries.some((e) =>
    e.kind === "system" && e.meta && e.meta.pairContinue), "the round cap to offer Continue", 40000);
  await idle("contstop", 20000);
  await api("POST", "/api/pair/continue", { room: "contstop" });
  await waitRoom("contstop", (x) => x.room.busy.includes("claude"), "the fix step to start", 20000);
  await say("contstop", "@codex SLEEP:5000 SAY:CONTASIDE"); // newer turn, owns the retry slot
  await waitRoom("contstop", (x) => x.room.busy.includes("codex"), "the newer aside to start", 20000);
  const beforeContStop = (await room("contstop")).entries.length;
  await api("POST", "/api/stop", { room: "contstop" });
  const contStopped = await idle("contstop", 25000);
  const contStopEntries = contStopped.entries.slice(beforeContStop);
  ok("stopping a Continue fix does not report an abandoned or paused cycle",
    !contStopped.entries.some((e) => e.meta && (e.meta.pairAbandoned || e.meta.pairPaused)),
    JSON.stringify(texts(contStopped, "system")));
  ok("the stopped Continue hop is neutral rather than a failed mention",
    contStopEntries.some((e) => e.meta && e.meta.agent === "claude" && e.meta.stopped === true) &&
    !contStopEntries.some((e) => e.meta && e.meta.agent === "claude" && e.meta.error === true),
    JSON.stringify(contStopEntries.filter((e) => e.kind === "system")));
  const beforeContRetry = contStopped.entries.length;
  const contRetry = await api("POST", "/api/retry", { room: "contstop" });
  ok("Retry is accepted after stopping a Continue", contRetry.status === 200, JSON.stringify(contRetry.data));
  d = await idle("contstop", 30000);
  const contFresh = d.entries.slice(beforeContRetry);
  ok("…and replays the newer aside rather than the pair cycle",
    contFresh.some((e) => e.author === "codex" && e.text === "CONTASIDE") &&
    !contFresh.some((e) => e.meta && e.meta.pair),
    JSON.stringify(contFresh.map((e) => `${e.author}:${e.text}`.slice(0, 40))));
  await say("contstop", "/pair end");

  // A named Stop does not bump the room-wide stop epoch. The interrupted pair
  // step therefore needs its own stopped result; treating it as HOP_FAILED
  // would pause the cycle and replace this newer aside in the Retry slot.
  await api("POST", "/api/rooms", { name: "contseatstop" });
  await useFakes("contseatstop");
  await cfg("contseatstop", { pairRounds: 1, maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("contseatstop", "/pair start @claude SAY:SEATROOT NEVERHAPPY SLOWFIX");
  await waitRoom("contseatstop", (x) => x.entries.some((e) =>
    e.kind === "system" && e.meta && e.meta.pairContinue), "the round cap to offer Continue", 40000);
  await idle("contseatstop", 20000);
  const seatContinue = await api("POST", "/api/pair/continue", { room: "contseatstop" });
  ok("the seat-stop continuation is accepted", seatContinue.status === 200, JSON.stringify(seatContinue.data));
  await waitRoom("contseatstop", (x) => x.room.busy.includes("claude"), "the seat-stop fix to start", 20000);
  await say("contseatstop", "@codex SLEEP:5000 SAY:SEATASIDE");
  await waitRoom("contseatstop", (x) =>
    x.room.busy.includes("claude") && x.room.busy.includes("codex"), "both lanes to be active", 20000);
  const beforeSeatStop = (await room("contseatstop")).entries.length;
  const seatStop = await api("POST", "/api/stop", { room: "contseatstop", agent: "claude" });
  ok("a named Stop interrupts only the Continue worker",
    seatStop.status === 200 && seatStop.data.stopped === true && seatStop.data.count === 1 &&
    seatStop.data.agent === "claude",
    JSON.stringify(seatStop.data));
  d = await idle("contseatstop", 30000);
  const seatStopFresh = d.entries.slice(beforeSeatStop);
  ok("the named Stop is neutral and does not pause the pair cycle",
    seatStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.stopped === true) &&
    !seatStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.error === true) &&
    !seatStopFresh.some((e) => e.meta && (e.meta.pairPaused || e.meta.pairAbandoned)),
    JSON.stringify(seatStopFresh.filter((e) => e.kind === "system")));
  ok("…and the other lane finishes the newer aside without a pair replay",
    seatStopFresh.some((e) => e.author === "codex" && e.text === "SEATASIDE") &&
    !seatStopFresh.some((e) => e.meta && e.meta.pair),
    JSON.stringify(seatStopFresh.map((e) => `${e.author}:${e.text}`.slice(0, 50))));
  ok("the completed newer aside still owns the closed Retry slot", d.room.canRetry === false,
    JSON.stringify(d.room));
  const seatStopRetry = await api("POST", "/api/retry", { room: "contseatstop" });
  ok("Retry cannot rewind to the selectively stopped pair root", seatStopRetry.status === 400,
    JSON.stringify(seatStopRetry.data));
  await say("contseatstop", "/pair end");

  // The initial worker is a normal turn rather than a hop, but it belongs to
  // the same pair cycle and has the same rule: a deliberate named Stop must not
  // reconstruct an older root over a newer message.
  await api("POST", "/api/rooms", { name: "pairworkstop" });
  await useFakes("pairworkstop");
  await cfg("pairworkstop", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("pairworkstop", "/pair start @claude SLEEP:5000 SAY:WORKROOT");
  await waitRoom("pairworkstop", (x) => x.room.busy.includes("claude"), "the initial pair worker to start", 20000);
  await say("pairworkstop", "@codex SLEEP:3000 SAY:WORKASIDE");
  await waitRoom("pairworkstop", (x) =>
    x.room.busy.includes("claude") && x.room.busy.includes("codex"), "both work-stop lanes to be active", 20000);
  const beforeWorkStop = (await room("pairworkstop")).entries.length;
  await api("POST", "/api/stop", { room: "pairworkstop", agent: "claude" });
  d = await idle("pairworkstop", 30000);
  const workStopFresh = d.entries.slice(beforeWorkStop);
  ok("a named Stop of the initial pair worker is neutral",
    workStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.stopped === true) &&
    !workStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.error === true),
    JSON.stringify(workStopFresh.filter((e) => e.kind === "system")));
  ok("…and leaves the completed newer aside in charge of Retry",
    workStopFresh.some((e) => e.author === "codex" && e.text === "WORKASIDE") &&
    d.room.canRetry === false,
    JSON.stringify(workStopFresh.map((e) => `${e.author}:${e.text}`.slice(0, 50))));
  ok("Retry cannot rewind to the stopped initial pair work",
    (await api("POST", "/api/retry", { room: "pairworkstop" })).status === 400);
  await say("pairworkstop", "/pair end");

  // Review is the one path where null means "silent approval", so its stopped
  // result must be distinct and handled before either approval or failure.
  await api("POST", "/api/rooms", { name: "pairreviewstop" });
  await useFakes("pairreviewstop");
  await cfg("pairreviewstop", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("pairreviewstop", "/pair start @claude SAY:REVIEWROOT SLOWREVIEW");
  await waitRoom("pairreviewstop", (x) =>
    x.entries.some((e) => e.author === "claude" && e.text.startsWith("REVIEWROOT")) && x.room.busy.includes("codex"),
  "the pair reviewer to start", 20000);
  // The reviewer is the escape-hatch seat while claude is the pair worker, so
  // this is an ordinary aside held directly behind the review being stopped.
  await say("pairreviewstop", "@codex SLEEP:3000 SAY:REVIEWASIDE");
  await waitRoom("pairreviewstop", (x) =>
    x.room.busy.includes("codex") && x.room.queued > 0, "the newer reviewer-side aside to queue", 20000);
  const beforeReviewStop = (await room("pairreviewstop")).entries.length;
  await api("POST", "/api/stop", { room: "pairreviewstop", agent: "codex" });
  d = await idle("pairreviewstop", 30000);
  const reviewStopFresh = d.entries.slice(beforeReviewStop);
  ok("a named Stop of the reviewer is neutral, not failure or approval",
    reviewStopFresh.some((e) => e.meta && e.meta.agent === "codex" && e.meta.stopped === true) &&
    !reviewStopFresh.some((e) => e.meta && e.meta.agent === "codex" && e.meta.error === true) &&
    !reviewStopFresh.some((e) => e.meta && e.meta.pairPaused) &&
    !reviewStopFresh.some((e) => e.kind === "system" && /approved|nothing to flag/i.test(e.text)),
    JSON.stringify(reviewStopFresh.filter((e) => e.kind === "system")));
  ok("…and leaves the completed reviewer-side aside in charge of Retry",
    reviewStopFresh.some((e) => e.author === "codex" && e.text === "REVIEWASIDE") &&
    d.room.canRetry === false,
    JSON.stringify(reviewStopFresh.map((e) => `${e.author}:${e.text}`.slice(0, 50))));
  ok("Retry cannot rewind to the stopped review",
    (await api("POST", "/api/retry", { room: "pairreviewstop" })).status === 400);
  await say("pairreviewstop", "/pair end");

  // The ordinary pair loop's fix step is separate from Continue's fix path;
  // cover its stopped-result branch independently.
  await api("POST", "/api/rooms", { name: "pairfixstop" });
  await useFakes("pairfixstop");
  await cfg("pairfixstop", { pairRounds: 2, maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("pairfixstop", "/pair start @claude SAY:FIXROOT NEVERHAPPY SLOWFIX");
  await waitRoom("pairfixstop", (x) =>
    x.entries.some((e) => e.meta && e.meta.pair === "review") && x.room.busy.includes("claude"),
  "the ordinary pair fix to start", 30000);
  await say("pairfixstop", "@codex SLEEP:3000 SAY:FIXASIDE");
  await waitRoom("pairfixstop", (x) =>
    x.room.busy.includes("claude") && x.room.busy.includes("codex"), "both fix-stop lanes to be active", 20000);
  const beforeFixStop = (await room("pairfixstop")).entries.length;
  await api("POST", "/api/stop", { room: "pairfixstop", agent: "claude" });
  d = await idle("pairfixstop", 30000);
  const fixStopFresh = d.entries.slice(beforeFixStop);
  ok("a named Stop of an ordinary pair fix is neutral",
    fixStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.stopped === true) &&
    !fixStopFresh.some((e) => e.meta && e.meta.agent === "claude" && e.meta.error === true) &&
    !fixStopFresh.some((e) => e.meta && e.meta.pairPaused),
    JSON.stringify(fixStopFresh.filter((e) => e.kind === "system")));
  ok("…and leaves the completed fix-side aside in charge of Retry",
    fixStopFresh.some((e) => e.author === "codex" && e.text === "FIXASIDE") &&
    d.room.canRetry === false,
    JSON.stringify(fixStopFresh.map((e) => `${e.author}:${e.text}`.slice(0, 50))));
  ok("Retry cannot rewind to the selectively stopped ordinary fix",
    (await api("POST", "/api/retry", { room: "pairfixstop" })).status === 400);
  await say("pairfixstop", "/pair end");

  // Rename moves the room's folder out from under any process the room might
  // still launch, so it waits for the whole exchange — not just a busy seat.
  await api("POST", "/api/rooms", { name: "renameguard" });
  await useFakes("renameguard");
  await cfg("renameguard", { maxHops: 0, agents: { claude: { lurk: false }, codex: { lurk: false } } });
  await say("renameguard", "/pair start @claude"); // armed only, so Continue reaches its work guard
  await say("renameguard", "@codex SLEEP:2500 SAY:RENBUSY");
  await waitRoom("renameguard", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("renameguard", "@both SAY:RENSPLIT");
  await waitRoom("renameguard", (x) => x.room.queued > 0, "the held half");
  const renameBusy = await api("POST", "/api/room/rename", { room: "renameguard", to: "renameguard2" });
  ok("rename is refused while an exchange still owes work", renameBusy.status === 409,
    JSON.stringify(renameBusy.data));
  const continueBusy = await api("POST", "/api/pair/continue", { room: "renameguard" });
  ok("Continue is refused while an exchange still owes work", continueBusy.status === 409,
    JSON.stringify(continueBusy.data));
  await idle("renameguard", 40000);
  const renameFree = await api("POST", "/api/room/rename", { room: "renameguard", to: "renameguard2" });
  ok("…and the guard releases once the exchange is done", renameFree.status === 200,
    JSON.stringify(renameFree.data));

  // Once an exchange has the boundary it keeps it. Flipping the room back to
  // Talk must not let a Retry of that same message come back full-access.
  await api("POST", "/api/rooms", { name: "scopelatch" });
  await useFakes("scopelatch");
  await cfg("scopelatch", {
    mode: "talk", maxHops: 0,
    agents: { claude: { lurk: false, permissionMode: "bypassPermissions" }, codex: { lurk: false } },
  });
  await say("scopelatch", "@claude SLEEP:2500 SAY:LATCHBUSY");
  await waitRoom("scopelatch", (x) => x.room.busy.includes("claude"), "claude to start");
  // claude's half is held, and fails once when it runs — so it is the seat
  // Retry targets, and its retry succeeds and reports the flags it ran with.
  await say("scopelatch", "@both FAILONCESEAT:claude ARGJSON");
  await waitRoom("scopelatch", (x) => x.room.queued > 0, "the held half");
  await cfg("scopelatch", { mode: "work" });              // exchange acquires the boundary
  await waitRoom("scopelatch", (x) => x.entries.some((e) =>
    e.kind === "system" && e.meta && e.meta.agent === "claude" && e.meta.error), "claude's half to fail", 30000);
  await idle("scopelatch", 40000);
  await cfg("scopelatch", { mode: "talk" });              // …and must not lose it
  ok("the failed half is retryable", (await room("scopelatch")).room.canRetry === true);
  await api("POST", "/api/retry", { room: "scopelatch" });
  d = await idle("scopelatch", 40000);
  const latchedArgv = argvFrom(lastAgent(d, "claude"));
  ok("a boundary acquired mid-exchange is latched against a later Work→Talk flip",
    hasArg(latchedArgv, "--permission-mode", "plan") &&
    !hasArg(latchedArgv, "--permission-mode", "bypassPermissions"), JSON.stringify(latchedArgv));

  // Rooms written by 1.0.1 recorded the boundary only on the user entry. Retry
  // has to read it from there, or a protected historical @both comes back with
  // full access.
  const legacyRoom = path.join(ROOT, "legacyscope2");
  fs.mkdirSync(path.join(legacyRoom, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoom, "room.json"), JSON.stringify({
    defaultAgent: "claude", mode: "talk", maxHops: 0, pairRounds: 0,
    projectDir: null, roomNote: null, timeoutMs: 900000,
    agents: {
      claude: { command: FAKE, model: null, effort: null, extraArgs: [], lurk: false, permissionMode: "bypassPermissions" },
      codex: { command: FAKE, model: null, effort: null, sandbox: "read-only", extraArgs: [], lurk: false },
    },
  }, null, 2));
  fs.writeFileSync(path.join(legacyRoom, "events.jsonl"),
    JSON.stringify({
      n: 1, kind: "user", author: "user", target: "both", text: "@both ARGJSON",
      ts: new Date().toISOString(), meta: { audience: { addressed: ["claude", "codex"], lurking: [] }, discussion: true },
    }) + "\n");
  // lastUser as an older build wrote it: no `discussion` field at all.
  fs.writeFileSync(path.join(legacyRoom, "state.json"), JSON.stringify({
    agents: { claude: { sessionRef: null, cursor: 0 }, codex: { sessionRef: null, cursor: 0 } },
    lastAddressed: "both", pair: null,
    lastUser: { n: 1, text: "@both ARGJSON", target: "both", done: {}, pair: false },
  }, null, 2));
  const legacy = await room("legacyscope2");
  ok("a legacy protected turn is still offered for retry", legacy.room.canRetry === true);
  await api("POST", "/api/retry", { room: "legacyscope2" });
  d = await idle("legacyscope2", 40000);
  const legacyArgv = argvFrom(lastAgent(d, "claude"));
  ok("retrying it recovers the boundary from the entry rather than going full-access",
    hasArg(legacyArgv, "--permission-mode", "plan") &&
    !hasArg(legacyArgv, "--permission-mode", "bypassPermissions"), JSON.stringify(legacyArgv));

  await api("POST", "/api/rooms", { name: "splitpair" });
  await useFakes("splitpair");
  await say("splitpair", "@codex SLEEP:2500 SAY:PAIRBUSY");
  await waitRoom("splitpair", (x) => x.room.busy.includes("codex"), "codex to start");
  const pairQueued = await say("splitpair", "/pair start @claude SAY:PAIRWORK");
  ok("a pair cycle waits as a unit rather than splitting",
    pairQueued.data.queued === true && !pairQueued.data.deferred &&
    pairQueued.data.target === "claude" && pairQueued.data.explicit === true,
    JSON.stringify(pairQueued.data));
  const armed = await room("splitpair");
  ok("a queued pair turn arms pair mode immediately",
    !!armed.room.pair && armed.room.pair.worker === "claude", JSON.stringify(armed.room.pair));
  ok("…and announces it in the transcript straight away",
    texts(armed, "system").some((t) => /Pair mode on/.test(t)), JSON.stringify(texts(armed, "system")));
  ok("…and appends the task where the user sent it, not where it ran",
    texts(armed, "user").join("|") === "SLEEP:2500 SAY:PAIRBUSY|SAY:PAIRWORK",
    JSON.stringify(texts(armed, "user")));
  ok("…and the waiting task owns the retry slot",
    armed.room.lastAddressed === "claude", armed.room.lastAddressed);
  d = await idle("splitpair", 40000);
  ok("the queued cycle then runs as a pair cycle, reviewer and all",
    d.entries.some((e) => e.author === "claude" && e.text === "PAIRWORK") &&
    d.entries.some((e) => e.author === "codex" && e.meta && e.meta.pair === "review"),
    JSON.stringify(d.entries.filter((e) => e.kind === "agent").map((e) => e.author + ":" + (e.meta && e.meta.pair || "turn"))));

  // The next untagged message must be a pair turn too — pair mode was on from
  // the moment the command was accepted, not from when its cycle got a seat.
  await api("POST", "/api/rooms", { name: "pairarmed" });
  await useFakes("pairarmed");
  await say("pairarmed", "@codex SLEEP:2000 SAY:ARMBUSY");
  await waitRoom("pairarmed", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("pairarmed", "/pair start @claude SAY:ARMFIRST");   // cycle waits
  const followUp = await say("pairarmed", "SAY:ARMSECOND");     // untagged: must pair too
  ok("an untagged message sent while a pair cycle waits is itself a pair turn",
    followUp.data.queued === true, JSON.stringify(followUp.data));
  d = await idle("pairarmed", 60000);
  ok("both pair tasks were reviewed rather than run as ordinary turns",
    d.entries.filter((e) => e.meta && e.meta.pair === "review").length === 2,
    JSON.stringify(d.entries.filter((e) => e.kind === "agent").map((e) => e.author + ":" + (e.meta && e.meta.pair || "turn"))));
  await say("pairarmed", "/pair end");

  console.log("\npair mode");
  await api("POST", "/api/rooms", { name: "pairroom" });
  await useFakes("pairroom");
  await say("pairroom", "/pair start @claude SAY:BUILT");
  d = await idle("pairroom", 40000);
  ok("worker does the task", d.entries.some((e) => e.author === "claude" && e.text === "BUILT"));
  ok("reviewer reviews", d.entries.some((e) => e.author === "codex" && e.meta && e.meta.pair === "review"));
  ok("approval is reported", texts(d, "system").some((t) => t.includes("approved")));
  const initialPair = (await room("pairroom")).room.pair;
  ok("pair mode stays on after a cycle", !!initialPair);
  ok("a default-sourced pair records until-approved as the active value",
    initialPair.rounds === 0 && initialPair.roundsSource === "room", JSON.stringify(initialPair));
  const pairStartNotice = d.entries.find((e) => e.kind === "system" && /Pair mode on/i.test(e.text));
  ok("zero-round pair notices never say up to 0",
    !!pairStartNotice && /until approved/i.test(pairStartNotice.text) && !/up to 0/i.test(pairStartNotice.text),
    pairStartNotice && pairStartNotice.text);

  // the point of the redesign: a plain message keeps the loop going
  await say("pairroom", "SAY:AGAIN");
  d = await idle("pairroom", 60000);
  ok("a later plain message is worked and reviewed",
    d.entries.some((e) => e.author === "claude" && e.text === "AGAIN") &&
    d.entries.filter((e) => e.meta && e.meta.pair === "review").length >= 2);
  ok("sending a message did not end pair mode", !!(await room("pairroom")).room.pair);

  await say("pairroom", "SAY:NEEDSFIX");
  d = await idle("pairroom", 60000);
  ok("rejected work triggers a fix round", d.entries.some((e) => e.meta && e.meta.pair === "fix"));

  // an aside to the idle agent must not wait for the pair cycle in flight
  await say("pairroom", "SLEEP:1200 SAY:LONGWORK");     // occupies the worker
  await waitRoom("pairroom", (x) => x.room.busy.includes("claude"), "slow worker to start");
  const asideNow = await say("pairroom", "@codex SAY:FREE");
  ok("an aside to the free seat dispatches while the worker is mid-response",
    asideNow.data.queued !== true, JSON.stringify(asideNow.data));
  await idle("pairroom", 90000);

  // an explicit tag is the escape hatch for a normal aside
  const beforeAside = (await room("pairroom")).entries.length;
  await say("pairroom", "@codex SAY:ASIDE");
  d = await idle("pairroom", 40000);
  const aside = d.entries.slice(beforeAside);
  ok("tagging the reviewer skips the pair loop",
    aside.some((e) => e.author === "codex" && e.text === "ASIDE") && !aside.some((e) => e.meta && e.meta.pair));

  // by default there is no round cap: the loop runs until the reviewer
  // approves, and only a runaway guard stops two agents that never converge
  ok("pair rounds default to until-approved", (await room("pairroom")).room.cfg.pairRounds === 0);
  const beforeRunaway = (await room("pairroom")).entries.length;
  await say("pairroom", "SAY:NEVERHAPPY");
  d = await idle("pairroom", 120000);
  const runaway = d.entries.slice(beforeRunaway);
  const reviews = runaway.filter((e) => e.meta && e.meta.pair === "review").length;
  ok("a stubborn reviewer keeps the loop going past two rounds", reviews > 2, `${reviews} reviews`);
  const guard = runaway.find((e) => e.kind === "system" && e.meta && e.meta.pairContinue);
  ok("the runaway guard stops it eventually", !!guard, guard && guard.text);
  ok("the guard says it is a safety stop", !!guard && /Safety stop/i.test(guard.text));

  // an explicit setting still caps the loop where you ask it to
  await cfg("pairroom", { pairRounds: 2 });
  d = await room("pairroom");
  ok("changing pair-rounds updates a room-sourced active mode",
    d.room.pair.rounds === 2 && d.room.pair.roundsSource === "room", JSON.stringify(d.room.pair));
  const beforeCap = (await room("pairroom")).entries.length;
  await say("pairroom", "SAY:NEVERHAPPY");
  d = await idle("pairroom", 120000);
  const capNote = d.entries.slice(beforeCap).find((e) => e.kind === "system" && e.meta && e.meta.pairContinue);
  ok("a configured cap is honoured", !!capNote && /your pair-rounds setting/.test(capNote.text), capNote && capNote.text);
  ok("configured cap stops at the set round",
    d.entries.slice(beforeCap).filter((e) => e.meta && e.meta.pair === "review").length === 2);

  const beforeCont = (await room("pairroom")).entries.length;
  const cont = await api("POST", "/api/pair/continue", { room: "pairroom" });
  ok("continue accepted", cont.status === 200);
  d = await idle("pairroom", 90000);
  const resumed = d.entries.slice(beforeCont);
  ok("continue resumes with a fix then another review",
    resumed.some((e) => e.meta && e.meta.pair === "fix") && resumed.some((e) => e.meta && e.meta.pair === "review"));
  ok("resumed rounds keep counting up",
    resumed.filter((e) => e.meta && e.meta.pair).every((e) => e.meta.round > 1));

  // A command-level override is intentionally different: Settings should not
  // silently rewrite an explicit `/pair start N` choice.
  await say("pairroom", "/pair start 3 @claude");
  d = await room("pairroom");
  ok("an explicit pair-round override records its source",
    d.room.pair.rounds === 3 && d.room.pair.roundsSource === "command", JSON.stringify(d.room.pair));
  await cfg("pairroom", { pairRounds: 1 });
  d = await room("pairroom");
  ok("Settings leave an explicit active override pinned",
    d.room.cfg.pairRounds === 1 && d.room.pair.rounds === 3 && d.room.pair.roundsSource === "command",
    JSON.stringify({ cfg: d.room.cfg.pairRounds, pair: d.room.pair }));
  await say("pairroom", "/pair start @claude");
  d = await room("pairroom");
  ok("restarting without an override follows the room setting again",
    d.room.pair.rounds === 1 && d.room.pair.roundsSource === "room", JSON.stringify(d.room.pair));
  await cfg("pairroom", { pairRounds: 2 });

  // a retried pair turn must come back as a pair turn, review included
  const beforeRetry = (await room("pairroom")).entries.length;
  await say("pairroom", "FAILONCE:PAIRRETRY SAY:RETRIED");
  await idle("pairroom", 60000);
  ok("a failed pair turn is reported", (await room("pairroom")).entries.slice(beforeRetry)
    .some((e) => e.kind === "system" && e.meta && e.meta.error));
  const retried = await api("POST", "/api/retry", { room: "pairroom" });
  ok("retry accepts the failed pair turn", retried.status === 200, JSON.stringify(retried.data));
  d = await idle("pairroom", 90000);
  ok("retry re-runs it as a pair turn, with the review",
    d.entries.slice(beforeRetry).some((e) => e.author === "claude" && e.text === "RETRIED") &&
    d.entries.slice(beforeRetry).some((e) => e.meta && e.meta.pair === "review"));

  // A broken reviewer is an unavailable review, never a silent approval.
  const beforeReviewFailure = (await room("pairroom")).entries.length;
  await say("pairroom", "SAY:REVIEWFAIL");
  d = await idle("pairroom", 90000);
  const reviewFailure = d.entries.slice(beforeReviewFailure);
  ok("a reviewer CLI failure pauses the pair cycle",
    reviewFailure.some((e) => e.kind === "system" && e.meta && e.meta.pairPaused && e.meta.error === false));
  ok("a reviewer CLI failure never creates a positive approval",
    !reviewFailure.some((e) => e.kind === "system" && /^\s*✅/.test(e.text)),
    JSON.stringify(reviewFailure.filter((e) => e.kind === "system").map((e) => e.text)));
  ok("the failed review remains retryable", d.room.canRetry === true);
  ok("working clears after a reviewer failure", d.room.working === false);

  // a cycle whose reviewer never frees up must say so instead of vanishing
  const beforeAbandon = (await room("pairroom")).entries.length;
  await say("pairroom", "SLEEP:1200 SAY:WORKDONE"); // pair turn starts on the worker
  await waitRoom("pairroom", (x) => x.room.busy.includes("claude"), "worker to become busy");
  const slowAside = await say("pairroom", "@codex SLEEP:6000 SAY:ASIDEFREE");
  ok("the inline reviewer aside dispatches during worker activity",
    slowAside.data.queued !== true, JSON.stringify(slowAside.data));
  await waitRoom("pairroom", (x) => x.room.busy.includes("codex"), "reviewer aside to become busy");
  const pendingAfterAbandon = await say("pairroom", "SAY:PENDINGDONE");
  ok("a later pair turn queues behind the active cycle", pendingAfterAbandon.data.queued === true,
    JSON.stringify(pendingAfterAbandon.data));
  d = await idle("pairroom", 90000);
  const abandoned = d.entries.slice(beforeAbandon);
  const abandonNote = abandoned.find((e) => e.kind === "system" && /abandoned/i.test(e.text));
  ok("an abandoned pair cycle announces itself as a non-error",
    !!abandonNote && abandonNote.meta && abandonNote.meta.error === false,
    JSON.stringify(abandoned.filter((e) => e.kind === "system").map((e) => ({ text: e.text, meta: e.meta }))));
  ok("pending work drains after the abandoned cycle and reviewer aside finish",
    abandoned.some((e) => e.author === "claude" && e.text === "PENDINGDONE") &&
    abandoned.some((e) => e.meta && e.meta.pair === "review"));
  ok("the abandoned cycle eventually clears working and its queue",
    d.room.working === false && d.room.queued === 0, JSON.stringify({ working: d.room.working, queued: d.room.queued }));

  const ended = await say("pairroom", "/pair end");
  ok("/pair end succeeds while the mode is idle", ended.status === 200, JSON.stringify(ended.data));
  ok("continue refused once pair mode is off",
    (await api("POST", "/api/pair/continue", { room: "pairroom" })).status === 400);
  ok("pair mode ends on command", !(await room("pairroom")).room.pair);
  ok("ending an already-off pair mode is refused", (await say("pairroom", "/pair end")).status === 400);
  const beforePlain = (await room("pairroom")).entries.length;
  await say("pairroom", "SAY:NORMAL");
  d = await idle("pairroom", 40000);
  ok("messages are ordinary again after ending",
    d.entries.slice(beforePlain).every((e) => !(e.meta && e.meta.pair)));

  console.log("\npair end lifecycle");
  await api("POST", "/api/rooms", { name: "pairend" });
  await useFakes("pairend");
  ok("/pair end is rejected before the mode is armed", (await say("pairend", "/pair end")).status === 400);
  await say("pairend", "/pair start @claude");
  ok("an armed but idle pair mode can end", (await say("pairend", "/pair end")).status === 200 &&
    !(await room("pairend")).room.pair);

  const summaries = await watchRoomSummaries("pairend");
  const beforeActiveEnd = (await room("pairend")).entries.length;
  await say("pairend", "/pair start @claude SLEEP:1400 SAY:ENDWORK");
  await waitRoom("pairend", (x) => x.room.working && x.room.busy.includes("claude"), "active pair cycle");
  const endDuring = await say("pairend", "/pair end");
  const afterEndCommand = await room("pairend");
  ok("/pair end returns immediately during a cycle",
    endDuring.status === 200 && !afterEndCommand.room.pair && afterEndCommand.room.working === true,
    JSON.stringify({ response: endDuring.data, room: afterEndCommand.room }));
  d = await idle("pairend", 90000);
  const finishedAfterEnd = d.entries.slice(beforeActiveEnd);
  ok("the in-flight cycle finishes from its snapshot after pair mode ends",
    finishedAfterEnd.some((e) => e.author === "claude" && e.text === "ENDWORK") &&
    finishedAfterEnd.some((e) => e.meta && e.meta.pair === "review") && !d.room.pair);
  ok("working eventually becomes false after ending mid-cycle", d.room.working === false);
  const sseUntil = Date.now() + 3000;
  for (;;) {
    const on = summaries.seen.findIndex((s) => s.working === true);
    if (on >= 0 && summaries.seen.slice(on + 1).some((s) => s.working === false)) break;
    if (Date.now() > sseUntil) break;
    await sleep(50);
  }
  await summaries.stop();
  const workingOn = summaries.seen.findIndex((s) => s.working === true);
  ok("SSE broadcasts both working lifecycle edges",
    workingOn >= 0 && summaries.seen.slice(workingOn + 1).some((s) => s.working === false),
    JSON.stringify(summaries.seen.map((s) => ({ working: s.working, busy: s.busy }))));

  console.log("\npair retry provenance");

  // An explicit aside writes lastUser too. If the pair review fails later,
  // Retry must still recover the pair's original root turn from the transcript.
  await api("POST", "/api/rooms", { name: "pairasidefail" });
  await useFakes("pairasidefail");
  await cfg("pairasidefail", { pairRounds: 2 });
  await say("pairasidefail", "/pair start @claude SLEEP:1000 SAY:REVIEWFAILONCE");
  await waitRoom("pairasidefail", (x) => x.room.busy.includes("claude"), "pair worker to start");
  const overwritingAside = await say("pairasidefail", "@codex SAY:OVERWROTE");
  ok("the lastUser-overwriting aside dispatches during pair work",
    overwritingAside.data.queued !== true, JSON.stringify(overwritingAside.data));
  await waitRoom("pairasidefail",
    (x) => x.entries.some((e) => e.author === "codex" && e.text === "OVERWROTE"),
    "explicit aside to finish");
  d = await idle("pairasidefail", 90000);
  const asideFailRoot = d.entries.find((e) => e.kind === "user" && e.text.includes("REVIEWFAILONCE"));
  ok("review failure after the aside restores the original pair turn for Retry",
    !!asideFailRoot && d.room.canRetry && d.entries.some((e) => e.meta && e.meta.pairPaused));
  const beforeAsideRetry = d.entries.length;
  const asideRetry = await api("POST", "/api/retry", { room: "pairasidefail" });
  ok("Retry accepts the restored pre-aside pair turn", asideRetry.status === 200, JSON.stringify(asideRetry.data));
  d = await idle("pairasidefail", 90000);
  const asideRerun = d.entries.slice(beforeAsideRetry);
  ok("Retry reruns that original work and review, not the later aside",
    asideRerun.some((e) => e.kind === "agent" && e.author === "claude" && e.text === "REVIEWFAILONCE" && !(e.meta && e.meta.pair)) &&
    asideRerun.some((e) => e.author === "codex" && e.meta && e.meta.pair === "review" && e.meta.rootN === asideFailRoot.n) &&
    !asideRerun.some((e) => e.kind === "user"),
    JSON.stringify(asideRerun.map((e) => ({ kind: e.kind, author: e.author, text: e.text, meta: e.meta }))));
  await say("pairasidefail", "/pair end");

  // A continuation starts from a review entry, but a failed fix still makes
  // the base user request the retry root.
  await api("POST", "/api/rooms", { name: "paircontinuefail" });
  await useFakes("paircontinuefail");
  await cfg("paircontinuefail", { pairRounds: 1 });
  await say("paircontinuefail", "/pair start @claude SAY:FIXFAILONCE");
  d = await idle("paircontinuefail", 90000);
  const continueRoot = d.entries.find((e) => e.kind === "user" && e.text.includes("FIXFAILONCE"));
  ok("one-round setup leaves review feedback available to continue",
    !!continueRoot && d.entries.some((e) => e.meta && e.meta.pairContinue && e.meta.rootN === continueRoot.n));
  const continueReq = await api("POST", "/api/pair/continue", { room: "paircontinuefail" });
  ok("the failing continuation is accepted", continueReq.status === 200, JSON.stringify(continueReq.data));
  d = await idle("paircontinuefail", 90000);
  ok("a failed continuation fix exposes Retry for the original request",
    d.room.canRetry && d.entries.some((e) => e.meta && e.meta.pairPaused && e.meta.agent === "claude"));
  const beforeContinueRetry = d.entries.length;
  const continueRetry = await api("POST", "/api/retry", { room: "paircontinuefail" });
  ok("Retry accepts a failed continuation", continueRetry.status === 200, JSON.stringify(continueRetry.data));
  d = await idle("paircontinuefail", 90000);
  const continuedRerun = d.entries.slice(beforeContinueRetry);
  const firstContinuedAgent = continuedRerun.find((e) => e.kind === "agent");
  ok("Retry after continue starts from the original user work, not another fix",
    firstContinuedAgent && firstContinuedAgent.author === "claude" &&
    firstContinuedAgent.text === "FIXFAILONCE" && !(firstContinuedAgent.meta && firstContinuedAgent.meta.pair) &&
    continuedRerun.some((e) => e.author === "codex" && e.meta && e.meta.pair === "review" && e.meta.rootN === continueRoot.n) &&
    !continuedRerun.some((e) => e.kind === "user"),
    JSON.stringify(continuedRerun.map((e) => ({ kind: e.kind, author: e.author, text: e.text, meta: e.meta }))));
  await say("paircontinuefail", "/pair end");

  // Pair configuration is resolved when Retry is pressed. Switching the mode
  // without a task must not resurrect the worker snapshot that originally failed.
  await api("POST", "/api/rooms", { name: "pairswitchretry" });
  await useFakes("pairswitchretry");
  await cfg("pairswitchretry", { pairRounds: 2 });
  await say("pairswitchretry", "/pair start @claude SAY:PRIMED");
  d = await idle("pairswitchretry", 90000);
  ok("an approved pair turn leaves nothing retryable", d.room.canRetry === false);
  await say("pairswitchretry", "/pair start @codex");
  d = await room("pairswitchretry");
  ok("switching roles after approval does not manufacture Retry",
    d.room.pair.worker === "codex" && d.room.canRetry === false &&
    (await api("POST", "/api/retry", { room: "pairswitchretry" })).status === 400,
    JSON.stringify({ pair: d.room.pair, canRetry: d.room.canRetry }));
  await say("pairswitchretry", "/pair start @claude");

  // Advance the future worker's cursor with an aside after the pair root, then
  // fail the review. Retrying after the role switch must not rewind that cursor.
  await say("pairswitchretry", "SLEEP:1000 SAY:REVIEWFAILONCE");
  await waitRoom("pairswitchretry", (x) => x.room.busy.includes("claude"), "switch-test worker to start");
  await say("pairswitchretry", "@codex SAY:CURSORHIGH");
  await waitRoom("pairswitchretry",
    (x) => x.entries.some((e) => e.kind === "agent" && e.author === "codex" && e.text === "CURSORHIGH"),
    "future worker aside to finish");
  d = await idle("pairswitchretry", 90000);
  const switchRoot = [...d.entries].reverse()
    .find((e) => e.kind === "user" && e.text.includes("REVIEWFAILONCE"));
  const switchRootN = switchRoot && switchRoot.n;
  const cursorAsideRoot = [...d.entries].reverse()
    .find((e) => e.kind === "user" && e.target === "codex" && e.text.includes("CURSORHIGH"));
  ok("the original pair failure is retryable before switching", !!switchRoot && d.room.canRetry);
  await say("pairswitchretry", "/pair start @codex");
  d = await room("pairswitchretry");
  ok("a taskless pair command switches the active roles",
    d.room.pair.worker === "codex" && d.room.pair.reviewer === "claude", JSON.stringify(d.room.pair));
  const newWorkerCursorBeforeRetry = d.room.agents.codex.cursor;
  ok("the new worker cursor is newer than the failed pair root before Retry",
    !!switchRoot && !!cursorAsideRoot && newWorkerCursorBeforeRetry >= cursorAsideRoot.n && newWorkerCursorBeforeRetry > switchRootN,
    JSON.stringify({ cursor: newWorkerCursorBeforeRetry, pairRoot: switchRootN, asideRoot: cursorAsideRoot && cursorAsideRoot.n }));
  const beforeSwitchRetry = d.entries.length;
  const switchCursorWatch = await watchRoomSummaries("pairswitchretry");
  const switchRetry = await api("POST", "/api/retry", { room: "pairswitchretry" });
  ok("Retry remains available after the taskless role switch", switchRetry.status === 200, JSON.stringify(switchRetry.data));
  d = await idle("pairswitchretry", 90000);
  const switchedRerun = d.entries.slice(beforeSwitchRetry);
  ok("Retry uses the newly active worker and reviewer",
    switchedRerun.some((e) => e.kind === "agent" && e.author === "codex" && e.text === "REVIEWFAILONCE" && !(e.meta && e.meta.pair)) &&
    switchedRerun.some((e) => e.author === "claude" && e.meta && e.meta.pair === "review" && e.meta.rootN === switchRootN) &&
    !switchedRerun.some((e) => e.kind === "agent" && e.author === "claude" && e.text === "REVIEWFAILONCE" && !(e.meta && e.meta.pair)),
    JSON.stringify(switchedRerun.map((e) => ({ author: e.author, text: e.text, meta: e.meta }))));
  const beforeCursorRecall = d.entries.length;
  await say("pairswitchretry", "RECALL");
  d = await idle("pairswitchretry", 90000);
  const recallAfterRetry = d.entries.slice(beforeCursorRecall)
    .find((e) => e.kind === "agent" && e.author === "codex" && !(e.meta && e.meta.pair));
  await switchCursorWatch.stop();
  const watchedCodexCursors = switchCursorWatch.seen.map((s) => s.agents.codex.cursor);
  ok("the switched worker cursor never decreases during Retry or the next turn",
    watchedCodexCursors.length > 0 && watchedCodexCursors.every((n) => n >= newWorkerCursorBeforeRetry) &&
    d.room.agents.codex.cursor >= newWorkerCursorBeforeRetry,
    JSON.stringify({ before: newWorkerCursorBeforeRetry, seen: watchedCodexCursors, after: d.room.agents.codex.cursor }));
  ok("the following turn does not replay context already heard before Retry",
    !!recallAfterRetry && !recallAfterRetry.text.includes("CURSORHIGH"), recallAfterRetry && recallAfterRetry.text);
  await say("pairswitchretry", "/pair end");

  console.log("\npair configuration snapshots");
  await api("POST", "/api/rooms", { name: "pairroundsnap" });
  await useFakes("pairroundsnap");
  await cfg("pairroundsnap", { pairRounds: 2 });
  const beforeOldRounds = (await room("pairroundsnap")).entries.length;
  await say("pairroundsnap", "/pair start @claude SLEEP:1200 SAY:NEVERHAPPY");
  await waitRoom("pairroundsnap",
    (x) => x.room.workingPair && x.room.workingPair.rounds === 2 && x.room.busy.includes("claude"),
    "two-round cycle snapshot");
  const changedRounds = await cfg("pairroundsnap", { pairRounds: 1 });
  const midRounds = changedRounds.data.room;
  ok("mid-cycle Settings separate the current and next pair snapshots",
    changedRounds.status === 200 && midRounds.workingPair.rounds === 2 && midRounds.pair.rounds === 1,
    JSON.stringify({ workingPair: midRounds.workingPair, pair: midRounds.pair }));
  d = await idle("pairroundsnap", 90000);
  const oldRounds = d.entries.slice(beforeOldRounds);
  ok("the in-flight cycle keeps its original two-round cap",
    oldRounds.filter((e) => e.meta && e.meta.pair === "review").length === 2 &&
    oldRounds.some((e) => e.meta && e.meta.pairContinue && e.meta.rounds === 2));
  const beforeNewRounds = d.entries.length;
  await say("pairroundsnap", "SAY:NEVERHAPPY");
  d = await idle("pairroundsnap", 90000);
  const newRounds = d.entries.slice(beforeNewRounds);
  ok("the next cycle uses the newly configured one-round cap",
    newRounds.filter((e) => e.meta && e.meta.pair === "review").length === 1 &&
    newRounds.some((e) => e.meta && e.meta.pairContinue && e.meta.rounds === 1));
  await say("pairroundsnap", "/pair end");

  console.log("\nlanes, queueing & stop");
  await api("POST", "/api/rooms", { name: "lanes" });
  await useFakes("lanes");
  const r1 = await say("lanes", "@claude SAY:A");
  const r2 = await say("lanes", "@codex SAY:B");
  const r3 = await say("lanes", "@codex SAY:C");
  ok("different seats dispatch in parallel", r1.data.ok === true && r2.data.ok === true);
  // Accepted straight away and held for the lane, rather than kept as raw text:
  // the message is in the transcript in send order, only its delivery waits.
  ok("a second message for the same seat is accepted and held for that lane",
    r3.status === 200 && !r3.data.queued && (r3.data.deferred || []).join() === "codex",
    JSON.stringify(r3.data));
  const midOrder = await room("lanes");
  ok("the held message is in the transcript in the order it was sent",
    texts(midOrder, "user").join("|") === "SAY:A|SAY:B|SAY:C",
    JSON.stringify(texts(midOrder, "user")));
  const mid = await room("lanes");
  ok("both lanes busy at once", mid.room.busy.length === 2, JSON.stringify(mid.room.busy));
  d = await idle("lanes");
  ok("held message runs after its lane frees", texts(d).includes("C"));
  ok("all three replies landed", ["A", "B", "C"].every((t) => texts(d).includes(t)));
  ok("the held reply came after the one it waited on",
    texts(d).indexOf("B") < texts(d).indexOf("C"));

  await api("POST", "/api/rooms", { name: "selectstop" });
  await useFakes("selectstop");
  await say("selectstop", "@claude SLEEP:2200 SAY:CLAUDE_DONE");
  await say("selectstop", "@codex SLEEP:2200 SAY:CODEX_DONE");
  await sleep(150);
  const selective = await api("POST", "/api/stop", { room: "selectstop", agent: "claude" });
  ok("a seat-scoped Stop reports only that CLI", selective.status === 200 &&
    selective.data.stopped === true && selective.data.count === 1 && selective.data.agent === "claude", JSON.stringify(selective.data));
  d = await idle("selectstop");
  ok("seat-scoped Stop leaves the other response running",
    !texts(d).includes("CLAUDE_DONE") && texts(d).includes("CODEX_DONE"));
  const badStop = await api("POST", "/api/stop", { room: "selectstop", agent: "nobody" });
  ok("seat-scoped Stop rejects unknown agents", badStop.status === 400);

  console.log("\nstop scopes, run ids & the queue view");
  // Stop aims through the run record rather than the process table. The record
  // exists for the whole life of a turn, so "the seat is busy" and "there is
  // something to stop" cannot disagree, and every response has an id a click
  // can name. (beginRun through spawn is one synchronous block today, so the
  // pre-spawn half of that is not reachable from a test; the guard in runCli is
  // there to keep it unreachable if staging ever grows an await.)
  await api("POST", "/api/rooms", { name: "stopscope" });
  await useFakes("stopscope");
  await say("stopscope", "@claude SLEEP:2500 SAY:PROV_DONE");
  // Deliberately no sleep: the seat is claimed synchronously with the accept.
  const claimed = await room("stopscope");
  const provRoot = [...claimed.entries].reverse().find((e) => e.kind === "user");
  const provInfo = (claimed.room.busyInfo || []).find((b) => b.agent === "claude");
  ok("a seat is stoppable from the instant its message is accepted",
    claimed.room.busy.includes("claude") && !!provInfo && !!provInfo.runId,
    JSON.stringify({ busy: claimed.room.busy, busyInfo: claimed.room.busyInfo }));
  ok("busyInfo says which message the seat is answering",
    !!provInfo && !!provRoot && provInfo.sourceN === provRoot.n && provInfo.rootN === provRoot.n &&
    !!provInfo.source && /PROV_DONE/.test(provInfo.source.text) && provInfo.source.kind === "user",
    JSON.stringify(provInfo));
  ok("busy and busyInfo describe the same seats",
    (claimed.room.busyInfo || []).map((b) => b.agent).sort().join() ===
      [...claimed.room.busy].sort().join());

  const staleStop = await api("POST", "/api/stop", { room: "stopscope", agent: "claude", runId: "r-not-a-run" });
  ok("a stale runId is a quiet 200, never an error",
    staleStop.status === 200 && staleStop.data.stale === true && staleStop.data.stopped === false,
    JSON.stringify(staleStop.data));
  ok("…and it leaves the response that is actually running alone",
    (await room("stopscope")).room.busy.includes("claude"));
  d = await idle("stopscope");
  ok("…which then finishes normally", texts(d).includes("PROV_DONE"));

  await say("stopscope", "@claude SLEEP:2500 SAY:PINNED_DONE");
  const pinned = await room("stopscope");
  const liveInfo = (pinned.room.busyInfo || []).find((b) => b.agent === "claude");
  const liveStop = await api("POST", "/api/stop", { room: "stopscope", agent: "claude", runId: liveInfo.runId });
  ok("the current runId stops exactly that response",
    liveStop.status === 200 && liveStop.data.stopped === true && liveStop.data.count === 1 &&
    liveStop.data.stale === false,
    JSON.stringify(liveStop.data));
  d = await idle("stopscope");
  ok("the stopped reply never landed", !texts(d).includes("PINNED_DONE"));
  const repeatStop = await api("POST", "/api/stop", { room: "stopscope", agent: "claude", runId: liveInfo.runId });
  ok("pressing Stop again on a response that already ended stays quiet",
    repeatStop.status === 200 && repeatStop.data.stale === true && repeatStop.data.stopped === false,
    JSON.stringify(repeatStop.data));
  await say("stopscope", "@claude SAY:REF_DONE");
  d = await idle("stopscope");
  const refRoot = d.entries.find((e) => e.kind === "user" && /REF_DONE/.test(e.text));
  ok("a finished reply keeps the reference its live bubble showed",
    lastAgent(d, "claude").meta.replyTo === refRoot.n, JSON.stringify(lastAgent(d, "claude").meta));

  // "Stop current responses, keep queued work" and its mirror.
  await api("POST", "/api/rooms", { name: "keepqueue" });
  await useFakes("keepqueue");
  await say("keepqueue", "@claude SLEEP:2500 SAY:RUNNING_A");
  await sleep(200);
  await say("keepqueue", "@claude SAY:QUEUED_A");
  ok("the second message waits in the busy lane",
    (await room("keepqueue")).room.queued === 1);
  const keepQueue = await api("POST", "/api/stop", { room: "keepqueue", scope: "active" });
  ok("stopping active responses reports what it cut and what it spared",
    keepQueue.status === 200 && keepQueue.data.stopped === true && keepQueue.data.count === 1 &&
    keepQueue.data.cancelled === 0,
    JSON.stringify(keepQueue.data));
  d = await idle("keepqueue");
  ok("…the running reply was cut", !texts(d).includes("RUNNING_A"));
  ok("…and the queued message still got answered", texts(d).includes("QUEUED_A"));

  await api("POST", "/api/rooms", { name: "dropqueue" });
  await useFakes("dropqueue");
  await say("dropqueue", "@claude SLEEP:2500 SAY:RUNNING_B");
  await sleep(200);
  await say("dropqueue", "@claude SAY:QUEUED_B");
  const dropQueue = await api("POST", "/api/stop", { room: "dropqueue", scope: "queue" });
  ok("cancelling the queue touches nothing that is running",
    dropQueue.status === 200 && dropQueue.data.stopped === false && dropQueue.data.cancelled === 1,
    JSON.stringify(dropQueue.data));
  d = await idle("dropqueue");
  ok("…the running reply finished normally", texts(d).includes("RUNNING_B"));
  ok("…and the queued message never ran", !texts(d).includes("QUEUED_B"));

  // One card per dispatch, not per source message: the ✕ must never reach past
  // what the user pointed at.
  await api("POST", "/api/rooms", { name: "queueview" });
  await useFakes("queueview");
  await say("queueview", "@claude SLEEP:2500 SAY:RUNNING_C");
  await sleep(200);
  await say("queueview", "@claude SAY:GROUP_A");
  await say("queueview", "@claude SAY:GROUP_B");
  const qv = await room("queueview");
  const rows = qv.room.queue || [];
  ok("the queue snapshot carries one row per pending delivery", rows.length === 2,
    JSON.stringify(rows));
  ok("each dispatch gets its own cancel scope",
    rows[0].queueGroupId && rows[1].queueGroupId && rows[0].queueGroupId !== rows[1].queueGroupId,
    JSON.stringify(rows.map((r) => r.queueGroupId)));
  ok("…while the jump target stays the message the user sent",
    rows[0].sourceN !== rows[1].sourceN && /GROUP_A/.test(rows[0].text) &&
    rows[0].positions.claude === 1 && rows[1].positions.claude === 2,
    JSON.stringify(rows));
  const cancelOne = await api("POST", "/api/queue/cancel", { room: "queueview", groupId: rows[0].queueGroupId });
  ok("cancelling one dispatch drops only its deliveries",
    cancelOne.status === 200 && cancelOne.data.cancelled === 1 && cancelOne.data.queued === 1,
    JSON.stringify(cancelOne.data));
  d = await idle("queueview");
  ok("…the running response was untouched", texts(d).includes("RUNNING_C"));
  ok("…the cancelled message never ran", !texts(d).includes("GROUP_A"));
  ok("…and the dispatch beside it still did", texts(d).includes("GROUP_B"));
  const cancelGone = await api("POST", "/api/queue/cancel", { room: "queueview", groupId: rows[0].queueGroupId });
  ok("cancelling an already-drained dispatch is not an error",
    cancelGone.status === 200 && cancelGone.data.cancelled === 0);

  // The contract behind "Stop everything": one press, and nothing this exchange
  // would still have spawned — the hop the reply earns, the lurk check after it
  // — ever starts. The reply is allowed to land first and the hop target is held
  // busy, so the chain is genuinely parked in a handoff gap with a follow-up
  // owing when Stop arrives.
  //
  // The control below runs the identical setup without the Stop and shows the
  // hop does land, so the assertion is about Stop and not about the setup.
  for (const [roomName, pressStop] of [["stopfuture", true], ["stopfuture-control", false]]) {
    await api("POST", "/api/rooms", { name: roomName });
    await useFakes(roomName);
    await cfg(roomName, { agents: { codex: { lurk: true } } });
    await say(roomName, "@codex SLEEP:3000 SAY:CODEXBUSY");
    await sleep(150);
    await say(roomName, "@claude TAG:codex");
    // The reply exists and its hop is waiting on the busy seat.
    await waitRoom(roomName,
      (r) => r.entries.some((e) => e.kind === "agent" && e.author === "claude") &&
        !r.room.busy.includes("claude"),
      "the reply to land with its hop still owing");
    if (pressStop) {
      const stopAll = await api("POST", "/api/stop", { room: roomName, scope: "all" });
      ok("Stop everything reports what it interrupted",
        stopAll.status === 200 && stopAll.data.count >= 1, JSON.stringify(stopAll.data));
    }
    d = await idle(roomName);
    await sleep(500); // anything still coming would have to land in this window
    d = await room(roomName);
    const hopped = d.entries.some((e) => e.kind === "agent" && e.author === "codex" && e.meta && e.meta.hop);
    const lurked = d.receipts.some((r) => r.mode === "lurk");
    if (pressStop) {
      ok("the reply that earned the follow-up is still there",
        d.entries.some((e) => e.kind === "agent" && e.author === "claude"), JSON.stringify(texts(d)));
      ok("one Stop everything blocks the follow-up waiting on a busy seat", !hopped, JSON.stringify(texts(d)));
    } else {
      ok("control: without the Stop that same follow-up does run", hopped, JSON.stringify(texts(d)));
    }
    // Nothing is asserted about lurking here: the hop target joins `invoked`
    // and is excluded from the lurker set either way, so it would pass without
    // proving anything. The lurk check gets its own pair below.
  }

  // The lurk check is the other thing an exchange still owes after its reply.
  // No tag, so nobody is pulled in as a hop and the lurker set is genuinely
  // non-empty — the control shows the lurk really does happen, and the Stop
  // variant shows one press ends the exchange before it can.
  for (const [roomName, pressStop] of [["stoplurk", true], ["stoplurk-control", false]]) {
    await api("POST", "/api/rooms", { name: roomName });
    await useFakes(roomName);
    await cfg(roomName, { agents: { codex: { lurk: true } } });
    await say(roomName, "@claude SLEEP:1800 SAY:NOHOPREPLY");
    await waitRoom(roomName, (r) => r.room.busy.includes("claude"), "the reply to start");
    ok(`${pressStop ? "" : "control: "}the lurker seat is free, so nothing but the chain can stop it`,
      !(await room(roomName)).room.busy.includes("codex"));
    if (pressStop) await api("POST", "/api/stop", { room: roomName, scope: "all" });
    d = await idle(roomName);
    await sleep(500);
    d = await room(roomName);
    const lurkRan = d.receipts.some((r) => r.mode === "lurk");
    if (pressStop) ok("one Stop everything blocks the lurk check that was still owing", !lurkRan, JSON.stringify(d.receipts));
    else ok("control: without the Stop that lurk check does run", lurkRan, JSON.stringify(d.receipts));
  }

  // Cancelling a queued message must end its exchange, not just its delivery:
  // a lurker chiming in about a message the user cancelled is the bug.
  await api("POST", "/api/rooms", { name: "cancelchime" });
  await useFakes("cancelchime");
  await cfg("cancelchime", { agents: { codex: { lurk: true } } });
  await say("cancelchime", "@claude SLEEP:2500 SAY:HOLDING");
  await sleep(200);
  await say("cancelchime", "@claude CHIME SAY:CANCEL_THIS");
  const chimeQueue = (await room("cancelchime")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "cancelchime", groupId: chimeQueue[0].queueGroupId });
  d = await idle("cancelchime");
  await sleep(400);
  d = await room("cancelchime");
  ok("a cancelled dispatch never runs its delivery", !texts(d).includes("CANCEL_THIS"));
  ok("…and the transcript records that it was not delivered",
    d.entries.some((e) => e.kind === "system" && e.meta && e.meta.cancelledQueue &&
      /was not delivered to claude/.test(e.text) && !/never/.test(e.text)),
    JSON.stringify(texts(d, "system")));
  ok("…while the response it was queued behind still finished", texts(d).includes("HOLDING"));
  // Note: a *concurrent* exchange's lurker can still see the cancelled message,
  // because the message really was sent and has been in the shared transcript
  // since the moment it was accepted. Cancelling withdraws the delivery, not
  // the record — hence the system note above. What must not happen is the
  // cancelled dispatch running downstream work of its own, which is next.

  // A dispatch whose every delivery was cancelled ends its own chain: no hop,
  // no lurk check. The lurker is deliberately left *free* here — its seat is
  // idle the whole time the cancelled chain is unwinding, so nothing but the
  // chain itself can be what stops the lurk step from running.
  await api("POST", "/api/rooms", { name: "cancelchain" });
  await useFakes("cancelchain");
  await cfg("cancelchain", { agents: { codex: { lurk: true } } });
  await say("cancelchain", "@claude SLEEP:2600 SAY:CLAUDEHELD");
  await sleep(200);
  await say("cancelchain", "@claude SAY:CHAIN_CANCELLED");
  const chainQueue = (await room("cancelchain")).room.queue;
  const cancelledN = chainQueue[0].sourceN;
  ok("the lurker seat is free while the cancelled chain unwinds",
    !(await room("cancelchain")).room.busy.includes("codex"));
  await api("POST", "/api/queue/cancel", { room: "cancelchain", groupId: chainQueue[0].queueGroupId });
  d = await idle("cancelchain");
  ok("a cancelled dispatch does no downstream work of its own",
    !texts(d).includes("CHAIN_CANCELLED") &&
    !d.receipts.some((r) => r.mode === "lurk" && r.turn === cancelledN),
    JSON.stringify(d.receipts.filter((r) => r.mode === "lurk")));

  // The other half of that rule: a split @both whose held half is cancelled
  // keeps the chain the seat that already answered earned.
  await api("POST", "/api/rooms", { name: "splitcancel" });
  await useFakes("splitcancel");
  await say("splitcancel", "@codex SLEEP:2500 SAY:BUSYSEAT");
  await sleep(200);
  await say("splitcancel", "@both TAG:codex");
  const splitQueue = (await room("splitcancel")).room.queue;
  ok("a split @both holds one delivery and counts as one message",
    splitQueue.length === 1 && (await room("splitcancel")).room.queuedDispatches === 1,
    JSON.stringify(splitQueue));
  await api("POST", "/api/queue/cancel", { room: "splitcancel", groupId: splitQueue[0].queueGroupId });
  d = await idle("splitcancel");
  ok("cancelling the held half leaves the half that already ran",
    d.entries.some((e) => e.kind === "agent" && e.author === "claude"));
  ok("…and the surviving half still earns its follow-up",
    d.entries.some((e) => e.kind === "agent" && e.author === "codex" && e.meta && e.meta.hop),
    JSON.stringify(texts(d)));

  // "Stop the current responses" must not kill a response that started after
  // the click: the request carries the runs that were on screen.
  await api("POST", "/api/rooms", { name: "pinnedactive" });
  await useFakes("pinnedactive");
  await say("pinnedactive", "@claude SLEEP:1500 SAY:FIRST_RUN");
  const pinnedSnapshot = (await room("pinnedactive")).room.busyInfo;
  d = await idle("pinnedactive");
  // The replacement earns a follow-up, so the stale click is checked against
  // the whole exchange and not just the one reply it would have killed.
  await say("pinnedactive", "@claude SLEEP:1500 TAG:codex");
  const stalePin = await api("POST", "/api/stop", {
    room: "pinnedactive", scope: "active",
    runs: pinnedSnapshot.map((b) => ({ agent: b.agent, runId: b.runId })),
  });
  ok("an active Stop pinned to a finished run stops nothing",
    stalePin.status === 200 && stalePin.data.stopped === false && stalePin.data.stale === true,
    JSON.stringify(stalePin.data));
  d = await idle("pinnedactive");
  ok("…so the response that started afterwards survives it",
    d.entries.some((e) => e.kind === "agent" && e.author === "claude"), JSON.stringify(texts(d)));
  ok("…along with the follow-up that response earned",
    d.entries.some((e) => e.kind === "agent" && e.author === "codex" && e.meta && e.meta.hop),
    JSON.stringify(texts(d)));

  // A lurker you stopped is not a lurker that broke.
  for (const [roomName, stopBody] of [
    ["lurkstopseat", { agent: "codex" }],
    ["lurkstopactive", { scope: "active" }],
    ["lurkstopall", { scope: "all" }],
  ]) {
    await api("POST", "/api/rooms", { name: roomName });
    await useFakes(roomName);
    await cfg(roomName, { agents: { codex: { lurk: true } } });
    await say(roomName, "@claude SLEEP:1600 SAY:LURKWAIT");
    await waitRoom(roomName, (r) => r.room.busy.includes("codex"), "the lurker to start");
    await api("POST", "/api/stop", { room: roomName, ...stopBody });
    d = await idle(roomName);
    ok(`a lurker stopped by ${stopBody.scope || "seat"} scope reads as stopped, not failed`,
      d.entries.some((e) => e.kind === "system" && e.meta && e.meta.stopped === true &&
        e.meta.agent === "codex" && e.meta.error === false) &&
      !d.entries.some((e) => e.kind === "system" && e.meta && e.meta.error === true),
      JSON.stringify(d.entries.filter((e) => e.kind === "system").map((e) => e.text)));
  }

  // A cancelled message stays in the transcript, because the user really did
  // send it — so the withdrawal has to travel with it into every later prompt,
  // or "nobody received this" quietly stops being true on the next turn.
  await api("POST", "/api/rooms", { name: "cancelrecall" });
  await useFakes("cancelrecall");
  await say("cancelrecall", "@claude SLEEP:2400 SAY:RECALLHOLD");
  await sleep(200);
  await say("cancelrecall", "@claude SAY:WITHDRAWNBODY");
  const recallQueue = (await room("cancelrecall")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "cancelrecall", groupId: recallQueue[0].queueGroupId });
  d = await idle("cancelrecall");
  await say("cancelrecall", "@claude ACTIVITY");
  d = await idle("cancelrecall");
  const recalled = lastAgent(d, "claude").text;
  ok("the seat that never received a message is not handed its body later",
    !/WITHDRAWNBODY/.test(recalled), recalled.slice(0, 500));
  ok("…it is told a message was withdrawn, and nothing more",
    /cancelled it before it was delivered/.test(recalled) &&
    /contents were withheld from you/.test(recalled), recalled.slice(0, 500));
  ok("…and the withdrawal survives a reload of the room",
    JSON.parse(fs.readFileSync(path.join(ROOT, "cancelrecall", "state.json"), "utf8"))
      .cancelledDeliveries[String(recallQueue[0].sourceN)].includes("claude"));

  // Attachments go the same way as the body: withholding the text while still
  // staging the file would withhold nothing at all. IMAGEINFO/FILEINFO report
  // what the provider actually received, which is the only thing that settles
  // whether bytes leaked — the prompt text cannot see a native image at all.
  //
  // One probe per room on purpose: the withheld entry is unseen only on the
  // first turn after the cancel, so probes sharing a room would silently start
  // asserting about an empty delta.
  for (const probe of ["IMAGEINFO", "FILEINFO", "ACTIVITY"]) {
    const roomName = `cancelbytes-${probe.toLowerCase()}`;
    await api("POST", "/api/rooms", { name: roomName });
    await useFakes(roomName);
    await say(roomName, "@claude SLEEP:2400 SAY:BYTESHOLD");
    await sleep(200);
    const queued = await api("POST", "/api/message", {
      room: roomName, target: "claude", text: "@claude SAY:BYTESBODY",
      images: [{ name: "secret.png", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
      files: [{ name: "secret.txt", mime: "text/plain", data: Buffer.from("SECRETFILEBODY").toString("base64") }],
    });
    ok(`${probe}: the attachment-carrying message was accepted and queued`,
      queued.status === 200, JSON.stringify(queued.data));
    const bytesQueue = (await room(roomName)).room.queue;
    await api("POST", "/api/queue/cancel", { room: roomName, groupId: bytesQueue[0].queueGroupId });
    d = await idle(roomName);
    await say(roomName, `@claude ${probe}`);
    d = await idle(roomName);
    const said = lastAgent(d, "claude").text;
    if (probe === "IMAGEINFO") {
      const gotImages = JSON.parse(said.replace(/^IMAGEJSON /, ""));
      ok("no image from a withheld message reaches the provider's native input",
        Array.isArray(gotImages) && gotImages.length === 0, said.slice(0, 300));
    } else if (probe === "FILEINFO") {
      const gotFiles = JSON.parse(said.replace(/^FILEJSON /, ""));
      ok("…and no file is staged for it either",
        Array.isArray(gotFiles) && gotFiles.length === 0, said.slice(0, 300));
    } else {
      ok("the withheld message is still relayed as a placeholder, so this is not an empty delta",
        /contents were withheld from you/.test(said) && !/BYTESBODY/.test(said), said.slice(0, 500));
      ok("…with no attachment name, path or inline bytes beside it",
        !/secret\.png/.test(said) && !/secret\.txt/.test(said) &&
        !/SECRETFILEBODY/.test(said) && !/Attached/.test(said), said.slice(0, 500));
    }
  }

  // A session reset replays history through the briefing rather than the delta,
  // so it needs the same rule — and it is the one path that used to leak the
  // attachment names of a message the seat never received.
  await api("POST", "/api/rooms", { name: "cancelrecover" });
  await useFakes("cancelrecover");
  await say("cancelrecover", "@claude SLEEP:2400 SAY:RECOVERHOLD");
  await sleep(200);
  await api("POST", "/api/message", {
    room: "cancelrecover", target: "claude", text: "@claude SAY:RECOVERBODY",
    files: [{ name: "leak.txt", mime: "text/plain", data: Buffer.from("LEAKEDFILEBODY").toString("base64") }],
  });
  const recoverQueue = (await room("cancelrecover")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "cancelrecover", groupId: recoverQueue[0].queueGroupId });
  d = await idle("cancelrecover");
  // First deliver the placeholder on an ordinary successful turn. That moves
  // Claude's cursor past the withdrawn entry, making it eligible for
  // historyTail on the subsequent session reset. Use a reply that does not echo
  // its activity block, so the later placeholder can only come from historyTail.
  await say("cancelrecover", "@claude SAY:RECOVERACK");
  d = await idle("cancelrecover");
  ok("the recovery setup advances the seat past the withdrawn entry",
    lastAgent(d, "claude").text === "RECOVERACK", lastAgent(d, "claude").text);
  await say("cancelrecover", "@claude MISSINGSESSION SAWWHAT");
  d = await idle("cancelrecover");
  const saw = JSON.parse(lastAgent(d, "claude").text.replace(/^SAWJSON /, ""));
  ok("the recovery replay reaches the agent at all",
    /RECOVERHOLD/.test(saw.briefing), saw.briefing.slice(0, 300));
  ok("…and actually replays the withdrawn entry as a placeholder",
    /contents were withheld from you/.test(saw.briefing), saw.briefing.slice(0, 800));
  ok("…without the body of the message that was never delivered",
    !/RECOVERBODY/.test(saw.briefing), saw.briefing.slice(0, 800));
  ok("…and without its attachment name, type or size",
    !/leak\.txt/.test(saw.briefing) && !/LEAKEDFILEBODY/.test(saw.briefing) &&
    !/Attached/.test(saw.briefing), saw.briefing.slice(0, 800));

  // The half of a split @both that was already delivered has read the message
  // and moved past it. The cancellation of its sibling has to reach it anyway.
  await api("POST", "/api/rooms", { name: "splitnotice" });
  await useFakes("splitnotice");
  await say("splitnotice", "@codex SLEEP:2600 SAY:CODEXBUSY");
  await sleep(200);
  // SPLITSECRET rides only on the user's message; the reply echoes SPLITREPLY.
  // Without a token the reply cannot repeat, "no body" would be untestable.
  await say("splitnotice", "@both SPLITSECRET SAY:SPLITREPLY");
  const splitNoticeQueue = (await room("splitnotice")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "splitnotice", groupId: splitNoticeQueue[0].queueGroupId });
  d = await idle("splitnotice");
  // The withheld seat goes first: an ACTIVITY reply echoes the delta into the
  // transcript, so probing the delivered half first would put the body into
  // ordinary context and make the next assertion meaningless.
  await say("splitnotice", "@codex ACTIVITY");
  d = await idle("splitnotice");
  const withheldSaw = lastAgent(d, "codex").text;
  ok("the seat it was withheld from gets the placeholder and no body",
    !/SPLITSECRET/.test(withheldSaw) && /withheld from you/.test(withheldSaw),
    withheldSaw.slice(0, 600));
  await say("splitnotice", "@claude ACTIVITY");
  d = await idle("splitnotice");
  const siblingSaw = lastAgent(d, "claude").text;
  const siblingActivity = JSON.parse(siblingSaw.replace(/^ACTIVITY /, ""));
  const siblingNoticeLine = siblingActivity.split(/\r?\n/).find((line) =>
    /^\(the user cancelled delivery of message #\d+ to codex before it started;/.test(line)) || "";
  ok("the delivered half is told its sibling delivery was cancelled",
    /codex did not receive it/.test(siblingNoticeLine), siblingActivity.slice(0, 600));
  ok("…without telling the delivered half to disregard its own copy",
    !/treat it as withdrawn/.test(siblingNoticeLine) && !/withheld from you/.test(siblingNoticeLine),
    siblingNoticeLine);

  // Cancel-all can drop unrelated dispatches for different seats in one call.
  // The notice must retain each source→seat pairing; independent unions create
  // a false cross-product, and a partial Retry must remove only its own record.
  await api("POST", "/api/rooms", { name: "cancelmixed" });
  await useFakes("cancelmixed");
  await say("cancelmixed", "@claude SLEEP:2400 SAY:MIXHOLDCLAUDE");
  await say("cancelmixed", "@codex SLEEP:2400 SAY:MIXHOLDCODEX");
  await waitRoom("cancelmixed",
    (x) => x.room.busy.includes("claude") && x.room.busy.includes("codex"), "both mixed-cancel seats busy");
  await say("cancelmixed", "@claude SAY:MIXCLAUDEONLY");
  await say("cancelmixed", "@codex SAWWHAT MIXCODEXONLY");
  const mixedQueue = (await room("cancelmixed")).room.queue;
  const mixedClaude = mixedQueue.find((item) => /MIXCLAUDEONLY/.test(item.text));
  const mixedCodex = mixedQueue.find((item) => /MIXCODEXONLY/.test(item.text));
  const mixedClaudeN = mixedClaude?.sourceN;
  const mixedCodexN = mixedCodex?.sourceN;
  ok("mixed-target messages are independently queued before Cancel all",
    mixedQueue.length === 2 && mixedClaude?.agents.join() === "claude" && mixedCodex?.agents.join() === "codex",
    JSON.stringify(mixedQueue));
  await api("POST", "/api/queue/cancel", { room: "cancelmixed" });
  d = await room("cancelmixed");
  const mixedNotice = [...d.entries].reverse().find((e) => e.meta && e.meta.cancelledQueue);
  const mixedRecords = (mixedNotice?.meta?.withdrawals || []).map((record) => ({
    sourceN: record.sourceN, agents: [...record.agents].sort(),
  }));
  const mixedNoticeText = String(mixedNotice?.text || "");
  ok("Cancel all preserves the source-to-seat mapping in its durable notice",
    mixedRecords.length === 2 &&
      mixedRecords.some((record) => record.sourceN === mixedClaudeN && record.agents.join() === "claude") &&
      mixedRecords.some((record) => record.sourceN === mixedCodexN && record.agents.join() === "codex"),
    JSON.stringify(mixedNotice));
  ok("…and its user-visible text does not cross-product those mappings",
    mixedNoticeText.includes(`message #${mixedClaudeN} was not delivered to claude`) &&
      mixedNoticeText.includes(`message #${mixedCodexN} was not delivered to codex`) &&
      !mixedNoticeText.includes(`message #${mixedClaudeN} was not delivered to codex`) &&
      !mixedNoticeText.includes(`message #${mixedCodexN} was not delivered to claude`), mixedNoticeText);
  d = await idle("cancelmixed");
  const mixedRetry = await api("POST", "/api/retry", { room: "cancelmixed" });
  ok("one dispatch from a mixed Cancel-all can be retried", mixedRetry.status === 200, JSON.stringify(mixedRetry.data));
  d = await idle("cancelmixed");
  const mixedSaw = JSON.parse(lastAgent(d, "codex").text.replace(/^SAWJSON /, ""));
  const mixedState = JSON.parse(fs.readFileSync(path.join(ROOT, "cancelmixed", "state.json"), "utf8"));
  ok("partial Retry clears only its source-to-seat withdrawal",
    !mixedState.cancelledDeliveries[String(mixedCodexN)] &&
      (mixedState.cancelledDeliveries[String(mixedClaudeN)] || []).join() === "claude",
    JSON.stringify(mixedState.cancelledDeliveries));
  ok("…and no live notice still claims the retried message was withheld",
    /MIXCODEXONLY/.test(mixedSaw.prompt) &&
      !mixedSaw.prompt.includes(`message #${mixedCodexN}`) &&
      !/contents were withheld from you/.test(mixedSaw.prompt) &&
      /cancelled delivery of this message to claude before it started/.test(mixedSaw.prompt),
    mixedSaw.prompt.slice(0, 1000));

  // Stop-everything drops the queue too, and those messages were never
  // delivered either — so they must not come back as actionable context.
  await api("POST", "/api/rooms", { name: "stopallwithdraw" });
  await useFakes("stopallwithdraw");
  await say("stopallwithdraw", "@claude SLEEP:2400 SAY:STOPALLHOLD");
  await sleep(200);
  await say("stopallwithdraw", "@claude SAY:STOPALLBODY");
  ok("the message is queued when Stop everything arrives",
    (await room("stopallwithdraw")).room.queued === 1);
  await api("POST", "/api/stop", { room: "stopallwithdraw", scope: "all" });
  d = await idle("stopallwithdraw");
  ok("Stop everything records the queue it dropped as withdrawn",
    d.entries.some((e) => e.kind === "system" && e.meta && e.meta.cancelledQueue),
    JSON.stringify(texts(d, "system")));
  await say("stopallwithdraw", "@claude ACTIVITY");
  d = await idle("stopallwithdraw");
  ok("…and that withdrawal survives into the seat's next turn",
    !/STOPALLBODY/.test(lastAgent(d, "claude").text) &&
    /contents were withheld from you/.test(lastAgent(d, "claude").text),
    lastAgent(d, "claude").text.slice(0, 500));

  // Retry delivers it after all, so the record of it never arriving has to go.
  await api("POST", "/api/rooms", { name: "cancelretry" });
  await useFakes("cancelretry");
  const retrySummaries = await watchRoomSummaries("cancelretry");
  await say("cancelretry", "@claude SLEEP:2400 SAY:RETRYHOLD");
  await sleep(200);
  await say("cancelretry", "@claude SLEEP:2400 SAY:RETRYBODY");
  const retryQueue = (await room("cancelretry")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "cancelretry", groupId: retryQueue[0].queueGroupId });
  const retrySource = String(retryQueue[0].sourceN);
  const cancelSyncUntil = Date.now() + 1200;
  while (!retrySummaries.seen.some((s) =>
    (s.cancelledDeliveries?.[retrySource] || []).includes("claude") && s.busy.includes("claude")) &&
      Date.now() < cancelSyncUntil) await sleep(25);
  ok("cancelling broadcasts the withheld receipt state while the current response is still running",
    retrySummaries.seen.some((s) =>
      (s.cancelledDeliveries?.[retrySource] || []).includes("claude") && s.busy.includes("claude")),
    JSON.stringify(retrySummaries.seen.map((s) => ({ busy: s.busy, cancelled: s.cancelledDeliveries }))));
  d = await idle("cancelretry");
  const summariesBeforeRetry = retrySummaries.seen.length;
  const cancelRetried = await api("POST", "/api/retry", { room: "cancelretry" });
  ok("a cancelled message can be retried", cancelRetried.status === 200, JSON.stringify(cancelRetried.data));
  await waitRoom("cancelretry", (x) => x.room.busy.includes("claude"), "retried delivery running");
  const retrySyncUntil = Date.now() + 900;
  while (!retrySummaries.seen.slice(summariesBeforeRetry).some((s) => !s.cancelledDeliveries?.[retrySource]) &&
      Date.now() < retrySyncUntil) await sleep(25);
  ok("Retry broadcasts the cleared withdrawal before the retried response finishes",
    retrySummaries.seen.slice(summariesBeforeRetry).some((s) => !s.cancelledDeliveries?.[retrySource]) &&
      (await room("cancelretry")).room.busy.includes("claude"),
    JSON.stringify(retrySummaries.seen.slice(summariesBeforeRetry)
      .map((s) => ({ busy: s.busy, cancelled: s.cancelledDeliveries }))));
  d = await idle("cancelretry");
  await retrySummaries.stop();
  ok("…and Retry actually delivers it", texts(d).includes("RETRYBODY"), JSON.stringify(texts(d)));
  ok("…leaving no withdrawal marker behind",
    !(JSON.parse(fs.readFileSync(path.join(ROOT, "cancelretry", "state.json"), "utf8"))
      .cancelledDeliveries || {})[String(retryQueue[0].sourceN)]);
  // Claude's own cursor has moved past it now, so ask the seat that still has
  // it unseen: its delta is where a stale withdrawal marker would show up.
  await say("cancelretry", "@codex ACTIVITY");
  d = await idle("cancelretry");
  const afterRetry = lastAgent(d, "codex").text;
  ok("…so later history stops claiming it was never delivered",
    !/cancelled/.test(afterRetry) && !/withheld/.test(afterRetry), afterRetry.slice(0, 500));
  ok("…and it reads as an ordinary delivered message from then on",
    /RETRYBODY/.test(afterRetry), afterRetry.slice(0, 500));

  // The other seat is told who never got it, without being told to ignore it.
  await api("POST", "/api/rooms", { name: "cancelother" });
  await useFakes("cancelother");
  await say("cancelother", "@claude SLEEP:2400 SAY:OTHERHOLD");
  await sleep(200);
  await say("cancelother", "@claude SAY:OTHERWITHDRAWN");
  const otherQueue = (await room("cancelother")).room.queue;
  await api("POST", "/api/queue/cancel", { room: "cancelother", groupId: otherQueue[0].queueGroupId });
  d = await idle("cancelother");
  await say("cancelother", "@codex ACTIVITY");
  d = await idle("cancelother");
  const otherSaw = lastAgent(d, "codex").text;
  const otherActivity = JSON.parse(otherSaw.replace(/^ACTIVITY /, ""));
  const otherMessageLine = otherActivity.split(/\r?\n/).find((line) => /OTHERWITHDRAWN/.test(line)) || "";
  ok("the other seat is told who never received it, not told to ignore it",
    /cancelled delivery of this message to claude before it started/.test(otherMessageLine) &&
    !/withheld from you/.test(otherMessageLine), otherMessageLine);
  ok("…and still receives the body, because nothing was withheld from it",
    /OTHERWITHDRAWN/.test(otherMessageLine), otherMessageLine);

  // A queued pair turn is one cycle owed to both seats, so cancelling it
  // withdraws it from both — and pair Retry has to clear both again, or the
  // seats that just did the work still read "withheld from you" afterwards.
  await api("POST", "/api/rooms", { name: "pairretrycancel" });
  await useFakes("pairretrycancel");
  const pairState = () => JSON.parse(
    fs.readFileSync(path.join(ROOT, "pairretrycancel", "state.json"), "utf8"));
  await say("pairretrycancel", "/pair start @claude");
  await say("pairretrycancel", "SLEEP:1500 SAY:PAIRWORK");
  await sleep(300);
  await say("pairretrycancel", "SAY:PAIRQUEUED");
  const pairQueue = (await room("pairretrycancel")).room.queue;
  ok("a pair turn waits as one whole cycle, not per seat",
    pairQueue.length === 1 && pairQueue[0].kind === "cycle" && pairQueue[0].agents.length === 2,
    JSON.stringify(pairQueue));
  await api("POST", "/api/queue/cancel", { room: "pairretrycancel", groupId: pairQueue[0].queueGroupId });
  const pairSourceN = String(pairQueue[0].sourceN);
  ok("cancelling it withdraws the message from both seats",
    (pairState().cancelledDeliveries[pairSourceN] || []).slice().sort().join() === "claude,codex",
    JSON.stringify(pairState().cancelledDeliveries));
  d = await idle("pairretrycancel");
  const pairRetried = await api("POST", "/api/retry", { room: "pairretrycancel" });
  ok("a cancelled pair turn can be retried", pairRetried.status === 200, JSON.stringify(pairRetried.data));
  d = await idle("pairretrycancel");
  ok("…and pair Retry clears the withdrawal for both seats",
    !pairState().cancelledDeliveries[pairSourceN], JSON.stringify(pairState().cancelledDeliveries));
  ok("…having actually run the retried cycle", texts(d).includes("PAIRQUEUED"), JSON.stringify(texts(d)));

  // A follow-up answers the reply that mentioned it, not the user's message —
  // which is exactly when the quote header earns its space.
  await api("POST", "/api/rooms", { name: "replyref" });
  await useFakes("replyref");
  await say("replyref", "@claude TAG:codex"); // the @tag appears in the reply, not the message
  d = await idle("replyref");
  const refUser = d.entries.find((e) => e.kind === "user");
  const refTrigger = d.entries.find((e) => e.kind === "agent" && e.author === "claude");
  const refHop = d.entries.find((e) => e.kind === "agent" && e.author === "codex");
  ok("a follow-up records the reply it answered and the root it hangs off",
    !!refHop && !!refTrigger && refHop.meta.replyTo === refTrigger.n &&
    refHop.meta.replyRoot === refUser.n,
    JSON.stringify(refHop && refHop.meta));

  if (process.env.PARLEY_SKIP_NATIVE_KILL !== "1") {
    await api("POST", "/api/rooms", { name: "stoptree" });
    await useFakes("stoptree");
    const stopWorkspace = path.join(ROOT, "stoptree", "workspace");
    const childReady = path.join(stopWorkspace, ".fake-cli-child-ready-STOPTREE");
    const childSurvived = path.join(stopWorkspace, ".fake-cli-child-survived-STOPTREE");
    await say("stoptree", "@claude SPAWNCHILD:STOPTREE SLEEP:5000");
    await waitFile(childReady, "fake CLI descendant to start");
    const stopped = await api("POST", "/api/stop", { room: "stoptree" });
    ok("Stop reports the running CLI", stopped.status === 200 && stopped.data.count === 1,
      JSON.stringify(stopped.data));
    await idle("stoptree");
    await sleep(1300);
    ok("Stop kills the CLI's descendant process too", !fs.existsSync(childSurvived), childSurvived);
  }

  console.log("\nwork mode & activity lines");
  await api("POST", "/api/rooms", { name: "workroom" });
  await useFakes("workroom");
  await cfg("workroom", { mode: "work" });
  d = await room("workroom");
  ok("mode switch is recorded", d.room.cfg.mode === "work");
  await say("workroom", "@claude ARGS");
  d = await idle("workroom");
  ok("work mode grants claude acceptEdits", /--permission-mode acceptEdits/.test(lastAgent(d, "claude").text));
  await say("workroom", "@claude WRITE:made-by-claude.txt");
  d = await idle("workroom");
  ok("tool use becomes an activity line", d.entries.some((e) => e.kind === "activity" && e.text.includes("made-by-claude.txt")));
  ok("the file really exists", fs.existsSync(path.join(ROOT, "workroom", "workspace", "made-by-claude.txt")));
  await say("workroom", "@codex WRITE:made-by-codex.txt");
  d = await idle("workroom");
  ok("codex writes in work mode too", fs.existsSync(path.join(ROOT, "workroom", "workspace", "made-by-codex.txt")));
  await say("workroom", "@both WRITE:should-not-exist.txt");
  d = await idle("workroom");
  ok("@both in a work room writes nothing", !fs.existsSync(path.join(ROOT, "workroom", "workspace", "should-not-exist.txt")));
  ok("discussion scope is relayed to both", d.entries.filter((e) => e.kind === "agent" && /Proposing to create/.test(e.text)).length === 2);

  const beforeUnsafeArgs = JSON.stringify((await room("workroom")).room.cfg.agents);
  const claudeDanger = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--dangerously-skip-permissions"] } },
  });
  const codexDanger = await cfg("workroom", {
    agents: { codex: { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] } },
  });
  const claudeBypass = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--permission-mode", "bypassPermissions"] } },
  });
  const claudeBypassEquals = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--permission-mode=bypassPermissions"] } },
  });
  const duplicatePermission = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--permission-mode", "plan", "--permission-mode=acceptEdits"] } },
  });
  const missingPermissionValue = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--permission-mode", "--model", "sonnet"] } },
  });
  const invalidPermission = await cfg("workroom", {
    agents: { claude: { permissionMode: "unlimitedMagic" } },
  });
  ok("dangerous CLI bypass flags are rejected",
    claudeDanger.status === 400 && codexDanger.status === 400 && claudeBypass.status === 400 &&
    claudeBypassEquals.status === 400,
    JSON.stringify({ claude: claudeDanger.data, codex: codexDanger.data,
      bypass: claudeBypass.data, bypassEquals: claudeBypassEquals.data }));
  ok("duplicate or malformed Claude permission overrides are rejected",
    duplicatePermission.status === 400 && missingPermissionValue.status === 400,
    JSON.stringify({ duplicate: duplicatePermission.data, missing: missingPermissionValue.data }));
  ok("unknown structured Claude permission modes are rejected", invalidPermission.status === 400,
    JSON.stringify(invalidPermission.data));
  ok("rejected bypass args leave room permissions unchanged",
    JSON.stringify((await room("workroom")).room.cfg.agents) === beforeUnsafeArgs);

  const safePermission = await cfg("workroom", {
    agents: { claude: { extraArgs: ["--permission-mode", "acceptEdits"] } },
  });
  ok("a named-turn permission override remains configurable", safePermission.status === 200,
    JSON.stringify(safePermission.data));
  await say("workroom", "@both ARGS");
  d = await idle("workroom");
  ok("discussion forces plan over a configured claude write override",
    /--permission-mode plan/.test(lastAgent(d, "claude").text) &&
    !/--permission-mode acceptEdits/.test(lastAgent(d, "claude").text),
    lastAgent(d, "claude").text.slice(0, 90));
  await cfg("workroom", { agents: { claude: { extraArgs: [] } } });

  console.log("\nClaude full access boundaries");
  await api("POST", "/api/rooms", { name: "claudefull" });
  await useFakes("claudefull");
  await cfg("claudefull", { mode: "work" });
  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  ok("Claude has a normal session before elevation", d.room.agents.claude.linked === true);

  const fullAccess = await cfg("claudefull", {
    agents: { claude: { permissionMode: "bypassPermissions" } },
  });
  d = await room("claudefull");
  ok("structured Claude Full access is accepted", fullAccess.status === 200 &&
    d.room.cfg.agents.claude.permissionMode === "bypassPermissions");
  ok("enabling Full access resets Claude and leaves an audit note",
    d.room.agents.claude.linked === false &&
    d.entries.some((e) => e.kind === "system" && e.text.includes("Claude Full access enabled")));
  const elevatedState = JSON.parse(fs.readFileSync(path.join(ROOT, "claudefull", "state.json"), "utf8"));
  ok("the saved Claude session provenance records Full access",
    elevatedState.agents.claude.permissionScope === "bypassPermissions");

  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  let fullArgv = argvFrom(lastAgent(d, "claude"));
  ok("ordinary Claude turns receive the structured bypass mode",
    hasArg(fullArgv, "--permission-mode", "bypassPermissions") && !fullArgv.includes("--resume"),
    JSON.stringify(fullArgv));
  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  fullArgv = argvFrom(lastAgent(d, "claude"));
  ok("resumed ordinary turns keep receiving the bypass flag",
    hasArg(fullArgv, "--permission-mode", "bypassPermissions") && fullArgv.includes("--resume"),
    JSON.stringify(fullArgv));

  await say("claudefull", "@claude SAY:FULLACCESS_ORIGIN");
  d = await idle("claudefull");
  ok("the live Full-access session has context worth preserving",
    lastAgent(d, "claude").text === "FULLACCESS_ORIGIN" && d.room.agents.claude.linked === true);

  await say("claudefull", "@both ARGJSON");
  d = await idle("claudefull");
  let protectedArgv = argvFrom(lastAgent(d, "claude"));
  ok("a protected @both turn uses an isolated Plan invocation",
    hasArg(protectedArgv, "--permission-mode", "plan") &&
    !hasArg(protectedArgv, "--permission-mode", "bypassPermissions") &&
    !protectedArgv.includes("--resume"), JSON.stringify(protectedArgv));
  ok("the isolated @both turn is briefed with prior room history",
    argValue(protectedArgv, "--append-system-prompt").includes("FULLACCESS_ORIGIN"));
  ok("the bypass-enabled native session is discarded after a protected turn",
    d.room.agents.claude.linked === false);

  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  fullArgv = argvFrom(lastAgent(d, "claude"));
  ok("the ordinary turn after isolation starts fresh in Full access",
    hasArg(fullArgv, "--permission-mode", "bypassPermissions") && !fullArgv.includes("--resume"),
    JSON.stringify(fullArgv));
  ok("the ordinary turn after isolation is re-briefed from room history",
    argValue(fullArgv, "--append-system-prompt").includes("FULLACCESS_ORIGIN"));

  const beforeHandoff = d.entries.length;
  await say("claudefull", "@codex TAGHOP:claude");
  d = await idle("claudefull");
  const handoffEntry = d.entries.slice(beforeHandoff).find((e) =>
    e.author === "claude" && e.meta && e.meta.hop);
  const handoffArgv = argvFrom(handoffEntry);
  ok("an ordinary agent handoff to Claude inherits Full access",
    hasArg(handoffArgv, "--permission-mode", "bypassPermissions"), JSON.stringify(handoffArgv));

  await say("claudefull", "@claude SAY:LISTENER_ORIGIN");
  d = await idle("claudefull");
  await cfg("claudefull", { agents: { claude: { lurk: true } } });
  ok("Claude has a live Full-access session before listener isolation",
    (await room("claudefull")).room.agents.claude.linked === true);
  await say("claudefull", "@codex LURKARGS");
  d = await idle("claudefull");
  const lurkEntry = [...d.entries].reverse().find((e) => e.author === "claude" && e.meta && e.meta.lurk);
  protectedArgv = argvFrom(lurkEntry);
  ok("a Full-access Claude listener is isolated in Plan",
    hasArg(protectedArgv, "--permission-mode", "plan") &&
    !hasArg(protectedArgv, "--permission-mode", "bypassPermissions") &&
    !protectedArgv.includes("--resume"), JSON.stringify(protectedArgv));
  ok("the isolated listener receives prior room history",
    argValue(protectedArgv, "--append-system-prompt").includes("LISTENER_ORIGIN"));
  ok("listener isolation discards the ordinary Full-access session",
    d.room.agents.claude.linked === false);
  await cfg("claudefull", { agents: { claude: { lurk: false } } });

  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  ok("Claude is re-seeded in Full access before reviewer isolation",
    d.room.agents.claude.linked === true &&
    hasArg(argvFrom(lastAgent(d, "claude")), "--permission-mode", "bypassPermissions"));
  await say("claudefull", "@claude SAY:REVIEW_ORIGIN");
  d = await idle("claudefull");
  await say("claudefull", "/pair start 1 @codex REVIEWARGS");
  d = await idle("claudefull");
  const reviewEntry = [...d.entries].reverse().find((e) =>
    e.author === "claude" && e.meta && e.meta.pair === "review");
  protectedArgv = argvFrom(reviewEntry);
  ok("a Full-access Claude pair reviewer is isolated in Plan",
    hasArg(protectedArgv, "--permission-mode", "plan") &&
    !hasArg(protectedArgv, "--permission-mode", "bypassPermissions") &&
    !protectedArgv.includes("--resume"), JSON.stringify(protectedArgv));
  ok("the isolated reviewer receives prior room history",
    argValue(protectedArgv, "--append-system-prompt").includes("REVIEW_ORIGIN"));
  ok("reviewer isolation discards the ordinary Full-access session",
    d.room.agents.claude.linked === false);
  await say("claudefull", "/pair end");

  const beforeWorker = d.entries.length;
  await say("claudefull", "/pair start 1 @claude ARGJSON");
  d = await idle("claudefull");
  const workerEntry = d.entries.slice(beforeWorker).find((e) =>
    e.kind === "agent" && e.author === "claude" && String(e.text).startsWith("ARGVJSON "));
  const workerArgv = argvFrom(workerEntry);
  ok("Claude as the ordinary pair worker inherits Full access",
    hasArg(workerArgv, "--permission-mode", "bypassPermissions"), JSON.stringify(workerArgv));
  await say("claudefull", "/pair end");

  await cfg("claudefull", {
    agents: { claude: { permissionMode: "bypassPermissions", extraArgs: ["--permission-mode", "plan"] } },
  });
  await say("claudefull", "@claude ARGJSON");
  d = await idle("claudefull");
  const maskedArgv = argvFrom(lastAgent(d, "claude"));
  ok("a non-bypass Extra CLI override masks the Full-access dropdown",
    hasArg(maskedArgv, "--permission-mode", "plan") &&
    !hasArg(maskedArgv, "--permission-mode", "bypassPermissions"), JSON.stringify(maskedArgv));
  const auditBeforeUnmask = d.entries.filter((e) => e.kind === "system" &&
    e.text.includes("Claude Full access enabled")).length;
  await cfg("claudefull", { agents: { claude: { extraArgs: [] } } });
  d = await room("claudefull");
  ok("removing the override activates Full access as a real permission transition",
    d.room.agents.claude.linked === false &&
    d.entries.filter((e) => e.kind === "system" && e.text.includes("Claude Full access enabled")).length === auditBeforeUnmask + 1);

  const fullOff = await cfg("claudefull", { agents: { claude: { permissionMode: "plan" } } });
  d = await room("claudefull");
  ok("disabling Full access is recorded and starts Claude fresh", fullOff.status === 200 &&
    d.room.agents.claude.linked === false &&
    d.entries.some((e) => e.kind === "system" && e.text.includes("Claude Full access disabled")));

  console.log("\npermission provenance & config reset races");
  const seedPermissionRoom = (name, claudeState) => {
    const dir = path.join(ROOT, name);
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(dir, "room.json"), JSON.stringify({
      agents: { claude: { permissionMode: "plan" }, codex: {} },
    }, null, 2));
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      agents: {
        claude: { sessionRef: "stale-elevated-session", cursor: 7, ...claudeState },
        codex: { sessionRef: null, cursor: 0 },
      },
    }, null, 2));
  };
  seedPermissionRoom("stalescope", { permissionScope: "bypassPermissions" });
  d = await room("stalescope");
  let migratedState = JSON.parse(fs.readFileSync(path.join(ROOT, "stalescope", "state.json"), "utf8"));
  ok("a saved Claude session with mismatched permission provenance is discarded on load",
    d.room.agents.claude.linked === false && migratedState.agents.claude.sessionRef === null &&
    migratedState.agents.claude.permissionScope === "plan");

  seedPermissionRoom("legacyscope", {});
  d = await room("legacyscope");
  migratedState = JSON.parse(fs.readFileSync(path.join(ROOT, "legacyscope", "state.json"), "utf8"));
  ok("a legacy Claude session without permission provenance also fails closed",
    d.room.agents.claude.linked === false && migratedState.agents.claude.sessionRef === null &&
    migratedState.agents.claude.permissionScope === "plan");

  // A settings change no longer waits for the room to go quiet. The running
  // process keeps the flags it launched with — nothing can change those — but
  // the session it produces is fenced off by the seat's config epoch and
  // discarded, so the next turn re-briefs under the new setting.
  await api("POST", "/api/rooms", { name: "configrace" });
  await useFakes("configrace");
  await say("configrace", "@codex SLEEP:1500 ARGJSON");
  await waitRoom("configrace", (x) => x.room.busy.includes("codex"), "codex to become busy");
  const busySandbox = await cfg("configrace", {
    agents: { codex: { sandbox: "danger-full-access" } },
  });
  ok("a sandbox change lands immediately even while that seat is answering",
    busySandbox.status === 200 &&
    busySandbox.data.room.cfg.agents.codex.sandbox === "danger-full-access" &&
    (busySandbox.data.runningInvocations || []).join() === "codex",
    JSON.stringify(busySandbox.data.runningInvocations));
  const busyMode = await cfg("configrace", { mode: "work" });
  ok("a room-mode change lands immediately too", busyMode.status === 200 &&
    busyMode.data.room.cfg.mode === "work", JSON.stringify(busyMode.data.runningInvocations));
  d = await idle("configrace", 20000);
  ok("the interrupted seat still finishes its answer",
    !!lastAgent(d, "codex") && argvFrom(lastAgent(d, "codex")).length > 0);
  ok("the session that turn created is discarded rather than resumed",
    d.room.agents.codex.linked === false, JSON.stringify(d.room.agents.codex));
  // The promise is scoped to the CLI run, not the reply: a recovery retry
  // inside the same reply relaunches under the new settings, so claiming "this
  // reply keeps its old permissions" would be false exactly when one restarts.
  ok("the mid-turn save is recorded, scoped to the run rather than the reply",
    d.entries.some((e) => e.kind === "system" && /^⏳ Saved —/.test(e.text) &&
      /already in progress keeps the previous permissions/.test(e.text) &&
      /automatic retry if a session is lost/.test(e.text) &&
      !/reply continues/.test(e.text)),
    JSON.stringify(texts(d, "system")));
  await say("configrace", "@codex ARGJSON");
  d = await idle("configrace");
  ok("the next turn runs under the newly saved settings",
    hasArg(argvFrom(lastAgent(d, "codex")), "--sandbox", "danger-full-access"),
    lastAgent(d, "codex").text);

  // Only the seats a change actually restarts are fenced.
  await api("POST", "/api/rooms", { name: "epochscope" });
  await useFakes("epochscope");
  await say("epochscope", "@claude SAY:LINKED");
  await idle("epochscope");
  await say("epochscope", "@codex SLEEP:1500 SAY:BUSYSEAT");
  await waitRoom("epochscope", (x) => x.room.busy.includes("codex"), "codex to become busy");
  await cfg("epochscope", { agents: { codex: { sandbox: "danger-full-access" } } });
  d = await idle("epochscope", 20000);
  ok("an unaffected seat keeps its session across another seat's reset",
    d.room.agents.claude.linked === true && d.room.agents.codex.linked === false,
    JSON.stringify(d.room.agents));

  // The epoch is stamped per adapter attempt. A resume that fails *after* the
  // change is retried under the new settings, so what the retry creates is new
  // and must be kept — fencing the whole turn would throw it away every time.
  await api("POST", "/api/rooms", { name: "epochretry" });
  await useFakes("epochretry");
  await say("epochretry", "@codex SAY:SEEDED");
  d = await idle("epochretry");
  ok("the retry room has a session to lose", d.room.agents.codex.linked === true);
  await say("epochretry", "@codex MISSINGSESSION RESUMEDELAY:1500 ARGJSON");
  await waitRoom("epochretry", (x) => x.room.busy.includes("codex"), "the resume attempt to start");
  await cfg("epochretry", { agents: { codex: { sandbox: "workspace-write" } } });
  d = await idle("epochretry", 20000);
  const retryArgv = argvFrom(lastAgent(d, "codex"));
  ok("the relaunched retry actually runs under the newly saved settings",
    hasArg(retryArgv, "--sandbox", "workspace-write") &&
    !hasArg(retryArgv, "--sandbox", "read-only"), JSON.stringify(retryArgv));
  ok("a resume retry that starts after the change keeps the session it creates",
    d.room.agents.codex.linked === true, JSON.stringify(d.room.agents.codex));

  // Two refusals stay: a project change would put one exchange in two working
  // directories, and a pair cycle's worker and reviewer must share a regime.
  await say("configrace", "@claude SLEEP:1500 ARGJSON");
  await waitRoom("configrace", (x) => x.room.busy.includes("claude"), "claude to become busy");
  const busyProject = await cfg("configrace", { projectDir: ROOT });
  ok("project-folder changes still wait for an affected running turn", busyProject.status === 409,
    JSON.stringify(busyProject.data));
  await api("POST", "/api/stop", { room: "configrace", agent: "claude" });
  await idle("configrace");
  d = await room("configrace");
  ok("a refused project change leaves the original config intact",
    d.room.cfg.projectDir === null && d.room.cfg.agents.codex.sandbox === "danger-full-access");

  // The two halves of one split @both must not straddle a project change. The
  // guard asks seatOccupied, not busy, so a half that is owed but not yet
  // started — the tick between a seat's release and its delivery — still counts.
  await api("POST", "/api/rooms", { name: "splitproject" });
  await useFakes("splitproject");
  await say("splitproject", "@codex SLEEP:2500 SAY:PROJBUSY");
  await waitRoom("splitproject", (x) => x.room.busy.includes("codex"), "codex to start");
  await say("splitproject", "@both SAY:PROJSPLIT");
  await waitRoom("splitproject", (x) => x.room.queued > 0, "the held half to be counted");
  const splitProject = await cfg("splitproject", { projectDir: ROOT });
  ok("a project change is refused while half of a split @both is still owed",
    splitProject.status === 409 && /codex/.test(splitProject.data.error),
    JSON.stringify(splitProject.data));
  await idle("splitproject", 40000);
  d = await room("splitproject");
  ok("both halves of that turn ran in the same workspace", d.room.cfg.projectDir === null);
  // The guard also counts whole exchanges, not just occupied seats, so a hop
  // launched in a gap between turns can't land in a different folder. A counter
  // that failed to unwind would lock project changes out for good.
  const afterExchange = await cfg("splitproject", { projectDir: ROOT });
  ok("the exchange guard releases once the chain is done",
    afterExchange.status === 200 && afterExchange.data.room.cfg.projectDir === ROOT,
    JSON.stringify(afterExchange.data.error || afterExchange.status));
  ok("a chain still in flight is reported as working even between its turns",
    (await room("splitproject")).room.working === false);

  await api("POST", "/api/rooms", { name: "paircfg" });
  await useFakes("paircfg");
  await say("paircfg", "/pair start @claude SLEEP:1500 SAY:PAIRCFG");
  await waitRoom("paircfg", (x) => x.room.working || x.room.busy.length > 0, "the pair cycle to start");
  const pairCfg = await cfg("paircfg", { agents: { claude: { permissionMode: "plan" } } });
  ok("an active pair cycle still refuses a session-restarting change",
    pairCfg.status === 409 && /pair cycle/i.test(pairCfg.data.error), JSON.stringify(pairCfg.data));
  await idle("paircfg", 40000);
  d = await room("paircfg");
  ok("the refused pair change left the config alone",
    d.room.cfg.agents.claude.permissionMode === "auto");

  console.log("\nseats, notes & housekeeping");
  const made = await api("POST", "/api/rooms", { name: "swapped", seats: ["codex", "claude"] });
  ok("seat selection accepted", made.status === 200);
  d = await room("swapped");
  ok("seat order is preserved", JSON.stringify(d.room.seats) === '["codex","claude"]', JSON.stringify(d.room.seats));
  ok("default agent follows seat 1", d.room.cfg.defaultAgent === "codex");
  const dup = await api("POST", "/api/rooms", { name: "dupe", seats: ["claude", "claude"] });
  ok("same-provider pairs rejected", dup.status === 400);

  await useFakes("swapped");
  await cfg("swapped", { roomNote: "The room codeword is TANGERINE." });
  await say("swapped", "@claude RECALL");
  d = await idle("swapped");
  ok("room note reaches the agent", lastAgent(d, "claude").text.includes("TANGERINE"), lastAgent(d, "claude").text);

  const bad = await cfg("default", { projectDir: path.join(ROOT, "nope-not-here") });
  ok("bad project folder rejected", bad.status === 400);
  ok("rejected config leaves the room untouched", (await room("default")).room.cfg.projectDir === null);

  const before = (await room("lurkroom")).entries.length;
  await api("POST", "/api/new", { room: "lurkroom" });
  d = await room("lurkroom");
  ok("/new archives and resets", before > 0 && d.entries.length === 0);
  ok("archive file written", fs.readdirSync(path.join(ROOT, "lurkroom")).some((f) => f.startsWith("transcript-")));

  const tr = await fetch(`${base}/api/transcript?room=default`, {
    headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("transcript downloads as markdown", tr.status === 200 && (await tr.text()).includes("MANGO"));
  ok("providers advertised for the UI", !!(await room("default")).room.providers.claude.label);

  console.log("\nrename & delete");
  ok("unknown rooms are not conjured", (await roomStatus("ghosttown")) === 404);
  ok("…and nothing was created on disk", !fs.existsSync(path.join(ROOT, "ghosttown")));
  const defaultDelete = await api("POST", "/api/room/delete", { room: "default" });
  ok("the default room cannot be deleted", defaultDelete.status === 400 &&
    fs.existsSync(path.join(ROOT, "default")), JSON.stringify(defaultDelete.data));

  const spacedCreate = await api("POST", "/api/rooms", { name: "  padded room  " });
  ok("room creation canonicalizes surrounding whitespace",
    spacedCreate.status === 200 && (await roomStatus("padded room")) === 200 &&
    fs.existsSync(path.join(ROOT, "padded room")) && !fs.existsSync(path.join(ROOT, "  padded room  ")));

  await api("POST", "/api/rooms", { name: "before" });
  await useFakes("before");
  await say("before", "@claude SAY:KEEPSAKE");
  await idle("before");
  const ren = await api("POST", "/api/room/rename", { room: "before", to: "  after  " });
  ok("rename succeeds", ren.status === 200 && ren.data.name === "after");
  ok("rename canonicalizes surrounding whitespace",
    fs.existsSync(path.join(ROOT, "after")) && !fs.existsSync(path.join(ROOT, "before")) &&
    !fs.existsSync(path.join(ROOT, "  after  ")));
  d = await room("after");
  ok("transcript survives the rename", texts(d).includes("KEEPSAKE"));
  ok("old name is gone", (await api("GET", "/api/room?name=before")).status === 404);
  ok("renamed room still answers", (await say("after", "@claude SAY:STILLHERE")).status === 200);
  d = await idle("after");
  ok("…and the reply lands", texts(d).includes("STILLHERE"));
  const clash = await api("POST", "/api/room/rename", { room: "after", to: "default" });
  ok("rename onto an existing room refused", clash.status === 409);

  // Pre-seed every plausible timestamp for the next few seconds. The delete
  // must suffix its destination instead of overwriting any of these folders.
  const trashDir = path.join(ROOT, ".trash");
  fs.mkdirSync(trashDir, { recursive: true });
  const seededTrash = new Set();
  const stampBase = Date.now();
  for (let offset = -2000; offset <= 10000; offset += 1000) {
    const seeded = path.join(trashDir, `after-${localStamp(new Date(stampBase + offset))}`);
    fs.mkdirSync(seeded, { recursive: true });
    seededTrash.add(seeded);
  }
  const del = await api("POST", "/api/room/delete", { room: "after" });
  ok("delete succeeds", del.status === 200);
  ok("trash-name collisions get a numeric suffix instead of overwriting",
    !seededTrash.has(del.data.trash) && /-2$/.test(path.basename(del.data.trash)), del.data.trash);
  ok("room folder is gone", !fs.existsSync(path.join(ROOT, "after")));
  ok("…and recoverable from .trash", fs.existsSync(del.data.trash) &&
    fs.existsSync(path.join(del.data.trash, "transcript.md")));
  ok("deleted room stays deleted", (await api("GET", "/api/room?name=after")).status === 404);
  ok("…and does not resurrect on mention", (await say("after", "hello?")).status === 404 &&
    !fs.existsSync(path.join(ROOT, "after")));
  ok("trash is hidden from the room list", !(await api("GET", "/api/rooms")).data.rooms.some((r) => r.name.startsWith(".")));
}

let code = 0;
try {
  await main();
} catch (e) {
  failures.push("threw: " + e.message);
  console.log("\n✗ " + e.message);
}
try { server.kill(); } catch { /* already gone */ }
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows may hold a handle */ }

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:\n" + failures.map((f) => "  - " + f).join("\n"));
  code = 1;
}
process.exit(code);
