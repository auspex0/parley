import { test as base, expect } from "@playwright/test";
import { isolatedServer } from "./server-fixture.mjs";

export const test = base.extend({
  server: async ({}, use, testInfo) => {
    const server = await isolatedServer();
    try { await use(server); }
    finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("server.log", { body: server.log(), contentType: "text/plain" });
        const listed = await server.api("GET", "/api/rooms").catch(() => null);
        for (const room of listed?.data.rooms || []) {
          const snapshot = await server.room(room.name || room).catch(() => null);
          await testInfo.attach(`${room.name || room}.json`, { body: JSON.stringify(snapshot, null, 2), contentType: "application/json" });
        }
      }
      await server.close();
    }
  },
  app: async ({ page, server }, use) => {
    const errors = [];
    const rejectedResponses = new Set();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const route = new URL(response.url()).pathname;
      if (route === "/api/retry" && [400, 409].includes(response.status())) rejectedResponses.add(response.url());
      else errors.push(`Unexpected HTTP ${response.status()}: ${route}`);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Expected refused actions are asserted by their test and visible toast.
      if (/Failed to load resource/.test(message.text()) && rejectedResponses.has(message.location().url)) return;
      errors.push(message.text());
    });
    await page.route("**/*", async (route) => {
      const request = new URL(route.request().url());
      if (request.origin !== server.url) {
        errors.push(`Unexpected external browser request: ${request.origin}`);
        return route.abort();
      }
      if (request.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
      return route.continue();
    });
    await page.goto(server.url);
    await expect(page.locator("#connDot")).toHaveClass(/on/);
    await expect(page.locator("#runtimeBanner")).toBeHidden();
    await use(page);
    expect(errors, "browser runtime/console errors").toEqual([]);
  },
});
export { expect };

export async function createRoom(page, server, name, { enter = false, sameProvider = false } = {}) {
  await page.locator("#addRoomBtn").click();
  await page.locator("#newRoomInput").fill(name);
  if (sameProvider) {
    await page.locator("#seat2").selectOption("claude");
    await expect(page.locator("#seat1Name")).toBeVisible();
    await page.locator("#seat1Name").fill("builder");
    await page.locator("#seat2Name").fill("reviewer");
  }
  const accepted = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/rooms" && res.request().method() === "POST");
  // press() dispatches an actual keyboard event, exercising HTML implicit submission.
  if (enter) await page.locator(sameProvider ? "#seat2Name" : "#newRoomInput").press("Enter");
  else await page.locator("#newRoomCreate").click();
  expect((await accepted).status()).toBe(200);
  await expect(page.locator("#roomTitle")).toHaveText(name);
  await expect(page.locator("#newRoomForm")).toBeHidden();
  await expect(page.locator("#connDot")).toHaveClass(/on/);
  await server.configure(name);
}

export async function send(page, text, { enter = false, route = "/api/message" } = {}) {
  await page.locator("#input").fill(text);
  await expect(page.locator("#sendBtn")).toBeEnabled();
  const accepted = page.waitForResponse((res) => new URL(res.url()).pathname === route && res.request().method() === "POST");
  if (enter) await page.locator("#input").press("Enter");
  else await page.locator("#sendBtn").click();
  const response = await accepted;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.locator("#input")).toHaveValue("");
  return response.json();
}

export async function idle(server, name) {
  await expect.poll(async () => {
    const { room } = await server.room(name);
    const owed = room.seats.some((seat) => room.agents[seat].catchUp && !room.agents[seat].asleep);
    return !room.busy.length && !room.queued && !room.working && !owed;
  }, { timeout: 25_000, message: `${name} finishes all scheduled work` }).toBe(true);
  return server.room(name);
}

export async function stopMenu(page, scope, agent) {
  await page.locator("#stopMore").click();
  const action = page.locator(`[data-stop-scope="${scope}"]${agent ? `[data-stop-agent="${agent}"]` : ""}`);
  await expect(action).toBeVisible();
  const stopped = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/stop");
  await action.click();
  expect((await stopped).status()).toBe(200);
}
