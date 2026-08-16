import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterModels,
  findRunnableModel,
  formatModelsTable,
  formatReasoningSummary,
  getMaxOutputTokens,
  getReasoningEffortValues,
  parseReasoningEffort,
  remappedReasoningFromWarnings,
  resolveUsedReasoningLevel,
  type GatewayModel,
} from '../src/models.js';

const runnable: GatewayModel = {
  id: 'example/agent',
  name: 'Agent',
  type: 'language',
  max_tokens: 32_768,
  tags: ['tool-use', 'reasoning', 'vision'],
  modalities: { input: ['text', 'image'], output: ['text'] },
  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
};

test('selects only tool-capable language models', () => {
  assert.equal(findRunnableModel([runnable], runnable.id), runnable);
  assert.throws(
    () => findRunnableModel([{ ...runnable, id: 'example/image', type: 'image' }], 'example/image'),
    /cannot run an agent task/,
  );
});

test('uses positive catalog output limits and ignores zero sentinels', () => {
  assert.equal(getMaxOutputTokens(runnable), 32_768);
  assert.equal(getMaxOutputTokens({ ...runnable, max_tokens: 0 }), undefined);
  assert.equal(getMaxOutputTokens({ ...runnable, max_tokens: null }), undefined);
});

test('validates and resolves reasoning effort without a catalog gate', () => {
  assert.equal(parseReasoningEffort('high'), 'high');
  assert.throws(() => parseReasoningEffort('extreme'), /Invalid reasoning effort/);
  assert.equal(resolveUsedReasoningLevel(undefined, []), 'provider default');
  assert.equal(resolveUsedReasoningLevel('provider-default', []), 'provider default');
  assert.equal(resolveUsedReasoningLevel('high', []), 'high');
  assert.equal(
    remappedReasoningFromWarnings([{
      type: 'compatibility',
      feature: 'reasoning',
      details: 'reasoning "xhigh" is not directly supported by this model. mapped to effort "high".',
    }]),
    'high',
  );
  assert.equal(
    resolveUsedReasoningLevel('xhigh', [{
      type: 'compatibility',
      feature: 'reasoning',
      details: 'reasoning "xhigh" is not directly supported by this model. mapped to effort "high".',
    }]),
    'high',
  );
  assert.equal(
    resolveUsedReasoningLevel('high', [{
      type: 'unsupported',
      feature: 'reasoning',
      details: 'reasoning "high" is not supported by this model.',
    }]),
    'provider default',
  );
});

test('reads and summarizes reasoning options', () => {
  assert.deepEqual(getReasoningEffortValues(runnable), ['low', 'high']);
  assert.equal(getReasoningEffortValues({ ...runnable, reasoning_options: [{ type: 'toggle' }] }), undefined);
  assert.equal(formatReasoningSummary(runnable), 'low, high');
  assert.equal(
    formatReasoningSummary({
      ...runnable,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'budget_tokens', min: 1024, max: 32_768 },
        { type: 'effort', values: ['minimal', 'high'] },
      ],
    }),
    'minimal, high · toggle · budget 1024–32768',
  );
  assert.equal(
    formatReasoningSummary({
      ...runnable,
      reasoning_options: [{ type: 'budget_tokens', min: 128 }],
    }),
    'budget ≥128',
  );
  assert.equal(
    formatReasoningSummary({ ...runnable, tags: ['reasoning'], reasoning_options: null }),
    'fixed',
  );
  assert.equal(
    formatReasoningSummary({ ...runnable, tags: ['tool-use'], reasoning_options: null }),
    '—',
  );
});

test('filters and formats a readable models table', () => {
  const other: GatewayModel = {
    id: 'example/short',
    name: 'Short',
    type: 'language',
    tags: ['tool-use'],
  };
  const filtered = filterModels([runnable, other], { reasoning: true });
  assert.deepEqual(filtered.map(model => model.id), ['example/agent']);

  const byQuery = filterModels(
    [
      runnable,
      other,
      { id: 'xai/grok-4.5', name: 'Grok 4.5', type: 'language', tags: ['tool-use', 'reasoning'] },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', type: 'language', tags: ['tool-use'] },
    ],
    { query: 'Grok' },
  );
  assert.deepEqual(byQuery.map(model => model.id), ['xai/grok-4.5']);
  assert.deepEqual(
    filterModels(
      [
        { id: 'xai/other', name: 'Something Grok-like', type: 'language', tags: [] },
        runnable,
      ],
      { query: '  grok  ' },
    ).map(model => model.id),
    ['xai/other'],
  );
  assert.deepEqual(
    filterModels([runnable, other], { query: 'agent', toolUse: true }).map(model => model.id),
    ['example/agent'],
  );

  const table = formatModelsTable([runnable, other]);
  assert.match(table, /^ID\s+TYPE\s+REASONING\s+CAPABILITIES$/m);
  assert.match(table, /example\/agent\s+language\s+low, high\s+tool-use, reasoning, vision/);
  assert.match(table, /example\/short\s+language\s+—\s+tool-use/);
  assert.match(table, /2 models$/);

  assert.equal(
    formatModelsTable([]),
    [
      'ID  TYPE  REASONING  CAPABILITIES',
      '──  ────  ─────────  ────────────',
      '(no models match the selected filters)',
      '',
      '0 models',
    ].join('\n'),
  );
});
