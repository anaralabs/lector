import type { LucideIcon, LucideProps } from "lucide-react";
import type { MouseEventHandler } from "react";
import { cn } from "@/lib/utils";

export interface IconProps {
	as: LucideIcon | ((props: LucideProps) => React.JSX.Element) | null;
	size?: "xs" | "sm" | "md" | "lg" | "xl";
	className?: string | boolean;
	onClick?: MouseEventHandler<SVGSVGElement>;
	strokeWidth?: number; // Added strokeWidth prop
}

const sizes = {
	xs: 12,
	sm: 14,
	md: 15,
	lg: 20,
	xl: 24,
};

export const Icon = ({
	as: IconComponent,
	size = "md",
	className,
	onClick,
	strokeWidth = 2,
}: IconProps) => {
	if (!IconComponent) return null;
	return (
		<IconComponent
			onClick={onClick}
			width={sizes[size]}
			height={sizes[size]}
			className={cn(className)}
			strokeWidth={strokeWidth}
		/>
	);
};
