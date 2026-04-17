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
    deletedAt: null
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
  const contentChanged = state.text !== page.content;
  const selectionChanged = state.selectionStart !== page.selectionStart || state.selectionEnd !== page.selectionEnd;
  if (!contentChanged && !selectionChanged) {
    return page;
  }
  const nextPage = {
    ...page,
    ...state,
    content: state.text
  };
  if (!contentChanged) {
    return nextPage;
  }
  const previousDerivedTitle = derivePageTitle(page.content);
  const nextDerivedTitle = derivePageTitle(state.text);
  const shouldAutoDeriveTitle = page.title === previousDerivedTitle;
  return {
    ...nextPage,
    title: shouldAutoDeriveTitle ? nextDerivedTitle : page.title,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : typeof value.updated_at === "string" && value.updated_at.length > 0 ? value.updated_at : createdAt;
  const deletedAt = typeof value.deletedAt === "string" ? value.deletedAt : typeof value.deleted_at === "string" ? value.deleted_at : null;
  return {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : `page-${index + 1}`,
    title: typeof value.title === "string" && value.title.trim().length > 0 ? value.title.trim() : derivePageTitle(normalizedContent),
    content: normalizedContent,
    text: normalizedContent,
    selectionStart,
    selectionEnd,
    createdAt,
    updatedAt,
    deletedAt
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
function createPageId() {
  return `page-${Math.random().toString(36).slice(2, 10)}`;
}

// src/lib/editor/persistence/storage.ts
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
    if (key === EditorStorage.PROMPTED_USER_IDS_KEY) {
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
  const pageB = createPage("beta");
  pageB.id = "page-b";
  pageB.title = "B";
  pageB.createdAt = "2026-04-14T00:00:00.000Z";
  pageB.updatedAt = "2026-04-14T00:00:00.000Z";
  pageB.deletedAt = null;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3RvcmFnZS50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvcmUvc2Vzc2lvbi50cyIsICIuLi9zcmMvbGliL2VkaXRvci9wZXJzaXN0ZW5jZS9zdG9yYWdlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgRWRpdG9yU3RvcmFnZSB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3N0b3JhZ2UudHMnO1xuaW1wb3J0IHsgY3JlYXRlUGFnZSwgdHlwZSBFZGl0b3JTZXNzaW9uIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxuY2xhc3MgTWVtb3J5U3RvcmFnZSB7XG5cdHByaXZhdGUgdmFsdWVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblxuXHRnZXQgbGVuZ3RoKCkge1xuXHRcdHJldHVybiB0aGlzLnZhbHVlcy5zaXplO1xuXHR9XG5cblx0Z2V0SXRlbShrZXk6IHN0cmluZykge1xuXHRcdHJldHVybiB0aGlzLnZhbHVlcy5nZXQoa2V5KSA/PyBudWxsO1xuXHR9XG5cblx0a2V5KGluZGV4OiBudW1iZXIpIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMudmFsdWVzLmtleXMoKV1baW5kZXhdID8/IG51bGw7XG5cdH1cblxuXHRzZXRJdGVtKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSB7XG5cdFx0dGhpcy52YWx1ZXMuc2V0KGtleSwgdmFsdWUpO1xuXHR9XG5cblx0cmVtb3ZlSXRlbShrZXk6IHN0cmluZykge1xuXHRcdHRoaXMudmFsdWVzLmRlbGV0ZShrZXkpO1xuXHR9XG5cblx0Y2xlYXIoKSB7XG5cdFx0dGhpcy52YWx1ZXMuY2xlYXIoKTtcblx0fVxufVxuXG5mdW5jdGlvbiBjcmVhdGVTZXNzaW9uKGFjdGl2ZVBhZ2VJZCA9ICdwYWdlLWEnKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2VBID0gY3JlYXRlUGFnZSgnYWxwaGEnKTtcblx0cGFnZUEuaWQgPSAncGFnZS1hJztcblx0cGFnZUEudGl0bGUgPSAnQSc7XG5cdHBhZ2VBLmNyZWF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXHRwYWdlQS51cGRhdGVkQXQgPSAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJztcblx0cGFnZUEuZGVsZXRlZEF0ID0gbnVsbDtcblxuXHRjb25zdCBwYWdlQiA9IGNyZWF0ZVBhZ2UoJ2JldGEnKTtcblx0cGFnZUIuaWQgPSAncGFnZS1iJztcblx0cGFnZUIudGl0bGUgPSAnQic7XG5cdHBhZ2VCLmNyZWF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXHRwYWdlQi51cGRhdGVkQXQgPSAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJztcblx0cGFnZUIuZGVsZXRlZEF0ID0gbnVsbDtcblxuXHRyZXR1cm4ge1xuXHRcdGFjdGl2ZVBhZ2VJZCxcblx0XHRwYWdlczogW3BhZ2VBLCBwYWdlQl1cblx0fTtcbn1cblxudGVzdC5iZWZvcmVFYWNoKCgpID0+IHtcblx0RWRpdG9yU3RvcmFnZS5yZXNldEZvclRlc3RzKCk7XG5cdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShnbG9iYWxUaGlzLCAnbG9jYWxTdG9yYWdlJywge1xuXHRcdHZhbHVlOiBuZXcgTWVtb3J5U3RvcmFnZSgpLFxuXHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxuXHR9KTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHNhdmVzIGFuZCBsb2FkcyBhbm9ueW1vdXMgc3RhdGUgdGhyb3VnaCB0aGUgZGF0YWJhc2UnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWInKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVBbm9ueW1vdXNTdGF0ZShzZXNzaW9uKTtcblxuXHRjb25zdCBsb2FkZWQgPSBhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRBbm9ueW1vdXNTdGF0ZSgpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLnBhZ2VzLmxlbmd0aCwgc2Vzc2lvbi5wYWdlcy5sZW5ndGgpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIHVzZXItc2NvcGVkIHN0YXRlIHNlcGFyYXRlbHkgcGVyIGFjY291bnQnLCBhc3luYyAoKSA9PiB7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVVzZXJTdGF0ZSgndXNlci1hJywgY3JlYXRlU2Vzc2lvbigncGFnZS1hJykpO1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVVc2VyU3RhdGUoJ3VzZXItYicsIGNyZWF0ZVNlc3Npb24oJ3BhZ2UtYicpKTtcblxuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1hJykpPy5hY3RpdmVQYWdlSWQsICdwYWdlLWEnKTtcblx0YXNzZXJ0LmVxdWFsKChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYicpKT8uYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBsb2FkcyBhIHNpbmdsZSBwYWdlIHdpdGhvdXQgcmVxdWlyaW5nIGZ1bGwgc2Vzc2lvbiBjb25zdW1lcnMnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBzZXNzaW9uKTtcblxuXHRjb25zdCBwYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclBhZ2UoJ3VzZXItYScsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2U/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5jb250ZW50LCAnYmV0YScpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2UgbWlncmF0ZXMgdGhlIGxlZ2FjeSBhbm9ueW1vdXMgSlNPTiBzZXNzaW9uIGludG8gdGhlIGRhdGFiYXNlJywgYXN5bmMgKCkgPT4ge1xuXHRsb2NhbFN0b3JhZ2Uuc2V0SXRlbShcblx0XHRFZGl0b3JTdG9yYWdlLkFOT05ZTU9VU19TVEFURV9LRVksXG5cdFx0SlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0cGFnZXM6IGNyZWF0ZVNlc3Npb24oJ3BhZ2UtYicpLnBhZ2VzLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiAncGFnZS1iJ1xuXHRcdH0pXG5cdCk7XG5cblx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShFZGl0b3JTdG9yYWdlLkFOT05ZTU9VU19TVEFURV9LRVkpLCBudWxsKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGtlZXBzIHBhZ2UgbG9va3VwcyBpbiBzeW5jIGFmdGVyIGRlbGV0aW9ucyBhcmUgc2F2ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbik7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbc2Vzc2lvbi5wYWdlc1swXSFdXG5cdH0pO1xuXG5cdGNvbnN0IGRlbGV0ZWRQYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkQW5vbnltb3VzUGFnZSgncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChkZWxldGVkUGFnZSwgbnVsbCk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSB0cmFja3MgcHJvbXB0ZWQgdXNlciBpZHMgd2l0aG91dCBkdXBsaWNhdGVzJywgYXN5bmMgKCkgPT4ge1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIGZhbHNlKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLm1hcmtQcm9tcHRlZFVzZXJJZCgndXNlci1hJyk7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2UubWFya1Byb21wdGVkVXNlcklkKCd1c2VyLWEnKTtcblxuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIHRydWUpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFByb21wdGVkVXNlcklkcygpLCBbJ3VzZXItYSddKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGlnbm9yZXMgbWFsZm9ybWVkIHByb21wdGVkIHVzZXIgaWQgcGF5bG9hZHMnLCBhc3luYyAoKSA9PiB7XG5cdGxvY2FsU3RvcmFnZS5zZXRJdGVtKEVkaXRvclN0b3JhZ2UuUFJPTVBURURfVVNFUl9JRFNfS0VZLCBKU09OLnN0cmluZ2lmeShbJ3VzZXItYScsIDQyLCBudWxsXSkpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkUHJvbXB0ZWRVc2VySWRzKCksIFsndXNlci1hJ10pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1hJyksIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZFVzZXJJZCgndXNlci1iJyksIGZhbHNlKTtcbn0pO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQYWdlIGV4dGVuZHMgRWRpdG9yU3RhdGUge1xuXHRpZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoY29udGVudCA9ICcnLCBpZCA9IGNyZWF0ZVBhZ2VJZCgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHRpZCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogY3JlYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogbnVsbFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbigpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2UoKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGlmIChzZXNzaW9uLnBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKSkge1xuXHRcdHJldHVybiBzZXNzaW9uO1xuXHR9XG5cblx0Y29uc3QgZmlyc3RWaXNpYmxlUGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpO1xuXHRpZiAoZmlyc3RWaXNpYmxlUGFnZSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBmaXJzdFZpc2libGVQYWdlLmlkXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4uc2Vzc2lvbixcblx0XHRhY3RpdmVQYWdlSWQ6IHNlc3Npb24ucGFnZXNbMF0hLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlU3RhdGUocGFnZTogRWRpdG9yUGFnZSwgc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNvbnRlbnRDaGFuZ2VkID0gc3RhdGUudGV4dCAhPT0gcGFnZS5jb250ZW50O1xuXHRjb25zdCBzZWxlY3Rpb25DaGFuZ2VkID1cblx0XHRzdGF0ZS5zZWxlY3Rpb25TdGFydCAhPT0gcGFnZS5zZWxlY3Rpb25TdGFydCB8fCBzdGF0ZS5zZWxlY3Rpb25FbmQgIT09IHBhZ2Uuc2VsZWN0aW9uRW5kO1xuXHRpZiAoIWNvbnRlbnRDaGFuZ2VkICYmICFzZWxlY3Rpb25DaGFuZ2VkKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRjb25zdCBuZXh0UGFnZTogRWRpdG9yUGFnZSA9IHtcblx0XHQuLi5wYWdlLFxuXHRcdC4uLnN0YXRlLFxuXHRcdGNvbnRlbnQ6IHN0YXRlLnRleHRcblx0fTtcblxuXHRpZiAoIWNvbnRlbnRDaGFuZ2VkKSB7XG5cdFx0cmV0dXJuIG5leHRQYWdlO1xuXHR9XG5cblx0Y29uc3QgcHJldmlvdXNEZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUocGFnZS5jb250ZW50KTtcblx0Y29uc3QgbmV4dERlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShzdGF0ZS50ZXh0KTtcblx0Y29uc3Qgc2hvdWxkQXV0b0Rlcml2ZVRpdGxlID0gcGFnZS50aXRsZSA9PT0gcHJldmlvdXNEZXJpdmVkVGl0bGU7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5uZXh0UGFnZSxcblx0XHR0aXRsZTogc2hvdWxkQXV0b0Rlcml2ZVRpdGxlID8gbmV4dERlcml2ZWRUaXRsZSA6IHBhZ2UudGl0bGUsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURlbGV0ZWQocGFnZTogRWRpdG9yUGFnZSwgZGVsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRkZWxldGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBkZWxldGVkQXRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb24odmFsdWU6IHVua25vd24pOiBFZGl0b3JTZXNzaW9uIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRpZiAoaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZSkpIHtcblx0XHRyZXR1cm4gbWlncmF0ZUxlZ2FjeVN0YXRlKHZhbHVlKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZShzdGF0ZS50ZXh0KSwgc3RhdGUpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2UodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jcmVhdGVkQXQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmNyZWF0ZWRBdC5sZW5ndGggPiAwXG5cdFx0XHQ/IHZhbHVlLmNyZWF0ZWRBdFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUuY3JlYXRlZF9hdCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuY3JlYXRlZF9hdC5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUuY3JlYXRlZF9hdFxuXHRcdFx0XHQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgdXBkYXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUudXBkYXRlZEF0ID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51cGRhdGVkQXQubGVuZ3RoID4gMFxuXHRcdFx0PyB2YWx1ZS51cGRhdGVkQXRcblx0XHRcdDogdHlwZW9mIHZhbHVlLnVwZGF0ZWRfYXQgPT09ICdzdHJpbmcnICYmIHZhbHVlLnVwZGF0ZWRfYXQubGVuZ3RoID4gMFxuXHRcdFx0XHQ/IHZhbHVlLnVwZGF0ZWRfYXRcblx0XHRcdFx0OiBjcmVhdGVkQXQ7XG5cdGNvbnN0IGRlbGV0ZWRBdCA9XG5cdFx0dHlwZW9mIHZhbHVlLmRlbGV0ZWRBdCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuZGVsZXRlZEF0XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS5kZWxldGVkX2F0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLmRlbGV0ZWRfYXRcblx0XHRcdFx0OiBudWxsO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogYHBhZ2UtJHtpbmRleCArIDF9YCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdFxuXHR9O1xufVxuXG5mdW5jdGlvbiBpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlOiBvYmplY3QpOiB2YWx1ZSBpcyBFZGl0b3JTdGF0ZSB7XG5cdHJldHVybiAndGV4dCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvblN0YXJ0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uRW5kJyBpbiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG5cdHJldHVybiAhIXZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCc7XG59XG5cbmZ1bmN0aW9uIGNsYW1wU2VsZWN0aW9uKHZhbHVlOiBudW1iZXIsIG1heDogbnVtYmVyKSB7XG5cdHJldHVybiBNYXRoLm1heCgwLCBNYXRoLm1pbih2YWx1ZSwgbWF4KSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhZ2VJZCgpIHtcblx0cmV0dXJuIGBwYWdlLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfWA7XG59XG4iLCAiaW1wb3J0IHsgY3JlYXRlU2Vzc2lvbiwgbm9ybWFsaXplU2Vzc2lvbiwgdHlwZSBFZGl0b3JQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9jb3JlL3Nlc3Npb24nO1xuXG5jb25zdCBEQl9OQU1FID0gJ2V6LWJsYW5rLWVkaXRvci1zdG9yYWdlJztcbmNvbnN0IERCX1ZFUlNJT04gPSAyO1xuY29uc3QgS1ZfU1RPUkVfTkFNRSA9ICdrdic7XG5jb25zdCBOT1RFU19TVE9SRV9OQU1FID0gJ25vdGVzJztcbmNvbnN0IE5PVEVTX1NDT1BFX0lOREVYID0gJ3Njb3BlJztcbmNvbnN0IFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FID0gJ3Nlc3Npb25fbWV0YSc7XG5cbmNvbnN0IEFOT05ZTU9VU19TQ09QRSA9ICdhbm9ueW1vdXMnO1xuY29uc3QgVVNFUl9TQ09QRV9QUkVGSVggPSAndXNlcjonO1xuXG5leHBvcnQgY2xhc3MgRWRpdG9yU3RvcmFnZSB7XG5cdHB1YmxpYyBzdGF0aWMgQU5PTllNT1VTX1NUQVRFX0tFWSA9ICdibGFuay1zdGF0ZTphbm9ueW1vdXMnO1xuXHRwdWJsaWMgc3RhdGljIFVTRVJfU1RBVEVfS0VZX1BSRUZJWCA9ICdibGFuay1zdGF0ZTp1c2VyOic7XG5cdHB1YmxpYyBzdGF0aWMgUFJPTVBURURfVVNFUl9JRFNfS0VZID0gJ2JsYW5rLWFub255bW91cy1pbXBvcnQtcHJvbXB0ZWQtdXNlci1pZHMnO1xuXG5cdHByaXZhdGUgc3RhdGljIGJhY2tlbmRQcm9taXNlOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXRpYyBtaWdyYXRpb25Qcm9taXNlOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc3RhdGljIG1lbW9yeUJhY2tlbmQgPSBjcmVhdGVNZW1vcnlCYWNrZW5kKCk7XG5cblx0c3RhdGljIGdldEFub255bW91c1N0YXRlS2V5KCkge1xuXHRcdHJldHVybiB0aGlzLkFOT05ZTU9VU19TVEFURV9LRVk7XG5cdH1cblxuXHRzdGF0aWMgZ2V0VXNlclN0YXRlS2V5KHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIGAke3RoaXMuVVNFUl9TVEFURV9LRVlfUFJFRklYfSR7dXNlcklkfWA7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0YXdhaXQgYmFja2VuZC5zYXZlU2Vzc2lvbihBTk9OWU1PVVNfU0NPUEUsIHNlc3Npb24pO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRBbm9ueW1vdXNTdGF0ZSgpOiBQcm9taXNlPEVkaXRvclNlc3Npb24+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0cmV0dXJuIChhd2FpdCBiYWNrZW5kLmxvYWRTZXNzaW9uKEFOT05ZTU9VU19TQ09QRSkpID8/IGNyZWF0ZVNlc3Npb24oKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvYWQgYW5vbnltb3VzIGVkaXRvciBzZXNzaW9uOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIHNhdmVVc2VyU3RhdGUodXNlcklkOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0YXdhaXQgYmFja2VuZC5zYXZlU2Vzc2lvbihidWlsZFVzZXJTY29wZSh1c2VySWQpLCBzZXNzaW9uKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkVXNlclN0YXRlKHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uIHwgbnVsbD4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRyZXR1cm4gYXdhaXQgYmFja2VuZC5sb2FkU2Vzc2lvbihidWlsZFVzZXJTY29wZSh1c2VySWQpKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvYWQgdXNlciBlZGl0b3Igc2Vzc2lvbjonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZEFub255bW91c1BhZ2UocGFnZUlkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclBhZ2UgfCBudWxsPiB7XG5cdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdHJldHVybiBiYWNrZW5kLmxvYWRQYWdlKEFOT05ZTU9VU19TQ09QRSwgcGFnZUlkKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkVXNlclBhZ2UodXNlcklkOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JQYWdlIHwgbnVsbD4ge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRyZXR1cm4gYmFja2VuZC5sb2FkUGFnZShidWlsZFVzZXJTY29wZSh1c2VySWQpLCBwYWdlSWQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRQcm9tcHRlZFVzZXJJZHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRjb25zdCBzdG9yZWQgPSBhd2FpdCBiYWNrZW5kLmdldEtleVZhbHVlKHRoaXMuUFJPTVBURURfVVNFUl9JRFNfS0VZKTtcblx0XHRcdGlmICghc3RvcmVkKSB7XG5cdFx0XHRcdHJldHVybiBbXTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzdG9yZWQpO1xuXHRcdFx0cmV0dXJuIEFycmF5LmlzQXJyYXkocGFyc2VkKVxuXHRcdFx0XHQ/IHBhcnNlZC5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpXG5cdFx0XHRcdDogW107XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIHByb21wdGVkIHVzZXIgaWRzOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgaGFzUHJvbXB0ZWRVc2VySWQodXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRyZXR1cm4gKGF3YWl0IHRoaXMubG9hZFByb21wdGVkVXNlcklkcygpKS5pbmNsdWRlcyh1c2VySWQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIG1hcmtQcm9tcHRlZFVzZXJJZCh1c2VySWQ6IHN0cmluZykge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwcm9tcHRlZFVzZXJJZHMgPSBhd2FpdCB0aGlzLmxvYWRQcm9tcHRlZFVzZXJJZHMoKTtcblx0XHRcdGlmIChwcm9tcHRlZFVzZXJJZHMuaW5jbHVkZXModXNlcklkKSkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGF3YWl0IGJhY2tlbmQuc2V0S2V5VmFsdWUodGhpcy5QUk9NUFRFRF9VU0VSX0lEU19LRVksIEpTT04uc3RyaW5naWZ5KFsuLi5wcm9tcHRlZFVzZXJJZHMsIHVzZXJJZF0pKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIHNhdmUgcHJvbXB0ZWQgdXNlciBpZHM6JywgZXJyb3IpO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyByZXNldEZvclRlc3RzKCkge1xuXHRcdHRoaXMuYmFja2VuZFByb21pc2UgPSBudWxsO1xuXHRcdHRoaXMubWlncmF0aW9uUHJvbWlzZSA9IG51bGw7XG5cdFx0dGhpcy5tZW1vcnlCYWNrZW5kID0gY3JlYXRlTWVtb3J5QmFja2VuZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgYXN5bmMgZ2V0QmFja2VuZCgpOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB7XG5cdFx0aWYgKCF0aGlzLmJhY2tlbmRQcm9taXNlKSB7XG5cdFx0XHR0aGlzLmJhY2tlbmRQcm9taXNlID0gdGhpcy5pbml0aWFsaXplQmFja2VuZCgpO1xuXHRcdH1cblxuXHRcdHJldHVybiB0aGlzLmJhY2tlbmRQcm9taXNlO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgYXN5bmMgaW5pdGlhbGl6ZUJhY2tlbmQoKTogUHJvbWlzZTxTdG9yYWdlQmFja2VuZD4ge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSB0eXBlb2YgaW5kZXhlZERCID09PSAndW5kZWZpbmVkJyA/IHRoaXMubWVtb3J5QmFja2VuZCA6IGF3YWl0IGNyZWF0ZUluZGV4ZWREYkJhY2tlbmQoKTtcblxuXHRcdGlmICghdGhpcy5taWdyYXRpb25Qcm9taXNlKSB7XG5cdFx0XHR0aGlzLm1pZ3JhdGlvblByb21pc2UgPSBtaWdyYXRlTGVnYWN5TG9jYWxTdG9yYWdlU3RhdGUoYmFja2VuZCk7XG5cdFx0fVxuXG5cdFx0YXdhaXQgdGhpcy5taWdyYXRpb25Qcm9taXNlO1xuXHRcdHJldHVybiBiYWNrZW5kO1xuXHR9XG59XG5cbmludGVyZmFjZSBTdG9yYWdlQmFja2VuZCB7XG5cdGdldEtleVZhbHVlKGtleTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcblx0c2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuXHRzYXZlU2Vzc2lvbihzY29wZTogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogUHJvbWlzZTx2b2lkPjtcblx0bG9hZFNlc3Npb24oc2NvcGU6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbiB8IG51bGw+O1xuXHRsb2FkUGFnZShzY29wZTogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+O1xufVxuXG5pbnRlcmZhY2UgU2Vzc2lvbk1ldGFSZWNvcmQge1xuXHRzY29wZTogc3RyaW5nO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIE5vdGVSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0c2NvcGU6IHN0cmluZztcblx0aWQ6IHN0cmluZztcblx0b3JkZXI6IG51bWJlcjtcblx0cGFnZTogRWRpdG9yUGFnZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVtb3J5QmFja2VuZCgpOiBTdG9yYWdlQmFja2VuZCB7XG5cdGNvbnN0IGtleVZhbHVlcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdGNvbnN0IHNlc3Npb25CeVNjb3BlID0gbmV3IE1hcDxzdHJpbmcsIEVkaXRvclNlc3Npb24+KCk7XG5cblx0cmV0dXJuIHtcblx0XHRhc3luYyBnZXRLZXlWYWx1ZShrZXk6IHN0cmluZykge1xuXHRcdFx0cmV0dXJuIGtleVZhbHVlcy5nZXQoa2V5KSA/PyBudWxsO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdGtleVZhbHVlcy5zZXQoa2V5LCB2YWx1ZSk7XG5cdFx0fSxcblx0XHRhc3luYyBzYXZlU2Vzc2lvbihzY29wZTogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0XHRzZXNzaW9uQnlTY29wZS5zZXQoc2NvcGUsIGNsb25lU2Vzc2lvbihzZXNzaW9uKSk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkU2Vzc2lvbihzY29wZTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkJ5U2NvcGUuZ2V0KHNjb3BlKTtcblx0XHRcdHJldHVybiBzZXNzaW9uID8gY2xvbmVTZXNzaW9uKHNlc3Npb24pIDogbnVsbDtcblx0XHR9LFxuXHRcdGFzeW5jIGxvYWRQYWdlKHNjb3BlOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkJ5U2NvcGUuZ2V0KHNjb3BlKTtcblx0XHRcdGlmICghc2Vzc2lvbikge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBwYWdlSWQpO1xuXHRcdFx0cmV0dXJuIHBhZ2UgPyB7IC4uLnBhZ2UgfSA6IG51bGw7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVJbmRleGVkRGJCYWNrZW5kKCk6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHtcblx0Y29uc3QgZGIgPSBhd2FpdCBvcGVuRGF0YWJhc2UoKTtcblxuXHRyZXR1cm4ge1xuXHRcdGFzeW5jIGdldEtleVZhbHVlKGtleTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKEtWX1NUT1JFX05BTUUsICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3Qgc3RvcmUgPSB0eC5vYmplY3RTdG9yZShLVl9TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8eyBrZXk6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9IHwgdW5kZWZpbmVkPihzdG9yZS5nZXQoa2V5KSk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0XHRyZXR1cm4gcmVjb3JkPy52YWx1ZSA/PyBudWxsO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0S2V5VmFsdWUoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oS1ZfU1RPUkVfTkFNRSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0dHgub2JqZWN0U3RvcmUoS1ZfU1RPUkVfTkFNRSkucHV0KHsga2V5LCB2YWx1ZSB9KTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHR9LFxuXHRcdGFzeW5jIHNhdmVTZXNzaW9uKHNjb3BlOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oW05PVEVTX1NUT1JFX05BTUUsIFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0Y29uc3Qgbm90ZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgbWV0YVN0b3JlID0gdHgub2JqZWN0U3RvcmUoU0VTU0lPTl9NRVRBX1NUT1JFX05BTUUpO1xuXG5cdFx0XHRjb25zdCBzY29wZUluZGV4ID0gbm90ZXNTdG9yZS5pbmRleChOT1RFU19TQ09QRV9JTkRFWCk7XG5cdFx0XHRjb25zdCBleGlzdGluZ1JlY29yZHMgPSBhd2FpdCByZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmRbXT4oc2NvcGVJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seShzY29wZSkpKTtcblx0XHRcdGNvbnN0IG5leHRLZXlzID0gbmV3IFNldChzZXNzaW9uLnBhZ2VzLm1hcCgocGFnZSkgPT4gYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKSkpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IHJlY29yZCBvZiBleGlzdGluZ1JlY29yZHMpIHtcblx0XHRcdFx0aWYgKCFuZXh0S2V5cy5oYXMocmVjb3JkLmtleSkpIHtcblx0XHRcdFx0XHRub3Rlc1N0b3JlLmRlbGV0ZShyZWNvcmQua2V5KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IFtvcmRlciwgcGFnZV0gb2Ygc2Vzc2lvbi5wYWdlcy5lbnRyaWVzKCkpIHtcblx0XHRcdFx0Y29uc3Qga2V5ID0gYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKTtcblx0XHRcdFx0bm90ZXNTdG9yZS5wdXQoe1xuXHRcdFx0XHRcdGtleSxcblx0XHRcdFx0XHRzY29wZSxcblx0XHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0XHRvcmRlcixcblx0XHRcdFx0XHRwYWdlOiB7IC4uLnBhZ2UgfVxuXHRcdFx0XHR9IHNhdGlzZmllcyBOb3RlUmVjb3JkKTtcblx0XHRcdH1cblxuXHRcdFx0bWV0YVN0b3JlLnB1dCh7XG5cdFx0XHRcdHNjb3BlLFxuXHRcdFx0XHRhY3RpdmVQYWdlSWQ6IHNlc3Npb24uYWN0aXZlUGFnZUlkXG5cdFx0XHR9IHNhdGlzZmllcyBTZXNzaW9uTWV0YVJlY29yZCk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkU2Vzc2lvbihzY29wZTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFtOT1RFU19TVE9SRV9OQU1FLCBTRVNTSU9OX01FVEFfU1RPUkVfTkFNRV0sICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3Qgbm90ZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgbWV0YVN0b3JlID0gdHgub2JqZWN0U3RvcmUoU0VTU0lPTl9NRVRBX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3Qgc2NvcGVJbmRleCA9IG5vdGVzU3RvcmUuaW5kZXgoTk9URVNfU0NPUEVfSU5ERVgpO1xuXG5cdFx0XHRjb25zdCBbbm90ZVJlY29yZHMsIG1ldGFSZWNvcmRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0XHRyZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmRbXT4oc2NvcGVJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seShzY29wZSkpKSxcblx0XHRcdFx0cmVxdWVzdFRvUHJvbWlzZTxTZXNzaW9uTWV0YVJlY29yZCB8IHVuZGVmaW5lZD4obWV0YVN0b3JlLmdldChzY29wZSkpXG5cdFx0XHRdKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblxuXHRcdFx0aWYgKCFtZXRhUmVjb3JkICYmIG5vdGVSZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcGFnZXMgPSBub3RlUmVjb3Jkc1xuXHRcdFx0XHQuc29ydCgobGVmdCwgcmlnaHQpID0+IGxlZnQub3JkZXIgLSByaWdodC5vcmRlcilcblx0XHRcdFx0Lm1hcCgocmVjb3JkKSA9PiAoeyAuLi5yZWNvcmQucGFnZSB9KSk7XG5cdFx0XHRjb25zdCBhY3RpdmVQYWdlSWQgPSBtZXRhUmVjb3JkPy5hY3RpdmVQYWdlSWQgPz8gcGFnZXNbMF0/LmlkID8/IGNyZWF0ZVNlc3Npb24oKS5hY3RpdmVQYWdlSWQ7XG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplU2Vzc2lvbih7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkUGFnZShzY29wZTogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZykge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihOT1RFU19TVE9SRV9OQU1FLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8Tm90ZVJlY29yZCB8IHVuZGVmaW5lZD4oXG5cdFx0XHRcdHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpLmdldChidWlsZE5vdGVLZXkoc2NvcGUsIHBhZ2VJZCkpXG5cdFx0XHQpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdFx0cmV0dXJuIHJlY29yZCA/IHsgLi4ucmVjb3JkLnBhZ2UgfSA6IG51bGw7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBvcGVuRGF0YWJhc2UoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihEQl9OQU1FLCBEQl9WRVJTSU9OKTtcblxuXHRcdHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gKGV2ZW50KSA9PiB7XG5cdFx0XHRjb25zdCBkYiA9IHJlcXVlc3QucmVzdWx0O1xuXHRcdFx0Y29uc3QgdHggPSByZXF1ZXN0LnRyYW5zYWN0aW9uO1xuXHRcdFx0aWYgKCF0eCkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHByZXZpb3VzVmVyc2lvbiA9IGV2ZW50Lm9sZFZlcnNpb247XG5cdFx0XHRjb25zdCBrdlN0b3JlID0gZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhLVl9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ/IHR4Lm9iamVjdFN0b3JlKEtWX1NUT1JFX05BTUUpXG5cdFx0XHRcdDogZGIuY3JlYXRlT2JqZWN0U3RvcmUoS1ZfU1RPUkVfTkFNRSwgeyBrZXlQYXRoOiAna2V5JyB9KTtcblx0XHRcdGNvbnN0IG5vdGVzU3RvcmUgPSBkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKE5PVEVTX1NUT1JFX05BTUUpXG5cdFx0XHRcdD8gdHgub2JqZWN0U3RvcmUoTk9URVNfU1RPUkVfTkFNRSlcblx0XHRcdFx0OiBkYi5jcmVhdGVPYmplY3RTdG9yZShOT1RFU19TVE9SRV9OQU1FLCB7IGtleVBhdGg6ICdrZXknIH0pO1xuXHRcdFx0aWYgKCFub3Rlc1N0b3JlLmluZGV4TmFtZXMuY29udGFpbnMoTk9URVNfU0NPUEVfSU5ERVgpKSB7XG5cdFx0XHRcdG5vdGVzU3RvcmUuY3JlYXRlSW5kZXgoTk9URVNfU0NPUEVfSU5ERVgsICdzY29wZScsIHsgdW5pcXVlOiBmYWxzZSB9KTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHNlc3Npb25NZXRhU3RvcmUgPSBkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ/IHR4Lm9iamVjdFN0b3JlKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FKVxuXHRcdFx0XHQ6IGRiLmNyZWF0ZU9iamVjdFN0b3JlKFNFU1NJT05fTUVUQV9TVE9SRV9OQU1FLCB7IGtleVBhdGg6ICdzY29wZScgfSk7XG5cblx0XHRcdGlmIChwcmV2aW91c1ZlcnNpb24gPCAyKSB7XG5cdFx0XHRcdG1pZ3JhdGVJbmRleGVkRGJMZWdhY3lTZXNzaW9uRGF0YShrdlN0b3JlLCBub3Rlc1N0b3JlLCBzZXNzaW9uTWV0YVN0b3JlKTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBtaWdyYXRlSW5kZXhlZERiTGVnYWN5U2Vzc2lvbkRhdGEoXG5cdGt2U3RvcmU6IElEQk9iamVjdFN0b3JlLFxuXHRub3Rlc1N0b3JlOiBJREJPYmplY3RTdG9yZSxcblx0c2Vzc2lvbk1ldGFTdG9yZTogSURCT2JqZWN0U3RvcmVcbikge1xuXHRrdlN0b3JlLm9wZW5DdXJzb3IoKS5vbnN1Y2Nlc3MgPSAoZXZlbnQpID0+IHtcblx0XHRjb25zdCBjdXJzb3IgPSAoZXZlbnQudGFyZ2V0IGFzIElEQlJlcXVlc3Q8SURCQ3Vyc29yV2l0aFZhbHVlIHwgbnVsbD4pLnJlc3VsdDtcblx0XHRpZiAoIWN1cnNvcikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHJlY29yZCA9IGN1cnNvci52YWx1ZSBhcyB7IGtleT86IHVua25vd247IHZhbHVlPzogdW5rbm93biB9O1xuXHRcdGNvbnN0IGtleSA9IHR5cGVvZiByZWNvcmQ/LmtleSA9PT0gJ3N0cmluZycgPyByZWNvcmQua2V5IDogbnVsbDtcblx0XHRjb25zdCB2YWx1ZSA9IHR5cGVvZiByZWNvcmQ/LnZhbHVlID09PSAnc3RyaW5nJyA/IHJlY29yZC52YWx1ZSA6IG51bGw7XG5cdFx0aWYgKCFrZXkgfHwgIXZhbHVlKSB7XG5cdFx0XHRjdXJzb3IuY29udGludWUoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBzY29wZSA9IGdldFNjb3BlRnJvbVN0YXRlS2V5KGtleSk7XG5cdFx0aWYgKCFzY29wZSkge1xuXHRcdFx0Y3Vyc29yLmNvbnRpbnVlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IG5vcm1hbGl6ZVNlc3Npb24oSlNPTi5wYXJzZSh2YWx1ZSkpO1xuXHRcdGlmICghc2Vzc2lvbikge1xuXHRcdFx0Y3Vyc29yLmNvbnRpbnVlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCBbb3JkZXIsIHBhZ2VdIG9mIHNlc3Npb24ucGFnZXMuZW50cmllcygpKSB7XG5cdFx0XHRub3Rlc1N0b3JlLnB1dCh7XG5cdFx0XHRcdGtleTogYnVpbGROb3RlS2V5KHNjb3BlLCBwYWdlLmlkKSxcblx0XHRcdFx0c2NvcGUsXG5cdFx0XHRcdGlkOiBwYWdlLmlkLFxuXHRcdFx0XHRvcmRlcixcblx0XHRcdFx0cGFnZTogeyAuLi5wYWdlIH1cblx0XHRcdH0gc2F0aXNmaWVzIE5vdGVSZWNvcmQpO1xuXHRcdH1cblxuXHRcdHNlc3Npb25NZXRhU3RvcmUucHV0KHtcblx0XHRcdHNjb3BlLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLmFjdGl2ZVBhZ2VJZFxuXHRcdH0gc2F0aXNmaWVzIFNlc3Npb25NZXRhUmVjb3JkKTtcblx0XHRrdlN0b3JlLmRlbGV0ZShrZXkpO1xuXHRcdGN1cnNvci5jb250aW51ZSgpO1xuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5TG9jYWxTdG9yYWdlU3RhdGUoYmFja2VuZDogU3RvcmFnZUJhY2tlbmQpIHtcblx0aWYgKHR5cGVvZiBsb2NhbFN0b3JhZ2UgPT09ICd1bmRlZmluZWQnKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3Qga2V5czogc3RyaW5nW10gPSBbXTtcblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGxvY2FsU3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcblx0XHRjb25zdCBrZXkgPSBsb2NhbFN0b3JhZ2Uua2V5KGluZGV4KTtcblx0XHRpZiAoa2V5KSB7XG5cdFx0XHRrZXlzLnB1c2goa2V5KTtcblx0XHR9XG5cdH1cblxuXHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG5cdFx0Y29uc3QgdmFsdWUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuXHRcdGlmICh2YWx1ZSA9PT0gbnVsbCkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2NvcGUgPSBnZXRTY29wZUZyb21TdGF0ZUtleShrZXkpO1xuXHRcdGlmIChzY29wZSkge1xuXHRcdFx0Y29uc3Qgc2Vzc2lvbiA9IG5vcm1hbGl6ZVNlc3Npb24oSlNPTi5wYXJzZSh2YWx1ZSkpO1xuXHRcdFx0aWYgKHNlc3Npb24pIHtcblx0XHRcdFx0YXdhaXQgYmFja2VuZC5zYXZlU2Vzc2lvbihzY29wZSwgc2Vzc2lvbik7XG5cdFx0XHR9XG5cdFx0XHRsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKGtleSA9PT0gJ2V6LWJsYW5rLXNlc3Npb24tdjInKSB7XG5cdFx0XHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbihKU09OLnBhcnNlKHZhbHVlKSk7XG5cdFx0XHRpZiAoc2Vzc2lvbikge1xuXHRcdFx0XHRhd2FpdCBiYWNrZW5kLnNhdmVTZXNzaW9uKEFOT05ZTU9VU19TQ09QRSwgc2Vzc2lvbik7XG5cdFx0XHR9XG5cdFx0XHRsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKGtleSA9PT0gRWRpdG9yU3RvcmFnZS5QUk9NUFRFRF9VU0VSX0lEU19LRVkpIHtcblx0XHRcdGF3YWl0IGJhY2tlbmQuc2V0S2V5VmFsdWUoa2V5LCB2YWx1ZSk7XG5cdFx0XHRsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBnZXRTY29wZUZyb21TdGF0ZUtleShrZXk6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuXHRpZiAoa2V5ID09PSBFZGl0b3JTdG9yYWdlLkFOT05ZTU9VU19TVEFURV9LRVkpIHtcblx0XHRyZXR1cm4gQU5PTllNT1VTX1NDT1BFO1xuXHR9XG5cblx0aWYgKGtleS5zdGFydHNXaXRoKEVkaXRvclN0b3JhZ2UuVVNFUl9TVEFURV9LRVlfUFJFRklYKSkge1xuXHRcdHJldHVybiBgJHtVU0VSX1NDT1BFX1BSRUZJWH0ke2tleS5zbGljZShFZGl0b3JTdG9yYWdlLlVTRVJfU1RBVEVfS0VZX1BSRUZJWC5sZW5ndGgpfWA7XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gYnVpbGRVc2VyU2NvcGUodXNlcklkOiBzdHJpbmcpIHtcblx0cmV0dXJuIGAke1VTRVJfU0NPUEVfUFJFRklYfSR7dXNlcklkfWA7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTm90ZUtleShzY29wZTogc3RyaW5nLCBpZDogc3RyaW5nKSB7XG5cdHJldHVybiBgJHtzY29wZX06JHtpZH1gO1xufVxuXG5mdW5jdGlvbiBjbG9uZVNlc3Npb24oc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IEVkaXRvclNlc3Npb24ge1xuXHRyZXR1cm4ge1xuXHRcdGFjdGl2ZVBhZ2VJZDogc2Vzc2lvbi5hY3RpdmVQYWdlSWQsXG5cdFx0cGFnZXM6IHNlc3Npb24ucGFnZXMubWFwKChwYWdlKSA9PiAoeyAuLi5wYWdlIH0pKVxuXHR9O1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9Qcm9taXNlPFQ+KHJlcXVlc3Q6IElEQlJlcXVlc3Q8VD4pOiBQcm9taXNlPFQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRyZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuXHRcdHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIHRyYW5zYWN0aW9uVG9Qcm9taXNlKHRyYW5zYWN0aW9uOiBJREJUcmFuc2FjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiByZXNvbHZlKCk7XG5cdFx0dHJhbnNhY3Rpb24ub25lcnJvciA9ICgpID0+IHJlamVjdCh0cmFuc2FjdGlvbi5lcnJvcik7XG5cdFx0dHJhbnNhY3Rpb24ub25hYm9ydCA9ICgpID0+IHJlamVjdCh0cmFuc2FjdGlvbi5lcnJvciA/PyBuZXcgRXJyb3IoJ0luZGV4ZWREQiB0cmFuc2FjdGlvbiBhYm9ydGVkJykpO1xuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUNlWixJQUFNLGdCQUFnQjtBQUV0QixTQUFTLGdCQUFnQixTQUF5QjtBQUN4RCxRQUFNLFlBQVksUUFDaEIsTUFBTSxJQUFJLEVBQ1YsSUFBSSxDQUFDLFNBQVMsS0FBSyxLQUFLLENBQUMsRUFDekIsS0FBSyxDQUFDLFNBQVMsS0FBSyxTQUFTLENBQUM7QUFFaEMsTUFBSSxDQUFDLFdBQVc7QUFDZixXQUFPO0FBQUEsRUFDUjtBQUVBLFNBQU8sVUFBVSxRQUFRLFFBQVEsR0FBRyxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQ2xEO0FBRU8sU0FBUyxXQUFXLFVBQVUsSUFBSSxLQUFLLGFBQWEsR0FBZTtBQUN6RSxRQUFNLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFDekMsU0FBTztBQUFBLElBQ047QUFBQSxJQUNBLE9BQU8s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QVVBLGVBQWMsUUFBUTtBQUN0QyxRQUFNLGNBQWMsY0FBYyxVQUFVLE9BQU87QUFFbkQsUUFBTSxPQUFPLE1BQU0sY0FBYyxhQUFhLFVBQVUsUUFBUTtBQUNoRSxTQUFPLE1BQU0sTUFBTSxJQUFJLFFBQVE7QUFDL0IsU0FBTyxNQUFNLE1BQU0sU0FBUyxNQUFNO0FBQ25DLENBQUM7QUFFRCxLQUFLLDhFQUE4RSxZQUFZO0FBQzlGLGVBQWE7QUFBQSxJQUNaLGNBQWM7QUFBQSxJQUNkLEtBQUssVUFBVTtBQUFBLE1BQ2QsT0FBT0EsZUFBYyxRQUFRLEVBQUU7QUFBQSxNQUMvQixjQUFjO0FBQUEsSUFDZixDQUFDO0FBQUEsRUFDRjtBQUVBLFFBQU0sVUFBVSxNQUFNLGNBQWMsbUJBQW1CO0FBRXZELFNBQU8sTUFBTSxRQUFRLGNBQWMsUUFBUTtBQUMzQyxTQUFPLE1BQU0sYUFBYSxRQUFRLGNBQWMsbUJBQW1CLEdBQUcsSUFBSTtBQUMzRSxDQUFDO0FBRUQsS0FBSyxzRUFBc0UsWUFBWTtBQUN0RixRQUFNLFVBQVVBLGVBQWMsUUFBUTtBQUN0QyxRQUFNLGNBQWMsbUJBQW1CLE9BQU87QUFDOUMsUUFBTSxjQUFjLG1CQUFtQjtBQUFBLElBQ3RDLGNBQWM7QUFBQSxJQUNkLE9BQU8sQ0FBQyxRQUFRLE1BQU0sQ0FBQyxDQUFFO0FBQUEsRUFDMUIsQ0FBQztBQUVELFFBQU0sY0FBYyxNQUFNLGNBQWMsa0JBQWtCLFFBQVE7QUFDbEUsU0FBTyxNQUFNLGFBQWEsSUFBSTtBQUMvQixDQUFDO0FBRUQsS0FBSyw2REFBNkQsWUFBWTtBQUM3RSxTQUFPLE1BQU0sTUFBTSxjQUFjLGtCQUFrQixRQUFRLEdBQUcsS0FBSztBQUVuRSxRQUFNLGNBQWMsbUJBQW1CLFFBQVE7QUFDL0MsUUFBTSxjQUFjLG1CQUFtQixRQUFRO0FBRS9DLFNBQU8sTUFBTSxNQUFNLGNBQWMsa0JBQWtCLFFBQVEsR0FBRyxJQUFJO0FBQ2xFLFNBQU8sVUFBVSxNQUFNLGNBQWMsb0JBQW9CLEdBQUcsQ0FBQyxRQUFRLENBQUM7QUFDdkUsQ0FBQztBQUVELEtBQUssNkRBQTZELFlBQVk7QUFDN0UsZUFBYSxRQUFRLGNBQWMsdUJBQXVCLEtBQUssVUFBVSxDQUFDLFVBQVUsSUFBSSxJQUFJLENBQUMsQ0FBQztBQUU5RixTQUFPLFVBQVUsTUFBTSxjQUFjLG9CQUFvQixHQUFHLENBQUMsUUFBUSxDQUFDO0FBQ3RFLFNBQU8sTUFBTSxNQUFNLGNBQWMsa0JBQWtCLFFBQVEsR0FBRyxJQUFJO0FBQ2xFLFNBQU8sTUFBTSxNQUFNLGNBQWMsa0JBQWtCLFFBQVEsR0FBRyxLQUFLO0FBQ3BFLENBQUM7IiwKICAibmFtZXMiOiBbImNyZWF0ZVNlc3Npb24iXQp9Cg==
