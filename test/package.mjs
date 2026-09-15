#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "parley-package-"));
let server;
try {
  assert.ok(process.env.npm_execpath, "Run through npm run test:package");
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, "pack", "--json", "--pack-destination", temporary], { encoding: "utf8", windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const manifest = JSON.parse(packed.stdout)[0];
  const paths = new Set(manifest.files.map((file) => file.path));
  for (const file of ["parley.mjs", "lib/budget-policy.mjs", "lib/budget-prompts.mjs", "lib/causal-coordinator.mjs", "lib/client-assets.mjs", "ui/index.html", "ui/styles.css", "ui/app.js"]) {
    assert.ok(paths.has(file), `packed package contains ${file}`);
  }
  assert.ok(![...paths].some((file) => /^(?:test|node_modules)\//.test(file)));
  // A relative archive avoids GNU tar interpreting a Windows drive as a remote host.
  const unpacked = spawnSync("tar", ["-xzf", manifest.filename], { cwd: temporary, encoding: "utf8", windowsHide: true });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(temporary, "package", "package.json"), "utf8"));
  assert.deepEqual(cfg.dependencies || {}, {}, "zero runtime dependencies");
  server = spawn(process.execPath, [path.join(temporary, "package", "parley.mjs"), "--port", "0", "--no-open", "--root", path.join(temporary, "rooms")], {
    cwd: temporary, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Packed server readiness timed out: ${output}`)), 10000);
    const read = (part) => {
      output += part;
      const url = /UI:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if (url) { clearTimeout(timer); resolve(url); }
    };
    server.stdout.on("data", read); server.stderr.on("data", read);
    server.once("exit", (code) => { clearTimeout(timer); reject(Error(`Packed server exited ${code}: ${output}`)); });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const html = await fetch(base).then((response) => response.text());
  for (const file of ["styles.css", "app.js"]) {
    const ref = new RegExp(`/ui/${file.replace(".", "\\.")}\\?v=[a-f0-9]+`).exec(html)?.[0];
    assert.ok(ref, `versioned ${file} reference`);
    const asset = await fetch(base + ref);
    assert.equal(asset.status, 200);
    assert.ok((await asset.text()).length > 100);
  }
  console.log(`Packed runtime verified: ${paths.size} files, all modules/assets present, startup without installation.`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
  }
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
