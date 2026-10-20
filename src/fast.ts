/**
 * Fast mode: request OpenAI's priority service tier for models the proxy
 * advertises a service tier for.
 *
 * CLIProxyAPI publishes the supported tiers per model, so a model without a
 * non-empty `service_tiers` list keeps its normal request shape.
 */

export class FastModeController {
	private supportedModelIds = new Set<string>();

	constructor(private enabled: boolean) {}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supportedModelIds = new Set(
			Array.from(modelIds, (modelId) => modelId.trim()).filter((modelId) => modelId.length > 0),
		);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	isModelSupported(modelId: string): boolean {
		return this.supportedModelIds.has(modelId.trim());
	}

	isEffectiveFor(modelId: string | undefined): boolean {
		return this.enabled && modelId !== undefined && this.isModelSupported(modelId);
	}
}
