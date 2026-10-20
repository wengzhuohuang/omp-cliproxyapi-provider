/**
 * Request pause: provider requests are held back while the pause is active.
 *
 * The preference lives in `cliproxyapi.json`, so the gate re-reads the file
 * before every request and picks up edits made outside omp.
 *
 * omp caps extension event handlers at 30 seconds, so a request cannot be held
 * open indefinitely. The pause therefore stops the work instead of parking it:
 * new prompts are refused, and a running turn is aborted at its next request
 * boundary, so no further tokens are spent until the pause is lifted.
 */

import { loadConfigFile } from "./config.ts";

export class PauseController {
	private enabled = false;

	constructor(enabled = false) {
		this.enabled = enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}
}

/** Read the persisted pause preference, keeping the in-memory state on failure. */
export async function readPauseSetting(agentDir: string, fallback = false): Promise<boolean> {
	try {
		const file = await loadConfigFile(agentDir);
		if (file.pause === undefined) {
			return fallback;
		}
		if (typeof file.pause !== "boolean") {
			throw new Error('cliproxyapi.json field "pause" must be a boolean');
		}
		return file.pause;
	} catch {
		return fallback;
	}
}
