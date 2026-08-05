#!/usr/bin/env node
/**
 * A fake agent CLI that speaks both wire protocols Parley knows, so the smoke
 * test can exercise the whole app without a provider login or a single token.
 *
 * Which protocol is chosen by the first argument, exactly as the real CLIs are
 * invoked: `exec ...` → Codex-style JSONL, anything else (`-p ...`) → Claude
 * Code-style stream-json.
 *
 * The reply is driven by directives in the prompt, so tests stay declarative:
 *   SAY:<TOKEN>     reply with exactly TOKEN
 *   RECALL          reply with every ALLCAPS token seen in the room-activity
 *                   block (proves the delta protocol relayed the other agent)
 *   LURKARGS        expose argv from a listener turn
 *   REVIEWARGS      expose argv from a pair-review turn
 *   IMAGEINFO       report the images received through the provider's native input
 *   FILEINFO        report generic files received through Parley's staged input
 *   ARGJSON         reply with argv as JSON (avoids briefing text ambiguity)
 *   ARGS            reply with the argv it was invoked with (proves flags:
 *                   --resume, --permission-mode, --effort, --sandbox …)
 *   TAG:<seat>      reply mentioning @seat (triggers a hop)
 *   TAGHOP:<seat>   tag a seat, which then exposes its hop argv as JSON
 *   SELFTAG:<seat>  mention self before @seat (tests non-self scan)
 *   CALL:<seat>     directly address seat by plain name (soft hop)
 *   PROSE:<seat>    mention seat in ordinary prose (must not hop)
 *   PINGPONG        keep @calling the other seat (tests safety cap)
 *   ORDERSTART      codex finishes first and both cross-call (tests ordering)
 *   WRITE:<file>    create the file in cwd and report a tool use (work mode)
 *   CHIME           when lurking, interject instead of passing
 *   NEEDSFIX        as reviewer in a pair session, demand a fix in round 1
 *   SHOWCASE        use a polished two-round pair exchange for UI demos
 *   NEVERHAPPY      as reviewer, never approve (used to reach the round cap)
 *   SLOWREVIEW      keep a pair-review hop open long enough to stop it
 *   SLOWFIX         with NEVERHAPPY, make the fix turn slow enough to interrupt
 *   SLEEP:<ms>      stay busy this long before replying (occupies a seat)
 *   FAILONCE:<id>   fail one process invocation, then succeed on explicit Retry
 *   FAILONCESEAT:<seat>  as FAILONCE, but only on that seat's CLI
 *   RESUMEERROR     fail a resumed invocation with a generic provider error
 *   MISSINGSESSION  fail a resumed invocation as a missing native session
 *   RESUMEDELAY:<ms> hold a resumed invocation open before it fails, so a test
 *                   can change settings while the first attempt is still running
 *   SPAWNCHILD:<id> spawn a delayed sentinel child (proves Stop kills the tree)
 *   REVIEWFAILONCE  fail one logical pair-review turn, then review normally
 *   FIXFAILONCE     request a fix, then fail one logical pair-fix turn
 *   REVIEWFAIL      fail only when this reply reaches the pair reviewer
 *   FAIL            exit non-zero, as a broken or unhappy CLI would
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
// Codex global options may precede `exec` (notably Parley's isolated
// `--add-dir`). Find the subcommand instead of assuming argv[0].
const execIndex = argv.indexOf("exec");
const codexMode = execIndex >= 0;
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const nativeResume = codexMode ? argv[execIndex + 1] === "resume" : !!arg("--resume");

const rawInput = await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => resolve(s));
  if (process.stdin.isTTY) resolve("");
});

let prompt = rawInput;
const receivedImages = [];
if (!codexMode && arg("--input-format") === "stream-json") {
  const line = rawInput.split(/\r?\n/).find((value) => value.trim());
  let event;
  try { event = JSON.parse(line || "{}"); } catch { event = {}; }
  const content = event && event.message && Array.isArray(event.message.content)
    ? event.message.content : [];
  prompt = content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
  for (const part of content.filter((value) => value.type === "image" && value.source)) {
    const bytes = Buffer.from(String(part.source.data || ""), "base64");
    receivedImages.push({ mime: part.source.media_type || "", bytes });
  }
} else if (codexMode) {
  // Mirror the real parser closely enough to catch a subtle argv regression:
  // fresh `exec --image` consumes multiple values, while resume consumes one.
  // A bare `-` after a fresh image flag is therefore an image path unless a
  // recognized option (Parley uses --json) terminates that variadic list.
  const imagePaths = [];
  let promptOnStdin = false;
  for (let i = execIndex + 1; i < argv.length; i++) {
    if (argv[i] !== "--image" && argv[i] !== "-i") {
      if (argv[i] === "-") promptOnStdin = true;
      continue;
    }
    if (nativeResume) {
      if (i + 1 < argv.length) imagePaths.push(argv[++i]);
      continue;
    }
    while (i + 1 < argv.length && (argv[i + 1] === "-" || !argv[i + 1].startsWith("-"))) {
      imagePaths.push(argv[++i]);
    }
  }
  for (const imagePath of imagePaths) {
    if (imagePath === "-") {
      receivedImages.push({ mime: "", bytes: Buffer.alloc(0), path: imagePath, swallowedPrompt: true });
      continue;
    }
    try {
      const bytes = fs.readFileSync(imagePath);
      receivedImages.push({ mime: "", bytes, path: imagePath, promptOnStdin });
    } catch { /* the adapter test will expose the missing image */ }
  }
}

