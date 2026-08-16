import type { TextStreamPart, ToolSet } from 'ai';

type StreamPart = TextStreamPart<ToolSet>;

type EventSink = {
  event(type: string, data?: Record<string, unknown>): Promise<void>;
};

type ContentBuffer = {
  text: string;
  providerMetadata: unknown;
};

type ToolInputBuffer = {
  input: string;
  details: Record<string, unknown>;
};

function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export class StreamEventLogger {
  private readonly reasoning = new Map<string, ContentBuffer>();
  private readonly text = new Map<string, ContentBuffer>();
  private readonly toolInput = new Map<string, ToolInputBuffer>();

  constructor(private readonly sink: EventSink) {}

  async record(part: StreamPart): Promise<void> {
    switch (part.type) {
      case 'reasoning-start':
        this.reasoning.set(part.id, {
          text: '',
          providerMetadata: part.providerMetadata,
        });
        return;
      case 'reasoning-delta': {
        const buffer = this.reasoning.get(part.id);
        if (!buffer) return this.writePart(part);
        buffer.text += part.text;
        buffer.providerMetadata = part.providerMetadata ?? buffer.providerMetadata;
        return;
      }
      case 'reasoning-end':
        return this.completeContent('reasoning', part.id, part.providerMetadata);
      case 'text-start':
        this.text.set(part.id, {
          text: '',
          providerMetadata: part.providerMetadata,
        });
        return;
      case 'text-delta': {
        const buffer = this.text.get(part.id);
        if (!buffer) return this.writePart(part);
        buffer.text += part.text;
        buffer.providerMetadata = part.providerMetadata ?? buffer.providerMetadata;
        return;
      }
      case 'text-end':
        return this.completeContent('text', part.id, part.providerMetadata);
      case 'tool-input-start': {
        const { type: _type, id: _id, ...details } = part;
        this.toolInput.set(part.id, { input: '', details });
        return;
      }
      case 'tool-input-delta': {
        const buffer = this.toolInput.get(part.id);
        if (!buffer) return this.writePart(part);
        buffer.input += part.delta;
        if (part.providerMetadata !== undefined) {
          buffer.details.providerMetadata = part.providerMetadata;
        }
        return;
      }
      case 'tool-input-end':
        return this.completeToolInput(part.id, part.providerMetadata);
      default:
        return this.writePart(part);
    }
  }

  async flush(): Promise<void> {
    for (const [id, buffer] of this.reasoning) {
      await this.writeContent('reasoning', id, buffer, true);
    }
    for (const [id, buffer] of this.text) {
      await this.writeContent('text', id, buffer, true);
    }
    for (const [id, buffer] of this.toolInput) {
      await this.writeToolInput(id, buffer, true);
    }
    this.reasoning.clear();
    this.text.clear();
    this.toolInput.clear();
  }

  private async completeContent(
    kind: 'reasoning' | 'text',
    id: string,
    providerMetadata: unknown,
  ): Promise<void> {
    const buffers = kind === 'reasoning' ? this.reasoning : this.text;
    const buffer = buffers.get(id);
    if (!buffer) {
      await this.sink.event(`agent.${kind}`, { id, text: '' });
      return;
    }
    buffer.providerMetadata = providerMetadata ?? buffer.providerMetadata;
    buffers.delete(id);
    await this.writeContent(kind, id, buffer, false);
  }

  private writeContent(
    kind: 'reasoning' | 'text',
    id: string,
    buffer: ContentBuffer,
    incomplete: boolean,
  ): Promise<void> {
    return this.sink.event(`agent.${kind}`, {
      id,
      text: buffer.text,
      ...(buffer.providerMetadata === undefined
        ? {}
        : { providerMetadata: buffer.providerMetadata }),
      ...(incomplete ? { incomplete: true } : {}),
    });
  }

  private async completeToolInput(id: string, providerMetadata: unknown): Promise<void> {
    const buffer = this.toolInput.get(id);
    if (!buffer) {
      await this.sink.event('agent.tool-input', { id, input: '' });
      return;
    }
    if (providerMetadata !== undefined) buffer.details.providerMetadata = providerMetadata;
    this.toolInput.delete(id);
    await this.writeToolInput(id, buffer, false);
  }

  private writeToolInput(
    id: string,
    buffer: ToolInputBuffer,
    incomplete: boolean,
  ): Promise<void> {
    return this.sink.event('agent.tool-input', {
      id,
      ...buffer.details,
      input: parseToolInput(buffer.input),
      ...(incomplete ? { incomplete: true } : {}),
    });
  }

  private writePart(part: StreamPart): Promise<void> {
    return this.sink.event(`agent.${part.type}`, {
      part: part as unknown as Record<string, unknown>,
    });
  }
}
