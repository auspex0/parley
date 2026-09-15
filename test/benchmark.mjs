#!/usr/bin/env node
// Reproducible synthetic-room/browser measurement, never a live provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { isolatedServer } from "./server-fixture.mjs";

const count = 2 * Math.floor(Math.max(400, Math.min(20_000, Number(process.env.PARLEY_BENCH_ENTRIES) || 6000)) / 2);
const samples = Math.floor(Math.max(1, Math.min(5, Number(process.env.PARLEY_BENCH_SAMPLES) || 3)));
const server = await isolatedServer({ env: { FAKE_TRACE_PROMPTS: "1" } });
let browser;
const results = { machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length }, entries: count, samples, rendering: [], conversations: [] };
const post = async (route, body) => {
  const response = await server.api("POST", route, body);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
};
async function wait(read, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
const idle = (name) => wait(() => server.room(name), ({ room }) => !room.busy.length && !room.queued && !room.working &&
  !room.seats.some((seat) => room.agents[seat].catchUp && !room.agents[seat].asleep), name);
const traces = (name) => {
  const file = path.join(server.root, name, "workspace", ".fake-cli-prompts.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((row) => row.event === "start") : [];
};
const round = (n) => Math.round(n * 10) / 10;
try {
  const name = "synthetic-long-room";
  const directory = path.join(server.root, name);
  fs.mkdirSync(path.join(directory, "workspace"), { recursive: true });
  const config = (await server.room("default")).room.cfg;
  fs.writeFileSync(path.join(directory, "room.json"), JSON.stringify(config));
  const entries = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      n, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      kind: i % 2 ? "agent" : "user", author: i % 2 ? (i % 4 === 1 ? "claude" : "codex") : "user",
      ...(i % 2 ? { meta: { replyTo: n === count ? 1 : n - 1 } } : { target: "both" }),
      text: `Synthetic message ${n}. A reproducible paragraph with **bold text**, a list of constraints, and a useful explanation.\n\n${"Room history remains readable across long conversations. ".repeat(4)}`,
    };
  });
  fs.writeFileSync(path.join(directory, "events.jsonl"), entries.map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ agents: { claude: { cursor: count }, codex: { cursor: count } } }));
  results.transcriptBytes = fs.statSync(path.join(directory, "events.jsonl")).size;
  browser = await chromium.launch();
  for (let sample = 0; sample < samples; sample++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const started = performance.now();
    await page.goto(`${server.url}/?room=${name}`);
    await page.locator(`[data-n="${count}"]`).waitFor();
    await page.locator("#connDot.on").waitFor();
    const initialMs = performance.now() - started;
    const initialRows = await page.locator("#chat > [data-n]").count();
    const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
    const jumpStarted = performance.now();
    await page.locator(`[data-n="${count}"] [data-jump-n="1"]`).click();
    await page.locator('[data-n="1"].jump-flash').waitFor();
    await page.waitForFunction(() => {
      const target = document.querySelector('[data-n="1"]').getBoundingClientRect();
      const viewport = document.querySelector("#chatWrap").getBoundingClientRect();
      return target.bottom > viewport.top && target.top < viewport.bottom;
    });
    const deepNavigationMs = performance.now() - jumpStarted;
    const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
    results.rendering.push({ sample: sample + 1, initialMs: round(initialMs), initialRows,
      deepNavigationMs: round(deepNavigationMs), revealedRows: await page.locator("#chat > [data-n]").count(),
      deepLayoutMs: round(1000 * (after.LayoutDuration - before.LayoutDuration)), deepScriptMs: round(1000 * (after.ScriptDuration - before.ScriptDuration)),
      deepLayouts: after.LayoutCount - before.LayoutCount, heapMiB: round(after.JSHeapUsedSize / 1024 ** 2) });
    assert.deepEqual(errors, []);
    await context.close();
  }

  for (const scenario of [
    { name: "single-no-listener", text: "@claude NOATTENTION", listeners: false, expected: 1 },
    { name: "single-silent-listener", text: "@claude NOATTENTION", listeners: true, expected: 2 },
    { name: "solo-with-listener-enabled", text: "@claude NOATTENTION", listeners: true, solo: true, expected: 1 },
    { name: "both-budget-zero", text: "@both PINGPONG", budget: 0, maximum: 5 },
    { name: "both-budget-one", text: "@both PINGPONG", budget: 1, maximum: 7 },
  ]) {
    await post("/api/rooms", { name: scenario.name });
    await server.configure(scenario.name, { hopBudget: scenario.budget ?? 0, agents: { codex: { lurk: !!scenario.listeners } } });
    const start = performance.now();
    await post("/api/message", { room: scenario.name, text: scenario.text, target: "auto", ...(scenario.solo ? { solo: true } : {}) });
    const first = await wait(() => server.room(scenario.name), (snapshot) => snapshot.entries.some((entry) => entry.kind === "agent"), "first reply");
    const firstReplyMs = performance.now() - start;
    const done = await idle(scenario.name);
    const calls = traces(scenario.name);
    assert(calls.length > 0, "fake trace must record invocations");
    assert(calls.every((call) => !call.overlappingPids?.length), "concurrent same-seat CLI invocation");
    if (scenario.expected) assert.equal(calls.length, scenario.expected, scenario.name);
    if (scenario.maximum) assert(calls.length <= scenario.maximum, `${scenario.name}: ${calls.length} > ${scenario.maximum}`);
    results.conversations.push({ name: scenario.name, invocations: calls.length,
      unexpectedInvocations: Math.max(0, calls.length - (scenario.expected || scenario.maximum)),
      silentListenerInvocations: done.receipts.filter((receipt) => receipt.mode === "lurk" && !receipt.spoke).length,
      silentInvocations: done.receipts.filter((receipt) => receipt.spoke === false).length,
      firstReplyMs: round(firstReplyMs), completionMs: round(performance.now() - start),
      outputBubbles: done.entries.filter((entry) => entry.kind === "agent").length,
      duplicateConcurrentInvocations: calls.flatMap((call) => call.overlappingPids || []).length,
      firstReplySeat: first.entries.find((entry) => entry.kind === "agent").author });
  }

  await post("/api/rooms", { name: "stream-measurement" });
  await server.configure("stream-measurement");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${server.url}/?room=stream-measurement`);
  await page.locator("#connDot.on").waitFor();
  await page.evaluate(() => {
    window.streamMetrics = { started: performance.now(), changes: [] };
    new MutationObserver(() => {
      const text = document.querySelector('[data-live-agent="codex"] .bubble')?.textContent || "";
      if (text && text !== window.streamMetrics.lastText) {
        window.streamMetrics.changes.push({ at: performance.now(), length: text.length });
        window.streamMetrics.lastText = text;
      }
    }).observe(document.querySelector("#chat"), { childList: true, subtree: true, characterData: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
  await page.locator("#input").fill("@codex STREAM SAY:REPRODUCIBLE_STREAM_LAYOUT_MEASUREMENT");
  await page.locator("#sendBtn").click();
  await page.locator('.msg.agent.codex[data-n] .bubble').filter({ hasText: "REPRODUCIBLE_STREAM_LAYOUT_MEASUREMENT" }).waitFor();
  const stream = await page.evaluate(() => ({ ...window.streamMetrics, finished: performance.now() }));
  const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
  assert(stream.changes.length > 1, "stream must visibly update before final response");
  results.streaming = { visibleUpdates: stream.changes.length, firstUpdateMs: round(stream.changes[0].at - stream.started),
    finalMs: round(stream.finished - stream.started), layoutMs: round(1000 * (after.LayoutDuration - before.LayoutDuration)),
    scriptMs: round(1000 * (after.ScriptDuration - before.ScriptDuration)), layouts: after.LayoutCount - before.LayoutCount };
  console.log(JSON.stringify(results, null, 2));
} finally { if (browser) await browser.close(); await server.close(); }
