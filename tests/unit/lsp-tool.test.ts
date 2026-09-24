import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	makeLspTool,
	LSP_TOOL_NAME,
	globalLspPool,
	LspClient,
	resolveBinary,
	clearResolveBinaryCache,
} from "../../server/lsp-tool.js";

describe("Native LSP Tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "lsp-tool-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	afterAll(async () => {
		await globalLspPool.shutdownAll();
	});

	it("exports proper tool definition", () => {
		const tool = makeLspTool({ cwd: tempDir, ownerId: "test-owner" });
		expect(tool.name).toBe(LSP_TOOL_NAME);
		const actionProps = tool.parameters.properties.action as any;
		const actions = actionProps.enum || actionProps.anyOf?.map((x: any) => x.const);
		expect(actions).toContain("definition");
		expect(actions).toContain("references");
		expect(actions).toContain("hover");
		expect(actions).toContain("diagnostics");
	});

	it("returns error cleanly for non-existent file", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const res = await exec("call-1", {
			action: "definition",
			path: "does_not_exist.ts",
			line: 1,
			character: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("File not found");
	});

	it("returns informative error when file type has no LSP mapping", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const filePath = "data.xyz";
		writeFileSync(join(tempDir, filePath), "some data");

		const res = await exec("call-2", {
			action: "definition",
			path: filePath,
			line: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("No language server mapping");
	});

	it("speaks JSON-RPC 2.0 with a mock language server process", async () => {
		// 编写一个极简的标准 mock LSP 进程脚本，测试完整的协议与传输编解码
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
import { createInterface } from "readline";

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!lenMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{
        uri: msg.params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
      }]
    });
  } else if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        contents: { kind: "markdown", value: "*(mock)* **function greet(name: string): void**" }
      }
    });
  } else if (msg.method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        { uri: msg.params.textDocument.uri, range: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } } }
      ]
    });
  } else if (msg.method === "textDocument/didOpen") {
    // 模拟推送诊断
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
            severity: 1,
            message: "Mock type error: Cannot find name 'foo'",
            code: 2304
          }
        ]
      }
    });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const client = new LspClient(tempDir, "mock", process.execPath, [mockServerScript], "typescript", () => {});
		await client.start();

		const testFile = join(tempDir, "test.ts");
		writeFileSync(testFile, "const x = 1;\nfoo();\n");
		const uri = await client.syncDocument(testFile);

		// 1. Definition
		const defRes = await client.request("textDocument/definition", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
		});
		expect(Array.isArray(defRes)).toBe(true);
		expect(defRes[0].range.start.line).toBe(0);

		// 2. Hover
		const hoverRes = await client.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
		});
		expect(hoverRes.contents.value).toContain("function greet");

		// 3. References
		const refRes = await client.request("textDocument/references", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
			context: { includeDeclaration: true },
		});
		expect(refRes.length).toBe(1);
		expect(refRes[0].range.start.line).toBe(5);

		// 4. Diagnostics (via publishDiagnostics notification)
		await new Promise((r) => setTimeout(r, 80));
		const diags = client.getDiagnostics(uri);
		expect(diags.length).toBe(1);
		expect(diags[0].message).toContain("Mock type error");
		expect(diags[0].code).toBe(2304);

		await client.shutdown();
	});

	it("resolves binary with local node_modules/.bin priority and proper executable extensions", () => {
		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		const isWin = process.platform === "win32";
		const testBin = join(binDir, isWin ? "custom-lsp.cmd" : "custom-lsp");
		writeFileSync(testBin, "#!/bin/sh\necho ok\n");

		const found = resolveBinary("custom-lsp", tempDir);
		expect(found).toBeTruthy();
		expect(found).toBe(testBin);
	});

	it("does not auto-install without explicit allowInstall (user consent gate)", async () => {
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			clearResolveBinaryCache();
			const res = await globalLspPool.getClient(tempDir, join(tempDir, "sample.ts"));
			if ("error" in res) {
				// 未授权时不得联网安装：返回安装指引 + allowInstall 重试提示
				expect(res.error).toContain("allowInstall");
			} else {
				// 该机器生态目录里已有语言服务：门禁未触发，直接释放
				await res.client.shutdown();
			}
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			clearResolveBinaryCache();
		}
	});

	it("returns error cleanly when path attempts traversal outside workspace", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		const res = await exec("call-traversal", {
			action: "definition",
			path: "../outside.ts",
			line: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("Path traversal denied");
	});

	it("handles shutdown cleanly and rejects requests when pool is shutting down", async () => {
		await globalLspPool.shutdownAll();
		const res = await globalLspPool.getClient(tempDir, "test.ts");
		expect("error" in res).toBe(true);
		if ("error" in res) {
			expect(res.error).toContain("shutting down");
		}
	});
});
