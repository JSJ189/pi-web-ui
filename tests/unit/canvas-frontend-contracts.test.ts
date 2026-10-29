import { describe, expect, it } from "vitest";
import type { CanvasNode, CanvasEdge } from "../../server/protocol";
import { parseDagJson, dagToGraph, buildSmartPrompt } from "../../web/src/components/canvas/canvas-dag";
import {
	autoLayout,
	computeMinimap,
	fitCanvasViewport,
	computeCanvasBounds,
} from "../../web/src/components/canvas/canvas-p0";
import { SQUAD_TEMPLATES } from "../../web/src/components/canvas/CanvasTemplates";
import {
	isRoleImplemented,
	visibleRoleFields,
	STATUS_COLORS,
	outPortsForRole,
} from "../../web/src/components/canvas/CanvasTypes";
import { canvasText } from "../../web/src/components/canvas/canvas-i18n";
const node = (id: string, x = 0, y = 0): CanvasNode => ({
	id,
	title: id,
	role: "coder",
	x,
	y,
	engine: "pi",
	model: "",
	cwd: ".",
	useWorktree: false,
	status: "idle",
});
const link = (from: string, to: string): CanvasEdge => ({
	id: from + to,
	sourceNodeId: from,
	targetNodeId: to,
	type: "handoff",
});
const base = () => ({
	nodes: [
		{ title: "Decision", role: "condition", config: { keyword: "ready", enabled: true, count: 2 } },
		{ title: "Build", role: "coder", instruction: "Implement", cwd: "project" },
	],
	edges: [{ from: 0, to: 1, type: "condition_true", sourcePort: "true", targetPort: "instruction", label: "Ready" }],
});
describe("canvas DAG contract", () => {
	it("keeps AI limits while allowing explicit whole-graph import limits", () => {
		const data = { nodes: Array.from({ length: 21 }, (_, i) => ({ title: `Step ${i}`, role: "coder" })), edges: [] };
		const raw = JSON.stringify(data);
		expect(() => parseDagJson(raw)).toThrow();
		expect(parseDagJson(raw, 200, 1000).nodes).toHaveLength(21);
		expect(() => parseDagJson(raw, 201, 1000)).toThrow();
	});
	it("retains typed edges, ports, instructions and scalar config", () => {
		const parsed = parseDagJson(JSON.stringify(base()));
		const graph = dagToGraph(parsed, "flow", "model", autoLayout, "fallback");
		expect(graph.edges[0]).toMatchObject({
			type: "condition_true",
			sourcePort: "true",
			targetPort: "instruction",
			label: "Ready",
		});
		expect(graph.nodes[0].config).toEqual(base().nodes[0].config);
		expect(graph.nodes[1]).toMatchObject({ cwd: "project", instruction: "Implement", useWorktree: false });
	});
	it("keeps explicit disconnected graphs disconnected", () => {
		const graph = dagToGraph(parseDagJson(JSON.stringify({ ...base(), edges: [] })), "flow", "", autoLayout);
		expect(graph.edges).toEqual([]);
	});
	it.each([
		{ nodes: [{ title: "bad", role: "toString" }], edges: [] },
		{ nodes: [{ title: "bad", role: "cron" }], edges: [] },
		{ nodes: [{ title: " ", role: "coder" }], edges: [] },
		{ nodes: [{ title: "bad", role: "coder", instruction: 3 }], edges: [] },
		{ nodes: [{ title: "bad", role: "coder", config: { nested: { x: 1 } } }], edges: [] },
		{ ...base(), edges: null },
		{ ...base(), edges: [{ from: 0, to: 9 }] },
		{ ...base(), edges: [{ from: 0, to: 0 }] },
		{ ...base(), edges: [{ from: 0, to: 1, type: "fake" }] },
		{ ...base(), edges: [{ from: 0, to: 1, sourcePort: "missing" }] },
		{ ...base(), edges: [{ from: 0, to: 1, targetPort: "missing" }] },
		{ ...base(), edges: [{ from: 0, to: 1, sourcePort: "true", type: "handoff" }] },
		{
			...base(),
			edges: [
				{ from: 0, to: 1 },
				{ from: 0, to: 1 },
			],
		},
		{
			...base(),
			edges: [
				{ from: 0, to: 1 },
				{ from: 1, to: 0 },
			],
		},
		{ ...base(), unknown: true },
	])("rejects malformed or unsupported DAG %#", (data) => expect(() => parseDagJson(JSON.stringify(data))).toThrow());
	it("rejects prototype config keys", () =>
		expect(() =>
			parseDagJson('{"nodes":[{"title":"x","role":"coder","config":{"__proto__":"bad"}}],"edges":[]}'),
		).toThrow());
	it("excludes unavailable roles from generation", () =>
		expect(buildSmartPrompt("task").split("Allowed roles: ")[1].split(".\n")[0]).not.toMatch(
			/cron|webhook|memory|subflow/,
		));
});
describe("canvas geometry", () => {
	it("uses longest dependency paths so joins follow every predecessor", () => {
		const nodes = [node("a"), node("b"), node("c"), node("d")];
		const laid = autoLayout(nodes, [link("a", "d"), link("a", "b"), link("b", "c"), link("c", "d")]);
		expect(laid[3].x).toBeGreaterThan(laid[2].x);
		expect(nodes[0].x).toBe(0);
	});
	it("spaces variable height cards and variable width columns", () => {
		const nodes = [{ ...node("a"), width: 420 }, node("b"), node("c")];
		const laid = autoLayout(nodes, [link("a", "c")], new Map([["a", 800]]));
		expect(laid[1].y).toBe(920);
		expect(laid[2].x).toBe(560);
	});
	it("preserves relative positions without modulo wrapping and fits measured cards", () => {
		const nodes = [node("a", -900, -500), node("b", 1800, 900)];
		const heights = { a: 700, b: 900 };
		const mini = computeMinimap(nodes, 160, 100, heights);
		expect(mini.nodes[1].x).toBeGreaterThan(mini.nodes[0].x);
		for (const n of mini.nodes) {
			expect(n.x).toBeGreaterThanOrEqual(0);
			expect(n.x + n.width).toBeLessThanOrEqual(160);
			expect(n.y + n.height).toBeLessThanOrEqual(100);
		}
		const b = computeCanvasBounds(nodes, heights);
		expect(b).toEqual({ x: -900, y: -500, width: 3000, height: 2300 });
		const fit = fitCanvasViewport(nodes, 1000, 800, heights);
		expect(b.x * fit.zoom + fit.x).toBeGreaterThanOrEqual(39);
		expect((b.y + b.height) * fit.zoom + fit.y).toBeLessThanOrEqual(761);
	});
	it("handles empty and cyclic legacy graphs deterministically", () => {
		expect(computeMinimap([]).nodes).toEqual([]);
		expect(Number.isFinite(fitCanvasViewport([], 0, 0).zoom)).toBe(true);
		expect(autoLayout([node("a"), node("b")], [link("a", "b"), link("b", "a")])).toHaveLength(2);
	});
});
describe("capability honesty and defaults", () => {
	it("offers both human decisions for wiring", () =>
		expect(outPortsForRole("human").map((p) => p.key)).toEqual(["result", "approve", "reject"]));
	it.each(["cron", "webhook", "memory", "subflow"] as const)("marks %s description only", (role) => {
		expect(isRoleImplemented(role)).toBe(false);
		expect(visibleRoleFields(role, {})).toMatchObject([{ kind: "hint" }]);
	});
	it("ships serial templates with QA, explicit human acceptance and no worktrees", () => {
		for (const tmpl of SQUAD_TEMPLATES) {
			const graph = tmpl.createGraph();
			expect(graph.nodes.some((n) => n.role === "human")).toBe(true);
			expect(graph.nodes.some((n) => n.role === "reviewer" || n.title === "审查")).toBe(true);
			expect(graph.nodes.every((n) => !n.useWorktree && isRoleImplemented(n.role))).toBe(true);
			expect(graph.edges).toHaveLength(graph.nodes.length - 1);
			for (let i = 0; i < graph.edges.length; i++)
				expect(graph.edges[i]).toMatchObject({ sourceNodeId: graph.nodes[i].id, targetNodeId: graph.nodes[i + 1].id });
		}
	});
	it("supports new terminal statuses and locale fallback", () => {
		expect(STATUS_COLORS.skipped).toBeTruthy();
		expect(STATUS_COLORS.cancelled).toBeTruthy();
		expect(canvasText("zh-CN", "中", "English")).toBe("中");
		expect(canvasText("fr", "中", "English")).toBe("English");
	});
});
