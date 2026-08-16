import { APICallError, EmptyResponseBodyError, RetryError } from 'ai';

/** Initial attempt plus 3 retries of the same messages payload. */
export const PROVIDER_MAX_ATTEMPTS = 4;

export function providerRetryDelayMs(failedAttempt: number): number {
  return 1000 * 2 ** (failedAttempt - 1);
}

export function unwrapProviderError(error: unknown): unknown {
  if (RetryError.isInstance(error)) return error.lastError ?? error;
  return error;
}

function statusCode(error: unknown): number | undefined {
  if (APICallError.isInstance(error) && error.statusCode != null) return error.statusCode;
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? String(error.code) : '';
    const cause = error.cause instanceof Error ? error.cause.message : '';
    return `${error.name} ${error.message} ${code} ${cause}`;
  }
  return String(error);
}

function isRetryableHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (status != null && status >= 500);
}

export function isRetryableProviderError(error: unknown): boolean {
  if (error == null) return false;
  if (RetryError.isInstance(error)) {
    if (error.reason === 'errorNotRetryable') return false;
    return isRetryableProviderError(error.lastError);
  }
  if (APICallError.isInstance(error)) {
    return error.isRetryable || isRetryableHttpStatus(error.statusCode);
  }
  if (EmptyResponseBodyError.isInstance(error)) return true;
  if (isRetryableHttpStatus(statusCode(error))) return true;
  if (error instanceof Error && error.cause && isRetryableProviderError(error.cause)) return true;
  return /(?:^|[^0-9])(408|409|429|500|502|503|504)(?:[^0-9]|$)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|fetch failed|socket|network|timeout|timed out|bad gateway|gateway timeout|temporarily unavailable|stream aborted|connection (?:lost|reset|closed|aborted)/i
    .test(errorText(error));
}

export function errorFromProviderStreamPart(part: {
  type: string;
  error?: unknown;
  reason?: string;
}): unknown | undefined {
  if (part.type === 'error') return part.error ?? new Error('Provider stream error.');
  if (part.type === 'abort') {
    return new Error(part.reason ? `Provider stream aborted: ${part.reason}` : 'Provider stream aborted.');
  }
  return undefined;
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Run interrupted by the user.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run interrupted by the user.'));
    };
    function finish() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withProviderRetries<T>(
  operation: () => Promise<T>,
  options: {
    signal: AbortSignal;
    maxAttempts?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    onRetry?: (info: {
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: unknown;
    }) => Promise<void> | void;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? PROVIDER_MAX_ATTEMPTS;
  const wait = options.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : unwrapProviderError(lastError) ?? new Error('Run interrupted by the user.');
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts
        && !options.signal.aborted
        && isRetryableProviderError(error);
      if (!canRetry) throw unwrapProviderError(error);
      const delayMs = providerRetryDelayMs(attempt);
      await options.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await wait(delayMs, options.signal);
    }
  }

  throw unwrapProviderError(lastError);
}
