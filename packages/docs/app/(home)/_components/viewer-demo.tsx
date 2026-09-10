"use client";

import dynamic from "next/dynamic";

const Reader = dynamic(() => import("./landing-reader"), {
	ssr: false,
	loading: () => (
		<div className="reader-loading" role="status">
			<span className="loading-paper" />
			<span>Opening the document…</span>
		</div>
	),
});

export function ViewerDemo() {
	return (
		<div className="demo-frame">
			<Reader />
		</div>
	);
}
