/**
 * CLIProxyAPI provider for omp.
 *
 * Registers a provider that discovers its models from a CLIProxyAPI instance and
 * serves them over the OpenAI Responses API the proxy exposes at `{root}/v1`.
 *
 * Setup paths:
 * 1. `/login` → "Sign in with an account" → CLIProxyAPI prompts for base URL + API key.
 * 2. `cliproxyapi.json` in the agent directory, or `CLIPROXYAPI_*` environment variables.
 *
 * Fast mode uses omp's own `/fast` command (OpenAI priority service tier). This
 * plugin only keeps that tier for the models the proxy advertises a service tier
 * for, and leaves every other model's request shape untouched.
 */

import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	type CatalogCacheFile,
	fetchCpaCatalog,
	loadCatalogCache,
	loadMappedCatalog,
	mergeCatalogWithExistingCache,
	saveCatalogCache,
} from "./catalog.ts";
import {
	DEFAULT_BASE_URL,
	type ResolvedConnection,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolvePauseDefault,
	saveConfigFile,
} from "./config.ts";
import { FastModeController } from "./fast.ts";
import { type MappedCatalog, toProviderModelConfig } from "./mapping.ts";
import { PauseController, readPauseSetting } from "./pause.ts";
import { registerElapsedStatus } from "./status.ts";

const LOGIN_VALIDATION_TIMEOUT_MS = 20_000;
const FAST_STATUS_KEY = "cliproxyapi-fast";
const PAUSED_STATUS_KEY = "cliproxyapi-paused";
const PRIORITY_SERVICE_TIER = "priority";

function logWarn(message: string): void {
	console.warn(`[omp-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[omp-cliproxyapi-provider] ${message}`);
}

