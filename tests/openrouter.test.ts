import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOpenRouterKeyInfo,
  promptCachingSettings,
  requireOpenRouterApiKey,
  validateOpenRouterKey,
} from '../src/openrouter.js';

test('requireOpenRouterApiKey reads a trimmed key and fails when unset', () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = '  sk-or-test  ';
    assert.equal(requireOpenRouterApiKey(), 'sk-or-test');
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(() => requireOpenRouterApiKey(), /OPENROUTER_API_KEY is not set/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test('validateOpenRouterKey reports remaining credits and HTTP failures', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/key');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk-or-test');
    return new Response(JSON.stringify({ data: { label: 'sk-or-v1-…', limit_remaining: 12.5 } }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    assert.equal(
      await validateOpenRouterKey('sk-or-test'),
      'OPENROUTER_API_KEY is valid (12.5 credits remaining)',
    );
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(() => validateOpenRouterKey('bad'), /OpenRouter key check returned HTTP 401/);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchOpenRouterKeyInfo reports what a limited key has left and null for an unlimited one', async () => {
  const original = globalThis.fetch;
  const respond = (data: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch;
  };
  try {
    respond({ label: 'sk-or-v1-…', limit: 20, limit_remaining: 4.63 });
    assert.deepEqual(await fetchOpenRouterKeyInfo('sk-or-test'), { label: 'sk-or-v1-…', limitRemaining: 4.63 });
    respond({ label: 'sk-or-v1-…', limit: null, limit_remaining: null });
    assert.deepEqual(await fetchOpenRouterKeyInfo('sk-or-test'), { label: 'sk-or-v1-…', limitRemaining: null });
    respond({});
    assert.deepEqual(await fetchOpenRouterKeyInfo('sk-or-test'), { limitRemaining: null });
  } finally {
    globalThis.fetch = original;
  }
});

test('prompt caching is requested only for Anthropic models', () => {
  assert.deepEqual(promptCachingSettings('anthropic/claude-fable-5.2'), {
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(promptCachingSettings('openai/gpt-6.1-terra'), {});
  assert.deepEqual(promptCachingSettings('some-lab/anthropic-compatible'), {});
});
