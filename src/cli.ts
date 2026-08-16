#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage, loadConfig, loadProjectEnvironment, readSystemPrompt } from './config.js';
import { fetchModels, filterModels, formatModelsTable, parseReasoningEffort } from './models.js';
import { validateOpenRouterKey } from './openrouter.js';
import { runTask } from './run.js';

const HELP = `bbx — run AI agent tasks in disposable Vercel Sandboxes

Usage:
  bbx run <task> --model <provider/model> [--reasoning-effort <level>] [--run-id <id>]
  bbx models [query] [--tool-use] [--vision] [--reasoning]
  bbx doctor

Options:
  --config <path>             Config file (default: ./bbx.config.json)
  --model <id>               OpenRouter model ID
  --reasoning-effort <level> provider-default, none, minimal, low, medium, high, xhigh
  --run-id <id>              Optional explicit run identifier override
  --tool-use                 List only models that support tool use
  --vision                   List only models that support vision
  --reasoning                List only models that support reasoning
  --help                     Show this help
  --version                  Show the version

Examples:
  bbx models grok
  bbx models claude --tool-use --reasoning
`;

async function showModels(filters: {
  toolUse: boolean;
  vision: boolean;
  reasoning: boolean;
  query?: string;
}): Promise<void> {
  const models = await fetchModels(AbortSignal.timeout(15_000));
  const filtered = filterModels(models, filters);
  console.log(formatModelsTable(filtered));
}

function oidcExpiry(token: string): Date | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return decoded.exp ? new Date(decoded.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

async function doctor(configPath?: string): Promise<boolean> {
  const config = await loadConfig(process.cwd(), configPath);
  const envFile = loadProjectEnvironment(config.baseDir);
  const checks: Array<[string, boolean, string]> = [];
  checks.push(['config', existsSync(config.configFile), config.configFile]);
  checks.push(['tasks', existsSync(config.tasksDir), config.tasksDir]);
  try {
    await readSystemPrompt(config);
    checks.push(['system prompt', true, config.systemPromptFile]);
  } catch (error) {
    checks.push(['system prompt', false, errorMessage(error)]);
  }
  const projectFile = path.join(config.baseDir, '.vercel', 'project.json');
  const repoFile = path.join(config.baseDir, '.vercel', 'repo.json');
  const linkFile = existsSync(projectFile) ? projectFile : existsSync(repoFile) ? repoFile : undefined;
  checks.push([
    'Vercel project',
    linkFile !== undefined,
    linkFile ?? `${path.join(config.baseDir, '.vercel')}/{project.json,repo.json}`,
  ]);

  const token = process.env.VERCEL_OIDC_TOKEN;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const expiry = token ? oidcExpiry(token) : undefined;
  const oidcValid = Boolean(token && (!expiry || expiry.getTime() > Date.now()));
  const explicitSandboxAuth = Boolean(
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID,
  );
  const sandboxAuthValid = oidcValid || explicitSandboxAuth;
  let openRouterAuthValid = Boolean(apiKey);
  if (!apiKey) {
    checks.push([
      'OpenRouter auth',
      false,
      `OPENROUTER_API_KEY not found${envFile ? ` in ${envFile}` : ''}`,
    ]);
  } else {
    try {
      const detail = await validateOpenRouterKey(apiKey, AbortSignal.timeout(15_000));
      openRouterAuthValid = true;
      checks.push(['OpenRouter auth', true, detail]);
    } catch (error) {
      openRouterAuthValid = false;
      checks.push(['OpenRouter auth', false, errorMessage(error)]);
    }
  }
  checks.push([
    'Sandbox auth',
    sandboxAuthValid,
    oidcValid
      ? 'VERCEL_OIDC_TOKEN is valid'
      : explicitSandboxAuth
        ? 'VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are set'
        : 'OIDC or explicit Sandbox credentials not found',
  ]);

  try {
    const models = await fetchModels(AbortSignal.timeout(15_000));
    checks.push(['OpenRouter', true, `${models.length} models available`]);
  } catch (error) {
    checks.push(['OpenRouter', false, errorMessage(error)]);
  }

  for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok' : 'FAIL'}  ${name}: ${detail}`);
  if (!openRouterAuthValid) {
    console.log('\nSet OPENROUTER_API_KEY in .env.local next to your config file.');
  }
  if (!sandboxAuthValid) {
    console.log('\nRun: vercel login && vercel link && vercel env pull .env.local --yes');
  }
  return checks.every(([, ok]) => ok);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      model: { type: 'string' },
      'reasoning-effort': { type: 'string' },
      'run-id': { type: 'string' },
      'tool-use': { type: 'boolean', default: false },
      vision: { type: 'boolean', default: false },
      reasoning: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    console.log('bbx 0.1.0');
    return;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  const command = positionals[0];
  if (command === 'models') {
    if (positionals.length > 2) throw new Error(`Unexpected argument: ${positionals[2]}`);
    await showModels({
      toolUse: values['tool-use'] ?? false,
      vision: values.vision ?? false,
      reasoning: values.reasoning ?? false,
      ...(positionals[1] ? { query: positionals[1] } : {}),
    });
    return;
  }
  if (command === 'doctor') {
    if (!(await doctor(values.config))) process.exitCode = 1;
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command: ${command}`);

  const taskName = positionals[1];
  if (!taskName) throw new Error('Missing task name.');
  if (positionals.length > 2) throw new Error(`Unexpected argument: ${positionals[2]}`);
  if (!values.model) throw new Error('Missing required --model <provider/model>.');

  const config = await loadConfig(process.cwd(), values.config);
  loadProjectEnvironment(config.baseDir);
  const reasoningEffort = parseReasoningEffort(values['reasoning-effort']);
  const result = await runTask({
    config,
    taskName,
    modelId: values.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(values['run-id'] ? { runId: values['run-id'] } : {}),
  });

  console.log(`\nRun ${result.runId}: ${result.status}`);
  if (result.summary) console.log(result.summary);
  if (result.artifacts) {
    for (const artifact of result.artifacts.files) {
      console.log(path.join(result.artifacts.directory, artifact.path));
    }
  }
  console.log(`Logs: ${result.logDirectory}`);
  if (result.error) console.error(result.error);
  if (result.cleanupError) console.error(`Sandbox cleanup failed: ${result.cleanupError}`);
  if (result.logError) console.error(`Run logging failed: ${result.logError}`);
  if (result.status !== 'completed' || result.cleanupError || result.logError) process.exitCode = 1;
}

main().catch(error => {
  console.error(`bbx: ${errorMessage(error)}`);
  process.exitCode = 1;
});
