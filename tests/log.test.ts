import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunLogger, sanitize } from '../src/log.js';

test('a failed event write does not poison the logging queue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-log-'));
  const logger = await RunLogger.create(root, 'recoverable');
  await rm(logger.directory, { recursive: true });

  await logger.event('lost');
  assert.ok(logger.error);

  await mkdir(logger.directory);
  await writeFile(logger.eventsFile, '');
  await logger.event('recovered', { ok: true });
  await logger.flush();

  assert.match(await readFile(logger.eventsFile, 'utf8'), /"type": "recovered"/);
});

test('events are pretty-printed and blank-line separated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-log-'));
  const logger = await RunLogger.create(root, 'pretty');
  await logger.event('alpha', { n: 1 });
  await logger.event('beta', { n: 2 });
  await logger.flush();

  const text = await readFile(logger.eventsFile, 'utf8');
  assert.match(text, /\{\n  "timestamp": /);
  assert.match(text, /"type": "alpha"/);
  assert.match(text, /\}\n\n\{\n  "timestamp": /);
  assert.ok(text.endsWith('}\n\n'));
});

test('transcript.txt receives human-readable progress text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-log-'));
  const logger = await RunLogger.create(root, 'transcript');
  logger.writeTranscript('Run demo\n');
  logger.writeTranscript('· Thinking: full text here\n');
  await logger.flush();

  assert.equal(
    await readFile(logger.transcriptFile, 'utf8'),
    'Run demo\n· Thinking: full text here\n',
  );
});

test('log sanitization redacts secrets and summarizes binary data', () => {
  const value = sanitize({
    apiKey: 'secret-value',
    apiToken: 'secret-api-token',
    authToken: 'secret-token',
    VERCEL_OIDC_TOKEN: 'secret-oidc-token',
    nested: { authorization: 'Bearer secret' },
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    buffer: Buffer.from('hello'),
    base64: 'a'.repeat(5000),
  }) as Record<string, unknown>;
  assert.equal(value.apiKey, '[REDACTED]');
  assert.equal(value.apiToken, '[REDACTED]');
  assert.equal(value.authToken, '[REDACTED]');
  assert.equal(value.VERCEL_OIDC_TOKEN, '[REDACTED]');
  assert.deepEqual(value.nested, { authorization: '[REDACTED]' });
  assert.deepEqual(value.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.match(JSON.stringify(value.buffer), /sha256/);
  assert.match(String(value.base64), /OMITTED/);
});

test('log sanitization replaces encrypted reasoning with a placeholder', () => {
  const value = sanitize({
    text: 'Visible reasoning summary',
    providerMetadata: {
      xai: { reasoningEncryptedContent: '1bE/jL5RGZl4/opaque' },
      googleVertex: { thoughtSignature: 'AY89a19bETOc' },
      vertex: { thoughtSignature: 'AY89a19bETOc' },
    },
    providerOptions: {
      xai: { reasoningEncryptedContent: 'blob' },
    },
    redacted_reasoning: 'hidden',
  }) as Record<string, unknown>;

  assert.equal(value.text, 'Visible reasoning summary');
  assert.equal(value.redacted_reasoning, '[OMITTED encrypted reasoning]');
  assert.deepEqual(value.providerMetadata, {
    xai: { reasoningEncryptedContent: '[OMITTED encrypted reasoning]' },
    googleVertex: { thoughtSignature: '[OMITTED encrypted reasoning]' },
    vertex: { thoughtSignature: '[OMITTED encrypted reasoning]' },
  });
  assert.deepEqual(value.providerOptions, {
    xai: { reasoningEncryptedContent: '[OMITTED encrypted reasoning]' },
  });
});

test('log sanitization preserves useful service error details', () => {
  const error = Object.assign(new Error('Request failed'), {
    json: { error: { code: 'file_error', message: 'No such file or directory' } },
    sessionId: 'sbx_test',
    response: { status: 400, statusText: 'Bad Request', url: 'https://example.test' },
  });
  const value = sanitize(error) as Record<string, unknown>;
  assert.deepEqual(value.json, {
    error: { code: 'file_error', message: 'No such file or directory' },
  });
  assert.equal(value.sessionId, 'sbx_test');
  assert.deepEqual(value.response, {
    status: 400,
    statusText: 'Bad Request',
    url: 'https://example.test',
  });
});
