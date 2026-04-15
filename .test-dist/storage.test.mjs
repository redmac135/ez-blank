// tests/storage.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/editor/core/session.ts
var UNTITLED_PAGE = "Untitled";
function derivePageTitle(content) {
  const firstLine = content.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) {
    return UNTITLED_PAGE;
  }
  return firstLine.replace(/\s+/g, " ").slice(0, 48);
}
function createPage(content = "", id = createPageId()) {
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id,
    title: derivePageTitle(content),
    content,
    text: content,
    selectionStart: 0,
    selectionEnd: 0,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    lastSyncedAt: null,
    lastSyncedTitle: null,
    lastSyncedContent: null,
    lastSyncedDeletedAt: null,
    dirty: true,
    syncStatus: "local-only",
    lastSyncedVersion: null
  };
}
function createSession() {
  const page = createPage();
  return {
    pages: [page],
    activePageId: page.id
  };
}
function ensureValidActivePage(session) {
  if (session.pages.length === 0) {
    return createSession();
  }
  if (session.pages.some((page) => page.id === session.activePageId && page.deletedAt === null)) {
    return session;
  }
  const firstVisiblePage = session.pages.find((page) => page.deletedAt === null);
  if (firstVisiblePage) {
    return {
      ...session,
      activePageId: firstVisiblePage.id
    };
  }
  return {
    ...session,
    activePageId: session.pages[0].id
  };
}
function updatePageState(page, state) {
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    ...page,
    ...state,
    content: state.text,
    title: derivePageTitle(state.text),
    updatedAt,
    dirty: true,
    syncStatus: page.deletedAt ? "deleted" : "dirty"
  };
}
function normalizeSession(value) {
  if (!isRecord(value)) return null;
  if (isLegacyEditorState(value)) {
    return migrateLegacyState(value);
  }
  if (!Array.isArray(value.pages)) {
    return null;
  }
  const pages = value.pages.map((page, index) => normalizePage(page, index)).filter((page) => page !== null);
  if (pages.length === 0) {
    return createSession();
  }
  const activePageId = typeof value.activePageId === "string" && pages.some((page) => page.id === value.activePageId && page.deletedAt === null) ? value.activePageId : pages.find((page) => page.deletedAt === null)?.id ?? pages[0].id;
  return ensureValidActivePage({ pages, activePageId });
}
function migrateLegacyState(state) {
  const page = updatePageState(createPage(state.text), state);
  return {
    pages: [page],
    activePageId: page.id
  };
}
function normalizePage(value, index) {
  if (!isRecord(value)) return null;
  const content = typeof value.content === "string" ? value.content : typeof value.text === "string" ? value.text : "";
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const selectionStart = clampSelection(
    typeof value.selectionStart === "number" ? value.selectionStart : 0,
    normalizedContent.length
  );
  const selectionEnd = clampSelection(
    typeof value.selectionEnd === "number" ? value.selectionEnd : selectionStart,
    normalizedContent.length
  );
  const createdAt = typeof value.createdAt === "string" && value.createdAt.length > 0 ? value.createdAt : typeof value.created_at === "string" && value.created_at.length > 0 ? value.created_at : (/* @__PURE__ */ new Date()).toISOString();
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : (/* @__PURE__ */ new Date()).toISOString();
  const deletedAt = typeof value.deletedAt === "string" ? value.deletedAt : typeof value.deleted_at === "string" ? value.deleted_at : null;
  const lastSyncedAt = typeof value.lastSyncedAt === "string" ? value.lastSyncedAt : typeof value.lastSyncedVersion === "string" ? value.lastSyncedVersion : null;
  const lastSyncedTitle = typeof value.lastSyncedTitle === "string" ? value.lastSyncedTitle : lastSyncedAt ? typeof value.title === "string" ? value.title.trim() : derivePageTitle(normalizedContent) : null;
  const lastSyncedContent = typeof value.lastSyncedContent === "string" ? value.lastSyncedContent : lastSyncedAt ? normalizedContent : null;
  const lastSyncedDeletedAt = typeof value.lastSyncedDeletedAt === "string" ? value.lastSyncedDeletedAt : lastSyncedAt ? deletedAt : null;
  const dirty = typeof value.dirty === "boolean" ? value.dirty : lastSyncedAt === null;
  const syncStatus = normalizeSyncStatus(value.syncStatus, deletedAt, dirty, lastSyncedAt);
  return {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : `page-${index + 1}`,
    title: typeof value.title === "string" && value.title.trim().length > 0 ? value.title.trim() : derivePageTitle(normalizedContent),
    content: normalizedContent,
    text: normalizedContent,
    selectionStart,
    selectionEnd,
    createdAt,
    updatedAt,
    deletedAt,
    lastSyncedAt,
    lastSyncedTitle,
    lastSyncedContent,
    lastSyncedDeletedAt,
    dirty,
    syncStatus,
    lastSyncedVersion: typeof value.lastSyncedVersion === "string" ? value.lastSyncedVersion : lastSyncedAt ? lastSyncedAt : typeof value.serverVersion === "string" ? value.serverVersion : null
  };
}
function isLegacyEditorState(value) {
  return "text" in value && "selectionStart" in value && "selectionEnd" in value;
}
function isRecord(value) {
  return !!value && typeof value === "object";
}
function clampSelection(value, max) {
  return Math.max(0, Math.min(value, max));
}
function normalizeSyncStatus(value, deletedAt, dirty, lastSyncedAt) {
  if (value === "local-only" || value === "synced" || value === "dirty" || value === "deleted" || value === "conflict" || value === "inconsistent") {
    return value;
  }
  if (deletedAt) {
    return "deleted";
  }
  if (dirty) {
    return lastSyncedAt ? "dirty" : "local-only";
  }
  return lastSyncedAt ? "synced" : "local-only";
}
function createPageId() {
  return `page-${Math.random().toString(36).slice(2, 10)}`;
}

