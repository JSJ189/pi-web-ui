import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error jsdom is installed without declaration files in this project.
import { JSDOM } from "jsdom";
import { renderDeviceHubPage } from "../../server/device-center/hub-page.js";

const windows: { window: { close(): void } }[] = [];
const flush = async () => {
	for (let i = 0; i < 80; i++) await Promise.resolve();
};
function fixture(origin = "https://hub.example") {
	const devices = [
		{ id: "device-win-11111111", name: "Work", online: true, url: "https://win.example/" },
		{ id: "device-mac-22222222", name: "Work", online: false, url: "javascript:alert(1)" },
	];
	const rooms = [
		{ id: "one", name: "Room one", deviceIds: devices.map((d) => d.id) },
		{ id: "two", name: "Room two", deviceIds: [devices[1].id] },
	];
	const task = {
		id: "task-one",
		deviceId: devices[0].id,
		text: "Continue",
		status: "failed",
		report: "<img src=x onerror=alert(1)>",
		handoff: { repository: "repo", commit: "abc", branch: "main", instructions: "Continue work" },
	};
	const fetch = vi.fn(async (path: string, options: any) => {
		let data: any = {};
		if (path === "/api/me") data = { account: { id: "owner", username: "<script>bad</script>" } };
		else if (path === "/api/devices") data = { devices };
		else if (path === "/api/rooms") data = { rooms };
		else if (path.endsWith("/messages")) data = { message: {}, tasks: [] };
		else if (path.endsWith("/open")) data = { url: "https://win.example/once?ticket=secret" };
		else if (path.startsWith("/api/rooms/"))
			data = {
				room: rooms.find((r) => path.endsWith(r.id)),
				messages: [{ sender: { name: "<svg onload=alert(1)>" }, text: "<script>bad</script>", createdAt: 0 }],
				tasks: [task],
			};
		return { ok: true, status: 200, json: async () => data };
	});
	const dom = new JSDOM(renderDeviceHubPage(), {
		url: origin,
		runScripts: "dangerously",
		beforeParse(window: any) {
			window.fetch = fetch as any;
		},
	});
	windows.push(dom);
	const document = dom.window.document;
	const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
	const input = (value: string) => {
		const field = document.getElementById("message") as HTMLTextAreaElement;
		field.value = value;
		field.setSelectionRange(value.length, value.length);
		field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		return field;
	};
	const submit = () =>
		document
			.getElementById("message-form")!
			.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	return { dom, document, fetch, click, input, submit, devices };
}
afterEach(() => {
	windows.splice(0).forEach((dom) => dom.window.close());
	vi.restoreAllMocks();
});

