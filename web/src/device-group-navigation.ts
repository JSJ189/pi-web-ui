import { useSyncExternalStore } from "react";

export interface DeviceGroupNavigation {
	revision: number;
	roomId?: string;
	create?: boolean;
	manage?: boolean;
}
let navigation: DeviceGroupNavigation = { revision: 0 };
const listeners = new Set<() => void>();
export function openDeviceGroup(detail: Omit<DeviceGroupNavigation, "revision">) {
	navigation = { ...detail, revision: navigation.revision + 1 };
	for (const listener of listeners) listener();
}
export function useDeviceGroupNavigation() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => navigation,
	);
}
