import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z
  .object({
    tasksDir: z.string().default('./tasks'),
    artifactsDir: z.string().default('./artifacts'),
    logsDir: z.string().default('./logs'),
    systemPromptFile: z.string().default('./SYSTEM_PROMPT.md'),
    limits: z
      .object({
        turns: z.number().int().positive().max(1000).default(200),
        durationMinutes: z.number().positive().max(24 * 60).default(60),
      })
      .default({ turns: 200, durationMinutes: 60 }),
  })
  .strict();

export type BbxConfig = {
  configFile: string;
  baseDir: string;
  tasksDir: string;
  artifactsDir: string;
  logsDir: string;
  systemPromptFile: string;
  limits: {
    turns: number;
    durationMinutes: number;
  };
};

function resolveFrom(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export async function loadConfig(
  cwd = process.cwd(),
  requestedPath?: string,
): Promise<BbxConfig> {
  const configFile = path.resolve(cwd, requestedPath ?? 'bbx.config.json');
  let parsed: unknown = {};

  if (existsSync(configFile)) {
    const source = await readFile(configFile, 'utf8');
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid JSON in ${configFile}: ${errorMessage(error)}`);
    }
  } else if (requestedPath) {
    throw new Error(`Config file not found: ${configFile}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config ${configFile}: ${z.prettifyError(result.error)}`);
  }

  const baseDir = path.dirname(configFile);
  return {
    configFile,
    baseDir,
    tasksDir: resolveFrom(baseDir, result.data.tasksDir),
    artifactsDir: resolveFrom(baseDir, result.data.artifactsDir),
    logsDir: resolveFrom(baseDir, result.data.logsDir),
    systemPromptFile: resolveFrom(baseDir, result.data.systemPromptFile),
    limits: result.data.limits,
  };
}

export function loadProjectEnvironment(baseDir: string): string | undefined {
  for (const filename of ['.env.local', '.env']) {
    const envFile = path.join(baseDir, filename);
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
      return envFile;
    }
  }
  return undefined;
}

export async function resolveTaskFile(
  config: BbxConfig,
  taskName: string,
): Promise<{ path: string; prompt: string }> {
  if (path.isAbsolute(taskName)) {
    throw new Error('Task names must be relative to tasksDir.');
  }

  const relativeName = taskName.endsWith('.txt') ? taskName : `${taskName}.txt`;
  const candidate = path.resolve(config.tasksDir, relativeName);
  const root = await realpath(config.tasksDir).catch(() => {
    throw new Error(`Tasks directory not found: ${config.tasksDir}`);
  });
  const resolved = await realpath(candidate).catch(() => {
    throw new Error(`Task not found: ${candidate}`);
  });

  if (!isPathInside(root, resolved) || path.extname(resolved) !== '.txt') {
    throw new Error(`Task must be a .txt file inside ${config.tasksDir}.`);
  }

  const prompt = await readFile(resolved, 'utf8');
  if (!prompt.trim()) throw new Error(`Task is empty: ${resolved}`);
  return { path: resolved, prompt };
}

export async function readSystemPrompt(config: BbxConfig): Promise<string> {
  return readFile(config.systemPromptFile, 'utf8').catch(error => {
    throw new Error(`Unable to read system prompt ${config.systemPromptFile}: ${errorMessage(error)}`);
  });
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const json = (error as Error & { json?: unknown }).json;
  if (json && typeof json === 'object') {
    const serviceError = (json as { error?: unknown }).error;
    const detail = serviceError && typeof serviceError === 'object'
      ? (serviceError as { message?: unknown }).message
      : (json as { message?: unknown }).message;
    if (typeof detail === 'string' && detail && detail !== error.message) {
      return `${error.message}: ${detail}`;
    }
  }

  return error.message;
}
