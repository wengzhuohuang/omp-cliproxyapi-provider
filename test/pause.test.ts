import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfigFile } from "../src/config.ts";
import { PauseController, readPauseSetting } from "../src/pause.ts";

const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
	savedEnv.set("CLIPROXYAPI_BASE_URL", process.env.CLIPROXYAPI_BASE_URL);
	delete process.env.CLIPROXYAPI_BASE_URL;
});

afterAll(() => {
	const value = savedEnv.get("CLIPROXYAPI_BASE_URL");
	if (value === undefined) {
		delete process.env.CLIPROXYAPI_BASE_URL;
	} else {
		process.env.CLIPROXYAPI_BASE_URL = value;
	}
});

async function withTempAgentDir<T>(run: (agentDir: string) => T | Promise<T>): Promise<T> {
	const agentDir = mkdtempSync(join(tmpdir(), "omp-cliproxyapi-pause-"));
	try {
		return await run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("readPauseSetting", () => {
	test("defaults to false without a config file", async () => {
		await withTempAgentDir(async (agentDir) => {
			expect(await readPauseSetting(agentDir)).toBe(false);
		});
	});

	test("reads the persisted preference", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { pause: true });
			expect(await readPauseSetting(agentDir)).toBe(true);
		});
	});

	test("keeps the current state when the file cannot be read", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { pause: "yes" as unknown as boolean });
			expect(await readPauseSetting(agentDir, true)).toBe(true);
		});
	});
});

describe("PauseController", () => {
	test("tracks the enabled state", () => {
		const controller = new PauseController(false);
		expect(controller.isEnabled()).toBe(false);
		controller.setEnabled(true);
		expect(controller.isEnabled()).toBe(true);
	});
});
