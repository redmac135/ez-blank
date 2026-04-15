export interface RemoteSyncSchedulerOptions {
	debounceMs: number;
	idleMs: number;
	idleCheckMs: number;
	canSync: () => boolean;
	canRetry: () => boolean;
	isBusy: () => boolean;
	isQueued: () => boolean;
	getLastLocalMutationAt: () => number;
	setLastLocalMutationAt: (timestamp: number) => void;
	markQueued: () => void;
	onFlush: () => void;
	onOnlineReady: () => void;
	isOnline: () => boolean;
}

export class RemoteSyncScheduler {
	private readonly options: RemoteSyncSchedulerOptions;
	private debounceTimeout: ReturnType<typeof setTimeout> | null = null;
	private retryTimeout: ReturnType<typeof setTimeout> | null = null;
	private idleInterval: ReturnType<typeof setInterval> | null = null;
	private retryDelayIndex = 0;

	constructor(options: RemoteSyncSchedulerOptions) {
		this.options = options;
	}

	startIdleInterval() {
		this.clearIdleInterval();
		this.idleInterval = setInterval(() => {
			if (
				!this.options.canSync() ||
				this.options.isBusy() ||
				this.options.isQueued() ||
				this.debounceTimeout
			) {
				return;
			}

			if (Date.now() - this.options.getLastLocalMutationAt() < this.options.idleMs) {
				return;
			}

			this.options.setLastLocalMutationAt(Date.now());
			this.schedule();
		}, this.options.idleCheckMs);
	}

	clearIdleInterval() {
		if (this.idleInterval) {
			clearInterval(this.idleInterval);
			this.idleInterval = null;
		}
	}

	schedule() {
		if (!this.options.canSync()) return;

		if (this.options.isBusy()) {
			this.options.markQueued();
			return;
		}

		this.clearDebounce();
		this.debounceTimeout = setTimeout(() => {
			this.debounceTimeout = null;
			this.options.onFlush();
		}, this.options.debounceMs);
	}

	syncNow() {
		if (!this.options.canSync()) {
			return;
		}

		this.options.setLastLocalMutationAt(Date.now());
		if (this.options.isBusy()) {
			this.options.markQueued();
			return;
		}

		this.clearDebounce();
		this.options.onFlush();
	}

	clearDebounce() {
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
	}

	startRetry() {
		if (!this.options.canRetry() || this.retryTimeout) {
			return;
		}

		const retryDelays = [1000, 1000, 1000, 5000, 10000, 30000];
		const delay = retryDelays[Math.min(this.retryDelayIndex, retryDelays.length - 1)];
		this.retryDelayIndex = Math.min(this.retryDelayIndex + 1, retryDelays.length - 1);

		this.retryTimeout = setTimeout(() => {
			this.retryTimeout = null;
			if (!this.options.canRetry()) {
				this.clearRetry();
				return;
			}

			if (this.options.isOnline() && !this.options.isBusy()) {
				this.clearRetry();
				this.options.onOnlineReady();
				return;
			}

			this.startRetry();
		}, delay);
	}

	clearRetry() {
		if (this.retryTimeout) {
			clearTimeout(this.retryTimeout);
			this.retryTimeout = null;
		}
		this.retryDelayIndex = 0;
	}

	dispose() {
		this.clearDebounce();
		this.clearRetry();
		this.clearIdleInterval();
	}
}