function isPayloadRecord(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = await resolveIdentity(agentDir);
	const providerId = identity.providerId;
	const providerName = identity.providerName;

	let connection = await resolveConnection(agentDir);
	let cached: CatalogCacheFile | null = connection
		? await loadCatalogCache(agentDir, connection.baseUrlInput)
		: null;

	let fastEnabled = false;
	try {
		fastEnabled = await resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);
	fastMode.setSupportedModelIds(cached?.fastModelIds ?? []);

	const pauseMode = new PauseController(false);
	try {
		pauseMode.setEnabled(await resolvePauseDefault(agentDir));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid pause configuration (${message}); using pause=false`);
	}

	/** Fetch the proxy catalog and map it onto omp models. */
	async function refreshCatalog(target: ResolvedConnection | null, apiKeyOverride?: string): Promise<MappedCatalog> {
		const baseUrlInput = target?.baseUrlInput ?? DEFAULT_BASE_URL;
		const endpoints = resolveEndpoints(baseUrlInput);
		const apiKey = apiKeyOverride ?? target?.apiKey;
		if (!apiKey) {
			throw new Error("no API key configured for CLIProxyAPI");
		}

		const fresh = await loadMappedCatalog(endpoints.modelsUrl, apiKey);
		const merged = mergeCatalogWithExistingCache(cached, {
			...fresh,
			inferenceBaseUrl: endpoints.inferenceBaseUrl,
			modelsUrl: endpoints.modelsUrl,
		}).merged;

		cached = { ...merged, fetchedAt: Date.now() };
		await saveCatalogCache(agentDir, merged, cached.fetchedAt);
		fastMode.setSupportedModelIds(merged.fastModelIds);
		return merged;
	}

	/** Re-register the provider so the session picks up a new model list. */
	function registerProvider(target: ResolvedConnection | null, nextCatalog: MappedCatalog): void {
		const baseUrl = target?.inferenceBaseUrl ?? resolveEndpoints(DEFAULT_BASE_URL).inferenceBaseUrl;
		const models = nextCatalog.models.map(toProviderModelConfig);
		pi.registerProvider(providerId, {
			baseUrl,
			// A key that came from the environment is passed by name so it never
			// lands in the model registry; a stored key is passed literally.
			...(target ? { apiKey: target.apiKeyEnvName ?? target.apiKey } : {}),
			api: "openai-responses",
			...(models.length > 0 ? { models } : {}),
			oauth: {
				name: providerName,
				login,
			},
			fetchDynamicModels: async (apiKey) => {
				const live = await refreshCatalog(target ?? connection, apiKey);
				return live.models.map(toProviderModelConfig);
			},
		});
	}

	/** `/login` flow: collect base URL + API key, validate, and persist. */
	async function login(callbacks: OAuthLoginCallbacks): Promise<string> {
		const baseUrlInput = await callbacks.onPrompt({
			message: `CLIProxyAPI base URL (e.g. ${DEFAULT_BASE_URL})`,
		});
		const apiKey = await callbacks.onPrompt({ message: "CLIProxyAPI API key", secret: true });

		const endpoints = resolveEndpoints(baseUrlInput);
		await fetchCpaCatalog(endpoints.modelsUrl, apiKey, { timeoutMs: LOGIN_VALIDATION_TIMEOUT_MS });

		await saveConfigFile(agentDir, { baseUrl: baseUrlInput, apiKey });
		connection = await resolveConnection(agentDir);
		cached = await loadCatalogCache(agentDir, connection?.baseUrlInput ?? baseUrlInput);
		const refreshed = await refreshCatalog(connection);
		registerProvider(connection, refreshed);
		return apiKey;
	}

	registerProvider(connection, {
		models: cached?.models ?? [],
		fastModelIds: cached?.fastModelIds ?? [],
		inferenceBaseUrl: connection?.inferenceBaseUrl ?? resolveEndpoints(DEFAULT_BASE_URL).inferenceBaseUrl,
		modelsUrl: connection?.modelsUrl ?? resolveEndpoints(DEFAULT_BASE_URL).modelsUrl,
	});

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Refresh the CLIProxyAPI model catalog",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				const refreshed = await refreshCatalog(connection);
				registerProvider(connection, refreshed);
				ctx.ui.notify(`CLIProxyAPI models refreshed: ${refreshed.models.length} model(s).`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("cliproxyapi-pause", {
		description: "Hold CLIProxyAPI provider requests until they are resumed",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await saveConfigFile(agentDir, { pause: true });
			pauseMode.setEnabled(true);
			ctx.ui.setStatus(PAUSED_STATUS_KEY, "paused");
			ctx.ui.notify("CLIProxyAPI requests are paused. Use /cliproxyapi-continue to resume.", "info");
		},
	});

	pi.registerCommand("cliproxyapi-continue", {
		description: "Resume paused CLIProxyAPI provider requests",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await saveConfigFile(agentDir, { pause: false });
			pauseMode.setEnabled(false);
			ctx.ui.setStatus(PAUSED_STATUS_KEY, undefined);
			ctx.ui.notify("CLIProxyAPI requests resumed.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// The persisted Fast preference is the startup default for omp's own /fast toggle.
		if (fastMode.isEnabled()) {
			pi.setServiceTier("openai", PRIORITY_SERVICE_TIER);
		}
		if (pauseMode.isEnabled()) {
			ctx.ui.setStatus(PAUSED_STATUS_KEY, "paused");
		}
	});

	pi.on("input", async (event, ctx) => {
		if (!pauseMode.isEnabled()) return;
		ctx.ui.notify("CLIProxyAPI requests are paused. Use /cliproxyapi-continue to resume.", "warning");
		return { handled: true, text: event.text };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (await readPauseSetting(agentDir, pauseMode.isEnabled())) {
			pauseMode.setEnabled(true);
			// The pause stops the run at its next request boundary instead of
			// parking the request, because omp caps extension handlers at 30s.
			ctx.abort();
			return event.payload;
		}
		pauseMode.setEnabled(false);
		ctx.ui.setStatus(PAUSED_STATUS_KEY, undefined);

		const payload = event.payload;
		const model = ctx.model;
		const isOurModel = model?.provider === providerId;
		if (!isOurModel || !isPayloadRecord(payload)) {
			return payload;
		}

		const tierRequested = fastMode.isEnabled() || payload.service_tier !== undefined;
		if (!tierRequested) {
			ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
			return payload;
		}

		if (!fastMode.isModelSupported(model.id)) {
			// The proxy does not advertise a tier for this model, so it keeps its normal shape.
			ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
			const { service_tier: _ignored, ...rest } = payload;
			return rest;
		}

		ctx.ui.setStatus(FAST_STATUS_KEY, "fast");
		return { ...payload, service_tier: payload.service_tier ?? PRIORITY_SERVICE_TIER };
	});

	registerElapsedStatus(pi);

	if (!connection) {
		logInfo(
			`not configured yet. Run /login and pick "${providerName}", or set CLIPROXYAPI_API_KEY in the environment.`,
		);
		return;
	}

	// A cached catalog keeps startup instant; the live listing refreshes in the background.
	if (cached && cached.models.length > 0) {
		void (async () => {
			try {
				const refreshed = await refreshCatalog(connection);
				registerProvider(connection, refreshed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`background model refresh failed (${message}); keeping the cached catalog.`);
			}
		})().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`background model refresh failed (${message}); keeping the cached catalog.`);
		});
		return;
	}

	try {
		const refreshed = await refreshCatalog(connection);
		registerProvider(connection, refreshed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load the CLIProxyAPI catalog (${message}); no models registered.`);
	}
}
