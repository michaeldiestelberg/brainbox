import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /(authorization|api[-_]?key|password|secret|credential)/i;
const SECRET_TOKEN_KEY = /token$/i;
const BINARY_KEY = /^(base64|data)$/i;

export class RunLogger {
  readonly directory: string;
  readonly eventsFile: string;
  private queue: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private constructor(directory: string) {
    this.directory = directory;
    this.eventsFile = path.join(directory, 'events.jsonl');
  }

  static async create(logsDir: string, runId: string): Promise<RunLogger> {
    const directory = path.join(logsDir, runId);
    await mkdir(directory, { recursive: false });
    const logger = new RunLogger(directory);
    await writeFile(logger.eventsFile, '', { flag: 'wx' });
    return logger;
  }

  event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const safeData = sanitize(data) as Record<string, unknown>;
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), type, ...safeData })}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.eventsFile, line))
      .catch(error => { this.rememberError(error); });
    return this.queue;
  }

  async writeJson(filename: string, value: unknown): Promise<string> {
    await this.flush();
    const destination = path.join(this.directory, filename);
    try {
      await writeFile(destination, `${JSON.stringify(sanitize(value), null, 2)}\n`, { flag: 'wx' });
      return destination;
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  get error(): unknown {
    return this.writeError;
  }

  private rememberError(error: unknown): void {
    this.writeError ??= error;
  }
}

export function sanitize(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key) || SECRET_TOKEN_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const source = value as Error & {
      cause?: unknown;
      response?: { status?: unknown; statusText?: unknown; url?: unknown };
    };
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [childKey, childValue] of Object.entries(value)) {
      if (!['name', 'message', 'stack', 'response'].includes(childKey)) {
        details[childKey] = sanitize(childValue, childKey, seen);
      }
    }
    if (source.cause !== undefined && details.cause === undefined) {
      details.cause = sanitize(source.cause, 'cause', seen);
    }
    if (source.response) {
      details.response = sanitize({
        status: source.response.status,
        statusText: source.response.statusText,
        url: source.response.url,
      }, 'response', seen);
    }
    seen.delete(value);
    return details;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return { bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') };
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, key, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const entries = Object.entries(value).map(([childKey, childValue]) => {
      if (BINARY_KEY.test(childKey) && typeof childValue === 'string' && childValue.length > 4096) {
        return [childKey, `[OMITTED ${childValue.length} encoded characters]`];
      }
      return [childKey, sanitize(childValue, childKey, seen)];
    });
    seen.delete(value);
    return Object.fromEntries(entries);
  }
  return value;
}
