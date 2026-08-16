import assert from 'node:assert/strict';
import test from 'node:test';
import { usageCost } from '../src/usage.js';

test('reads OpenRouter usage.raw.cost and treats missing values as 0', () => {
  assert.equal(usageCost({ raw: { cost: 0.0123 } }), 0.0123);
  assert.equal(usageCost({ raw: { cost: 0 } }), 0);
  assert.equal(usageCost({ raw: { cost: -0.001 } }), -0.001);
  assert.equal(usageCost({ inputTokens: 12, outputTokens: 7, totalTokens: 19 }), 0);
  assert.equal(usageCost({ raw: { total_tokens: 19 } }), 0);
  assert.equal(usageCost({ raw: { cost: '0.0123' } }), 0);
  assert.equal(usageCost({ raw: { cost: Number.NaN } }), 0);
  assert.equal(usageCost({ raw: { cost: Number.POSITIVE_INFINITY } }), 0);
  assert.equal(usageCost(undefined), 0);
  assert.equal(usageCost(null), 0);
});

test('sums reported step costs without deriving a price from tokens', () => {
  const steps = [
    { usage: { raw: { cost: 0.25 }, inputTokens: 100 } },
    { usage: { inputTokens: 50 } },
    { usage: { raw: { cost: 0.5 } } },
  ];
  assert.equal(steps.reduce((total, step) => total + usageCost(step.usage), 0), 0.75);
});
