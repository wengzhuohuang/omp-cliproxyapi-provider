import { describe, expect, test } from "bun:test";
import {
	CPA_COMPAT,
	DEFAULT_CONTEXT_WINDOW,
	extractReasoningEfforts,
	mapCatalogModel,
	mapReasoningEfforts,
	supportsFastServiceTier,
	toProviderModelConfig,
	type CpaCatalogModel,
} from "../src/mapping.ts";

const SOL: CpaCatalogModel = {
	slug: "gpt-6.1-sol",
	display_name: "GPT 6.1 Sol",
	context_window: 872000,
	max_tokens: 128000,
	input_modalities: ["text", "image"],
	supported_reasoning_levels: [
		{ effort: "low" },
		{ effort: "medium" },
		{ effort: "high" },
		{ effort: "xhigh" },
		{ effort: "max" },
		{ effort: "ultra" },
	],
	default_reasoning_level: "low",
	service_tiers: [{ id: "priority", name: "Fast" }],
};

describe("mapReasoningEfforts", () => {
	test("keeps canonical levels in ladder order", () => {
		const { efforts } = mapReasoningEfforts(["high", "low", "xhigh"]);
		expect(efforts.map((effort) => String(effort))).toEqual(["low", "high", "xhigh"]);
	});

	test("folds the extra ultra level onto the top rung", () => {
		const { efforts, effortMap } = mapReasoningEfforts(["low", "ultra"]);
		expect(efforts.map((effort) => String(effort))).toEqual(["low", "max"]);
		expect(effortMap).toEqual({ max: "ultra" });
	});

	test("a natively supported level wins over an aliased one", () => {
		const { efforts, effortMap } = mapReasoningEfforts(["low", "max", "ultra"]);
		expect(efforts.map((effort) => String(effort))).toEqual(["low", "max"]);
		expect(effortMap).toBeUndefined();
	});

	test("drops the off level and unknown levels", () => {
		const { efforts } = mapReasoningEfforts(["none", "low", "turbo"]);
		expect(efforts.map((effort) => String(effort))).toEqual(["low"]);
	});
});

describe("mapCatalogModel", () => {
	test("maps a codex catalog entry", () => {
		const model = mapCatalogModel(SOL);
		expect(model).not.toBeNull();
		expect(model?.id).toBe("gpt-6.1-sol");
		expect(model?.name).toBe("GPT 6.1 Sol");
		expect(model?.contextWindow).toBe(872000);
		expect(model?.maxTokens).toBe(128000);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
		expect(model?.fastCapable).toBe(true);
		expect(model?.thinking?.mode).toBe("effort");
		expect(model?.thinking?.defaultLevel && String(model?.thinking?.defaultLevel)).toBe("low");
	});

	test("falls back to a default context window", () => {
		const model = mapCatalogModel({ slug: "mystery" });
		expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(model?.reasoning).toBe(false);
		expect(model?.thinking).toBeUndefined();
	});

	test("skips hidden models and entries without an id", () => {
		expect(mapCatalogModel({ slug: "hidden-model", visibility: "hide" })).toBeNull();
		expect(mapCatalogModel({ display_name: "no id" })).toBeNull();
	});

	test("always exposes text input", () => {
		expect(mapCatalogModel({ slug: "image-only", input_modalities: ["image"] })?.input).toEqual([
			"text",
			"image",
		]);
	});
});

describe("catalog helpers", () => {
	test("reads plain and nested effort levels", () => {
		expect(extractReasoningEfforts({ supported_reasoning_levels: ["low", { effort: "high" }] })).toEqual([
			"low",
			"high",
		]);
	});

	test("detects advertised service tiers", () => {
		expect(supportsFastServiceTier({ service_tiers: [{ id: "priority" }] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [] })).toBe(false);
		expect(supportsFastServiceTier({})).toBe(false);
	});
});

describe("toProviderModelConfig", () => {
	test("produces a registration-ready model", () => {
		const model = mapCatalogModel(SOL);
		const config = toProviderModelConfig(model!);
		expect(config.id).toBe("gpt-6.1-sol");
		expect(config.api).toBe("openai-responses");
		expect(config.reasoning).toBe(true);
		expect(config.contextWindow).toBe(872000);
		expect(config.compat).toMatchObject(CPA_COMPAT);
	});
});
