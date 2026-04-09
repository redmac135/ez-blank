import { createSession, normalizeSession, type EditorSession } from './session';

export class EditorStorage {
	public static STORAGE_KEY = 'ez-blank-session-v2';
	public static LEGACY_STORAGE_KEY = 'ez-blank-session-v1';
	public static ACTIVE_PAGE_KEY = 'ez-blank-active-page-v1';

	static save(session: EditorSession) {
		try {
			const serialized = JSON.stringify({ pages: session.pages });
			localStorage.setItem(this.STORAGE_KEY, serialized);
			sessionStorage.setItem(this.ACTIVE_PAGE_KEY, session.activePageId);
		} catch (e) {
			console.error('Failed to save editor session:', e);
		}
	}

	static load(): EditorSession {
		try {
			const current = localStorage.getItem(this.STORAGE_KEY);
			if (current) {
				return this.applyLocalActivePage(normalizeSession(JSON.parse(current)) ?? createSession());
			}

			const legacy = localStorage.getItem(this.LEGACY_STORAGE_KEY);
			if (legacy) {
				const migrated = normalizeSession(JSON.parse(legacy)) ?? createSession();
				this.save(migrated);
				localStorage.removeItem(this.LEGACY_STORAGE_KEY);
				return this.applyLocalActivePage(migrated);
			}

			return this.applyLocalActivePage(createSession());
		} catch (e) {
			console.error('Failed to load editor session:', e);
			return this.applyLocalActivePage(createSession());
		}
	}

	private static applyLocalActivePage(session: EditorSession): EditorSession {
		const localActivePageId = sessionStorage.getItem(this.ACTIVE_PAGE_KEY);
		const activePageId =
			typeof localActivePageId === 'string' &&
			session.pages.some((page) => page.id === localActivePageId)
				? localActivePageId
				: session.activePageId;

		if (activePageId !== localActivePageId) {
			sessionStorage.setItem(this.ACTIVE_PAGE_KEY, activePageId);
		}

		return {
			...session,
			activePageId
		};
	}
}
