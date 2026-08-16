import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { evictStaleViewImages } from '../src/messages.js';

function viewImageResult(path: string, withFile: boolean): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: `call-${path}`,
      toolName: 'view_image',
      output: {
        type: 'content',
        value: withFile
          ? [
            { type: 'text', text: `Image ${path} (500000 → 80000 bytes, 1440×900 JPEG)` },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: { type: 'data', data: 'aaaabbbb' },
            },
          ]
          : [{ type: 'text', text: `Image ${path}` }],
      },
    }],
  };
}

test('evictStaleViewImages keeps only the latest screenshot file payload', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'build a landing page' },
    viewImageResult('/tmp/hero.png', true),
    viewImageResult('/tmp/experience.png', true),
    viewImageResult('/tmp/final.png', true),
  ];

  const compacted = evictStaleViewImages(messages);
  const toolResults = compacted
    .filter(message => message.role === 'tool')
    .flatMap(message => Array.isArray(message.content) ? message.content : []);

  assert.equal(toolResults.length, 3);

  const outputs = toolResults.map(part => {
    assert.equal(part.type, 'tool-result');
    return part.output;
  });

  assert.equal(outputs[0]?.type, 'content');
  assert.equal(outputs[1]?.type, 'content');
  assert.equal(outputs[2]?.type, 'content');

  const firstParts = outputs[0]!.value as Array<{ type: string; text?: string }>;
  const secondParts = outputs[1]!.value as Array<{ type: string; text?: string }>;
  const latestParts = outputs[2]!.value as Array<{ type: string; text?: string; data?: unknown }>;

  assert.equal(firstParts.length, 1);
  assert.equal(firstParts[0]?.type, 'text');
  assert.match(firstParts[0]?.text ?? '', /hero\.png/);
  assert.match(firstParts[0]?.text ?? '', /omitted from later steps/);
  assert.equal(secondParts.length, 1);
  assert.match(secondParts[0]?.text ?? '', /experience\.png/);
  assert.equal(latestParts.length, 2);
  assert.equal(latestParts[0]?.type, 'text');
  assert.equal(latestParts[1]?.type, 'file');
});

test('evictStaleViewImages is a no-op when only one screenshot exists', () => {
  const messages: ModelMessage[] = [
    viewImageResult('/tmp/only.png', true),
  ];
  const compacted = evictStaleViewImages(messages);
  assert.equal(compacted, messages);
  const part = (compacted[0]!.content as Array<{ output: { value: unknown[] } }>)[0]!;
  assert.equal(part.output.value.length, 2);
});
