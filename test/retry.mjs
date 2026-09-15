#!/usr/bin/env node
// Focused recovery integration coverage: isolated rooms, fake providers only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedServer } from "./server-fixture.mjs";

const server = await isolatedServer({ env: { FAKE_DELAY_MS: "30", PARLEY_HOP_SAFETY: "4" } });
const root = server.root;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read, condition, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (condition(value)) return value;
    await delay(35);
  }
  throw new Error(`Timed out: ${label}\n${server.log()}`);
}
const api = (route, body) => server.api(body ? "POST" : "GET", route, body);
const room = (name) => api(`/api/room?name=${name}`).then((r) => r.data);
const post = async (route, body) => {
  const result = await api(route, body);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.data;
};
const say = (name, text) => post("/api/message", { room: name, text, target: "auto" });
const settled = (name) => wait(() => room(name), (d) =>
  !d.room.busy.length && !d.room.working && !d.room.queued &&
  !Object.values(d.room.agents).some((a) => a.catchUp && !a.asleep), `${name} to settle`, 40000);
async function create(name, options = {}) {
  await post("/api/rooms", { name });
  await server.configure(name, options);
}
const errors = (d) => d.entries.filter((e) => e.meta?.error);
const state = (name) => fs.readFileSync(path.join(root, name, "state.json"), "utf8");

