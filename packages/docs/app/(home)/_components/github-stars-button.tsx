"use client";

import clsx from "clsx";
import { Star } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type Props = {
	className?: string;
};

export const GithubStarsButton = ({ className }: Props) => {
	const [stars, setStars] = useState<string>();

	useEffect(() => {
		const fetchStars = async () => {
			const res = await fetch("https://api.github.com/repos/anaralabs/lector");
			const data = (await res.json()) as { stargazers_count: number };
			if (typeof data?.stargazers_count === "number") {
				setStars(new Intl.NumberFormat().format(data.stargazers_count));
			}
		};
		fetchStars().catch(console.error);
	}, []);

	return (
		<Link href="https://github.com/anaralabs/lector/stargazers" target="_blank">
			<Button variant="secondary" className={className}>
				<Icon as={Star} className="h-4 w-4" />
				<span>Star</span>
				<span
					style={{ transition: "max-width 1s, opacity 1s" }}
					className={clsx(
						"w-full overflow-hidden whitespace-nowrap",
						stars ? "max-w-[100px] opacity-100" : "max-w-0 opacity-0",
					)}
				>
					{stars}
				</span>
			</Button>
		</Link>
	);
};
