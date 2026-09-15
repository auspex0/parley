/** Real Chromium regressions. Install once: npx playwright install chromium. */
import fs from "node:fs";
import path from "node:path";
import { test, expect, createRoom, send, idle, stopMenu } from "./browser-fixture.mjs";

test("creates a room by clicking its actual submit button", async ({ app, server }) => {
  await createRoom(app, server, "clicked");
  expect((await server.room("clicked")).room.seats).toEqual(["claude", "codex"]);
  await expect(app.locator("#roomList .room-item.active")).toContainText("clicked");
});

test("creates a room by implicit Enter with multiple visible text fields", async ({ app, server }) => {
  await createRoom(app, server, "keyboard", { enter: true, sameProvider: true });
  expect((await server.room("keyboard")).room.seats).toEqual(["builder", "reviewer"]);
  await expect(app.locator("#seatChips")).toContainText("@builder");
  await expect(app.locator("#seatChips")).toContainText("@reviewer");
});

test("selected recipient gets progressive stream and one final bubble", async ({ app, server }) => {
  await createRoom(app, server, "stream");
  await app.locator('.chip[data-t="codex"]').click();
  const text = "STREAM SAY:BROWSER_PROGRESSIVE_RESPONSE";
  await app.locator("#input").fill(text);
  await expect(app.locator("#routeHint")).toContainText(/codex/i);
  await send(app, text, { enter: true });
  const live = app.locator('[data-live-agent="codex"] .bubble');
  await expect(live).toContainText("BROW");
  const partial = await live.innerText();
  expect(partial.length).toBeLessThan("BROWSER_PROGRESSIVE_RESPONSE".length);
  await expect(app.locator('#pill_codex')).toHaveClass(/busy/);
  await expect(app.locator('#stopBtn')).toBeVisible();
  await expect(app.locator('.msg.agent.codex[data-n] .bubble')).toHaveText("BROWSER_PROGRESSIVE_RESPONSE");
  const finished = await idle(server, "stream");
  expect(finished.entries.filter((entry) => entry.kind === "user")).toMatchObject([{ text, target: "codex" }]);
  expect(finished.entries.filter((entry) => entry.kind === "agent")).toMatchObject([{ author: "codex", text: "BROWSER_PROGRESSIVE_RESPONSE" }]);
  await expect(app.locator('[data-live-agent]')).toHaveCount(0);
  await expect(app.locator('#stopWrap')).toBeHidden();
});

test("visible Stop pins and stops the running response", async ({ app, server }) => {
  await createRoom(app, server, "stop");
  await send(app, "@codex READY:browser-stop SLEEP:20000 SAY:SHOULD_NOT_FINISH");
  await expect.poll(() => fs.existsSync(path.join(server.root, "stop", "workspace", ".fake-cli-ready-browser-stop"))).toBe(true);
  const { room } = await server.room("stop");
  const run = room.busyInfo.find((info) => info.agent === "codex");
  const request = app.waitForRequest((req) => new URL(req.url()).pathname === "/api/stop");
  await app.locator("#stopBtn").click();
  expect((await request).postDataJSON()).toMatchObject({ room: "stop", scope: "active", runs: [{ agent: "codex", runId: run.runId }] });
  const finished = await idle(server, "stop");
  expect(finished.entries.some((entry) => entry.kind === "agent" && entry.text === "SHOULD_NOT_FINISH")).toBe(false);
  await expect(app.locator("#chat")).toContainText(/stopped/i);
  await expect(app.locator('[data-live-agent]')).toHaveCount(0);
  await expect(app.locator("#stopWrap")).toBeHidden();
});

