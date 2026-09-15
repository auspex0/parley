#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedServer } from "./server-fixture.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(read, condition, label, ms = 25000) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (condition(value)) return value;
    await delay(35);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}
function trace(workspace) {
  const file = path.join(workspace, ".fake-cli-prompts.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === "start") : [];
}
async function watchStarts(server, name) {
  const html = await fetch(server.url).then((res) => res.text());
  const token = /name="parley-token" content="([^"]+)"/.exec(html)[1];
  const protocol = /name="parley-runtime-protocol" content="([^"]+)"/.exec(html)[1];
  const controller = new AbortController();
  const response = await fetch(`${server.url}/api/events?room=${name}&token=${token}&protocol=${protocol}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const starts = new Map();
  let readError;
  const reading = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          for (const line of frame.split("\n").filter((s) => s.startsWith("data: "))) {
            const message = JSON.parse(line.slice(6));
            if (message.type === "status" && message.phase !== "done" && !starts.has(message.runId)) starts.set(message.runId, message);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) readError = error;
    }
  })();
  return async () => {
    controller.abort();
    await reading;
    if (readError) throw readError;
    return [...starts.values()];
  };
}
const allowance = (invocation) => /(?:Safety boundary|Continuation allowance): (\d+) charged continuation/.exec(invocation.prompt)?.[1];
const assertShared = (invocation, count) => {
  assert.equal(allowance(invocation), String(count), `${invocation.phase}: ${invocation.prompt.slice(-1500)}`);
  assert.match(invocation.prompt, /shared across both seats and not reserved per seat/);
  assert.match(invocation.prompt, /new message/);
  assert.doesNotMatch(invocation.briefing, /charged continuation(?:s remain| remains)/);
};

for (const safety of [2, 4]) {
  const server = await isolatedServer({ env: { PARLEY_HOP_SAFETY: String(safety), FAKE_TRACE_PROMPTS: "1", FAKE_DELAY_MS: "35" } });
  const post = async (route, body) => {
    const result = await server.api("POST", route, body);
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  const create = async (name, cfg = {}) => {
    await post("/api/rooms", { name });
    await server.configure(name, cfg);
  };
  const say = (name, text, extra = {}) => post("/api/message", { room: name, text, target: "auto", ...extra });
  const settled = (name) => wait(() => server.room(name), (d) =>
    !d.room.busy.length && !d.room.queued && !d.room.working &&
    !Object.values(d.room.agents).some((a) => a.catchUp && !a.asleep), `${name} to settle`, 45000);
  try {
    await create("solo");
    await say("solo", "@claude PINGPONG", { solo: true });
    let d = await settled("solo");
    let invocations = trace(d.room.workspace);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0].prompt, /Solo mode: only you are being invoked/);

    await create("zero");
    await say("zero", "@claude SAY:ZERO");
    d = await settled("zero");
    invocations = trace(d.room.workspace);
    assert.equal(invocations.length, 1);
    assertShared(invocations[0], 0);
    assert.match(invocations[0].prompt, /Separately owed sibling delivery, enabled listening, and one answer return/);
    assert.doesNotMatch(invocations[0].prompt, /no agent-to-agent delivery|Solo mode/);

    for (const budget of [0, 1]) {
      const name = `both${budget}`;
      await create(name, { hopBudget: budget });
      const stopWatching = await watchStarts(server, name);
      await say(name, "@both PINGPONG");
      d = await settled(name);
      const starts = await stopWatching();
      invocations = trace(d.room.workspace);
      assert.ok(invocations.length > 2 && invocations.length <= 5 + 2 * budget,
        `${name}: expected at most ${5 + 2 * budget} actual turns, got ${invocations.length}`);
      assert.equal(invocations.filter((i) => i.phase === "root").length, 2);
      const sibling = invocations.find((i) => i.phase === "sibling");
      assert.ok(sibling);
      assertShared(sibling, budget);
      assert.match(sibling.prompt, /This sibling is uncharged/);
      for (const kind of ["sibling", "answer-return"]) {
        const firstStatus = starts.find((run) => run.delivery?.kind === kind);
        assert.ok(firstStatus, `first SSE status exposes ${kind} delivery`);
        assert.equal(firstStatus.delivery.source, "room");
        assert.equal(firstStatus.delivery.counted, false);
        assert.equal(firstStatus.sourceN, firstStatus.delivery.triggerEntryN);
      }
    }

    await create("until", { hopBudget: -1 });
    await say("until", "@claude PINGPONG");
    d = await settled("until");
    invocations = trace(d.room.workspace);
    assert.equal(allowance(invocations[0]), undefined, "fresh Until-settled root has no scarcity note");
    assert.equal(d.room.hopSafetyLimit, safety);
    const launches = d.receipts.filter((r) => r.relayLaunch);
    assert.equal(launches.length, safety);
    assert.deepEqual(launches.map((r) => r.relayLaunch.index), Array.from({ length: safety }, (_, i) => i + 1));
    for (const receipt of launches) {
      const launch = receipt.relayLaunch;
      assert.equal(launch.limit, safety);
      assert.equal(launch.budget, -1);
      assert.equal(launch.source, "room");
      assert.ok(launch.rootN > 0 && launch.triggerEntryN > launch.rootN);
      assert.equal(receipt.outcome, "text");
      const reply = d.entries.find((e) => e.meta?.relayLaunch?.index === launch.index);
      assert.deepEqual(reply.meta.relayLaunch, launch);
    }
    for (const phase of ["explicit", "continuation", "closure"]) assert.ok(invocations.some((i) => i.phase === phase), phase);
    for (const count of safety === 2 ? [1, 0] : [2, 1, 0]) {
      assert.ok(invocations.some((i) => allowance(i) === String(count)), `allowance ${count}`);
    }
    for (const invocation of invocations.filter((i) => allowance(i) !== undefined)) {
      assertShared(invocation, Number(allowance(invocation)));
    }
    const returns = invocations.filter((i) => i.phase === "closure");
    assert.ok(returns.some((i) => allowance(i) === "0"));
    assert.ok(returns.some((i) => /This answer-return is uncharged/.test(i.prompt)));
    const caps = d.entries.filter((e) => e.meta?.relayCap);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].meta.relayCap.limit, safety);
    assert.equal(caps[0].meta.relayCap.source, "room");
    console.log(`✓ safety ${safety}: actual root, sibling, explicit, continuation and answer-return prompts; @both 5/7 bounds; charged text ordinals`);

    for (const remaining of [2, 1, 0].filter((n) => n < safety)) {
      const name = `recovered${remaining}`;
      const dir = path.join(server.root, name);
      fs.mkdirSync(dir);
      const stored = JSON.parse(fs.readFileSync(path.join(server.root, "default", "state.json"), "utf8"));
      const cfg = JSON.parse(fs.readFileSync(path.join(server.root, "default", "room.json"), "utf8"));
      cfg.hopBudget = 8; // today's config cannot reinterpret the stored root
      stored.nextTurn = 2;
      stored.lastUser = { n: 1, text: "SAY:RECOVERED", target: "claude", done: {} };
      stored.relayUsage = { 1: safety - remaining };
      const entry = { n: 1, kind: "user", author: "you", target: "claude", text: "SAY:RECOVERED", meta: { relay: { hopBudget: -1, source: "message", solo: false } } };
      fs.writeFileSync(path.join(dir, "room.json"), JSON.stringify(cfg));
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(stored));
      fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify(entry) + "\n");
      await post("/api/retry", { room: name, rootN: 1, agents: ["claude"] });
      d = await settled(name);
      assertShared(trace(d.room.workspace)[0], remaining);
      assert.match(trace(d.room.workspace)[0].prompt, /Safety boundary/);
    }

    await create("lurk", { hopBudget: 1, agents: { codex: { lurk: true } } });
    await say("lurk", "@claude SAY:CLOSURETAG");
    d = await settled("lurk");
    invocations = trace(d.room.workspace);
    const listening = invocations.find((i) => i.phase === "lurk");
    const lurkReturn = invocations.find((i) => i.phase === "lurk-return");
    assert.ok(listening && lurkReturn);
    assertShared(listening, 1);
    assert.match(listening.prompt, /This enabled listening is uncharged/);
    assertShared(lurkReturn, 1);
    assert.match(lurkReturn.prompt, /This lurk is uncharged/);
    console.log(`✓ safety ${safety}: recovered durable allowances and enabled listener/return prompts`);

    for (const mode of ["pass", "empty", "slow", "fail"]) {
      const name = `outcome${mode}`;
      await create(name, { hopBudget: 1 });
      await say(name, mode === "fail" ? "@claude TAGVERSIONFAIL:codex" : `@claude HOPRESULT:${mode}`, { hopBudget: 1 });
      if (mode === "slow") {
        const live = await wait(() => server.room(name), (x) => x.room.busyInfo.some((run) => run.relayLaunch), "charged launch before Stop");
        const run = live.room.busyInfo.find((r) => r.relayLaunch);
        assert.equal(run.relayLaunch.index, 1);
        assert.equal(run.relayLaunch.source, "message");
        const active = live.room.hopRuns.find((r) => r.rootN === run.rootN);
        assert.deepEqual(Object.keys(active).sort(), ["accounting", "budget", "id", "limit", "phase", "rootN", "source", "used"]);
        assert.equal(active.limit, 1);
        await post("/api/stop", { room: name, agent: run.agent, runId: run.runId });
      }
      d = await settled(name);
      const charged = d.receipts.filter((r) => r.relayLaunch);
      const usage = JSON.parse(fs.readFileSync(path.join(server.root, name, "state.json"), "utf8")).relayUsage;
      assert.deepEqual(Object.values(usage), [1], `${mode} spends its launched unit`);
      if (mode === "pass" || mode === "empty") {
        assert.equal(charged.length, 1);
        assert.equal(charged[0].outcome, mode);
        assert.equal(charged[0].spoke, false);
        assert.equal(charged[0].relayLaunch.index, 1);
        assert.equal(charged[0].relayLaunch.source, "message");
        assert.equal(d.entries.filter((e) => e.meta?.relayCap).length, 0, "final silence alone does not create a cap");
      } else {
        assert.equal(charged.length, 0, "failed/stopped attempts create no success receipt");
        const terminal = d.entries.find((e) => e.meta?.relayLaunch);
        assert.ok(terminal && terminal.meta[mode === "slow" ? "stopped" : "error"]);
        assert.equal(terminal.meta.relayLaunch.index, 1);
        assert.equal(terminal.meta.relayLaunch.source, "message");
        assert.ok(d.room.agents.codex.cursor < terminal.meta.relayLaunch.triggerEntryN);
        assert.equal(terminal.meta.recovery, undefined, "causal failure has no ordinary root Retry");
      }
    }
    console.log(`✓ safety ${safety}: charged pass/empty/Stop/failure keep launch provenance without refunds or false receipts`);

    await create("catchup", { hopBudget: 0, agents: { codex: { lurk: true } } });
    const stopWatchingCatchUp = await watchStarts(server, "catchup");
    await say("catchup", "@codex SLEEP:3500 SAY:BLOCKER");
    await wait(() => server.room("catchup"), (x) => x.room.busy.includes("codex"), "catch-up listener occupied");
    await say("catchup", "@claude SAY:CLOSURETAG");
    await wait(() => server.room("catchup"), (x) => !!x.room.agents.codex.catchUp && !x.room.busy.includes("claude"), "first catch-up root");
    await say("catchup", "@claude SAY:CHIME");
    const pending = await wait(() => server.room("catchup"), (x) => {
      const second = x.entries.find((e) => e.author === "claude" && e.text === "CHIME");
      return second && x.room.agents.codex.catchUp?.throughN >= second.n;
    }, "both catch-up exchanges recorded");
    const owed = pending.room.agents.codex.catchUp;
    const expectedRoots = pending.entries.filter((e) => e.kind === "user" && e.meta?.audience?.lurking.includes("codex")).map((e) => e.n);
    assert.equal(expectedRoots.length, 2);
    d = await settled("catchup");
    const catchUpStarts = await stopWatchingCatchUp();
    const receipt = d.receipts.find((r) => r.mode === "lurk-catchup");
    assert.deepEqual(receipt.catchUp, { rootNs: expectedRoots, ownerRootN: expectedRoots.at(-1), fromN: owed.sinceN, throughN: owed.throughN });
    const chime = d.entries.find((e) => e.meta?.lurkCatchUp);
    assert.deepEqual(chime.meta.catchUp, receipt.catchUp);
    const answer = d.entries.find((e) => e.meta?.catchUpReturn);
    assert.ok(answer);
    assert.deepEqual(answer.meta.catchUp, receipt.catchUp);
    const terminal = d.receipts.find((r) => r.mode === "closure");
    assert.ok(terminal);
    assert.deepEqual(terminal.catchUp, receipt.catchUp);
    const catchUpStart = catchUpStarts.find((run) => run.phase === "catching-up");
    assert.ok(catchUpStart, "catch-up emitted an initial status");
    assert.deepEqual(catchUpStart.catchUp, receipt.catchUp, "initial status carries exact roots and covered range");
    for (const kind of ["catch-up-return", "catch-up-answer"]) {
      const firstStatus = catchUpStarts.find((run) => run.delivery?.kind === kind);
      assert.ok(firstStatus, `initial SSE status exposes ${kind}`);
      assert.equal(firstStatus.delivery.source, "catch-up");
      assert.equal(firstStatus.delivery.counted, false);
      assert.deepEqual(firstStatus.catchUp, receipt.catchUp);
    }
    const catchingUp = trace(d.room.workspace).find((i) => i.prompt.includes("one coalesced catch-up"));
    assert.ok(catchingUp);
    assert.equal(allowance(catchingUp), undefined, "coalesced roots have no ordinary root allowance");
    console.log(`✓ safety ${safety}: coalesced catch-up retains exact roots/range through the return and terminal answer`);
  } finally {
    await server.close();
  }
}
console.log("Provenance integration coverage passed.");
