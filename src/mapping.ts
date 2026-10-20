/**
 * Mapping from a CLIProxyAPI catalog entry to an omp model.
 *
 * CLIProxyAPI publishes a Codex-style catalog (reasoning levels, service tiers,
 * context window, modalities). omp models describe the same capabilities with
 * `thinking.efforts` / `thinking.effortMap` and the canonical `Effort` ladder,
 * so the wire levels need an explicit translation.
 */

import { THINKING_EFFORTS, type Model } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type ModelInput = "text" | "image";

/** One CLIProxyAPI catalog entry (only the fields the plugin reads). */
export interface CpaCatalogModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	context_window?: number;
	max_context_window?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: Array<string | { effort?: string }>;
	default_reasoning_level?: string;
	service_tiers?: Array<{ id?: string; name?: string } | string>;
	visibility?: string;
}

/** A model resolved for omp registration. */
export interface MappedModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: Model["thinking"];
	input: ModelInput[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	compat: Record<string, unknown>;
	/** CLIProxyAPI advertises a service tier for this model, so Fast applies. */
	fastCapable: boolean;
	/** Set when the model disappeared from the upstream catalog but is still retained. */
	stale?: boolean;
	/** Timestamp of the last catalog that listed this model. */
	lastSeenAt?: number;
	/** Timestamp of the first catalog that stopped listing this model. */
	staleSince?: number;
}

export interface MappedCatalog {
	models: MappedModel[];
	fastModelIds: string[];
	inferenceBaseUrl: string;
	modelsUrl: string;
}

/**
 * Compatibility overrides applied to every CLIProxyAPI model.
 *
 * The proxy is not an official OpenAI endpoint, so the host's OpenAI defaults
 * (stateful chaining, developer role, strict tool schemas, encrypted reasoning
 * replay) are switched off to keep requests replay-safe.
 */
export const CPA_COMPAT: Record<string, unknown> = {
	supportsStore: true,
	statefulResponses: false,
	supportsDeveloperRole: false,
	supportsStrictMode: false,
	supportsReasoningEffort: true,
	includeEncryptedReasoning: false,
};

const EXTRA_EFFORT_ALIASES: Record<string, string> = {
	// CLIProxyAPI exposes an `ultra` level above omp's `max` rung.
	ultra: "max",
};

export function catalogModelId(model: CpaCatalogModel): string {
	return (model.slug ?? model.id ?? "").trim();
}

export function extractReasoningEfforts(model: CpaCatalogModel): string[] {
	const raw = model.supported_reasoning_levels ?? [];
	const efforts: string[] = [];
	for (const entry of raw) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (!normalized || efforts.includes(normalized)) continue;
		efforts.push(normalized);
	}
	return efforts;
}

/**
 * Translate wire effort levels into omp's canonical ladder.
 *
 * Levels omp does not know are dropped; a level above the ladder (`ultra`) is
 * folded onto the top rung and kept reachable through `effortMap`.
 */
export function mapReasoningEfforts(wireEfforts: string[]): {
	efforts: Model["thinking"] extends undefined ? never : NonNullable<Model["thinking"]>["efforts"];
	effortMap?: Record<string, string>;
} {
	const native = new Set<string>();
	const aliases = new Map<string, string>();

	for (const wire of wireEfforts) {
		if (wire === "none" || wire === "off") continue;
		const known = THINKING_EFFORTS.find((effort) => effort === wire);
		if (known) {
			native.add(known);
			continue;
		}
		const alias = EXTRA_EFFORT_ALIASES[wire];
		if (alias) {
			aliases.set(alias, wire);
		}
	}

	const canonical = new Set(native);
	const effortMap: Record<string, string> = {};
	for (const [level, wire] of aliases) {
		// A natively supported level always wins over an aliased one.
		if (native.has(level)) continue;
		canonical.add(level);
		effortMap[level] = wire;
	}

	const efforts = THINKING_EFFORTS.filter((effort) => canonical.has(effort));
	return Object.keys(effortMap).length > 0 ? { efforts, effortMap } : { efforts };
}

export function buildInputModalities(model: CpaCatalogModel): ModelInput[] {
	const raw = model.input_modalities ?? [];
	const input: ModelInput[] = [];
	for (const modality of raw) {
		const value = String(modality).trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}
	if (!input.includes("text")) {
		input.unshift("text");
	}
	return input;
}

export function supportsFastServiceTier(model: CpaCatalogModel): boolean {
	return Array.isArray(model.service_tiers) && model.service_tiers.length > 0;
}

function positiveNumber(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

/** Map one catalog entry to a model, or `null` when the entry is not usable. */
export function mapCatalogModel(model: CpaCatalogModel): MappedModel | null {
	const id = catalogModelId(model);
	if (!id) {
		return null;
	}
	if (String(model.visibility ?? "").toLowerCase() === "hide") {
		return null;
	}

	const wireEfforts = extractReasoningEfforts(model);
	const { efforts, effortMap } = mapReasoningEfforts(wireEfforts);
	const reasoning = efforts.length > 0;

	const contextWindow =
		positiveNumber(model.context_window, model.max_context_window) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens =
		positiveNumber(model.max_tokens, model.max_output_tokens, model.max_completion_tokens) ?? DEFAULT_MAX_TOKENS;

	const defaultLevel = model.default_reasoning_level?.trim().toLowerCase();
	const defaultEffort = efforts.find((effort) => effort === defaultLevel);

	return {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning,
		thinking: reasoning
			? {
					mode: "effort",
					efforts,
					...(defaultEffort ? { defaultLevel: defaultEffort } : {}),
					...(effortMap ? { effortMap } : {}),
				}
			: undefined,
		input: buildInputModalities(model),
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens,
		compat: { ...CPA_COMPAT },
		fastCapable: supportsFastServiceTier(model),
	};
}

/** Convert a mapped model into the shape omp's provider registration expects. */
export function toProviderModelConfig(model: MappedModel): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		api: "openai-responses",
		reasoning: model.reasoning,
		...(model.thinking ? { thinking: model.thinking } : {}),
		input: model.input,
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat as ProviderModelConfig["compat"],
	};
}
