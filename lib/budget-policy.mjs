// Stored compatibility accounting: one extra request launch consumes one unit;
// structural delivery and its answer return remain separately owed.
export function normalizeHopBudget(value, fallback = -1) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= -1 ? n : fallback;
}

export function requireRoomHopBudget(value, label = "hopBudget") {
  const n = typeof value === "number" ? value
    : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
  if (!Number.isSafeInteger(n) || n < -1) {
    throw Object.assign(new Error(`${label} must be -1 (until settled) or a non-negative integer`), { status: 400 });
  }
  return n;
}

export function requireMessageHopBudget(value, label = "message hopBudget") {
  const n = requireRoomHopBudget(value, label);
  if (n > 8) {
    throw Object.assign(new Error(`${label} must be -1 (until settled) or an integer from 0 to 8`), { status: 400 });
  }
  return n;
}

export function effectiveRelayLimit(budget, safetyLimit) {
  return budget < 0 ? safetyLimit : budget;
}

export function isAutomaticPolicy(policy) {
  return policy?.version === 2 && policy.accounting === "automatic";
}

export function snapshotAccounting(config, safetyLimit) {
  return config.accounting === "automatic"
    ? { version: 2, accounting: "automatic", safetyLimit }
    : { version: 1, accounting: "exchanges" };
}

// Compatibility policy only. New policy versions must define their own closed
// category mapping; permission to schedule is checked separately by the engine.
export function consumesContinuation(kind, policy) {
  if (isAutomaticPolicy(policy)) return kind !== "root";
  if (["explicit", "continuation"].includes(kind)) return true;
  if (["sibling", "lurk", "answer-return", "catch-up", "catch-up-return", "catch-up-answer", "root"].includes(kind)) return false;
  throw new Error(`unknown compatibility delivery kind: ${kind}`);
}

export function resolveRelaySafetyLimit(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.max(2, n) : 25;
}

export function publicRelayRun(run) {
  const { id, rootN, used, budget, limit, source, phase, accounting } = run;
  return { id, rootN, used, budget, limit, source, phase, accounting };
}

// Durable cap identity is an edge, independent of later observed usage or a
// different process's safety ceiling. First wins, including on disagreement.
export function newCapEdges(entries, proposed, provenance, onConflict = () => {}) {
  const seen = new Map();
  for (const entry of entries) {
    const cap = entry.meta?.relayCap;
    if (!cap) continue;
    for (const edge of cap.dropped || []) {
      const key = `${edge.target}:${edge.n}`;
      if (!seen.has(key)) seen.set(key, cap);
    }
  }
  return proposed.filter((edge) => {
    const key = `${edge.target}:${edge.n}`;
    const prior = seen.get(key);
    if (prior) {
      if (prior.rootN !== provenance.rootN || prior.budget !== provenance.budget ||
          (prior.source || "room") !== provenance.source ||
          prior.policyId !== provenance.policyId) onConflict(edge, prior);
      return false;
    }
    seen.set(key, provenance);
    return true;
  });
}
