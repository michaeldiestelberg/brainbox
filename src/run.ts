import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import { ToolLoopAgent, isStepCount, type ModelMessage } from 'ai';
import type { BbxConfig } from './config.js';
import { errorMessage, readSystemPrompt, resolveTaskFile } from './config.js';
import { ArtifactDownloadError, downloadArtifacts, type ArtifactManifest } from './artifacts.js';
import { RunLogger } from './log.js';
import { StreamEventLogger } from './stream-log.js';
import { TerminalReporter } from './terminal.js';
import {
  fetchModels,
  findRunnableModel,
  formatReasoningLevel,
  getMaxOutputTokens,
  reasoningLevelFromWarnings,
  type ReasoningEffort,
} from './models.js';
import { createSandboxTools, initializeSandboxFilesystem, type FinishState } from './tools.js';

export type RunStatus =
  | 'completed'
  | 'turn_limit'
  | 'time_limit'
  | 'agent_error'
  | 'artifact_download_error'
  | 'interrupted';

export type RunResult = {
  runId: string;
  status: RunStatus;
  task: string;
  model: string;
  /** Reasoning level actually used (after any SDK remap). */
  reasoningEffort: string;
  /** Level requested on the CLI, or "provider default" when unset. */
  requestedReasoningEffort: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  turns: number;
  summary?: string;
  artifacts?: ArtifactManifest;
  error?: string;
  cleanupError?: string;
  logError?: string;
  logDirectory: string;
};

export type RunOptions = {
  config: BbxConfig;
  taskName: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  runId?: string;
};

export function createRunId(modelId: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const model = modelId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 108)
    .replace(/[._-]+$/g, '') || 'model';
  return `${date}-${model}-${randomBytes(4).toString('hex')}`;
}

export function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('Run ID must be 1-128 filesystem-safe characters.');
  }
  return runId;
}

