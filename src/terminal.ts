const PREVIEW_LENGTH = 160;

type Writer = (text: string) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function compact(value: unknown, limit = PREVIEW_LENGTH): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function pathsFromFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(file => record(file)?.path)
    .filter((path): path is string => typeof path === 'string');
}

function toolCallDetail(toolName: unknown, inputValue: unknown): string {
  const input = record(inputValue);
  if (!input) return '';

  switch (toolName) {
    case 'run_command':
      return compact(input.command);
    case 'read_file':
    case 'list_files':
    case 'view_image':
      return compact(input.path);
    case 'write_files': {
      const paths = pathsFromFiles(input.files);
      if (paths.length === 0) return '';
      const shown = paths.slice(0, 2).join(', ');
      return compact(paths.length > 2 ? `${shown} (+${paths.length - 2} more)` : shown);
    }
    case 'finish_task': {
      const paths = pathsFromFiles(input.artifacts);
      return paths.length === 0 ? 'no artifacts' : compact(paths.join(', '));
    }
    case 'command_status':
    case 'kill_command':
      return compact(input.commandId);
    default:
      return compact(JSON.stringify(input), 100);
  }
}

function errorDetail(value: unknown): string {
  const error = record(value);
  const serviceError = record(record(error?.json)?.error);
  if (serviceError?.message !== undefined) return compact(serviceError.message);
  if (value instanceof Error) return compact(value.message);
  return compact(error?.message ?? value);
}

function resultDetail(toolName: unknown, outputValue: unknown): string {
  const output = record(outputValue);
  if (!output) return '';

  if (toolName === 'run_command' && typeof output.exitCode === 'number') {
    const duration = typeof output.durationMs === 'number' ? `, ${output.durationMs}ms` : '';
    return `exit ${output.exitCode}${duration}`;
  }
  if (toolName === 'write_files') {
    const count = Array.isArray(output.files) ? output.files.length : 0;
    return `${count} ${count === 1 ? 'file' : 'files'}`;
  }
  if (toolName === 'read_file' && typeof output.bytes === 'number') {
    return `${output.bytes} bytes`;
  }
  if (toolName === 'finish_task' && output.accepted === false) {
    return `rejected: ${compact(output.error)}`;
  }
  return '';
}

export class TerminalReporter {
  private streamingText = false;

  constructor(private readonly write: Writer = text => process.stdout.write(text)) {}

  started(runId: string, task: string, model: string, reasoning: string): void {
    this.line(`Run ${runId}`);
    this.line(`· Task: ${task}`);
    this.line(`· Model: ${model}`);
    this.line(`· Reasoning: ${reasoning}`);
  }

  sandboxReady(region?: string): void {
    this.line(`✓ Sandbox ready${region ? ` (${region})` : ''}`);
  }

  text(text: string): void {
    this.write(text);
    this.streamingText = true;
  }

  event(type: string, data: Record<string, unknown>): void {
    if (type === 'agent.reasoning') {
      const preview = compact(data.text);
      if (preview) this.line(`· Thinking: ${preview}`);
      return;
    }

    const part = record(data.part);
    if (!part) return;
    if (type === 'agent.tool-call') {
      const detail = toolCallDetail(part.toolName, part.input);
      this.line(`→ ${String(part.toolName)}${detail ? `: ${detail}` : ''}`);
    } else if (type === 'agent.tool-result') {
      const detail = resultDetail(part.toolName, part.output);
      const rejected = part.toolName === 'finish_task' && record(part.output)?.accepted === false;
      this.line(`${rejected ? '!' : '✓'} ${String(part.toolName)}${detail ? ` (${detail})` : ''}`);
    } else if (type === 'agent.tool-error') {
      this.line(`✗ ${String(part.toolName)}: ${errorDetail(part.error)}`);
    }
  }

  phase(message: string): void {
    this.line(`· ${message}`);
  }

  artifactsDownloaded(count: number): void {
    this.line(`✓ Downloaded ${count} ${count === 1 ? 'artifact' : 'artifacts'}`);
  }

  finishText(): void {
    if (this.streamingText) this.write('\n');
    this.streamingText = false;
  }

  private line(text: string): void {
    this.finishText();
    this.write(`${text}\n`);
  }
}
