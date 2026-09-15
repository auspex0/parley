import { test } from "node:test";
import assert from "node:assert/strict";
import { newCapEdges, publicRelayRun, normalizeHopBudget, requireMessageHopBudget, resolveRelaySafetyLimit } from "../lib/budget-policy.mjs";
import { relayAllowanceNote } from "../lib/budget-prompts.mjs";
import { createCausalCoordinator } from "../lib/causal-coordinator.mjs";

function fixture({ budget = 0, overrides = {} } = {}) {
  const room = { generation: 1, entries: [], state: { agents: { a: { cursor: 0 }, b: { cursor: 0 } } } };
  const chain = { stopped: false };
  const outcomes = [], launches = [];
  let used = 0;
  const deps = {
    HOP_SAFETY_HOPS: 4, relayUsed: () => used,
    findHopTarget: (_room, entry) => entry.target,
    persistLurkOutcome: (_room, target, range, reason) => outcomes.push({ target, ...range, reason }),
    isEntryResult: (e) => !!e?.n, otherSeat: (_room, author) => author === "a" ? "b" : "a",
    withdrawnFrom: () => false, chainHalted: () => chain.stopped,
    isAsleep: () => false, noteSleepSkip: () => {}, seatOccupied: () => false,
    waitForHopSeat: async () => true, broadcast: () => {}, roomSummary: () => ({}),
    runHopTurn: async (_room, target, trigger, rootN, scope, opts) => {
      launches.push(opts.onLaunch?.());
      room.state.agents[target].cursor = trigger.n;
      return null;
    },
    recordRelayLaunch: () => ++used,
    HOP_FAILED: Symbol(), STEP_STOPPED: Symbol(), SEAT_ASLEEP: Symbol(),
    deliverCausalAnswer: async () => ({ seen: false, entry: null }),
    causalAnswerRange: (reply) => ({ sinceN: reply.n, throughN: reply.n, triggerN: reply.n }),
    appendEntry: (_room, entry) => { room.entries.push(entry); return entry; },
    CAUSAL_CONTINUATION_INSTRUCTION: "continuation",
    ...overrides,
  };
  const make = () => createCausalCoordinator(deps, room, {
    userTurn: { n: 1, target: "a" }, chain, gen: 1,
    relayPolicy: { hopBudget: budget, source: "message" },
    hopRun: { used },
  });
  return { room, chain, outcomes, launches, deps, make };
}
const request = (n = 2) => ({ n, kind: "agent", author: "a", target: "b" });

test("cap before Stop survives, pending chime stops, finalization is terminal and idempotent", async () => {
  const f = fixture(); const c = f.make();
  c.enqueueInitial([request()]); await c.settle();
  assert.equal(f.room.entries.length, 0, "caps wait only until coordinator completion");
  c.enqueueLurks([{ n: 3, kind: "agent", author: "b", target: "a" }]);
  f.chain.stopped = true; await c.settle(); c.finalize(); c.finalize();
  c.enqueueInitial([request(4)]); await c.settle();
  assert.deepEqual(f.room.entries[0].meta.relayCap.dropped, [{ n: 2, target: "b" }]);
  assert.deepEqual(f.outcomes.map((e) => [e.triggerN, e.reason]), [[3, "request-stopped"]]);
  assert.equal(f.room.entries.length, 1); assert.equal(f.launches.length, 0);
});

test("Stop before launch disposes request without inventing a cap", async () => {
  const f = fixture(); const c = f.make(); c.enqueueInitial([request()]);
  f.chain.stopped = true; await c.settle(); c.finalize();
  assert.equal(f.outcomes[0].reason, "request-stopped");
  assert.equal(f.room.entries.length, 0); assert.equal(f.launches.length, 0);
});

test("replaced generation writes no pending or capped artifacts", async () => {
  const f = fixture(); const c = f.make(); c.enqueueInitial([request()]); await c.settle();
  c.enqueueLurks([{ ...request(3), author: "b", target: "a" }]);
  f.room.generation++; c.finalize();
  assert.deepEqual(f.room.entries, []); assert.deepEqual(f.outcomes, []);
});

test("unexpected launch exception disposes active and queued work without restarting", async () => {
  let calls = 0;
  const f = fixture({ budget: 2, overrides: { runHopTurn: async () => { calls++; throw Error("fixture staging failure"); } } });
  const c = f.make(); c.enqueueInitial([request(2), request(3)]);
  await assert.rejects(c.settle(), /fixture staging failure/); c.finalize(); c.finalize(); await c.settle();
  assert.equal(calls, 1);
  assert.deepEqual(f.outcomes.map((e) => [e.triggerN, e.reason]), [[2, "request-failed"], [3, "request-failed"]]);
});

