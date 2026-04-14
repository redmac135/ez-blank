import { createSession, normalizeSession, type EditorSession } from './session';

export interface UserSyncMeta {
	dirty: boolean;
	lastSyncedAt: string | null;
}

const DEFAULT_SYNC_META: UserSyncMeta = {
	dirty: false,
	lastSyncedAt: null
};

export class EditorStorage {
	public static ANONYMOUS_STATE_KEY = 'blank-state:anonymous';
	public static USER_STATE_KEY_PREFIX = 'blank-state:user:';
	public static USER_SYNC_META_KEY_PREFIX = 'blank-sync-meta:user:';
	public static PROMPTED_USER_IDS_KEY = 'blank-anonymous-import-prompted-user-ids';
	public static LEGACY_STORAGE_KEY = 'ez-blank-session-v2';

	static getAnonymousStateKey() {
		return this.ANONYMOUS_STATE_KEY;
	}

	static getUserStateKey(userId: string) {
		return `${this.USER_STATE_KEY_PREFIX}${userId}`;
	}

	static getUserSyncMetaKey(userId: string) {
		return `${this.USER_SYNC_META_KEY_PREFIX}${userId}`;
	}

	static saveAnonymousState(session: EditorSession) {
		this.saveSession(this.getAnonymousStateKey(), session);
	}

	static loadAnonymousState(): EditorSession {
		try {
			const current = localStorage.getItem(this.getAnonymousStateKey());
			if (current) {
				return this.deserializeSession(current) ?? createSession();
			}

			const migrated = this.loadLegacyAnonymousState();
			if (migrated) {
				this.saveAnonymousState(migrated);
				return migrated;
			}

			return createSession();
		} catch (e) {
			console.error('Failed to load anonymous editor session:', e);
			return createSession();
		}
	}

	static saveUserState(userId: string, session: EditorSession) {
		this.saveSession(this.getUserStateKey(userId), session);
	}

	static loadUserState(userId: string): EditorSession | null {
		try {
			const stored = localStorage.getItem(this.getUserStateKey(userId));
			return stored ? this.deserializeSession(stored) : null;
		} catch (e) {
			console.error('Failed to load user editor session:', e);
			return null;
		}
	}

	static saveUserSyncMeta(userId: string, meta: UserSyncMeta) {
		try {
			localStorage.setItem(this.getUserSyncMetaKey(userId), JSON.stringify(meta));
		} catch (e) {
			console.error('Failed to save user sync meta:', e);
		}
	}

	static loadUserSyncMeta(userId: string): UserSyncMeta {
		try {
			const stored = localStorage.getItem(this.getUserSyncMetaKey(userId));
			if (!stored) {
				return DEFAULT_SYNC_META;
			}

			const parsed = JSON.parse(stored);
			return {
				dirty: parsed?.dirty === true,
				lastSyncedAt: typeof parsed?.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null
			};
		} catch (e) {
			console.error('Failed to load user sync meta:', e);
			return DEFAULT_SYNC_META;
		}
	}

	static loadPromptedUserIds(): string[] {
		try {
			const stored = localStorage.getItem(this.PROMPTED_USER_IDS_KEY);
			if (!stored) {
				return [];
			}

			const parsed = JSON.parse(stored);
			return Array.isArray(parsed)
				? parsed.filter((value): value is string => typeof value === 'string')
				: [];
		} catch (e) {
			console.error('Failed to load prompted user ids:', e);
			return [];
		}
	}

	static hasPromptedUserId(userId: string): boolean {
		return this.loadPromptedUserIds().includes(userId);
	}

	static markPromptedUserId(userId: string) {
		try {
			const promptedUserIds = this.loadPromptedUserIds();
			if (promptedUserIds.includes(userId)) {
				return;
			}

			localStorage.setItem(
				this.PROMPTED_USER_IDS_KEY,
				JSON.stringify([...promptedUserIds, userId])
			);
		} catch (e) {
			console.error('Failed to save prompted user ids:', e);
		}
	}

	private static saveSession(key: string, session: EditorSession) {
		try {
			const serialized = JSON.stringify({
				pages: session.pages,
				activePageId: session.activePageId
			});
			localStorage.setItem(key, serialized);
		} catch (e) {
			console.error('Failed to save editor session:', e);
		}
	}

	private static deserializeSession(serialized: string): EditorSession | null {
		return normalizeSession(JSON.parse(serialized));
	}

	private static loadLegacyAnonymousState(): EditorSession | null {
		const current = localStorage.getItem(this.LEGACY_STORAGE_KEY);
		if (!current) {
			return null;
		}

		localStorage.removeItem(this.LEGACY_STORAGE_KEY);
		return this.deserializeSession(current);
	}
}