try {
  await create("split");
  await say("split", "@both FAILONCESEAT:claude SLEEP:2000 SAY:RETRYFREE");
  let d = await wait(() => room("split"), (x) => errors(x).length && x.room.busy.includes("codex"), "failed Claude while Codex is busy");
  const failure = errors(d)[0];
  const rootN = failure.meta.recovery.rootN;
  assert.deepEqual(failure.meta.recovery, { kind: "retry", rootN, agent: "claude" });
  assert.equal(d.room.canRetry, true);
  for (const agents of [[], null, "claude", [7], ["unknown"], [""]]) {
    assert.equal((await api("/api/retry", { room: "split", rootN, agents })).status, 400);
  }
  for (const value of [null, "1", 0, -1, 1.5]) {
    assert.equal((await api("/api/retry", { room: "split", rootN: value, agents: ["claude"] })).status, 400);
  }
  const busy = await api("/api/retry", { room: "split", rootN, agents: ["codex"] });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /codex.*busy/);
  await post("/api/retry", { room: "split", rootN, agents: ["claude", "CLAUDE"] });
  const duplicate = await api("/api/retry", { room: "split", rootN, agents: ["claude"] });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.error, /claude.*busy/);
  assert.equal((await room("split")).room.queued, 0);
  d = await settled("split");
  const direct = d.entries.filter((e) => e.kind === "agent" && e.meta?.replyTo === rootN && !e.meta?.hop);
  assert.deepEqual(direct.map((e) => e.author).sort(), ["claude", "codex"]);
  assert.equal(d.room.resolvedErrors[failure.n].entryN, direct.find((e) => e.author === "claude").n);
  assert.deepEqual(d.entries.find((e) => e.n === failure.n), failure, "historical failure stays intact");
  const causal = d.entries.filter((e) => e.meta?.hop);
  assert.equal(new Set(causal.map((e) => `${e.author}:${e.meta.replyTo}`)).size, causal.length);
  console.log("✓ seat-scoped Retry recovers the free half, deduplicates seats, and preserves root coordination");

  await say("split", "@claude SAY:NEWER");
  d = await settled("split");
  const stable = state("split");
  const stale = await api("/api/retry", { room: "split", rootN, agents: ["claude"] });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /older message/);
  assert.equal(state("split"), stable);
  const newerN = d.entries.filter((e) => e.kind === "user").at(-1).n;
  assert.equal((await api("/api/retry", { room: "split", rootN: newerN, agents: ["codex"] })).status, 400);
  console.log("✓ stale and out-of-envelope recovery requests refuse without changing state");

  await create("wake");
  await post("/api/seat/sleep", { room: "wake", agent: "claude" });
  await say("wake", "@both FAILONCESEAT:claude SAY:WOKEN");
  await settled("wake");
  await post("/api/seat/sleep", { room: "wake", agent: "claude", asleep: false, deliver: true });
  d = await settled("wake");
  const wakeError = errors(d)[0];
  assert.ok(wakeError, "wake delivery failed once");
  assert.equal((await api("/api/retry", { room: "wake", rootN: wakeError.meta.recovery.rootN, agents: ["codex"] })).status, 400);
  await post("/api/retry", { room: "wake", rootN: wakeError.meta.recovery.rootN, agents: ["claude"] });
  d = await settled("wake");
  assert.ok(d.room.resolvedErrors[wakeError.n]);
  console.log("✓ Wake's narrowed retry envelope cannot expand to the original audience");

  for (const [name, directive, stage] of [["review", "REVIEWFAILONCE", "review"], ["fix", "FIXFAILONCE", "fix"], ["work", "FAILONCE:WORK SAY:WORKED", "work"]]) {
    await create(name);
    await say(name, `/pair start @claude SAY:${directive}`.replace("SAY:FAILONCE:", "FAILONCE:"));
    d = await settled(name);
    const error = errors(d)[0];
    assert.ok(error, `${stage} must fail`);
    assert.deepEqual(error.meta.recovery, { kind: "pair-retry", rootN: error.meta.recovery.rootN, stage });
    const pairRootN = error.meta.recovery.rootN;
    assert.ok(!d.entries.find((e) => e.n === pairRootN).meta.relay);
    for (const agents of [[], null, ["claude"], ["claude", "codex"]]) {
      assert.equal((await api("/api/retry", { room: name, rootN: pairRootN, agents })).status, 400);
    }
    await post("/api/retry", { room: name, rootN: pairRootN });
    d = await settled(name);
    assert.ok(d.entries.some((e) => e.meta?.pairApproved && e.meta.rootN === pairRootN));
    assert.ok(d.room.resolvedErrors[error.n]);
  }
  console.log("✓ Pair worker, reviewer, and fix failures recover through the entire cycle");

  // A stored failed fix can become unnecessary when the whole cycle is
  // retried and its new work passes review immediately.
  const skippedDir = path.join(root, "skippedfix");
  fs.mkdirSync(skippedDir);
  const skippedState = JSON.parse(state("work"));
  skippedState.nextTurn = 3;
  skippedState.lastUser = { n: 1, text: "SAY:READY", target: "claude", done: { claude: false }, pair: true };
  skippedState.resolvedErrors = {};
  for (const seat of Object.values(skippedState.agents)) { seat.cursor = 0; seat.sessionRef = null; }
  const skippedEntries = [
    { n: 1, kind: "user", author: "user", target: "claude", text: "SAY:READY", meta: { pair: { worker: "claude", reviewer: "codex", rounds: 2 } } },
    { n: 2, kind: "system", author: "system", text: "old fix failed", meta: { agent: "claude", error: true, recovery: { kind: "pair-retry", rootN: 1, stage: "fix" } } },
  ];
  fs.copyFileSync(path.join(root, "work", "room.json"), path.join(skippedDir, "room.json"));
  fs.writeFileSync(path.join(skippedDir, "state.json"), JSON.stringify(skippedState));
  fs.writeFileSync(path.join(skippedDir, "events.jsonl"), skippedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await post("/api/retry", { room: "skippedfix", rootN: 1 });
  d = await settled("skippedfix");
  assert.equal(d.room.resolvedErrors[2].entryN, d.entries.find((e) => e.meta?.pairApproved).n);
  assert.equal(d.entries.filter((e) => e.meta?.pair === "fix").length, 0);
  console.log("✓ whole-cycle approval resolves an old fix failure even when the fix is no longer needed");

  await create("ended");
  await say("ended", "/pair start @claude SAY:REVIEWFAILONCE");
  d = await settled("ended");
  const endedN = errors(d)[0].meta.recovery.rootN;
  await say("ended", "/pair end");
  await post("/api/seat/sleep", { room: "ended", agent: "claude" });
  d = await room("ended");
  assert.equal(d.room.canRetry, false);
  const endedState = state("ended");
  for (let i = 0; i < 3; i++) {
    const refused = await api("/api/retry", { room: "ended", rootN: endedN });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Pair has ended/);
    assert.doesNotMatch(refused.data.error, /wake|busy/);
    assert.equal(state("ended"), endedState);
  }
  assert.equal((await api("/api/queue/retry", { room: "ended", n: endedN, agents: ["claude"] })).status, 400);
  assert.equal((await room("ended")).entries.length, d.entries.length);
  console.log("✓ ended Pair refuses before sleep advice and repeated refusals mutate nothing");

  await create("cancelled");
  await say("cancelled", "/pair start @claude");
  await post("/api/queue/pause", { room: "cancelled", paused: true });
  await say("cancelled", "SAY:CANCELLEDPAIR");
  d = await room("cancelled");
  const queued = d.room.queue[0];
  assert.ok(queued);
  await post("/api/queue/cancel", { room: "cancelled", groupId: queued.queueGroupId });
  const cancelledN = queued.sourceN;
  assert.equal((await api("/api/queue/retry", { room: "cancelled", n: cancelledN })).status, 400);
  await post("/api/retry", { room: "cancelled", rootN: cancelledN });
  d = await settled("cancelled");
  assert.ok(d.entries.some((e) => e.meta?.pairApproved && e.meta.rootN === cancelledN));
  assert.ok(!d.room.cancelledDeliveries[cancelledN]);
  assert.ok(!d.entries.some((e) => e.meta?.relayCap));
  console.log("✓ cancelled queued Pair uses whole-cycle recovery and remains relay-free");

  // A root written by old builds has no relay snapshot. Positive Pair identity
  // must guard the ordinary funnel without rejecting these ordinary roots.
  const legacyDir = path.join(root, "legacy");
  fs.mkdirSync(legacyDir);
  const legacyState = JSON.parse(state("split"));
  legacyState.nextTurn = 2;
  legacyState.lastUser = { n: 1, text: "SAY:LEGACY", target: "claude", done: {} };
  for (const seat of Object.values(legacyState.agents)) { seat.cursor = 0; seat.sessionRef = null; }
  fs.copyFileSync(path.join(root, "split", "room.json"), path.join(legacyDir, "room.json"));
  fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(legacyState));
  fs.writeFileSync(path.join(legacyDir, "events.jsonl"), JSON.stringify({ n: 1, kind: "user", author: "you", target: "claude", text: "SAY:LEGACY" }) + "\n");
  await post("/api/retry", { room: "legacy", rootN: 1, agents: ["claude"] });
  d = await settled("legacy");
  assert.ok(d.entries.some((e) => e.author === "claude" && e.text === "LEGACY"));
  console.log("✓ ordinary legacy roots remain recoverable without relay metadata");
  console.log("Retry integration coverage passed.");
} finally {
  await server.close();
}
