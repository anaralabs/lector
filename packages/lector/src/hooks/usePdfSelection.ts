import { useMemo, useSyncExternalStore } from "react";
import { usePdf } from "../internal";

/** Selection anchors survive virtualized text-layer removal. */
export function usePdfSelection() {
	const controller = usePdf((state) => state.selection);
	const selection = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);
	return useMemo(
		() => ({
			selection,
			setSelection: controller.setSelection,
			clearSelection: controller.clear,
			getText: controller.getText,
			getSelection: controller.getSelection,
			getSelectionAsync: controller.getSelectionAsync,
		}),
		[controller, selection],
	);
}
