import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

/**
 * Shared layout configurations
 */
export const baseOptions: BaseLayoutProps = {
	githubUrl: "https://github.com/anaralabs/lector",

	nav: {
		title: (
			<>
				<Image
					alt=""
					src="/lector/anara-mark.svg"
					width={28}
					height={14}
					className="w-7 h-auto dark:invert"
				/>
				<span className="font-medium [.uwu_&]:hidden [header_&]:text-[15px]">
					Lector
				</span>
			</>
		),
		transparentMode: "top",
	},
	links: [
		{
			text: "Documentation",
			url: "/docs/basic-usage",
			active: "nested-url",
		},
	],
};
