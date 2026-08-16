const PREVIEW_LENGTH = 160;

type Writer = (text: string) => void;

export type ProgressDestination = {
  write: Writer;
  /** When set, long values are truncated. Omit for full text in transcript logs. */
  previewLimit?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function compact(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Full detail: trim ends, keep internal whitespace/newlines. */
function fullText(value: unknown): string {
  return String(value ?? '').replace(/^\s+/, '').replace(/\s+$/, '');
}

function detail(value: unknown, previewLimit?: number): string {
  if (previewLimit !== undefined) return compact(value, previewLimit);
  return fullText(value);
}

function pathsFromFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(file => record(file)?.path)
    .filter((path): path is string => typeof path === 'string');
}

function toolCallDetail(toolName: unknown, inputValue: unknown, previewLimit?: number): string {
  const input = record(inputValue);
  if (!input) return '';

  switch (toolName) {
    case 'run_command':
      return detail(input.command, previewLimit);
    case 'read_file':
    case 'list_files':
    case 'view_image':
      return detail(input.path, previewLimit);
    case 'write_files': {
      const paths = pathsFromFiles(input.files);
      if (paths.length === 0) return '';
      if (previewLimit !== undefined) {
        const shown = paths.slice(0, 2).join(', ');
        return compact(paths.length > 2 ? `${shown} (+${paths.length - 2} more)` : shown, previewLimit);
      }
      return paths.join(', ');
    }
    case 'finish_task': {
      const paths = pathsFromFiles(input.artifacts);
      return paths.length === 0 ? 'no artifacts' : detail(paths.join(', '), previewLimit);
    }
    case 'command_status':
    case 'kill_command':
      return detail(input.commandId, previewLimit);
    default:
      return previewLimit === undefined
        ? fullText(JSON.stringify(input))
        : compact(JSON.stringify(input), Math.min(previewLimit, 100));
  }
}

function errorDetail(value: unknown, previewLimit?: number): string {
  const error = record(value);
  const serviceError = record(record(error?.json)?.error);
  if (serviceError?.message !== undefined) return detail(serviceError.message, previewLimit);
  if (value instanceof Error) return detail(value.message, previewLimit);
  return detail(error?.message ?? value, previewLimit);
}

function resultDetail(toolName: unknown, outputValue: unknown, previewLimit?: number): string {
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
    return `rejected: ${detail(output.error, previewLimit)}`;
  }
  return '';
}

function formatLabeled(label: string, body: string): string {
  if (!body) return label;
  if (body.includes('\n')) return `${label}:\n${body}`;
  return `${label}: ${body}`;
}

export class TerminalReporter {
  private streamingText = false;
  private readonly destinations: ProgressDestination[];

  constructor(writeOrDestinations: Writer | ProgressDestination[] = text => process.stdout.write(text)) {
    this.destinations = typeof writeOrDestinations === 'function'
      ? [{ write: writeOrDestinations, previewLimit: PREVIEW_LENGTH }]
      : writeOrDestinations;
  }

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
    this.writeAll(text);
    this.streamingText = true;
  }

  event(type: string, data: Record<string, unknown>): void {
    if (type === 'agent.reasoning') {
      for (const destination of this.destinations) {
        const preview = detail(data.text, destination.previewLimit);
        if (!preview) continue;
        this.writeDestinationLine(destination, formatLabeled('· Thinking', preview));
      }
      return;
    }

    const part = record(data.part);
    if (!part) return;
    if (type === 'agent.tool-call') {
      for (const destination of this.destinations) {
        const body = toolCallDetail(part.toolName, part.input, destination.previewLimit);
        this.writeDestinationLine(
          destination,
          body ? formatLabeled(`→ ${String(part.toolName)}`, body) : `→ ${String(part.toolName)}`,
        );
      }
    } else if (type === 'agent.tool-result') {
      for (const destination of this.destinations) {
        const body = resultDetail(part.toolName, part.output, destination.previewLimit);
        const rejected = part.toolName === 'finish_task' && record(part.output)?.accepted === false;
        this.writeDestinationLine(
          destination,
          `${rejected ? '!' : '✓'} ${String(part.toolName)}${body ? ` (${body})` : ''}`,
        );
      }
    } else if (type === 'agent.tool-error') {
      for (const destination of this.destinations) {
        this.writeDestinationLine(
          destination,
          `✗ ${String(part.toolName)}: ${errorDetail(part.error, destination.previewLimit)}`,
        );
      }
    }
  }

  phase(message: string): void {
    this.line(`· ${message}`);
  }

  artifactsDownloaded(count: number): void {
    this.line(`✓ Downloaded ${count} ${count === 1 ? 'artifact' : 'artifacts'}`);
  }

  finishText(): void {
    if (this.streamingText) this.writeAll('\n');
    this.streamingText = false;
  }

  private line(text: string): void {
    this.finishText();
    this.writeAll(`${text}\n`);
  }

  private writeDestinationLine(destination: ProgressDestination, text: string): void {
    this.finishText();
    destination.write(`${text}\n`);
  }

  private writeAll(text: string): void {
    for (const destination of this.destinations) destination.write(text);
  }
}
