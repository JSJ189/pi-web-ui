/** Apply Web UI queue preferences without changing the user's pi CLI settings. */
export function applyQueueModesToSession(
	session: {
		settingsManager: { applyOverrides: (settings: { steeringMode: QueueMode; followUpMode: QueueMode }) => void };
		agent: { steeringMode: QueueMode; followUpMode: QueueMode };
	},
	settings: { steeringMode?: QueueMode; followUpMode?: QueueMode },
): void {
	const steeringMode = settings.steeringMode ?? "all";
	const followUpMode = settings.followUpMode ?? "all";
	session.settingsManager.applyOverrides({ steeringMode, followUpMode });
	// The agent reads these fields when dequeuing; changing SettingsManager alone
	// only takes effect after a reload. SDK setters also persist CLI settings.
	session.agent.steeringMode = steeringMode;
	session.agent.followUpMode = followUpMode;
}

type QueueMode = "all" | "one-at-a-time";
