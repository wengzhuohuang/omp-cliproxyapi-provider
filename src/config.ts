/**
 * Configuration, credentials, and endpoint resolution for the CLIProxyAPI provider.
 *
 * Everything the plugin persists lives next to the other omp agent state
 * (`getAgentDir()`), so a profile switch keeps config, cache, and models apart.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const MODELS_CACHE_FILE_NAME = "cliproxyapi-models.json";

/** Client identifier sent to the proxy's model listing endpoint. */
export const CLIENT_VERSION = "omp";

export const MODELS_REQUEST_TIMEOUT_MS = 60_000;

export interface CliproxyConfigFile {
	/** CLIProxyAPI root, e.g. `http://127.0.0.1:8317`. */
	baseUrl?: string;
	/** Bearer token / CPA API key. */
	apiKey?: string;
	/** Provider id shown in `/model` (default `cliproxyapi`). */
	providerId?: string;
	/** Display name shown in `/login`. */
	providerName?: string;
	/** Persisted Fast (priority service tier) preference. */
	fast?: boolean;
	/** Persisted request-pause preference. */
	pause?: boolean;
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedEndpoints {
	/** Base URL for inference (`{root}/v1`), without trailing slash. */
	inferenceBaseUrl: string;
	/** Model listing URL (`{root}/v1/models?client_version=omp`). */
	modelsUrl: string;
	/** Origin of the proxy (`scheme://host:port`). */
	rootOrigin: string;
}

export interface ResolvedConnection {
	baseUrlInput: string;
	apiKey: string;
	/** Set when the key came from the environment, so the host can resolve it by name. */
	apiKeyEnvName?: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Normalize a user-provided proxy address into the inference and model-list endpoints.
 *
 * Accepted input: `host:port`, `http://host:port`, `http://host:port/v1`,
 * `http://host:port/backend-api`, or a full model-list URL. Inference always lands on
 * `{root}/v1` because the provider speaks the OpenAI Responses API there.
 */
export function resolveEndpoints(baseUrlInput: string): ResolvedEndpoints {
	let raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	if (!/^https?:\/\//i.test(raw)) {
		raw = `http://${raw}`;
	}

	const url = new URL(raw);
	let path = url.pathname.replace(/\/+$/, "");
	if (path.endsWith("/models")) {
		path = path.slice(0, -"/models".length);
	}
	if (path.endsWith("/backend-api")) {
		path = path.slice(0, -"/backend-api".length);
	}
	if (path === "") {
		path = "/v1";
	} else if (!path.endsWith("/v1")) {
		path = `${path}/v1`;
	}

	return {
		inferenceBaseUrl: `${url.origin}${path}`,
		modelsUrl: `${url.origin}/v1/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
		rootOrigin: url.origin,
	};
}

export async function loadConfigFile(agentDir: string): Promise<CliproxyConfigFile> {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = await Bun.file(configPath).text();
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		return parsed as CliproxyConfigFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		return {};
	}
}

export async function saveConfigFile(agentDir: string, config: CliproxyConfigFile): Promise<void> {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	await mkdir(dirname(configPath), { recursive: true });
	const existing = await loadConfigFile(agentDir);
	await Bun.write(configPath, `${JSON.stringify({ ...existing, ...config }, null, 2)}\n`);
}

export function parseBooleanSetting(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

export async function resolveIdentity(agentDir: string): Promise<ResolvedIdentity> {
	const file = await loadConfigFile(agentDir).catch(() => ({}) as CliproxyConfigFile);

	return {
		providerId: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_ID, file.providerId, DEFAULT_PROVIDER_ID)!,
		providerName: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_NAME, file.providerName, DEFAULT_PROVIDER_NAME)!,
	};
}

/** Resolve the Fast preference: env, then config file, then false. */
export async function resolveFastDefault(agentDir: string): Promise<boolean> {
	const envValue = firstNonEmpty(process.env.CLIPROXYAPI_FAST);
	if (envValue !== undefined) {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error("CLIPROXYAPI_FAST must be one of: true, false, 1, 0, yes, no, on, off");
		}
		return parsed;
	}

	const file = await loadConfigFile(agentDir);
	if (file.fast === undefined) {
		return false;
	}
	if (typeof file.fast !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "fast" must be a boolean`);
	}
	return file.fast;
}

/** Resolve the request-pause preference from the config file, defaulting to false. */
export async function resolvePauseDefault(agentDir: string): Promise<boolean> {
	const file = await loadConfigFile(agentDir);
	if (file.pause === undefined) {
		return false;
	}
	if (typeof file.pause !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "pause" must be a boolean`);
	}
	return file.pause;
}

/**
 * Resolve the active connection.
 * Priority: environment > config file (written by `/login`) > nothing configured.
 */
export async function resolveConnection(agentDir: string): Promise<ResolvedConnection | null> {
	const file = await loadConfigFile(agentDir).catch(() => ({}) as CliproxyConfigFile);

	const baseUrlInput = firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, file.baseUrl, DEFAULT_BASE_URL)!;
	const envApiKey = firstNonEmpty(process.env.CLIPROXYAPI_API_KEY);
	const fileApiKey = firstNonEmpty(file.apiKey);
	const apiKey = envApiKey ?? fileApiKey;
	if (!apiKey) {
		return null;
	}

	const endpoints = resolveEndpoints(baseUrlInput);
	return {
		baseUrlInput,
		apiKey,
		...(envApiKey ? { apiKeyEnvName: "CLIPROXYAPI_API_KEY" } : {}),
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}
