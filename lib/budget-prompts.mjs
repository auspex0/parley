import { effectiveRelayLimit } from "./budget-policy.mjs";

const CONTINUE = "The user can continue the discussion with a new message; do not cram unresolved material into this turn.";

// Dynamic text belongs outside the session-deduplicated instruction blocks.
// `used` is read at invocation time; a charged leg passes its launch index.
export function relayAllowanceNote({ budget, solo = false, accounting }, used, safetyLimit, {
  charged = false, root = false, delivery = "delivery",
} = {}) {
  if (solo) return root
    ? "Solo mode: only you are being invoked. Tags will not schedule the other seat. Answer the user's request yourself."
    : null;
  if (accounting === "automatic") {
    const limit = effectiveRelayLimit(budget, safetyLimit);
    return `Automatic turns: ${used}/${limit} used for this user message. ` +
      `At most ${Math.max(0, limit - used)} additional automatic invocations may start. ` +
      "Every automatic invocation counts, including listeners, answer returns, passes, failures and retries. " +
      "Initial user-requested responses do not count. No return is exempt from the limit. " +
      "Respond only when you have something material to add; otherwise reply exactly [pass]. " + CONTINUE;
  }
  const remaining = Math.max(0, effectiveRelayLimit(budget, safetyLimit) - used);
  // A new Until-settled root needs no scarcity language, even under a small
  // test/process ceiling. Recovered roots near exhaustion do need the truth.
  if (budget < 0 && root && used === 0) return null;
  if (remaining > 2) return null;
  const boundary = budget < 0 ? "Safety boundary" : "Continuation allowance";
  const count = `${remaining} charged continuation${remaining === 1 ? " remains" : "s remain"}`;
  const timing = charged ? " after this turn" : " for this user message";
  const uncharged = !root && !charged ? ` This ${delivery} is uncharged.` : "";
  const terminal = remaining === 0
    ? " No further charged continuation will launch. Separately owed sibling delivery, enabled listening, and one answer return per launched request may still complete."
    : " Each launched request's answer is still returned once.";
  const response = root ? " Answer the user's request; automatic discussion should continue only on unresolved substance."
    : " Continue only on unresolved substance; reply exactly [pass] when this automatic delivery has nothing to add.";
  return `${boundary}: ${count}${timing}, shared across both seats and not reserved per seat.${uncharged}${terminal}${response} ${CONTINUE}`;
}
