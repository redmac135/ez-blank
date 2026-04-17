import { createSession, normalizeSession, type EditorPage, type EditorSession } from '../core/session';

const DB_NAME = 'ez-blank-editor-storage';
const DB_VERSION = 2;
const KV_STORE_NAME = 'kv';
const NOTES_STORE_NAME = 'notes';
const NOTES_SCOPE_INDEX = 'scope';
const SESSION_META_STORE_NAME = 'session_meta';

const ANONYMOUS_SCOPE = 'anonymous';
const USER_SCOPE_PREFIX = 'user:';

export class EditorStorage {
	public static ANONYMOUS_STATE_KEY = 'blank-state:anonymous';
	public static USER_STATE_KEY_PREFIX = 'blank-state:user:';
	public static PROMPTED_USER_IDS_KEY = 'blank-anonymous-import-prompted-user-ids';

	private static backendPromise: Promise<StorageBackend> | null = null;
	private static migrationPromise: Promise<void> | null = null;
	private static memoryBackend = createMemoryBackend();

	static getAnonymousStateKey() {
		return this.ANONYMOUS_STATE_KEY;
	}

	static getUserStateKey(userId: string) {
		return `${this.USER_STATE_KEY_PREFIX}${userId}`;
	}

	static async saveAnonymousState(session: EditorSession) {
		const backend = await this.getBackend();
		await backend.saveSession(ANONYMOUS_SCOPE, session);
	}

	static async loadAnonymousState(): Promise<EditorSession> {
		try {
			const backend = await this.getBackend();
			return (await backend.loadSession(ANONYMOUS_SCOPE)) ?? createSession();
		} catch (error) {
			console.error('Failed to load anonymous editor session:', error);
			return createSession();
		}
	}

	static async saveUserState(userId: string, session: EditorSession) {
		const backend = await this.getBackend();
		await backend.saveSession(buildUserScope(userId), session);
	}

	static async loadUserState(userId: string): Promise<EditorSession | null> {
		try {
			const backend = await this.getBackend();
			return await backend.loadSession(buildUserScope(userId));
		} catch (error) {
			console.error('Failed to load user editor session:', error);
			return null;
		}
	}

	static async loadAnonymousPage(pageId: string): Promise<EditorPage | null> {
		const backend = await this.getBackend();
		return backend.loadPage(ANONYMOUS_SCOPE, pageId);
	}

	static async loadUserPage(userId: string, pageId: string): Promise<EditorPage | null> {
		const backend = await this.getBackend();
		return backend.loadPage(buildUserScope(userId), pageId);
	}

	static async loadPromptedUserIds(): Promise<string[]> {
		try {
			const backend = await this.getBackend();
			const stored = await backend.getKeyValue(this.PROMPTED_USER_IDS_KEY);
			if (!stored) {
				return [];
			}

			const parsed = JSON.parse(stored);
			return Array.isArray(parsed)
				? parsed.filter((value): value is string => typeof value === 'string')
				: [];
		} catch (error) {
			console.error('Failed to load prompted user ids:', error);
			return [];
		}
	}

	static async hasPromptedUserId(userId: string): Promise<boolean> {
		return (await this.loadPromptedUserIds()).includes(userId);
	}

	static async markPromptedUserId(userId: string) {
		try {
			const promptedUserIds = await this.loadPromptedUserIds();
			if (promptedUserIds.includes(userId)) {
				return;
			}

			const backend = await this.getBackend();
			await backend.setKeyValue(this.PROMPTED_USER_IDS_KEY, JSON.stringify([...promptedUserIds, userId]));
		} catch (error) {
			console.error('Failed to save prompted user ids:', error);
		}
	}

	static resetForTests() {
		this.backendPromise = null;
		this.migrationPromise = null;
		this.memoryBackend = createMemoryBackend();
	}

	private static async getBackend(): Promise<StorageBackend> {
		if (!this.backendPromise) {
			this.backendPromise = this.initializeBackend();
		}

		return this.backendPromise;
	}

	private static async initializeBackend(): Promise<StorageBackend> {
		const backend = typeof indexedDB === 'undefined' ? this.memoryBackend : await createIndexedDbBackend();

		if (!this.migrationPromise) {
			this.migrationPromise = migrateLegacyLocalStorageState(backend);
		}

		await this.migrationPromise;
		return backend;
	}
}

