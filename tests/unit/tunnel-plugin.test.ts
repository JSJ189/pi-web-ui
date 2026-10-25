import { describe, expect, it } from "vitest";
import { sanitizeHostHeader } from "../../plugins/tunnel/index.mjs";

describe("sanitizeHostHeader", () => {
	it("合法 host 保持原样", () => {
		expect(sanitizeHostHeader("127.0.0.1:8765")).toBe("127.0.0.1:8765");
		expect(sanitizeHostHeader("my-server.lan:9000")).toBe("my-server.lan:9000");
		expect(sanitizeHostHeader("localhost:8765")).toBe("localhost:8765");
		expect(sanitizeHostHeader("  192.168.1.10:8765  ")).toBe("192.168.1.10:8765");
	});

	it("含注入字符（单引号/反斜杠/换行/代码片段）回落 fallback", () => {
		const fallback = "127.0.0.1:8765";
		expect(sanitizeHostHeader("localhost:8765'; alert(1); //", fallback)).toBe(fallback);
		expect(sanitizeHostHeader("evil.com\nnewline", fallback)).toBe(fallback);
		expect(sanitizeHostHeader('foo"bar', fallback)).toBe(fallback);
		expect(sanitizeHostHeader("<script>", fallback)).toBe(fallback);
		expect(sanitizeHostHeader("", fallback)).toBe(fallback);
		expect(sanitizeHostHeader(undefined as any, fallback)).toBe(fallback);
	});
});
