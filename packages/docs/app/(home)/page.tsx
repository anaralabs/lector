// biome-ignore-all lint/correctness/useUniqueElementIds: Singleton page landmarks and public fragment links need stable IDs.
import {
	ArrowRight,
	ArrowUpRight,
	Braces,
	FileText,
	Highlighter,
	Layers3,
} from "lucide-react";
import Link from "next/link";
import { codeToHtml } from "shiki";
import { CopyButton } from "./_components/landing-controls";
import { ViewerDemo } from "./_components/viewer-demo";

const snippet = `import {
  Root, Pages, Page,
  CanvasLayer, TextLayer,
} from "@anaralabs/lector";

export function Reader() {
  return (
    <Root source="/document.pdf" className="h-[600px]">
      <Pages>
        <Page>
          <CanvasLayer />
          <TextLayer />
        </Page>
      </Pages>
    </Root>
  );
}`;

export default async function Home() {
	const code = await codeToHtml(snippet, {
		lang: "tsx",
		themes: { light: "github-light", dark: "github-dark" },
		defaultColor: false,
	});
	return (
		<main id="main" className="landing-main">
			<section className="hero" aria-labelledby="hero-title">
				<div className="hero-heading">
					<h1 id="hero-title">
						PDF viewing,
						<br />
						on your terms.
					</h1>
					<div className="hero-actions">
						<Link className="primary-link" href="/docs/installation">
							Get started <ArrowRight size={16} aria-hidden="true" />
						</Link>
						<a
							className="secondary-link"
							href="https://github.com/anaralabs/lector"
						>
							View on GitHub <ArrowUpRight size={15} aria-hidden="true" />
						</a>
					</div>
				</div>
				<div className="hero-copy">
					<p className="hero-description">
						Lector is an open-source toolkit for building PDF experiences in
						React. Compose rendering, text selection, and annotations into a
						viewer that feels like part of your product.
					</p>
					<CopyButton value="npm i @anaralabs/lector pdfjs-dist" showCommand />
					<Link href="/docs/installation" className="install-note">
						React 19+ · TypeScript · Powered by PDF.js{" "}
						<ArrowUpRight size={12} aria-hidden="true" />
					</Link>
				</div>
			</section>

			<section
				className="demo-section"
				id="playground"
				aria-label="Interactive PDF viewer"
			>
				<ViewerDemo />
			</section>

			<section className="principles" aria-labelledby="principles-title">
				<h2 id="principles-title">
					All the mechanics of a PDF viewer.
					<br />
					<span>None of the decisions about your interface.</span>
				</h2>
				<div className="principle-grid">
					<article>
						<div className="feature-visual layer-visual" aria-hidden="true">
							<div>
								<Braces size={14} />
								<code>Root</code>
								<span>document.pdf</span>
							</div>
							<div>
								<Layers3 size={14} />
								<code>Pages</code>
								<span>virtualized</span>
							</div>
							<div>
								<FileText size={14} />
								<code>Page</code>
							</div>
							<div className="layer-pair">
								<code>CanvasLayer</code>
								<code>TextLayer</code>
							</div>
						</div>
						<h3>Compose your own viewer</h3>
						<p>
							Compose document state, virtualized pages, and rendering layers
							with your own React components.
						</p>
						<Link href="/docs/basic-usage">
							Meet the primitives <ArrowRight size={14} aria-hidden="true" />
						</Link>
					</article>
					<article>
						<div className="feature-visual viewport-visual" aria-hidden="true">
							<div className="virtual-page outside">
								01
								<span />
							</div>
							<div className="viewport-window">
								<span className="viewport-label">viewport</span>
								<div className="virtual-page">
									02
									<span />
								</div>
								<div className="virtual-page">
									03
									<span />
								</div>
							</div>
							<div className="virtual-page outside">
								04
								<span />
							</div>
						</div>
						<h3>Keep the document moving</h3>
						<p>
							Virtualized pages render as you read. Built-in panning and zooming
							keep large documents within reach.
						</p>
						<Link href="/docs/code/zoom-control">
							Explore the controls <ArrowRight size={14} aria-hidden="true" />
						</Link>
					</article>
					<article>
						<div className="feature-visual selection-visual" aria-hidden="true">
							<div className="selection-mini-toolbar">
								<Highlighter size={13} /> Highlight
								<span />
								<span />
								<span />
							</div>
							<p>
								We propose a new simple
								<br />
								<mark>network architecture, the Transformer</mark>
								<br />
								<span>based solely on attention mechanisms.</span>
							</p>
							<div className="selection-source">
								<FileText size={12} /> Attention Is All You Need.pdf{" "}
								<span>p. 01</span>
							</div>
						</div>
						<h3>Go beyond the canvas</h3>
						<p>
							Add text selection, search, highlights, and annotations. Every
							layer works with the same document.
						</p>
						<Link href="/docs/code/highlight">
							Explore the layers <ArrowRight size={14} aria-hidden="true" />
						</Link>
					</article>
				</div>
			</section>

			<section className="composition" aria-labelledby="composition-title">
				<div className="composition-copy">
					<h2 id="composition-title">
						A few primitives.
						<br />A working reader.
					</h2>
					<p>
						A document, its pages, and the layers you need. Familiar React
						composition, with the PDF state and rendering taken care of.
					</p>
					<Link className="secondary-link" href="/docs/basic-usage">
						Read the documentation <ArrowUpRight size={15} aria-hidden="true" />
					</Link>
				</div>
				<div className="code-panel">
					<div className="code-header">
						<span>
							<FileText size={13} />
							reader.tsx
						</span>
						<CopyButton value={snippet} />
					</div>
					<div
						className="code-content"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes this fixed, developer-authored code sample.
						dangerouslySetInnerHTML={{ __html: code }}
					/>
					<div className="code-footer">
						<Link href="/docs/installation">
							Set up the PDF.js worker{" "}
							<ArrowUpRight size={12} aria-hidden="true" />
						</Link>
					</div>
				</div>
			</section>
			<section className="closing">
				<h2>
					Build the reader
					<br />
					your product deserves.
				</h2>
				<div className="closing-actions">
					<Link className="primary-link" href="/docs/installation">
						Get started <ArrowRight size={16} aria-hidden="true" />
					</Link>
					<a
						className="secondary-link"
						href="https://github.com/anaralabs/lector"
					>
						View on GitHub <ArrowUpRight size={15} aria-hidden="true" />
					</a>
				</div>
			</section>
		</main>
	);
}
