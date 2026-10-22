/**
 * canvas-dispatch.ts — 画布协作 WebSocket 客户端消息分发器。
 */
import type { ClientMessage, ServerMessage } from "../protocol.js";
import { deleteCanvasGraph, listCanvasGraphs, loadCanvasGraph, saveCanvasGraph } from "./canvas-store.js";
import type { CanvasOrchestrator } from "./canvas-orchestrator.js";

export function handleCanvasMessage(
	msg: ClientMessage,
	dataDir: string,
	orchestrator: CanvasOrchestrator,
	send: (msg: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "canvas_list": {
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
			return true;
		}

		case "canvas_load": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.id);
				send({ type: "canvas_graph_state", graph });
			} catch {
				send({
					type: "canvas_graph_state",
					graph: loadCanvasGraph(dataDir, "default"),
				});
			}
			return true;
		}

		case "canvas_save": {
			saveCanvasGraph(dataDir, msg.graph);
			send({ type: "canvas_graph_state", graph: msg.graph });
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
			return true;
		}

		case "canvas_delete": {
			deleteCanvasGraph(dataDir, msg.id);
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
			return true;
		}

		case "canvas_run_all": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				void orchestrator.runAll(graph, msg.initialPrompt);
			} catch {
				// 忽略
			}
			return true;
		}

		case "canvas_run_node": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				void orchestrator.runNode(graph, msg.nodeId, msg.prompt);
			} catch {
				// 忽略
			}
			return true;
		}

		case "canvas_stop_node": {
			orchestrator.stopNode(msg.graphId, msg.nodeId);
			return true;
		}

		case "canvas_stop_all": {
			orchestrator.stopAll(msg.graphId);
			return true;
		}

		case "canvas_steer_node": {
			orchestrator.steerNode(msg.graphId, msg.nodeId, msg.message);
			return true;
		}

		case "canvas_reset_status": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				orchestrator.resetStatus(graph);
				send({ type: "canvas_graph_state", graph });
			} catch {
				// 忽略
			}
			return true;
		}

		default:
			return false;
	}
}
