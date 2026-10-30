import { expect, it } from "vitest";
import { resolveBotCwd } from "../../web/src/local-bot-path";
it.each([
	["web", "E:/project", "E:/project/web"],
	[".", "E:\\project", "E:/project"],
	["../other", "/work/project", "/work/other"],
	["/tmp/project", "E:/project", "/tmp/project"],
	["\\\\server\\share\\folder", "E:/project", "//server/share/folder"],
	["../../x", "C:/project", "C:/x"],
])("resolves %s against %s", (value, base, result) => {
	expect(resolveBotCwd(value, base)).toBe(result);
});