// src/lib/editor/persistence/storage.ts
var DEFAULT_SYNC_META = {
  dirty: false,
  lastSyncedAt: null,
  pageVersions: {}
};
var DB_NAME = "ez-blank-editor-storage";
var DB_VERSION = 2;
var KV_STORE_NAME = "kv";
var NOTES_STORE_NAME = "notes";
var NOTES_SCOPE_INDEX = "scope";
var SESSION_META_STORE_NAME = "session_meta";
var ANONYMOUS_SCOPE = "anonymous";
var USER_SCOPE_PREFIX = "user:";
var EditorStorage = class {
  static ANONYMOUS_STATE_KEY = "blank-state:anonymous";
  static USER_STATE_KEY_PREFIX = "blank-state:user:";
  static USER_SYNC_META_KEY_PREFIX = "blank-sync-meta:user:";
  static PROMPTED_USER_IDS_KEY = "blank-anonymous-import-prompted-user-ids";
  static backendPromise = null;
  static migrationPromise = null;
  static memoryBackend = createMemoryBackend();
  static getAnonymousStateKey() {
    return this.ANONYMOUS_STATE_KEY;
  }
  static getUserStateKey(userId) {
    return `${this.USER_STATE_KEY_PREFIX}${userId}`;
  }
  static getUserSyncMetaKey(userId) {
    return `${this.USER_SYNC_META_KEY_PREFIX}${userId}`;
  }
  static async saveAnonymousState(session) {
    const backend = await this.getBackend();
    await backend.saveSession(ANONYMOUS_SCOPE, session);
  }
  static async loadAnonymousState() {
    try {
      const backend = await this.getBackend();
      return await backend.loadSession(ANONYMOUS_SCOPE) ?? createSession();
    } catch (error) {
      console.error("Failed to load anonymous editor session:", error);
      return createSession();
    }
  }
  static async saveUserState(userId, session) {
    const backend = await this.getBackend();
    await backend.saveSession(buildUserScope(userId), session);
  }
  static async loadUserState(userId) {
    try {
      const backend = await this.getBackend();
      return await backend.loadSession(buildUserScope(userId));
    } catch (error) {
      console.error("Failed to load user editor session:", error);
      return null;
    }
  }
  static async loadAnonymousPage(pageId) {
    const backend = await this.getBackend();
    return backend.loadPage(ANONYMOUS_SCOPE, pageId);
  }
  static async loadUserPage(userId, pageId) {
    const backend = await this.getBackend();
    return backend.loadPage(buildUserScope(userId), pageId);
  }
  static async saveUserSyncMeta(userId, meta) {
    try {
      const backend = await this.getBackend();
      await backend.setKeyValue(this.getUserSyncMetaKey(userId), JSON.stringify(meta));
    } catch (error) {
      console.error("Failed to save user sync meta:", error);
    }
  }
  static async loadUserSyncMeta(userId) {
    try {
      const backend = await this.getBackend();
      const stored = await backend.getKeyValue(this.getUserSyncMetaKey(userId));
      if (!stored) {
        return DEFAULT_SYNC_META;
      }
      const parsed = JSON.parse(stored);
      return {
        dirty: parsed?.dirty === true,
        lastSyncedAt: typeof parsed?.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
        pageVersions: normalizePageVersions(parsed?.pageVersions)
      };
    } catch (error) {
      console.error("Failed to load user sync meta:", error);
      return DEFAULT_SYNC_META;
    }
  }
  static async loadPromptedUserIds() {
    try {
      const backend = await this.getBackend();
      const stored = await backend.getKeyValue(this.PROMPTED_USER_IDS_KEY);
      if (!stored) {
        return [];
      }
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
    } catch (error) {
      console.error("Failed to load prompted user ids:", error);
      return [];
    }
  }
  static async hasPromptedUserId(userId) {
    return (await this.loadPromptedUserIds()).includes(userId);
  }
  static async markPromptedUserId(userId) {
    try {
      const promptedUserIds = await this.loadPromptedUserIds();
      if (promptedUserIds.includes(userId)) {
        return;
      }
      const backend = await this.getBackend();
      await backend.setKeyValue(this.PROMPTED_USER_IDS_KEY, JSON.stringify([...promptedUserIds, userId]));
    } catch (error) {
      console.error("Failed to save prompted user ids:", error);
    }
  }
  static resetForTests() {
    this.backendPromise = null;
    this.migrationPromise = null;
    this.memoryBackend = createMemoryBackend();
  }
  static async getBackend() {
    if (!this.backendPromise) {
      this.backendPromise = this.initializeBackend();
    }
    return this.backendPromise;
  }
  static async initializeBackend() {
    const backend = typeof indexedDB === "undefined" ? this.memoryBackend : await createIndexedDbBackend();
    if (!this.migrationPromise) {
      this.migrationPromise = migrateLegacyLocalStorageState(backend);
    }
    await this.migrationPromise;
    return backend;
  }
};
function createMemoryBackend() {
  const keyValues = /* @__PURE__ */ new Map();
  const sessionByScope = /* @__PURE__ */ new Map();
  return {
    async getKeyValue(key) {
      return keyValues.get(key) ?? null;
    },
    async setKeyValue(key, value) {
      keyValues.set(key, value);
    },
    async saveSession(scope, session) {
      sessionByScope.set(scope, cloneSession(session));
    },
    async loadSession(scope) {
      const session = sessionByScope.get(scope);
      return session ? cloneSession(session) : null;
    },
    async loadPage(scope, pageId) {
      const session = sessionByScope.get(scope);
      if (!session) {
        return null;
      }
      const page = session.pages.find((entry) => entry.id === pageId);
      return page ? { ...page } : null;
    }
  };
}
async function createIndexedDbBackend() {
  const db = await openDatabase();
  return {
    async getKeyValue(key) {
      const tx = db.transaction(KV_STORE_NAME, "readonly");
      const store = tx.objectStore(KV_STORE_NAME);
      const record = await requestToPromise(store.get(key));
      await transactionToPromise(tx);
      return record?.value ?? null;
    },
    async setKeyValue(key, value) {
      const tx = db.transaction(KV_STORE_NAME, "readwrite");
      tx.objectStore(KV_STORE_NAME).put({ key, value });
      await transactionToPromise(tx);
    },
    async saveSession(scope, session) {
      const tx = db.transaction([NOTES_STORE_NAME, SESSION_META_STORE_NAME], "readwrite");
      const notesStore = tx.objectStore(NOTES_STORE_NAME);
      const metaStore = tx.objectStore(SESSION_META_STORE_NAME);
      const scopeIndex = notesStore.index(NOTES_SCOPE_INDEX);
      const existingRecords = await requestToPromise(scopeIndex.getAll(IDBKeyRange.only(scope)));
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
        });
      }
      metaStore.put({
        scope,
        activePageId: session.activePageId
      });
      await transactionToPromise(tx);
    },
    async loadSession(scope) {
      const tx = db.transaction([NOTES_STORE_NAME, SESSION_META_STORE_NAME], "readonly");
      const notesStore = tx.objectStore(NOTES_STORE_NAME);
      const metaStore = tx.objectStore(SESSION_META_STORE_NAME);
      const scopeIndex = notesStore.index(NOTES_SCOPE_INDEX);
      const [noteRecords, metaRecord] = await Promise.all([
        requestToPromise(scopeIndex.getAll(IDBKeyRange.only(scope))),
        requestToPromise(metaStore.get(scope))
      ]);
      await transactionToPromise(tx);
      if (!metaRecord && noteRecords.length === 0) {
        return null;
      }
      const pages = noteRecords.sort((left, right) => left.order - right.order).map((record) => ({ ...record.page }));
      const activePageId = metaRecord?.activePageId ?? pages[0]?.id ?? createSession().activePageId;
      return normalizeSession({ pages, activePageId });
    },
    async loadPage(scope, pageId) {
      const tx = db.transaction(NOTES_STORE_NAME, "readonly");
      const record = await requestToPromise(
        tx.objectStore(NOTES_STORE_NAME).get(buildNoteKey(scope, pageId))
      );
      await transactionToPromise(tx);
      return record ? { ...record.page } : null;
    }
  };
}
async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        return;
      }
      const previousVersion = event.oldVersion;
      const kvStore = db.objectStoreNames.contains(KV_STORE_NAME) ? tx.objectStore(KV_STORE_NAME) : db.createObjectStore(KV_STORE_NAME, { keyPath: "key" });
      const notesStore = db.objectStoreNames.contains(NOTES_STORE_NAME) ? tx.objectStore(NOTES_STORE_NAME) : db.createObjectStore(NOTES_STORE_NAME, { keyPath: "key" });
      if (!notesStore.indexNames.contains(NOTES_SCOPE_INDEX)) {
        notesStore.createIndex(NOTES_SCOPE_INDEX, "scope", { unique: false });
      }
      const sessionMetaStore = db.objectStoreNames.contains(SESSION_META_STORE_NAME) ? tx.objectStore(SESSION_META_STORE_NAME) : db.createObjectStore(SESSION_META_STORE_NAME, { keyPath: "scope" });
      if (previousVersion < 2) {
        migrateIndexedDbLegacySessionData(kvStore, notesStore, sessionMetaStore);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function migrateIndexedDbLegacySessionData(kvStore, notesStore, sessionMetaStore) {
  kvStore.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) {
      return;
    }
    const record = cursor.value;
    const key = typeof record?.key === "string" ? record.key : null;
    const value = typeof record?.value === "string" ? record.value : null;
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
      });
    }
    sessionMetaStore.put({
      scope,
      activePageId: session.activePageId
    });
    kvStore.delete(key);
    cursor.continue();
  };
}
async function migrateLegacyLocalStorageState(backend) {
  if (typeof localStorage === "undefined") {
    return;
  }
  const keys = [];
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
    if (key === "ez-blank-session-v2") {
      const session = normalizeSession(JSON.parse(value));
      if (session) {
        await backend.saveSession(ANONYMOUS_SCOPE, session);
      }
      localStorage.removeItem(key);
      continue;
    }
    if (key === EditorStorage.PROMPTED_USER_IDS_KEY || key.startsWith(EditorStorage.USER_SYNC_META_KEY_PREFIX)) {
      await backend.setKeyValue(key, value);
      localStorage.removeItem(key);
    }
  }
}
function getScopeFromStateKey(key) {
  if (key === EditorStorage.ANONYMOUS_STATE_KEY) {
    return ANONYMOUS_SCOPE;
  }
  if (key.startsWith(EditorStorage.USER_STATE_KEY_PREFIX)) {
    return `${USER_SCOPE_PREFIX}${key.slice(EditorStorage.USER_STATE_KEY_PREFIX.length)}`;
  }
  return null;
}
function buildUserScope(userId) {
  return `${USER_SCOPE_PREFIX}${userId}`;
}
function buildNoteKey(scope, id) {
  return `${scope}:${id}`;
}
function cloneSession(session) {
  return {
    activePageId: session.activePageId,
    pages: session.pages.map((page) => ({ ...page }))
  };
}
function normalizePageVersions(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, version]) => {
      return typeof version === "string" || version === null;
    })
  );
}
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// tests/storage.test.ts
var MemoryStorage = class {
  values = /* @__PURE__ */ new Map();
  get length() {
    return this.values.size;
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
  removeItem(key) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
};
function createSession2(activePageId = "page-a") {
  const pageA = createPage("alpha");
  pageA.id = "page-a";
  pageA.title = "A";
  pageA.createdAt = "2026-04-14T00:00:00.000Z";
  pageA.updatedAt = "2026-04-14T00:00:00.000Z";
  pageA.deletedAt = null;
  pageA.lastSyncedAt = "2026-04-14T00:00:00.000Z";
  pageA.lastSyncedTitle = "A";
  pageA.lastSyncedContent = "alpha";
  pageA.lastSyncedDeletedAt = null;
  pageA.dirty = false;
  pageA.syncStatus = "synced";
  pageA.lastSyncedVersion = "2026-04-14T00:00:00.000Z";
  const pageB = createPage("beta");
  pageB.id = "page-b";
  pageB.title = "B";
  pageB.createdAt = "2026-04-14T00:00:00.000Z";
  pageB.updatedAt = "2026-04-14T00:00:00.000Z";
  pageB.deletedAt = null;
  pageB.lastSyncedAt = "2026-04-14T00:00:00.000Z";
  pageB.lastSyncedTitle = "B";
  pageB.lastSyncedContent = "beta";
  pageB.lastSyncedDeletedAt = null;
  pageB.dirty = false;
  pageB.syncStatus = "synced";
  pageB.lastSyncedVersion = "2026-04-14T00:00:00.000Z";
  return {
    activePageId,
    pages: [pageA, pageB]
  };
}
test.beforeEach(() => {
  EditorStorage.resetForTests();
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true
  });
});
test("EditorStorage saves and loads anonymous state through the database", async () => {
  const session = createSession2("page-b");
  await EditorStorage.saveAnonymousState(session);
  const loaded = await EditorStorage.loadAnonymousState();
  assert.equal(loaded.activePageId, "page-b");
  assert.equal(loaded.pages.length, session.pages.length);
});
test("EditorStorage saves and loads user-scoped state separately per account", async () => {
  await EditorStorage.saveUserState("user-a", createSession2("page-a"));
  await EditorStorage.saveUserState("user-b", createSession2("page-b"));
  assert.equal((await EditorStorage.loadUserState("user-a"))?.activePageId, "page-a");
  assert.equal((await EditorStorage.loadUserState("user-b"))?.activePageId, "page-b");
});
test("EditorStorage loads a single page without requiring full session consumers", async () => {
  const session = createSession2("page-a");
  await EditorStorage.saveUserState("user-a", session);
  const page = await EditorStorage.loadUserPage("user-a", "page-b");
  assert.equal(page?.id, "page-b");
  assert.equal(page?.content, "beta");
});
test("EditorStorage loads default sync metadata when none exists", async () => {
  assert.deepEqual(await EditorStorage.loadUserSyncMeta("user-a"), {
    dirty: false,
    lastSyncedAt: null,
    pageVersions: {}
  });
});
test("EditorStorage saves and loads user sync metadata", async () => {
  await EditorStorage.saveUserSyncMeta("user-a", {
    dirty: true,
    lastSyncedAt: "2026-04-14T00:00:00.000Z",
    pageVersions: { "page-a": "2026-04-14T00:00:00.000Z" }
  });
  assert.deepEqual(await EditorStorage.loadUserSyncMeta("user-a"), {
    dirty: true,
    lastSyncedAt: "2026-04-14T00:00:00.000Z",
    pageVersions: { "page-a": "2026-04-14T00:00:00.000Z" }
  });
});
test("EditorStorage migrates the legacy anonymous JSON session into the database", async () => {
  localStorage.setItem(
    EditorStorage.ANONYMOUS_STATE_KEY,
    JSON.stringify({
      pages: createSession2("page-b").pages,
      activePageId: "page-b"
    })
  );
  const session = await EditorStorage.loadAnonymousState();
  assert.equal(session.activePageId, "page-b");
  assert.equal(localStorage.getItem(EditorStorage.ANONYMOUS_STATE_KEY), null);
});
test("EditorStorage keeps page lookups in sync after deletions are saved", async () => {
  const session = createSession2("page-a");
  await EditorStorage.saveAnonymousState(session);
  await EditorStorage.saveAnonymousState({
    activePageId: "page-a",
    pages: [session.pages[0]]
  });
  const deletedPage = await EditorStorage.loadAnonymousPage("page-b");
  assert.equal(deletedPage, null);
});
test("EditorStorage tracks prompted user ids without duplicates", async () => {
  assert.equal(await EditorStorage.hasPromptedUserId("user-a"), false);
  await EditorStorage.markPromptedUserId("user-a");
  await EditorStorage.markPromptedUserId("user-a");
  assert.equal(await EditorStorage.hasPromptedUserId("user-a"), true);
  assert.deepEqual(await EditorStorage.loadPromptedUserIds(), ["user-a"]);
});
test("EditorStorage ignores malformed prompted user id payloads", async () => {
  localStorage.setItem(EditorStorage.PROMPTED_USER_IDS_KEY, JSON.stringify(["user-a", 42, null]));
  assert.deepEqual(await EditorStorage.loadPromptedUserIds(), ["user-a"]);
  assert.equal(await EditorStorage.hasPromptedUserId("user-a"), true);
  assert.equal(await EditorStorage.hasPromptedUserId("user-b"), false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3RvcmFnZS50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvcmUvc2Vzc2lvbi50cyIsICIuLi9zcmMvbGliL2VkaXRvci9wZXJzaXN0ZW5jZS9zdG9yYWdlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgRWRpdG9yU3RvcmFnZSB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3N0b3JhZ2UudHMnO1xuaW1wb3J0IHsgY3JlYXRlUGFnZSwgdHlwZSBFZGl0b3JTZXNzaW9uIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxuY2xhc3MgTWVtb3J5U3RvcmFnZSB7XG5cdHByaXZhdGUgdmFsdWVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblxuXHRnZXQgbGVuZ3RoKCkge1xuXHRcdHJldHVybiB0aGlzLnZhbHVlcy5zaXplO1xuXHR9XG5cblx0Z2V0SXRlbShrZXk6IHN0cmluZykge1xuXHRcdHJldHVybiB0aGlzLnZhbHVlcy5nZXQoa2V5KSA/PyBudWxsO1xuXHR9XG5cblx0a2V5KGluZGV4OiBudW1iZXIpIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMudmFsdWVzLmtleXMoKV1baW5kZXhdID8/IG51bGw7XG5cdH1cblxuXHRzZXRJdGVtKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSB7XG5cdFx0dGhpcy52YWx1ZXMuc2V0KGtleSwgdmFsdWUpO1xuXHR9XG5cblx0cmVtb3ZlSXRlbShrZXk6IHN0cmluZykge1xuXHRcdHRoaXMudmFsdWVzLmRlbGV0ZShrZXkpO1xuXHR9XG5cblx0Y2xlYXIoKSB7XG5cdFx0dGhpcy52YWx1ZXMuY2xlYXIoKTtcblx0fVxufVxuXG5mdW5jdGlvbiBjcmVhdGVTZXNzaW9uKGFjdGl2ZVBhZ2VJZCA9ICdwYWdlLWEnKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2VBID0gY3JlYXRlUGFnZSgnYWxwaGEnKTtcblx0cGFnZUEuaWQgPSAncGFnZS1hJztcblx0cGFnZUEudGl0bGUgPSAnQSc7XG5cdHBhZ2VBLmNyZWF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXHRwYWdlQS51cGRhdGVkQXQgPSAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJztcblx0cGFnZUEuZGVsZXRlZEF0ID0gbnVsbDtcblx0cGFnZUEubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWic7XG5cdHBhZ2VBLmxhc3RTeW5jZWRUaXRsZSA9ICdBJztcblx0cGFnZUEubGFzdFN5bmNlZENvbnRlbnQgPSAnYWxwaGEnO1xuXHRwYWdlQS5sYXN0U3luY2VkRGVsZXRlZEF0ID0gbnVsbDtcblx0cGFnZUEuZGlydHkgPSBmYWxzZTtcblx0cGFnZUEuc3luY1N0YXR1cyA9ICdzeW5jZWQnO1xuXHRwYWdlQS5sYXN0U3luY2VkVmVyc2lvbiA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXG5cdGNvbnN0IHBhZ2VCID0gY3JlYXRlUGFnZSgnYmV0YScpO1xuXHRwYWdlQi5pZCA9ICdwYWdlLWInO1xuXHRwYWdlQi50aXRsZSA9ICdCJztcblx0cGFnZUIuY3JlYXRlZEF0ID0gJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWic7XG5cdHBhZ2VCLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXHRwYWdlQi5kZWxldGVkQXQgPSBudWxsO1xuXHRwYWdlQi5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJztcblx0cGFnZUIubGFzdFN5bmNlZFRpdGxlID0gJ0InO1xuXHRwYWdlQi5sYXN0U3luY2VkQ29udGVudCA9ICdiZXRhJztcblx0cGFnZUIubGFzdFN5bmNlZERlbGV0ZWRBdCA9IG51bGw7XG5cdHBhZ2VCLmRpcnR5ID0gZmFsc2U7XG5cdHBhZ2VCLnN5bmNTdGF0dXMgPSAnc3luY2VkJztcblx0cGFnZUIubGFzdFN5bmNlZFZlcnNpb24gPSAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJztcblxuXHRyZXR1cm4ge1xuXHRcdGFjdGl2ZVBhZ2VJZCxcblx0XHRwYWdlczogW3BhZ2VBLCBwYWdlQl1cblx0fTtcbn1cblxudGVzdC5iZWZvcmVFYWNoKCgpID0+IHtcblx0RWRpdG9yU3RvcmFnZS5yZXNldEZvclRlc3RzKCk7XG5cdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShnbG9iYWxUaGlzLCAnbG9jYWxTdG9yYWdlJywge1xuXHRcdHZhbHVlOiBuZXcgTWVtb3J5U3RvcmFnZSgpLFxuXHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxuXHR9KTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHNhdmVzIGFuZCBsb2FkcyBhbm9ueW1vdXMgc3RhdGUgdGhyb3VnaCB0aGUgZGF0YWJhc2UnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWInKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVBbm9ueW1vdXNTdGF0ZShzZXNzaW9uKTtcblxuXHRjb25zdCBsb2FkZWQgPSBhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRBbm9ueW1vdXNTdGF0ZSgpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLnBhZ2VzLmxlbmd0aCwgc2Vzc2lvbi5wYWdlcy5sZW5ndGgpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIHVzZXItc2NvcGVkIHN0YXRlIHNlcGFyYXRlbHkgcGVyIGFjY291bnQnLCBhc3luYyAoKSA9PiB7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVVzZXJTdGF0ZSgndXNlci1hJywgY3JlYXRlU2Vzc2lvbigncGFnZS1hJykpO1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVVc2VyU3RhdGUoJ3VzZXItYicsIGNyZWF0ZVNlc3Npb24oJ3BhZ2UtYicpKTtcblxuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1hJykpPy5hY3RpdmVQYWdlSWQsICdwYWdlLWEnKTtcblx0YXNzZXJ0LmVxdWFsKChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYicpKT8uYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBsb2FkcyBhIHNpbmdsZSBwYWdlIHdpdGhvdXQgcmVxdWlyaW5nIGZ1bGwgc2Vzc2lvbiBjb25zdW1lcnMnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBzZXNzaW9uKTtcblxuXHRjb25zdCBwYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclBhZ2UoJ3VzZXItYScsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2U/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5jb250ZW50LCAnYmV0YScpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2UgbG9hZHMgZGVmYXVsdCBzeW5jIG1ldGFkYXRhIHdoZW4gbm9uZSBleGlzdHMnLCBhc3luYyAoKSA9PiB7XG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN5bmNNZXRhKCd1c2VyLWEnKSwge1xuXHRcdGRpcnR5OiBmYWxzZSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0cGFnZVZlcnNpb25zOiB7fVxuXHR9KTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHNhdmVzIGFuZCBsb2FkcyB1c2VyIHN5bmMgbWV0YWRhdGEnLCBhc3luYyAoKSA9PiB7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVVzZXJTeW5jTWV0YSgndXNlci1hJywge1xuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdGxhc3RTeW5jZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0cGFnZVZlcnNpb25zOiB7ICdwYWdlLWEnOiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJyB9XG5cdH0pO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN5bmNNZXRhKCd1c2VyLWEnKSwge1xuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdGxhc3RTeW5jZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0cGFnZVZlcnNpb25zOiB7ICdwYWdlLWEnOiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJyB9XG5cdH0pO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2UgbWlncmF0ZXMgdGhlIGxlZ2FjeSBhbm9ueW1vdXMgSlNPTiBzZXNzaW9uIGludG8gdGhlIGRhdGFiYXNlJywgYXN5bmMgKCkgPT4ge1xuXHRsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcblx0XHRFZGl0b3JTdG9yYWdlLkFOT05ZTU9VU19TVEFURV9LRVksXG5cdFx0SlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0cGFnZXM6IGNyZWF0ZVNlc3Npb24oJ3BhZ2UtYicpLnBhZ2VzLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiAncGFnZS1iJ1xuXHRcdH0pXG5cdCk7XG5cblx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShFZGl0b3JTdG9yYWdlLkFOT05ZTU9VU19TVEFURV9LRVkpLCBudWxsKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGtlZXBzIHBhZ2UgbG9va3VwcyBpbiBzeW5jIGFmdGVyIGRlbGV0aW9ucyBhcmUgc2F2ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbik7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbc2Vzc2lvbi5wYWdlc1swXSFdXG5cdH0pO1xuXG5cdGNvbnN0IGRlbGV0ZWRQYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkQW5vbnltb3VzUGFnZSgncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChkZWxldGVkUGFnZSwgbnVsbCk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSB0cmFja3MgcHJvbXB0ZWQgdXNlciBpZHMgd2l0aG91dCBkdXBsaWNhdGVzJywgYXN5bmMgKCkgPT4ge1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIGZhbHNlKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLm1hcmtQcm9tcHRlZFVzZXJJZCgndXNlci1hJyk7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2UubWFya1Byb21wdGVkVXNlcklkKCd1c2VyLWEnKTtcblxuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIHRydWUpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFByb21wdGVkVXNlcklkcygpLCBbJ3VzZXItYSddKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGlnbm9yZXMgbWFsZm9ybWVkIHByb21wdGVkIHVzZXIgaWQgcGF5bG9hZHMnLCBhc3luYyAoKSA9PiB7XG5cdGxvY2FsU3RvcmFnZS5zZXRJdGVtKEVkaXRvclN0b3JhZ2UuUFJPTVBURURfVVNFUl9JRFNfS0VZLCBKU09OLnN0cmluZ2lmeShbJ3VzZXItYScsIDQyLCBudWxsXSkpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkUHJvbXB0ZWRVc2VySWRzKCksIFsndXNlci1hJ10pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1iJyksIGZhbHNlKTtcbn0pO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcblxuZXhwb3J0IHR5cGUgUGFnZVN5bmNTdGF0dXMgPSAnbG9jYWwtb25seScgfCAnc3luY2VkJyB8ICdkaXJ0eScgfCAnZGVsZXRlZCcgfCAnY29uZmxpY3QnIHwgJ2luY29uc2lzdGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlIHtcblx0aWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkQXQ6IHN0cmluZztcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG5cdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkVGl0bGU6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRDb250ZW50OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRkaXJ0eTogYm9vbGVhbjtcblx0c3luY1N0YXR1czogUGFnZVN5bmNTdGF0dXM7XG5cdGxhc3RTeW5jZWRWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoY29udGVudCA9ICcnLCBpZCA9IGNyZWF0ZVBhZ2VJZCgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHRpZCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogY3JlYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBudWxsLFxuXHRcdGxhc3RTeW5jZWRDb250ZW50OiBudWxsLFxuXHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IG51bGwsXG5cdFx0ZGlydHk6IHRydWUsXG5cdFx0c3luY1N0YXR1czogJ2xvY2FsLW9ubHknLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBudWxsXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IEVkaXRvclNlc3Npb24ge1xuXHRpZiAoc2Vzc2lvbi5wYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xuXHR9XG5cblx0aWYgKHNlc3Npb24ucGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHNlc3Npb247XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk7XG5cdGlmIChmaXJzdFZpc2libGVQYWdlKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdGFjdGl2ZVBhZ2VJZDogc2Vzc2lvbi5wYWdlc1swXSEuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpLFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2UuZGVsZXRlZEF0ID8gJ2RlbGV0ZWQnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6ICdkZWxldGVkJ1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlSZW1vdGVQYWdlU3RhdGUoXG5cdHBhZ2U6IEVkaXRvclBhZ2UsXG5cdHN0YXRlOiB7XG5cdFx0dGl0bGU6IHN0cmluZztcblx0XHRjb250ZW50OiBzdHJpbmc7XG5cdFx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRcdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHRcdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHR9XG4pOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiBzdGF0ZS50aXRsZSxcblx0XHRjb250ZW50OiBzdGF0ZS5jb250ZW50LFxuXHRcdHRleHQ6IHN0YXRlLmNvbnRlbnQsXG5cdFx0Y3JlYXRlZEF0OiBwYWdlLmNyZWF0ZWRBdCA/PyBzdGF0ZS5jcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBzdGF0ZS51cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0OiBzdGF0ZS5kZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiBzdGF0ZS51cGRhdGVkQXQsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBzdGF0ZS50aXRsZSxcblx0XHRsYXN0U3luY2VkQ29udGVudDogc3RhdGUuY29udGVudCxcblx0XHRsYXN0U3luY2VkRGVsZXRlZEF0OiBzdGF0ZS5kZWxldGVkQXQsXG5cdFx0ZGlydHk6IGZhbHNlLFxuXHRcdHN5bmNTdGF0dXM6IHN0YXRlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdzeW5jZWQnLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBzdGF0ZS51cGRhdGVkQXRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlU3luY2VkKFxuXHRwYWdlOiBFZGl0b3JQYWdlLFxuXHRzeW5jZWRBdDogc3RyaW5nLFxuXHRsYXN0U3luY2VkVmVyc2lvbiA9IHN5bmNlZEF0XG4pOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdGxhc3RTeW5jZWRBdDogc3luY2VkQXQsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGxhc3RTeW5jZWRDb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0ZGlydHk6IGZhbHNlLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2UuZGVsZXRlZEF0ID8gJ2RlbGV0ZWQnIDogJ3N5bmNlZCcsXG5cdFx0bGFzdFN5bmNlZFZlcnNpb25cblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUNvbmZsaWN0Q29weShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZVN1ZmZpeDogc3RyaW5nLCBub3cgPSBuZXcgRGF0ZSgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IG5vdy50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0aWQ6IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHRpdGxlOiBgJHtwYWdlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwID8gcGFnZS50aXRsZS50cmltKCkgOiBVTlRJVExFRF9QQUdFfSAke3RpdGxlU3VmZml4fWAudHJpbSgpLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IGNyZWF0ZWRBdCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRUaXRsZTogbnVsbCxcblx0XHRsYXN0U3luY2VkQ29udGVudDogbnVsbCxcblx0XHRsYXN0U3luY2VkRGVsZXRlZEF0OiBudWxsLFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6ICdjb25mbGljdCcsXG5cdFx0bGFzdFN5bmNlZFZlcnNpb246IG51bGxcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb24odmFsdWU6IHVua25vd24pOiBFZGl0b3JTZXNzaW9uIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRpZiAoaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZSkpIHtcblx0XHRyZXR1cm4gbWlncmF0ZUxlZ2FjeVN0YXRlKHZhbHVlKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZShzdGF0ZS50ZXh0KSwgc3RhdGUpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2UodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jcmVhdGVkQXQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmNyZWF0ZWRBdC5sZW5ndGggPiAwXG5cdFx0XHQ/IHZhbHVlLmNyZWF0ZWRBdFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUuY3JlYXRlZF9hdCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuY3JlYXRlZF9hdC5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUuY3JlYXRlZF9hdFxuXHRcdFx0XHQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgdXBkYXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUudXBkYXRlZEF0ID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51cGRhdGVkQXQubGVuZ3RoID4gMFxuXHRcdFx0PyB2YWx1ZS51cGRhdGVkQXRcblx0XHRcdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRjb25zdCBkZWxldGVkQXQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5kZWxldGVkQXQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmRlbGV0ZWRBdFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUuZGVsZXRlZF9hdCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS5kZWxldGVkX2F0XG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZEF0ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkQXRcblx0XHRcdDogdHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uXG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZFRpdGxlID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZFRpdGxlID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkVGl0bGVcblx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gdHlwZW9mIHZhbHVlLnRpdGxlID09PSAnc3RyaW5nJ1xuXHRcdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpXG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZENvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5sYXN0U3luY2VkQ29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZENvbnRlbnRcblx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gbm9ybWFsaXplZENvbnRlbnRcblx0XHRcdFx0OiBudWxsO1xuXHRjb25zdCBsYXN0U3luY2VkRGVsZXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZERlbGV0ZWRBdCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZERlbGV0ZWRBdFxuXHRcdFx0OiBsYXN0U3luY2VkQXRcblx0XHRcdFx0PyBkZWxldGVkQXRcblx0XHRcdFx0OiBudWxsO1xuXHRjb25zdCBkaXJ0eSA9XG5cdFx0dHlwZW9mIHZhbHVlLmRpcnR5ID09PSAnYm9vbGVhbidcblx0XHRcdD8gdmFsdWUuZGlydHlcblx0XHRcdDogbGFzdFN5bmNlZEF0ID09PSBudWxsO1xuXHRjb25zdCBzeW5jU3RhdHVzID0gbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzLCBkZWxldGVkQXQsIGRpcnR5LCBsYXN0U3luY2VkQXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogYHBhZ2UtJHtpbmRleCArIDF9YCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHQ/IHZhbHVlLnRpdGxlLnRyaW0oKVxuXHRcdFx0XHQ6IGRlcml2ZVBhZ2VUaXRsZShub3JtYWxpemVkQ29udGVudCksXG5cdFx0Y29udGVudDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0dGV4dDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdCxcblx0XHRsYXN0U3luY2VkVGl0bGUsXG5cdFx0bGFzdFN5bmNlZENvbnRlbnQsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdCxcblx0XHRkaXJ0eSxcblx0XHRzeW5jU3RhdHVzLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOlxuXHRcdFx0dHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uXG5cdFx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdFx0PyBsYXN0U3luY2VkQXRcblx0XHRcdFx0XHQ6IHR5cGVvZiB2YWx1ZS5zZXJ2ZXJWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHRcdFx0PyB2YWx1ZS5zZXJ2ZXJWZXJzaW9uXG5cdFx0XHRcdFx0XHQ6IG51bGxcblx0fTtcbn1cblxuZnVuY3Rpb24gaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZTogb2JqZWN0KTogdmFsdWUgaXMgRWRpdG9yU3RhdGUge1xuXHRyZXR1cm4gJ3RleHQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25TdGFydCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvbkVuZCcgaW4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRyZXR1cm4gISF2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnO1xufVxuXG5mdW5jdGlvbiBjbGFtcFNlbGVjdGlvbih2YWx1ZTogbnVtYmVyLCBtYXg6IG51bWJlcikge1xuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4odmFsdWUsIG1heCkpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKFxuXHR2YWx1ZTogdW5rbm93bixcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsLFxuXHRkaXJ0eTogYm9vbGVhbixcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsXG4pOiBQYWdlU3luY1N0YXR1cyB7XG5cdGlmIChcblx0XHR2YWx1ZSA9PT0gJ2xvY2FsLW9ubHknIHx8XG5cdFx0dmFsdWUgPT09ICdzeW5jZWQnIHx8XG5cdFx0dmFsdWUgPT09ICdkaXJ0eScgfHxcblx0XHR2YWx1ZSA9PT0gJ2RlbGV0ZWQnIHx8XG5cdFx0dmFsdWUgPT09ICdjb25mbGljdCcgfHxcblx0XHR2YWx1ZSA9PT0gJ2luY29uc2lzdGVudCdcblx0KSB7XG5cdFx0cmV0dXJuIHZhbHVlO1xuXHR9XG5cblx0aWYgKGRlbGV0ZWRBdCkge1xuXHRcdHJldHVybiAnZGVsZXRlZCc7XG5cdH1cblxuXHRpZiAoZGlydHkpIHtcblx0XHRyZXR1cm4gbGFzdFN5bmNlZEF0ID8gJ2RpcnR5JyA6ICdsb2NhbC1vbmx5Jztcblx0fVxuXG5cdHJldHVybiBsYXN0U3luY2VkQXQgPyAnc3luY2VkJyA6ICdsb2NhbC1vbmx5Jztcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9YDtcbn1cbiIsICJpbXBvcnQgeyBjcmVhdGVTZXNzaW9uLCBub3JtYWxpemVTZXNzaW9uLCB0eXBlIEVkaXRvclBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4uL2NvcmUvc2Vzc2lvbic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVXNlclN5bmNNZXRhIHtcblx0ZGlydHk6IGJvb2xlYW47XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0cGFnZVZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPjtcbn1cblxuY29uc3QgREVGQVVMVF9TWU5DX01FVEE6IFVzZXJTeW5jTWV0YSA9IHtcblx0ZGlydHk6IGZhbHNlLFxuXHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdHBhZ2VWZXJzaW9uczoge31cbn07XG5cbmNvbnN0IERCX05BTUUgPSAnZXotYmxhbmstZWRpdG9yLXN0b3JhZ2UnO1xuY29uc3QgREJfVkVSU0lPTiA9IDI7XG5jb25zdCBLVl9TVE9SRV9OQU1FID0gJ2t2JztcbmNvbnN0IE5PVEVTX1NUT1JFX05BTUUgPSAnbm90ZXMnO1xuY29uc3QgTk9URVNfU0NPUEVfSU5ERVggPSAnc2NvcGUnO1xuY29uc3QgU0VTU0lPTl9NRVRBX1NUT1JFX05BTUUgPSAnc2Vzc2lvbl9tZXRhJztcblxuY29uc3QgQU5PTllNT1VTX1NDT1BFID0gJ2Fub255bW91cyc7XG5jb25zdCBVU0VSX1NDT1BFX1BSRUZJWCA9ICd1c2VyOic7XG5cbmV4cG9ydCBjbGFzcyBFZGl0b3JTdG9yYWdlIHtcblx0cHVibGljIHN0YXRpYyBBTk9OWU1PVVNfU1RBVEVfS0VZID0gJ2JsYW5rLXN0YXRlOmFub255bW91cyc7XG5cdHB1YmxpYyBzdGF0aWMgVVNFUl9TVEFURV9LRVlfUFJFRklYID0gJ2JsYW5rLXN0YXRlOnVzZXI6Jztcblx0cHVibGljIHN0YXRpYyBVU0VSX1NZTkNfTUVUQV9LRVlfUFJFRklYID0gJ2JsYW5rLXN5bmMtbWV0YTp1c2VyOic7XG5cdHB1YmxpYyBzdGF0aWMgUFJPTVBURURfVVNFUl9JRFNfS0VZID0gJ2JsYW5rLWFub255bW91cy1pbXBvcnQtcHJvbXB0ZWQtdXNlci1pZHMnO1xuXG5cdHByaXZhdGUgc3RhdGljIGJhY2tlbmRQcm9taXNlOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXRpYyBtaWdyYXRpb25Qcm9taXNlOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc3RhdGljIG1lbW9yeUJhY2tlbmQgPSBjcmVhdGVNZW1vcnlCYWNrZW5kKCk7XG5cblx0c3RhdGljIGdldEFub255bW91c1N0YXRlS2V5KCkge1xuXHRcdHJldHVybiB0aGlzLkFOT05ZTU9VU19TVEFURV9LRVk7XG5cdH1cblxuXHRzdGF0aWMgZ2V0VXNlclN0YXRlS2V5KHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIGAke3RoaXMuVVNFUl9TVEFURV9LRVlfUFJFRklYfSR7dXNlcklkfWA7XG5cdH1cblxuXHRzdGF0aWMgZ2V0VXNlclN5bmNNZXRhS2V5KHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIGAke3RoaXMuVVNFUl9TWU5DX01FVEFfS0VZX1BSRUZJWH0ke3VzZXJJZH1gO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIHNhdmVBbm9ueW1vdXNTdGF0ZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdGF3YWl0IGJhY2tlbmQuc2F2ZVNlc3Npb24oQU5PTllNT1VTX1NDT1BFLCBzZXNzaW9uKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkQW5vbnltb3VzU3RhdGUoKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdHJldHVybiAoYXdhaXQgYmFja2VuZC5sb2FkU2Vzc2lvbihBTk9OWU1PVVNfU0NPUEUpKSA/PyBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIGFub255bW91cyBlZGl0b3Igc2Vzc2lvbjonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyBhc3luYyBzYXZlVXNlclN0YXRlKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdGF3YWl0IGJhY2tlbmQuc2F2ZVNlc3Npb24oYnVpbGRVc2VyU2NvcGUodXNlcklkKSwgc2Vzc2lvbik7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFVzZXJTdGF0ZSh1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbiB8IG51bGw+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0cmV0dXJuIGF3YWl0IGJhY2tlbmQubG9hZFNlc3Npb24oYnVpbGRVc2VyU2NvcGUodXNlcklkKSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIHVzZXIgZWRpdG9yIHNlc3Npb246JywgZXJyb3IpO1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRBbm9ueW1vdXNQYWdlKHBhZ2VJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JQYWdlIHwgbnVsbD4ge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRyZXR1cm4gYmFja2VuZC5sb2FkUGFnZShBTk9OWU1PVVNfU0NPUEUsIHBhZ2VJZCk7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFVzZXJQYWdlKHVzZXJJZDogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+IHtcblx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0cmV0dXJuIGJhY2tlbmQubG9hZFBhZ2UoYnVpbGRVc2VyU2NvcGUodXNlcklkKSwgcGFnZUlkKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBzYXZlVXNlclN5bmNNZXRhKHVzZXJJZDogc3RyaW5nLCBtZXRhOiBVc2VyU3luY01ldGEpIHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0YXdhaXQgYmFja2VuZC5zZXRLZXlWYWx1ZSh0aGlzLmdldFVzZXJTeW5jTWV0YUtleSh1c2VySWQpLCBKU09OLnN0cmluZ2lmeShtZXRhKSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBzYXZlIHVzZXIgc3luYyBtZXRhOicsIGVycm9yKTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFVzZXJTeW5jTWV0YSh1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8VXNlclN5bmNNZXRhPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGNvbnN0IHN0b3JlZCA9IGF3YWl0IGJhY2tlbmQuZ2V0S2V5VmFsdWUodGhpcy5nZXRVc2VyU3luY01ldGFLZXkodXNlcklkKSk7XG5cdFx0XHRpZiAoIXN0b3JlZCkge1xuXHRcdFx0XHRyZXR1cm4gREVGQVVMVF9TWU5DX01FVEE7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc3RvcmVkKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGRpcnR5OiBwYXJzZWQ/LmRpcnR5ID09PSB0cnVlLFxuXHRcdFx0XHRsYXN0U3luY2VkQXQ6IHR5cGVvZiBwYXJzZWQ/Lmxhc3RTeW5jZWRBdCA9PT0gJ3N0cmluZycgPyBwYXJzZWQubGFzdFN5bmNlZEF0IDogbnVsbCxcblx0XHRcdFx0cGFnZVZlcnNpb25zOiBub3JtYWxpemVQYWdlVmVyc2lvbnMocGFyc2VkPy5wYWdlVmVyc2lvbnMpXG5cdFx0XHR9O1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9hZCB1c2VyIHN5bmMgbWV0YTonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gREVGQVVMVF9TWU5DX01FVEE7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRQcm9tcHRlZFVzZXJJZHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRjb25zdCBzdG9yZWQgPSBhd2FpdCBiYWNrZW5kLmdldEtleVZhbHVlKHRoaXMuUFJPTVBURURfVVNFUl9JRFNfS0VZKTtcblx0XHRcdGlmICghc3RvcmVkKSB7XG5cdFx0XHRcdHJldHVybiBbXTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzdG9yZWQpO1xuXHRcdFx0cmV0dXJuIEFycmF5LmlzQXJyYXkocGFyc2VkKVxuXHRcdFx0XHQ/IHBhcnNlZC5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpXG5cdFx0XHRcdDogW107XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIHByb21wdGVkIHVzZXIgaWRzOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgaGFzUHJvbXB0ZWRVc2VySWQodXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRyZXR1cm4gKGF3YWl0IHRoaXMubG9hZFByb21wdGVkVXNlcklkcygpKS5pbmNsdWRlcyh1c2VySWQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIG1hcmtQcm9tcHRlZFVzZXJJZCh1c2VySWQ6IHN0cmluZykge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwcm9tcHRlZFVzZXJJZHMgPSBhd2FpdCB0aGlzLmxvYWRQcm9tcHRlZFVzZXJJZHMoKTtcblx0XHRcdGlmIChwcm9tcHRlZFVzZXJJZHMuaW5jbHVkZXModXNlcklkKSkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGF3YWl0IGJhY2tlbmQuc2V0S2V5VmFsdWUodGhpcy5QUk9NUFRFRF9VU0VSX0lEU19LRVksIEpTT04uc3RyaW5naWZ5KFsuLi5wcm9tcHRlZFVzZXJJZHMsIHVzZXJJZF0pKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIHNhdmUgcHJvbXB0ZWQgdXNlciBpZHM6JywgZXJyb3IpO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyByZXNldEZvclRlc3RzKCkge1xuXHRcdHRoaXMuYmFja2VuZFByb21pc2UgPSBudWxsO1xuXHRcdHRoaXMubWlncmF0aW9uUHJvbWlzZSA9IG51bGw7XG5cdFx0dGhpcy5tZW1vcnlCYWNrZW5kID0gY3JlYXRlTWVtb3J5QmFja2VuZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgYXN5bmMgZ2V0QmFja2VuZCgpOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB7XG5cdFx0aWYgKCF0aGlzLmJhY2tlbmRQcm9taXNlKSB7XG5cdFx0XHR0aGlzLmJhY2tlbmRQcm9taXNlID0gdGhpcy5pbml0aWFsaXplQmFja2VuZCgpO1xuXHRcdH1cblxuXHRcdHJldHVybiB0aGlzLmJhY2tlbmRQcm9taXNlO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgYXN5bmMgaW5pdGlhbGl6ZUJhY2tlbmQoKTogUHJvbWlzZTxTdG9yYWdlQmFja2VuZD4ge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSB0eXBlb2YgaW5kZXhlZERCID09PSAndW5kZWZpbmVkJyA/IHRoaXMubWVtb3J5QmFja2VuZCA6IGF3YWl0IGNyZWF0ZUluZGV4ZWREYkJhY2tlbmQoKTtcblxuXHRcdGlmICghdGhpcy5taWdyYXRpb25Qcm9taXNlKSB7XG5cdFx0XHR0aGlzLm1pZ3JhdGlvblByb21pc2UgPSBtaWdyYXRlTGVnYWN5TG9jYWxTdG9yYWdlU3RhdGUoYmFja2VuZCk7XG5cdFx0fVxuXG5cdFx0YXdhaXQgdGhpcy5taWdyYXRpb25Qcm9taXNlO1xuXHRcdHJldHVybiBiYWNrZW5kO1xuXHR9XG59XG5cbmludGVyZmFjZSBTdG9yYWdlQmFja2VuZCB7XG5cdGdldEtleVZhbHVlKGtleTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcblx0c2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuXHRzYXZlU2Vzc2lvbihzY29wZTogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogUHJvbWlzZTx2b2lkPjtcblx0bG9hZFNlc3Npb24oc2NvcGU6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbiB8IG51bGw+O1xuXHRsb2FkUGFnZShzY29wZTogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+O1xufVxuXG5pbnRlcmZhY2UgU2Vzc2lvbk1ldGFSZWNvcmQge1xuXHRzY29wZTogc3RyaW5nO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIE5vdGVSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0c2NvcGU6IHN0cmluZztcblx0aWQ6IHN0cmluZztcblx0b3JkZXI6IG51bWJlcjtcblx0cGFnZTogRWRpdG9yUGFnZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVtb3J5QmFja2VuZCgpOiBTdG9yYWdlQmFja2VuZCB7XG5cdGNvbnN0IGtleVZhbHVlcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdGNvbnN0IHNlc3Npb25CeVNjb3BlID0gbmV3IE1hcDxzdHJpbmcsIEVkaXRvclNlc3Npb24+KCk7XG5cblx0cmV0dXJuIHtcblx0XHRhc3luYyBnZXRLZXlWYWx1ZShrZXk6IHN0cmluZykge1xuXHRcdFx0cmV0dXJuIGtleVZhbHVlcy5nZXQoa2V5KSA/PyBudWxsO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdGtleVZhbHVlcy5zZXQoa2V5LCB2YWx1ZSk7XG5cdFx0fSxcblx0XHRhc3luYyBzYXZlU2Vzc2lvbihzY29wZTogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0XHRzZXNzaW9uQnlTY29wZS5zZXQoc2NvcGUsIGNsb25lU2Vzc2lvbihzZXNzaW9uKSk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkU2Vzc2lvbihzY29wZTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkJ5U2NvcGUuZ2V0KHNjb3BlKTtcblx0XHRcdHJldHVybiBzZXNzaW9uID8gY2xvbmVTZXNzaW9uKHNlc3Npb24pIDogbnVsbDtcblx0XHR9LFxuXHRcdGFzeW5jIGxvYWRQYWdlKHNjb3BlOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkJ5U2NvcGUuZ2V0KHNjb3BlKTtcblx0XHRcdGlmICghc2Vzc2lvbikge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBwYWdlSWQpO1xuXHRcdFx0cmV0dXJuIHBhZ2UgPyB7IC4uLnBhZ2UgfSA6IG51bGw7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVJbmRleGVkRGJCYWNrZW5kKCk6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHtcblx0Y29uc3QgZGIgPSBhd2FpdCBvcGVuRGF0YWJhc2UoKTtcblxuXHRyZXR1cm4ge1xuXHRcdGFzeW5jIGdldEtleVZhbHVlKGtleTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKEtWX1NUT1JFX05BTUUsICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3Qgc3RvcmUgPSB0eC5vYmplY3RTdG9yZShLVl9TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8eyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9IHwgdW5kZWZpbmVkPihzdG9yZS5nZXQoa2V5KSk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0XHRyZXR1cm4gcmVjb3JkPy52YWx1ZSA/PyBudWxsO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oS1ZfU1RPUkVfTkFNRSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0dHgub2JqZWN0U3RvcmUoS1ZfU1RPUkVfTkFNRSkucHV0KHsga2V5LCB2YWx1ZSB9KTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHR9LFxuXHRcdGFzeW5jIHNhdmVTZXNzaW9uKHNjb3BlOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oW05PVEVTX1NUT1JFX05BTUUsIFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0Y29uc3Qgbm90ZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgbWV0YVN0b3JlID0gdHgub2JqZWN0U3RvcmUoU0VTU0lPTl9NRVRBX1NUT1JFX05BTUUpO1xuXG5cdFx0XHRjb25zdCBzY29wZUluZGV4ID0gbm90ZXNTdG9yZS5pbmRleChOT1RFU19TQ09QRV9JTkRFWCk7XG5cdFx0XHRjb25zdCBleGlzdGluZ1JlY29yZHMgPSBhd2FpdCByZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmRbXT4oc2NvcGVJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seShzY29wZSkpKTtcblx0XHRcdGNvbnN0IG5leHRLZXlzID0gbmV3IFNldChzZXNzaW9uLnBhZ2VzLm1hcCgocGFnZSkgPT4gYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKSkpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IHJlY29yZCBvZiBleGlzdGluZ1JlY29yZHMpIHtcblx0XHRcdFx0aWYgKCFuZXh0S2V5cy5oYXMocmVjb3JkLmtleSkpIHtcblx0XHRcdFx0XHRub3Rlc1N0b3JlLmRlbGV0ZShyZWNvcmQua2V5KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IFtvcmRlciwgcGFnZV0gb2Ygc2Vzc2lvbi5wYWdlcy5lbnRyaWVzKCkpIHtcblx0XHRcdFx0Y29uc3Qga2V5ID0gYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKTtcblx0XHRcdFx0bm90ZXNTdG9yZS5wdXQoe1xuXHRcdFx0XHRcdGtleSxcblx0XHRcdFx0XHRzY29wZSxcblx0XHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0XHRvcmRlcixcblx0XHRcdFx0XHRwYWdlOiB7IC4uLnBhZ2UgfVxuXHRcdFx0XHR9IHNhdGlzZmllcyBOb3RlUmVjb3JkKTtcblx0XHRcdH1cblxuXHRcdFx0bWV0YVN0b3JlLnB1dCh7XG5cdFx0XHRcdHNjb3BlLFxuXHRcdFx0XHRhY3RpdmVQYWdlSWQ6IHNlc3Npb24uYWN0aXZlUGFnZUlkXG5cdFx0XHR9IHNhdGlzZmllcyBTZXNzaW9uTWV0YVJlY29yZCk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkU2Vzc2lvbihzY29wZTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFtOT1RFU19TVE9SRV9OQU1FLCBTRVNTSU9OX01FVEFfU1RPUkVfTkFNRV0sICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3Qgbm90ZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgbWV0YVN0b3JlID0gdHgub2JqZWN0U3RvcmUoU0VTU0lPTl9NRVRBX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3Qgc2NvcGVJbmRleCA9IG5vdGVzU3RvcmUuaW5kZXgoTk9URVNfU0NPUEVfSU5ERVgpO1xuXG5cdFx0XHRjb25zdCBbbm90ZVJlY29yZHMsIG1ldGFSZWNvcmRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0XHRyZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmRbXT4oc2NvcGVJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seShzY29wZSkpKSxcblx0XHRcdFx0cmVxdWVzdFRvUHJvbWlzZTxTZXNzaW9uTWV0YVJlY29yZCB8IHVuZGVmaW5lZD4obWV0YVN0b3JlLmdldChzY29wZSkpXG5cdFx0XHRdKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblxuXHRcdFx0aWYgKCFtZXRhUmVjb3JkICYmIG5vdGVSZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFnZXMgPSBub3RlUmVjb3Jkc1xuXHRcdFx0XHQuc29ydCgobGVmdCwgcmlnaHQpID0+IGxlZnQub3JkZXIgLSByaWdodC5vcmRlcilcblx0XHRcdFx0Lm1hcCgocmVjb3JkKSA9PiAoeyAuLi5yZWNvcmQucGFnZSB9KSk7XG5cdFx0XHRjb25zdCBhY3RpdmVQYWdlSWQgPSBtZXRhUmVjb3JkPy5hY3RpdmVQYWdlSWQgPz8gcGFnZXNbMF0/LmlkID8/IGNyZWF0ZVNlc3Npb24oKS5hY3RpdmVQYWdlSWQ7XG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplU2Vzc2lvbih7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkUGFnZShzY29wZTogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZykge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihOT1RFU19TVE9SRV9OQU1FLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8Tm90ZVJlY29yZCB8IHVuZGVmaW5lZD4oXG5cdFx0XHRcdHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpLmdldChidWlsZE5vdGVLZXkoc2NvcGUsIHBhZ2VJZCkpXG5cdFx0XHQpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdFx0cmV0dXJuIHJlY29yZCA/IHsgLi4ucmVjb3JkLnBhZ2UgfSA6IG51bGw7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBvcGVuRGF0YWJhc2UoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihEQl9OQU1FLCBEQl9WRVJTSU9OKTtcblxuXHRcdHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gKGV2ZW50KSA9PiB7XG5cdFx0XHRjb25zdCBkYiA9IHJlcXVlc3QucmVzdWx0O1xuXHRcdFx0Y29uc3QgdHggPSByZXF1ZXN0LnRyYW5zYWN0aW9uO1xuXHRcdFx0aWYgKCF0eCkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHByZXZpb3VzVmVyc2lvbiA9IGV2ZW50Lm9sZFZlcnNpb247XG5cdFx0XHRjb25zdCBrdlN0b3JlID0gZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhLVl9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ/IHR4Lm9iamVjdFN0b3JlKEtWX1NUT1JFX05BTUUpXG5cdFx0XHRcdDogZGIuY3JlYXRlT2JqZWN0U3RvcmUoS1ZfU1RPUkVfTkFNRSwgeyBrZXlQYXRoOiAna2V5JyB9KTtcblx0XHRcdGNvbnN0IG5vdGVzU3RvcmUgPSBkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKE5PVEVTX1NUT1JFX05BTUUpXG5cdFx0XHRcdD8gdHgub2JqZWN0U3RvcmUoTk9URVNfU1RPUkVfTkFNRSlcblx0XHRcdFx0OiBkYi5jcmVhdGVPYmplY3RTdG9yZShOT1RFU19TVE9SRV9OQU1FLCB7IGtleVBhdGg6ICdrZXknIH0pO1xuXHRcdFx0aWYgKCFub3Rlc1N0b3JlLmluZGV4TmFtZXMuY29udGFpbnMoTk9URVNfU0NPUEVfSU5ERVgpKSB7XG5cdFx0XHRcdG5vdGVzU3RvcmUuY3JlYXRlSW5kZXgoTk9URVNfU0NPUEVfSU5ERVgsICdzY29wZScsIHsgdW5pcXVlOiBmYWxzZSB9KTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHNlc3Npb25NZXRhU3RvcmUgPSBkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ/IHR4Lm9iamVjdFN0b3JlKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ6IGRiLmNyZWF0ZU9iamVjdFN0b3JlKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FLCB7IGtleVBhdGg6ICdzY29wZScgfSk7XG5cblx0XHRcdGlmIChwcmV2aW91c1ZlcnNpb24gPCAyKSB7XG5cdFx0XHRcdG1pZ3JhdGVJbmRleGVkRGJMZWdhY3lTZXNzaW9uRGF0YShrdlN0b3JlLCBub3Rlc1N0b3JlLCBzZXNzaW9uTWV0YVN0b3JlKTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBtaWdyYXRlSW5kZXhlZERiTGVnYWN5U2Vzc2lvbkRhdGEoXG5cdGt2U3RvcmU6IElEQk9iamVjdFN0b3JlLFxuXHRub3Rlc1N0b3JlOiBJREJPYmplY3RTdG9yZSxcblx0c2Vzc2lvbk1ldGFTdG9yZTogSURCT2JqZWN0U3RvcmVcbikge1xuXHRrdlN0b3JlLm9wZW5DdXJzb3IoKS5vbnN1Y2Nlc3MgPSAoZXZlbnQpID0+IHtcblx0XHRjb25zdCBjdXJzb3IgPSAoZXZlbnQudGFyZ2V0IGFzIElEQlJlcXVlc3Q8SURCQ3Vyc29yV2l0aFZhbHVlIHwgbnVsbD4pLnJlc3VsdDtcblx0XHRpZiAoIWN1cnNvcikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHJlY29yZCA9IGN1cnNvci52YWx1ZSBhcyB7IGtleT86IHVua25vd247IHZhbHVlPzogdW5rbm93biB9O1xuXHRcdGNvbnN0IGtleSA9IHR5cGVvZiByZWNvcmQ/LmtleSA9PT0gJ3N0cmluZycgPyByZWNvcmQua2V5IDogbnVsbDtcblx0XHRjb25zdCB2YWx1ZSA9IHR5cGVvZiByZWNvcmQ/LnZhbHVlID09PSAnc3RyaW5nJyA/IHJlY29yZC52YWx1ZSA6IG51bGw7XG5cdFx0aWYgKCFrZXkgfHwgIXZhbHVlKSB7XG5cdFx0XHRjdXJzb3IuY29udGludWUoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBzY29wZSA9IGdldFNjb3BlRnJvbVN0YXRlS2V5KGtleSk7XG5cdFx0aWYgKCFzY29wZSkge1xuXHRcdFx0Y3Vyc29yLmNvbnRpbnVlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IG5vcm1hbGl6ZVNlc3Npb24oSlNPTi5wYXJzZSh2YWx1ZSkpO1xuXHRcdGlmICghc2Vzc2lvbikge1xuXHRcdFx0Y3Vyc29yLmNvbnRpbnVlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCBbb3JkZXIsIHBhZ2VdIG9mIHNlc3Npb24ucGFnZXMuZW50cmllcygpKSB7XG5cdFx0XHRub3Rlc1N0b3JlLnB1dCh7XG5cdFx0XHRcdGtleTogYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKSxcblx0XHRcdFx0c2NvcGUsXG5cdFx0XHRcdGlkOiBwYWdlLmlkLFxuXHRcdFx0XHRvcmRlcixcblx0XHRcdFx0cGFnZTogeyAuLi5wYWdlIH1cblx0XHRcdH0gc2F0aXNmaWVzIE5vdGVSZWNvcmQpO1xuXHRcdH1cblxuXHRcdHNlc3Npb25NZXRhU3RvcmUucHV0KHtcblx0XHRcdHNjb3BlLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLmFjdGl2ZVBhZ2VJZFxuXHRcdH0gc2F0aXNmaWVzIFNlc3Npb25NZXRhUmVjb3JkKTtcblx0XHRrdlN0b3JlLmRlbGV0ZShrZXkpO1xuXHRcdGN1cnNvci5jb250aW51ZSgpO1xuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5TG9jYWxTdG9yYWdlU3RhdGUoYmFja2VuZDogU3RvcmFnZUJhY2tlbmQpIHtcblx0aWYgKHR5cGVvZiBsb2NhbFN0b3JhZ2UgPT09ICd1bmRlZmluZWQnKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3Qga2V5czogc3RyaW5nW10gPSBbXTtcblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGxvY2FsU3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcblx0XHRjb25zdCBrZXkgPSBsb2NhbFN0b3JhZ2Uua2V5KGluZGV4KTtcblx0XHRpZiAoa2V5KSB7XG5cdFx0XHRrZXlzLnB1c2goa2V5KTtcblx0XHR9XG5cdH1cblxuXHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG5cdFx0Y29uc3QgdmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuXHRcdGlmICh2YWx1ZSA9PT0gbnVsbCkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2NvcGUgPSBnZXRTY29wZUZyb21TdGF0ZUtleShrZXkpO1xuXHRcdGlmIChzY29wZSkge1xuXHRcdFx0Y29uc3Qgc2Vzc2lvbiA9IG5vcm1hbGl6ZVNlc3Npb24oSlNPTi5wYXJzZSh2YWx1ZSkpO1xuXHRcdFx0aWYgKHNlc3Npb24pIHtcblx0XHRcdFx0YXdhaXQgYmFja2VuZC5zYXZlU2Vzc2lvbihzY29wZSwgc2Vzc2lvbik7XG5cdFx0XHR9XG5cdFx0XHRsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKGtleSA9PT0gJ2V6LWJsYW5rLXNlc3Npb24tdjInKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbihKU09OLnBhcnNlKHZhbHVlKSk7XG5cdFx0XHRpZiAoc2Vzc2lvbikge1xuXHRcdFx0XHRhd2FpdCBiYWNrZW5kLnNhdmVTZXNzaW9uKEFOT05ZTU9VU19TQ09QRSwgc2Vzc2lvbik7XG5cdFx0XHR9XG5cdFx0XHRsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKFxuXHRcdFx0a2V5ID09PSBFZGl0b3JTdG9yYWdlLlBST01QVEVEX1VTRVJfSURTX0tFWSB8fFxuXHRcdFx0a2V5LnN0YXJ0c1dpdGgoRWRpdG9yU3RvcmFnZS5VU0VSX1NZTkNfTUVUQV9LRVlfUFJFRklYKVxuXHRcdCkge1xuXHRcdFx0YXdhaXQgYmFja2VuZC5zZXRLZXlWYWx1ZShrZXksIHZhbHVlKTtcblx0XHRcdGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKGtleSk7XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGdldFNjb3BlRnJvbVN0YXRlS2V5KGtleTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG5cdGlmIChrZXkgPT09IEVkaXRvclN0b3JhZ2UuQU5PTllNT1VTX1NUQVRFX0tFWSkge1xuXHRcdHJldHVybiBBTk9OWU1PVVNfU0NPUEU7XG5cdH1cblxuXHRpZiAoa2V5LnN0YXJ0c1dpdGgoRWRpdG9yU3RvcmFnZS5VU0VSX1NUQVRFX0tFWV9QUkVGSVgpKSB7XG5cdFx0cmV0dXJuIGAke1VTRVJfU0NPUEVfUFJFRklYfSR7a2V5LnNsaWNlKEVkaXRvclN0b3JhZ2UuVVNFUl9TVEFURV9LRVlfUFJFRklYLmxlbmd0aCl9YDtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBidWlsZFVzZXJTY29wZSh1c2VySWQ6IHN0cmluZykge1xuXHRyZXR1cm4gYCR7VVNFUl9TQ09QRV9QUkVGSVh9JHt1c2VySWR9YDtcbn1cblxuZnVuY3Rpb24gYnVpbGROb3RlS2V5KHNjb3BlOiBzdHJpbmcsIGlkOiBzdHJpbmcpIHtcblx0cmV0dXJuIGAke3Njb3BlfToke2lkfWA7XG59XG5cbmZ1bmN0aW9uIGNsb25lU2Vzc2lvbihzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCxcblx0XHRwYWdlczogc2Vzc2lvbi5wYWdlcy5tYXAoKHBhZ2UpID0+ICh7IC4uLnBhZ2UgfSkpXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2VWZXJzaW9ucyh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+IHtcblx0aWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG5cdFx0cmV0dXJuIHt9O1xuXHR9XG5cblx0cmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhcblx0XHRPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikuZmlsdGVyKChbLCB2ZXJzaW9uXSkgPT4ge1xuXHRcdFx0cmV0dXJuIHR5cGVvZiB2ZXJzaW9uID09PSAnc3RyaW5nJyB8fCB2ZXJzaW9uID09PSBudWxsO1xuXHRcdH0pIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZyB8IG51bGxdPlxuXHQpO1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9Qcm9taXNlPFQ+KHJlcXVlc3Q6IElEQlJlcXVlc3Q8VD4pOiBQcm9taXNlPFQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRyZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuXHRcdHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIHRyYW5zYWN0aW9uVG9Qcm9taXNlKHRyYW5zYWN0aW9uOiBJREJUcmFuc2FjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiByZXNvbHZlKCk7XG5cdFx0dHJhbnNhY3Rpb24ub25lcnJvciA9ICgpID0+IHJlamVjdCh0cmFuc2FjdGlvbi5lcnJvcik7XG5cdFx0dHJhbnNhY3Rpb24ub25hYm9ydCA9ICgpID0+IHJlamVjdCh0cmFuc2FjdGlvbi5lcnJvciA/PyBuZXcgRXJyb3IoJ0luZGV4ZWREQiB0cmFuc2FjdGlvbiBhYm9ydGVkJykpO1xuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUN3QlosSUFBTSxnQkFBZ0I7QUFFdEIsU0FBUyxnQkFBZ0IsU0FBeUI7QUFDeEQsUUFBTSxZQUFZLFFBQ2hCLE1BQU0sSUFBSSxFQUNWLElBQUksQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLEVBQ3pCLEtBQUssQ0FBQyxTQUFTLEtBQUssU0FBUyxDQUFDO0FBRWhDLE1BQUksQ0FBQyxXQUFXO0FBQ2YsV0FBTztBQUFBLEVBQ1I7QUFFQSxTQUFPLFVBQVUsUUFBUSxRQUFRLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUNsRDtBQUVPLFNBQVMsV0FBVyxVQUFVLElBQUksS0FBSyxhQUFhLEdBQWU7QUFDekUsUUFBTSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQ3pDLFNBQU87QUFBQSxJQUNOO0FBQUEsSUFDQSxPQUFPLGdCQUFnQixPQUFPO0FBQUEsSUFDOUI7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUNOLGdCQUFnQjtBQUFBLElBQ2hCLGNBQWM7QUFBQSxJQUNkO0FBQUEsSUFDQSxXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxjQUFjO0FBQUEsSUFDZCxpQkFBaUI7QUFBQSxJQUNqQixtQkFBbUI7QUFBQSxJQUNuQixxQkFBcUI7QUFBQSxJQUNyQixPQUFPO0FBQUEsSUFDUCxZQUFZO0FBQUEsSUFDWixtQkFBbUI7QUFBQSxFQUNwQjtBQUNEO0FBRU8sU0FBUyxnQkFBK0I7QUFDOUMsUUFBTSxPQUFPLFdBQVc7QUFDeEIsU0FBTztBQUFBLElBQ04sT0FBTyxDQUFDLElBQUk7QUFBQSxJQUNaLGNBQWMsS0FB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
