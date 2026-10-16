import { describe, expect, it } from "vitest";
import { computeDropdownShift, computePortalDropdownPosition } from "../../web/src/components/Dropdown";

describe("computeDropdownShift (Issue #252)", () => {
	it("在视口内正常容纳时无需平移 (shift === 0)", () => {
		// 宽屏 1920，触发器在 (500, 600)，菜单宽 450，align=left
		const shiftLeft = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftLeft).toBe(0);

		// 宽屏 1920，触发器在 (1500, 1600)，菜单宽 450，align=right
		const shiftRight = computeDropdownShift({
			align: "right",
			triggerLeft: 1500,
			triggerRight: 1600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftRight).toBe(0);
	});

	it("向左溢出时（Issue #252 经典复现场景：中窄屏/靠左触发器 + align=right），向右平移钳制在 margin 内", () => {
		// 视口 900px，触发器在输入框左下角 (100, 220)，菜单宽 550px，align=right
		// 自然位置：naturalLeft = 220 - 550 = -330px（超出左边界 330px！）
		// 期望：向右平移到 margin(8px)，shift = 8 - (-330) = +338px
		const shift = computeDropdownShift({
			align: "right",
			triggerLeft: 100,
			triggerRight: 220,
			menuWidth: 550,
			viewportWidth: 900,
			margin: 8,
		});
		expect(shift).toBe(338);
		// 平移后的最终位置：-330 + 338 = 8px
		expect(220 - 550 + shift).toBe(8);
	});

	it("align=left 且触发器靠左但依然溢出左边界时，向右平移到 margin", () => {
		// 触发器由于极窄或负偏移在 (-50, 50)，菜单宽 400，align=left
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: -50,
			triggerRight: 50,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(58);
		expect(-50 + shift).toBe(8);
	});

	it("向右溢出时，向左平移钳制在视口右边缘内", () => {
		// 视口 800px，触发器在 (500, 600)，菜单宽 400px，align=left
		// 自然位置：naturalLeft = 500px，naturalRight = 900px（超出右侧 100px）
		// maxLeft = 800 - 8 - 400 = 392px
		// 期望：shift = 392 - 500 = -108px
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(-108);
		// 平移后的最终位置：500 - 108 = 392px，右边缘 = 392 + 400 = 792px (800 - 8)
		expect(500 + shift + 400).toBe(800 - 8);
	});

	it("菜单宽度大于视口可用宽度时，优先保证左侧在视野内 (left === margin)", () => {
		// 视口 500px，菜单宽 600px，margin 8
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 100,
			triggerRight: 200,
			menuWidth: 600,
			viewportWidth: 500,
			margin: 8,
		});
		// naturalLeft = 100，期望移到 margin(8)，shift = -92
		expect(shift).toBe(-92);
		expect(100 + shift).toBe(8);
	});

	it("非正常尺寸（menuWidth <= 0 或 viewportWidth <= 0）时不产生平移", () => {
		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 0,
				viewportWidth: 800,
			}),
		).toBe(0);

		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 400,
				viewportWidth: 0,
			}),
		).toBe(0);
	});
});

describe("computePortalDropdownPosition (侧边栏与 Portal 菜单定位)", () => {
	const viewport = { viewportWidth: 1200, viewportHeight: 800 };
	const menu = { menuWidth: 340, menuHeight: 300 };

	it("左侧停靠栏 (direction=right): 默认在触发器右侧向内展开，垂直与触发器顶部平齐", () => {
		// 触发器在左侧停靠栏 (left: 4, right: 34, top: 100, bottom: 130)
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 4, right: 34, top: 100, bottom: 130 },
			...menu,
			...viewport,
			direction: "right",
			gap: 6,
			margin: 8,
		});

		// 期望：left = 34 + 6 = 40px；top = 100px
		expect(pos.left).toBe(40);
		expect(pos.top).toBe(100);
	});

	it("左侧停靠栏 (direction=right): 靠近屏幕底部时，自动向上平移以贴底", () => {
		// 触发器靠近视口底部 (top: 650, bottom: 680)
		// 菜单高 300，如果 top=650，则 bottom=950 > 800-8 (792)
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 4, right: 34, top: 650, bottom: 680 },
			...menu,
			...viewport,
			direction: "right",
			gap: 6,
			margin: 8,
		});

		// 期望：贴底 top = 800 - 8 - 300 = 492px
		expect(pos.left).toBe(40);
		expect(pos.top).toBe(492);
	});

	it("右侧停靠栏 (direction=left): 默认在触发器左侧向内展开，垂直与触发器顶部平齐", () => {
		// 触发器在右侧停靠栏 (left: 1166, right: 1196, top: 120, bottom: 150)
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 1166, right: 1196, top: 120, bottom: 150 },
			...menu,
			...viewport,
			direction: "left",
			gap: 6,
			margin: 8,
		});

		// 期望：left = 1166 - 340 - 6 = 820px；top = 120px
		expect(pos.left).toBe(820);
		expect(pos.top).toBe(120);
	});

	it("右侧停靠栏 (direction=left): 左侧放不下且右侧放得下时，自动翻转到右侧", () => {
		// 窄触发器在 (left: 200, right: 230)，菜单宽 340，左侧 200 - 340 - 6 < 8 放不下
		// 右侧 230 + 6 + 340 = 576 <= 1200 - 8 能放下
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 200, right: 230, top: 150, bottom: 180 },
			...menu,
			...viewport,
			direction: "left",
			gap: 6,
			margin: 8,
		});

		// 翻转到右侧：230 + 6 = 236px
		expect(pos.left).toBe(236);
		expect(pos.top).toBe(150);
	});

	it("底栏 (direction=up): 默认在触发器上方弹出，上方不足时自动翻转到下方", () => {
		// 正常底栏触发器在 (top: 750, bottom: 780)，上方能放下
		const posUp = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 750, bottom: 780 },
			...menu,
			...viewport,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posUp.top).toBe(750 - 300 - 6); // 444
		expect(posUp.left).toBe(500);

		// 上方放不下 (top: 100, bottom: 130)，翻转到下方
		const posFlip = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 100, bottom: 130 },
			...menu,
			...viewport,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posFlip.top).toBe(130 + 6); // 136
		expect(posFlip.left).toBe(500);
	});

	it("顶栏 (direction=down): 默认在触发器下方弹出，下方不足时自动翻转到上方", () => {
		// 正常顶栏触发器在 (top: 10, bottom: 40)
		const posDown = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 10, bottom: 40 },
			...menu,
			...viewport,
			direction: "down",
			align: "right",
			gap: 6,
			margin: 8,
		});
		expect(posDown.top).toBe(40 + 6); // 46
		expect(posDown.left).toBe(600 - 340); // 260

		// 下方放不下 (top: 600, bottom: 630)，翻转到上方
		const posFlip = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 600, bottom: 630 },
			...menu,
			...viewport,
			direction: "down",
			align: "right",
			gap: 6,
			margin: 8,
		});
		expect(posFlip.top).toBe(600 - 300 - 6); // 294
		expect(posFlip.left).toBe(600 - 340);
	});

	it("异常尺寸（非正数尺寸）安全容错", () => {
		const posZero = computePortalDropdownPosition({
			triggerRect: { left: 50, right: 80, top: 100, bottom: 130 },
			menuWidth: 0,
			menuHeight: 0,
			viewportWidth: 800,
			viewportHeight: 600,
		});
		expect(posZero.left).toBe(50);
		expect(posZero.top).toBe(136);
	});
});
