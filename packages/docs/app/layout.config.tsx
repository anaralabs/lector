import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

import Logo from "@/public/logo.png";

/**
 * Shared layout configurations
 */
export const baseOptions: BaseLayoutProps = {
	githubUrl: "https://github.com/anaralabs/lector",

	nav: {
		title: (
			<>
				<Image
					alt="Fumadocs"
					src={Logo}
					className="w-5 h-5"
					aria-label="Fumadocs"
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
