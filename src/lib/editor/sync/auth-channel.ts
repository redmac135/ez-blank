interface AuthChannelMessage {
	type: 'auth-session-updated';
	sourceTabId: string;
	userId: string | null;
}

export interface AuthSyncChannelOptions {
	channelName: string;
	tabId: string;
	getCurrentUserId: () => string | null;
	onRemoteAuthChanged: () => void;
}

export class AuthSyncChannel {
	private readonly options: AuthSyncChannelOptions;
	private channel: BroadcastChannel | null = null;

	constructor(options: AuthSyncChannelOptions) {
		this.options = options;
	}

	open() {
		if (typeof BroadcastChannel === 'undefined') {
			return;
		}

		this.close();
		this.channel = new BroadcastChannel(this.options.channelName);
		this.channel.onmessage = (event) => {
			const message = event.data as Partial<AuthChannelMessage> | null;
			if (!message || message.type !== 'auth-session-updated') {
				return;
			}
			if (typeof message.sourceTabId === 'string' && message.sourceTabId === this.options.tabId) {
				return;
			}

			const currentUserId = this.options.getCurrentUserId();
			if (typeof message.userId === 'string' && message.userId === currentUserId) {
				return;
			}
			if (message.userId === null && currentUserId === null) {
				return;
			}

			this.options.onRemoteAuthChanged();
		};
	}

	broadcast(userId: string | null) {
		if (!this.channel) {
			return;
		}

		const message: AuthChannelMessage = {
			type: 'auth-session-updated',
			sourceTabId: this.options.tabId,
			userId
		};
		this.channel.postMessage(message);
	}

	close() {
		if (!this.channel) {
			return;
		}
		this.channel.close();
		this.channel = null;
	}
}
