import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Sandbox } from '@vercel/sandbox';
import { ArtifactDownloadError, downloadArtifacts } from '../src/artifacts.js';
import { RunLogger } from '../src/log.js';

test('enumeration failures become partial results without hidden directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-artifacts-'));
  const artifactsDir = path.join(root, 'artifacts');
  const logsDir = path.join(root, 'logs');
  const runId = 'failed-enumeration';
  await Promise.all([mkdir(artifactsDir), mkdir(logsDir)]);
  const logger = await RunLogger.create(logsDir, runId);
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
    error => error instanceof ArtifactDownloadError && error.manifest.files.length === 0,
  );

  assert.deepEqual(invocation?.args?.slice(-1), ['-print0']);
  assert.equal(invocation?.args?.some(argument => argument.includes('\0')), false);
  await access(path.join(artifactsDir, `${runId}.partial`));
  await assert.rejects(access(path.join(artifactsDir, `.${runId}.downloading`)));
});

test('partial recovery failures preserve a typed error and the actual directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-artifact-recovery-'));
  const artifactsDir = path.join(root, 'artifacts');
  const logsDir = path.join(root, 'logs');
  const runId = 'failed-recovery';
  const partialDirectory = path.join(artifactsDir, `${runId}.partial`);
  const temporaryDirectory = path.join(artifactsDir, `.${runId}.downloading`);
  await Promise.all([mkdir(artifactsDir), mkdir(logsDir)]);
  const logger = await RunLogger.create(logsDir, runId);
  const sandbox = {
    runCommand: async () => {
      await mkdir(partialDirectory);
      await writeFile(path.join(partialDirectory, 'occupied'), 'collision');
      throw new Error('enumeration failed');
    },
  } as unknown as Sandbox;

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
  assert.equal(caught.manifest.directory, temporaryDirectory);
  assert.ok(caught.cause instanceof AggregateError);
  await access(temporaryDirectory);
});
