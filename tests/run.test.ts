import assert from 'node:assert/strict';
import test from 'node:test';
import type { Command, Sandbox } from '@vercel/sandbox';
import { errorMessage } from '../src/config.js';
import type { RunLogger } from '../src/log.js';
import type { CatalogModel } from '../src/models.js';
import { createRunId, createSandboxName, validateRunId } from '../src/run.js';
import {
  clipped,
  createSandboxTools,
  initializeSandboxFilesystem,
  normalizeArtifactPath,
  readSandboxFileChunk,
  SANDBOX_ARTIFACTS,
  shellInvocation,
} from '../src/tools.js';

test('run IDs contain the date, safe model name, and unique suffix', () => {
  const runId = createRunId(
    'DeepSeek/deepseek-v4-flash-0731',
    new Date('2026-08-09T12:34:56.000Z'),
  );
  assert.match(runId, /^2026-08-09-deepseek-deepseek-v4-flash-0731-[a-f0-9]{8}$/);
  assert.ok(runId.length <= 128);
  assert.equal(validateRunId('my-run_01'), 'my-run_01');
  assert.throws(() => validateRunId('../escape'), /filesystem-safe/);
});

test('sandbox names preserve the unique run suffix within their shorter limit', () => {
  const runId = `2026-08-09-${'long-model-name-'.repeat(8)}deadbeef`;
  const name = createSandboxName(runId);
  assert.ok(name.length <= 63);
  assert.match(name, /^bbx-/);
  assert.match(name, /-deadbeef$/);
});

test('artifact paths are normalized safely inside the sandbox artifact root', () => {
  assert.equal(normalizeArtifactPath('reports/final.pdf'), 'reports/final.pdf');
  assert.equal(
    normalizeArtifactPath(`${SANDBOX_ARTIFACTS}/reports/final.pdf`),
    'reports/final.pdf',
  );
  assert.throws(() => normalizeArtifactPath('../secret'), /Invalid artifact path/);
  assert.throws(() => normalizeArtifactPath('/etc/passwd'), /Invalid artifact path/);
});

test('shell commands are passed through one predictable invocation', () => {
  assert.deepEqual(shellInvocation('cat essay.md | wc -w'), {
    cmd: 'sh',
    args: ['-lc', 'cat essay.md | wc -w'],
  });
});

test('output clipping preserves UTF-8 characters at byte boundaries', () => {
  const value = `${'a'.repeat(48 * 1024 - 1)}😀${'b'.repeat(20 * 1024)}`;
  const result = clipped(value);

  assert.equal(result.truncated, true);
  assert.equal(result.bytes, Buffer.byteLength(value));
  assert.doesNotMatch(result.text, /�/);
});

test('file reads request only a bounded slice inside the sandbox', async () => {
  let received: { args?: string[] } | undefined;
  const chunk = Buffer.from('bounded chunk');
  const sandbox = {
    runCommand: async (input: { args?: string[] }) => {
      received = input;
      return {
        exitCode: 0,
        stdout: async () => `500000000\n${chunk.toString('base64')}`,
        stderr: async () => '',
      };
    },
  } as unknown as Sandbox;

  const result = await readSandboxFileChunk(sandbox, {
    path: 'large.log',
    offset: 64 * 1024,
    limit: 64 * 1024,
    encoding: 'base64',
  }, AbortSignal.timeout(1_000));

  assert.equal(received?.args?.at(-3), '/vercel/sandbox/large.log');
  assert.equal(received?.args?.at(-2), String(64 * 1024));
  assert.equal(received?.args?.at(-1), String(48 * 1024));
  assert.equal(result.content, chunk.toString('base64'));
  assert.equal(result.totalBytes, 500_000_000);
});

test('foreground commands are not retained after their output is returned', async () => {
  let getCommandCalls = 0;
  const command = {
    cmdId: 'command-1',
    exitCode: 0,
    durationMs: 1,
    stdout: async () => 'done',
    stderr: async () => '',
  } as unknown as Command;
  const sandbox = {
    runCommand: async () => command,
    getCommand: async () => {
      getCommandCalls += 1;
      return command;
    },
  } as unknown as Sandbox;
  const logger = { event: async () => {} } as unknown as RunLogger;
  const model = {
    id: 'example/model',
    name: 'Model',
    type: 'language',
    tags: ['tool-use'],
  } as CatalogModel;
  const tools = createSandboxTools({
    sandbox,
    logger,
    signal: AbortSignal.timeout(1_000),
    model,
    finish: { accepted: false, artifacts: [] },
  });
  const runCommand = tools.run_command as unknown as {
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  };
  const commandStatus = tools.command_status as unknown as {
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  };

  await runCommand.execute({ command: 'true', sudo: false, detached: false });
  await commandStatus.execute({ commandId: 'command-1', wait: false });

  assert.equal(getCommandCalls, 1);
});

test('sandbox initialization creates the nested artifact directory recursively', async () => {
  let received: unknown;
  const sandbox = {
    runCommand: async (input: unknown) => {
      received = input;
      return { exitCode: 0, stderr: async () => '' };
    },
  } as unknown as Sandbox;

  await initializeSandboxFilesystem(sandbox, AbortSignal.timeout(1_000));
  assert.deepEqual(received, {
    cmd: 'mkdir',
    args: ['-p', SANDBOX_ARTIFACTS],
    timeoutMs: 10_000,
    signal: (received as { signal: AbortSignal }).signal,
  });
});

test('service API details are included in user-facing errors', () => {
  const error = Object.assign(new Error('Status code 400 is not ok'), {
    json: { error: { code: 'file_error', message: 'parent directory is missing' } },
  });
  assert.equal(
    errorMessage(error),
    'Status code 400 is not ok: parent directory is missing',
  );
});