export function createSandboxName(runId: string): string {
  const safeRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const name = `bbx-${safeRunId}`;
  if (name.length <= 63) return name;

  const suffix = safeRunId.slice(-8);
  const prefix = safeRunId
    .slice(0, 63 - 'bbx--'.length - suffix.length)
    .replace(/-+$/g, '');
  return `bbx-${prefix}-${suffix}`;
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function consumeAgentStream(
  result: Awaited<ReturnType<ToolLoopAgent<any, any>['stream']>>,
  logger: RunLogger,
  terminal: TerminalReporter,
  onWarnings?: (warnings: unknown) => Promise<void>,
): Promise<void> {
  const streamLogger = new StreamEventLogger({
    event: async (type, data = {}) => {
      await logger.event(type, data);
      terminal.event(type, data);
    },
  });
  try {
    for await (const part of result.stream) {
      await streamLogger.record(part);
      if (part && typeof part === 'object' && 'warnings' in part) {
        await onWarnings?.((part as { warnings?: unknown }).warnings);
      }
      if (part.type === 'text-delta') terminal.text(part.text);
    }
  } finally {
    await streamLogger.flush();
    terminal.finishText();
  }
}

export async function runTask(options: RunOptions): Promise<RunResult> {
  const started = new Date();
  const runId = validateRunId(options.runId ?? createRunId(options.modelId, started));
  const requestedReasoning = options.reasoningEffort ?? 'provider-default';
  const requestedReasoningEffort = formatReasoningLevel(options.reasoningEffort);
  let usedReasoningEffort = requestedReasoningEffort;
  const task = await resolveTaskFile(options.config, options.taskName);
  const systemPrompt = await readSystemPrompt(options.config);
  await mkdir(options.config.logsDir, { recursive: true });
  await mkdir(options.config.artifactsDir, { recursive: true });
  const logger = await RunLogger.create(options.config.logsDir, runId);
  const terminal = new TerminalReporter();
  const durationMs = options.config.limits.durationMinutes * 60_000;
  const deadline = Date.now() + durationMs;
  const processAbort = new AbortController();
  const cleanupAbort = new AbortController();
  let interrupted = false;
  let cleanupStarted = false;
  const interrupt = () => {
    interrupted = true;
    const error = new Error('Run interrupted by the user.');
    if (cleanupStarted || processAbort.signal.aborted) cleanupAbort.abort(error);
    else processAbort.abort(error);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const workSignal = AbortSignal.any([AbortSignal.timeout(durationMs), processAbort.signal]);
  const finish: FinishState = { accepted: false, artifacts: [] };
  let sandbox: Sandbox | undefined;
  let turns = 0;
  let status: RunStatus = 'agent_error';
  let runError: string | undefined;
  let cleanupError: string | undefined;
  let logError: string | undefined;
  let artifacts: ArtifactManifest | undefined;

  const cleanupSignal = (timeoutMs: number): AbortSignal => {
    cleanupStarted = true;
    return AbortSignal.any([cleanupAbort.signal, AbortSignal.timeout(timeoutMs)]);
  };
  const recordLogError = async (filename: string, error: unknown): Promise<void> => {
    logError ??= `${filename}: ${errorMessage(error)}`;
    await logger.event('log.write.error', { filename, error });
  };
  const writeLogJson = async (filename: string, value: unknown): Promise<void> => {
    try {
      await logger.writeJson(filename, value);
    } catch (error) {
      await recordLogError(filename, error);
    }
  };
  const captureLoggerError = (): void => {
    if (logger.error !== undefined) logError ??= `events.jsonl: ${errorMessage(logger.error)}`;
  };

  await logger.event('run.started', {
    runId,
    task: { name: options.taskName, path: task.path, prompt: task.prompt },
    systemPrompt,
    model: options.modelId,
    reasoningEffort: usedReasoningEffort,
    requestedReasoningEffort,
    limits: options.config.limits,
    config: {
      tasksDir: options.config.tasksDir,
      artifactsDir: options.config.artifactsDir,
      logsDir: options.config.logsDir,
      systemPromptFile: options.config.systemPromptFile,
    },
  });
  terminal.started(runId, options.taskName, options.modelId, usedReasoningEffort);

  const applyReasoningWarnings = async (warnings: unknown, source: string): Promise<void> => {
    const resolved = reasoningLevelFromWarnings(warnings);
    if (!resolved || resolved === usedReasoningEffort) return;
    usedReasoningEffort = resolved;
    await logger.event('reasoning.resolved', {
      requested: requestedReasoningEffort,
      used: usedReasoningEffort,
      source,
      warnings,
    });
    terminal.phase(`Reasoning remapped to ${usedReasoningEffort}`);
  };

  try {
    const models = await fetchModels(AbortSignal.any([workSignal, AbortSignal.timeout(15_000)]));
    const model = findRunnableModel(models, options.modelId);
    const maxOutputTokens = getMaxOutputTokens(model);
    await logger.event('model.selected', { model, maxOutputTokens, reasoningEffort: usedReasoningEffort });

    const sandboxName = createSandboxName(runId);
    sandbox = await Sandbox.create({
      name: sandboxName,
      persistent: false,
      timeout: durationMs + 120_000,
      tags: { app: 'bbx', run: runId.slice(0, 64) },
      signal: workSignal,
    });
    await logger.event('sandbox.created', {
      name: sandbox.name,
      image: sandbox.image,
      persistent: sandbox.persistent,
      region: sandbox.region,
      runtime: sandbox.runtime,
    });
    await initializeSandboxFilesystem(sandbox, workSignal);
    await logger.event('sandbox.initialized');
    terminal.sandboxReady(sandbox.region);

    const tools = createSandboxTools({ sandbox, logger, signal: workSignal, model, finish });
    const messages: ModelMessage[] = [{ role: 'user', content: task.prompt }];

    while (!finish.accepted && turns < options.config.limits.turns && !workSignal.aborted) {
      const turnBudget = options.config.limits.turns - turns;
      const agent = new ToolLoopAgent({
        model: options.modelId,
        instructions: systemPrompt,
        tools,
        reasoning: requestedReasoning,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        stopWhen: [({ steps }) => finish.accepted && steps.length > 0, isStepCount(turnBudget)],
        providerOptions: {
          gateway: { user: runId, tags: ['app:bbx', `run:${runId.slice(0, 60)}`] },
        },
      });

      const result = await agent.stream({
        messages,
        abortSignal: workSignal,
        timeout: { totalMs: remainingMs(deadline) },
        onStepStart: event => logger.event('agent.step.start', { stepNumber: turns + event.stepNumber, messages: event.messages }),
        onStepEnd: async event => {
          await applyReasoningWarnings(event.warnings, 'agent.step.end');
          await logger.event('agent.step.end', {
            stepNumber: turns + event.stepNumber,
            finishReason: event.finishReason,
            usage: event.usage,
            performance: event.performance,
            warnings: event.warnings,
            reasoningEffort: usedReasoningEffort,
          });
        },
      });

      await consumeAgentStream(result, logger, terminal, warnings => applyReasoningWarnings(warnings, 'agent.stream'));
      const [steps, responseMessages, usage, warnings] = await Promise.all([
        result.steps,
        result.responseMessages,
        result.usage,
        result.warnings,
      ]);
      await applyReasoningWarnings(warnings, 'agent.invocation.end');
      turns += steps.length;
      messages.push(...responseMessages);
      await logger.event('agent.invocation.end', {
        turns,
        usage,
        warnings,
        finished: finish.accepted,
        reasoningEffort: usedReasoningEffort,
      });

      if (!finish.accepted && turns < options.config.limits.turns && !workSignal.aborted) {
        messages.push({
          role: 'user',
          content: 'Continue working. Do not stop with a normal response; call finish_task only when the task and artifacts are complete.',
        });
        await logger.event('agent.continue.requested', { turns });
      }
    }

    if (finish.accepted) status = 'completed';
    else if (interrupted) status = 'interrupted';
    else if (workSignal.aborted || Date.now() >= deadline) status = 'time_limit';
    else status = 'turn_limit';

    try {
      terminal.phase('Downloading artifacts…');
      artifacts = await downloadArtifacts({
        sandbox,
        artifactsDir: options.config.artifactsDir,
        runId,
        ...(finish.accepted ? { declarations: finish.artifacts } : {}),
        logger,
        signal: cleanupSignal(120_000),
        partial: !finish.accepted,
      });
      terminal.artifactsDownloaded(artifacts.files.length);
    } catch (error) {
      if (error instanceof ArtifactDownloadError) artifacts = error.manifest;
      runError = `Artifact download failed: ${errorMessage(error)}`;
      status = 'artifact_download_error';
      await logger.event('artifact.download.error', { error });
    }
    if (artifacts) await writeLogJson('artifact-manifest.json', artifacts);
  } catch (error) {
    runError = errorMessage(error);
    status = interrupted
      ? 'interrupted'
      : workSignal.aborted || Date.now() >= deadline
        ? 'time_limit'
        : 'agent_error';
    await logger.event('run.error', { error });

    if (sandbox) {
      try {
        artifacts = await downloadArtifacts({
          sandbox,
          artifactsDir: options.config.artifactsDir,
          runId,
          logger,
          signal: cleanupSignal(120_000),
          partial: true,
        });
      } catch (salvageError) {
        if (salvageError instanceof ArtifactDownloadError) artifacts = salvageError.manifest;
        await logger.event('artifact.salvage.error', { error: salvageError });
      }
      if (artifacts) await writeLogJson('artifact-manifest.json', artifacts);
    }
  } finally {
    if (sandbox) {
      try {
        await sandbox.delete({ signal: cleanupSignal(60_000) });
        await logger.event('sandbox.deleted', { name: sandbox.name });
      } catch (error) {
        cleanupError = errorMessage(error);
        await logger.event('sandbox.delete.error', { error });
      }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }

  captureLoggerError();
  const finished = new Date();
  const result: RunResult = {
    runId,
    status,
    task: options.taskName,
    model: options.modelId,
    reasoningEffort: usedReasoningEffort,
    requestedReasoningEffort,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    turns,
    ...(finish.summary === undefined ? {} : { summary: finish.summary }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(runError === undefined ? {} : { error: runError }),
    ...(cleanupError === undefined ? {} : { cleanupError }),
    ...(logError === undefined ? {} : { logError }),
    logDirectory: logger.directory,
  };
  await logger.event('run.finished', { result });
  await logger.flush();
  captureLoggerError();
  if (logError !== undefined) result.logError = logError;
  await writeLogJson('result.json', result);
  await logger.flush();
  captureLoggerError();
  if (logError !== undefined) result.logError = logError;
  return result;
}
