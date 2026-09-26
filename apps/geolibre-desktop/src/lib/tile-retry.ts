/**
 * Retries for native tile requests. Some tile servers fail part of their
 * requests with a transient 5xx, more often when tiles arrive in parallel, and
 * MapLibre never asks again for a tile that errored until the view changes: the
 * map keeps a hole, or the parent tile scaled up. A couple of short retries
 * recover those tiles.
 */

/** Wait before each retry, in milliseconds; its length is the number of retries. */
export const TILE_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * The HTTP status in a failed `fetch_url_bytes` call, whose error reads
 * "Request failed with status 500 Internal Server Error", or null when the
 * request never got a response (DNS, TLS, timeout, blocked URL).
 */
export function tileErrorStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /Request failed with status (\d{3})\b/.exec(message);
  return match ? Number(match[1]) : null;
}

/** 5xx and 429 are worth another try; any other 4xx will not change. */
export function isRetryableTileStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface TileRetryOptions {
  /** Aborted when MapLibre no longer needs the tile: stop retrying. */
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fetchOnce`, retrying after each delay while it fails with a retryable
 * status. The last error is rethrown unchanged, so MapLibre reports the same
 * message it would without retries.
 */
export async function fetchTileWithRetry<T>(
  fetchOnce: () => Promise<T>,
  { signal, delaysMs = TILE_RETRY_DELAYS_MS, sleep = wait }: TileRetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce();
    } catch (error) {
      const status = tileErrorStatus(error);
      const retryable = status !== null && isRetryableTileStatus(status);
      if (!retryable || attempt >= delaysMs.length || signal?.aborted) throw error;
      await sleep(delaysMs[attempt]);
      if (signal?.aborted) throw error;
    }
  }
}
