// Retry policy shared by the direct gateway: the orchestrator-client pattern
// proven in the comfy-nodes offload client (retry transient statuses, capped
// exponential backoff with jitter).

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface RetryFetchOptions {
  fetchImpl?: typeof fetch;
  /** Total attempts, not retries. */
  maxTries?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retryFetch(
  input: string,
  init?: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const {
    fetchImpl = fetch,
    maxTries = 4,
    sleep = defaultSleep,
    jitter = Math.random,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (attempt > 0) await sleep((Math.min(2 ** attempt, 15) + jitter()) * 1000);
    try {
      const res = await fetchImpl(input, init);
      if (!RETRYABLE_STATUSES.has(res.status) || attempt === maxTries - 1) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      if (attempt === maxTries - 1) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
