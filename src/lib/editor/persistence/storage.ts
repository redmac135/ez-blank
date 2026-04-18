import type { CountVisibility, EditorPreferences, ThemeMode } from '../core/preferences';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../core/preferences';
import {
	createPage,
	createSession,
	normalizeSession,
	sortPagesByRecency,
	type EditorPage,
	type EditorSession
} from '../core/session';
import {
	ANONYMOUS_USERID,
	BLANK_DB_NAME,
	BLANK_DB_VERSION,
	PAGES_STORE_NAME,
	SETTINGS_STORE_NAME,
	SETTING_ACTIVE_PAGE_ID,
	SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT,
	SETTING_SPELLCHECK_ENABLED,
	SETTING_THEME,
	SETTING_WORD_COUNT_VISIBILITY,
	USER_ID_INDEX,
	UPDATED_AT_INDEX,
	type PageRecord,
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
			this.backendPromise =
				typeof indexedDB === 'undefined' ? Promise.resolve(this.memoryBackend) : createIndexedDbBackend();
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
	const pages = new Map<string, PageRecord>();
	const settings = new Map<string, SettingRecord>();

	return {
		async saveSession(userId: string, session: EditorSession) {
			const nextKeys = new Set(session.pages.map((page) => buildCompositeKey(userId, page.id)));
			for (const key of [...pages.keys()]) {
				if (key.startsWith(`${userId}::`) && !nextKeys.has(key)) {
					pages.delete(key);
				}
			}

			for (const page of session.pages) {
				pages.set(buildCompositeKey(userId, page.id), toPageRecord(page, userId));
			}

			settings.set(
				buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID),
				createSettingRecord(userId, SETTING_ACTIVE_PAGE_ID, session.activePageId)
			);
		},
		async loadSession(userId: string) {
			const userPages = sortPagesByRecency(
				[...pages.values()].filter((page) => page.userId === userId).map((page) => toEditorPage(page))
			);

			if (userPages.length === 0) {
				return null;
			}

			const activePageId = settings.get(buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID))?.value;
			return normalizeSession(
				{ pages: userPages, activePageId: typeof activePageId === 'string' ? activePageId : userPages[0].id },
				userId
			);
		},
		async loadPage(userId: string, pageId: string) {
			const page = pages.get(buildCompositeKey(userId, pageId));
			return page ? toEditorPage(page) : null;
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
			const tx = db.transaction([PAGES_STORE_NAME, SETTINGS_STORE_NAME], 'readwrite');
			const pagesStore = tx.objectStore(PAGES_STORE_NAME);
			const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
			const userIndex = pagesStore.index(USER_ID_INDEX);
			const existing = await requestToPromise<PageRecord[]>(userIndex.getAll(IDBKeyRange.only(userId)));
			const nextIds = new Set(session.pages.map((page) => page.id));

			for (const page of existing) {
				if (!nextIds.has(page.id)) {
					pagesStore.delete([userId, page.id]);
				}
			}

			for (const page of session.pages) {
				pagesStore.put(toPageRecord(page, userId));
			}

			settingsStore.put(createSettingRecord(userId, SETTING_ACTIVE_PAGE_ID, session.activePageId));
			await transactionToPromise(tx);
		},
		async loadSession(userId: string) {
			const tx = db.transaction([PAGES_STORE_NAME, SETTINGS_STORE_NAME], 'readonly');
			const pagesStore = tx.objectStore(PAGES_STORE_NAME);
			const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
			const updatedAtIndex = pagesStore.index(UPDATED_AT_INDEX);

			const [pages, activePageSetting] = await Promise.all([
				readPagesByUpdatedAtDesc(updatedAtIndex, userId),
				requestToPromise<SettingRecord | undefined>(settingsStore.get([userId, SETTING_ACTIVE_PAGE_ID]))
			]);
			await transactionToPromise(tx);

			if (pages.length === 0) {
				return null;
			}

			return normalizeSession(
				{
					pages: pages.map((page) => toEditorPage(page)),
					activePageId:
						typeof activePageSetting?.value === 'string' ? activePageSetting.value : pages[0]!.id
				},
				userId
			);
		},
		async loadPage(userId: string, pageId: string) {
			const tx = db.transaction(PAGES_STORE_NAME, 'readonly');
			const page = await requestToPromise<PageRecord | undefined>(
				tx.objectStore(PAGES_STORE_NAME).get([userId, pageId])
			);
			await transactionToPromise(tx);
			return page ? toEditorPage(page) : null;
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
			if (!db.objectStoreNames.contains(PAGES_STORE_NAME)) {
				const pagesStore = db.createObjectStore(PAGES_STORE_NAME, {
					keyPath: ['userId', 'id']
				});
			pagesStore.createIndex(USER_ID_INDEX, 'userId', { unique: false });
				pagesStore.createIndex(UPDATED_AT_INDEX, ['userId', 'updatedAt'], { unique: false });
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

function toPageRecord(page: EditorPage, userId: string): PageRecord {
	return {
		id: page.id,
		userId,
		title: page.title,
		content: page.content,
		selectionStart: page.selectionStart,
		selectionEnd: page.selectionEnd,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		deletedAt: page.deletedAt,
		lastSyncedAt: page.lastSyncedAt,
		lastKnownRemoteUpdatedAt: page.lastKnownRemoteUpdatedAt,
		lastKnownRemoteDeletedAt: page.lastKnownRemoteDeletedAt,
		syncStatus: page.syncStatus,
		isEphemeral: page.isEphemeral
	};
}

function toEditorPage(page: PageRecord): EditorPage {
	const nextPage = createPage(page.content, {
		id: page.id,
		userId: page.userId,
		now: page.createdAt,
		isEphemeral: page.isEphemeral
	});

	return {
		...nextPage,
		title: page.title,
		content: page.content,
		text: page.content,
		selectionStart: page.selectionStart,
		selectionEnd: page.selectionEnd,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		deletedAt: page.deletedAt,
		lastSyncedAt: page.lastSyncedAt,
		lastKnownRemoteUpdatedAt: page.lastKnownRemoteUpdatedAt,
		lastKnownRemoteDeletedAt: page.lastKnownRemoteDeletedAt,
		syncStatus: page.syncStatus,
		isEphemeral: page.isEphemeral
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

function readPagesByUpdatedAtDesc(index: IDBIndex, userId: string): Promise<PageRecord[]> {
	return new Promise((resolve, reject) => {
		const pages: PageRecord[] = [];
		const range = IDBKeyRange.bound([userId, ''], [userId, '\uffff']);
		const request = index.openCursor(range, 'prev');

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(pages);
				return;
			}

			pages.push(cursor.value as PageRecord);
			cursor.continue();
		};

		request.onerror = () => reject(request.error);
	});
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
