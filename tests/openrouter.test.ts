import assert from 'node:assert/strict';
import test from 'node:test';
import { requireOpenRouterApiKey, validateOpenRouterKey } from '../src/openrouter.js';

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
