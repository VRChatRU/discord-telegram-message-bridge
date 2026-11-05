import { setTimeout as wait } from "node:timers/promises";

const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 10_000;

export async function runHeartbeat(
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  let nextAttempt = performance.now() + INTERVAL_MS;
  while (!signal.aborted) {
    try {
      await wait(Math.ceil(nextAttempt - performance.now()), undefined, {
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted) return;

    nextAttempt = performance.now() + INTERVAL_MS;
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      await response.body?.cancel();
    } catch {
      // Try again at the next scheduled pulse.
    }
  }
}