const receivedFiles = [];
const fileMarker = /\[Attached file: ("(?:\\.|[^"\\])*") \([^;\]]+\); temporary path: ("(?:\\.|[^"\\])*")\./g;
for (const match of prompt.matchAll(fileMarker)) {
  let name, filePath;
  try { name = JSON.parse(match[1]); filePath = JSON.parse(match[2]); } catch { continue; }
  try {
    const bytes = fs.readFileSync(filePath);
    receivedFiles.push({ name, path: filePath, bytes, addDir: arg("--add-dir") });
  } catch {
    receivedFiles.push({ name, path: filePath, bytes: Buffer.alloc(0), addDir: arg("--add-dir"), missing: true });
  }
}

// Only the *current* instruction should drive behaviour — earlier turns are
// replayed inside the room-activity block and must not re-trigger directives.
const cut = prompt.lastIndexOf("(to you):");
const current = cut >= 0 ? prompt.slice(cut + "(to you):".length) : "";
const activity = cut >= 0 ? prompt.slice(0, cut) : prompt;
const has = (s, hay = current) => hay.includes(s);
const after = (key) => {
  const m = new RegExp(key + "([A-Za-z0-9_.\\-]+)").exec(current);
  return m ? m[1] : null;
};

const isLurk = has("you are lurking", prompt) || has("not addressed in this exchange", prompt);
const isReview = has("you are the reviewer", prompt);
const isFix = has("review feedback above", prompt);
const isHop = has("You were addressed directly by the other agent", prompt);
const round = Number((/round (\d)/.exec(prompt) || [])[1] || 0);

let reply, wroteFile = null;
if (isReview) {
  // NEVERHAPPY keeps the reviewer unsatisfied so a test can reach the round
  // cap; the marker rides along in the feedback so the next round sees it.
  const showcase = has("SHOWCASE", prompt);
  const stubborn = has("NEVERHAPPY", prompt);
  const firstPass = round <= 1 && (has("NEEDSFIX", prompt) || showcase);
  const failFix = has("FIXFAILONCE", prompt);
  if (has("REVIEWARGS", prompt)) reply = "ARGVJSON " + JSON.stringify(argv);
  else
  // SLOWFIX rides into the feedback so the *fix* turn that reads it is slow
  // enough for a test to interrupt deliberately.
  reply = stubborn ? "Still not right — try again. NEVERHAPPY" + (has("SLOWFIX", prompt) ? " SLEEP:3000" : "")
    : firstPass && showcase ? "One issue: add a reminder to redact diagnostics before sharing them."
      : firstPass ? "Not quite — please add a comment at the top."
      : failFix ? "Please revise this. FIXFAILONCE"
      : "[approve]";
} else if (isFix) {
  // carry the marker forward so a "stubborn reviewer" test stays stubborn
  reply = has("SHOWCASE", prompt)
    ? "Added the redaction reminder and reran the release checks."
    : "Fixed as requested." + (has("NEVERHAPPY", prompt) ? " NEVERHAPPY" : "");
} else if (isLurk) {
  if (has("LURKARGS", prompt)) reply = "ARGVJSON " + JSON.stringify(argv);
  else
  reply = has("CHIME", prompt) ? "One thing worth flagging: CHIMED." : "[pass]";
} else if (has("SHOWCASE", prompt)) {
  reply = "Prepared the release checklist and ran the full validation suite.";
} else if (after("SAY:")) {
  // Carry the review-delay marker into the worker's visible reply so the next
  // pair hop sees it in its current instruction, independent of delta cursors.
  reply = after("SAY:") + (has("SLOWREVIEW") ? " SLOWREVIEW" : "");
} else if (isHop && has("DUMPARGV")) {
  reply = "ARGVJSON " + JSON.stringify(argv);
} else if (has("ARGJSON")) {
  reply = "ARGVJSON " + JSON.stringify(argv);
} else if (has("IMAGEINFO")) {
  reply = "IMAGEJSON " + JSON.stringify(receivedImages.map((image) => ({
    mime: image.mime,
    size: image.bytes.length,
    sha256: crypto.createHash("sha256").update(image.bytes).digest("hex"),
    ...(image.path ? { path: image.path } : {}),
    ...(image.promptOnStdin !== undefined ? { promptOnStdin: image.promptOnStdin } : {}),
    ...(image.swallowedPrompt ? { swallowedPrompt: true } : {}),
  })));
} else if (has("FILEINFO")) {
  reply = "FILEJSON " + JSON.stringify(receivedFiles.map((file) => ({
    name: file.name,
    path: file.path,
    addDir: file.addDir,
    size: file.bytes.length,
    sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
    inline: prompt.includes(`[Beginning attached file ${JSON.stringify(file.name)}`) &&
      prompt.includes(file.bytes.toString("utf8")),
    ...(file.missing ? { missing: true } : {}),
  })));
} else if (has("ARGS")) {
  reply = "ARGV " + argv.join(" ");
} else if (has("RECALL")) {
  const tokens = [...new Set((activity.match(/\b[A-Z]{4,}\b/g) || []))]
    .filter((t) => !["RECALL", "ARGS", "CHIME", "NEEDSFIX", "ARGV"].includes(t));
  reply = tokens.length ? "I heard: " + tokens.join(" ") : "I heard nothing.";
} else if (after("SELFTAG:")) {
  reply = `@${codexMode ? "codex" : "claude"} noted. @${after("SELFTAG:")}, thoughts?`;
} else if (after("TAGHOP:")) {
  reply = `@${after("TAGHOP:")} DUMPARGV`;
} else if (after("TAG:")) {
  reply = `@${after("TAG:")} your turn.`;
} else if (after("CALL:")) {
  const seat = after("CALL:");
  reply = `${seat[0].toUpperCase() + seat.slice(1)}, what do you reckon?`;
} else if (after("PROSE:")) {
  const seat = after("PROSE:");
  reply = `Give ${seat[0].toUpperCase() + seat.slice(1)} write access.`;
} else if (has("PINGPONG")) {
  reply = `@${codexMode ? "claude" : "codex"} PINGPONG`;
} else if (has("ORDERSTART")) {
  reply = codexMode ? "@claude FROMCODEX" : "@codex FROMCLAUDE";
} else if (after("WRITE:")) {
  // An obedient agent respects the discussion scope instead of writing.
  if (has("do not modify files", prompt)) {
    reply = `Proposing to create ${after("WRITE:")} — tag me to implement it.`;
  } else {
    wroteFile = after("WRITE:");
    fs.writeFileSync(path.resolve(process.cwd(), wroteFile), "written by the fake cli\n", "utf8");
    reply = `Created ${wroteFile}.`;
  }
} else if (has("RESUMEERROR")) {
  // Reaching this reply means Parley discarded a healthy session and retried
  // a generic provider failure fresh, which the smoke test must reject.
  reply = "UNSAFE_FRESH_RETRY";
} else if (has("MISSINGSESSION")) {
  reply = "SESSION_RECOVERED";
} else {
  reply = "ok";
}

function failLogicalTurn(keyText, label) {
  // A generic provider failure must remain failed. The workspace counter
  // survives the process so the user's explicit Retry can then succeed.
  const key = crypto.createHash("sha256").update(keyText).digest("hex").slice(0, 16);
  const counter = path.resolve(process.cwd(), `.fake-cli-failonce-count-${key}`);
  let attempts = 0;
  try {
    attempts = Math.max(0, Number(fs.readFileSync(counter, "utf8")) || 0);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (attempts < 1) {
    fs.writeFileSync(counter, String(attempts + 1), "utf8");
    process.stderr.write(`fake-cli: asked to fail logical turn (${label})\n`);
    process.exit(2);
  }
}

const resumeDelay = after("RESUMEDELAY:");
if (nativeResume && resumeDelay) await new Promise((r) => setTimeout(r, Number(resumeDelay)));

if (nativeResume && has("RESUMEERROR")) {
  process.stderr.write("fake-cli: generic upstream failure after work may have started\n");
  process.exit(2);
}
if (nativeResume && has("MISSINGSESSION")) {
  process.stderr.write(codexMode
    ? "Error: thread not found: fake-thread-missing\n"
    : "Error: No conversation found with session ID fake-session-missing\n");
  process.exit(2);
}

const childId = after("SPAWNCHILD:");
if (childId) {
  const ready = path.resolve(process.cwd(), `.fake-cli-child-ready-${childId}`);
  const sentinel = path.resolve(process.cwd(), `.fake-cli-child-survived-${childId}`);
  const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "survived\\n"), 1000)`;
  spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true }).unref();
  fs.writeFileSync(ready, "ready\n", "utf8");
}

const failOnce = after("FAILONCE:");
if (failOnce) failLogicalTurn(`turn:${failOnce}`, failOnce);
// Same idea, but only for one seat — so a @both can leave exactly one half
// failed and retryable while the other answers normally.
const failOnceSeat = after("FAILONCESEAT:");
if (failOnceSeat === (codexMode ? "codex" : "claude")) {
  failLogicalTurn(`seat:${failOnceSeat}`, failOnceSeat);
}
if (isReview && has("REVIEWFAILONCE")) failLogicalTurn("review-once", "review");
if (isFix && has("FIXFAILONCE")) failLogicalTurn("fix-once", "fix");

if ((isReview && /\bREVIEWFAIL\b/.test(current)) || /\bFAIL\b/.test(current)) {
  process.stderr.write("fake-cli: asked to fail\n");
  process.exit(2);
}

const slept = after("SLEEP:");
const orderDelay = has("ORDERSTART") && !codexMode ? 400 : 0;
const reviewDelay = isReview && has("SLOWREVIEW", prompt) ? 5000 : 0;
await new Promise((r) => setTimeout(r, Number(slept || reviewDelay || process.env.FAKE_DELAY_MS || 250) + orderDelay));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (codexMode) {
  const resuming = argv[execIndex + 1] === "resume" && argv[execIndex + 2] && argv[execIndex + 2] !== "--last";
  const threadId = resuming ? argv[execIndex + 2] : "fake-thread-" + crypto.randomUUID();
  out({ type: "thread.started", thread_id: threadId });
  out({ type: "turn.started" });
  if (wroteFile) {
    const p = path.resolve(process.cwd(), wroteFile);
    out({ type: "item.started", item: { id: "i1", type: "file_change", changes: [{ path: p, kind: "add" }], status: "in_progress" } });
    out({ type: "item.completed", item: { id: "i1", type: "file_change", changes: [{ path: p, kind: "add" }], status: "completed" } });
  }
  out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: reply } });
  out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 7, reasoning_output_tokens: 3 } });
  const lastMsgFile = arg("--output-last-message") || arg("-o");
  if (lastMsgFile) fs.writeFileSync(lastMsgFile, reply, "utf8");
} else {
  const sessionId = arg("--resume") || "fake-session-" + crypto.randomUUID();
  out({ type: "system", subtype: "init", session_id: sessionId });
  if (wroteFile) {
    out({
      type: "assistant", session_id: sessionId,
      message: { content: [{ type: "tool_use", id: "toolu_fake1", name: "Write", input: { file_path: path.resolve(process.cwd(), wroteFile) } }] },
    });
  }
  out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } });
  out({ type: "result", subtype: "success", result: reply, session_id: sessionId, is_error: false, usage: { input_tokens: 10, output_tokens: 7 } });
}
