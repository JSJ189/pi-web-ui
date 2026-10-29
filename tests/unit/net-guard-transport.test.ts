import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	connectors: [] as any[],
	agents: [] as any[],
	fetch: vi.fn(),
}));
vi.mock("undici", () => ({
	buildConnector: (options: any) => {
		transport.connectors.push(options);
		return vi.fn();
	},
	Agent: class {
		close = vi.fn(async () => {});
		destroy = vi.fn(async () => {});
		constructor(public options: any) {
			transport.agents.push(this);
		}
	},
	fetch: transport.fetch,
}));
import { resolveAndValidateUrl, safeFetch } from "../../server/net-guard.js";
import { fetchText } from "../../server/preset-share.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	transport.connectors.length = 0;
	transport.agents.length = 0;
});

const lookup = async (_hostname: string) => [{ address: "93.184.216.34", family: 4 }];

describe("DNS-bound HTTP transport", () => {
	it("pins connection lookup while preserving original URL, TLS hostname and Host", async () => {
		const dns = vi.fn(lookup);
		transport.fetch.mockResolvedValueOnce(new Response("ok"));
		const response = await safeFetch("https://public.example/path", {}, { lookup: dns });
		expect(await response.text()).toBe("ok");
		expect(dns).toHaveBeenCalledTimes(1);
		expect(transport.fetch.mock.calls[0][0]).toBe("https://public.example/path");
		const callback = vi.fn();
		transport.connectors[0].lookup("public.example", { all: true }, callback);
		expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
		expect(dns).toHaveBeenCalledTimes(1);
		const wrongHost = vi.fn();
		transport.agents[0].options.connect({ hostname: "attacker.example" }, wrongHost);
		expect(wrongHost.mock.calls[0][0]).toBeInstanceOf(Error);
		expect(transport.agents[0].close).toHaveBeenCalledOnce();
	});

	it("does not trust replaced global fetch or allow skipDnsLookup on production transport", async () => {
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		await expect(
			safeFetch(
				"https://rebind.example",
				{},
				{
					skipDnsLookup: true,
					lookup: async () => [{ address: "127.0.0.1" }],
				},
			),
		).rejects.toThrow(/Blocked private/);
		expect(globalFetch).not.toHaveBeenCalled();
		expect(transport.fetch).not.toHaveBeenCalled();
	});

	it("rejects non-IP DNS answers", async () => {
		expect(
			await resolveAndValidateUrl("https://public.example", {
				lookup: async () => [{ address: "another.example" }],
			}),
		).toEqual({ ok: false, reason: "host" });
	});

	it("cancels redirects and creates a separately pinned dispatcher for each hop", async () => {
		const cancel = vi.fn();
		transport.fetch
			.mockResolvedValueOnce(
				new Response(new ReadableStream({ cancel }), {
					status: 302,
					headers: { location: "https://next.example/end" },
				}),
			)
			.mockResolvedValueOnce(new Response("done"));
		const dns = vi.fn(lookup);
		await (
			await safeFetch("https://public.example/start", { headers: { authorization: "secret" } }, { lookup: dns })
		).text();
		expect(cancel).toHaveBeenCalledOnce();
		expect(dns.mock.calls.map((args) => args[0])).toEqual(["public.example", "next.example"]);
		expect(transport.agents).toHaveLength(2);
		expect(new Headers(transport.fetch.mock.calls[1][1].headers).has("authorization")).toBe(false);
	});

	it("cancels redirect bodies before rejecting invalid, excessive or private redirects", async () => {
		for (const location of ["http://[", "http://127.0.0.1/private", "https://next.example"]) {
			const cancel = vi.fn();
			transport.fetch.mockResolvedValueOnce(
				new Response(new ReadableStream({ cancel }), {
					status: 302,
					headers: { location },
				}),
			);
			await expect(
				safeFetch(
					"https://public.example",
					{},
					{
						lookup,
						maxRedirects: location === "https://next.example" ? 0 : 5,
					},
				),
			).rejects.toThrow();
			expect(cancel).toHaveBeenCalledOnce();
		}
	});

	it("keeps abort attached until the body and dispatcher have closed", async () => {
		let finish!: () => void;
		transport.fetch.mockImplementationOnce(async (_url, init) => {
			init.dispatcher.close.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			return new Response("ok");
		});
		const abort = new AbortController();
		const response = await safeFetch("https://public.example", { signal: abort.signal }, { lookup });
		abort.abort();
		expect(transport.agents[0].destroy).toHaveBeenCalledOnce();
		finish();
		await response.text();
	});

	it("destroys failed dispatchers and bounds stalled DNS", async () => {
		transport.fetch.mockRejectedValueOnce(new Error("connection failed"));
		await expect(safeFetch("https://public.example", {}, { lookup })).rejects.toThrow("connection failed");
		expect(transport.agents[0].destroy).toHaveBeenCalledOnce();
		await expect(
			safeFetch(
				"https://public.example",
				{},
				{
					lookup: () => new Promise(() => {}),
					timeoutMs: 10,
				},
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("bounds slow response bodies and cancels rejected or oversized preset bodies", async () => {
		const cancel = vi.fn();
		transport.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
		await expect(fetchText("https://public.example", { lookup, timeoutMs: 10 })).rejects.toMatchObject({
			name: "TimeoutError",
		});
		expect(cancel).toHaveBeenCalledOnce();
		const cancelError = vi.fn();
		transport.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelError }), { status: 500 }));
		expect(await fetchText("https://public.example", { lookup })).toMatchObject({
			ok: false,
			errorKey: "presets.fetch.status",
		});
		expect(cancelError).toHaveBeenCalledOnce();
		const cancelLarge = vi.fn();
		transport.fetch.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(100));
					},
					cancel: cancelLarge,
				}),
			),
		);
		expect(await fetchText("https://public.example", { lookup, maxBytes: 10 })).toMatchObject({
			ok: false,
			errorKey: "presets.fetch.tooLarge",
		});
		expect(cancelLarge).toHaveBeenCalledOnce();
	});
});
