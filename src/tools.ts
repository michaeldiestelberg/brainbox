import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Command, Sandbox } from '@vercel/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import type { CatalogModel } from './models.js';
import type { RunLogger } from './log.js';
import { prepareImageForModel } from './image.js';

export const SANDBOX_ROOT = '/vercel/sandbox';
export const SANDBOX_ARTIFACTS = `${SANDBOX_ROOT}/artifacts`;
const MODEL_OUTPUT_LIMIT = 64 * 1024;
const MAX_FILE_READ = MODEL_OUTPUT_LIMIT;
const MAX_BASE64_FILE_READ = Math.floor(MODEL_OUTPUT_LIMIT / 4) * 3;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const READ_FILE_SCRIPT = [
  'set -eu',
  'size=$(wc -c < "$1")',
  'printf "%s\\n" "$size"',
  'dd if="$1" iflag=skip_bytes,count_bytes skip="$2" count="$3" status=none | base64 -w 0',
].join('\n');

export type DeclaredArtifact = {
  path: string;
  description?: string;
};

export type FinishState = {
  accepted: boolean;
  summary?: string;
  artifacts: DeclaredArtifact[];
};

type ToolContext = {
  sandbox: Sandbox;
  logger: RunLogger;
  signal: AbortSignal;
  model: CatalogModel;
  finish: FinishState;
};

export async function initializeSandboxFilesystem(
  sandbox: Sandbox,
  signal: AbortSignal,
): Promise<void> {
  const command = await sandbox.runCommand({
    cmd: 'mkdir',
    args: ['-p', SANDBOX_ARTIFACTS],
    timeoutMs: 10_000,
    signal,
  });
  if (command.exitCode !== 0) {
    const stderr = await command.stderr();
    throw new Error(stderr.trim() || `Unable to create ${SANDBOX_ARTIFACTS}.`);
  }
}

export function clipped(value: string): { text: string; truncated: boolean; bytes: number } {
  const buffer = Buffer.from(value);
  const bytes = buffer.byteLength;
  if (bytes <= MODEL_OUTPUT_LIMIT) return { text: value, truncated: false, bytes };

  let headEnd = 48 * 1024;
  while (headEnd > 0 && (buffer[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes - 16 * 1024;
  while (tailStart < bytes && (buffer[tailStart]! & 0xc0) === 0x80) tailStart += 1;
  const head = buffer.subarray(0, headEnd).toString('utf8');
  const tail = buffer.subarray(tailStart).toString('utf8');
  const omitted = tailStart - headEnd;
  return {
    text: `${head}\n\n[... ${omitted} bytes omitted from model context ...]\n\n${tail}`,
    truncated: true,
    bytes,
  };
}

function sandboxPath(value: string): string {
  return path.posix.isAbsolute(value)
    ? path.posix.normalize(value)
    : path.posix.resolve(SANDBOX_ROOT, value);
}

export async function readSandboxFileChunk(
  sandbox: Sandbox,
  input: { path: string; offset: number; limit: number; encoding: 'utf8' | 'base64' },
  signal: AbortSignal,
): Promise<{
  path: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  eof: boolean;
  content: string;
  encoding: 'utf8' | 'base64';
  contentTruncated?: boolean;
}> {
  const resolved = sandboxPath(input.path);
  const limit = Math.min(
    input.limit,
    input.encoding === 'base64' ? MAX_BASE64_FILE_READ : MAX_FILE_READ,
  );
  const command = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', READ_FILE_SCRIPT, 'bbx-read-file', resolved, String(input.offset), String(limit)],
    signal,
    timeoutMs: 30_000,
  });
  const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
  if (command.exitCode !== 0) throw new Error(stderr.trim() || `Unable to read ${resolved}.`);

  const separator = stdout.indexOf('\n');
  const totalBytes = Number.parseInt(separator === -1 ? stdout : stdout.slice(0, separator), 10);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error(`Unable to determine the size of ${resolved}.`);
  }
  const encoded = separator === -1 ? '' : stdout.slice(separator + 1).trim();
  const chunk = Buffer.from(encoded, 'base64');
  if (chunk.byteLength > limit) throw new Error(`Sandbox returned too much data for ${resolved}.`);

  const decoded = input.encoding === 'base64' ? encoded : chunk.toString('utf8');
  const content = clipped(decoded);
  return {
    path: resolved,
    offset: input.offset,
    bytes: chunk.byteLength,
    totalBytes,
    eof: input.offset + chunk.byteLength >= totalBytes,
    content: content.text,
    encoding: input.encoding,
    ...(content.truncated ? { contentTruncated: true } : {}),
  };
}

export function normalizeArtifactPath(value: string): string {
  if (!value) throw new Error('Artifact paths cannot be empty.');
  const normalized = path.posix.normalize(value);
  const relative = path.posix.isAbsolute(normalized)
    ? path.posix.relative(SANDBOX_ARTIFACTS, normalized)
    : normalized;
  if (
    relative === '.'
    || relative === '..'
    || relative.startsWith('../')
    || path.posix.isAbsolute(relative)
  ) {
    throw new Error(`Invalid artifact path: ${value}`);
  }
  return relative;
}

