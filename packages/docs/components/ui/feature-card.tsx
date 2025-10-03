import type { LucideIcon } from "lucide-react";

interface FeatureCardProps {
	icon: LucideIcon;
	title: string;
	description: string;
}

export function FeatureCard({
	icon: Icon,
	title,
	description,
}: FeatureCardProps) {
	return (
		<div className="group relative overflow-hidden rounded-lg border bg-background p-6 shadow-md transition-shadow hover:shadow-lg">
			<div className="flex flex-col items-center space-y-4">
				<div className="rounded-full bg-primary/10 p-3 ring-1 ring-primary/20 transition-colors group-hover:bg-primary/20">
					<Icon className="h-6 w-6 text-primary" />
				</div>
				<h3 className="text-xl font-bold">{title}</h3>
				<p className="text-center text-sm text-muted-foreground">
					{description}
				</p>
			</div>
		</div>
	);
}
