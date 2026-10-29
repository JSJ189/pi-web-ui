import { expect, it } from "vitest";
import { DeviceTaskError, deviceTaskFailure } from "../../server/device-center/task-error.js";
it("returns actionable controlled failures without exposing raw SDK errors", () => {
	expect(deviceTaskFailure(new DeviceTaskError("Enable execution on this device", "internal diagnostic"))).toBe(
		"Enable execution on this device",
	);
	const report = deviceTaskFailure(new Error("Provider failed Authorization: secret"));
	expect(report).toContain("target device");
	expect(report).not.toContain("secret");
});
