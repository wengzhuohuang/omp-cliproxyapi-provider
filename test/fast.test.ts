import { describe, expect, test } from "bun:test";
import { FastModeController } from "../src/fast.ts";

describe("FastModeController", () => {
	test("is off until it is enabled", () => {
		const fast = new FastModeController(false);
		expect(fast.isEnabled()).toBe(false);
		expect(fast.isEffectiveFor("gpt-6.1-sol")).toBe(false);
	});

	test("only applies to models the proxy advertises a tier for", () => {
		const fast = new FastModeController(true);
		fast.setSupportedModelIds(["gpt-6.1-sol", "  "]);
		expect(fast.isModelSupported("gpt-6.1-sol")).toBe(true);
		expect(fast.isModelSupported("gpt-6-luna")).toBe(false);
		expect(fast.isEffectiveFor("gpt-6.1-sol")).toBe(true);
		expect(fast.isEffectiveFor("gpt-6-luna")).toBe(false);
		expect(fast.isEffectiveFor(undefined)).toBe(false);
	});
});
