import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextStreamPart, ToolSet } from 'ai';
import { StreamEventLogger } from '../src/stream-log.js';

type LoggedEvent = { type: string; data: Record<string, unknown> };

function part(value: unknown): TextStreamPart<ToolSet> {
  return value as TextStreamPart<ToolSet>;
}

test('stream deltas are combined into readable blocks', async () => {
  const events: LoggedEvent[] = [];
  const logger = new StreamEventLogger({
    event: async (type, data = {}) => { events.push({ type, data }); },
  });

  await logger.record(part({ type: 'reasoning-start', id: 'reasoning-1' }));
  await logger.record(part({ type: 'reasoning-delta', id: 'reasoning-1', text: 'Think ' }));
  await logger.record(part({ type: 'reasoning-delta', id: 'reasoning-1', text: 'carefully.' }));
  await logger.record(part({ type: 'reasoning-end', id: 'reasoning-1' }));
  await logger.record(part({ type: 'text-start', id: 'text-1' }));
  await logger.record(part({ type: 'text-delta', id: 'text-1', text: 'Done.' }));
  await logger.record(part({ type: 'text-end', id: 'text-1' }));
  await logger.record(part({ type: 'tool-input-start', id: 'tool-1', toolName: 'run_command' }));
  await logger.record(part({ type: 'tool-input-delta', id: 'tool-1', delta: '{"command":' }));
  await logger.record(part({ type: 'tool-input-delta', id: 'tool-1', delta: '"pwd"}' }));
  await logger.record(part({ type: 'tool-input-end', id: 'tool-1' }));
  await logger.flush();

  assert.deepEqual(events, [
    {
      type: 'agent.reasoning',
      data: { id: 'reasoning-1', text: 'Think carefully.' },
    },
    {
      type: 'agent.text',
      data: { id: 'text-1', text: 'Done.' },
    },
    {
      type: 'agent.tool-input',
      data: { id: 'tool-1', toolName: 'run_command', input: { command: 'pwd' } },
    },
  ]);
});

test('unfinished stream blocks are retained and marked incomplete', async () => {
  const events: LoggedEvent[] = [];
  const logger = new StreamEventLogger({
    event: async (type, data = {}) => { events.push({ type, data }); },
  });

  await logger.record(part({ type: 'reasoning-start', id: 'reasoning-1' }));
  await logger.record(part({ type: 'reasoning-delta', id: 'reasoning-1', text: 'Partial thought' }));
  await logger.flush();

  assert.deepEqual(events, [{
    type: 'agent.reasoning',
    data: { id: 'reasoning-1', text: 'Partial thought', incomplete: true },
  }]);
});
