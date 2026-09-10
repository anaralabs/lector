"use client";

import { Root } from "@anaralabs/lector";
import { useTheme } from "next-themes";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import "@/lib/setup";

/** Keep live examples in step with the docs theme and their available space. */
export function ExampleRoot({
	className,
	...props
}: ComponentProps<typeof Root>) {
	const { resolvedTheme } = useTheme();

	return (
		<Root
			data-lector-example=""
			isZoomFitWidth
			zoomOptions={{ minZoom: 0.1, maxZoom: 10 }}
			{...props}
			colorScheme={resolvedTheme === "dark" ? "dark" : "light"}
			className={cn(
				"not-prose min-w-0 overflow-hidden rounded-lg border bg-muted text-foreground",
				className,
			)}
		/>
	);
}
