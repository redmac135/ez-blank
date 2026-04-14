import type { Session } from '@supabase/supabase-js';

export interface SavedAuthSession {
	userId: string;
	email: string | null;
	session: Session;
	savedAt: string;
}

const ACTIVE_SESSION_KEYS_KEY = 'blank-auth-active-session-keys';
const ACTIVE_SESSION_STORAGE_PREFIX = 'blank-auth-active-session:';
const SAVED_SESSIONS_KEY = 'blank-auth-saved-sessions';

export const activeAuthStorage = {
	getItem(key: string) {
		return getStorage().getItem(getActiveSessionStorageKey(key));
	},
	setItem(key: string, value: string) {
		getStorage().setItem(getActiveSessionStorageKey(key), value);
		saveActiveSessionKeyName(key);
	},
	removeItem(key: string) {
		getStorage().removeItem(getActiveSessionStorageKey(key));
		removeActiveSessionKeyName(key);
	}
};

export function clearActiveAuthSession() {
	for (const key of loadActiveSessionKeyNames()) {
		getStorage().removeItem(getActiveSessionStorageKey(key));
	}

	getStorage().removeItem(ACTIVE_SESSION_KEYS_KEY);
}

export function loadSavedAuthSessions(): SavedAuthSession[] {
	try {
		const stored = getStorage().getItem(SAVED_SESSIONS_KEY);
		if (!stored) {
			return [];
		}

		const parsed = JSON.parse(stored);
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed.filter(isSavedAuthSession);
	} catch {
		return [];
	}
}

export function saveAuthSession(session: Session) {
	const nextSession: SavedAuthSession = {
		userId: session.user.id,
		email: session.user.email ?? null,
		session,
		savedAt: new Date().toISOString()
	};
	const sessions = loadSavedAuthSessions().filter(
		(savedSession) => savedSession.userId !== nextSession.userId
	);

	getStorage().setItem(SAVED_SESSIONS_KEY, JSON.stringify([...sessions, nextSession]));
}

export function removeSavedAuthSession(userId: string) {
	const sessions = loadSavedAuthSessions().filter((savedSession) => savedSession.userId !== userId);
	getStorage().setItem(SAVED_SESSIONS_KEY, JSON.stringify(sessions));
}

export function findSavedAuthSessionByEmail(email: string): SavedAuthSession | null {
	const normalizedEmail = email.trim().toLowerCase();
	return (
		loadSavedAuthSessions().find(
			(savedSession) => savedSession.email?.toLowerCase() === normalizedEmail
		) ?? null
	);
}

function isSavedAuthSession(value: unknown): value is SavedAuthSession {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const record = value as Record<string, unknown>;
	return (
		typeof record.userId === 'string' &&
		(typeof record.email === 'string' || record.email === null) &&
		typeof record.savedAt === 'string' &&
		!!record.session &&
		typeof record.session === 'object'
	);
}

function getActiveSessionStorageKey(key: string) {
	return `${ACTIVE_SESSION_STORAGE_PREFIX}${key}`;
}

function loadActiveSessionKeyNames(): string[] {
	try {
		const stored = getStorage().getItem(ACTIVE_SESSION_KEYS_KEY);
		if (!stored) {
			return [];
		}

		const parsed = JSON.parse(stored);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: [];
	} catch {
		return [];
	}
}

function saveActiveSessionKeyName(key: string) {
	const keys = loadActiveSessionKeyNames();
	if (keys.includes(key)) {
		return;
	}

	getStorage().setItem(ACTIVE_SESSION_KEYS_KEY, JSON.stringify([...keys, key]));
}

function removeActiveSessionKeyName(key: string) {
	const keys = loadActiveSessionKeyNames().filter((entry) => entry !== key);
	if (keys.length === 0) {
		getStorage().removeItem(ACTIVE_SESSION_KEYS_KEY);
		return;
	}

	getStorage().setItem(ACTIVE_SESSION_KEYS_KEY, JSON.stringify(keys));
}

function getStorage(): Storage {
	if (typeof localStorage !== 'undefined') {
		return localStorage;
	}

	return noopStorage;
}

const noopStorage: Storage = {
	get length() {
		return 0;
	},
	clear() {},
	getItem() {
		return null;
	},
	key() {
		return null;
	},
	removeItem() {},
	setItem() {}
};
