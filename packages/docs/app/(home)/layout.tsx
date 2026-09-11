import { ArrowUpRight, Github } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "./_components/landing-controls";
import "./landing.css";

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<div className="landing">
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<header className="site-header">
				<Link href="/" className="wordmark" aria-label="Lector home">
					<Image
						src="/lector/anara-mark.svg"
						width={32}
						height={16}
						alt=""
						className="anara-mark"
					/>
					Lector
				</Link>
				<nav aria-label="Main navigation">
					<Link href="/docs/code/basic" className="nav-examples">
						Examples
					</Link>
					<Link href="/docs/basic-usage">Documentation</Link>
					<a href="https://github.com/anaralabs/lector" className="nav-github">
						<Github size={15} aria-hidden="true" />
						<span>GitHub</span>
						<ArrowUpRight size={12} aria-hidden="true" />
					</a>
					<ThemeToggle />
				</nav>
			</header>
			{children}
			<footer className="site-footer">
				<div>
					<Link href="/" className="footer-name">
						Lector
					</Link>
					<span>
						Made by{" "}
						<a href="https://anara.com">
							Anara <ArrowUpRight size={12} aria-hidden="true" />
						</a>
					</span>
				</div>
				<div>
					<a href="https://github.com/anaralabs/lector/blob/main/LICENSE">
						MIT licensed
					</a>
					<a href="https://github.com/anaralabs/lector">
						View source <ArrowUpRight size={12} aria-hidden="true" />
					</a>
				</div>
			</footer>
		</div>
	);
}
