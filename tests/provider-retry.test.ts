import assert from 'node:assert/strict';
import test from 'node:test';
import { APICallError, EmptyResponseBodyError, RetryError } from 'ai';
import {
  PROVIDER_MAX_ATTEMPTS,
  errorFromProviderStreamPart,
  isRetryableProviderError,
  providerRetryDelayMs,
  unwrapProviderError,
  withProviderRetries,
} from '../src/provider-retry.js';

test('classifies provider and network failures as retryable', () => {
  assert.equal(
    isRetryableProviderError(new APICallError({
      message: 'Bad Gateway',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 502,
      isRetryable: true,
    })),
    true,
  );
  assert.equal(
    isRetryableProviderError(new APICallError({
      message: 'Internal Server Error',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: false,
    })),
    true,
  );
  assert.equal(isRetryableProviderError(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableProviderError(new Error('Connect Timeout Error')), true);
  assert.equal(isRetryableProviderError(new EmptyResponseBodyError()), true);
  assert.equal(isRetryableProviderError(new Error('Provider stream aborted.')), true);
  assert.equal(
    isRetryableProviderError(new RetryError({
      message: 'Failed after retries',
      reason: 'maxRetriesExceeded',
      errors: [new Error('HTTP 502')],
    })),
    true,
  );
});

test('does not retry client errors or non-retryable SDK failures', () => {
  assert.equal(
    isRetryableProviderError(new APICallError({
      message: 'Bad Request',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    })),
    false,
  );
  assert.equal(
    isRetryableProviderError(new RetryError({
      message: 'Not retryable',
      reason: 'errorNotRetryable',
      errors: [new Error('HTTP 502')],
    })),
    false,
  );
  assert.equal(isRetryableProviderError(new Error('Unknown model')), false);
});

test('stream error and abort parts become thrown failures', () => {
  const providerError = new Error('HTTP 502');
  assert.equal(errorFromProviderStreamPart({ type: 'error', error: providerError }), providerError);
  assert.match(
    (errorFromProviderStreamPart({ type: 'abort', reason: 'connection lost' }) as Error).message,
    /connection lost/,
  );
  assert.equal(errorFromProviderStreamPart({ type: 'text-delta' }), undefined);
});

test('retries the same payload with backoff and then throws the original error', async () => {
  const delays: number[] = [];
  const payloads: string[][] = [];
  const messages = ['task'];
  let attempts = 0;
  const original = new APICallError({
    message: 'Bad Gateway',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 502,
    isRetryable: true,
  });

  await assert.rejects(
    () => withProviderRetries(async () => {
      attempts += 1;
      payloads.push([...messages]);
      throw original;
    }, {
      signal: new AbortController().signal,
      sleep: async ms => { delays.push(ms); },
    }),
    error => error === original,
  );

  assert.equal(attempts, PROVIDER_MAX_ATTEMPTS);
  assert.deepEqual(delays, [
    providerRetryDelayMs(1),
    providerRetryDelayMs(2),
    providerRetryDelayMs(3),
  ]);
  assert.deepEqual(payloads, [['task'], ['task'], ['task'], ['task']]);
  assert.equal(messages.length, 1);
});

test('succeeds after a retryable failure without treating it as a finished invocation', async () => {
  const messages = ['task'];
  let attempts = 0;
  const result = await withProviderRetries(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('HTTP 502');
    return { response: 'ok', payload: [...messages] };
  }, {
    signal: new AbortController().signal,
    sleep: async () => {},
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, { response: 'ok', payload: ['task'] });
  assert.equal(messages.includes('Continue working'), false);
});

test('does not retry when the run is aborted or the error is not a provider failure', async () => {
  const controller = new AbortController();
  let attempts = 0;
  controller.abort(new Error('Run interrupted by the user.'));
  await assert.rejects(
    () => withProviderRetries(async () => {
      attempts += 1;
      throw new Error('HTTP 502');
    }, { signal: controller.signal, sleep: async () => {} }),
    /interrupted/,
  );
  assert.equal(attempts, 0);

  attempts = 0;
  const clientError = new APICallError({
    message: 'Unauthorized',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  });
  await assert.rejects(
    () => withProviderRetries(async () => {
      attempts += 1;
      throw clientError;
    }, { signal: new AbortController().signal, sleep: async () => {} }),
    error => error === clientError,
  );
  assert.equal(attempts, 1);
});

test('unwraps SDK retry wrappers to the original provider error', () => {
  const original = new Error('HTTP 502');
  assert.equal(
    unwrapProviderError(new RetryError({
      message: 'Failed after retries',
      reason: 'maxRetriesExceeded',
      errors: [original],
    })),
    original,
  );
});
