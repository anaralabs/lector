import type { ErrorCode, ErrorPhase } from "./protocol";

/** Errors `createViewer` rejects with; the same `code`/`phase` as `error` events. */
export class EngineError extends Error {
	constructor(
		message: string,
		readonly code: ErrorCode,
		readonly phase: ErrorPhase,
		/** the source that failed (a URL), when there is one */
		readonly source?: string,
	) {
		super(message);
		this.name = "EngineError";
	}
}
