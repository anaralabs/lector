import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { baseOptions } from "@/app/layout.config";
import { Footer } from "./_components/footer";

export default function Layout({
	children,
}: {
	children: ReactNode;
}): React.ReactElement {
	return (
		<div className="flex flex-col ">
			<HomeLayout
				className="relative bg-background text-foreground min-h-screen"
				{...baseOptions}
			>
				<div className="absolute inset-0 bg-gradient-to-br from-background via-background to-[#ff7a00]/10" />
				<div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,122,0,0.05),transparent_50%)]" />
				<div className="relative">{children}</div>
			</HomeLayout>
			<Footer />
		</div>
	);
}