test("unexpected answer exception retains an explicit failed answer disposition", async () => {
  const f = fixture({ budget: 1 });
  f.deps.runHopTurn = async (_r, target, trigger, _root, _scope, opts) => {
    opts.onLaunch(); f.room.state.agents[target].cursor = trigger.n;
    return { n: 3, kind: "agent", author: target };
  };
  f.deps.deliverCausalAnswer = async () => { throw Error("answer failure"); };
  const c = f.make(); c.enqueueInitial([request()]);
  await assert.rejects(c.settle(), /answer failure/); c.finalize();
  assert.equal(f.outcomes[0].reason, "closure-failed"); assert.equal(f.outcomes[0].triggerN, 3);
});

test("successful final pass charges exactly once and produces no cap", async () => {
  const f = fixture({ budget: 1 }); const c = f.make();
  c.enqueueInitial([request()]); await c.settle(); c.finalize();
  assert.deepEqual(f.launches, [{ rootN: 1, triggerEntryN: 2, index: 1, budget: 1, limit: 1, source: "message" }]);
  assert.deepEqual(f.room.entries, []); assert.deepEqual(f.outcomes, []);
});

test("recovered coordinators durably deduplicate old cap edges, allow new ones, and honor later cursors", async () => {
  const f = fixture();
  for (const ns of [[2], [2, 3]]) {
    const c = f.make(); c.enqueueInitial(ns.map(request)); await c.settle(); c.finalize();
  }
  assert.deepEqual(f.room.entries.map((e) => e.meta.relayCap.dropped), [[{ n: 2, target: "b" }], [{ n: 3, target: "b" }]]);
  const c = f.make(); c.enqueueInitial([request(4)]); await c.settle();
  f.room.state.agents.b.cursor = 4; c.finalize(); assert.equal(f.room.entries.length, 2);
});

test("cap identity is first wins; only root, budget, source and policy identity conflict", () => {
  const prior = { rootN: 1, budget: -1, source: "room", used: 4, limit: 4, dropped: [{ n: 2, target: "b" }] };
  const entries = [{ meta: { relayCap: prior } }]; let conflicts = 0;
  assert.deepEqual(newCapEdges(entries, prior.dropped, { ...prior, used: 25, limit: 25 }, () => conflicts++), []);
  assert.equal(conflicts, 0);
  for (const change of [{ rootN: 2 }, { budget: 3 }, { source: "message" }, { policyId: "new" }]) {
    newCapEdges(entries, prior.dropped, { ...prior, ...change }, () => conflicts++);
  }
  assert.equal(conflicts, 4);
});

test("public relay projection never spreads internal coordinator properties", () => {
  assert.deepEqual(Object.keys(publicRelayRun({ id: "d1", secret: "internal", chain: {} })),
    ["id", "rootN", "used", "budget", "limit", "source", "phase", "accounting"]);
  assert.equal(normalizeHopBudget("4"), 4); assert.throws(() => requireMessageHopBudget(9));
});

test("the process safety ceiling is always a finite positive safe integer", () => {
  for (const raw of ["Infinity", "NaN", "1.5", "0", "-4", undefined, "999999999999999999999"]) {
    assert.equal(resolveRelaySafetyLimit(raw), 25);
  }
  assert.equal(resolveRelaySafetyLimit("1"), 2);
  assert.equal(resolveRelaySafetyLimit("4"), 4);
});

test("dynamic prompt contract distinguishes Solo, zero structural delivery and recovered safety boundaries", () => {
  assert.match(relayAllowanceNote({ solo: true }, 0, 4, { root: true }), /Solo mode/);
  assert.match(relayAllowanceNote({ budget: 0 }, 0, 4, { root: true }), /Separately owed sibling delivery/);
  assert.equal(relayAllowanceNote({ budget: -1 }, 0, 2, { root: true }), null);
  for (const [used, remaining] of [[2, 2], [3, 1], [4, 0]]) {
    const note = relayAllowanceNote({ budget: -1 }, used, 4, { root: true });
    assert.match(note, new RegExp(`${remaining} charged continuation`));
    assert.match(note, /shared across both seats and not reserved per seat/);
    assert.match(note, /new message/);
  }
  assert.match(relayAllowanceNote({ budget: -1 }, 1, 2, { charged: true }), /1 charged continuation remains after this turn/);
});
