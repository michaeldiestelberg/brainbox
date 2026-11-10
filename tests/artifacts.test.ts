import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Sandbox } from '@vercel/sandbox';
import { ArtifactDownloadError, downloadArtifacts } from '../src/artifacts.js';
import { RunLogger } from '../src/log.js';

function fakeCommand(stdout: string) {
  return { exitCode: 0, stdout: async () => stdout, stderr: async () => '' };
}

/** A sandbox whose artifact directory holds `files`; `beforeDownload` can inject failures. */
function fakeSandbox(
  files: string[],
  beforeDownload: (remotePath: string) => Promise<void> = async () => {},
): Sandbox {
  return {
    runCommand: async () => fakeCommand(files.map(file => `${file}\0`).join('')),
    downloadFile: async (
      source: { path: string },
      destination: { path: string; cwd: string },
    ) => {
      await beforeDownload(source.path);
      const target = path.join(destination.cwd, destination.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `content of ${destination.path}`);
      return target;
    },
  } as unknown as Sandbox;
}

async function workspace(prefix: string, runId: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const artifactsDir = path.join(root, 'artifacts');
  const logsDir = path.join(root, 'logs');
  await Promise.all([mkdir(artifactsDir), mkdir(logsDir)]);
  const logger = await RunLogger.create(logsDir, runId);
  return { artifactsDir, logger };
}

test('enumeration failures leave no directory behind', async () => {
  const runId = 'failed-enumeration';
  const { artifactsDir, logger } = await workspace('bbx-artifacts-', runId);
  let invocation: { args?: string[] } | undefined;
  const sandbox = {
    runCommand: async (input: { args?: string[] }) => {
      invocation = input;
      throw new Error('enumeration failed');
    },
  } as unknown as Sandbox;

  await assert.rejects(
    downloadArtifacts({
      sandbox,
      artifactsDir,
      runId,
      logger,
      signal: AbortSignal.timeout(1_000),
      partial: false,
    }),
    error => error instanceof ArtifactDownloadError && error.manifest === undefined,
  );

  assert.deepEqual(invocation?.args?.slice(-1), ['-print0']);
  assert.equal(invocation?.args?.some(argument => argument.includes('\0')), false);
  assert.deepEqual(await readdir(artifactsDir), []);
});

test('a salvage that finds no files creates no partial directory', async () => {
  const runId = 'nothing-to-salvage';
  const { artifactsDir, logger } = await workspace('bbx-artifact-empty-', runId);

  const manifest = await downloadArtifacts({
    sandbox: fakeSandbox([]),
    artifactsDir,
    runId,
    logger,
    signal: AbortSignal.timeout(1_000),
    partial: true,
  });

  assert.equal(manifest, undefined);
  assert.deepEqual(await readdir(artifactsDir), []);
});

test('a salvage with files is stored in the .partial directory', async () => {
  const runId = 'salvaged';
  const { artifactsDir, logger } = await workspace('bbx-artifact-salvage-', runId);

  const manifest = await downloadArtifacts({
    sandbox: fakeSandbox(['/vercel/sandbox/artifacts/draft.md']),
    artifactsDir,
    runId,
    logger,
    signal: AbortSignal.timeout(1_000),
    partial: true,
  });

  assert.equal(manifest?.partial, true);
  assert.equal(manifest?.directory, path.join(artifactsDir, `${runId}.partial`));
  assert.deepEqual(manifest?.files.map(file => file.path), ['draft.md']);
  await access(path.join(artifactsDir, `${runId}.partial`, 'draft.md'));
});

test('an interrupted download keeps the files it already saved as partial', async () => {
  const runId = 'interrupted-download';
  const { artifactsDir, logger } = await workspace('bbx-artifact-interrupted-', runId);
  const sandbox = fakeSandbox(
    ['/vercel/sandbox/artifacts/a.md', '/vercel/sandbox/artifacts/b.md'],
    async remotePath => {
      if (remotePath.endsWith('b.md')) throw new Error('connection lost');
    },
  );

  let caught: unknown;
  try {
    await downloadArtifacts({
      sandbox,
      artifactsDir,
      runId,
      logger,
      signal: AbortSignal.timeout(1_000),
      partial: false,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ArtifactDownloadError);
  assert.equal(caught.manifest?.directory, path.join(artifactsDir, `${runId}.partial`));
  assert.deepEqual(caught.manifest?.files.map(file => file.path), ['a.md']);
  await access(path.join(artifactsDir, `${runId}.partial`, 'a.md'));
  await assert.rejects(access(path.join(artifactsDir, `.${runId}.downloading`)));
});

test('partial recovery failures preserve a typed error and the actual directory', async () => {
  const runId = 'failed-recovery';
  const { artifactsDir, logger } = await workspace('bbx-artifact-recovery-', runId);
  const partialDirectory = path.join(artifactsDir, `${runId}.partial`);
  const temporaryDirectory = path.join(artifactsDir, `.${runId}.downloading`);
  const sandbox = fakeSandbox(
    ['/vercel/sandbox/artifacts/a.md', '/vercel/sandbox/artifacts/b.md'],
    async remotePath => {
      if (!remotePath.endsWith('b.md')) return;
      // Something else claims the .partial name while the download is failing.
      await mkdir(partialDirectory);
      await writeFile(path.join(partialDirectory, 'occupied'), 'collision');
      throw new Error('connection lost');
    },
  );

  let caught: unknown;
  try {
    await downloadArtifacts({
      sandbox,
      artifactsDir,
      runId,
      logger,
      signal: AbortSignal.timeout(1_000),
      partial: false,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ArtifactDownloadError);
  assert.equal(caught.manifest?.directory, temporaryDirectory);
  assert.ok(caught.cause instanceof AggregateError);
  await access(path.join(temporaryDirectory, 'a.md'));
});
