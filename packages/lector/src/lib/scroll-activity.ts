// Tiny shared tracker for "is the user actively scrolling a viewport right
// now". The scroll rAF in useObserveElement bumps `lastScrollAt` on every
// frame that carries a fresh offset; render paths consult `msSinceScroll()`
// to decide whether they should start a heavy pdfjs render now or wait for
// the flick to settle.
//
// This is intentionally module-global. There's one scrolling user per
// viewport per page, and viewers don't nest meaningfully.

let lastScrollAt = 0;

export function notifyScrollActivity(): void {
	lastScrollAt =
		typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function msSinceScroll(): number {
	const now =
		typeof performance !== "undefined" ? performance.now() : Date.now();
	return now - lastScrollAt;
}

export function isScrollActive(idleMs = 120): boolean {
	return msSinceScroll() < idleMs;
}
