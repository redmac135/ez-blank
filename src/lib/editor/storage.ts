import { createSession, normalizeSession, type EditorSession } from './session';

export class EditorStorage {
	public static STORAGE_KEY = 'ez-blank-session-v2';
	public static LEGACY_STORAGE_KEY = 'ez-blank-session-v1';

	static save(session: EditorSession) {
		try {
			const serialized = JSON.stringify(session);
			localStorage.setItem(this.STORAGE_KEY, serialized);
		} catch (e) {
			console.error('Failed to save editor session:', e);
		}
	}

	static load(): EditorSession {
		try {
			const current = localStorage.getItem(this.STORAGE_KEY);
			if (current) {
				return normalizeSession(JSON.parse(current)) ?? createSession();
			}

			const legacy = localStorage.getItem(this.LEGACY_STORAGE_KEY);
			if (legacy) {
				const migrated = normalizeSession(JSON.parse(legacy)) ?? createSession();
				this.save(migrated);
				localStorage.removeItem(this.LEGACY_STORAGE_KEY);
				return migrated;
			}

			return createSession();
		} catch (e) {
			console.error('Failed to load editor session:', e);
			return createSession();
		}
	}
}
