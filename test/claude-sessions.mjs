import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedServer } from "./server-fixture.mjs";

const server = await isolatedServer({ env: { FAKE_DELAY_MS: "25", FAKE_TRACE_PROMPTS: "1" } });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (name) => JSON.parse(fs.readFileSync(path.join(server.root, name, "state.json"), "utf8")).agents.claude;
const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];
async function settled(name) {
  for (let i = 0; i < 400; i++) {
    const d = await server.room(name);
    if (!d.room.working && !d.room.busy.length && !d.room.queued) return d;
    await pause(25);
  }
  throw Error(`Room did not settle: ${name}`);
}
async function send(name, target, text = "ARGJSON") {
  const before = (await server.room(name)).entries.at(-1)?.n || 0;
  assert.equal((await server.api("POST", "/api/message", { room: name, target, text })).status, 200);
  const d = await settled(name);
  const reply = d.entries.find((e) => e.n > before && e.kind === "agent" && e.author === "claude" && e.text.startsWith("ARGVJSON "));
  assert(reply?.text.startsWith("ARGVJSON "), JSON.stringify(reply));
  return JSON.parse(reply.text.slice("ARGVJSON ".length));
}
try {
  await server.configure("default", { mode: "work", accounting: "automatic", hopBudget: 0,
    agents: { claude: { permissionMode: "bypassPermissions" } } });
  let argv = await send("default", "claude");
  assert.equal(arg(argv, "--permission-mode"), "bypassPermissions");
  assert(!argv.includes("--resume"));
  const work = state("default").sessionRef;
  argv = await send("default", "claude");
  assert.equal(arg(argv, "--resume"), work);

  argv = await send("default", "both");
  assert.equal(arg(argv, "--permission-mode"), "plan");
  assert(!argv.includes("--resume"), "Never resume the full-access session in Plan");
  assert(argv.includes("--append-system-prompt"));
  const plan = state("default").sessionRef;
  assert(plan && plan !== work);
  assert.equal(state("default").permissionScope, "plan");
  argv = await send("default", "both");
  assert.equal(arg(argv, "--resume"), plan);
  assert(!argv.includes("--append-system-prompt"), "No repeated fresh-session history briefing");

  // Load a copy of saved room data through the startup migration path.
  fs.cpSync(path.join(server.root, "default"), path.join(server.root, "reloaded"), { recursive: true });
  argv = await send("reloaded", "both");
  assert.equal(arg(argv, "--resume"), plan, "Plan session survives room reload");
  assert.equal(state("reloaded").permissionScope, "plan");

  fs.cpSync(path.join(server.root, "default"), path.join(server.root, "offline-change"), { recursive: true });
  const configFile = path.join(server.root, "offline-change", "room.json");
  const changedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  changedConfig.agents.claude.permissionMode = "acceptEdits";
  fs.writeFileSync(configFile, JSON.stringify(changedConfig));
  await server.room("offline-change");
  assert.equal(state("offline-change").sessionRef, null, "Offline permission change fails closed");
  argv = await send("offline-change", "both");
  assert(!argv.includes("--resume"));
  assert.equal(arg(argv, "--permission-mode"), "plan");

  argv = await send("default", "claude");
  assert.equal(arg(argv, "--permission-mode"), "bypassPermissions");
  assert(!argv.includes("--resume"));
  const nextWork = state("default").sessionRef;
  argv = await send("default", "claude");
  assert.equal(arg(argv, "--resume"), nextWork);
  assert.notEqual(nextWork, work);

  await send("default", "both");
  const beforeFailure = state("default").sessionRef;
  await server.api("POST", "/api/config", { room: "default", config: { hopBudget: 4 } });
  argv = await send("default", "both", "MISSINGSESSION ARGJSON");
  assert(!argv.includes("--resume"), "Missing native session is recovered fresh");
  assert.equal(arg(argv, "--permission-mode"), "plan");
  const recovered = state("default").sessionRef;
  assert(recovered);
  assert.notEqual(recovered, beforeFailure);
  await server.api("POST", "/api/config", { room: "default", config: { hopBudget: 0 } });
  argv = await send("default", "both");
  assert.equal(arg(argv, "--resume"), recovered);

  assert.equal((await server.api("POST", "/api/config", { room: "default",
    config: { agents: { claude: { permissionMode: "plan" } } } })).status, 200);
  argv = await send("default", "claude");
  assert(!argv.includes("--resume"), "Settings change retires old session");
  const configuredPlan = state("default").sessionRef;
  argv = await send("default", "both");
  assert.equal(arg(argv, "--resume"), configuredPlan, "Same effective Plan mode retains session");

  // An in-flight old-permission completion must not restore its session after
  // Settings changes. Only the next launch may establish new provenance.
  await server.api("POST", "/api/message", { room: "default", target: "both", text: "ARGJSON SLEEP:400" });
  for (let i = 0; i < 100; i++) {
    if ((await server.room("default")).room.busy.includes("claude")) break;
    await pause(10);
  }
  assert((await server.room("default")).room.busy.includes("claude"));
  await server.api("POST", "/api/config", { room: "default",
    config: { agents: { claude: { permissionMode: "bypassPermissions" } } } });
  await settled("default");
  assert.equal(state("default").sessionRef, null, "Old completion cannot restore its session");
  argv = await send("default", "both");
  assert(!argv.includes("--resume"));
  const newPlan = state("default").sessionRef;
  argv = await send("default", "both");
  assert.equal(arg(argv, "--resume"), newPlan);

  const traceFile = path.join(server.root, "default", "workspace", ".fake-cli-prompts.jsonl");
  const traces = () => fs.readFileSync(traceFile, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const beforeDebate = traces().length;
  await server.api("POST", "/api/config", { room: "default", config: { hopBudget: 4 } });
  await server.api("POST", "/api/message", { room: "default", target: "both", text: "PINGPONG" });
  await settled("default");
  const debateStarts = traces().slice(beforeDebate).filter((e) => e.event === "start" && e.seat === "claude");
  assert(debateStarts.length >= 2, "Exercise automatic turns inside one debate");
  assert(debateStarts.every((e) => e.briefing === ""), "No fresh briefing on automatic debate turns");
  assert.equal(state("default").sessionRef, newPlan, "Entire debate retains the Plan session");

  // A seat without Full access: Plan is only a flag on the same native session,
  // so alternating discussion and work turns must never reset it. Only a seat
  // whose bypass would defeat Plan keeps a separate Plan session (above).
  assert.equal((await server.api("POST", "/api/rooms", { name: "ordinary" })).status, 200);
  await server.configure("ordinary", { mode: "work", accounting: "automatic", hopBudget: 0 });
  argv = await send("ordinary", "claude");
  assert.equal(arg(argv, "--permission-mode"), "acceptEdits");
  assert(!argv.includes("--resume"));
  const ordinary = state("ordinary").sessionRef;
  assert(ordinary);
  argv = await send("ordinary", "both");
  assert.equal(arg(argv, "--permission-mode"), "plan", "Discussion still runs under Plan");
  assert.equal(arg(argv, "--resume"), ordinary, "Discussion resumes the ordinary work session");
  assert(!argv.includes("--append-system-prompt"), "No fresh briefing on the discussion turn");
  assert.equal(state("ordinary").sessionRef, ordinary);
  assert.equal(state("ordinary").permissionScope, "acceptEdits", "A Plan flag does not re-stamp an ordinary session");
  argv = await send("ordinary", "claude");
  assert.equal(arg(argv, "--permission-mode"), "acceptEdits");
  assert.equal(arg(argv, "--resume"), ordinary, "Work resumes the same session after a discussion turn");
  assert(!argv.includes("--append-system-prompt"), "No fresh briefing on the work turn");

  // Match the smoke suite's stale-listener contract test, with permissions
  // that actually belong to a retained listener session.
  const listenerDir = path.join(server.root, "stale-listener");
  fs.mkdirSync(path.join(listenerDir, "workspace"), { recursive: true });
  const fakeCommand = (await server.room("default")).room.cfg.agents.claude.command;
  fs.writeFileSync(path.join(listenerDir, "room.json"), JSON.stringify({
    defaultAgent: "codex", maxHops: 1,
    agents: { claude: { command: fakeCommand, lurk: true }, codex: { command: fakeCommand, lurk: false } },
  }));
  fs.writeFileSync(path.join(listenerDir, "state.json"), JSON.stringify({
    lastAddressed: "codex", agents: {
      claude: { sessionRef: "fake-session-listener-stale", cursor: 0, permissionScope: "default" },
      codex: { sessionRef: null, cursor: 0 },
    },
  }));
  await server.api("POST", "/api/message", { room: "stale-listener", target: "codex", text: "LURKVERSION" });
  const listener = await settled("stale-listener");
  assert(listener.entries.some((e) => e.author === "claude" && e.text === "LURKVERSIONYES"));
  assert.equal(state("stale-listener").sessionRef, "fake-session-listener-stale");
  assert.equal(state("stale-listener").promptSessionRef, "fake-session-listener-stale");
  assert.match(state("stale-listener").briefingFingerprint, /^[a-f0-9]{64}$/);
  console.log("Claude session transitions passed (fake providers only).");
} finally {
  await server.close();
}
