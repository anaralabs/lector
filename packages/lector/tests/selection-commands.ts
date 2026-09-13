import type { BrowserCommand } from "vitest/node";

export const selectionPointer: BrowserCommand<
	[action: "down" | "move" | "up", x: number, y: number]
> = async (context, action, x, y) => {
	const frame = await context.frame();
	const element = await frame.frameElement();
	const bounds = await element.boundingBox();
	if (action === "up") {
		await context.page.mouse.up();
		return;
	}
	const size = await element.evaluate((el) => ({
		width: (el as HTMLElement).offsetWidth,
		height: (el as HTMLElement).offsetHeight,
	}));
	await context.page.mouse.move(
		(x * bounds!.width) / size.width + bounds!.x,
		(y * bounds!.height) / size.height + bounds!.y,
	);
	if (action === "down") await context.page.mouse.down();
};

declare module "vitest/browser" {
	interface BrowserCommands {
		selectionPointer(
			action: "down" | "move" | "up",
			x: number,
			y: number,
		): Promise<void>;
	}
}
