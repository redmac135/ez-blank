// tests/storage.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/editor/core/preferences.ts
var DEFAULT_PREFERENCES = {
  themeMode: "light",
  spellcheckEnabled: true,
  countVisibility: "auto"
};
var COUNT_VISIBILITY_ORDER = ["pinned", "auto", "hidden"];
function normalizePreferences(value) {
  if (!value || typeof value !== "object") {
    return DEFAULT_PREFERENCES;
  }
  const candidate = value;
  return {
    themeMode: candidate.themeMode === "dark" ? "dark" : "light",
    spellcheckEnabled: typeof candidate.spellcheckEnabled === "boolean" ? candidate.spellcheckEnabled : DEFAULT_PREFERENCES.spellcheckEnabled,
    countVisibility: COUNT_VISIBILITY_ORDER.includes(candidate.countVisibility) ? candidate.countVisibility : DEFAULT_PREFERENCES.countVisibility
  };
}

// src/lib/editor/persistence/records.ts
var BLANK_DB_NAME = "blank";
var BLANK_DB_VERSION = 1;
var PAGES_STORE_NAME = "pages";
var SETTINGS_STORE_NAME = "settings";
var USER_ID_INDEX = "userId";
var ANONYMOUS_USERID = "anonymous";
var SETTING_ACTIVE_PAGE_ID = "activePageId";
var SETTING_THEME = "theme";
var SETTING_WORD_COUNT_VISIBILITY = "wordCountVisibility";
var SETTING_SPELLCHECK_ENABLED = "spellcheckEnabled";
var SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT = "hasPromptedForAnonymousImport";

