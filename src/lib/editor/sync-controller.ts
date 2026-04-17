export interface SyncRequestOptions {
	showSuccessNotice: boolean;
}

interface TimerApi {
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

interface CreateSyncControllerOptions {
	delayMs: number;
	runSync: (options: SyncRequestOptions) => Promise<void>;
	timer?: TimerApi;
}

export interface SyncController {
	scheduleDebounced(): void;
	requestImmediate(options?: Partial<SyncRequestOptions>): void;
	queueFollowUp(options?: Partial<SyncRequestOptions>): void;
	cancel(): void;
}

const DEFAULT_OPTIONS: SyncRequestOptions = {
	showSuccessNotice: false
};

export function createSyncController(options: CreateSyncControllerOptions): SyncController {
	const timer = options.timer ?? globalThis;
	let syncBusy = false;
	let pendingAfterCurrent = false;
	let pendingShowSuccessNotice = false;
	let debouncedSyncTimeout: ReturnType<typeof setTimeout> | null = null;

	function normalizeOptions(input?: Partial<SyncRequestOptions>): SyncRequestOptions {
		return {
			...DEFAULT_OPTIONS,
			...input
		};
	}

	function clearScheduledSync() {
		if (debouncedSyncTimeout) {
			timer.clearTimeout(debouncedSyncTimeout);
			debouncedSyncTimeout = null;
		}
	}

	function requestSync(requestOptions: SyncRequestOptions) {
		if (syncBusy) {
			pendingAfterCurrent = true;
			pendingShowSuccessNotice ||= requestOptions.showSuccessNotice;
			return;
		}

		void runSync(requestOptions);
	}

	async function runSync(requestOptions: SyncRequestOptions) {
		syncBusy = true;

		try {
			await options.runSync(requestOptions);
		} finally {
			syncBusy = false;
			if (pendingAfterCurrent) {
				const showSuccessNotice = pendingShowSuccessNotice;
				pendingAfterCurrent = false;
				pendingShowSuccessNotice = false;
				void runSync({ showSuccessNotice });
			}
		}
	}

	return {
		scheduleDebounced() {
			clearScheduledSync();
			debouncedSyncTimeout = timer.setTimeout(() => {
				debouncedSyncTimeout = null;
				requestSync(DEFAULT_OPTIONS);
			}, options.delayMs);
		},
		requestImmediate(input) {
			clearScheduledSync();
			requestSync(normalizeOptions(input));
		},
		queueFollowUp(input) {
			requestSync(normalizeOptions(input));
		},
		cancel() {
			clearScheduledSync();
		}
	};
}
