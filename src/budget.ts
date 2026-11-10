import type { TokenPricing } from './models.js';

/**
 * Fewest output tokens a step must be able to afford. Below this the model would
 * be cut off before it could do anything useful, so the run stops instead.
 */
export const MIN_STEP_OUTPUT_TOKENS = 4096;

export type StepAllowance =
  /** Send the step. `maxOutputTokens` is absent when the request should not set one. */
  | { proceed: true; maxOutputTokens?: number }
  /** The cost limit cannot cover another step. */
  | { proceed: false };

export type StepAllowanceInput = {
  /** `limits.costUsd`, or undefined when the run has no cost limit. */
  limitUsd: number | undefined;
  spentUsd: number;
  /** Estimated input tokens of the step about to be sent. */
  nextInputTokens: number;
  pricing: TokenPricing | null | undefined;
  /** The model's own output ceiling from the catalog, if it reports one. */
  modelMaxOutputTokens: number | undefined;
};

/**
 * Output tokens the rest of the cost limit can pay for, after setting aside the
 * next step's input at the full input price. Infinite when output is free.
 */
export function affordableOutputTokens(input: {
  limitUsd: number;
  spentUsd: number;
  nextInputTokens: number;
  pricing: TokenPricing;
}): number {
  if (!(input.pricing.completion > 0)) return Number.POSITIVE_INFINITY;
  const remainingUsd = input.limitUsd - input.spentUsd - input.nextInputTokens * input.pricing.prompt;
  return Math.max(0, Math.floor(remainingUsd / input.pricing.completion));
}

/**
 * Decide whether the next step may be sent and how many output tokens it may ask for.
 *
 * Without a cost limit the model's own maximum is used, as before. With one, the
 * request asks for no more output than the limit can still pay for. That keeps a
 * run inside its limit and shrinks the credit OpenRouter holds while a request is
 * in flight, which is the input plus the full `max_tokens`.
 */
export function stepAllowance(input: StepAllowanceInput): StepAllowance {
  const modelMax = input.modelMaxOutputTokens;
  const unsized: StepAllowance = modelMax === undefined
    ? { proceed: true }
    : { proceed: true, maxOutputTokens: modelMax };
  if (input.limitUsd === undefined) return unsized;
  if (input.spentUsd >= input.limitUsd) return { proceed: false };
  // No usable price: the limit can still stop the run on reported cost, but not size a step.
  if (!input.pricing) return unsized;

  const affordable = affordableOutputTokens({
    limitUsd: input.limitUsd,
    spentUsd: input.spentUsd,
    nextInputTokens: input.nextInputTokens,
    pricing: input.pricing,
  });
  if (affordable < MIN_STEP_OUTPUT_TOKENS) return { proceed: false };
  // Without a known model maximum, a computed value could exceed what the provider accepts.
  if (modelMax === undefined) return unsized;
  return { proceed: true, maxOutputTokens: Math.min(modelMax, affordable) };
}

/** Rough input size of a run's first request, before any usage has been reported. */
export function estimateFirstInputTokens(systemPrompt: string, taskPrompt: string): number {
  const TOOL_SCHEMA_TOKENS = 2000;
  return Math.ceil((systemPrompt.length + taskPrompt.length) / 3) + TOOL_SCHEMA_TOKENS;
}

/**
 * Input size of the step after the one that reported `usage`: what it read plus
 * what it wrote, since both are sent back. Undefined when usage has no token counts.
 */
export function nextInputTokensAfter(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const { inputTokens, outputTokens } = usage as { inputTokens?: unknown; outputTokens?: unknown };
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return undefined;
  const output = typeof outputTokens === 'number' && Number.isFinite(outputTokens) ? outputTokens : 0;
  return inputTokens + output;
}

/**
 * Reason a run must not start, given what the key has left and the run's cost limit.
 * Undefined when the run may start. `keyRemainingUsd` is null for a key without a
 * limit: OpenRouter does not show an ordinary key the account balance, so there is
 * nothing to compare against.
 */
export function startBlocker(
  keyRemainingUsd: number | null | undefined,
  limitUsd: number | undefined,
): string | undefined {
  if (keyRemainingUsd == null) return undefined;
  if (keyRemainingUsd <= 0) {
    return 'The OpenRouter key has no credit left under its limit. Raise the key limit or wait for it to reset.';
  }
  if (limitUsd !== undefined && keyRemainingUsd < limitUsd) {
    return `The OpenRouter key has $${keyRemainingUsd.toFixed(2)} left under its limit, less than limits.costUsd ($${limitUsd.toFixed(2)}). Raise the key limit or lower limits.costUsd.`;
  }
  return undefined;
}
