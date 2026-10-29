#!/usr/bin/env node
/** Standalone account, device relay and collaboration hub. No agent SDK needed. */
try {
	const { startDeviceHub } = await import("../dist/server/device-center/main.js");
	const hub = await startDeviceHub();
	let closing = false;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			if (closing) return;
			closing = true;
			void hub.close().then(
				() => process.exit(0),
				(error) => {
					console.error(error.message);
					process.exit(1);
				},
			);
		});
	}
} catch (error) {
	console.error(`[device-hub] ${error.message}`);
	process.exitCode = 1;
}
