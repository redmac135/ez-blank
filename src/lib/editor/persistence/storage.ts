import type { CountVisibility, EditorPreferences, ThemeMode } from '../core/preferences';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../core/preferences';
import {
	createPage,
	createSession,
	normalizeSession,
	type EditorPage,
	type EditorSession
} from '../core/session';
import {
	ANONYMOUS_USERID,
	BLANK_DB_NAME,
	BLANK_DB_VERSION,
	NOTES_STORE_NAME,
	SETTINGS_STORE_NAME,
	SETTING_ACTIVE_PAGE_ID,
	SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT,
	SETTING_SPELLCHECK_ENABLED,
	SETTING_THEME,
	SETTING_WORD_COUNT_VISIBILITY,
	USER_ID_INDEX,
	type NoteRecord,
	type SettingRecord
} from './records';

export class EditorStorage {
	private static backendPromise: Promise<StorageBackend> | null = null;
	private static memoryBackend = createMemoryBackend();

	static async saveAnonymousState(session: EditorSession) {
		await this.saveUserState(ANONYMOUS_USERID, session);
	}

	static async loadAnonymousState(): Promise<EditorSession> {
		return (await this.loadUserState(ANONYMOUS_USERID)) ?? createSession(ANONYMOUS_USERID);
	}

	static async saveUserState(userId: string, session: EditorSession) {
		const backend = await this.getBackend();
		await backend.saveSession(userId, session);
	}

	static async loadUserState(userId: string): Promise<EditorSession | null> {
		try {
			const backend = await this.getBackend();
			return await backend.loadSession(userId);
		} catch (error) {
			console.error('Failed to load user editor session:', error);
			return null;
		}
	}

	static async loadAnonymousPage(pageId: string): Promise<EditorPage | null> {
		return this.loadUserPage(ANONYMOUS_USERID, pageId);
	}

	static async loadUserPage(userId: string, pageId: string): Promise<EditorPage | null> {
		const backend = await this.getBackend();
		return backend.loadPage(userId, pageId);
	}

	static async loadPreferences(userId = ANONYMOUS_USERID): Promise<EditorPreferences> {
		try {
			const backend = await this.getBackend();
			const [themeMode, countVisibility, spellcheckEnabled] = await Promise.all([
				backend.getSetting<ThemeMode>(userId, SETTING_THEME),
				backend.getSetting<CountVisibility>(userId, SETTING_WORD_COUNT_VISIBILITY),
				backend.getSetting<boolean>(userId, SETTING_SPELLCHECK_ENABLED)
			]);

			return normalizePreferences({
				themeMode,
				countVisibility,
				spellcheckEnabled
			});
		} catch (error) {
			console.error('Failed to load editor preferences:', error);
			return DEFAULT_PREFERENCES;
		}
	}

	static async savePreferences(userId: string, preferences: EditorPreferences) {
		try {
			const backend = await this.getBackend();
			await Promise.all([
				backend.setSetting(userId, SETTING_THEME, preferences.themeMode),
				backend.setSetting(userId, SETTING_WORD_COUNT_VISIBILITY, preferences.countVisibility),
				backend.setSetting(userId, SETTING_SPELLCHECK_ENABLED, preferences.spellcheckEnabled)
			]);
		} catch (error) {
			console.error('Failed to save editor preferences:', error);
		}
	}

	static async hasPromptedForAnonymousImport(userId: string): Promise<boolean> {
		try {
			const backend = await this.getBackend();
			return (await backend.getSetting<boolean>(userId, SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT)) === true;
		} catch (error) {
			console.error('Failed to load anonymous import prompt status:', error);
			return false;
		}
	}

	static async markPromptedForAnonymousImport(userId: string) {
		try {
			const backend = await this.getBackend();
			await backend.setSetting(userId, SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT, true);
		} catch (error) {
			console.error('Failed to save anonymous import prompt status:', error);
		}
	}

	static resetForTests() {
		this.backendPromise = null;
		this.memoryBackend = createMemoryBackend();
	}

	private static async getBackend(): Promise<StorageBackend> {
		if (!this.backendPromise) {
			this.backendPromise = typeof indexedDB === 'undefined' ? Promise.resolve(this.memoryBackend) : createIndexedDbBackend();
		}

		return this.backendPromise;
	}
}

interface StorageBackend {
	saveSession(userId: string, session: EditorSession): Promise<void>;
	loadSession(userId: string): Promise<EditorSession | null>;
	loadPage(userId: string, pageId: string): Promise<EditorPage | null>;
	getSetting<T>(userId: string, key: string): Promise<T | undefined>;
	setSetting(userId: string, key: string, value: unknown): Promise<void>;
}

function createMemoryBackend(): StorageBackend {
	const notes = new Map<string, NoteRecord>();
	const settings = new Map<string, SettingRecord>();

	return {
		async saveSession(userId: string, session: EditorSession) {
			const nextKeys = new Set(session.pages.map((page) => buildCompositeKey(userId, page.id)));
			for (const key of [...notes.keys()]) {
				if (key.startsWith(`${userId}::`) && !nextKeys.has(key)) {
					notes.delete(key);
				}
			}

			for (const page of session.pages) {
				notes.set(buildCompositeKey(userId, page.id), toNoteRecord(page, userId));
			}

			settings.set(buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID), createSettingRecord(userId, SETTING_ACTIVE_PAGE_ID, session.activePageId));
		},
		async loadSession(userId: string) {
			const userNotes = [...notes.values()]
				.filter((note) => note.userId === userId)
				.sort(compareNotes)
				.map((note) => toEditorPage(note));

			if (userNotes.length === 0) {
				return null;
			}

			const activePageId = settings.get(buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID))?.value;
			return normalizeSession(
				{ pages: userNotes, activePageId: typeof activePageId === 'string' ? activePageId : userNotes[0].id },
				userId
			);
		},
		async loadPage(userId: string, pageId: string) {
			const note = notes.get(buildCompositeKey(userId, pageId));
			return note ? toEditorPage(note) : null;
		},
		async getSetting<T>(userId: string, key: string) {
			return settings.get(buildCompositeKey(userId, key))?.value as T | undefined;
		},
		async setSetting(userId: string, key: string, value: unknown) {
			settings.set(buildCompositeKey(userId, key), createSettingRecord(userId, key, value));
		}
	};
}

