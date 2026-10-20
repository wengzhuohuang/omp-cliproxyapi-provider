import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_FILE_NAME,
	DEFAULT_BASE_URL,
	parseBooleanSetting,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolvePauseDefault,
	saveConfigFile,
} from "../src/config.ts";

/** The plugin reads these from the environment, so the tests must not inherit them. */
const ENV_KEYS = [
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PAUSE",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

async function withTempAgentDir<T>(run: (agentDir: string) => T | Promise<T>): Promise<T> {
	const agentDir = mkdtempSync(join(tmpdir(), "omp-cliproxyapi-test-"));
	try {
		return await run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

describe("resolveEndpoints", () => {
	test("adds a scheme and the /v1 suffix", async () => {
		const endpoints = resolveEndpoints("127.0.0.1:8317");
		expect(endpoints.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(endpoints.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=omp");
	});

	test("keeps an explicit /v1 path", async () => {
		expect(resolveEndpoints("http://192.168.30.21:8317/v1").inferenceBaseUrl).toBe(
			"http://192.168.30.21:8317/v1",
		);
	});

	test("rewrites the codex backend path to the responses path", async () => {
		expect(resolveEndpoints("http://127.0.0.1:8317/backend-api").inferenceBaseUrl).toBe(
			"http://127.0.0.1:8317/v1",
		);
	});

	test("accepts a full model-list URL", async () => {
		expect(resolveEndpoints("http://127.0.0.1:8317/v1/models").inferenceBaseUrl).toBe(
			"http://127.0.0.1:8317/v1",
		);
	});

	test("rejects an empty base URL", async () => {
		expect(() => resolveEndpoints("  ")).toThrow();
	});
});

describe("parseBooleanSetting", () => {
	test("accepts the documented spellings", async () => {
		for (const value of ["1", "true", "yes", "on", "TRUE"]) {
			expect(parseBooleanSetting(value)).toBe(true);
		}
		for (const value of ["0", "false", "no", "off"]) {
			expect(parseBooleanSetting(value)).toBe(false);
		}
		expect(parseBooleanSetting("maybe")).toBeUndefined();
	});
});

describe("resolveConnection", () => {
	test("returns null without any credential", async () => {
		await withTempAgentDir(async (agentDir) => {
			const previous = process.env.CLIPROXYAPI_API_KEY;
			delete process.env.CLIPROXYAPI_API_KEY;
			try {
				expect(await resolveConnection(agentDir)).toBeNull();
			} finally {
				if (previous !== undefined) process.env.CLIPROXYAPI_API_KEY = previous;
			}
		});
	});

	test("reads the key from the config file", async () => {
		await withTempAgentDir(async (agentDir) => {
			const previous = process.env.CLIPROXYAPI_API_KEY;
			delete process.env.CLIPROXYAPI_API_KEY;
			try {
				await saveConfigFile(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "secret" });
				const connection = await resolveConnection(agentDir);
				expect(connection?.apiKey).toBe("secret");
				expect(connection?.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
				expect(connection?.apiKeyEnvName).toBeUndefined();
			} finally {
				if (previous !== undefined) process.env.CLIPROXYAPI_API_KEY = previous;
			}
		});
	});

	test("prefers the environment and reports the variable name", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { apiKey: "from-file" });
			process.env.CLIPROXYAPI_API_KEY = "from-env";
			try {
				const connection = await resolveConnection(agentDir);
				expect(connection?.apiKey).toBe("from-env");
				expect(connection?.apiKeyEnvName).toBe("CLIPROXYAPI_API_KEY");
			} finally {
				delete process.env.CLIPROXYAPI_API_KEY;
			}
		});
	});
});

describe("config file", () => {
	test("merges writes instead of replacing them", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { baseUrl: "http://127.0.0.1:8317" });
			await saveConfigFile(agentDir, { apiKey: "secret" });
			const connection = await resolveConnection(agentDir);
			expect(connection?.baseUrlInput).toBe("http://127.0.0.1:8317");
			expect(connection?.apiKey).toBe("secret");
		});
	});

	test("reports a missing file as an empty config", async () => {
		await withTempAgentDir(async (agentDir) => {
			expect(await resolveFastDefault(agentDir)).toBe(false);
			expect(await resolvePauseDefault(agentDir)).toBe(false);
		});
	});
});

describe("identity", () => {
	test("defaults to the cliproxyapi provider id", async () => {
		await withTempAgentDir(async (agentDir) => {
			const previousId = process.env.CLIPROXYAPI_PROVIDER_ID;
			delete process.env.CLIPROXYAPI_PROVIDER_ID;
			try {
				const identity = await resolveIdentity(agentDir);
				expect(identity.providerId).toBe("cliproxyapi");
				expect(identity.providerName).toBe("CLIProxyAPI");
			} finally {
				if (previousId !== undefined) process.env.CLIPROXYAPI_PROVIDER_ID = previousId;
			}
		});
	});

	test("reads the provider id from the config file", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { providerId: "cpa" });
			expect((await resolveIdentity(agentDir)).providerId).toBe("cpa");
		});
	});
});

describe("fast and pause preferences", () => {
	test("environment wins over the config file", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { fast: false });
			process.env.CLIPROXYAPI_FAST = "true";
			try {
				expect(await resolveFastDefault(agentDir)).toBe(true);
			} finally {
				delete process.env.CLIPROXYAPI_FAST;
			}
		});
	});

	test("the config file wins over the default", async () => {
		await withTempAgentDir(async (agentDir) => {
			await saveConfigFile(agentDir, { fast: true, pause: true });
			expect(await resolveFastDefault(agentDir)).toBe(true);
			expect(await resolvePauseDefault(agentDir)).toBe(true);
		});
	});

	test("an invalid environment value is rejected", async () => {
		await withTempAgentDir(async (agentDir) => {
			process.env.CLIPROXYAPI_FAST = "sometimes";
			try {
				await expect(resolveFastDefault(agentDir)).rejects.toThrow();
			} finally {
				delete process.env.CLIPROXYAPI_FAST;
			}
		});
	});
});

test("the config file name matches the documented one", async () => {
	expect(CONFIG_FILE_NAME).toBe("cliproxyapi.json");
	expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8317");
});