export function shellInvocation(command: string): { cmd: string; args: string[] } {
  return { cmd: 'sh', args: ['-lc', command] };
}

function mediaTypeFor(filename: string): string | undefined {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return types[path.posix.extname(filename).toLowerCase()];
}

async function commandOutput(command: Command, logger: RunLogger): Promise<Record<string, unknown>> {
  const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
  await logger.event('sandbox.command.output', {
    commandId: command.cmdId,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    stdout,
    stderr,
  });
  return {
    commandId: command.cmdId,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    stdout: clipped(stdout),
    stderr: clipped(stderr),
  };
}

async function validateDeclaredArtifacts(
  sandbox: Sandbox,
  artifacts: DeclaredArtifact[],
  signal: AbortSignal,
): Promise<{ valid: boolean; message: string; artifacts: DeclaredArtifact[] }> {
  const normalized: DeclaredArtifact[] = [];
  const seen = new Set<string>();

  for (const artifact of artifacts) {
    let relative: string;
    try {
      relative = normalizeArtifactPath(artifact.path);
    } catch (error) {
      return { valid: false, message: error instanceof Error ? error.message : String(error), artifacts: [] };
    }
    if (seen.has(relative)) continue;

    const absolute = path.posix.join(SANDBOX_ARTIFACTS, relative);
    const result = await sandbox.runCommand({
      cmd: 'find',
      args: [absolute, '-maxdepth', '0', '-printf', '%y'],
      signal,
      timeoutMs: 10_000,
    });
    const kind = (await result.stdout()).trim();
    if (result.exitCode !== 0 || !kind) {
      return { valid: false, message: `Artifact does not exist: ${relative}`, artifacts: [] };
    }
    if (kind === 'l') {
      return { valid: false, message: `Artifact symlinks are not accepted: ${relative}`, artifacts: [] };
    }
    if (kind !== 'f' && kind !== 'd') {
      return { valid: false, message: `Artifact must be a file or directory: ${relative}`, artifacts: [] };
    }

    seen.add(relative);
    normalized.push(artifact.description === undefined
      ? { path: relative }
      : { path: relative, description: artifact.description });
  }

  return { valid: true, message: 'Completion accepted.', artifacts: normalized };
}