interface StorageBackend {
	getKeyValue(key: string): Promise<string | null>;
	setKeyValue(key: string, value: string): Promise<void>;
	saveSession(scope: string, session: EditorSession): Promise<void>;
	loadSession(scope: string): Promise<EditorSession | null>;
	loadPage(scope: string, pageId: string): Promise<EditorPage | null>;
}

interface SessionMetaRecord {
	scope: string;
	activePageId: string;
}

interface NoteRecord {
	key: string;
	scope: string;
	id: string;
	order: number;
	page: EditorPage;
}

function createMemoryBackend(): StorageBackend {
	const keyValues = new Map<string, string>();
	const sessionByScope = new Map<string, EditorSession>();

	return {
		async getKeyValue(key: string) {
			return keyValues.get(key) ?? null;
		},
		async setKeyValue(key: string, value: string) {
			keyValues.set(key, value);
		},
		async saveSession(scope: string, session: EditorSession) {
			sessionByScope.set(scope, cloneSession(session));
		},
		async loadSession(scope: string) {
			const session = sessionByScope.get(scope);
			return session ? cloneSession(session) : null;
		},
		async loadPage(scope: string, pageId: string) {
			const session = sessionByScope.get(scope);
			if (!session) {
				return null;
			}

			const page = session.pages.find((entry) => entry.id === pageId);
			return page ? { ...page } : null;
		}
	};
}

async function createIndexedDbBackend(): Promise<StorageBackend> {
	const db = await openDatabase();

	return {
		async getKeyValue(key: string) {
			const tx = db.transaction(KV_STORE_NAME, 'readonly');
			const store = tx.objectStore(KV_STORE_NAME);
			const record = await requestToPromise<{ key: string; value: string } | undefined>(store.get(key));
			await transactionToPromise(tx);
			return record?.value ?? null;
		},
		async setKeyValue(key: string, value: string) {
			const tx = db.transaction(KV_STORE_NAME, 'readwrite');
			tx.objectStore(KV_STORE_NAME).put({ key, value });
			await transactionToPromise(tx);
		},
		async saveSession(scope: string, session: EditorSession) {
			const tx = db.transaction([NOTES_STORE_NAME, SESSION_META_STORE_NAME], 'readwrite');
			const notesStore = tx.objectStore(NOTES_STORE_NAME);
			const metaStore = tx.objectStore(SESSION_META_STORE_NAME);

			const scopeIndex = notesStore.index(NOTES_SCOPE_INDEX);
			const existingRecords = await requestToPromise<NoteRecord[]>(scopeIndex.getAll(IDBKeyRange.only(scope)));
			const nextKeys = new Set(session.pages.map((page) => buildNoteKey(scope, page.id)));

			for (const record of existingRecords) {
				if (!nextKeys.has(record.key)) {
					notesStore.delete(record.key);
				}
			}

			for (const [order, page] of session.pages.entries()) {
				const key = buildNoteKey(scope, page.id);
				notesStore.put({
					key,
					scope,
					id: page.id,
					order,
					page: { ...page }
				} satisfies NoteRecord);
			}

			metaStore.put({
				scope,
				activePageId: session.activePageId
			} satisfies SessionMetaRecord);
			await transactionToPromise(tx);
		},
		async loadSession(scope: string) {
			const tx = db.transaction([NOTES_STORE_NAME, SESSION_META_STORE_NAME], 'readonly');
			const notesStore = tx.objectStore(NOTES_STORE_NAME);
			const metaStore = tx.objectStore(SESSION_META_STORE_NAME);
			const scopeIndex = notesStore.index(NOTES_SCOPE_INDEX);

			const [noteRecords, metaRecord] = await Promise.all([
				requestToPromise<NoteRecord[]>(scopeIndex.getAll(IDBKeyRange.only(scope))),
				requestToPromise<SessionMetaRecord | undefined>(metaStore.get(scope))
			]);
			await transactionToPromise(tx);

			if (!metaRecord && noteRecords.length === 0) {
				return null;
			}

			const pages = noteRecords
				.sort((left, right) => left.order - right.order)
				.map((record) => ({ ...record.page }));
			const activePageId = metaRecord?.activePageId ?? pages[0]?.id ?? createSession().activePageId;
			return normalizeSession({ pages, activePageId });
		},
		async loadPage(scope: string, pageId: string) {
			const tx = db.transaction(NOTES_STORE_NAME, 'readonly');
			const record = await requestToPromise<NoteRecord | undefined>(
				tx.objectStore(NOTES_STORE_NAME).get(buildNoteKey(scope, pageId))
			);
			await transactionToPromise(tx);
			return record ? { ...record.page } : null;
		}
	};
}

