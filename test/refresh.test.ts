import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";

test("manual refresh replaces removed models and updates the persisted catalog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cpa-refresh-"));
	const previous = { ...process.env };
	const realFetch = globalThis.fetch;
	let ids = ["old"];
	let config: ProviderConfig | undefined;
	let refresh: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let hostModels: string[] = [];
	const notifications: string[] = [];
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.CLIPROXYAPI_BASE_URL = "http://localhost:8317";
		mock.module("@oh-my-pi/pi-ai", () => ({ THINKING_EFFORTS: ["minimal", "low", "medium", "high", "xhigh"] }));
		mock.module("@oh-my-pi/pi-coding-agent", () => ({ getAgentDir: () => dir }));
		// Load after mocking the host module: its native addon is unavailable in this test runtime.
		const { loadCatalogCache } = await import("../src/catalog.ts");
		const { default: extension } = await import("../src/cliproxyapi.ts");
		process.env.CLIPROXYAPI_API_KEY = "test-key";
		globalThis.fetch = (async () => Response.json({ data: ids.map(id => ({ id })) })) as unknown as typeof fetch;
		const pi = {
			registerProvider: (_id: string, next: ProviderConfig) => { config = next; },
			unregisterProvider: () => { config = undefined; hostModels = []; },
			registerCommand: (name: string, command: { handler: typeof refresh }) => {
				if (name === "cliproxyapi-refresh") refresh = command.handler;
			},
			on: () => {},
		} as unknown as ExtensionAPI;
		await extension(pi);
		expect(config?.models?.map(model => model.id)).toEqual(["old"]);
		ids = ["new"];
		const ctx = {
			ui: { notify: (message: string) => notifications.push(message) },
			modelRegistry: { refreshDiscoverableProviders: async () => {
				hostModels = (await config!.fetchDynamicModels!("test-key")).map(model => model.id);
			} },
		} as unknown as ExtensionContext;
		await refresh!("", ctx);
		expect(config?.models?.map(model => model.id)).toEqual(["new"]);
		expect((await loadCatalogCache(dir, "http://localhost:8317"))?.models.map(model => model.id)).toEqual(["new"]);
		expect(notifications.at(-1)).toContain("1 model(s)");
		expect(hostModels).toEqual(["new"]);
		globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
		await refresh!("", ctx);
		expect(config?.models?.map(model => model.id)).toEqual(["new"]);
		expect((await loadCatalogCache(dir, "http://localhost:8317"))?.models.map(model => model.id)).toEqual(["new"]);
		expect(notifications.at(-1)).toContain("Failed to refresh");
		globalThis.fetch = (async () => Response.json({ data: ids.map(id => ({ id })) })) as unknown as typeof fetch;
		ids = [];
		await refresh!("", ctx);
		expect(config?.models ?? []).toEqual([]);
		expect(hostModels).toEqual([]);
		expect((await loadCatalogCache(dir, "http://localhost:8317"))?.models).toEqual([]);
	} finally {
		globalThis.fetch = realFetch;
		process.env = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
