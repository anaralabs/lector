"use client";

import dynamic from "next/dynamic";
import { ReaderLoading } from "./reader-loading";

const Reader = dynamic(() => import("./landing-reader"), {
	ssr: false,
	loading: () => <ReaderLoading />,
});

export function ViewerDemo() {
	return (
		<div className="demo-frame">
			<Reader />
		</div>
	);
}