async function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => {
			const db = request.result;
			const tx = request.transaction;
			if (!tx) {
				return;
			}

			const previousVersion = event.oldVersion;
			const kvStore = db.objectStoreNames.contains(KV_STORE_NAME)
				? tx.objectStore(KV_STORE_NAME)
				: db.createObjectStore(KV_STORE_NAME, { keyPath: 'key' });
			const notesStore = db.objectStoreNames.contains(NOTES_STORE_NAME)
				? tx.objectStore(NOTES_STORE_NAME)
				: db.createObjectStore(NOTES_STORE_NAME, { keyPath: 'key' });
			if (!notesStore.indexNames.contains(NOTES_SCOPE_INDEX)) {
				notesStore.createIndex(NOTES_SCOPE_INDEX, 'scope', { unique: false });
			}
			const sessionMetaStore = db.objectStoreNames.contains(SESSION_META_STORE_NAME)
				? tx.objectStore(SESSION_META_STORE_NAME)
				: db.createObjectStore(SESSION_META_STORE_NAME, { keyPath: 'scope' });

			if (previousVersion < 2) {
				migrateIndexedDbLegacySessionData(kvStore, notesStore, sessionMetaStore);
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function migrateIndexedDbLegacySessionData(
	kvStore: IDBObjectStore,
	notesStore: IDBObjectStore,
	sessionMetaStore: IDBObjectStore
) {
	kvStore.openCursor().onsuccess = (event) => {
		const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
		if (!cursor) {
			return;
		}

		const record = cursor.value as { key?: unknown; value?: unknown };
		const key = typeof record?.key === 'string' ? record.key : null;
		const value = typeof record?.value === 'string' ? record.value : null;
		if (!key || !value) {
			cursor.continue();
			return;
		}

		const scope = getScopeFromStateKey(key);
		if (!scope) {
			cursor.continue();
			return;
		}

		const session = normalizeSession(JSON.parse(value));
		if (!session) {
			cursor.continue();
			return;
		}

		for (const [order, page] of session.pages.entries()) {
			notesStore.put({
				key: buildNoteKey(scope, page.id),
				scope,
				id: page.id,
				order,
				page: { ...page }
			} satisfies NoteRecord);
		}

		sessionMetaStore.put({
			scope,
			activePageId: session.activePageId
		} satisfies SessionMetaRecord);
		kvStore.delete(key);
		cursor.continue();
	};
}

async function migrateLegacyLocalStorageState(backend: StorageBackend) {
	if (typeof localStorage === 'undefined') {
		return;
	}

	const keys: string[] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key) {
			keys.push(key);
		}
	}

	for (const key of keys) {
		const value = localStorage.getItem(key);
		if (value === null) {
			continue;
		}

		const scope = getScopeFromStateKey(key);
		if (scope) {
			const session = normalizeSession(JSON.parse(value));
			if (session) {
				await backend.saveSession(scope, session);
			}
			localStorage.removeItem(key);
			continue;
		}

		if (key === 'ez-blank-session-v2') {
			const session = normalizeSession(JSON.parse(value));
			if (session) {
				await backend.saveSession(ANONYMOUS_SCOPE, session);
			}
			localStorage.removeItem(key);
			continue;
		}

		if (key === EditorStorage.PROMPTED_USER_IDS_KEY) {
			await backend.setKeyValue(key, value);
			localStorage.removeItem(key);
		}
	}
}

function getScopeFromStateKey(key: string): string | null {
	if (key === EditorStorage.ANONYMOUS_STATE_KEY) {
		return ANONYMOUS_SCOPE;
	}

	if (key.startsWith(EditorStorage.USER_STATE_KEY_PREFIX)) {
		return `${USER_SCOPE_PREFIX}${key.slice(EditorStorage.USER_STATE_KEY_PREFIX.length)}`;
	}

	return null;
}

function buildUserScope(userId: string) {
	return `${USER_SCOPE_PREFIX}${userId}`;
}

function buildNoteKey(scope: string, id: string) {
	return `${scope}:${id}`;
}

function cloneSession(session: EditorSession): EditorSession {
	return {
		activePageId: session.activePageId,
		pages: session.pages.map((page) => ({ ...page }))
	};
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
