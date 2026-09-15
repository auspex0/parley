import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedServer } from "./server-fixture.mjs";

const server = await isolatedServer({ env: { FAKE_TRACE_PROMPTS: "1", FAKE_DELAY_MS: "30" } });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled(name) {
  for (let i = 0; i < 600; i++) {
    const d = await server.room(name);
    if (!d.room.working && !d.room.busy.length && !d.room.queued &&
        !Object.values(d.room.agents).some((a) => a.catchUp && !a.asleep)) return d;
    await pause(40);
  }
  throw Error(`Did not settle: ${name}\n${server.log()}`);
}
async function create(name, budget, extra = {}) {
  assert.equal((await server.api("POST", "/api/rooms", { name })).status, 200);
  const fresh = await server.room(name);
  assert.equal(fresh.room.cfg.accounting, "automatic");
  assert.equal(fresh.room.cfg.hopBudget, 4);
  await server.configure(name, { accounting: "automatic", hopBudget: budget, ...extra });
}
async function send(name, text, target = "both") {
  assert.equal((await server.api("POST", "/api/message", { room: name, text, target })).status, 200);
  return settled(name);
}
function launches(d) {
  return [...d.entries, ...d.receipts].filter((e) => e.meta?.relayLaunch || e.relayLaunch)
    .map((e) => e.meta?.relayLaunch || e.relayLaunch);
}
function starts(name) {
  const file = path.join(server.root, name, "workspace", ".fake-cli-prompts.jsonl");
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((e) => e.event === "start");
}
async function waitFor(name, predicate) {
  for (let i = 0; i < 300; i++) {
    const d = await server.room(name);
    if (predicate(d)) return d;
    await pause(25);
  }
  throw Error(`Condition not reached: ${name}`);
}
try {
  for (const budget of [0, 1, 2, 4, -1]) {
    const name = `auto-${budget}`;
    await create(name, budget);
    const d = await send(name, "PINGPONG");
    const root = d.entries.find((e) => e.kind === "user");
    assert.equal(root.meta.relay.version, 2);
    const limit = budget < 0 ? 4 : budget;
    assert.equal(root.meta.relay.safetyLimit, 4);
    assert.equal(starts(name).length, 2 + limit, `${name}: actual CLI starts`);
    assert(!d.entries.some((e) => e.meta?.chainFailure), `${name}: no scheduler exception`);
    assert.equal(new Set(launches(d).map((l) => l.index)).size, limit);
    assert(d.entries.some((e) => e.meta?.relayCap?.accounting === "automatic"));
    for (const receipt of d.receipts.filter((r) => r.outputEntryN)) {
      const output = d.entries.find((e) => e.n === receipt.outputEntryN);
      assert.equal(output.author, receipt.agent);
    }
  }
  await create("auto-listener-zero", 0, { agents: { claude: { lurk: true } } });
  let d = await send("auto-listener-zero", "CHIME", "codex");
  assert.equal(starts("auto-listener-zero").length, 1);
  await create("auto-listener-one", 1, { agents: { claude: { lurk: true } } });
  d = await send("auto-listener-one", "CHIME", "codex");
  assert.equal(starts("auto-listener-one").length, 2);
  assert.equal(launches(d)[0].index, 1);
  await create("auto-listener-empty", 1, { agents: { claude: { lurk: true } } });
  d = await send("auto-listener-empty", "SAY:LURKEMPTY", "codex");
  assert.equal(starts("auto-listener-empty").length, 2);
  assert(d.receipts.some((r) => r.mode === "lurk" && r.outcome === "empty" && r.relayLaunch?.index === 1));
  assert(!d.entries.some((e) => e.meta?.error));
  await create("auto-pass", 4);
  d = await send("auto-pass", "BOTHATTENTION");
  assert.equal(starts("auto-pass").length, 4);
  assert.equal(d.receipts.filter((r) => r.outcome === "pass" && r.relayLaunch).length, 2);
  // Switching settings cannot reinterpret an accepted root.
  const prior = d.entries.find((e) => e.kind === "user").meta.relay;
  await server.configure("auto-pass", { accounting: "exchanges", hopBudget: 0 });
  assert.deepEqual((await server.room("auto-pass")).entries.find((e) => e.kind === "user").meta.relay, prior);
  d = await send("auto-pass", "BOTHATTENTION");
  assert.equal(d.entries.filter((e) => e.kind === "user").at(-1).meta.relay.version, 1);
  assert.equal((await server.api("POST", "/api/config", { room: "auto-pass", config: { accounting: "custom" } })).status, 400);
  for (const mode of ["empty", "pass", "fail", "rate"]) {
    const name = `auto-outcome-${mode}`;
    await create(name, 1);
    d = await send(name, `HOPRESULT:${mode}`, "codex");
    assert.equal(starts(name).length, 2);
    assert.equal(new Set(launches(d).map((l) => l.index)).size, 1);
    if (["empty", "pass"].includes(mode)) {
      assert(d.receipts.some((r) => r.outcome === mode && r.relayLaunch?.index === 1));
    } else {
      const failed = d.entries.find((e) => e.meta?.error);
      assert.equal(failed.meta.relayLaunch.index, 1);
      if (mode === "rate") { assert.match(failed.text, /five-hour/); assert(failed.meta.technicalError); }
      d = await send(name, "SAY:DELIVERED_LATER", "claude");
      const later = d.receipts.find((r) => r.agent === "claude" && r.from < failed.meta.delivery.triggerEntryN &&
        r.upTo >= failed.meta.delivery.triggerEntryN && r.recordedAfterN >= failed.n);
      assert(later?.outputEntryN, "later successful delivery has an exact output link");
    }
  }
  for (const budgets of [[1, 1], [0, 1], [0, 0]]) {
    const name = `auto-catchup-${budgets.join("-")}`;
    await create(name, 0, { agents: { codex: { lurk: true } } });
    const post = (text, target, hopBudget = 0) => server.api("POST", "/api/message", { room: name, text, target, hopBudget });
    await post("SLEEP:3500 SAY:BLOCKER", "codex");
    await waitFor(name, (x) => x.room.busy.includes("codex"));
    await post("SAY:CLOSURETAG", "claude", budgets[0]);
    await waitFor(name, (x) => x.room.agents.codex.catchUp && !x.room.busy.includes("claude"));
    await post("SAY:CHIME", "claude", budgets[1]);
    await waitFor(name, (x) => {
      const last = x.entries.find((e) => e.author === "claude" && e.text === "CHIME");
      return last && x.room.agents.codex.catchUp?.throughN >= last.n;
    });
    d = await settled(name);
    const roots = d.entries.filter((e) => e.kind === "user").slice(1);
    const owner = roots[budgets.findIndex((b) => b > 0)];
    assert.equal(starts(name).length, owner ? 4 : 3, "no free catch-up or answer-return bypass");
    const receipt = d.receipts.find((r) => r.mode === "lurk-catchup");
    if (owner) {
      assert.equal(receipt.catchUp.ownerRootN, owner.n);
      assert.deepEqual(receipt.catchUp.rootNs, roots.map((r) => r.n));
      assert.equal(receipt.relayLaunch.rootN, owner.n);
      assert.equal(receipt.relayLaunch.index, 1);
      assert(launches(d).every((l) => l.rootN === owner.n));
    } else assert.equal(receipt, undefined);
  }
  for (const budget of [0, 1]) {
    const name = `auto-session-retry-${budget}`;
    await create(name, budget);
    await send(name, "SAY:SESSION", "codex");
    d = await send(name, "MISSINGSESSION", "codex");
    assert.equal(starts(name).length, 2 + budget, "internal fresh-session recovery consumes an automatic unit");
    assert.equal(new Set(launches(d).map((l) => l.index)).size, budget);
    if (!budget) assert(d.entries.some((e) => e.meta?.relayCap));
  }
  // Stop retains the admitted charge even if native termination is delayed.
  await create("auto-stop", 4);
  await server.api("POST", "/api/message", { room: "auto-stop", text: "HOPRESULT:slow", target: "codex" });
  await waitFor("auto-stop", (x) => x.room.busyInfo.some((run) => run.relayLaunch) && starts("auto-stop").length === 2);
  await server.api("POST", "/api/stop", { room: "auto-stop", scope: "all" });
  d = await settled("auto-stop");
  assert.equal(starts("auto-stop").length, 2, "Stop cannot authorize another automatic start");
  assert(d.entries.some((e) => e.meta?.stopped && e.meta.relayLaunch?.index === 1));
  assert.equal(new Set(launches(d).map((l) => l.index)).size, 1, "Stop does not refund the admitted turn");

  // Reload durable artifacts into an unloaded room, as a fresh process would.
  const restored = path.join(server.root, "auto-restored");
  fs.mkdirSync(restored);
  for (const file of ["room.json", "state.json", "events.jsonl"]) {
    fs.copyFileSync(path.join(server.root, "auto-outcome-pass", file), path.join(restored, file));
  }
  d = await server.room("auto-restored");
  assert.equal(d.entries.find((e) => e.kind === "user").meta.relay.version, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored, "state.json"), "utf8")).relayUsage,
    JSON.parse(fs.readFileSync(path.join(server.root, "auto-outcome-pass", "state.json"), "utf8")).relayUsage);
  const legacy = path.join(server.root, "legacy-restored");
  fs.mkdirSync(legacy);
  const config = JSON.parse(fs.readFileSync(path.join(restored, "room.json"), "utf8"));
  delete config.accounting;
  config.hopBudget = 0;
  fs.writeFileSync(path.join(legacy, "room.json"), JSON.stringify(config));
  d = await server.room("legacy-restored");
  assert.equal(d.room.cfg.accounting, "exchanges");
  assert.equal(d.room.cfg.hopBudget, 0, "loading legacy configuration does not translate the allowance");
  console.log("Automatic-turn integration scenarios passed");
} finally { await server.close(); }