test("error Retry recovers only the failed root seat while its sibling is busy", async ({ app, server }) => {
  await createRoom(app, server, "retry");
  const original = "@both FAILONCESEAT:claude SLEEP:6000 SAY:ORIGINAL_RETRY";
  await send(app, original);
  const retry = app.locator(".sysmsg.err").getByRole("button", { name: /^Retry/ }).first();
  await expect(retry).toBeVisible();
  const failed = await server.room("retry");
  const root = failed.entries.find((entry) => entry.kind === "user");
  const sibling = failed.room.busyInfo.find((run) => run.agent === "codex");
  expect(sibling).toBeTruthy();
  await expect(retry).toBeEnabled();
  const response = app.waitForResponse((res) => new URL(res.url()).pathname === "/api/retry");
  await retry.click();
  const recovered = await response;
  expect(recovered.request().postDataJSON()).toMatchObject({ room: "retry", rootN: root.n, agents: ["claude"] });
  expect(recovered.status(), await recovered.text()).toBe(200);
  await expect.poll(async () => (await server.room("retry")).room.busyInfo.some((run) => run.agent === "claude" && run.rootN === root.n)).toBe(true);
  expect((await server.room("retry")).room.busyInfo.find((run) => run.agent === "codex").runId).toBe(sibling.runId);
  const finished = await idle(server, "retry");
  expect(finished.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
  for (const seat of ["claude", "codex"]) {
    const replies = finished.entries.filter((entry) => entry.kind === "agent" && entry.author === seat && entry.text === "ORIGINAL_RETRY");
    expect(replies).toHaveLength(1);
  }
  await expect(app.locator(".sysmsg.err").first()).toBeVisible();
  await expect(retry).toBeDisabled();
});

test("cancelled queued Pair offers one root-bound whole-cycle recovery", async ({ app, server }) => {
  await createRoom(app, server, "pair-queue");
  await send(app, "/pair start @claude SLEEP:20000 SAY:FIRST_PAIR");
  await expect(app.locator('[data-live-agent="claude"]')).toBeVisible();
  await send(app, "SAY:QUEUED_PAIR");
  await expect(app.locator("#queueBadge")).toContainText("queued");
  const before = await server.room("pair-queue");
  const root = before.entries.find((entry) => entry.kind === "user" && entry.text.includes("QUEUED_PAIR"));
  await stopMenu(app, "queue");
  const row = app.locator(`[data-n="${root.n}"]`);
  await expect(row).toContainText(/discarded|cancelled/i);
  await expect(row).toContainText(/claude/i);
  await expect(row).toContainText(/codex/i);
  await expect(row.locator("[data-retry-discarded]")).toHaveCount(0);
  const retry = row.getByRole("button", { name: /retry.*(?:pair|cycle)|(?:pair|cycle).*retry/i });
  await expect(retry).toHaveCount(1);
  await stopMenu(app, "all");
  await idle(server, "pair-queue");
  const response = app.waitForResponse((res) => new URL(res.url()).pathname === "/api/retry");
  await retry.click();
  const recovered = await response;
  expect(recovered.request().postDataJSON()).toEqual({ room: "pair-queue", rootN: root.n });
  expect(recovered.status(), await recovered.text()).toBe(200);
  const finished = await idle(server, "pair-queue");
  expect(finished.entries.filter((entry) => entry.kind === "user")).toHaveLength(2);
  expect(finished.entries.some((entry) => entry.author === "claude" && entry.text === "QUEUED_PAIR")).toBe(true);
  expect(finished.entries.some((entry) => entry.meta?.pair === "review" && entry.meta.rootN === root.n)).toBe(true);
});

for (const [stage, directive, seat] of [["reviewer", "REVIEWFAILONCE", "codex"], ["fix", "FIXFAILONCE", "claude"]]) {
  test(`visible Pair ${stage} failure Retry reruns its original complete cycle`, async ({ app, server }) => {
    const name = `pair-${stage}`;
    await createRoom(app, server, name);
    await send(app, `/pair start @claude SAY:${directive}`);
    const failed = await idle(server, name);
    const root = failed.entries.find((entry) => entry.kind === "user");
    const error = failed.entries.find((entry) => entry.meta?.error && entry.meta.agent === seat);
    expect(error).toBeTruthy();
    const retry = app.locator(`[data-n="${error.n}"]`).getByRole("button", { name: /^Retry/ });
    await expect(retry).toBeVisible();
    await expect(app.locator("#pairBanner")).toContainText("Pair mode");
    await expect(app.locator("#stopWrap")).toBeHidden();
    const response = app.waitForResponse((res) => new URL(res.url()).pathname === "/api/retry");
    await retry.click();
    const recovered = await response;
    expect(recovered.request().postDataJSON()).toEqual({ room: name, rootN: root.n });
    expect(recovered.status(), await recovered.text()).toBe(200);
    const finished = await idle(server, name);
    const rerun = finished.entries.filter((entry) => entry.n > failed.entries.at(-1).n);
    expect(rerun.find((entry) => entry.kind === "agent")).toMatchObject({ author: "claude", text: directive });
    expect(rerun.some((entry) => entry.author === "codex" && entry.meta?.pair === "review" && entry.meta.rootN === root.n)).toBe(true);
    expect(rerun.some((entry) => entry.kind === "user")).toBe(false);
    await expect(app.locator("#chat")).toContainText(/approved/i);
    await expect(retry).toBeDisabled();
  });
}

test("a historical error action cannot retry the newer failed message", async ({ app, server }) => {
  await createRoom(app, server, "stale-error");
  await send(app, "@claude FAILONCE:old SAY:OLD_ROOT");
  const old = await idle(server, "stale-error");
  const root = old.entries.find((entry) => entry.kind === "user");
  const error = old.entries.find((entry) => entry.meta?.error);
  await expect(app.locator(`[data-n="${error.n}"]`)).toBeVisible();
  await send(app, "@codex FAILONCE:new SAY:NEW_ROOT");
  const before = await idle(server, "stale-error");
  const row = app.locator(`[data-n="${error.n}"]`);
  const retry = row.getByRole("button", { name: /^Retry/ });
  if (await retry.count() && await retry.isEnabled()) {
    const response = app.waitForResponse((res) => new URL(res.url()).pathname === "/api/retry");
    await retry.click();
    const refused = await response;
    expect(refused.request().postDataJSON()).toMatchObject({ rootN: root.n, agents: ["claude"] });
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    await expect(app.locator("#toast")).toBeVisible();
    await expect(app.locator("#toast")).toContainText(/earlier|historical|stale|newer|ask again/i);
  } else if (await retry.count()) await expect(retry).toBeDisabled();
  const after = await server.room("stale-error");
  expect(after.entries).toEqual(before.entries);
  expect(after.receipts).toEqual(before.receipts);
  expect(after.room.busy).toEqual([]);
  expect(after.room.queued).toBe(0);
  await expect(row).toBeVisible();
});

test("ending Pair refuses its old failure without waking or launching a seat", async ({ app, server }) => {
  await createRoom(app, server, "ended-pair");
  await send(app, "/pair start @claude SAY:REVIEWFAILONCE");
  const failed = await idle(server, "ended-pair");
  const root = failed.entries.find((entry) => entry.kind === "user");
  const error = failed.entries.find((entry) => entry.meta?.error);
  await app.locator("#pairEndBtn").click();
  await expect(app.locator("#pairBanner")).toBeHidden();
  await send(app, "/sleep @claude", { route: "/api/seat/sleep" });
  await expect.poll(async () => (await server.room("ended-pair")).room.agents.claude.asleep).toBe(true);
  const before = await server.room("ended-pair");
  const retry = app.locator(`[data-n="${error.n}"]`).getByRole("button", { name: /^Retry/ });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await retry.count() && await retry.isEnabled()) {
      const response = app.waitForResponse((res) => new URL(res.url()).pathname === "/api/retry");
      await retry.click();
      const refused = await response;
      expect(refused.request().postDataJSON()).toEqual({ room: "ended-pair", rootN: root.n });
      expect(refused.status()).toBeGreaterThanOrEqual(400);
      await expect(app.locator("#toast")).toContainText(/pair.*(?:ended|off|end)|(?:ended|off).*pair/i);
      await expect(app.locator("#toast")).not.toContainText(/wake|asleep|busy/i);
    } else if (await retry.count()) await expect(retry).toBeDisabled();
    const after = await server.room("ended-pair");
    expect(after.entries).toEqual(before.entries);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.room.busy).toEqual([]);
    expect(after.room.queued).toBe(0);
    expect(after.room.agents.claude.asleep).toBe(true);
  }
});
