/** OpenRouter's reported USD cost for one model call, or 0 when the provider omitted it. */
export function usageCost(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const raw = (usage as { raw?: unknown }).raw;
  if (!raw || typeof raw !== 'object') return 0;
  const cost = (raw as { cost?: unknown }).cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}
