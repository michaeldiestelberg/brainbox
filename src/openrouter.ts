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

export async function validateOpenRouterKey(apiKey: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${OPENROUTER_API_BASE}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter key check returned HTTP ${response.status}.`);
  }
  const parsed = keyInfoSchema.parse(await response.json());
  const remaining = parsed.data.limit_remaining;
  if (remaining == null) return 'OPENROUTER_API_KEY is valid';
  return `OPENROUTER_API_KEY is valid (${remaining} credits remaining)`;
}