// src/lib/editor/core/session.ts
var UNTITLED_PAGE = "Untitled";
function derivePageTitle(content) {
  const firstLine = content.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) {
    return UNTITLED_PAGE;
  }
  return firstLine.replace(/\s+/g, " ").slice(0, 48);
}
function createPage(content = "", options = {}) {
  const timestamp = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: options.id ?? createPageId(),
    userId: options.userId ?? ANONYMOUS_USERID,
    title: derivePageTitle(content),
    content,
    text: content,
    selectionStart: 0,
    selectionEnd: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    lastSyncedAt: null,
    lastKnownRemoteUpdatedAt: null,
    lastKnownRemoteDeletedAt: null,
    syncStatus: "dirty",
    isEphemeral: options.isEphemeral ?? true
  };
}
function createSession(userId = ANONYMOUS_USERID) {
  const page = createPage("", { userId, isEphemeral: true });
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
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    syncStatus: nextDirtyStatus(page.syncStatus),
    isEphemeral: false
  };
}
function normalizeSession(value, userId = ANONYMOUS_USERID) {
  if (!isRecord(value)) return null;
  if (isLegacyEditorState(value)) {
    return migrateLegacyState(value, userId);
  }
  if (!Array.isArray(value.pages)) {
    return null;
  }
  const pages = value.pages.map((page, index) => normalizePage(page, index, userId)).filter((page) => page !== null).sort(comparePages);
  if (pages.length === 0) {
    return createSession(userId);
  }
  const activePageId = typeof value.activePageId === "string" && pages.some((page) => page.id === value.activePageId && page.deletedAt === null) ? value.activePageId : pages.find((page) => page.deletedAt === null)?.id ?? pages[0].id;
  return ensureValidActivePage({ pages, activePageId });
}
function migrateLegacyState(state, userId = ANONYMOUS_USERID) {
  const page = updatePageState(createPage("", { userId, isEphemeral: true }), state);
  return {
    pages: [page],
    activePageId: page.id
  };
}
function normalizePage(value, index, userId) {
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
  const createdAt = readTimestamp(value.createdAt, value.created_at);
  const updatedAt = readTimestamp(value.updatedAt, value.updated_at) ?? createdAt;
  const deletedAt = readNullableTimestamp(value.deletedAt, value.deleted_at);
  return {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : createFallbackPageId(index),
    userId: typeof value.userId === "string" && value.userId.length > 0 ? value.userId : userId,
    title: typeof value.title === "string" && value.title.trim().length > 0 ? value.title.trim() : derivePageTitle(normalizedContent),
    content: normalizedContent,
    text: normalizedContent,
    selectionStart,
    selectionEnd,
    createdAt,
    updatedAt,
    deletedAt,
    lastSyncedAt: readNullableTimestamp(value.lastSyncedAt),
    lastKnownRemoteUpdatedAt: readNullableTimestamp(value.lastKnownRemoteUpdatedAt),
    lastKnownRemoteDeletedAt: readNullableTimestamp(value.lastKnownRemoteDeletedAt),
    syncStatus: normalizeSyncStatus(value.syncStatus),
    isEphemeral: typeof value.isEphemeral === "boolean" ? value.isEphemeral : false
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `page-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
function createFallbackPageId(index) {
  return `page-${index + 1}`;
}
function readTimestamp(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return (/* @__PURE__ */ new Date()).toISOString();
}
function readNullableTimestamp(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}
function normalizeSyncStatus(value) {
  return value === "synced" || value === "pending_push" || value === "conflict" ? value : "dirty";
}
function nextDirtyStatus(status) {
  return status === "conflict" ? "conflict" : "dirty";
}
function comparePages(left, right) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.id.localeCompare(right.id);
}

// src/lib/editor/persistence/storage.ts
var EditorStorage = class {
  static backendPromise = null;
  static memoryBackend = createMemoryBackend();
  static async saveAnonymousState(session) {
    await this.saveUserState(ANONYMOUS_USERID, session);
  }
  static async loadAnonymousState() {
    return await this.loadUserState(ANONYMOUS_USERID) ?? createSession(ANONYMOUS_USERID);
  }
  static async saveUserState(userId, session) {
    const backend = await this.getBackend();
    await backend.saveSession(userId, session);
  }
  static async loadUserState(userId) {
    try {
      const backend = await this.getBackend();
      return await backend.loadSession(userId);
    } catch (error) {
      console.error("Failed to load user editor session:", error);
      return null;
    }
  }
  static async loadAnonymousPage(pageId) {
    return this.loadUserPage(ANONYMOUS_USERID, pageId);
  }
  static async loadUserPage(userId, pageId) {
    const backend = await this.getBackend();
    return backend.loadPage(userId, pageId);
  }
  static async loadPreferences(userId = ANONYMOUS_USERID) {
    try {
      const backend = await this.getBackend();
      const [themeMode, countVisibility, spellcheckEnabled] = await Promise.all([
        backend.getSetting(userId, SETTING_THEME),
        backend.getSetting(userId, SETTING_WORD_COUNT_VISIBILITY),
        backend.getSetting(userId, SETTING_SPELLCHECK_ENABLED)
      ]);
      return normalizePreferences({
        themeMode,
        countVisibility,
        spellcheckEnabled
      });
    } catch (error) {
      console.error("Failed to load editor preferences:", error);
      return DEFAULT_PREFERENCES;
    }
  }
  static async savePreferences(userId, preferences) {
    try {
      const backend = await this.getBackend();
      await Promise.all([
        backend.setSetting(userId, SETTING_THEME, preferences.themeMode),
        backend.setSetting(userId, SETTING_WORD_COUNT_VISIBILITY, preferences.countVisibility),
        backend.setSetting(userId, SETTING_SPELLCHECK_ENABLED, preferences.spellcheckEnabled)
      ]);
    } catch (error) {
      console.error("Failed to save editor preferences:", error);
    }
  }
  static async hasPromptedForAnonymousImport(userId) {
    try {
      const backend = await this.getBackend();
      return await backend.getSetting(userId, SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT) === true;
    } catch (error) {
      console.error("Failed to load anonymous import prompt status:", error);
      return false;
    }
  }
  static async markPromptedForAnonymousImport(userId) {
    try {
      const backend = await this.getBackend();
      await backend.setSetting(userId, SETTING_HAS_PROMPTED_FOR_ANONYMOUS_IMPORT, true);
    } catch (error) {
      console.error("Failed to save anonymous import prompt status:", error);
    }
  }
  static resetForTests() {
    this.backendPromise = null;
    this.memoryBackend = createMemoryBackend();
  }
  static async getBackend() {
    if (!this.backendPromise) {
      this.backendPromise = typeof indexedDB === "undefined" ? Promise.resolve(this.memoryBackend) : createIndexedDbBackend();
    }
    return this.backendPromise;
  }
};
function createMemoryBackend() {
  const pages = /* @__PURE__ */ new Map();
  const settings = /* @__PURE__ */ new Map();
  return {
    async saveSession(userId, session) {
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
    async loadSession(userId) {
      const userPages = [...pages.values()].filter((page) => page.userId === userId).sort(comparePages2).map((page) => toEditorPage(page));
      if (userPages.length === 0) {
        return null;
      }
      const activePageId = settings.get(buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID))?.value;
      return normalizeSession(
        { pages: userPages, activePageId: typeof activePageId === "string" ? activePageId : userPages[0].id },
        userId
      );
    },
    async loadPage(userId, pageId) {
      const page = pages.get(buildCompositeKey(userId, pageId));
      return page ? toEditorPage(page) : null;
    },
    async getSetting(userId, key) {
      return settings.get(buildCompositeKey(userId, key))?.value;
    },
    async setSetting(userId, key, value) {
      settings.set(buildCompositeKey(userId, key), createSettingRecord(userId, key, value));
    }
  };
}
async function createIndexedDbBackend() {
  const db = await openDatabase();
  return {
    async saveSession(userId, session) {
      const tx = db.transaction([PAGES_STORE_NAME, SETTINGS_STORE_NAME], "readwrite");
      const pagesStore = tx.objectStore(PAGES_STORE_NAME);
      const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
      const userIndex = pagesStore.index(USER_ID_INDEX);
      const existing = await requestToPromise(userIndex.getAll(IDBKeyRange.only(userId)));
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
    async loadSession(userId) {
      const tx = db.transaction([PAGES_STORE_NAME, SETTINGS_STORE_NAME], "readonly");
      const pagesStore = tx.objectStore(PAGES_STORE_NAME);
      const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
      const userIndex = pagesStore.index(USER_ID_INDEX);
      const [pages, activePageSetting] = await Promise.all([
        requestToPromise(userIndex.getAll(IDBKeyRange.only(userId))),
        requestToPromise(settingsStore.get([userId, SETTING_ACTIVE_PAGE_ID]))
      ]);
      await transactionToPromise(tx);
      if (pages.length === 0) {
        return null;
      }
      return normalizeSession(
        {
          pages: pages.sort(comparePages2).map((page) => toEditorPage(page)),
          activePageId: typeof activePageSetting?.value === "string" ? activePageSetting.value : pages[0].id
        },
        userId
      );
    },
    async loadPage(userId, pageId) {
      const tx = db.transaction(PAGES_STORE_NAME, "readonly");
      const page = await requestToPromise(
        tx.objectStore(PAGES_STORE_NAME).get([userId, pageId])
      );
      await transactionToPromise(tx);
      return page ? toEditorPage(page) : null;
    },
    async getSetting(userId, key) {
      const tx = db.transaction(SETTINGS_STORE_NAME, "readonly");
      const setting = await requestToPromise(
        tx.objectStore(SETTINGS_STORE_NAME).get([userId, key])
      );
      await transactionToPromise(tx);
      return setting?.value;
    },
    async setSetting(userId, key, value) {
      const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
      tx.objectStore(SETTINGS_STORE_NAME).put(createSettingRecord(userId, key, value));
      await transactionToPromise(tx);
    }
  };
}
async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BLANK_DB_NAME, BLANK_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAGES_STORE_NAME)) {
        const pagesStore = db.createObjectStore(PAGES_STORE_NAME, {
          keyPath: ["userId", "id"]
        });
        pagesStore.createIndex(USER_ID_INDEX, "userId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        const settingsStore = db.createObjectStore(SETTINGS_STORE_NAME, {
          keyPath: ["userId", "key"]
        });
        settingsStore.createIndex(USER_ID_INDEX, "userId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function buildCompositeKey(left, right) {
  return `${left}::${right}`;
}
function toPageRecord(page, userId) {
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
    syncStatus: page.syncStatus,
    isEphemeral: page.isEphemeral
  };
}
function toEditorPage(page) {
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
function createSettingRecord(userId, key, value) {
  return {
    userId,
    key,
    value,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function comparePages2(left, right) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.id.localeCompare(right.id);
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
function createSession2(userId, activePageId = "page-a") {
  const pageA = createPage("alpha", {
    id: "page-a",
    userId,
    now: "2026-04-14T00:00:00.000Z",
    isEphemeral: false
  });
  pageA.title = "A";
  pageA.updatedAt = "2026-04-14T00:00:00.000Z";
  const pageB = createPage("beta", {
    id: "page-b",
    userId,
    now: "2026-04-15T00:00:00.000Z",
    isEphemeral: false
  });
  pageB.title = "B";
  pageB.updatedAt = "2026-04-15T00:00:00.000Z";
  return {
    activePageId,
    pages: [pageA, pageB]
  };
}
test.beforeEach(() => {
  EditorStorage.resetForTests();
});
test("EditorStorage saves and loads anonymous state through the blank database shape", async () => {
  const session = createSession2(ANONYMOUS_USERID, "page-b");
  await EditorStorage.saveAnonymousState(session);
  const loaded = await EditorStorage.loadAnonymousState();
  assert.equal(loaded.activePageId, "page-b");
  assert.equal(loaded.pages.length, session.pages.length);
  assert.equal(loaded.pages[0]?.userId, ANONYMOUS_USERID);
  assert.equal(loaded.pages[0]?.isEphemeral, false);
});
test("EditorStorage saves and loads user-scoped state separately per account", async () => {
  await EditorStorage.saveUserState("user-a", createSession2("user-a", "page-a"));
  await EditorStorage.saveUserState("user-b", createSession2("user-b", "page-b"));
  assert.equal((await EditorStorage.loadUserState("user-a"))?.activePageId, "page-a");
  assert.equal((await EditorStorage.loadUserState("user-b"))?.activePageId, "page-b");
  assert.equal((await EditorStorage.loadUserState("user-a"))?.pages[0]?.userId, "user-a");
  assert.equal((await EditorStorage.loadUserState("user-b"))?.pages[0]?.userId, "user-b");
});
test("EditorStorage loads a single page without requiring full session consumers", async () => {
  const session = createSession2("user-a", "page-a");
  await EditorStorage.saveUserState("user-a", session);
  const page = await EditorStorage.loadUserPage("user-a", "page-b");
  assert.equal(page?.id, "page-b");
  assert.equal(page?.content, "beta");
  assert.equal(page?.userId, "user-a");
  assert.equal(page?.isEphemeral, false);
});
test("EditorStorage keeps page lookups in sync after hard removals are saved", async () => {
  const session = createSession2(ANONYMOUS_USERID, "page-a");
  await EditorStorage.saveAnonymousState(session);
  await EditorStorage.saveAnonymousState({
    activePageId: "page-a",
    pages: [session.pages[0]]
  });
  const deletedPage = await EditorStorage.loadAnonymousPage("page-b");
  assert.equal(deletedPage, null);
});
test("EditorStorage preserves ephemeral placeholders", async () => {
  const session = {
    activePageId: "page-a",
    pages: [createPage("", { id: "page-a", userId: ANONYMOUS_USERID, isEphemeral: true })]
  };
  await EditorStorage.saveAnonymousState(session);
  const loaded = await EditorStorage.loadAnonymousState();
  assert.equal(loaded.pages[0]?.isEphemeral, true);
});
test("EditorStorage returns default preferences when no settings are stored", async () => {
  assert.deepEqual(await EditorStorage.loadPreferences(ANONYMOUS_USERID), DEFAULT_PREFERENCES);
});
test("EditorStorage saves and loads preferences through settings records", async () => {
  await EditorStorage.savePreferences("user-a", {
    themeMode: "dark",
    spellcheckEnabled: false,
    countVisibility: "pinned"
  });
  assert.deepEqual(await EditorStorage.loadPreferences("user-a"), {
    themeMode: "dark",
    spellcheckEnabled: false,
    countVisibility: "pinned"
  });
});
test("EditorStorage tracks whether an account has been prompted to import anonymous data", async () => {
  assert.equal(await EditorStorage.hasPromptedForAnonymousImport("user-a"), false);
  await EditorStorage.markPromptedForAnonymousImport("user-a");
  await EditorStorage.markPromptedForAnonymousImport("user-a");
  assert.equal(await EditorStorage.hasPromptedForAnonymousImport("user-a"), true);
  assert.equal(await EditorStorage.hasPromptedForAnonymousImport("user-b"), false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3RvcmFnZS50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvcmUvcHJlZmVyZW5jZXMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IERFRkFVTFRfUFJFRkVSRU5DRVMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3ByZWZlcmVuY2VzLnRzJztcbmltcG9ydCB7IGNyZWF0ZVBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL2NvcmUvc2Vzc2lvbi50cyc7XG5pbXBvcnQgeyBFZGl0b3JTdG9yYWdlIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyc7XG5pbXBvcnQgeyBBTk9OWU1PVVNfVVNFUklEIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbmZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkOiBzdHJpbmcsIGFjdGl2ZVBhZ2VJZCA9ICdwYWdlLWEnKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2VBID0gY3JlYXRlUGFnZSgnYWxwaGEnLCB7XG5cdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdHVzZXJJZCxcblx0XHRub3c6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0cGFnZUEudGl0bGUgPSAnQSc7XG5cdHBhZ2VBLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXG5cdGNvbnN0IHBhZ2VCID0gY3JlYXRlUGFnZSgnYmV0YScsIHtcblx0XHRpZDogJ3BhZ2UtYicsXG5cdFx0dXNlcklkLFxuXHRcdG5vdzogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRwYWdlQi50aXRsZSA9ICdCJztcblx0cGFnZUIudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWic7XG5cblx0cmV0dXJuIHtcblx0XHRhY3RpdmVQYWdlSWQsXG5cdFx0cGFnZXM6IFtwYWdlQSwgcGFnZUJdXG5cdH07XG59XG5cbnRlc3QuYmVmb3JlRWFjaCgoKSA9PiB7XG5cdEVkaXRvclN0b3JhZ2UucmVzZXRGb3JUZXN0cygpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIGFub255bW91cyBzdGF0ZSB0aHJvdWdoIHRoZSBibGFuayBkYXRhYmFzZSBzaGFwZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oQU5PTllNT1VTX1VTRVJJRCwgJ3BhZ2UtYicpO1xuXG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb24pO1xuXG5cdGNvbnN0IGxvYWRlZCA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQuYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXMubGVuZ3RoLCBzZXNzaW9uLnBhZ2VzLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LnVzZXJJZCwgQU5PTllNT1VTX1VTRVJJRCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBzYXZlcyBhbmQgbG9hZHMgdXNlci1zY29wZWQgc3RhdGUgc2VwYXJhdGVseSBwZXIgYWNjb3VudCcsIGFzeW5jICgpID0+IHtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnLCAncGFnZS1hJykpO1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVVc2VyU3RhdGUoJ3VzZXItYicsIGNyZWF0ZVNlc3Npb24oJ3VzZXItYicsICdwYWdlLWInKSk7XG5cblx0YXNzZXJ0LmVxdWFsKChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYScpKT8uYWN0aXZlUGFnZUlkLCAncGFnZS1hJyk7XG5cdGFzc2VydC5lcXVhbCgoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN0YXRlKCd1c2VyLWInKSk/LmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1hJykpPy5wYWdlc1swXT8udXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbCgoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN0YXRlKCd1c2VyLWInKSk/LnBhZ2VzWzBdPy51c2VySWQsICd1c2VyLWInKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGxvYWRzIGEgc2luZ2xlIHBhZ2Ugd2l0aG91dCByZXF1aXJpbmcgZnVsbCBzZXNzaW9uIGNvbnN1bWVycycsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScsICdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBzZXNzaW9uKTtcblxuXHRjb25zdCBwYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclBhZ2UoJ3VzZXItYScsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2U/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5jb250ZW50LCAnYmV0YScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZT8udXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Uga2VlcHMgcGFnZSBsb29rdXBzIGluIHN5bmMgYWZ0ZXIgaGFyZCByZW1vdmFscyBhcmUgc2F2ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKEFOT05ZTU9VU19VU0VSSUQsICdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbik7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbc2Vzc2lvbi5wYWdlc1swXSFdXG5cdH0pO1xuXG5cdGNvbnN0IGRlbGV0ZWRQYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkQW5vbnltb3VzUGFnZSgncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChkZWxldGVkUGFnZSwgbnVsbCk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBwcmVzZXJ2ZXMgZXBoZW1lcmFsIHBsYWNlaG9sZGVycycsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbiA9IHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbY3JlYXRlUGFnZSgnJywgeyBpZDogJ3BhZ2UtYScsIHVzZXJJZDogQU5PTllNT1VTX1VTRVJJRCwgaXNFcGhlbWVyYWw6IHRydWUgfSldXG5cdH07XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb24pO1xuXG5cdGNvbnN0IGxvYWRlZCA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHJldHVybnMgZGVmYXVsdCBwcmVmZXJlbmNlcyB3aGVuIG5vIHNldHRpbmdzIGFyZSBzdG9yZWQnLCBhc3luYyAoKSA9PiB7XG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkUHJlZmVyZW5jZXMoQU5PTllNT1VTX1VTRVJJRCksIERFRkFVTFRfUFJFRkVSRU5DRVMpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIHByZWZlcmVuY2VzIHRocm91Z2ggc2V0dGluZ3MgcmVjb3JkcycsIGFzeW5jICgpID0+IHtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlUHJlZmVyZW5jZXMoJ3VzZXItYScsIHtcblx0XHR0aGVtZU1vZGU6ICdkYXJrJyxcblx0XHRzcGVsbGNoZWNrRW5hYmxlZDogZmFsc2UsXG5cdFx0Y291bnRWaXNpYmlsaXR5OiAncGlubmVkJ1xuXHR9KTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFByZWZlcmVuY2VzKCd1c2VyLWEnKSwge1xuXHRcdHRoZW1lTW9kZTogJ2RhcmsnLFxuXHRcdHNwZWxsY2hlY2tFbmFibGVkOiBmYWxzZSxcblx0XHRjb3VudFZpc2liaWxpdHk6ICdwaW5uZWQnXG5cdH0pO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2UgdHJhY2tzIHdoZXRoZXIgYW4gYWNjb3VudCBoYXMgYmVlbiBwcm9tcHRlZCB0byBpbXBvcnQgYW5vbnltb3VzIGRhdGEnLCBhc3luYyAoKSA9PiB7XG5cdGFzc2VydC5lcXVhbChhd2FpdCBFZGl0b3JTdG9yYWdlLmhhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KCd1c2VyLWEnKSwgZmFsc2UpO1xuXG5cdGF3YWl0IEVkaXRvclN0b3JhZ2UubWFya1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KCd1c2VyLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5tYXJrUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQoJ3VzZXItYScpO1xuXG5cdGFzc2VydC5lcXVhbChhd2FpdCBFZGl0b3JTdG9yYWdlLmhhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KCd1c2VyLWEnKSwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChhd2FpdCBFZGl0b3JTdG9yYWdlLmhhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KCd1c2VyLWInKSwgZmFsc2UpO1xufSk7XG4iLCAiZXhwb3J0IHR5cGUgVGhlbWVNb2RlID0gJ2xpZ2h0JyB8ICdkYXJrJztcbmV4cG9ydCB0eXBlIENvdW50VmlzaWJpbGl0eSA9ICdwaW5uZWQnIHwgJ2F1dG8nIHwgJ2hpZGRlbic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUHJlZmVyZW5jZXMge1xuXHR0aGVtZU1vZGU6IFRoZW1lTW9kZTtcblx0c3BlbGxjaGVja0VuYWJsZWQ6IGJvb2xlYW47XG5cdGNvdW50VmlzaWJpbGl0eTogQ291bnRWaXNpYmlsaXR5O1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9QUkVGRVJFTkNFUzogRWRpdG9yUHJlZmVyZW5jZXMgPSB7XG5cdHRoZW1lTW9kZTogJ2xpZ2h0Jyxcblx0c3BlbGxjaGVja0VuYWJsZWQ6IHRydWUsXG5cdGNvdW50VmlzaWJpbGl0eTogJ2F1dG8nXG59O1xuXG5jb25zdCBDT1VOVF9WSVNJQklMSVRZX09SREVSOiBDb3VudFZpc2liaWxpdHlbXSA9IFsncGlubmVkJywgJ2F1dG8nLCAnaGlkZGVuJ107XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVQcmVmZXJlbmNlcyh2YWx1ZTogdW5rbm93bik6IEVkaXRvclByZWZlcmVuY2VzIHtcblx0aWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG5cdFx0cmV0dXJuIERFRkFVTFRfUFJFRkVSRU5DRVM7XG5cdH1cblxuXHRjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPEVkaXRvclByZWZlcmVuY2VzPjtcblxuXHRyZXR1cm4ge1xuXHRcdHRoZW1lTW9kZTogY2FuZGlkYXRlLnRoZW1lTW9kZSA9PT0gJ2RhcmsnID8gJ2RhcmsnIDogJ2xpZ2h0Jyxcblx0XHRzcGVsbGNoZWNrRW5hYmxlZDpcblx0XHRcdHR5cGVvZiBjYW5kaWRhdGUuc3BlbGxjaGVja0VuYWJsZWQgPT09ICdib29sZWFuJ1xuXHRcdFx0XHQ/IGNhbmRpZGF0ZS5zcGVsbGNoZWNrRW5hYmxlZFxuXHRcdFx0XHQ6IERFRkFVTFRfUFJFRkVSRU5DRVMuc3BlbGxjaGVja0VuYWJsZWQsXG5cdFx0Y291bnRWaXNpYmlsaXR5OiBDT1VOVF9WSVNJQklMSVRZX09SREVSLmluY2x1ZGVzKGNhbmRpZGF0ZS5jb3VudFZpc2liaWxpdHkgYXMgQ291bnRWaXNpYmlsaXR5KVxuXHRcdFx0PyAoY2FuZGlkYXRlLmNvdW50VmlzaWJpbGl0eSBhcyBDb3VudFZpc2liaWxpdHkpXG5cdFx0XHQ6IERFRkFVTFRfUFJFRkVSRU5DRVMuY291bnRWaXNpYmlsaXR5XG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjeWNsZUNvdW50VmlzaWJpbGl0eSh2YWx1ZTogQ291bnRWaXNpYmlsaXR5KTogQ291bnRWaXNpYmlsaXR5IHtcblx0Y29uc3QgY3VycmVudEluZGV4ID0gQ09VTlRfVklTSUJJTElUWV9PUkRFUi5pbmRleE9mKHZhbHVlKTtcblx0cmV0dXJuIENPVU5UX1ZJU0lCSUxJVFlfT1JERVJbKGN1cnJlbnRJbmRleCArIDEpICUgQ09VTlRfVklTSUJJTElUWV9PUkRFUi5sZW5ndGhdITtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldENvdW50VmlzaWJpbGl0eUxhYmVsKHZhbHVlOiBDb3VudFZpc2liaWxpdHkpOiBzdHJpbmcge1xuXHRzd2l0Y2ggKHZhbHVlKSB7XG5cdFx0Y2FzZSAncGlubmVkJzpcblx0XHRcdHJldHVybiAnQ291bnQgcGlubmVkJztcblx0XHRjYXNlICdoaWRkZW4nOlxuXHRcdFx0cmV0dXJuICdDb3VudCBoaWRkZW4nO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gJ0NvdW50IHNob3duJztcblx0fVxufVxuIiwgImV4cG9ydCBjb25zdCBCTEFOS19EQl9OQU1FID0gJ2JsYW5rJztcbmV4cG9ydCBjb25zdCBCTEFOS19EQl9WRVJTSU9OID0gMTtcbmV4cG9ydCBjb25zdCBQQUdFU19TVE9SRV9OQU1FID0gJ3BhZ2VzJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HU19TVE9SRV9OQU1FID0gJ3NldHRpbmdzJztcbmV4cG9ydCBjb25zdCBVU0VSX0lEX0lOREVYID0gJ3VzZXJJZCc7XG5cbmV4cG9ydCBjb25zdCBBTk9OWU1PVVNfVVNFUklEID0gJ2Fub255bW91cyc7XG5cbmV4cG9ydCB0eXBlIFBhZ2VTeW5jU3RhdHVzID0gJ3N5bmNlZCcgfCAnZGlydHknIHwgJ3BlbmRpbmdfcHVzaCcgfCAnY29uZmxpY3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VSZWNvcmQge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkQXQ6IHN0cmluZztcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG5cdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0c3luY1N0YXR1czogUGFnZVN5bmNTdGF0dXM7XG5cdGlzRXBoZW1lcmFsOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmcgfCBudWxsO1xuXHR2YWx1ZTogdW5rbm93bjtcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEID0gJ2FjdGl2ZVBhZ2VJZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19USEVNRSA9ICd0aGVtZSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFkgPSAnd29yZENvdW50VmlzaWJpbGl0eSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQgPSAnc3BlbGxjaGVja0VuYWJsZWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JUID0gJ2hhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0JztcbiIsICJpbXBvcnQgdHlwZSB7IEVkaXRvclN0YXRlIH0gZnJvbSAnLi4vYmFzaWMvaGlzdG9yeSc7XG5pbXBvcnQge1xuXHRBTk9OWU1PVVNfVVNFUklELFxuXHR0eXBlIFBhZ2VSZWNvcmQsXG5cdHR5cGUgUGFnZVN5bmNTdGF0dXNcbn0gZnJvbSAnLi4vcGVyc2lzdGVuY2UvcmVjb3Jkcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlLCBQYWdlUmVjb3JkIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yU2Vzc2lvbiB7XG5cdHBhZ2VzOiBFZGl0b3JQYWdlW107XG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgVU5USVRMRURfUEFHRSA9ICdVbnRpdGxlZCc7XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVQYWdlVGl0bGUoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZmlyc3RMaW5lID0gY29udGVudFxuXHRcdC5zcGxpdCgnXFxuJylcblx0XHQubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcblx0XHQuZmluZCgobGluZSkgPT4gbGluZS5sZW5ndGggPiAwKTtcblxuXHRpZiAoIWZpcnN0TGluZSkge1xuXHRcdHJldHVybiBVTlRJVExFRF9QQUdFO1xuXHR9XG5cblx0cmV0dXJuIGZpcnN0TGluZS5yZXBsYWNlKC9cXHMrL2csICcgJykuc2xpY2UoMCwgNDgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUGFnZShcblx0Y29udGVudCA9ICcnLFxuXHRvcHRpb25zOiB7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0dXNlcklkPzogc3RyaW5nO1xuXHRcdG5vdz86IHN0cmluZztcblx0XHRpc0VwaGVtZXJhbD86IGJvb2xlYW47XG5cdH0gPSB7fVxuKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRpbWVzdGFtcCA9IG9wdGlvbnMubm93ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHRpZDogb3B0aW9ucy5pZCA/PyBjcmVhdGVQYWdlSWQoKSxcblx0XHR1c2VySWQ6IG9wdGlvbnMudXNlcklkID8/IEFOT05ZTU9VU19VU0VSSUQsXG5cdFx0dGl0bGU6IGRlcml2ZVBhZ2VUaXRsZShjb250ZW50KSxcblx0XHRjb250ZW50LFxuXHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0c2VsZWN0aW9uRW5kOiAwLFxuXHRcdGNyZWF0ZWRBdDogdGltZXN0YW1wLFxuXHRcdHVwZGF0ZWRBdDogdGltZXN0YW1wLFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBvcHRpb25zLmlzRXBoZW1lcmFsID8/IHRydWVcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IEVkaXRvclNlc3Npb24ge1xuXHRpZiAoc2Vzc2lvbi5wYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xuXHR9XG5cblx0aWYgKHNlc3Npb24ucGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHNlc3Npb247XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk7XG5cdGlmIChmaXJzdFZpc2libGVQYWdlKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdGFjdGl2ZVBhZ2VJZDogc2Vzc2lvbi5wYWdlc1swXSEuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY29udGVudENoYW5nZWQgPSBzdGF0ZS50ZXh0ICE9PSBwYWdlLmNvbnRlbnQ7XG5cdGNvbnN0IHNlbGVjdGlvbkNoYW5nZWQgPVxuXHRcdHN0YXRlLnNlbGVjdGlvblN0YXJ0ICE9PSBwYWdlLnNlbGVjdGlvblN0YXJ0IHx8IHN0YXRlLnNlbGVjdGlvbkVuZCAhPT0gcGFnZS5zZWxlY3Rpb25FbmQ7XG5cdGlmICghY29udGVudENoYW5nZWQgJiYgIXNlbGVjdGlvbkNoYW5nZWQpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdGNvbnN0IG5leHRQYWdlOiBFZGl0b3JQYWdlID0ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dFxuXHR9O1xuXG5cdGlmICghY29udGVudENoYW5nZWQpIHtcblx0XHRyZXR1cm4gbmV4dFBhZ2U7XG5cdH1cblxuXHRjb25zdCBwcmV2aW91c0Rlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShwYWdlLmNvbnRlbnQpO1xuXHRjb25zdCBuZXh0RGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpO1xuXHRjb25zdCBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPSBwYWdlLnRpdGxlID09PSBwcmV2aW91c0Rlcml2ZWRUaXRsZTtcblxuXHRyZXR1cm4ge1xuXHRcdC4uLm5leHRQYWdlLFxuXHRcdHRpdGxlOiBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPyBuZXh0RGVyaXZlZFRpdGxlIDogcGFnZS50aXRsZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVQYWdlKHBhZ2U6IEVkaXRvclBhZ2UpOiBFZGl0b3JQYWdlIHtcblx0aWYgKCFwYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IGZhbHNlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdC4uLmNsb25lZCxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHRcdC5zb3J0KGNvbXBhcmVQYWdlcyk7XG5cblx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKHVzZXJJZCk7XG5cdH1cblxuXHRjb25zdCBhY3RpdmVQYWdlSWQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5hY3RpdmVQYWdlSWQgPT09ICdzdHJpbmcnICYmXG5cdFx0cGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gdmFsdWUuYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKVxuXHRcdFx0PyB2YWx1ZS5hY3RpdmVQYWdlSWRcblx0XHRcdDogKHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKT8uaWQgPz8gcGFnZXNbMF0uaWQpO1xuXG5cdHJldHVybiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UoeyBwYWdlcywgYWN0aXZlUGFnZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUxlZ2FjeVN0YXRlKHN0YXRlOiBFZGl0b3JTdGF0ZSwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGNyZWF0ZVBhZ2UoJycsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KSwgc3RhdGUpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2UodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgY29udGVudCA9XG5cdFx0dHlwZW9mIHZhbHVlLmNvbnRlbnQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmNvbnRlbnRcblx0XHRcdDogdHlwZW9mIHZhbHVlLnRleHQgPT09ICdzdHJpbmcnXG5cdFx0XHRcdD8gdmFsdWUudGV4dFxuXHRcdFx0XHQ6ICcnO1xuXHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IGNvbnRlbnQucmVwbGFjZSgvXFxyXFxuPy9nLCAnXFxuJyk7XG5cdGNvbnN0IHNlbGVjdGlvblN0YXJ0ID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvblN0YXJ0ID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvblN0YXJ0IDogMCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3Qgc2VsZWN0aW9uRW5kID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvbkVuZCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25FbmQgOiBzZWxlY3Rpb25TdGFydCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3QgY3JlYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS5jcmVhdGVkQXQsIHZhbHVlLmNyZWF0ZWRfYXQpO1xuXHRjb25zdCB1cGRhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLnVwZGF0ZWRBdCwgdmFsdWUudXBkYXRlZF9hdCkgPz8gY3JlYXRlZEF0O1xuXHRjb25zdCBkZWxldGVkQXQgPSByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUuZGVsZXRlZEF0LCB2YWx1ZS5kZWxldGVkX2F0KTtcblxuXHRyZXR1cm4ge1xuXHRcdGlkOiB0eXBlb2YgdmFsdWUuaWQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmlkLmxlbmd0aCA+IDAgPyB2YWx1ZS5pZCA6IGNyZWF0ZUZhbGxiYWNrUGFnZUlkKGluZGV4KSxcblx0XHR1c2VySWQ6IHR5cGVvZiB2YWx1ZS51c2VySWQgPT09ICdzdHJpbmcnICYmIHZhbHVlLnVzZXJJZC5sZW5ndGggPiAwID8gdmFsdWUudXNlcklkIDogdXNlcklkLFxuXHRcdHRpdGxlOlxuXHRcdFx0dHlwZW9mIHZhbHVlLnRpdGxlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS50aXRsZS50cmltKCkubGVuZ3RoID4gMFxuXHRcdFx0XHQ/IHZhbHVlLnRpdGxlLnRyaW0oKVxuXHRcdFx0XHQ6IGRlcml2ZVBhZ2VUaXRsZShub3JtYWxpemVkQ29udGVudCksXG5cdFx0Y29udGVudDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0dGV4dDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RTeW5jZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQpLFxuXHRcdHN5bmNTdGF0dXM6IG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWUuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IHR5cGVvZiB2YWx1ZS5pc0VwaGVtZXJhbCA9PT0gJ2Jvb2xlYW4nID8gdmFsdWUuaXNFcGhlbWVyYWwgOiBmYWxzZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlOiBvYmplY3QpOiB2YWx1ZSBpcyBFZGl0b3JTdGF0ZSB7XG5cdHJldHVybiAndGV4dCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvblN0YXJ0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uRW5kJyBpbiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG5cdHJldHVybiAhIXZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCc7XG59XG5cbmZ1bmN0aW9uIGNsYW1wU2VsZWN0aW9uKHZhbHVlOiBudW1iZXIsIG1heDogbnVtYmVyKSB7XG5cdHJldHVybiBNYXRoLm1heCgwLCBNYXRoLm1pbih2YWx1ZSwgbWF4KSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhZ2VJZCgpIHtcblx0aWYgKHR5cGVvZiBjcnlwdG8gIT09ICd1bmRlZmluZWQnICYmIHR5cGVvZiBjcnlwdG8ucmFuZG9tVVVJRCA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHR9XG5cblx0cmV0dXJuIGBwYWdlLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfS0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUZhbGxiYWNrUGFnZUlkKGluZGV4OiBudW1iZXIpIHtcblx0cmV0dXJuIGBwYWdlLSR7aW5kZXggKyAxfWA7XG59XG5cbmZ1bmN0aW9uIHJlYWRUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbn1cblxuZnVuY3Rpb24gcmVhZE51bGxhYmxlVGltZXN0YW1wKC4uLnZhbHVlczogdW5rbm93bltdKSB7XG5cdGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZTogdW5rbm93bik6IFBhZ2VTeW5jU3RhdHVzIHtcblx0cmV0dXJuIHZhbHVlID09PSAnc3luY2VkJyB8fCB2YWx1ZSA9PT0gJ3BlbmRpbmdfcHVzaCcgfHwgdmFsdWUgPT09ICdjb25mbGljdCcgPyB2YWx1ZSA6ICdkaXJ0eSc7XG59XG5cbmZ1bmN0aW9uIG5leHREaXJ0eVN0YXR1cyhzdGF0dXM6IFBhZ2VTeW5jU3RhdHVzKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gc3RhdHVzID09PSAnY29uZmxpY3QnID8gJ2NvbmZsaWN0JyA6ICdkaXJ0eSc7XG59XG5cbmZ1bmN0aW9uIGNvbXBhcmVQYWdlcyhsZWZ0OiBFZGl0b3JQYWdlLCByaWdodDogRWRpdG9yUGFnZSkge1xuXHRpZiAobGVmdC5jcmVhdGVkQXQgIT09IHJpZ2h0LmNyZWF0ZWRBdCkge1xuXHRcdHJldHVybiBsZWZ0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKHJpZ2h0LmNyZWF0ZWRBdCk7XG5cdH1cblxuXHRyZXR1cm4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IENvdW50VmlzaWJpbGl0eSwgRWRpdG9yUHJlZmVyZW5jZXMsIFRoZW1lTW9kZSB9IGZyb20gJy4uL2NvcmUvcHJlZmVyZW5jZXMnO1xuaW1wb3J0IHsgREVGQVVMVF9QUkVGRVJFTkNFUywgbm9ybWFsaXplUHJlZmVyZW5jZXMgfSBmcm9tICcuLi9jb3JlL3ByZWZlcmVuY2VzJztcbmltcG9ydCB7XG5cdGNyZWF0ZVBhZ2UsXG5cdGNyZWF0ZVNlc3Npb24sXG5cdG5vcm1hbGl6ZVNlc3Npb24sXG5cdHR5cGUgRWRpdG9yUGFnZSxcblx0dHlwZSBFZGl0b3JTZXNzaW9uXG59IGZyb20gJy4uL2NvcmUvc2Vzc2lvbic7XG5pbXBvcnQge1xuXHRBTk9OWU1PVVNfVVNFUklELFxuXHRCTEFOS19EQl9OQU1FLFxuXHRCTEFOS19EQl9WRVJTSU9OLFxuXHRQQUdFU19TVE9SRV9OQU1FLFxuXHRTRVRUSU5HU19TVE9SRV9OQU1FLFxuXHRTRVRUSU5HX0FDVElWRV9QQUdFX0lELFxuXHRTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCxcblx0U0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQsXG5cdFNFVFRJTkdfVEhFTUUsXG5cdFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZLFxuXHRVU0VSX0lEX0lOREVYLFxuXHR0eXBlIFBhZ2VSZWNvcmQsXG5cdHR5cGUgU2V0dGluZ1JlY29yZFxufSBmcm9tICcuL3JlY29yZHMnO1xuXG5leHBvcnQgY2xhc3MgRWRpdG9yU3RvcmFnZSB7XG5cdHByaXZhdGUgc3RhdGljIGJhY2tlbmRQcm9taXNlOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0YXRpYyBtZW1vcnlCYWNrZW5kID0gY3JlYXRlTWVtb3J5QmFja2VuZCgpO1xuXG5cdHN0YXRpYyBhc3luYyBzYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbikge1xuXHRcdGF3YWl0IHRoaXMuc2F2ZVVzZXJTdGF0ZShBTk9OWU1PVVNfVVNFUklELCBzZXNzaW9uKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkQW5vbnltb3VzU3RhdGUoKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uPiB7XG5cdFx0cmV0dXJuIChhd2FpdCB0aGlzLmxvYWRVc2VyU3RhdGUoQU5PTllNT1VTX1VTRVJJRCkpID8/IGNyZWF0ZVNlc3Npb24oQU5PTllNT1VTX1VTRVJJRCk7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgc2F2ZVVzZXJTdGF0ZSh1c2VySWQ6IHN0cmluZywgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbikge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRhd2FpdCBiYWNrZW5kLnNhdmVTZXNzaW9uKHVzZXJJZCwgc2Vzc2lvbik7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFVzZXJTdGF0ZSh1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbiB8IG51bGw+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0cmV0dXJuIGF3YWl0IGJhY2tlbmQubG9hZFNlc3Npb24odXNlcklkKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvYWQgdXNlciBlZGl0b3Igc2Vzc2lvbjonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZEFub255bW91c1BhZ2UocGFnZUlkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclBhZ2UgfCBudWxsPiB7XG5cdFx0cmV0dXJuIHRoaXMubG9hZFVzZXJQYWdlKEFOT05ZTU9VU19VU0VSSUQsIHBhZ2VJZCk7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFVzZXJQYWdlKHVzZXJJZDogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+IHtcblx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0cmV0dXJuIGJhY2tlbmQubG9hZFBhZ2UodXNlcklkLCBwYWdlSWQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRQcmVmZXJlbmNlcyh1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogUHJvbWlzZTxFZGl0b3JQcmVmZXJlbmNlcz4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRjb25zdCBbdGhlbWVNb2RlLCBjb3VudFZpc2liaWxpdHksIHNwZWxsY2hlY2tFbmFibGVkXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdFx0YmFja2VuZC5nZXRTZXR0aW5nPFRoZW1lTW9kZT4odXNlcklkLCBTRVRUSU5HX1RIRU1FKSxcblx0XHRcdFx0YmFja2VuZC5nZXRTZXR0aW5nPENvdW50VmlzaWJpbGl0eT4odXNlcklkLCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSksXG5cdFx0XHRcdGJhY2tlbmQuZ2V0U2V0dGluZzxib29sZWFuPih1c2VySWQsIFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVEKVxuXHRcdFx0XSk7XG5cblx0XHRcdHJldHVybiBub3JtYWxpemVQcmVmZXJlbmNlcyh7XG5cdFx0XHRcdHRoZW1lTW9kZSxcblx0XHRcdFx0Y291bnRWaXNpYmlsaXR5LFxuXHRcdFx0XHRzcGVsbGNoZWNrRW5hYmxlZFxuXHRcdFx0fSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIGVkaXRvciBwcmVmZXJlbmNlczonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gREVGQVVMVF9QUkVGRVJFTkNFUztcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgc2F2ZVByZWZlcmVuY2VzKHVzZXJJZDogc3RyaW5nLCBwcmVmZXJlbmNlczogRWRpdG9yUHJlZmVyZW5jZXMpIHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0YXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0XHRiYWNrZW5kLnNldFNldHRpbmcodXNlcklkLCBTRVRUSU5HX1RIRU1FLCBwcmVmZXJlbmNlcy50aGVtZU1vZGUpLFxuXHRcdFx0XHRiYWNrZW5kLnNldFNldHRpbmcodXNlcklkLCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSwgcHJlZmVyZW5jZXMuY291bnRWaXNpYmlsaXR5KSxcblx0XHRcdFx0YmFja2VuZC5zZXRTZXR0aW5nKHVzZXJJZCwgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQsIHByZWZlcmVuY2VzLnNwZWxsY2hlY2tFbmFibGVkKVxuXHRcdFx0XSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBzYXZlIGVkaXRvciBwcmVmZXJlbmNlczonLCBlcnJvcik7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIGhhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdHJldHVybiAoYXdhaXQgYmFja2VuZC5nZXRTZXR0aW5nPGJvb2xlYW4+KHVzZXJJZCwgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQpKSA9PT0gdHJ1ZTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvYWQgYW5vbnltb3VzIGltcG9ydCBwcm9tcHQgc3RhdHVzOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbWFya1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGF3YWl0IGJhY2tlbmQuc2V0U2V0dGluZyh1c2VySWQsIFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JULCB0cnVlKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIHNhdmUgYW5vbnltb3VzIGltcG9ydCBwcm9tcHQgc3RhdHVzOicsIGVycm9yKTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgcmVzZXRGb3JUZXN0cygpIHtcblx0XHR0aGlzLmJhY2tlbmRQcm9taXNlID0gbnVsbDtcblx0XHR0aGlzLm1lbW9yeUJhY2tlbmQgPSBjcmVhdGVNZW1vcnlCYWNrZW5kKCk7XG5cdH1cblxuXHRwcml2YXRlIHN0YXRpYyBhc3luYyBnZXRCYWNrZW5kKCk6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHtcblx0XHRpZiAoIXRoaXMuYmFja2VuZFByb21pc2UpIHtcblx0XHRcdHRoaXMuYmFja2VuZFByb21pc2UgPVxuXHRcdFx0XHR0eXBlb2YgaW5kZXhlZERCID09PSAndW5kZWZpbmVkJyA/IFByb21pc2UucmVzb2x2ZSh0aGlzLm1lbW9yeUJhY2tlbmQpIDogY3JlYXRlSW5kZXhlZERiQmFja2VuZCgpO1xuXHRcdH1cblxuXHRcdHJldHVybiB0aGlzLmJhY2tlbmRQcm9taXNlO1xuXHR9XG59XG5cbmludGVyZmFjZSBTdG9yYWdlQmFja2VuZCB7XG5cdHNhdmVTZXNzaW9uKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogUHJvbWlzZTx2b2lkPjtcblx0bG9hZFNlc3Npb24odXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclNlc3Npb24gfCBudWxsPjtcblx0bG9hZFBhZ2UodXNlcklkOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JQYWdlIHwgbnVsbD47XG5cdGdldFNldHRpbmc8VD4odXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nKTogUHJvbWlzZTxUIHwgdW5kZWZpbmVkPjtcblx0c2V0U2V0dGluZyh1c2VySWQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVtb3J5QmFja2VuZCgpOiBTdG9yYWdlQmFja2VuZCB7XG5cdGNvbnN0IHBhZ2VzID0gbmV3IE1hcDxzdHJpbmcsIFBhZ2VSZWNvcmQ+KCk7XG5cdGNvbnN0IHNldHRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdSZWNvcmQ+KCk7XG5cblx0cmV0dXJuIHtcblx0XHRhc3luYyBzYXZlU2Vzc2lvbih1c2VySWQ6IHN0cmluZywgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbikge1xuXHRcdFx0Y29uc3QgbmV4dEtleXMgPSBuZXcgU2V0KHNlc3Npb24ucGFnZXMubWFwKChwYWdlKSA9PiBidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIHBhZ2UuaWQpKSk7XG5cdFx0XHRmb3IgKGNvbnN0IGtleSBvZiBbLi4ucGFnZXMua2V5cygpXSkge1xuXHRcdFx0XHRpZiAoa2V5LnN0YXJ0c1dpdGgoYCR7dXNlcklkfTo6YCkgJiYgIW5leHRLZXlzLmhhcyhrZXkpKSB7XG5cdFx0XHRcdFx0cGFnZXMuZGVsZXRlKGtleSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Zm9yIChjb25zdCBwYWdlIG9mIHNlc3Npb24ucGFnZXMpIHtcblx0XHRcdFx0cGFnZXMuc2V0KGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwgcGFnZS5pZCksIHRvUGFnZVJlY29yZChwYWdlLCB1c2VySWQpKTtcblx0XHRcdH1cblxuXHRcdFx0c2V0dGluZ3Muc2V0KFxuXHRcdFx0XHRidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQpLFxuXHRcdFx0XHRjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZCwgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCwgc2Vzc2lvbi5hY3RpdmVQYWdlSWQpXG5cdFx0XHQpO1xuXHRcdH0sXG5cdFx0YXN5bmMgbG9hZFNlc3Npb24odXNlcklkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHVzZXJQYWdlcyA9IFsuLi5wYWdlcy52YWx1ZXMoKV1cblx0XHRcdFx0LmZpbHRlcigocGFnZSkgPT4gcGFnZS51c2VySWQgPT09IHVzZXJJZClcblx0XHRcdFx0LnNvcnQoY29tcGFyZVBhZ2VzKVxuXHRcdFx0XHQubWFwKChwYWdlKSA9PiB0b0VkaXRvclBhZ2UocGFnZSkpO1xuXG5cdFx0XHRpZiAodXNlclBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgYWN0aXZlUGFnZUlkID0gc2V0dGluZ3MuZ2V0KGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCkpPy52YWx1ZTtcblx0XHRcdHJldHVybiBub3JtYWxpemVTZXNzaW9uKFxuXHRcdFx0XHR7IHBhZ2VzOiB1c2VyUGFnZXMsIGFjdGl2ZVBhZ2VJZDogdHlwZW9mIGFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgPyBhY3RpdmVQYWdlSWQgOiB1c2VyUGFnZXNbMF0uaWQgfSxcblx0XHRcdFx0dXNlcklkXG5cdFx0XHQpO1xuXHRcdH0sXG5cdFx0YXN5bmMgbG9hZFBhZ2UodXNlcklkOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCBwYWdlID0gcGFnZXMuZ2V0KGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwgcGFnZUlkKSk7XG5cdFx0XHRyZXR1cm4gcGFnZSA/IHRvRWRpdG9yUGFnZShwYWdlKSA6IG51bGw7XG5cdFx0fSxcblx0XHRhc3luYyBnZXRTZXR0aW5nPFQ+KHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZykge1xuXHRcdFx0cmV0dXJuIHNldHRpbmdzLmdldChidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIGtleSkpPy52YWx1ZSBhcyBUIHwgdW5kZWZpbmVkO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0U2V0dGluZyh1c2VySWQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG5cdFx0XHRzZXR0aW5ncy5zZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBrZXkpLCBjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZCwga2V5LCB2YWx1ZSkpO1xuXHRcdH1cblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlSW5kZXhlZERiQmFja2VuZCgpOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB7XG5cdGNvbnN0IGRiID0gYXdhaXQgb3BlbkRhdGFiYXNlKCk7XG5cblx0cmV0dXJuIHtcblx0XHRhc3luYyBzYXZlU2Vzc2lvbih1c2VySWQ6IHN0cmluZywgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbikge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihbUEFHRVNfU1RPUkVfTkFNRSwgU0VUVElOR1NfU1RPUkVfTkFNRV0sICdyZWFkd3JpdGUnKTtcblx0XHRcdGNvbnN0IHBhZ2VzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShQQUdFU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHNldHRpbmdzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHVzZXJJbmRleCA9IHBhZ2VzU3RvcmUuaW5kZXgoVVNFUl9JRF9JTkRFWCk7XG5cdFx0XHRjb25zdCBleGlzdGluZyA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8UGFnZVJlY29yZFtdPih1c2VySW5kZXguZ2V0QWxsKElEQktleVJhbmdlLm9ubHkodXNlcklkKSkpO1xuXHRcdFx0Y29uc3QgbmV4dElkcyA9IG5ldyBTZXQoc2Vzc2lvbi5wYWdlcy5tYXAoKHBhZ2UpID0+IHBhZ2UuaWQpKTtcblxuXHRcdFx0Zm9yIChjb25zdCBwYWdlIG9mIGV4aXN0aW5nKSB7XG5cdFx0XHRcdGlmICghbmV4dElkcy5oYXMocGFnZS5pZCkpIHtcblx0XHRcdFx0XHRwYWdlc1N0b3JlLmRlbGV0ZShbdXNlcklkLCBwYWdlLmlkXSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Zm9yIChjb25zdCBwYWdlIG9mIHNlc3Npb24ucGFnZXMpIHtcblx0XHRcdFx0cGFnZXNTdG9yZS5wdXQodG9QYWdlUmVjb3JkKHBhZ2UsIHVzZXJJZCkpO1xuXHRcdFx0fVxuXG5cdFx0XHRzZXR0aW5nc1N0b3JlLnB1dChjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZCwgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCwgc2Vzc2lvbi5hY3RpdmVQYWdlSWQpKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHR9LFxuXHRcdGFzeW5jIGxvYWRTZXNzaW9uKHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFtQQUdFU19TVE9SRV9OQU1FLCBTRVRUSU5HU19TVE9SRV9OQU1FXSwgJ3JlYWRvbmx5Jyk7XG5cdFx0XHRjb25zdCBwYWdlc1N0b3JlID0gdHgub2JqZWN0U3RvcmUoUEFHRVNfU1RPUkVfTkFNRSk7XG5cdFx0XHRjb25zdCBzZXR0aW5nc1N0b3JlID0gdHgub2JqZWN0U3RvcmUoU0VUVElOR1NfU1RPUkVfTkFNRSk7XG5cdFx0XHRjb25zdCB1c2VySW5kZXggPSBwYWdlc1N0b3JlLmluZGV4KFVTRVJfSURfSU5ERVgpO1xuXG5cdFx0XHRjb25zdCBbcGFnZXMsIGFjdGl2ZVBhZ2VTZXR0aW5nXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdFx0cmVxdWVzdFRvUHJvbWlzZTxQYWdlUmVjb3JkW10+KHVzZXJJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seSh1c2VySWQpKSksXG5cdFx0XHRcdHJlcXVlc3RUb1Byb21pc2U8U2V0dGluZ1JlY29yZCB8IHVuZGVmaW5lZD4oc2V0dGluZ3NTdG9yZS5nZXQoW3VzZXJJZCwgU0VUVElOR19BQ1RJVkVfUEFHRV9JRF0pKVxuXHRcdFx0XSk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cblx0XHRcdGlmIChwYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBub3JtYWxpemVTZXNzaW9uKFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cGFnZXM6IHBhZ2VzLnNvcnQoY29tcGFyZVBhZ2VzKS5tYXAoKHBhZ2UpID0+IHRvRWRpdG9yUGFnZShwYWdlKSksXG5cdFx0XHRcdFx0YWN0aXZlUGFnZUlkOlxuXHRcdFx0XHRcdFx0dHlwZW9mIGFjdGl2ZVBhZ2VTZXR0aW5nPy52YWx1ZSA9PT0gJ3N0cmluZycgPyBhY3RpdmVQYWdlU2V0dGluZy52YWx1ZSA6IHBhZ2VzWzBdIS5pZFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR1c2VySWRcblx0XHRcdCk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkUGFnZSh1c2VySWQ6IHN0cmluZywgcGFnZUlkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oUEFHRVNfU1RPUkVfTkFNRSwgJ3JlYWRvbmx5Jyk7XG5cdFx0XHRjb25zdCBwYWdlID0gYXdhaXQgcmVxdWVzdFRvUHJvbWlzZTxQYWdlUmVjb3JkIHwgdW5kZWZpbmVkPihcblx0XHRcdFx0dHgub2JqZWN0U3RvcmUoUEFHRVNfU1RPUkVfTkFNRSkuZ2V0KFt1c2VySWQsIHBhZ2VJZF0pXG5cdFx0XHQpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdFx0cmV0dXJuIHBhZ2UgPyB0b0VkaXRvclBhZ2UocGFnZSkgOiBudWxsO1xuXHRcdH0sXG5cdFx0YXN5bmMgZ2V0U2V0dGluZzxUPih1c2VySWQ6IHN0cmluZywga2V5OiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oU0VUVElOR1NfU1RPUkVfTkFNRSwgJ3JlYWRvbmx5Jyk7XG5cdFx0XHRjb25zdCBzZXR0aW5nID0gYXdhaXQgcmVxdWVzdFRvUHJvbWlzZTxTZXR0aW5nUmVjb3JkIHwgdW5kZWZpbmVkPihcblx0XHRcdFx0dHgub2JqZWN0U3RvcmUoU0VUVElOR1NfU1RPUkVfTkFNRSkuZ2V0KFt1c2VySWQsIGtleV0pXG5cdFx0XHQpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdFx0cmV0dXJuIHNldHRpbmc/LnZhbHVlIGFzIFQgfCB1bmRlZmluZWQ7XG5cdFx0fSxcblx0XHRhc3luYyBzZXRTZXR0aW5nKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oU0VUVElOR1NfU1RPUkVfTkFNRSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0dHgub2JqZWN0U3RvcmUoU0VUVElOR1NfU1RPUkVfTkFNRSkucHV0KGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkLCBrZXksIHZhbHVlKSk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBvcGVuRGF0YWJhc2UoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihCTEFOS19EQl9OQU1FLCBCTEFOS19EQl9WRVJTSU9OKTtcblxuXHRcdHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gKCkgPT4ge1xuXHRcdFx0Y29uc3QgZGIgPSByZXF1ZXN0LnJlc3VsdDtcblx0XHRcdGlmICghZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhQQUdFU19TVE9SRV9OQU1FKSkge1xuXHRcdFx0XHRjb25zdCBwYWdlc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoUEFHRVNfU1RPUkVfTkFNRSwge1xuXHRcdFx0XHRcdGtleVBhdGg6IFsndXNlcklkJywgJ2lkJ11cblx0XHRcdFx0fSk7XG5cdFx0XHRcdHBhZ2VzU3RvcmUuY3JlYXRlSW5kZXgoVVNFUl9JRF9JTkRFWCwgJ3VzZXJJZCcsIHsgdW5pcXVlOiBmYWxzZSB9KTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKFNFVFRJTkdTX1NUT1JFX05BTUUpKSB7XG5cdFx0XHRcdGNvbnN0IHNldHRpbmdzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FLCB7XG5cdFx0XHRcdFx0a2V5UGF0aDogWyd1c2VySWQnLCAna2V5J11cblx0XHRcdFx0fSk7XG5cdFx0XHRcdHNldHRpbmdzU3RvcmUuY3JlYXRlSW5kZXgoVVNFUl9JRF9JTkRFWCwgJ3VzZXJJZCcsIHsgdW5pcXVlOiBmYWxzZSB9KTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbXBvc2l0ZUtleShsZWZ0OiBzdHJpbmcsIHJpZ2h0OiBzdHJpbmcpIHtcblx0cmV0dXJuIGAke2xlZnR9Ojoke3JpZ2h0fWA7XG59XG5cbmZ1bmN0aW9uIHRvUGFnZVJlY29yZChwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQ6IHN0cmluZyk6IFBhZ2VSZWNvcmQge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBwYWdlLmlkLFxuXHRcdHVzZXJJZCxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0Y3JlYXRlZEF0OiBwYWdlLmNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IHBhZ2UudXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiBwYWdlLmxhc3RTeW5jZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHBhZ2UubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcGFnZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogcGFnZS5zeW5jU3RhdHVzLFxuXHRcdGlzRXBoZW1lcmFsOiBwYWdlLmlzRXBoZW1lcmFsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHRvRWRpdG9yUGFnZShwYWdlOiBQYWdlUmVjb3JkKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IG5leHRQYWdlID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHtcblx0XHRpZDogcGFnZS5pZCxcblx0XHR1c2VySWQ6IHBhZ2UudXNlcklkLFxuXHRcdG5vdzogcGFnZS5jcmVhdGVkQXQsXG5cdFx0aXNFcGhlbWVyYWw6IHBhZ2UuaXNFcGhlbWVyYWxcblx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5uZXh0UGFnZSxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogcGFnZS5jcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBwYWdlLnVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogcGFnZS5sYXN0U3luY2VkQXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBwYWdlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHBhZ2UubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2Uuc3luY1N0YXR1cyxcblx0XHRpc0VwaGVtZXJhbDogcGFnZS5pc0VwaGVtZXJhbFxuXHR9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBTZXR0aW5nUmVjb3JkIHtcblx0cmV0dXJuIHtcblx0XHR1c2VySWQsXG5cdFx0a2V5LFxuXHRcdHZhbHVlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdH07XG59XG5cbmZ1bmN0aW9uIGNvbXBhcmVQYWdlcyhsZWZ0OiBQYWdlUmVjb3JkLCByaWdodDogUGFnZVJlY29yZCkge1xuXHRpZiAobGVmdC5jcmVhdGVkQXQgIT09IHJpZ2h0LmNyZWF0ZWRBdCkge1xuXHRcdHJldHVybiBsZWZ0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKHJpZ2h0LmNyZWF0ZWRBdCk7XG5cdH1cblxuXHRyZXR1cm4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvUHJvbWlzZTxUPihyZXF1ZXN0OiBJREJSZXF1ZXN0PFQ+KTogUHJvbWlzZTxUPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiB0cmFuc2FjdGlvblRvUHJvbWlzZSh0cmFuc2FjdGlvbjogSURCVHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHR0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gcmVzb2x2ZSgpO1xuXHRcdHRyYW5zYWN0aW9uLm9uZXJyb3IgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuXHRcdHRyYW5zYWN0aW9uLm9uYWJvcnQgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IgPz8gbmV3IEVycm9yKCdJbmRleGVkREIgdHJhbnNhY3Rpb24gYWJvcnRlZCcpKTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDUVosSUFBTSxzQkFBeUM7QUFBQSxFQUNyRCxXQUFXO0FBQUEsRUFDWCxtQkFBbUI7QUFBQSxFQUNuQixpQkFBaUI7QUFDbEI7QUFFQSxJQUFNLHlCQUE0QyxDQUFDLFVBQVUsUUFBUSxRQUFRO0FBRXRFLFNBQVMscUJBQXFCLE9BQW1DO0FBQ3ZF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QUFZO0FBQzFGLFFBQU0sVUFBVUEsZUFBYyxrQkFBa0IsUUFBUTtBQUN4RCxRQUFNLGNBQWMsbUJBQW1CLE9BQU87QUFDOUMsUUFBTSxjQUFjLG1CQUFtQjtBQUFBLElBQ3RDLGNBQWM7QUFBQSxJQUNkLE9BQU8sQ0FBQyxRQUFRLE1BQU0sQ0FBQyxDQUFFO0FBQUEsRUFDMUIsQ0FBQztBQUVELFFBQU0sY0FBYyxNQUFNLGNBQWMsa0JBQWtCLFFBQVE7QUFDbEUsU0FBTyxNQUFNLGFBQWEsSUFBSTtBQUMvQixDQUFDO0FBRUQsS0FBSyxrREFBa0QsWUFBWTtBQUNsRSxRQUFNLFVBQXlCO0FBQUEsSUFDOUIsY0FBYztBQUFBLElBQ2QsT0FBTyxDQUFDLFdBQVcsSUFBSSxFQUFFLElBQUksVUFBVSxRQUFRLGtCQUFrQixhQUFhLEtBQUssQ0FBQyxDQUFDO0FBQUEsRUFDdEY7QUFDQSxRQUFNLGNBQWMsbUJBQW1CLE9BQU87QUFFOUMsUUFBTSxTQUFTLE1BQU0sY0FBYyxtQkFBbUI7QUFDdEQsU0FBTyxNQUFNLE9BQU8sTUFBTSxDQUFDLEdBQUcsYUFBYSxJQUFJO0FBQ2hELENBQUM7QUFFRCxLQUFLLHlFQUF5RSxZQUFZO0FBQ3pGLFNBQU8sVUFBVSxNQUFNLGNBQWMsZ0JBQWdCLGdCQUFnQixHQUFHLG1CQUFtQjtBQUM1RixDQUFDO0FBRUQsS0FBSyxzRUFBc0UsWUFBWTtBQUN0RixRQUFNLGNBQWMsZ0JBQWdCLFVBQVU7QUFBQSxJQUM3QyxXQUFXO0FBQUEsSUFDWCxtQkFBbUI7QUFBQSxJQUNuQixpQkFBaUI7QUFBQSxFQUNsQixDQUFDO0FBRUQsU0FBTyxVQUFVLE1BQU0sY0FBYyxnQkFBZ0IsUUFBUSxHQUFHO0FBQUEsSUFDL0QsV0FBVztBQUFBLElBQ1gsbUJBQW1CO0FBQUEsSUFDbkIsaUJBQWlCO0FBQUEsRUFDbEIsQ0FBQztBQUNGLENBQUM7QUFFRCxLQUFLLHNGQUFzRixZQUFZO0FBQ3RHLFNBQU8sTUFBTSxNQUFNLGNBQWMsOEJBQThCLFFBQVEsR0FBRyxLQUFLO0FBRS9FLFFBQU0sY0FBYywrQkFBK0IsUUFBUTtBQUMzRCxRQUFNLGNBQWMsK0JBQStCLFFBQVE7QUFFM0QsU0FBTyxNQUFNLE1BQU0sY0FBYyw4QkFBOEIsUUFBUSxHQUFHLElBQUk7QUFDOUUsU0FBTyxNQUFNLE1BQU0sY0FBYyw4QkFBOEIsUUFBUSxHQUFHLEtBQUs7QUFDaEYsQ0FBQzsiLAogICJuYW1lcyI6IFsiY29tcGFyZVBhZ2VzIiwgImNyZWF0ZVNlc3Npb24iXQp9Cg==
