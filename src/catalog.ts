/**
 * CLIProxyAPI catalog access: remote listing, on-disk cache, and stale-model retention.
 *
 * The proxy occasionally prunes models because of a transient capacity blip, so a
 * model that vanishes from one listing is retained for a while instead of
 * disappearing from `/model`.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MODELS_CACHE_FILE_NAME, MODELS_REQUEST_TIMEOUT_MS, resolveEndpoints } from "./config.ts";
import { type CpaCatalogModel, type MappedCatalog, type MappedModel, mapCatalogModel } from "./mapping.ts";

export const DEFAULT_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ModelsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, body: string) {
		super(`models request failed: ${status} ${statusText}${body ? ` body=${body.slice(0, 200)}` : ""}`);
		this.name = "ModelsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedModelsError(error: unknown): boolean {
	return error instanceof ModelsHttpError && error.status === 401;
}

/** Fetch the proxy's model catalog. HTTP 200 with an empty catalog is a success. */
export async function fetchCpaCatalog(
	modelsUrl: string,
	apiKey: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CpaCatalogModel[]> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? MODELS_REQUEST_TIMEOUT_MS);
	const requestSignal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;

	const response = await fetch(modelsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal: requestSignal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}

	if (Array.isArray(payload)) {
		return payload as CpaCatalogModel[];
	}
	if (payload && typeof payload === "object") {
		const object = payload as { models?: unknown; data?: unknown };
		if (Array.isArray(object.models)) {
			return object.models as CpaCatalogModel[];
		}
		if (Array.isArray(object.data)) {
			return object.data as CpaCatalogModel[];
		}
	}
	return [];
}

export interface CatalogCacheFile extends MappedCatalog {
	fetchedAt: number;
}

export async function loadCatalogCache(agentDir: string, baseUrlInput: string): Promise<CatalogCacheFile | null> {
	const cachePath = join(agentDir, MODELS_CACHE_FILE_NAME);
	try {
		const parsed = JSON.parse(await Bun.file(cachePath).text()) as Partial<CatalogCacheFile>;
		const endpoints = resolveEndpoints(baseUrlInput);
		if (
			typeof parsed.fetchedAt !== "number" ||
			parsed.modelsUrl !== endpoints.modelsUrl ||
			parsed.inferenceBaseUrl !== endpoints.inferenceBaseUrl ||
			!Array.isArray(parsed.models) ||
			!Array.isArray(parsed.fastModelIds)
		) {
			return null;
		}
		return parsed as CatalogCacheFile;
	} catch {
		return null;
	}
}

export async function saveCatalogCache(
	agentDir: string,
	loaded: MappedCatalog,
	fetchedAt = Date.now(),
): Promise<void> {
	const cachePath = join(agentDir, MODELS_CACHE_FILE_NAME);
	await mkdir(dirname(cachePath), { recursive: true });
	await Bun.write(cachePath, `${JSON.stringify({ ...loaded, fetchedAt }, null, 2)}\n`);
}

export interface MergeCatalogResult {
	merged: MappedCatalog;
	retainedStaleModels: MappedModel[];
	droppedModelIds: string[];
}

/**
 * Merge a fresh listing with the cached one, retaining models that went missing.
 *
 * A model is retained from the moment it first disappears until it has been
 * missing for the whole retention window.
 */
export function mergeCatalogWithExistingCache(
	existingCache: CatalogCacheFile | null,
	fresh: MappedCatalog,
	now = Date.now(),
	staleTtlMs = DEFAULT_STALE_TTL_MS,
): MergeCatalogResult {
	if (!existingCache || !Array.isArray(existingCache.models) || existingCache.models.length === 0) {
		return {
			merged: {
				...fresh,
				models: fresh.models.map((model) => ({ ...model, lastSeenAt: now, stale: false })),
			},
			retainedStaleModels: [],
			droppedModelIds: [],
		};
	}

	const freshModelMap = new Map<string, MappedModel>();
	const freshFastIds = new Set(fresh.fastModelIds);

	for (const model of fresh.models) {
		freshModelMap.set(model.id, { ...model, lastSeenAt: now, stale: false });
	}

	const retainedStaleModels: MappedModel[] = [];
	const droppedModelIds: string[] = [];

	for (const previous of existingCache.models) {
		if (freshModelMap.has(previous.id)) {
			continue;
		}
		const lastSeen = previous.lastSeenAt ?? existingCache.fetchedAt ?? now;
		const staleSince = previous.stale === true ? (previous.staleSince ?? lastSeen) : now;

		if (now - staleSince < staleTtlMs) {
			retainedStaleModels.push({ ...previous, lastSeenAt: lastSeen, staleSince, stale: true });
			if (existingCache.fastModelIds.includes(previous.id)) {
				freshFastIds.add(previous.id);
			}
		} else {
			droppedModelIds.push(previous.id);
		}
	}

	return {
		merged: {
			...fresh,
			models: [...freshModelMap.values(), ...retainedStaleModels],
			fastModelIds: Array.from(freshFastIds),
		},
		retainedStaleModels,
		droppedModelIds,
	};
}

/** Fetch the remote catalog and map it onto omp models. */
export async function loadMappedCatalog(
	modelsUrl: string,
	apiKey: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MappedCatalog> {
	const entries = await fetchCpaCatalog(modelsUrl, apiKey, {
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	const models = entries
		.map((entry) => mapCatalogModel(entry))
		.filter((model): model is MappedModel => model !== null);

	const fastModelIds = Array.from(
		new Set(models.filter((model) => model.fastCapable).map((model) => model.id)),
	);

	return {
		models,
		fastModelIds,
		inferenceBaseUrl: "",
		modelsUrl,
	};
}
