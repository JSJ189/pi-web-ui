#!/usr/bin/env node
/** Standalone Hub CLI; no main CLI or agent SDK dependencies. */
import { runHubCliEntry } from "./device-hub-cli.mjs";
try {
	await runHubCliEntry();
} catch (error) {
	console.error(`[device-hub] ${error.message}`);
	process.exitCode = 1;
}
