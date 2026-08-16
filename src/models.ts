import { z } from 'zod';

const reasoningOptionSchema = z
  .object({
    type: z.enum(['effort', 'toggle', 'budget_tokens']),
    values: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .passthrough();

const gatewayModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    max_tokens: z.number().int().nonnegative().nullish(),
    tags: z.array(z.string()).nullish(),
    modalities: z
      .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
      })
      .nullish(),
    reasoning_options: z.array(reasoningOptionSchema).nullish(),
  })
  .passthrough();

const catalogSchema = z.object({ data: z.array(gatewayModelSchema) });

export type GatewayModel = z.infer<typeof gatewayModelSchema>;
export const REASONING_EFFORTS = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export async function fetchModels(signal?: AbortSignal): Promise<GatewayModel[]> {
  const response = await fetch(
    'https://ai-gateway.vercel.sh/v1/models',
    signal ? { signal } : undefined,
  );
  if (!response.ok) {
    throw new Error(`AI Gateway model catalog returned HTTP ${response.status}.`);
  }
  return catalogSchema.parse(await response.json()).data;
}

export function findRunnableModel(models: GatewayModel[], modelId: string): GatewayModel {
  const model = models.find(candidate => candidate.id === modelId);
  if (!model) {
    throw new Error(`Unknown AI Gateway model: ${modelId}. Run "bbx models" to list current IDs.`);
  }
  const tags = model.tags ?? [];
  if (model.type !== 'language' || !tags.includes('tool-use')) {
    throw new Error(
      `Model ${modelId} cannot run an agent task (type=${model.type}, tool-use=${tags.includes('tool-use')}).`,
    );
  }
  return model;
}

export function getMaxOutputTokens(model: GatewayModel): number | undefined {
  return model.max_tokens === 0 || model.max_tokens == null ? undefined : model.max_tokens;
}

/** Label used in logs when the caller did not pick a reasoning level. */
export const PROVIDER_DEFAULT_LABEL = 'provider default';

export function formatReasoningLevel(effort?: ReasoningEffort): string {
  if (!effort || effort === 'provider-default') return PROVIDER_DEFAULT_LABEL;
  return effort;
}

const remappedEffortPattern = /mapped to (?:effort|thinking(?:[_ ]level)?) ["']([^"']+)["']/i;

function warningText(warning: unknown): string {
  if (!warning || typeof warning !== 'object') return '';
  const record = warning as Record<string, unknown>;
  return [record.details, record.message].filter(value => typeof value === 'string').join(' ');
}

function isReasoningWarning(warning: unknown): boolean {
  if (!warning || typeof warning !== 'object') return false;
  const record = warning as Record<string, unknown>;
  if (record.feature === 'reasoning') return true;
  return /reasoning/i.test(warningText(warning));
}