export function createSandboxTools(context: ToolContext) {
  const commands = new Map<string, Command>();
  const hasVision = (context.model.tags ?? []).includes('vision');

  return {
    run_command: tool({
      description:
        'Run a shell command in the sandbox. Pipes, redirects, variables, and command chaining are supported.',
      inputSchema: z.object({
        command: z.string().min(1).describe('The complete shell command to run.'),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        sudo: z.boolean().default(false),
        detached: z.boolean().default(false),
        timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
      }),
      execute: async input => {
        await context.logger.event('sandbox.command.start', { input });
        const params = {
          ...shellInvocation(input.command),
          cwd: input.cwd ? sandboxPath(input.cwd) : SANDBOX_ROOT,
          ...(input.env ? { env: input.env } : {}),
          sudo: input.sudo,
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          signal: context.signal,
        };

        if (input.detached) {
          const command = await context.sandbox.runCommand({ ...params, detached: true });
          commands.set(command.cmdId, command);
          await context.logger.event('sandbox.command.detached', { commandId: command.cmdId });
          return { commandId: command.cmdId, running: true };
        }

        const command = await context.sandbox.runCommand(params);
        return commandOutput(command, context.logger);
      },
    }),

    command_status: tool({
      description: 'Check, wait for, or retrieve output from a detached sandbox command.',
      inputSchema: z.object({
        commandId: z.string().min(1),
        wait: z.boolean().default(false),
      }),
      execute: async ({ commandId, wait }) => {
        let command = commands.get(commandId);
        command ??= await context.sandbox.getCommand(commandId, { signal: context.signal });
        if (wait && command.exitCode === null) command = await command.wait({ signal: context.signal });
        if (command.exitCode === null) {
          commands.set(commandId, command);
          return { commandId, running: true };
        }
        commands.delete(commandId);
        return { running: false, ...(await commandOutput(command, context.logger)) };
      },
    }),

    kill_command: tool({
      description: 'Stop a detached sandbox command.',
      inputSchema: z.object({ commandId: z.string().min(1), signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT']).default('SIGTERM') }),
      execute: async ({ commandId, signal }) => {
        const command = commands.get(commandId) ?? await context.sandbox.getCommand(commandId, { signal: context.signal });
        await command.kill(signal, { abortSignal: context.signal });
        commands.delete(commandId);
        await context.logger.event('sandbox.command.killed', { commandId, signal });
        return { commandId, killed: true, signal };
      },
    }),

    read_file: tool({
      description: `Read a file from the sandbox in chunks of at most ${MAX_FILE_READ} bytes.`,
      inputSchema: z.object({
        path: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(MAX_FILE_READ).default(64 * 1024),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      }),
      execute: async input => {
        const output = await readSandboxFileChunk(context.sandbox, input, context.signal);
        await context.logger.event('sandbox.file.read', output);
        return output;
      },
    }),

    write_files: tool({
      description: 'Write one or more UTF-8 or base64-encoded files in the sandbox.',
      inputSchema: z.object({
        files: z.array(z.object({
          path: z.string().min(1),
          content: z.string(),
          encoding: z.enum(['utf8', 'base64']).default('utf8'),
          mode: z.number().int().nonnegative().max(0o777).optional(),
        })).min(1).max(100),
      }),
      execute: async ({ files }) => {
        const writes = files.map(file => ({
          path: sandboxPath(file.path),
          content: Buffer.from(file.content, file.encoding),
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }));
        await context.sandbox.writeFiles(writes, { signal: context.signal });
        const result = writes.map(file => ({ path: file.path, bytes: file.content.byteLength, mode: file.mode }));
        await context.logger.event('sandbox.files.written', { files: result });
        return { files: result };
      },
    }),

    list_files: tool({
      description: 'List files and directories recursively with type and byte size.',
      inputSchema: z.object({
        path: z.string().default('.'),
        depth: z.number().int().nonnegative().max(20).default(2),
      }),
      execute: async input => {
        const resolved = sandboxPath(input.path);
        const command = await context.sandbox.runCommand({
          cmd: 'find',
          args: [resolved, '-maxdepth', String(input.depth), '-printf', '%y\t%s\t%p\n'],
          signal: context.signal,
          timeoutMs: 30_000,
        });
        const stdout = await command.stdout();
        const stderr = await command.stderr();
        await context.logger.event('sandbox.files.listed', { path: resolved, depth: input.depth, stdout, stderr, exitCode: command.exitCode });
        if (command.exitCode !== 0) throw new Error(stderr || `Unable to list ${resolved}`);
        return { path: resolved, listing: clipped(stdout) };
      },
    }),

    view_image: tool({
      description: hasVision
        ? 'View an image from the sandbox using the model image modality. Images are compressed to a small JPEG before the model sees them; only the latest screenshot is kept in full in later steps.'
        : 'This model does not support image input; calling this tool returns an explanatory error.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: requestedPath }) => {
        if (!hasVision) return { error: `Model ${context.model.id} does not advertise vision support.` };
        const resolved = sandboxPath(requestedPath);
        const sourceMediaType = mediaTypeFor(resolved);
        if (!sourceMediaType) return { error: `Unsupported image format: ${resolved}` };
        if (sourceMediaType === 'image/svg+xml') {
          return { error: `SVG images are not supported for view_image: ${resolved}` };
        }
        const contents = await context.sandbox.readFileToBuffer({ path: resolved }, { signal: context.signal });
        if (contents === null) return { error: `Image not found: ${resolved}` };
        if (contents.byteLength > MAX_IMAGE_BYTES) return { error: `Image exceeds ${MAX_IMAGE_BYTES} bytes.` };

        let prepared;
        try {
          prepared = await prepareImageForModel(contents);
        } catch (error) {
          return { error: `Unable to prepare image for the model: ${error instanceof Error ? error.message : String(error)}` };
        }

        const result = {
          path: resolved,
          mediaType: prepared.mediaType,
          width: prepared.width,
          height: prepared.height,
          originalBytes: prepared.originalBytes,
          bytes: prepared.bytes,
          sha256: createHash('sha256').update(prepared.buffer).digest('hex'),
          base64: prepared.buffer.toString('base64'),
        };
        await context.logger.event('sandbox.image.viewed', result);
        return result;
      },
      toModelOutput: ({ output }) => {
        if ('error' in output) return { type: 'text', value: output.error };
        return {
          type: 'content',
          value: [
            {
              type: 'text',
              text: `Image ${output.path} (${output.originalBytes} → ${output.bytes} bytes, ${output.width}×${output.height} JPEG)`,
            },
            { type: 'file', mediaType: output.mediaType, data: { type: 'data', data: output.base64 } },
          ],
        };
      },
    }),

    finish_task: tool({
      description:
        'Finish the task. Call this exactly once after all work is complete. Artifact paths may be relative to /vercel/sandbox/artifacts or absolute paths inside it.',
      inputSchema: z.object({
        summary: z.string().min(1),
        artifacts: z.array(z.object({
          path: z.string().min(1),
          description: z.string().optional(),
        })).default([]),
      }),
      execute: async ({ summary, artifacts }) => {
        const declarations: DeclaredArtifact[] = artifacts.map(artifact =>
          artifact.description === undefined
            ? { path: artifact.path }
            : { path: artifact.path, description: artifact.description },
        );
        const validation = await validateDeclaredArtifacts(context.sandbox, declarations, context.signal);
        if (!validation.valid) {
          await context.logger.event('agent.finish.rejected', { summary, artifacts, reason: validation.message });
          return { accepted: false, error: validation.message };
        }
        context.finish.accepted = true;
        context.finish.summary = summary;
        context.finish.artifacts = validation.artifacts;
        await context.logger.event('agent.finish.accepted', { summary, artifacts: validation.artifacts });
        return { accepted: true, summary, artifacts: validation.artifacts };
      },
    }),
  };
}
