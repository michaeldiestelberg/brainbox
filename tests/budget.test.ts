import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affordableOutputTokens,
  estimateAppendedTokens,
  estimateFirstInputTokens,
  MIN_STEP_OUTPUT_TOKENS,
  nextInputTokensAfter,
  startBlocker,
  stepAllowance,
} from '../src/budget.js';

// $8 per million input tokens, $40 per million output tokens.
const pricing = { prompt: 8e-6, completion: 40e-6 };

test('a run without a cost limit keeps the model maximum', () => {
  assert.deepEqual(
    stepAllowance({ limitUsd: undefined, spentUsd: 99, nextInputTokens: 50_000, pricing, modelMaxOutputTokens: 128_000 }),
    { proceed: true, maxOutputTokens: 128_000 },
  );
  assert.deepEqual(
    stepAllowance({ limitUsd: undefined, spentUsd: 0, nextInputTokens: 0, pricing, modelMaxOutputTokens: undefined }),
    { proceed: true },
  );
});

test('affordable output is what remains after the next input, at the output price', () => {
  // $5.00 - $1.00 spent - 100,000 input tokens ($0.80) = $3.20, which buys 80,000 output tokens.
  assert.equal(
    affordableOutputTokens({ limitUsd: 5, spentUsd: 1, nextInputTokens: 100_000, pricing }),
    80_000,
  );
  assert.equal(affordableOutputTokens({ limitUsd: 5, spentUsd: 6, nextInputTokens: 0, pricing }), 0);
  assert.equal(
    affordableOutputTokens({ limitUsd: 5, spentUsd: 0, nextInputTokens: 0, pricing: { prompt: 0, completion: 0 } }),
    Number.POSITIVE_INFINITY,
  );
});

test('a step asks for the model maximum while the limit can pay for it', () => {
  // A cheap model: $1 buys far more output than the model can produce.
  assert.deepEqual(
    stepAllowance({
      limitUsd: 1,
      spentUsd: 0.2,
      nextInputTokens: 10_000,
      pricing: { prompt: 0.1e-6, completion: 0.4e-6 },
      modelMaxOutputTokens: 32_768,
    }),
    { proceed: true, maxOutputTokens: 32_768 },
  );
});

test('a step asks for less output as the limit runs down', () => {
  assert.deepEqual(
    stepAllowance({ limitUsd: 5, spentUsd: 1, nextInputTokens: 100_000, pricing, modelMaxOutputTokens: 128_000 }),
    { proceed: true, maxOutputTokens: 80_000 },
  );
});

test('the run stops when the limit is spent or cannot cover a useful step', () => {
  assert.deepEqual(
    stepAllowance({ limitUsd: 5, spentUsd: 5, nextInputTokens: 0, pricing, modelMaxOutputTokens: 128_000 }),
    { proceed: false },
  );
  // $0.90 left, $0.80 of it needed for input: 2,500 output tokens is below the floor.
  const short = { limitUsd: 5, spentUsd: 4.1, nextInputTokens: 100_000, pricing };
  assert.ok(affordableOutputTokens(short) < MIN_STEP_OUTPUT_TOKENS);
  assert.deepEqual(stepAllowance({ ...short, modelMaxOutputTokens: 128_000 }), { proceed: false });
  assert.deepEqual(stepAllowance({ ...short, modelMaxOutputTokens: undefined }), { proceed: false });
});

test('a limit still stops an unpriced model on reported cost, without sizing steps', () => {
  const unpriced = { limitUsd: 5, nextInputTokens: 100_000, pricing: null, modelMaxOutputTokens: 64_000 };
  assert.deepEqual(stepAllowance({ ...unpriced, spentUsd: 4.99 }), { proceed: true, maxOutputTokens: 64_000 });
  assert.deepEqual(stepAllowance({ ...unpriced, spentUsd: 5.01 }), { proceed: false });
});

test('a model without a known maximum is never sent a computed one', () => {
  assert.deepEqual(
    stepAllowance({ limitUsd: 5, spentUsd: 1, nextInputTokens: 100_000, pricing, modelMaxOutputTokens: undefined }),
    { proceed: true },
  );
});

test('the next input is what the last step read plus what it wrote', () => {
  assert.equal(nextInputTokensAfter({ inputTokens: 40_000, outputTokens: 1_500 }), 41_500);
  assert.equal(nextInputTokensAfter({ inputTokens: 40_000 }), 40_000);
  assert.equal(nextInputTokensAfter({ outputTokens: 10 }), undefined);
  assert.equal(nextInputTokensAfter(undefined), undefined);
  assert.equal(estimateFirstInputTokens('a'.repeat(300), 'b'.repeat(300)), 2_200);
});

test('tool results after the last assistant message count toward the next input', () => {
  const messages = [
    { role: 'user', content: 'x'.repeat(9_000) },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'run_command', input: {} }] },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'a',
        toolName: 'run_command',
        output: { type: 'json', value: { stdout: { text: 'y'.repeat(48_000) }, exitCode: 0 } },
      }],
    },
  ];
  // Only the tool message counts: 48,000 characters of output is 16,000 tokens, plus its small labels.
  const appended = estimateAppendedTokens(messages);
  assert.ok(appended >= 16_000 && appended < 16_100, String(appended));
  // With $0.50 left, 11,000 known input tokens alone would allow 10,300 output tokens, and the
  // uncounted tool result would push that request past the limit. Counting it keeps the request inside.
  const tight = { limitUsd: 5, spentUsd: 4.5, pricing, modelMaxOutputTokens: 128_000 };
  assert.deepEqual(stepAllowance({ ...tight, nextInputTokens: 11_000 }), { proceed: true, maxOutputTokens: 10_300 });
  const nextInputTokens = 11_000 + appended;
  const sized = stepAllowance({ ...tight, nextInputTokens });
  assert.ok(sized.proceed && sized.maxOutputTokens !== undefined && sized.maxOutputTokens < 10_300);
  const worstCaseUsd = nextInputTokens * pricing.prompt + sized.maxOutputTokens * pricing.completion;
  assert.ok(worstCaseUsd <= 0.5, String(worstCaseUsd));
});

test('an image result counts as a fixed size, not by its base64 length', () => {
  const image = {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'b',
      toolName: 'view_image',
      output: {
        type: 'content',
        value: [
          { type: 'text', text: 'abc' },
          { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'A'.repeat(130_000) } },
        ],
      },
    }],
  };
  const appended = estimateAppendedTokens([{ role: 'assistant', content: 'look' }, image]);
  assert.ok(appended >= 2_000 && appended < 2_100, String(appended));
  assert.equal(estimateAppendedTokens([{ role: 'assistant', content: 'done' }]), 0);
});

test('a run is refused when the key has less left than it may spend', () => {
  // A key without a limit reports nothing to compare against.
  assert.equal(startBlocker(null, 5), undefined);
  assert.equal(startBlocker(undefined, undefined), undefined);
  assert.equal(startBlocker(12.5, 5), undefined);
  assert.equal(startBlocker(5, 5), undefined);
  assert.equal(startBlocker(0.4, undefined), undefined);
  assert.match(startBlocker(4.63, 5) ?? '', /\$4\.63 left.*limits\.costUsd \(\$5\.00\)/);
  assert.match(startBlocker(0, undefined) ?? '', /no credit left/);
  assert.match(startBlocker(-0.2, 5) ?? '', /no credit left/);
});