/** Mapped effort from an SDK compatibility warning, if present. */
export function remappedReasoningFromWarnings(warnings: unknown): string | undefined {
  if (!Array.isArray(warnings)) return undefined;
  for (const warning of warnings) {
    const match = warningText(warning).match(remappedEffortPattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function hasUnsupportedReasoningWarning(warnings: unknown): boolean {
  if (!Array.isArray(warnings)) return false;
  return warnings.some(warning => {
    if (!isReasoningWarning(warning)) return false;
    if (warning && typeof warning === 'object' && (warning as { type?: unknown }).type === 'unsupported') {
      return true;
    }
    return /is not supported/i.test(warningText(warning));
  });
}

/** Override from SDK warnings, or undefined when warnings do not change the level. */
export function reasoningLevelFromWarnings(warnings: unknown): string | undefined {
  const remapped = remappedReasoningFromWarnings(warnings);
  if (remapped) return remapped;
  if (hasUnsupportedReasoningWarning(warnings)) return PROVIDER_DEFAULT_LABEL;
  return undefined;
}

/**
 * Effective reasoning level after SDK warnings.
 * A remap wins; an unsupported warning falls back to the provider default.
 */
export function resolveUsedReasoningLevel(
  requested: ReasoningEffort | undefined,
  warnings: unknown,
): string {
  return reasoningLevelFromWarnings(warnings) ?? formatReasoningLevel(requested);
}

export function parseReasoningEffort(value?: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  throw new Error(`Invalid reasoning effort. Use one of: ${REASONING_EFFORTS.join(', ')}.`);
}

/** Effort values advertised by the catalog, if the model supports configurable effort. */
export function getReasoningEffortValues(model: GatewayModel): string[] | undefined {
  const effortOption = model.reasoning_options?.find(option => option.type === 'effort');
  if (!effortOption?.values?.length) return undefined;
  return effortOption.values;
}

/**
 * Human-readable reasoning controls for a model.
 * Effort levels (what `--reasoning-effort` accepts) come first; then toggle/budget.
 */
export function formatReasoningSummary(model: GatewayModel): string {
  const options = model.reasoning_options ?? [];
  if (options.length === 0) {
    return (model.tags ?? []).includes('reasoning') ? 'fixed' : '—';
  }

  const effort = options.find(option => option.type === 'effort' && option.values?.length);
  const parts: string[] = [];
  if (effort?.values?.length) {
    parts.push(effort.values.join(', '));
  }
  if (options.some(option => option.type === 'toggle')) {
    parts.push('toggle');
  }
  for (const option of options) {
    if (option.type !== 'budget_tokens') continue;
    if (option.min != null && option.max != null) {
      parts.push(`budget ${option.min}–${option.max}`);
    } else if (option.min != null) {
      parts.push(`budget ≥${option.min}`);
    } else if (option.max != null) {
      parts.push(`budget ≤${option.max}`);
    } else {
      parts.push('budget');
    }
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Prefer agent-relevant tags first so the capabilities column stays scannable. */
const CAPABILITY_TAG_ORDER = [
  'tool-use',
  'reasoning',
  'vision',
  'file-input',
  'web-search',
  'structured-output',
] as const;

export function formatCapabilityTags(tags: readonly string[] | null | undefined): string {
  if (!tags?.length) return '—';
  const rank = new Map<string, number>(CAPABILITY_TAG_ORDER.map((tag, index) => [tag, index]));
  return [...tags]
    .sort((a, b) => (rank.get(a) ?? CAPABILITY_TAG_ORDER.length) - (rank.get(b) ?? CAPABILITY_TAG_ORDER.length)
      || a.localeCompare(b))
    .join(', ');
}

export type ModelListFilters = {
  toolUse?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  /** Case-insensitive substring match against model id and name. */
  query?: string;
};

export function filterModels(models: GatewayModel[], filters: ModelListFilters = {}): GatewayModel[] {
  const query = filters.query?.trim().toLowerCase();
  return models.filter(model => {
    const tags = model.tags ?? [];
    const matchesQuery = !query
      || model.id.toLowerCase().includes(query)
      || model.name.toLowerCase().includes(query);
    return matchesQuery
      && (!filters.toolUse || tags.includes('tool-use'))
      && (!filters.vision || tags.includes('vision'))
      && (!filters.reasoning || tags.includes('reasoning'));
  });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

/** Aligned multi-column listing of models, including reasoning effort when available. */
export function formatModelsTable(models: GatewayModel[]): string {
  const headers = {
    id: 'ID',
    type: 'TYPE',
    reasoning: 'REASONING',
    tags: 'CAPABILITIES',
  } as const;

  const rows = models.map(model => ({
    id: model.id,
    type: model.type,
    reasoning: formatReasoningSummary(model),
    tags: formatCapabilityTags(model.tags),
  }));

  const widths = {
    id: Math.max(headers.id.length, ...rows.map(row => row.id.length)),
    type: Math.max(headers.type.length, ...rows.map(row => row.type.length)),
    reasoning: Math.max(headers.reasoning.length, ...rows.map(row => row.reasoning.length)),
    tags: Math.max(headers.tags.length, ...rows.map(row => row.tags.length)),
  };

  const line = (row: { id: string; type: string; reasoning: string; tags: string }) =>
    `${pad(row.id, widths.id)}  ${pad(row.type, widths.type)}  ${pad(row.reasoning, widths.reasoning)}  ${row.tags}`;

  const separator = [
    '─'.repeat(widths.id),
    '─'.repeat(widths.type),
    '─'.repeat(widths.reasoning),
    '─'.repeat(widths.tags),
  ].join('  ');

  const body = rows.length === 0
    ? '(no models match the selected filters)'
    : rows.map(line).join('\n');

  const count = `${models.length} model${models.length === 1 ? '' : 's'}`;
  return `${line(headers)}\n${separator}\n${body}\n\n${count}`;
}
