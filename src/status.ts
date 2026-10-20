/**
 * Elapsed time and throughput readout for the interactive session.
 *
 * The footer shows the runtime of the current run, and a notification reports the
 * approximate tokens per second plus the token usage once the run settles.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const ELAPSED_STATUS_KEY = "cliproxyapi-elapsed";
const REFRESH_INTERVAL_MS = 1000;
/** Only the interactive parent session owns the timer; subagents run headless. */
function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

function formatElapsed(totalSeconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(safeSeconds / 86400);
	const hours = Math.floor((safeSeconds % 86400) / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;

	const units = [
		{ value: days, suffix: "d" },
		{ value: hours, suffix: "h" },
		{ value: minutes, suffix: "m" },
		{ value: seconds, suffix: "s" },
	];

	const parts: string[] = [];
	let started = false;
	for (const [index, unit] of units.entries()) {
		if (!started) {
			if (unit.value === 0 && index < units.length - 1) continue;
			started = true;
		}
		parts.push(`${unit.value}${unit.suffix}`);
	}
	return parts.join(" ");
}

export function registerElapsedStatus(pi: ExtensionAPI): void {
	let startedAtMs: number | undefined;
	let statusCtx: ExtensionContext | undefined;
	let refreshHandle: Timer | undefined;
	let usage: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

	const clearTimer = (ctx: ExtensionContext): void => {
		if (refreshHandle) {
			ctx.clearTimer(refreshHandle);
			refreshHandle = undefined;
		}
	};

	const clearStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(ELAPSED_STATUS_KEY, undefined);
	};

	pi.on("before_agent_start", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (startedAtMs !== undefined) {
			statusCtx = ctx;
			return;
		}

		startedAtMs = Date.now();
		statusCtx = ctx;
		usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		ctx.ui.setStatus(ELAPSED_STATUS_KEY, "Elapsed 0s");
		refreshHandle = ctx.setInterval(() => {
			if (startedAtMs === undefined || !statusCtx) return;
			const seconds = Math.floor((Date.now() - startedAtMs) / 1000);
			statusCtx.ui.setStatus(ELAPSED_STATUS_KEY, `Elapsed ${formatElapsed(seconds)}`);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("agent_end", (event, ctx) => {
		if (startedAtMs === undefined || !isPrimaryUiSession(ctx)) return;

		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			usage.input += message.usage.input || 0;
			usage.output += message.usage.output || 0;
			usage.cacheRead += message.usage.cacheRead || 0;
			usage.cacheWrite += message.usage.cacheWrite || 0;
			usage.totalTokens += message.usage.totalTokens || 0;
		}

		// A scheduled continuation means the run has not settled yet.
		if (event.willContinue) return;

		const elapsedMs = Date.now() - startedAtMs;
		startedAtMs = undefined;
		clearTimer(ctx);
		ctx.ui.setStatus(ELAPSED_STATUS_KEY, `Elapsed ${formatElapsed(elapsedMs / 1000)}`);
		statusCtx = ctx;

		if (elapsedMs <= 0) return;
		const elapsedSeconds = elapsedMs / 1000;
		const tps = usage.output > 0 ? (usage.output / elapsedSeconds).toFixed(1) : "--";
		ctx.ui.notify(
			`TPS ${tps} tok/s. out ${usage.output.toLocaleString()}, in ${usage.input.toLocaleString()}, ` +
				`cache r/w ${usage.cacheRead.toLocaleString()}/${usage.cacheWrite.toLocaleString()}, ` +
				`total ${usage.totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`,
			"info",
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearTimer(ctx);
		clearStatus(ctx);
		startedAtMs = undefined;
		statusCtx = undefined;
	});
}
