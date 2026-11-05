import { setTimeout } from "node:timers/promises";

export type Fetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class RequestError extends Error {
  readonly retryAfterMs?: number;
  readonly permanent: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      retryAfterMs?: number;
      permanent?: boolean;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "RequestError";
    this.retryAfterMs = options.retryAfterMs;
    this.permanent = options.permanent ?? false;
    this.status = options.status;
  }
}

export async function request(
  fetcher: Fetch,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch {
    signal.throwIfAborted();
    // Some fetch errors include the URL, which can contain a credential.
    throw new RequestError("Network request failed");
  }
}

export function retryDelay(attempt: number, error: unknown): number {
  const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
  const requested =
    error instanceof RequestError ? error.retryAfterMs : undefined;
  return Math.max(backoff, requested ?? 0) + Math.floor(Math.random() * 500);
}

export function secondsToMs(value: unknown): number | undefined {
  if (
    (typeof value !== "string" || !value.trim()) &&
    typeof value !== "number"
  ) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1_000)
    : undefined;
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await setTimeout(ms, undefined, { signal });
}
