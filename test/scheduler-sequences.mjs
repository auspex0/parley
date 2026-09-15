#!/usr/bin/env node
// Seeded, bounded interleavings at real scheduler boundaries. Reproduce one
// sequence with PARLEY_SEQUENCE_SEED=7 node test/scheduler-sequences.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedServer } from "./server-fixture.mjs";

const seeds = process.env.PARLEY_SEQUENCE_SEED ? [Number(process.env.PARLEY_SEQUENCE_SEED)] : [7, 71, 701];
const server = await isolatedServer({ env: { FAKE_TRACE_PROMPTS: "1", FAKE_DELAY_MS: "100" } });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (route, body) => {
  const response = await server.api("POST", route, body);
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.data)}`);
  return response.data;
};
function rng(seed) {
  let state = seed >>> 0;
  return () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
}
async function wait(name, predicate, label, timeout = 12_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const snapshot = await server.room(name);
    const runs = snapshot.room.busyInfo || [];
    assert.equal(new Set(runs.map((run) => run.agent)).size, runs.length, "one concurrent run per seat");
    assert.equal(new Set(runs.map((run) => run.runId)).size, runs.length, "distinct active invocation IDs");
    if (predicate(snapshot)) return snapshot;
    await pause(20);
  }
  const snapshot = await server.room(name);
  throw new Error(`${name}: timed out waiting for ${label}\n${JSON.stringify({ busy: snapshot.room.busyInfo,
    queued: snapshot.room.queue, working: snapshot.room.working,
    entries: snapshot.entries.map(({ n, kind, text, meta }) => ({ n, kind, text, meta })),
    traces: traces(name).filter((event) => event.event === "start").map(({ pid, startedAt, seat, phase, overlappingPids }) => ({ pid, startedAt, seat, phase, overlappingPids })) }, null, 2)}`);
}
const settled = (name) => wait(name, ({ room }) => !room.busy.length && !room.queued && !room.working &&
  !room.seats.some((seat) => room.agents[seat].catchUp && !room.agents[seat].asleep), "settled room");
const say = (name, text, options = {}) => post("/api/message", { room: name, text, target: "auto", ...options });
const direct = (snapshot, rootN) => snapshot.entries.filter((entry) => entry.kind === "agent" && entry.meta?.replyTo === rootN && !entry.meta?.hop);
const state = (name) => JSON.parse(fs.readFileSync(path.join(server.root, name, "state.json"), "utf8"));
function traces(name) {
  const file = path.join(server.root, name, "workspace", ".fake-cli-prompts.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}
function audit(name, snapshot) {
  const starts = traces(name).filter((event) => event.event === "start");
  assert(starts.length > 0, "every scenario reaches a fake provider");
  assert.deepEqual(starts.flatMap((event) => event.overlappingPids || []), [], "no duplicate concurrent same-seat CLI execution");
  const charges = new Map();
  for (const artifact of [...snapshot.entries.map((entry) => entry.meta || {}), ...snapshot.receipts]) {
    const launch = artifact.relayLaunch;
    if (!launch) continue;
    const key = `${launch.rootN}:${launch.index}`;
    if (charges.has(key)) assert.deepEqual(launch, charges.get(key), "receipt and entry agree on the same charge");
    else charges.set(key, launch);
  }
  for (const [rootN, used] of Object.entries(state(name).relayUsage || {})) {
    const indexes = [...charges.values()].filter((launch) => String(launch.rootN) === rootN).map((launch) => launch.index).sort((a, b) => a - b);
    assert.deepEqual(indexes, Array.from({ length: used }, (_, index) => index + 1), "every charged launch has exactly one durable terminal identity; no missing or double charge");
  }
  const edges = snapshot.entries.flatMap((entry) => (entry.meta?.relayCap?.dropped || []).map((edge) => `${edge.target}:${edge.n}`));
  assert.equal(new Set(edges).size, edges.length, "cap edges are durable first-wins");
  assert.deepEqual(snapshot.room.busy, []);
  assert.equal(snapshot.room.queued, 0);
  return starts.length;
}

let scenarios = 0, launches = 0;
try {
  for (const seed of seeds) {
    const random = rng(seed);
    const cases = ["queue", "retry", "wake", "generation", "stop-before-cap", "cap-before-stop"];
    for (let i = cases.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [cases[i], cases[j]] = [cases[j], cases[i]];
    }
    for (const scenario of cases) {
      if (process.env.PARLEY_SEQUENCE_CASES && !process.env.PARLEY_SEQUENCE_CASES.split(",").includes(scenario)) continue;
      const name = `s${seed}-${scenario}`;
      const seat = random() < 0.5 ? "claude" : "codex";
      const other = seat === "claude" ? "codex" : "claude";
      await post("/api/rooms", { name });
      await server.configure(name);
      let result;
      if (scenario === "queue") {
        await post("/api/queue/pause", { room: name, paused: true });
        await say(name, "@both SAY:QUEUED_SEQUENCE");
        const queued = await server.room(name);
        const rootN = queued.entries.find((entry) => entry.kind === "user").n;
        await post("/api/queue/cancel", { room: name, groupId: queued.room.queue[0].queueGroupId });
        assert((await server.room(name)).entries.some((entry) => entry.meta?.cancelledQueue), "discard has durable disposition");
        const order = random() < 0.5 ? [seat, other] : [other, seat];
        for (const agent of order) await post("/api/queue/retry", { room: name, n: rootN, agents: [agent] });
        const recovered = await server.room(name);
        assert.equal(recovered.room.queued, 2);
        // A stale group id cannot remove the replacement deliveries.
        await post("/api/queue/cancel", { room: name, groupId: queued.room.queue[0].queueGroupId });
        assert.equal((await server.room(name)).room.queued, 2);
        await post("/api/queue/pause", { room: name, paused: false });
        result = await settled(name);
        assert.deepEqual(direct(result, rootN).map((entry) => entry.author).sort(), ["claude", "codex"]);
      } else if (scenario === "retry" || scenario === "wake") {
        if (scenario === "wake") await post("/api/seat/sleep", { room: name, agent: seat, asleep: true });
        await say(name, `@both FAILONCESEAT:${seat} SLEEP:350 SAY:RECOVER_SEQUENCE`);
        if (scenario === "wake") {
          await settled(name);
          await post("/api/seat/sleep", { room: name, agent: seat, asleep: false, deliver: true });
        }
        const failed = await wait(name, (snapshot) => snapshot.entries.some((entry) => entry.meta?.error), "seat failure");
        const error = failed.entries.find((entry) => entry.meta?.error);
        const rootN = error.meta.recovery.rootN;
        await post("/api/retry", { room: name, rootN, agents: [seat, seat] });
        const duplicate = await server.api("POST", "/api/retry", { room: name, rootN, agents: [seat] });
        assert.equal(duplicate.status, 409, "running failed half cannot retry concurrently");
        result = await settled(name);
        assert.deepEqual(direct(result, rootN).map((entry) => entry.author).sort(), ["claude", "codex"]);
        assert(result.room.resolvedErrors[error.n], "success resolves the preserved failure");
        assert.deepEqual(result.entries.find((entry) => entry.n === error.n), error);
      } else if (scenario === "generation") {
        await say(name, `@${seat} READY:sequence-old SLEEP:20000 SAY:OLD_GENERATION`);
        const old = await wait(name, (snapshot) => snapshot.room.busy.includes(seat) && fs.existsSync(path.join(server.root, name, "workspace", ".fake-cli-ready-sequence-old")), "old provider launch");
        const oldRun = old.room.busyInfo.find((run) => run.agent === seat);
        await say(name, `@${seat} SAY:OLD_QUEUED`);
        await post("/api/new", { room: name });
        await say(name, `@${seat} READY:sequence-new SLEEP:350 SAY:NEW_GENERATION`);
        await wait(name, (snapshot) => snapshot.room.busyInfo.some((run) => run.agent === seat && run.runId !== oldRun.runId) &&
          fs.existsSync(path.join(server.root, name, "workspace", ".fake-cli-ready-sequence-new")), "replacement provider launch", 30000);
        const stale = await post("/api/stop", { room: name, scope: "seat", agent: seat, runId: oldRun.runId });
        assert.equal(stale.stale, true);
        assert.equal(stale.stopped, false);
        result = await settled(name);
        assert(!result.entries.some((entry) => /OLD_GENERATION|OLD_QUEUED/.test(entry.text)), "old generation writes nothing into replacement");
        assert.equal(result.entries.filter((entry) => entry.kind === "agent" && entry.text === "NEW_GENERATION").length, 1);
      } else if (scenario === "stop-before-cap") {
        await say(name, `@${seat} READY:sequence-stop SLEEP:20000 PINGPONG`, { hopBudget: 1 });
        const running = await wait(name, (snapshot) => snapshot.room.busy.includes(seat) && fs.existsSync(path.join(server.root, name, "workspace", ".fake-cli-ready-sequence-stop")), "provider to stop");
        await post("/api/stop", { room: name, scope: "active", runs: running.room.busyInfo.map(({ agent, runId }) => ({ agent, runId })) });
        result = await settled(name);
        assert(result.entries.some((entry) => entry.meta?.stopped), "stopped invocation has a terminal artifact");
        assert(!result.entries.some((entry) => entry.meta?.relayCap), "Stop before launch creates no cap");
        assert.equal(result.receipts.length, 0, "stopped attempt has no success receipt");
      } else {
        await say(name, "@both PINGPONG", { hopBudget: random() < 0.5 ? 0 : 1 });
        result = await settled(name);
        const caps = result.entries.filter((entry) => entry.meta?.relayCap);
        assert(caps.length > 0, "fixture reaches cap before Stop");
        await post("/api/stop", { room: name, scope: "all" });
        const stopped = await settled(name);
        assert.deepEqual(stopped.entries.filter((entry) => entry.meta?.relayCap), caps, "Stop preserves earlier cap chronology");
        result = stopped;
      }
      launches += audit(name, result);
      scenarios++;
      console.log(`✓ seed ${seed}: ${scenario} (${seat})`);
    }
  }
  console.log(`${scenarios} seeded scheduler sequences passed; ${launches} fake invocations audited; seeds ${seeds.join(", ")}.`);
} catch (error) { console.error(`Reproduce with PARLEY_SEQUENCE_SEED.\n${server.log()}`); throw error; }
finally { await server.close(); }
