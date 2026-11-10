/* ==========================================================================
   BuildMind API — providers/ai/http.ts
   One bounded HTTP call, shared by every AI adapter.

   This exists so the four things that always go wrong with vendor APIs are
   handled in exactly one place:
     * a hung socket            → bounded by an AbortSignal and a hard timeout
     * a huge response           → streamed and counted, then abandoned
     * a non-JSON body           → normalised, never thrown raw at the caller
     * a status that means auth  → mapped to PROVIDER_AUTH_FAILED, not 500

   The API key is placed in a header here and nowhere else. No URL ever
   carries a secret — Google's own docs allow a key in a query string, and we
   deliberately do not use that form.
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import { MAX_PROVIDER_RESPONSE_BYTES, PROVIDER_TIMEOUT_MS } from '../../config/constants.js';

export interface HttpJsonOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpJsonResponse {
  status: number;
  json: unknown;
}

/** Combine a caller signal with our own timeout, whichever fires first. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function postJson(opts: HttpJsonOptions): Promise<HttpJsonResponse> {
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const { signal, done } = withTimeout(opts.signal, timeoutMs);

  try {
    const response = await fetch(opts.url, {
      method: opts.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.headers ?? {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal,
      redirect: 'error',
    });

    const text = await readBounded(response, MAX_PROVIDER_RESPONSE_BYTES);

    if (response.status === 401 || response.status === 403) {
      throw new AppError('PROVIDER_AUTH_FAILED', { cause: `status ${response.status}` });
    }
    if (response.status === 429) {
      throw new AppError('PROVIDER_RATE_LIMITED', { cause: 'status 429' });
    }
    if (response.status >= 500) {
      throw new AppError('PROVIDER_UNAVAILABLE', { cause: `status ${response.status}` });
    }

    let json: unknown = null;
    if (text.length) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: 'non-json response body' });
      }
    }

    return { status: response.status, json };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && (err.name === 'AbortError' || /timeout/i.test(err.message))) {
      throw new AppError('PROVIDER_TIMEOUT', { cause: err });
    }
    // fetch() rejects with a TypeError for DNS/TLS/connection failures.
    throw new AppError('PROVIDER_UNAVAILABLE', { cause: err });
  } finally {
    done();
  }
}

/** Read a response body, refusing to buffer more than `limit` bytes. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: 'response exceeded size limit' });
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
