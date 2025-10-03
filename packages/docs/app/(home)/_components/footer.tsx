import { Github, Twitter } from "lucide-react";
import { Icon } from "@/components/ui/icon";

export function Footer(): React.ReactElement {
	return (
		<footer className="mt-auto border-t bg-background/50 backdrop-blur-sm py-12">
			<div className="container flex flex-col gap-8">
				<div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
					<div>
						<p className="text-lg font-semibold bg-gradient-to-r from-[#ff7a00] to-[#ff7a00]/70 bg-clip-text text-transparent">
							Lector
						</p>
						<p className="text-sm text-muted-foreground mt-1">
							Open-source PDF viewer primitives
						</p>
					</div>

					<div className="flex gap-6">
						<a
							href="https://github.com/anaralabs/lector"
							target="_blank"
							rel="noreferrer"
							className="text-muted-foreground hover:text-foreground transition-colors"
							aria-label="GitHub Repository"
						>
							<Icon as={Github} className="h-5 w-5" />
						</a>
						<a
							href="https://twitter.com/anaralabs"
							target="_blank"
							rel="noreferrer"
							className="text-muted-foreground hover:text-foreground transition-colors"
							aria-label="Twitter Profile"
						>
							<Icon as={Twitter} className="h-5 w-5" />
						</a>
					</div>
				</div>

				<div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pt-4 border-t text-sm text-muted-foreground">
					<div className="flex items-center gap-1">
						Powered by{" "}
						<a
							href="https://anara.com"
							target="_blank"
							rel="noreferrer"
							className="font-medium text-[#ff7a00] hover:text-[#ff7a00]/80 transition-colors inline-flex items-center gap-1"
						>
							Anara
							<span className="text-xs bg-[#ff7a00]/10 text-[#ff7a00] px-2 py-0.5 rounded-full">
								YC S24
							</span>
						</a>
					</div>

					<div className="flex gap-6 text-sm">
						<a
							href="https://anara.com/careers"
							target="_blank"
							rel="noreferrer"
							className="hover:text-foreground transition-colors"
						>
							Careers
						</a>
						<a
							href="https://anara.com"
							target="_blank"
							rel="noreferrer"
							className="hover:text-foreground transition-colors"
						>
							About
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
}