async function createIndexedDbBackend(): Promise<StorageBackend> {
	const db = await openDatabase();

	return {
		async saveSession(userId: string, session: EditorSession) {
			const tx = db.transaction([NOTES_STORE_NAME, SETTINGS_STORE_NAME], 'readwrite');
			const notesStore = tx.objectStore(NOTES_STORE_NAME);
			const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
			const userIndex = notesStore.index(USER_ID_INDEX);
			const existing = await requestToPromise<NoteRecord[]>(userIndex.getAll(IDBKeyRange.only(userId)));
			const nextIds = new Set(session.pages.map((page) => page.id));

			for (const note of existing) {
				if (!nextIds.has(note.id)) {
					notesStore.delete([userId, note.id]);
				}
			}

			for (const page of session.pages) {
				notesStore.put(toNoteRecord(page, userId));
			}

			settingsStore.put(createSettingRecord(userId, SETTING_ACTIVE_PAGE_ID, session.activePageId));
			await transactionToPromise(tx);
		},
		async loadSession(userId: string) {
			const tx = db.transaction([NOTES_STORE_NAME, SETTINGS_STORE_NAME], 'readonly');
			const notesStore = tx.objectStore(NOTES_STORE_NAME);
			const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
			const userIndex = notesStore.index(USER_ID_INDEX);

			const [notes, activePageSetting] = await Promise.all([
				requestToPromise<NoteRecord[]>(userIndex.getAll(IDBKeyRange.only(userId))),
				requestToPromise<SettingRecord | undefined>(settingsStore.get([userId, SETTING_ACTIVE_PAGE_ID]))
			]);
			await transactionToPromise(tx);

			if (notes.length === 0) {
				return null;
			}

			return normalizeSession(
				{
					pages: notes.sort(compareNotes).map((note) => toEditorPage(note)),
					activePageId:
						typeof activePageSetting?.value === 'string'
							? activePageSetting.value
							: notes[0]!.id
				},
				userId
			);
		},
		async loadPage(userId: string, pageId: string) {
			const tx = db.transaction(NOTES_STORE_NAME, 'readonly');
			const note = await requestToPromise<NoteRecord | undefined>(
				tx.objectStore(NOTES_STORE_NAME).get([userId, pageId])
			);
			await transactionToPromise(tx);
			return note ? toEditorPage(note) : null;
		},
		async getSetting<T>(userId: string, key: string) {
			const tx = db.transaction(SETTINGS_STORE_NAME, 'readonly');
			const setting = await requestToPromise<SettingRecord | undefined>(
				tx.objectStore(SETTINGS_STORE_NAME).get([userId, key])
			);
			await transactionToPromise(tx);
			return setting?.value as T | undefined;
		},
		async setSetting(userId: string, key: string, value: unknown) {
			const tx = db.transaction(SETTINGS_STORE_NAME, 'readwrite');
			tx.objectStore(SETTINGS_STORE_NAME).put(createSettingRecord(userId, key, value));
			await transactionToPromise(tx);
		}
	};
}

async function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(BLANK_DB_NAME, BLANK_DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(NOTES_STORE_NAME)) {
				const notesStore = db.createObjectStore(NOTES_STORE_NAME, {
					keyPath: ['userId', 'id']
				});
				notesStore.createIndex(USER_ID_INDEX, 'userId', { unique: false });
			}

			if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
				const settingsStore = db.createObjectStore(SETTINGS_STORE_NAME, {
					keyPath: ['userId', 'key']
				});
				settingsStore.createIndex(USER_ID_INDEX, 'userId', { unique: false });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function buildCompositeKey(left: string, right: string) {
	return `${left}::${right}`;
}

function toNoteRecord(page: EditorPage, userId: string): NoteRecord {
	return {
		id: page.id,
		userId,
		title: page.title,
		content: page.content,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		deletedAt: page.deletedAt,
		lastSyncedAt: page.lastSyncedAt,
		lastKnownRemoteUpdatedAt: page.lastKnownRemoteUpdatedAt,
		lastKnownRemoteDeletedAt: page.lastKnownRemoteDeletedAt,
		syncStatus: page.syncStatus
	};
}

function toEditorPage(note: NoteRecord): EditorPage {
	const page = createPage(note.content, {
		id: note.id,
		userId: note.userId,
		now: note.createdAt
	});

	return {
		...page,
		title: note.title,
		content: note.content,
		text: note.content,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		deletedAt: note.deletedAt,
		lastSyncedAt: note.lastSyncedAt,
		lastKnownRemoteUpdatedAt: note.lastKnownRemoteUpdatedAt,
		lastKnownRemoteDeletedAt: note.lastKnownRemoteDeletedAt,
		syncStatus: note.syncStatus
	};
}

function createSettingRecord(userId: string, key: string, value: unknown): SettingRecord {
	return {
		userId,
		key,
		value,
		updatedAt: new Date().toISOString()
	};
}

function compareNotes(left: NoteRecord, right: NoteRecord) {
	if (left.createdAt !== right.createdAt) {
		return left.createdAt.localeCompare(right.createdAt);
	}

	return left.id.localeCompare(right.id);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});
}
