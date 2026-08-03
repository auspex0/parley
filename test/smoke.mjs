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
import { fileURLToPath } from "node:url";

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
const RUNTIME_PROTOCOL = "1";

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
  ok("the page blocks controls when an older backend is still running",
    page.includes('meta name="parley-runtime-protocol" content="1"') &&
    page.includes("PAGE_RUNTIME_PROTOCOL") && page.includes("Restart Parley"));
  TOKEN = (/name="parley-token" content="([^"]+)"/.exec(page) || [])[1] || "";
  ok("the page carries a session token", TOKEN.length > 20);
  const runtimeResponse = await fetch(base + "/api/rooms", {
    headers: { "X-Parley-Token": TOKEN, "X-Parley-Runtime-Protocol": RUNTIME_PROTOCOL },
  });
  ok("the API identifies its runtime protocol",
    runtimeResponse.headers.get("x-parley-runtime-protocol") === "1");
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

  console.log("routing & the delta protocol");
  await useFakes("default");
  await say("default", "@claude SAY:MANGO");
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
  ok("same seat queues", r3.data.queued === true);
  await sleep(150);
  const mid = await room("lanes");
  ok("both lanes busy at once", mid.room.busy.length === 2, JSON.stringify(mid.room.busy));
  d = await idle("lanes");
  ok("queued message runs after its lane frees", texts(d).includes("C"));
  ok("all three replies landed", ["A", "B", "C"].every((t) => texts(d).includes(t)));

  await api("POST", "/api/rooms", { name: "selectstop" });
  await useFakes("selectstop");
  await say("selectstop", "@claude SLEEP:2200 SAY:CLAUDE_DONE");
  await say("selectstop", "@codex SLEEP:2200 SAY:CODEX_DONE");
  await sleep(150);
  const selective = await api("POST", "/api/stop", { room: "selectstop", agent: "claude" });
  ok("a seat-scoped Stop reports only that CLI", selective.status === 200 &&
    selective.data.stopped === 1 && selective.data.agent === "claude", JSON.stringify(selective.data));
  d = await idle("selectstop");
  ok("seat-scoped Stop leaves the other response running",
    !texts(d).includes("CLAUDE_DONE") && texts(d).includes("CODEX_DONE"));
  const badStop = await api("POST", "/api/stop", { room: "selectstop", agent: "nobody" });
  ok("seat-scoped Stop rejects unknown agents", badStop.status === 400);

  await api("POST", "/api/rooms", { name: "stoptree" });
  await useFakes("stoptree");
  const stopWorkspace = path.join(ROOT, "stoptree", "workspace");
  const childReady = path.join(stopWorkspace, ".fake-cli-child-ready-STOPTREE");
  const childSurvived = path.join(stopWorkspace, ".fake-cli-child-survived-STOPTREE");
  await say("stoptree", "@claude SPAWNCHILD:STOPTREE SLEEP:5000");
  await waitFile(childReady, "fake CLI descendant to start");
  const stopped = await api("POST", "/api/stop", { room: "stoptree" });
  ok("Stop reports the running CLI", stopped.status === 200 && stopped.data.stopped === 1,
    JSON.stringify(stopped.data));
  await idle("stoptree");
  await sleep(1300);
  ok("Stop kills the CLI's descendant process too", !fs.existsSync(childSurvived), childSurvived);

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

  await say("claudefull", "@claude SLEEP:1200 ARGJSON");
  await sleep(120);
  const busyElevation = await cfg("claudefull", {
    agents: { claude: { permissionMode: "bypassPermissions" } },
  });
  ok("Claude permission changes wait for a running turn", busyElevation.status === 409,
    JSON.stringify(busyElevation.data));
  await api("POST", "/api/stop", { room: "claudefull", agent: "claude" });
  await idle("claudefull");

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

  await api("POST", "/api/rooms", { name: "configrace" });
  await useFakes("configrace");
  await say("configrace", "@codex SLEEP:1200 ARGJSON");
  await waitRoom("configrace", (x) => x.room.busy.includes("codex"), "codex to become busy");
  const busySandbox = await cfg("configrace", {
    agents: { codex: { sandbox: "danger-full-access" } },
  });
  const busyMode = await cfg("configrace", { mode: "work" });
  ok("Codex sandbox and room-mode resets wait for its running turn",
    busySandbox.status === 409 && busyMode.status === 409,
    JSON.stringify({ sandbox: busySandbox.data, mode: busyMode.data }));
  await api("POST", "/api/stop", { room: "configrace", agent: "codex" });
  await idle("configrace");

  await say("configrace", "@claude SLEEP:1200 ARGJSON");
  await waitRoom("configrace", (x) => x.room.busy.includes("claude"), "claude to become busy");
  const busyProject = await cfg("configrace", { projectDir: ROOT });
  ok("project-folder resets wait for an affected running turn", busyProject.status === 409,
    JSON.stringify(busyProject.data));
  await api("POST", "/api/stop", { room: "configrace", agent: "claude" });
  await idle("configrace");
  d = await room("configrace");
  ok("rejected reset changes leave the original config intact",
    d.room.cfg.mode === "talk" && d.room.cfg.projectDir === null &&
    d.room.cfg.agents.codex.sandbox === "read-only");

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
