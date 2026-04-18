interface TimerApi {
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

interface CreateActivePageControllerOptions {
	delayMs: number;
	runPush: (pageId: string) => Promise<void>;
	timer?: TimerApi;
}

export interface ActivePageController {
	schedule(pageId: string): void;
	requestImmediate(pageId: string): void;
	cancel(): void;
}

export function createActivePageController(
	options: CreateActivePageControllerOptions
): ActivePageController {
	const timer = options.timer ?? globalThis;
	let pushBusy = false;
	let debouncedPushTimeout: ReturnType<typeof setTimeout> | null = null;
	let inFlightPageId: string | null = null;
	let pendingPageId: string | null = null;

	function clearScheduledPush() {
		if (debouncedPushTimeout) {
			timer.clearTimeout(debouncedPushTimeout);
			debouncedPushTimeout = null;
		}
	}

	function requestPush(pageId: string) {
		if (pushBusy) {
			pendingPageId = pageId;
			return;
		}

		void runPush(pageId);
	}

	async function runPush(pageId: string) {
		pushBusy = true;
		inFlightPageId = pageId;

		try {
			await options.runPush(pageId);
		} finally {
			pushBusy = false;
			inFlightPageId = null;
			if (pendingPageId && pendingPageId !== pageId) {
				const nextPageId = pendingPageId;
				pendingPageId = null;
				void runPush(nextPageId);
				return;
			}

			pendingPageId = null;
		}
	}

	return {
		schedule(pageId: string) {
			if (pageId === pendingPageId || pageId === inFlightPageId) {
				return;
			}

			clearScheduledPush();
			debouncedPushTimeout = timer.setTimeout(() => {
				debouncedPushTimeout = null;
				requestPush(pageId);
			}, options.delayMs);
		},
		requestImmediate(pageId: string) {
			if (pageId === pendingPageId || pageId === inFlightPageId) {
				return;
			}

			clearScheduledPush();
			requestPush(pageId);
		},
		cancel() {
			clearScheduledPush();
		}
	};
}