describe("standalone device Hub", () => {
	it("sends group messages on public HTTP without secure-context randomUUID", async () => {
		const f = fixture("http://82.156.246.55:8790");
		await flush();
		f.click("#room-list button");
		await flush();
		Object.defineProperty(f.dom.window.crypto, "randomUUID", { value: undefined });
		f.input("HTTP group message");
		f.submit();
		await flush();
		const sent = f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"));
		expect(sent).toBeDefined();
		expect(JSON.parse(sent![1].body).idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
		expect(f.document.getElementById("transport-note")?.textContent).toContain("HTTP");
	});
	it("renders a self contained document with safe dynamic text and both languages", async () => {
		const html = renderDeviceHubPage();
		expect(html).not.toMatch(/\son\w+=|<script[^>]+src=|https:\/\/.*cdn/i);
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		expect(f.document.querySelector("#account script")).toBeNull();
		expect(f.document.querySelector("#messages svg")).toBeNull();
		expect(f.document.querySelector("#tasks img")).toBeNull();
		expect(f.document.getElementById("tasks")!.textContent).toContain("<img src=x");
		f.click("#language");
		expect(f.document.documentElement.lang).toBe("en");
		expect(f.document.querySelector("h1")!.textContent).toBe("Device Hub");
	});
	it("selects duplicate names by ID using keyboard and mouse, dispatches multiple mentions", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		const field = f.input("@Wo");
		expect(f.document.getElementById("suggestions")!.textContent).toContain("22222222");
		field.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		field.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		f.input(field.value + "and @Wo");
		f.click("#suggestions button");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(2);
		f.submit();
		await flush();
		const sent = f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"))!;
		expect(JSON.parse(sent[1].body).targetDeviceIds).toEqual([f.devices[1].id, f.devices[0].id]);
		expect(sent[1]).toMatchObject({
			credentials: "same-origin",
			mode: "same-origin",
			headers: { "Content-Type": "application/json" },
		});
	});
	it("removes selected targets when the visible mention is replaced with plain text", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		f.input("@Wo");
		f.click("#suggestions button");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(1);
		f.input("ordinary replacement text");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(0);
		expect(f.document.getElementById("send-hint")!.textContent).toContain("不派发任务");
		f.submit();
		await flush();
		expect(
			JSON.parse(f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"))![1].body).targetDeviceIds,
		).toEqual([]);
	});
	it("keeps duplicate-name IDs while tokens remain, then clears ambiguous chips when a token is removed", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		const field = f.input("@Wo");
		f.click("#suggestions button");
		f.input(field.value + "and @Wo");
		f.click("#suggestions button");
		f.input("@Work and @Work updated task");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(2);
		f.input("@Work updated task");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(0);
		f.submit();
		await flush();
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(false);
		expect(f.document.getElementById("mention-warning")!.hidden).toBe(false);
		// The surviving text cannot pick one of two same-name IDs: explicitly choose again.
		f.input("@Wo");
		f.click("#suggestions button:nth-child(2)");
		f.submit();
		await flush();
		expect(
			JSON.parse(f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"))![1].body).targetDeviceIds,
		).toEqual([f.devices[1].id]);
	});
	it("does not treat an edited name prefix as the original selected token", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		f.input("@Wo");
		f.click("#suggestions button");
		f.input("@Workstation do something");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(0);
		f.submit();
		await flush();
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(false);
	});
	it("blocks unselected @ text and clears mentions on room change", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		f.input("@Work do something");
		f.submit();
		await flush();
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(false);
		expect(f.document.getElementById("mention-warning")!.hidden).toBe(false);
		f.input("@Wo");
		f.click("#suggestions button");
		f.click("#room-list button:nth-child(2)");
		await flush();
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(0);
		f.input("ordinary chat");
		f.submit();
		await flush();
		expect(
			JSON.parse(f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"))![1].body).targetDeviceIds,
		).toEqual([]);
	});
	it("prepares handoff without dispatch, then sends parent and repository evidence", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		(f.document.querySelector("#tasks select") as HTMLSelectElement).value = f.devices[1].id;
		f.click("#tasks button");
		await flush();
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(false);
		f.submit();
		await flush();
		const sent = JSON.parse(f.fetch.mock.calls.find(([path]) => path.endsWith("/messages"))![1].body);
		expect(sent).toMatchObject({
			parentTaskId: "task-one",
			targetDeviceIds: [f.devices[1].id],
			handoff: { repository: "repo", commit: "abc", branch: "main", instructions: "Continue work" },
		});
	});
	it("authorizes device access before navigating a new tab and rejects unsafe links", async () => {
		const f = fixture();
		await flush();
		const replace = vi.fn();
		const tab = { opener: {}, location: { replace }, close: vi.fn() };
		f.dom.window.open = vi.fn(() => tab) as any;
		expect(
			f.document.querySelectorAll('#devices a[data-action="device-open"], #devices a[data-action="desktop-open"]'),
		).toHaveLength(2);
		expect(f.document.querySelectorAll('#devices a[data-action="device-entry"]')).toHaveLength(2);
		const link = f.document.querySelector('#devices a[data-action="device-open"]')!;
		expect(link.getAttribute("rel")).toContain("noopener");
		f.click('#devices a[data-action="device-open"]');
		await flush();
		expect(
			f.fetch.mock.calls.some(
				([path, options]) => path === "/api/devices/" + f.devices[0].id + "/open" && options.method === "POST",
			),
		).toBe(true);
		expect(tab.opener).toBeNull();
		expect(replace).toHaveBeenCalledWith("https://win.example/once?ticket=secret");
	});
	it("opens remote desktop with the same authorization ticket and a fixed next path", async () => {
		const f = fixture();
		await flush();
		const replace = vi.fn();
		const tab = { opener: {}, location: { replace }, close: vi.fn() };
		f.dom.window.open = vi.fn(() => tab) as any;
		const link = f.document.querySelector('#devices a[data-action="desktop-open"]')!;
		expect(link.textContent).toBe("远程桌面");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
		f.click('#devices a[data-action="desktop-open"]');
		await flush();
		const target = new URL(replace.mock.calls[0][0]);
		expect(target.origin).toBe("https://win.example");
		expect(target.searchParams.get("ticket")).toBe("secret");
		expect(target.searchParams.get("next")).toBe("/desktop");
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/open"))).toBe(true);
		f.click("#language");
		expect(f.document.querySelector('#devices a[data-action="desktop-open"]')?.textContent).toBe("Remote desktop");
	});
	it("requires target confirmation for revoke and clears selected IDs even if refreshed data is stale", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		f.input("@Wo");
		f.click("#suggestions button");
		const confirm = vi.fn((_message?: string) => false);
		f.dom.window.confirm = confirm;
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining(f.devices[0].id));
		expect(confirm.mock.calls[0][0]).toContain(f.devices[0].name);
		expect(f.fetch.mock.calls.some(([path]) => path.endsWith("/revoke"))).toBe(false);
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(1);
		confirm.mockReturnValue(true);
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		const call = f.fetch.mock.calls.find(([path]) => path.endsWith("/revoke"))!;
		expect(call[0]).toBe("/api/devices/" + f.devices[0].id + "/revoke");
		expect(call[1]).toMatchObject({ method: "POST", body: "{}", mode: "same-origin" });
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(0);
		expect(f.document.getElementById("devices")!.textContent).not.toContain(f.devices[0].id);
		expect(f.document.querySelector('#tasks option[value="' + f.devices[0].id + '"]')).toBeNull();
		f.input("@Wo");
		expect(f.document.getElementById("suggestions")!.textContent).not.toContain("11111111");
		expect(f.document.getElementById("suggestions")!.textContent).toContain("22222222");
	});
	it("keeps device selections and reports real revoke errors when revocation fails", async () => {
		const f = fixture();
		await flush();
		f.click("#room-list button");
		await flush();
		f.input("@Wo");
		f.click("#suggestions button");
		f.dom.window.confirm = vi.fn(() => true);
		const original = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (path, options) =>
			path.endsWith("/revoke")
				? { ok: false, status: 503, json: async () => ({ error: "Revoke unavailable" }) }
				: original(path, options),
		);
		f.click("#devices .card button[data-action=revoke]");
		await flush();
		expect(f.document.getElementById("error")!.textContent).toBe("Revoke unavailable");
		expect(f.document.querySelectorAll("#mentions .chip")).toHaveLength(1);
	});
	it("ignores stale room responses and polls on a three second schedule", async () => {
		const f = fixture();
		await flush();
		let resolve: (data: any) => void = () => {};
		const original = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (path, options) =>
			path === "/api/rooms/one"
				? await new Promise<any>((done) => {
						resolve = done;
					})
				: original(path, options),
		);
		f.click("#room-list button");
		await flush();
		const signal = f.fetch.mock.calls.find(([path]) => path === "/api/rooms/one")![1].signal;
		f.click("#room-list button:nth-child(2)");
		await flush();
		expect(signal.aborted).toBe(true);
		resolve({
			ok: true,
			json: async () => ({ room: { id: "one", name: "STALE", deviceIds: [] }, messages: [], tasks: [] }),
		});
		await flush();
		expect(f.document.getElementById("room-title")!.textContent).toBe("Room two");
		expect(renderDeviceHubPage()).toContain("setTimeout(refresh,3000)");
	});
	it("surfaces connection failures instead of claiming online", async () => {
		const f = fixture();
		await flush();
		f.fetch.mockRejectedValue(new Error("Connection refused"));
		f.click("#room-list button");
		await flush();
		expect(f.document.getElementById("error")!.textContent).toContain("Connection refused");
		expect(f.document.getElementById("connection")!.textContent).toBe("连接失败");
	});
});
