import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import type { RunLogger } from './log.js';
import { SANDBOX_ARTIFACTS, type DeclaredArtifact } from './tools.js';

export type ArtifactEntry = {
  path: string;
  bytes: number;
  sha256: string;
  description?: string;
};

export type ArtifactManifest = {
  directory: string;
  partial: boolean;
  files: ArtifactEntry[];
};

export class ArtifactDownloadError extends Error {
  readonly manifest: ArtifactManifest;

  constructor(message: string, manifest: ArtifactManifest, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactDownloadError';
    this.manifest = manifest;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function listFiles(
  sandbox: Sandbox,
  declarations: DeclaredArtifact[] | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  const roots = declarations === undefined
    ? [SANDBOX_ARTIFACTS]
    : declarations.map(item => path.posix.join(SANDBOX_ARTIFACTS, item.path));
  const files = new Set<string>();

  for (const root of roots) {
    const result = await sandbox.runCommand({
      cmd: 'find',
      args: [root, '-type', 'f', '-print0'],
      timeoutMs: 30_000,
      signal,
    });
    const output = await result.stdout();
    if (result.exitCode !== 0) {
      const stderr = await result.stderr();
      throw new Error(stderr.trim() || `Unable to enumerate artifact files under ${root}.`);
    }
    for (const filename of output.split('\0').filter(Boolean)) {
      const normalized = path.posix.normalize(filename);
      if (normalized.startsWith(`${SANDBOX_ARTIFACTS}/`)) files.add(normalized);
    }
  }

  return [...files].sort();
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function descriptionFor(relative: string, declarations?: DeclaredArtifact[]): string | undefined {
  return declarations
    ?.filter(item => relative === item.path || relative.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
    ?.description;
}

export async function downloadArtifacts(options: {
  sandbox: Sandbox;
  artifactsDir: string;
  runId: string;
  declarations?: DeclaredArtifact[];
  logger: RunLogger;
  signal: AbortSignal;
  partial: boolean;
}): Promise<ArtifactManifest> {
  const finalDirectory = path.join(
    options.artifactsDir,
    options.partial ? `${options.runId}.partial` : options.runId,
  );
  const partialDirectory = path.join(options.artifactsDir, `${options.runId}.partial`);
  const temporaryDirectory = path.join(options.artifactsDir, `.${options.runId}.downloading`);
  for (const candidate of new Set([finalDirectory, partialDirectory, temporaryDirectory])) {
    if (await pathExists(candidate)) {
      throw new Error(`Artifact output already exists for run ${options.runId}.`);
    }
  }

  await mkdir(temporaryDirectory, { recursive: false });
  const entries: ArtifactEntry[] = [];
  let finalizing = false;

  try {
    const remoteFiles = await listFiles(options.sandbox, options.declarations, options.signal);
    for (const remoteFile of remoteFiles) {
      const relative = path.posix.relative(SANDBOX_ARTIFACTS, remoteFile);
      const downloaded = await options.sandbox.downloadFile(
        { path: remoteFile },
        { path: relative, cwd: temporaryDirectory },
        { mkdirRecursive: true, signal: options.signal },
      );
      if (downloaded === null) throw new Error(`Artifact disappeared before download: ${relative}`);
      const info = await stat(downloaded);
      const description = descriptionFor(relative, options.declarations);
      entries.push({
        path: relative,
        bytes: info.size,
        sha256: await sha256(downloaded),
        ...(description === undefined ? {} : { description }),
      });
      await options.logger.event('artifact.downloaded', { path: relative, bytes: info.size });
    }
    finalizing = true;
    await rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    let recoveryError: unknown;
    let recoveredDirectory = temporaryDirectory;

    if (finalizing && finalDirectory === partialDirectory && await pathExists(partialDirectory)) {
      recoveredDirectory = partialDirectory;
    } else if (!(finalizing && finalDirectory === partialDirectory)) {
      try {
        await rename(temporaryDirectory, partialDirectory);
        recoveredDirectory = partialDirectory;
      } catch (renameError) {
        recoveryError = renameError;
      }
    }

    const manifest = { directory: recoveredDirectory, partial: true, files: entries };
    await options.logger.event('artifact.download.partial', { manifest, error, recoveryError });
    const cause = recoveryError === undefined
      ? error
      : new AggregateError([error, recoveryError], 'Artifact download and partial recovery both failed.');
    throw new ArtifactDownloadError(
      `Artifact download stopped after ${entries.length} file(s).`,
      manifest,
      { cause },
    );
  }

  return { directory: finalDirectory, partial: options.partial, files: entries };
}
