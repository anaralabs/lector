import { type RefObject, useEffect, useState } from "react";

type Listener = (visible: boolean) => void;
const targets = new Map<
	Element,
	{ listeners: Set<Listener>; visible: boolean }
>();
let observer: IntersectionObserver | undefined;

export const useVisibility = ({
	elementRef,
}: {
	elementRef: RefObject<HTMLElement | null>;
}) => {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		observer ??= new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const target = targets.get(entry.target);
				if (!target) continue;
				target.visible = entry.isIntersecting;
				for (const listener of target.listeners) listener(entry.isIntersecting);
			}
		});
		let target = targets.get(element);
		if (!target) {
			target = { listeners: new Set(), visible: false };
			targets.set(element, target);
			observer.observe(element);
		}
		const { listeners } = target;
		listeners.add(setVisible);
		setVisible(target.visible);
		return () => {
			listeners.delete(setVisible);
			if (listeners.size === 0) {
				observer?.unobserve(element);
				targets.delete(element);
			}
			if (targets.size === 0) {
				observer?.disconnect();
				observer = undefined;
			}
		};
	}, [elementRef]);
	return { visible };
};
