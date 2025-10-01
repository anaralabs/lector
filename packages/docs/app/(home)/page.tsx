import { AlertTriangle, ArrowRight, Github } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { AnaraViewer } from "./_components/anara";
import { GithubStarsButton } from "./_components/github-stars-button";

export default function Home() {
	return (
		<div className="flex flex-col gap-8 px-4 max-w-7xl w-full mx-auto py-16">
			<div className="w-full bg-amber-50 border border-amber-300 rounded-lg p-4 flex items-start gap-3 text-amber-800">
				<Icon as={AlertTriangle} className="h-5 w-5 flex-shrink-0 mt-0.5" />
				<div className="flex flex-col gap-2">
					<h2 className="font-semibold">
						Breaking Change: Repository Name Update
					</h2>
					<p className="text-sm">
						We&apos;ve changed our name from <strong>unriddle-ai</strong> to{" "}
						<strong>anaralabs</strong>. Please update your dependencies from{" "}
						<code className="bg-amber-100 px-1.5 py-0.5 rounded text-amber-900">
							@unriddle-ai/lector
						</code>{" "}
						to{" "}
						<code className="bg-amber-100 px-1.5 py-0.5 rounded text-amber-900">
							@anaralabs/lector
						</code>
						.
					</p>
				</div>
			</div>

			<div className="flex flex-col lg:flex-row gap-8">
				<div className="flex flex-col lg:w-1/2 gap-6 justify-center">
					<div className="flex flex-col gap-4">
						<a
							href="https://github.com/anaralabs/lector"
							target="_blank"
							rel="noreferrer"
							className="inline-flex hover:bg-[#ff7a00]/20 transition-colors items-center gap-2 text-sm bg-[#ff7a00]/10 text-[#ff7a00] px-4 py-1 rounded-full w-fit"
						>
							<Icon as={Github} className="h-4 w-4" />
							<span>Open Source</span>
						</a>

						<h1 className="font-bold text-4xl sm:text-5xl lg:text-6xl bg-gradient-to-br from-foreground via-foreground to-[#ff7a00] bg-clip-text text-transparent">
							Primitives for your PDF viewer
						</h1>

						<p className="text-lg text-muted-foreground max-w-xl">
							Build your perfect PDF viewer with our headless UI components.
							Fully customizable, accessible, and easy to integrate.
						</p>
					</div>

					<div className="flex flex-wrap gap-4 items-center">
						<Link href="/docs/basic-usage">
							<Button className="font-semibold bg-gradient-to-r from-[#ff7a00] to-[#ff7a00]/90 hover:from-[#ff7a00]/90 hover:to-[#ff7a00] transition-all duration-300">
								Quickstart
								<Icon as={ArrowRight} className="h-6 w-6" />
							</Button>
						</Link>

						<GithubStarsButton />
					</div>

					<div className="flex gap-4 items-center text-sm text-muted-foreground mt-4">
						<div className="flex items-center gap-2">
							<div className="h-2 w-2 rounded-full bg-[#ff7a00]" />
							Composition pattern
						</div>
						<div className="flex items-center gap-2">
							<div className="h-2 w-2 rounded-full bg-[#ff7a00]" />
							Virtualization
						</div>
						<div className="flex items-center gap-2">
							<div className="h-2 w-2 rounded-full bg-[#ff7a00]" />
							Panning/Zooming
						</div>
					</div>
				</div>

				<div className="lg:w-1/2 rounded-lg overflow-hidden borde shadow-xl backdrop-blur-sm bg-white/5">
					<AnaraViewer />
				</div>
			</div>
		</div>
	);
}
