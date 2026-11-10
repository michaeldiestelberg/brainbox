import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_APP_URL = 'https://productized.tech';
export const OPENROUTER_APP_TITLE = 'brainbox';

const keyInfoSchema = z
  .object({
    data: z
      .object({
        label: z.string().optional(),
        limit_remaining: z.number().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export function requireOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it to .env.local next to your config file.');
  }
  return apiKey;
}

export function createBbxOpenRouter(): OpenRouterProvider {
  return createOpenRouter({
    apiKey: requireOpenRouterApiKey(),
    headers: {
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-Title': OPENROUTER_APP_TITLE,
    },
    compatibility: 'strict',
  });
}

/**
 * Model settings that switch on prompt caching for providers that only cache on request.
 *
 * Most providers cache a repeated prompt prefix on their own. Anthropic does not: without
 * `cache_control` every step of a run is billed the whole conversation again at the full
 * input price. A top-level `cache_control` makes Anthropic cache up to the last block of
 * each request and move that point forward as the conversation grows. It changes what a
 * run costs, not what the model sees.
 */
export function promptCachingSettings(modelId: string): { cache_control?: { type: 'ephemeral' } } {
  return modelId.startsWith('anthropic/') ? { cache_control: { type: 'ephemeral' } } : {};
}

export type OpenRouterKeyInfo = {
  label?: string;
  /** USD left under the key's own limit, or null when the key has no limit. */
  limitRemaining: number | null;
};

export async function fetchOpenRouterKeyInfo(apiKey: string, signal?: AbortSignal): Promise<OpenRouterKeyInfo> {
  const response = await fetch(`${OPENROUTER_API_BASE}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter key check returned HTTP ${response.status}.`);
  }
  const { data } = keyInfoSchema.parse(await response.json());
  return {
    ...(data.label === undefined ? {} : { label: data.label }),
    limitRemaining: data.limit_remaining ?? null,
  };
}

export async function validateOpenRouterKey(apiKey: string, signal?: AbortSignal): Promise<string> {
  const { limitRemaining } = await fetchOpenRouterKeyInfo(apiKey, signal);
  if (limitRemaining == null) return 'OPENROUTER_API_KEY is valid';
  return `OPENROUTER_API_KEY is valid (${limitRemaining} credits remaining)`;
}
