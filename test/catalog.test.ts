import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ModelsHttpError,
	fetchCpaCatalog,
	isUnauthorizedModelsError,
	loadCatalogCache,
	mergeCatalogWithExistingCache,
	saveCatalogCache,
} from "../src/catalog.ts";
import type { MappedCatalog, MappedModel } from "../src/mapping.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function model(id: string, overrides: Partial<MappedModel> = {}): MappedModel {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {},
		fastCapable: false,
		...overrides,
	};
}

describe("fetchCpaCatalog", () => {
	test("reads the models array", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }), { status: 200 })) as unknown as typeof fetch;
		const entries = await fetchCpaCatalog("http://proxy/v1/models", "key");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.slug).toBe("gpt-6.1-sol");
	});

	test("accepts an OpenAI-style data array", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }] }), { status: 200 })) as unknown as typeof fetch;
		const entries = await fetchCpaCatalog("http://proxy/v1/models", "key");
		expect(entries[0]?.id).toBe("gpt-6.1-sol");
	});

	test("treats an empty catalog as success", async () => {
		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		expect(await fetchCpaCatalog("http://proxy/v1/models", "key")).toEqual([]);
	});

	test("reports a 401 as an unauthorized models error", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const error = await fetchCpaCatalog("http://proxy/v1/models", "key").catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ModelsHttpError);
		expect(isUnauthorizedModelsError(error)).toBe(true);
	});
});

describe("catalog cache", () => {
	test("round-trips through the agent directory", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "omp-cliproxyapi-cache-"));
		try {
			const catalog: MappedCatalog = {
				models: [model("gpt-6.1-sol")],
				fastModelIds: ["gpt-6.1-sol"],
				inferenceBaseUrl: "http://127.0.0.1:8317/v1",
				modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=omp",
			};
			await saveCatalogCache(agentDir, catalog);
			const loaded = await loadCatalogCache(agentDir, "http://127.0.0.1:8317");
			expect(loaded?.models[0]?.id).toBe("gpt-6.1-sol");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("ignores a cache recorded for another base URL", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "omp-cliproxyapi-cache-"));
		try {
			await saveCatalogCache(agentDir, {
				models: [model("gpt-6.1-sol")],
				fastModelIds: [],
				inferenceBaseUrl: "http://127.0.0.1:8317/v1",
				modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=omp",
			});
			expect(await loadCatalogCache(agentDir, "http://other:8317")).toBeNull();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("mergeCatalogWithExistingCache", () => {
	const fresh: MappedCatalog = {
		models: [model("kept")],
		fastModelIds: [],
		inferenceBaseUrl: "http://127.0.0.1:8317/v1",
		modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=omp",
	};

	test("retains a model that vanished from the upstream listing", () => {
		const now = 1_000_000;
		const existing = {
			...fresh,
			models: [model("kept"), model("vanished")],
			fetchedAt: now,
		};
		const result = mergeCatalogWithExistingCache(existing, fresh, now);
		expect(result.merged.models.map((entry) => entry.id).sort()).toEqual(["kept", "vanished"]);
		expect(result.retainedStaleModels[0]?.stale).toBe(true);
	});

	test("drops a model that stayed missing for the whole retention window", () => {
		const now = 1_000_000;
		const existing = {
			...fresh,
			models: [model("vanished", { stale: true, staleSince: now - 8 * 24 * 60 * 60 * 1000 })],
			fetchedAt: now,
		};
		const result = mergeCatalogWithExistingCache(existing, fresh, now);
		expect(result.merged.models.map((entry) => entry.id)).toEqual(["kept"]);
		expect(result.droppedModelIds).toEqual(["vanished"]);
	});
});
