/**
 * Upload order: 0 a visible page's base bitmap or its preview, 1 a planned sharp tile on a
 * visible page, 2 other planned tiles, 3 unplanned fallbacks (only leftover budget).
 */
export function uploadRank(tile: { page: number; scale: number; lastWanted: number }, visible: readonly number[], frameId: number, baseScale: number, targetScale: number) {
	if (tile.lastWanted !== frameId) return 3;
	if (!visible.includes(tile.page)) return 2;
	return tile.scale <= baseScale ? 0 : tile.scale === targetScale ? 1 : 2;
}
