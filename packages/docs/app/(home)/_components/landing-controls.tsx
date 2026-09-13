"use client";

import { ThemeToggle as BaseThemeToggle } from "fumadocs-ui/components/layout/theme-toggle";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ThemeToggle() {
	return <BaseThemeToggle className="icon-button theme-toggle" />;
}

export function CopyButton({
	value,
	label = "Copy code",
	showCommand = false,
}: {
	value: string;
	label?: string;
	showCommand?: boolean;
}) {
	const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			setStatus("copied");
		} catch {
			setStatus("error");
		}
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setStatus("idle"), 2500);
	}
	return (
		<div className={showCommand ? "install-wrap" : "copy-wrap"}>
			<button
				type="button"
				onClick={copy}
				className={showCommand ? "install-command" : "icon-button"}
				aria-label={status === "copied" ? "Copied" : label}
			>
				{showCommand ? (
					<>
						<span className="command-prefix" aria-hidden="true">
							$
						</span>
						<code>{value}</code>
					</>
				) : null}
				<span className="copy-icon" data-copied={status === "copied"}>
					<Copy size={14} />
					<Check size={14} />
				</span>
			</button>
			<span className="copy-status" role="status">
				{status === "copied"
					? "Copied to clipboard"
					: status === "error"
						? "Couldn’t copy. Select and copy the text."
						: ""}
			</span>
		</div>
	);
}
