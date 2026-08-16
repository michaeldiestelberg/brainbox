import type { ModelMessage, ToolResultPart } from 'ai';

type ContentPart = {
  type?: string;
  text?: string;
  mediaType?: string;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isViewImageFileResult(part: unknown): part is ToolResultPart {
  if (!isRecord(part) || part.type !== 'tool-result' || part.toolName !== 'view_image') return false;
  const output = part.output;
  if (!isRecord(output) || output.type !== 'content' || !Array.isArray(output.value)) return false;
  return output.value.some(item => isRecord(item) && item.type === 'file');
}

function stubViewImageOutput(output: ToolResultPart['output']): ToolResultPart['output'] {
  const parts = output.type === 'content' && Array.isArray(output.value)
    ? output.value as ContentPart[]
    : [];
  const texts = parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text!.trim())
    .filter(Boolean);
  const summary = texts[0] ?? 'Image previously viewed';
  return {
    type: 'content',
    value: [{
      type: 'text',
      text: `${summary} [image payload omitted from later steps to save context]`,
    }],
  };
}

/**
 * Keep only the latest view_image file payload in the conversation.
 * Earlier screenshots become short text stubs so the model still knows it inspected them.
 */
export function evictStaleViewImages(messages: ModelMessage[]): ModelMessage[] {
  const locations: Array<{ messageIndex: number; partIndex: number }> = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (isViewImageFileResult(part)) locations.push({ messageIndex, partIndex });
    });
  });

  if (locations.length <= 1) return messages;

  const keep = locations[locations.length - 1]!;
  return messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;
    const nextContent = message.content.map((part, partIndex) => {
      const shouldStub = locations.some(
        loc => loc.messageIndex === messageIndex
          && loc.partIndex === partIndex
          && (loc.messageIndex !== keep.messageIndex || loc.partIndex !== keep.partIndex),
      );
      if (!shouldStub || !isViewImageFileResult(part)) return part;
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: stubViewImageOutput(part.output),
        ...(part.providerOptions === undefined ? {} : { providerOptions: part.providerOptions }),
      } satisfies ToolResultPart;
    });
    return { ...message, content: nextContent } as ModelMessage;
  });
}
