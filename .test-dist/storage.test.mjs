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
var UPDATED_AT_INDEX = "updatedAt";
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
  const pages = sortPagesByRecency(session.pages);
  if (pages.some((page) => page.id === session.activePageId && page.deletedAt === null)) {
    return {
      ...session,
      pages
    };
  }
  const firstVisiblePage = pages.find((page) => page.deletedAt === null);
  if (firstVisiblePage) {
    return {
      ...session,
      pages,
      activePageId: firstVisiblePage.id
    };
  }
  return {
    ...session,
    pages,
    activePageId: pages[0].id
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
  const pages = value.pages.map((page, index) => normalizePage(page, index, userId)).filter((page) => page !== null).sort(comparePagesByRecency);
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
function sortPagesByRecency(pages) {
  return [...pages].sort(comparePagesByRecency);
}
function comparePagesByRecency(left, right) {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
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
      const userPages = sortPagesByRecency(
        [...pages.values()].filter((page) => page.userId === userId).map((page) => toEditorPage(page))
      );
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
      const updatedAtIndex = pagesStore.index(UPDATED_AT_INDEX);
      const [pages, activePageSetting] = await Promise.all([
        readPagesByUpdatedAtDesc(updatedAtIndex, userId),
        requestToPromise(settingsStore.get([userId, SETTING_ACTIVE_PAGE_ID]))
      ]);
      await transactionToPromise(tx);
      if (pages.length === 0) {
        return null;
      }
      return normalizeSession(
        {
          pages: pages.map((page) => toEditorPage(page)),
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
        pagesStore.createIndex(UPDATED_AT_INDEX, ["userId", "updatedAt"], { unique: false });
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
function createSettingRecord(userId, key, value) {
  return {
    userId,
    key,
    value,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function readPagesByUpdatedAtDesc(index, userId) {
  return new Promise((resolve, reject) => {
    const pages = [];
    const range = IDBKeyRange.bound([userId, ""], [userId, "\uFFFF"]);
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(pages);
        return;
      }
      pages.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
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
  assert.equal(loaded.pages[0]?.id, "page-b");
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
test("EditorStorage preserves selection offsets across local session reloads", async () => {
  const session = createSession2("user-a", "page-b");
  session.pages[1].selectionStart = 2;
  session.pages[1].selectionEnd = 4;
  await EditorStorage.saveUserState("user-a", session);
  const loaded = await EditorStorage.loadUserState("user-a");
  assert.equal(loaded?.activePageId, "page-b");
  assert.equal(loaded?.pages[0]?.id, "page-b");
  assert.equal(loaded?.pages[0]?.selectionStart, 2);
  assert.equal(loaded?.pages[0]?.selectionEnd, 4);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3RvcmFnZS50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvcmUvcHJlZmVyZW5jZXMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IERFRkFVTFRfUFJFRkVSRU5DRVMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3ByZWZlcmVuY2VzLnRzJztcbmltcG9ydCB7IGNyZWF0ZVBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL2NvcmUvc2Vzc2lvbi50cyc7XG5pbXBvcnQgeyBFZGl0b3JTdG9yYWdlIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyc7XG5pbXBvcnQgeyBBTk9OWU1PVVNfVVNFUklEIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbmZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkOiBzdHJpbmcsIGFjdGl2ZVBhZ2VJZCA9ICdwYWdlLWEnKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2VBID0gY3JlYXRlUGFnZSgnYWxwaGEnLCB7XG5cdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdHVzZXJJZCxcblx0XHRub3c6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0cGFnZUEudGl0bGUgPSAnQSc7XG5cdHBhZ2VBLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonO1xuXG5cdGNvbnN0IHBhZ2VCID0gY3JlYXRlUGFnZSgnYmV0YScsIHtcblx0XHRpZDogJ3BhZ2UtYicsXG5cdFx0dXNlcklkLFxuXHRcdG5vdzogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRwYWdlQi50aXRsZSA9ICdCJztcblx0cGFnZUIudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWic7XG5cblx0cmV0dXJuIHtcblx0XHRhY3RpdmVQYWdlSWQsXG5cdFx0cGFnZXM6IFtwYWdlQSwgcGFnZUJdXG5cdH07XG59XG5cbnRlc3QuYmVmb3JlRWFjaCgoKSA9PiB7XG5cdEVkaXRvclN0b3JhZ2UucmVzZXRGb3JUZXN0cygpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIGFub255bW91cyBzdGF0ZSB0aHJvdWdoIHRoZSBibGFuayBkYXRhYmFzZSBzaGFwZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oQU5PTllNT1VTX1VTRVJJRCwgJ3BhZ2UtYicpO1xuXG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb24pO1xuXG5cdGNvbnN0IGxvYWRlZCA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQuYWN0aXZlUGFnZUlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXMubGVuZ3RoLCBzZXNzaW9uLnBhZ2VzLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LnVzZXJJZCwgQU5PTllNT1VTX1VTRVJJRCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBzYXZlcyBhbmQgbG9hZHMgdXNlci1zY29wZWQgc3RhdGUgc2VwYXJhdGVseSBwZXIgYWNjb3VudCcsIGFzeW5jICgpID0+IHtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnLCAncGFnZS1hJykpO1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVVc2VyU3RhdGUoJ3VzZXItYicsIGNyZWF0ZVNlc3Npb24oJ3VzZXItYicsICdwYWdlLWInKSk7XG5cblx0YXNzZXJ0LmVxdWFsKChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYScpKT8uYWN0aXZlUGFnZUlkLCAncGFnZS1hJyk7XG5cdGFzc2VydC5lcXVhbCgoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN0YXRlKCd1c2VyLWInKSk/LmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1hJykpPy5wYWdlc1swXT8udXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbCgoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN0YXRlKCd1c2VyLWInKSk/LnBhZ2VzWzBdPy51c2VySWQsICd1c2VyLWInKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIGxvYWRzIGEgc2luZ2xlIHBhZ2Ugd2l0aG91dCByZXF1aXJpbmcgZnVsbCBzZXNzaW9uIGNvbnN1bWVycycsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScsICdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBzZXNzaW9uKTtcblxuXHRjb25zdCBwYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclBhZ2UoJ3VzZXItYScsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2U/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5jb250ZW50LCAnYmV0YScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZT8udXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Uga2VlcHMgcGFnZSBsb29rdXBzIGluIHN5bmMgYWZ0ZXIgaGFyZCByZW1vdmFscyBhcmUgc2F2ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKEFOT05ZTU9VU19VU0VSSUQsICdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbik7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbc2Vzc2lvbi5wYWdlc1swXSFdXG5cdH0pO1xuXG5cdGNvbnN0IGRlbGV0ZWRQYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkQW5vbnltb3VzUGFnZSgncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChkZWxldGVkUGFnZSwgbnVsbCk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBwcmVzZXJ2ZXMgZXBoZW1lcmFsIHBsYWNlaG9sZGVycycsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbiA9IHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbY3JlYXRlUGFnZSgnJywgeyBpZDogJ3BhZ2UtYScsIHVzZXJJZDogQU5PTllNT1VTX1VTRVJJRCwgaXNFcGhlbWVyYWw6IHRydWUgfSldXG5cdH07XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb24pO1xuXG5cdGNvbnN0IGxvYWRlZCA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZEFub255bW91c1N0YXRlKCk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHByZXNlcnZlcyBzZWxlY3Rpb24gb2Zmc2V0cyBhY3Jvc3MgbG9jYWwgc2Vzc2lvbiByZWxvYWRzJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigndXNlci1hJywgJ3BhZ2UtYicpO1xuXHRzZXNzaW9uLnBhZ2VzWzFdIS5zZWxlY3Rpb25TdGFydCA9IDI7XG5cdHNlc3Npb24ucGFnZXNbMV0hLnNlbGVjdGlvbkVuZCA9IDQ7XG5cblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWEnLCBzZXNzaW9uKTtcblxuXHRjb25zdCBsb2FkZWQgPSBhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYScpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkPy5hY3RpdmVQYWdlSWQsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKGxvYWRlZD8ucGFnZXNbMF0/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQ/LnBhZ2VzWzBdPy5zZWxlY3Rpb25TdGFydCwgMik7XG5cdGFzc2VydC5lcXVhbChsb2FkZWQ/LnBhZ2VzWzBdPy5zZWxlY3Rpb25FbmQsIDQpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2UgcmV0dXJucyBkZWZhdWx0IHByZWZlcmVuY2VzIHdoZW4gbm8gc2V0dGluZ3MgYXJlIHN0b3JlZCcsIGFzeW5jICgpID0+IHtcblx0YXNzZXJ0LmRlZXBFcXVhbChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRQcmVmZXJlbmNlcyhBTk9OWU1PVVNfVVNFUklEKSwgREVGQVVMVF9QUkVGRVJFTkNFUyk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBzYXZlcyBhbmQgbG9hZHMgcHJlZmVyZW5jZXMgdGhyb3VnaCBzZXR0aW5ncyByZWNvcmRzJywgYXN5bmMgKCkgPT4ge1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVQcmVmZXJlbmNlcygndXNlci1hJywge1xuXHRcdHRoZW1lTW9kZTogJ2RhcmsnLFxuXHRcdHNwZWxsY2hlY2tFbmFibGVkOiBmYWxzZSxcblx0XHRjb3VudFZpc2liaWxpdHk6ICdwaW5uZWQnXG5cdH0pO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkUHJlZmVyZW5jZXMoJ3VzZXItYScpLCB7XG5cdFx0dGhlbWVNb2RlOiAnZGFyaycsXG5cdFx0c3BlbGxjaGVja0VuYWJsZWQ6IGZhbHNlLFxuXHRcdGNvdW50VmlzaWJpbGl0eTogJ3Bpbm5lZCdcblx0fSk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSB0cmFja3Mgd2hldGhlciBhbiBhY2NvdW50IGhhcyBiZWVuIHByb21wdGVkIHRvIGltcG9ydCBhbm9ueW1vdXMgZGF0YScsIGFzeW5jICgpID0+IHtcblx0YXNzZXJ0LmVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UuaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQoJ3VzZXItYScpLCBmYWxzZSk7XG5cblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5tYXJrUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQoJ3VzZXItYScpO1xuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLm1hcmtQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCgndXNlci1hJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UuaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQoJ3VzZXItYScpLCB0cnVlKTtcblx0YXNzZXJ0LmVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UuaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQoJ3VzZXItYicpLCBmYWxzZSk7XG59KTtcbiIsICJleHBvcnQgdHlwZSBUaGVtZU1vZGUgPSAnbGlnaHQnIHwgJ2RhcmsnO1xuZXhwb3J0IHR5cGUgQ291bnRWaXNpYmlsaXR5ID0gJ3Bpbm5lZCcgfCAnYXV0bycgfCAnaGlkZGVuJztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQcmVmZXJlbmNlcyB7XG5cdHRoZW1lTW9kZTogVGhlbWVNb2RlO1xuXHRzcGVsbGNoZWNrRW5hYmxlZDogYm9vbGVhbjtcblx0Y291bnRWaXNpYmlsaXR5OiBDb3VudFZpc2liaWxpdHk7XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1BSRUZFUkVOQ0VTOiBFZGl0b3JQcmVmZXJlbmNlcyA9IHtcblx0dGhlbWVNb2RlOiAnbGlnaHQnLFxuXHRzcGVsbGNoZWNrRW5hYmxlZDogdHJ1ZSxcblx0Y291bnRWaXNpYmlsaXR5OiAnYXV0bydcbn07XG5cbmNvbnN0IENPVU5UX1ZJU0lCSUxJVFlfT1JERVI6IENvdW50VmlzaWJpbGl0eVtdID0gWydwaW5uZWQnLCAnYXV0bycsICdoaWRkZW4nXTtcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVByZWZlcmVuY2VzKHZhbHVlOiB1bmtub3duKTogRWRpdG9yUHJlZmVyZW5jZXMge1xuXHRpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHtcblx0XHRyZXR1cm4gREVGQVVMVF9QUkVGRVJFTkNFUztcblx0fVxuXG5cdGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RWRpdG9yUHJlZmVyZW5jZXM+O1xuXG5cdHJldHVybiB7XG5cdFx0dGhlbWVNb2RlOiBjYW5kaWRhdGUudGhlbWVNb2RlID09PSAnZGFyaycgPyAnZGFyaycgOiAnbGlnaHQnLFxuXHRcdHNwZWxsY2hlY2tFbmFibGVkOlxuXHRcdFx0dHlwZW9mIGNhbmRpZGF0ZS5zcGVsbGNoZWNrRW5hYmxlZCA9PT0gJ2Jvb2xlYW4nXG5cdFx0XHRcdD8gY2FuZGlkYXRlLnNwZWxsY2hlY2tFbmFibGVkXG5cdFx0XHRcdDogREVGQVVMVF9QUkVGRVJFTkNFUy5zcGVsbGNoZWNrRW5hYmxlZCxcblx0XHRjb3VudFZpc2liaWxpdHk6IENPVU5UX1ZJU0lCSUxJVFlfT1JERVIuaW5jbHVkZXMoY2FuZGlkYXRlLmNvdW50VmlzaWJpbGl0eSBhcyBDb3VudFZpc2liaWxpdHkpXG5cdFx0XHQ/IChjYW5kaWRhdGUuY291bnRWaXNpYmlsaXR5IGFzIENvdW50VmlzaWJpbGl0eSlcblx0XHRcdDogREVGQVVMVF9QUkVGRVJFTkNFUy5jb3VudFZpc2liaWxpdHlcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGN5Y2xlQ291bnRWaXNpYmlsaXR5KHZhbHVlOiBDb3VudFZpc2liaWxpdHkpOiBDb3VudFZpc2liaWxpdHkge1xuXHRjb25zdCBjdXJyZW50SW5kZXggPSBDT1VOVF9WSVNJQklMSVRZX09SREVSLmluZGV4T2YodmFsdWUpO1xuXHRyZXR1cm4gQ09VTlRfVklTSUJJTElUWV9PUkRFUlsoY3VycmVudEluZGV4ICsgMSkgJSBDT1VOVF9WSVNJQklMSVRZX09SREVSLmxlbmd0aF0hO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q291bnRWaXNpYmlsaXR5TGFiZWwodmFsdWU6IENvdW50VmlzaWJpbGl0eSk6IHN0cmluZyB7XG5cdHN3aXRjaCAodmFsdWUpIHtcblx0XHRjYXNlICdwaW5uZWQnOlxuXHRcdFx0cmV0dXJuICdDb3VudCBwaW5uZWQnO1xuXHRcdGNhc2UgJ2hpZGRlbic6XG5cdFx0XHRyZXR1cm4gJ0NvdW50IGhpZGRlbic7XG5cdFx0ZGVmYXVsdDpcblx0XHRcdHJldHVybiAnQ291bnQgc2hvd24nO1xuXHR9XG59XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcbmV4cG9ydCBjb25zdCBVUERBVEVEX0FUX0lOREVYID0gJ3VwZGF0ZWRBdCc7XG5cbmV4cG9ydCBjb25zdCBBTk9OWU1PVVNfVVNFUklEID0gJ2Fub255bW91cyc7XG5cbmV4cG9ydCB0eXBlIFBhZ2VTeW5jU3RhdHVzID0gJ3N5bmNlZCcgfCAnZGlydHknIHwgJ3BlbmRpbmdfcHVzaCcgfCAnY29uZmxpY3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VSZWNvcmQge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRzZWxlY3Rpb25TdGFydDogbnVtYmVyO1xuXHRzZWxlY3Rpb25FbmQ6IG51bWJlcjtcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdHN5bmNTdGF0dXM6IFBhZ2VTeW5jU3RhdHVzO1xuXHRpc0VwaGVtZXJhbDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nUmVjb3JkIHtcblx0a2V5OiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nIHwgbnVsbDtcblx0dmFsdWU6IHVua25vd247XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCA9ICdhY3RpdmVQYWdlSWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfVEhFTUUgPSAndGhlbWUnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZID0gJ3dvcmRDb3VudFZpc2liaWxpdHknO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVEID0gJ3NwZWxsY2hlY2tFbmFibGVkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCA9ICdoYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCc7XG4iLCAiaW1wb3J0IHR5cGUgeyBFZGl0b3JTdGF0ZSB9IGZyb20gJy4uL2Jhc2ljL2hpc3RvcnknO1xuaW1wb3J0IHtcblx0QU5PTllNT1VTX1VTRVJJRCxcblx0dHlwZSBQYWdlUmVjb3JkLFxuXHR0eXBlIFBhZ2VTeW5jU3RhdHVzXG59IGZyb20gJy4uL3BlcnNpc3RlbmNlL3JlY29yZHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclBhZ2UgZXh0ZW5kcyBFZGl0b3JTdGF0ZSwgUGFnZVJlY29yZCB7fVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoXG5cdGNvbnRlbnQgPSAnJyxcblx0b3B0aW9uczoge1xuXHRcdGlkPzogc3RyaW5nO1xuXHRcdHVzZXJJZD86IHN0cmluZztcblx0XHRub3c/OiBzdHJpbmc7XG5cdFx0aXNFcGhlbWVyYWw/OiBib29sZWFuO1xuXHR9ID0ge31cbik6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0aW1lc3RhbXAgPSBvcHRpb25zLm5vdyA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdHJldHVybiB7XG5cdFx0aWQ6IG9wdGlvbnMuaWQgPz8gY3JlYXRlUGFnZUlkKCksXG5cdFx0dXNlcklkOiBvcHRpb25zLnVzZXJJZCA/PyBBTk9OWU1PVVNfVVNFUklELFxuXHRcdHRpdGxlOiBkZXJpdmVQYWdlVGl0bGUoY29udGVudCksXG5cdFx0Y29udGVudCxcblx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdHNlbGVjdGlvbkVuZDogMCxcblx0XHRjcmVhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHR1cGRhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogb3B0aW9ucy5pc0VwaGVtZXJhbCA/PyB0cnVlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2UoJycsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gc29ydFBhZ2VzQnlSZWNlbmN5KHNlc3Npb24ucGFnZXMpO1xuXHRpZiAocGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRwYWdlc1xuXHRcdH07XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gcGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpO1xuXHRpZiAoZmlyc3RWaXNpYmxlUGFnZSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXMsXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdHBhZ2VzLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZXNbMF0hLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNWaXNpYmxlRXBoZW1lcmFsQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRyZXR1cm4gISFhY3RpdmVQYWdlICYmIGFjdGl2ZVBhZ2UuZGVsZXRlZEF0ID09PSBudWxsICYmIGFjdGl2ZVBhZ2UuaXNFcGhlbWVyYWw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVFbGlnaWJsZUFjdGl2ZVBhZ2VJZChzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRpZiAoIWFjdGl2ZVBhZ2UgfHwgYWN0aXZlUGFnZS5kZWxldGVkQXQgIT09IG51bGwgfHwgYWN0aXZlUGFnZS5pc0VwaGVtZXJhbCkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIGFjdGl2ZVBhZ2UuaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVBY3RpdmVQYWdlVXBkYXRlVGFyZ2V0KFxuXHRwcmV2aW91c1Nlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdG5leHRTZXNzaW9uOiBFZGl0b3JTZXNzaW9uXG4pOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgbmV4dEFjdGl2ZVBhZ2VJZCA9IGdldFJlbW90ZUVsaWdpYmxlQWN0aXZlUGFnZUlkKG5leHRTZXNzaW9uKTtcblx0aWYgKG5leHRBY3RpdmVQYWdlSWQgJiYgbmV4dEFjdGl2ZVBhZ2VJZCAhPT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkge1xuXHRcdHJldHVybiBuZXh0QWN0aXZlUGFnZUlkO1xuXHR9XG5cblx0Y29uc3QgcHJldmlvdXNBY3RpdmVCZWZvcmUgPSBwcmV2aW91c1Nlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0Y29uc3QgcHJldmlvdXNBY3RpdmVBZnRlciA9IG5leHRTZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHByZXZpb3VzU2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGlmIChcblx0XHRwcmV2aW91c0FjdGl2ZUJlZm9yZSAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmRlbGV0ZWRBdCA9PT0gbnVsbCAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmlzRXBoZW1lcmFsICYmXG5cdFx0cHJldmlvdXNBY3RpdmVBZnRlciAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQWZ0ZXIuZGVsZXRlZEF0ID09PSBudWxsICYmXG5cdFx0IXByZXZpb3VzQWN0aXZlQWZ0ZXIuaXNFcGhlbWVyYWxcblx0KSB7XG5cdFx0cmV0dXJuIHByZXZpb3VzQWN0aXZlQWZ0ZXIuaWQ7XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY29udGVudENoYW5nZWQgPSBzdGF0ZS50ZXh0ICE9PSBwYWdlLmNvbnRlbnQ7XG5cdGNvbnN0IHNlbGVjdGlvbkNoYW5nZWQgPVxuXHRcdHN0YXRlLnNlbGVjdGlvblN0YXJ0ICE9PSBwYWdlLnNlbGVjdGlvblN0YXJ0IHx8IHN0YXRlLnNlbGVjdGlvbkVuZCAhPT0gcGFnZS5zZWxlY3Rpb25FbmQ7XG5cdGlmICghY29udGVudENoYW5nZWQgJiYgIXNlbGVjdGlvbkNoYW5nZWQpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdGNvbnN0IG5leHRQYWdlOiBFZGl0b3JQYWdlID0ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dFxuXHR9O1xuXG5cdGlmICghY29udGVudENoYW5nZWQpIHtcblx0XHRyZXR1cm4gbmV4dFBhZ2U7XG5cdH1cblxuXHRjb25zdCBwcmV2aW91c0Rlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShwYWdlLmNvbnRlbnQpO1xuXHRjb25zdCBuZXh0RGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpO1xuXHRjb25zdCBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPSBwYWdlLnRpdGxlID09PSBwcmV2aW91c0Rlcml2ZWRUaXRsZTtcblxuXHRyZXR1cm4ge1xuXHRcdC4uLm5leHRQYWdlLFxuXHRcdHRpdGxlOiBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPyBuZXh0RGVyaXZlZFRpdGxlIDogcGFnZS50aXRsZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVQYWdlKHBhZ2U6IEVkaXRvclBhZ2UpOiBFZGl0b3JQYWdlIHtcblx0aWYgKCFwYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IGZhbHNlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdC4uLmNsb25lZCxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHQuc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xuXG5cdGlmIChwYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbih1c2VySWQpO1xuXHR9XG5cblx0Y29uc3QgYWN0aXZlUGFnZUlkID1cblx0XHR0eXBlb2YgdmFsdWUuYWN0aXZlUGFnZUlkID09PSAnc3RyaW5nJyAmJlxuXHRcdHBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHZhbHVlLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbClcblx0XHRcdD8gdmFsdWUuYWN0aXZlUGFnZUlkXG5cdFx0XHQ6IChwYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk/LmlkID8/IHBhZ2VzWzBdLmlkKTtcblxuXHRyZXR1cm4gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHsgcGFnZXMsIGFjdGl2ZVBhZ2VJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1pZ3JhdGVMZWdhY3lTdGF0ZShzdGF0ZTogRWRpdG9yU3RhdGUsIHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IHVwZGF0ZVBhZ2VTdGF0ZShjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2UgfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jb250ZW50ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5jb250ZW50XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLnRleHRcblx0XHRcdFx0OiAnJztcblx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xuXHRjb25zdCBzZWxlY3Rpb25TdGFydCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25TdGFydCA6IDAsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IHNlbGVjdGlvbkVuZCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uRW5kIDogc2VsZWN0aW9uU3RhcnQsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUuY3JlYXRlZEF0LCB2YWx1ZS5jcmVhdGVkX2F0KTtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS51cGRhdGVkQXQsIHZhbHVlLnVwZGF0ZWRfYXQpID8/IGNyZWF0ZWRBdDtcblx0Y29uc3QgZGVsZXRlZEF0ID0gcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmRlbGV0ZWRBdCwgdmFsdWUuZGVsZXRlZF9hdCk7XG5cblx0cmV0dXJuIHtcblx0XHRpZDogdHlwZW9mIHZhbHVlLmlkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5pZC5sZW5ndGggPiAwID8gdmFsdWUuaWQgOiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleCksXG5cdFx0dXNlcklkOiB0eXBlb2YgdmFsdWUudXNlcklkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51c2VySWQubGVuZ3RoID4gMCA/IHZhbHVlLnVzZXJJZCA6IHVzZXJJZCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0U3luY2VkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0KSxcblx0XHRzeW5jU3RhdHVzOiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiB0eXBlb2YgdmFsdWUuaXNFcGhlbWVyYWwgPT09ICdib29sZWFuJyA/IHZhbHVlLmlzRXBoZW1lcmFsIDogZmFsc2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZTogb2JqZWN0KTogdmFsdWUgaXMgRWRpdG9yU3RhdGUge1xuXHRyZXR1cm4gJ3RleHQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25TdGFydCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvbkVuZCcgaW4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRyZXR1cm4gISF2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnO1xufVxuXG5mdW5jdGlvbiBjbGFtcFNlbGVjdGlvbih2YWx1ZTogbnVtYmVyLCBtYXg6IG51bWJlcikge1xuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4odmFsdWUsIG1heCkpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQYWdlSWQoKSB7XG5cdGlmICh0eXBlb2YgY3J5cHRvICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgY3J5cHRvLnJhbmRvbVVVSUQgPT09ICdmdW5jdGlvbicpIHtcblx0XHRyZXR1cm4gY3J5cHRvLnJhbmRvbVVVSUQoKTtcblx0fVxuXG5cdHJldHVybiBgcGFnZS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKX0tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleDogbnVtYmVyKSB7XG5cdHJldHVybiBgcGFnZS0ke2luZGV4ICsgMX1gO1xufVxuXG5mdW5jdGlvbiByZWFkVGltZXN0YW1wKC4uLnZhbHVlczogdW5rbm93bltdKSB7XG5cdGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCkge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIHJlYWROdWxsYWJsZVRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWU6IHVua25vd24pOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiB2YWx1ZSA9PT0gJ3N5bmNlZCcgfHwgdmFsdWUgPT09ICdwZW5kaW5nX3B1c2gnIHx8IHZhbHVlID09PSAnY29uZmxpY3QnID8gdmFsdWUgOiAnZGlydHknO1xufVxuXG5mdW5jdGlvbiBuZXh0RGlydHlTdGF0dXMoc3RhdHVzOiBQYWdlU3luY1N0YXR1cyk6IFBhZ2VTeW5jU3RhdHVzIHtcblx0cmV0dXJuIHN0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc29ydFBhZ2VzQnlSZWNlbmN5KHBhZ2VzOiBFZGl0b3JQYWdlW10pIHtcblx0cmV0dXJuIFsuLi5wYWdlc10uc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVBhZ2VzQnlSZWNlbmN5KGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LnVwZGF0ZWRBdCAhPT0gcmlnaHQudXBkYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LnVwZGF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQudXBkYXRlZEF0KTtcblx0fVxuXG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgQ291bnRWaXNpYmlsaXR5LCBFZGl0b3JQcmVmZXJlbmNlcywgVGhlbWVNb2RlIH0gZnJvbSAnLi4vY29yZS9wcmVmZXJlbmNlcyc7XG5pbXBvcnQgeyBERUZBVUxUX1BSRUZFUkVOQ0VTLCBub3JtYWxpemVQcmVmZXJlbmNlcyB9IGZyb20gJy4uL2NvcmUvcHJlZmVyZW5jZXMnO1xuaW1wb3J0IHtcblx0Y3JlYXRlUGFnZSxcblx0Y3JlYXRlU2Vzc2lvbixcblx0bm9ybWFsaXplU2Vzc2lvbixcblx0c29ydFBhZ2VzQnlSZWNlbmN5LFxuXHR0eXBlIEVkaXRvclBhZ2UsXG5cdHR5cGUgRWRpdG9yU2Vzc2lvblxufSBmcm9tICcuLi9jb3JlL3Nlc3Npb24nO1xuaW1wb3J0IHtcblx0QU5PTllNT1VTX1VTRVJJRCxcblx0QkxBTktfREJfTkFNRSxcblx0QkxBTktfREJfVkVSU0lPTixcblx0UEFHRVNfU1RPUkVfTkFNRSxcblx0U0VUVElOR1NfU1RPUkVfTkFNRSxcblx0U0VUVElOR19BQ1RJVkVfUEFHRV9JRCxcblx0U0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQsXG5cdFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVELFxuXHRTRVRUSU5HX1RIRU1FLFxuXHRTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSxcblx0VVNFUl9JRF9JTkRFWCxcblx0VVBEQVRFRF9BVF9JTkRFWCxcblx0dHlwZSBQYWdlUmVjb3JkLFxuXHR0eXBlIFNldHRpbmdSZWNvcmRcbn0gZnJvbSAnLi9yZWNvcmRzJztcblxuZXhwb3J0IGNsYXNzIEVkaXRvclN0b3JhZ2Uge1xuXHRwcml2YXRlIHN0YXRpYyBiYWNrZW5kUHJvbWlzZTogUHJvbWlzZTxTdG9yYWdlQmFja2VuZD4gfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzdGF0aWMgbWVtb3J5QmFja2VuZCA9IGNyZWF0ZU1lbW9yeUJhY2tlbmQoKTtcblxuXHRzdGF0aWMgYXN5bmMgc2F2ZUFub255bW91c1N0YXRlKHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRhd2FpdCB0aGlzLnNhdmVVc2VyU3RhdGUoQU5PTllNT1VTX1VTRVJJRCwgc2Vzc2lvbik7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZEFub255bW91c1N0YXRlKCk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbj4ge1xuXHRcdHJldHVybiAoYXdhaXQgdGhpcy5sb2FkVXNlclN0YXRlKEFOT05ZTU9VU19VU0VSSUQpKSA/PyBjcmVhdGVTZXNzaW9uKEFOT05ZTU9VU19VU0VSSUQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIHNhdmVVc2VyU3RhdGUodXNlcklkOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0YXdhaXQgYmFja2VuZC5zYXZlU2Vzc2lvbih1c2VySWQsIHNlc3Npb24pO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRVc2VyU3RhdGUodXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclNlc3Npb24gfCBudWxsPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdHJldHVybiBhd2FpdCBiYWNrZW5kLmxvYWRTZXNzaW9uKHVzZXJJZCk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIHVzZXIgZWRpdG9yIHNlc3Npb246JywgZXJyb3IpO1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRBbm9ueW1vdXNQYWdlKHBhZ2VJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JQYWdlIHwgbnVsbD4ge1xuXHRcdHJldHVybiB0aGlzLmxvYWRVc2VyUGFnZShBTk9OWU1PVVNfVVNFUklELCBwYWdlSWQpO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRVc2VyUGFnZSh1c2VySWQ6IHN0cmluZywgcGFnZUlkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclBhZ2UgfCBudWxsPiB7XG5cdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdHJldHVybiBiYWNrZW5kLmxvYWRQYWdlKHVzZXJJZCwgcGFnZUlkKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkUHJlZmVyZW5jZXModXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IFByb21pc2U8RWRpdG9yUHJlZmVyZW5jZXM+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0Y29uc3QgW3RoZW1lTW9kZSwgY291bnRWaXNpYmlsaXR5LCBzcGVsbGNoZWNrRW5hYmxlZF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG5cdFx0XHRcdGJhY2tlbmQuZ2V0U2V0dGluZzxUaGVtZU1vZGU+KHVzZXJJZCwgU0VUVElOR19USEVNRSksXG5cdFx0XHRcdGJhY2tlbmQuZ2V0U2V0dGluZzxDb3VudFZpc2liaWxpdHk+KHVzZXJJZCwgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFkpLFxuXHRcdFx0XHRiYWNrZW5kLmdldFNldHRpbmc8Ym9vbGVhbj4odXNlcklkLCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRClcblx0XHRcdF0pO1xuXG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplUHJlZmVyZW5jZXMoe1xuXHRcdFx0XHR0aGVtZU1vZGUsXG5cdFx0XHRcdGNvdW50VmlzaWJpbGl0eSxcblx0XHRcdFx0c3BlbGxjaGVja0VuYWJsZWRcblx0XHRcdH0pO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9hZCBlZGl0b3IgcHJlZmVyZW5jZXM6JywgZXJyb3IpO1xuXHRcdFx0cmV0dXJuIERFRkFVTFRfUFJFRkVSRU5DRVM7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIHNhdmVQcmVmZXJlbmNlcyh1c2VySWQ6IHN0cmluZywgcHJlZmVyZW5jZXM6IEVkaXRvclByZWZlcmVuY2VzKSB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdFx0YmFja2VuZC5zZXRTZXR0aW5nKHVzZXJJZCwgU0VUVElOR19USEVNRSwgcHJlZmVyZW5jZXMudGhlbWVNb2RlKSxcblx0XHRcdFx0YmFja2VuZC5zZXRTZXR0aW5nKHVzZXJJZCwgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFksIHByZWZlcmVuY2VzLmNvdW50VmlzaWJpbGl0eSksXG5cdFx0XHRcdGJhY2tlbmQuc2V0U2V0dGluZyh1c2VySWQsIFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVELCBwcmVmZXJlbmNlcy5zcGVsbGNoZWNrRW5hYmxlZClcblx0XHRcdF0pO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gc2F2ZSBlZGl0b3IgcHJlZmVyZW5jZXM6JywgZXJyb3IpO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyBhc3luYyBoYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCh1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRyZXR1cm4gKGF3YWl0IGJhY2tlbmQuZ2V0U2V0dGluZzxib29sZWFuPih1c2VySWQsIFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JUKSkgPT09IHRydWU7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBsb2FkIGFub255bW91cyBpbXBvcnQgcHJvbXB0IHN0YXR1czonLCBlcnJvcik7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIGFzeW5jIG1hcmtQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCh1c2VySWQ6IHN0cmluZykge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRhd2FpdCBiYWNrZW5kLnNldFNldHRpbmcodXNlcklkLCBTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCwgdHJ1ZSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoJ0ZhaWxlZCB0byBzYXZlIGFub255bW91cyBpbXBvcnQgcHJvbXB0IHN0YXR1czonLCBlcnJvcik7XG5cdFx0fVxuXHR9XG5cblx0c3RhdGljIHJlc2V0Rm9yVGVzdHMoKSB7XG5cdFx0dGhpcy5iYWNrZW5kUHJvbWlzZSA9IG51bGw7XG5cdFx0dGhpcy5tZW1vcnlCYWNrZW5kID0gY3JlYXRlTWVtb3J5QmFja2VuZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBzdGF0aWMgYXN5bmMgZ2V0QmFja2VuZCgpOiBQcm9taXNlPFN0b3JhZ2VCYWNrZW5kPiB7XG5cdFx0aWYgKCF0aGlzLmJhY2tlbmRQcm9taXNlKSB7XG5cdFx0XHR0aGlzLmJhY2tlbmRQcm9taXNlID1cblx0XHRcdFx0dHlwZW9mIGluZGV4ZWREQiA9PT0gJ3VuZGVmaW5lZCcgPyBQcm9taXNlLnJlc29sdmUodGhpcy5tZW1vcnlCYWNrZW5kKSA6IGNyZWF0ZUluZGV4ZWREYkJhY2tlbmQoKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gdGhpcy5iYWNrZW5kUHJvbWlzZTtcblx0fVxufVxuXG5pbnRlcmZhY2UgU3RvcmFnZUJhY2tlbmQge1xuXHRzYXZlU2Vzc2lvbih1c2VySWQ6IHN0cmluZywgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IFByb21pc2U8dm9pZD47XG5cdGxvYWRTZXNzaW9uKHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uIHwgbnVsbD47XG5cdGxvYWRQYWdlKHVzZXJJZDogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+O1xuXHRnZXRTZXR0aW5nPFQ+KHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZyk6IFByb21pc2U8VCB8IHVuZGVmaW5lZD47XG5cdHNldFNldHRpbmcodXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bik6IFByb21pc2U8dm9pZD47XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1lbW9yeUJhY2tlbmQoKTogU3RvcmFnZUJhY2tlbmQge1xuXHRjb25zdCBwYWdlcyA9IG5ldyBNYXA8c3RyaW5nLCBQYWdlUmVjb3JkPigpO1xuXHRjb25zdCBzZXR0aW5ncyA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nUmVjb3JkPigpO1xuXG5cdHJldHVybiB7XG5cdFx0YXN5bmMgc2F2ZVNlc3Npb24odXNlcklkOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0XHRcdGNvbnN0IG5leHRLZXlzID0gbmV3IFNldChzZXNzaW9uLnBhZ2VzLm1hcCgocGFnZSkgPT4gYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBwYWdlLmlkKSkpO1xuXHRcdFx0Zm9yIChjb25zdCBrZXkgb2YgWy4uLnBhZ2VzLmtleXMoKV0pIHtcblx0XHRcdFx0aWYgKGtleS5zdGFydHNXaXRoKGAke3VzZXJJZH06OmApICYmICFuZXh0S2V5cy5oYXMoa2V5KSkge1xuXHRcdFx0XHRcdHBhZ2VzLmRlbGV0ZShrZXkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGZvciAoY29uc3QgcGFnZSBvZiBzZXNzaW9uLnBhZ2VzKSB7XG5cdFx0XHRcdHBhZ2VzLnNldChidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIHBhZ2UuaWQpLCB0b1BhZ2VSZWNvcmQocGFnZSwgdXNlcklkKSk7XG5cdFx0XHR9XG5cblx0XHRcdHNldHRpbmdzLnNldChcblx0XHRcdFx0YnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEKSxcblx0XHRcdFx0Y3JlYXRlU2V0dGluZ1JlY29yZCh1c2VySWQsIFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQsIHNlc3Npb24uYWN0aXZlUGFnZUlkKVxuXHRcdFx0KTtcblx0XHR9LFxuXHRcdGFzeW5jIGxvYWRTZXNzaW9uKHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB1c2VyUGFnZXMgPSBzb3J0UGFnZXNCeVJlY2VuY3koXG5cdFx0XHRcdFsuLi5wYWdlcy52YWx1ZXMoKV0uZmlsdGVyKChwYWdlKSA9PiBwYWdlLnVzZXJJZCA9PT0gdXNlcklkKS5tYXAoKHBhZ2UpID0+IHRvRWRpdG9yUGFnZShwYWdlKSlcblx0XHRcdCk7XG5cblx0XHRcdGlmICh1c2VyUGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBhY3RpdmVQYWdlSWQgPSBzZXR0aW5ncy5nZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEKSk/LnZhbHVlO1xuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZVNlc3Npb24oXG5cdFx0XHRcdHsgcGFnZXM6IHVzZXJQYWdlcywgYWN0aXZlUGFnZUlkOiB0eXBlb2YgYWN0aXZlUGFnZUlkID09PSAnc3RyaW5nJyA/IGFjdGl2ZVBhZ2VJZCA6IHVzZXJQYWdlc1swXS5pZCB9LFxuXHRcdFx0XHR1c2VySWRcblx0XHRcdCk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkUGFnZSh1c2VySWQ6IHN0cmluZywgcGFnZUlkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHBhZ2UgPSBwYWdlcy5nZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBwYWdlSWQpKTtcblx0XHRcdHJldHVybiBwYWdlID8gdG9FZGl0b3JQYWdlKHBhZ2UpIDogbnVsbDtcblx0XHR9LFxuXHRcdGFzeW5jIGdldFNldHRpbmc8VD4odXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nKSB7XG5cdFx0XHRyZXR1cm4gc2V0dGluZ3MuZ2V0KGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwga2V5KSk/LnZhbHVlIGFzIFQgfCB1bmRlZmluZWQ7XG5cdFx0fSxcblx0XHRhc3luYyBzZXRTZXR0aW5nKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcblx0XHRcdHNldHRpbmdzLnNldChidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIGtleSksIGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkLCBrZXksIHZhbHVlKSk7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVJbmRleGVkRGJCYWNrZW5kKCk6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHtcblx0Y29uc3QgZGIgPSBhd2FpdCBvcGVuRGF0YWJhc2UoKTtcblxuXHRyZXR1cm4ge1xuXHRcdGFzeW5jIHNhdmVTZXNzaW9uKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFtQQUdFU19TVE9SRV9OQU1FLCBTRVRUSU5HU19TVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0Y29uc3QgcGFnZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKFBBR0VTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3Qgc2V0dGluZ3NTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKFNFVFRJTkdTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgdXNlckluZGV4ID0gcGFnZXNTdG9yZS5pbmRleChVU0VSX0lEX0lOREVYKTtcblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVxdWVzdFRvUHJvbWlzZTxQYWdlUmVjb3JkW10+KHVzZXJJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seSh1c2VySWQpKSk7XG5cdFx0XHRjb25zdCBuZXh0SWRzID0gbmV3IFNldChzZXNzaW9uLnBhZ2VzLm1hcCgocGFnZSkgPT4gcGFnZS5pZCkpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IHBhZ2Ugb2YgZXhpc3RpbmcpIHtcblx0XHRcdFx0aWYgKCFuZXh0SWRzLmhhcyhwYWdlLmlkKSkge1xuXHRcdFx0XHRcdHBhZ2VzU3RvcmUuZGVsZXRlKFt1c2VySWQsIHBhZ2UuaWRdKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IHBhZ2Ugb2Ygc2Vzc2lvbi5wYWdlcykge1xuXHRcdFx0XHRwYWdlc1N0b3JlLnB1dCh0b1BhZ2VSZWNvcmQocGFnZSwgdXNlcklkKSk7XG5cdFx0XHR9XG5cblx0XHRcdHNldHRpbmdzU3RvcmUucHV0KGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lELCBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCkpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdH0sXG5cdFx0YXN5bmMgbG9hZFNlc3Npb24odXNlcklkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oW1BBR0VTX1NUT1JFX05BTUUsIFNFVFRJTkdTX1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IHBhZ2VzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShQQUdFU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHNldHRpbmdzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHVwZGF0ZWRBdEluZGV4ID0gcGFnZXNTdG9yZS5pbmRleChVUERBVEVEX0FUX0lOREVYKTtcblxuXHRcdFx0Y29uc3QgW3BhZ2VzLCBhY3RpdmVQYWdlU2V0dGluZ10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG5cdFx0XHRcdHJlYWRQYWdlc0J5VXBkYXRlZEF0RGVzYyh1cGRhdGVkQXRJbmRleCwgdXNlcklkKSxcblx0XHRcdFx0cmVxdWVzdFRvUHJvbWlzZTxTZXR0aW5nUmVjb3JkIHwgdW5kZWZpbmVkPihzZXR0aW5nc1N0b3JlLmdldChbdXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEXSkpXG5cdFx0XHRdKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblxuXHRcdFx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZVNlc3Npb24oXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwYWdlczogcGFnZXMubWFwKChwYWdlKSA9PiB0b0VkaXRvclBhZ2UocGFnZSkpLFxuXHRcdFx0XHRcdGFjdGl2ZVBhZ2VJZDpcblx0XHRcdFx0XHRcdHR5cGVvZiBhY3RpdmVQYWdlU2V0dGluZz8udmFsdWUgPT09ICdzdHJpbmcnID8gYWN0aXZlUGFnZVNldHRpbmcudmFsdWUgOiBwYWdlc1swXSEuaWRcblx0XHRcdFx0fSxcblx0XHRcdFx0dXNlcklkXG5cdFx0XHQpO1xuXHRcdH0sXG5cdFx0YXN5bmMgbG9hZFBhZ2UodXNlcklkOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFBBR0VTX1NUT1JFX05BTUUsICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3QgcGFnZSA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8UGFnZVJlY29yZCB8IHVuZGVmaW5lZD4oXG5cdFx0XHRcdHR4Lm9iamVjdFN0b3JlKFBBR0VTX1NUT1JFX05BTUUpLmdldChbdXNlcklkLCBwYWdlSWRdKVxuXHRcdFx0KTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHRcdHJldHVybiBwYWdlID8gdG9FZGl0b3JQYWdlKHBhZ2UpIDogbnVsbDtcblx0XHR9LFxuXHRcdGFzeW5jIGdldFNldHRpbmc8VD4odXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFNFVFRJTkdTX1NUT1JFX05BTUUsICdyZWFkb25seScpO1xuXHRcdFx0Y29uc3Qgc2V0dGluZyA9IGF3YWl0IHJlcXVlc3RUb1Byb21pc2U8U2V0dGluZ1JlY29yZCB8IHVuZGVmaW5lZD4oXG5cdFx0XHRcdHR4Lm9iamVjdFN0b3JlKFNFVFRJTkdTX1NUT1JFX05BTUUpLmdldChbdXNlcklkLCBrZXldKVxuXHRcdFx0KTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHRcdHJldHVybiBzZXR0aW5nPy52YWx1ZSBhcyBUIHwgdW5kZWZpbmVkO1xuXHRcdH0sXG5cdFx0YXN5bmMgc2V0U2V0dGluZyh1c2VySWQ6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFNFVFRJTkdTX1NUT1JFX05BTUUsICdyZWFkd3JpdGUnKTtcblx0XHRcdHR4Lm9iamVjdFN0b3JlKFNFVFRJTkdTX1NUT1JFX05BTUUpLnB1dChjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZCwga2V5LCB2YWx1ZSkpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdH1cblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gb3BlbkRhdGFiYXNlKCk6IFByb21pc2U8SURCRGF0YWJhc2U+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oQkxBTktfREJfTkFNRSwgQkxBTktfREJfVkVSU0lPTik7XG5cblx0XHRyZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9ICgpID0+IHtcblx0XHRcdGNvbnN0IGRiID0gcmVxdWVzdC5yZXN1bHQ7XG5cdFx0XHRpZiAoIWRiLm9iamVjdFN0b3JlTmFtZXMuY29udGFpbnMoUEFHRVNfU1RPUkVfTkFNRSkpIHtcblx0XHRcdFx0Y29uc3QgcGFnZXNTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKFBBR0VTX1NUT1JFX05BTUUsIHtcblx0XHRcdFx0XHRrZXlQYXRoOiBbJ3VzZXJJZCcsICdpZCddXG5cdFx0XHRcdH0pO1xuXHRcdFx0cGFnZXNTdG9yZS5jcmVhdGVJbmRleChVU0VSX0lEX0lOREVYLCAndXNlcklkJywgeyB1bmlxdWU6IGZhbHNlIH0pO1xuXHRcdFx0XHRwYWdlc1N0b3JlLmNyZWF0ZUluZGV4KFVQREFURURfQVRfSU5ERVgsIFsndXNlcklkJywgJ3VwZGF0ZWRBdCddLCB7IHVuaXF1ZTogZmFsc2UgfSk7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhTRVRUSU5HU19TVE9SRV9OQU1FKSkge1xuXHRcdFx0XHRjb25zdCBzZXR0aW5nc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoU0VUVElOR1NfU1RPUkVfTkFNRSwge1xuXHRcdFx0XHRcdGtleVBhdGg6IFsndXNlcklkJywgJ2tleSddXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRzZXR0aW5nc1N0b3JlLmNyZWF0ZUluZGV4KFVTRVJfSURfSU5ERVgsICd1c2VySWQnLCB7IHVuaXF1ZTogZmFsc2UgfSk7XG5cdFx0XHR9XG5cdFx0fTtcblxuXHRcdHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XG5cdFx0cmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb21wb3NpdGVLZXkobGVmdDogc3RyaW5nLCByaWdodDogc3RyaW5nKSB7XG5cdHJldHVybiBgJHtsZWZ0fTo6JHtyaWdodH1gO1xufVxuXG5mdW5jdGlvbiB0b1BhZ2VSZWNvcmQocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkOiBzdHJpbmcpOiBQYWdlUmVjb3JkIHtcblx0cmV0dXJuIHtcblx0XHRpZDogcGFnZS5pZCxcblx0XHR1c2VySWQsXG5cdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwYWdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZDogcGFnZS5zZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0OiBwYWdlLmNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IHBhZ2UudXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiBwYWdlLmxhc3RTeW5jZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHBhZ2UubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcGFnZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogcGFnZS5zeW5jU3RhdHVzLFxuXHRcdGlzRXBoZW1lcmFsOiBwYWdlLmlzRXBoZW1lcmFsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHRvRWRpdG9yUGFnZShwYWdlOiBQYWdlUmVjb3JkKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IG5leHRQYWdlID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHtcblx0XHRpZDogcGFnZS5pZCxcblx0XHR1c2VySWQ6IHBhZ2UudXNlcklkLFxuXHRcdG5vdzogcGFnZS5jcmVhdGVkQXQsXG5cdFx0aXNFcGhlbWVyYWw6IHBhZ2UuaXNFcGhlbWVyYWxcblx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5uZXh0UGFnZSxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwYWdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZDogcGFnZS5zZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0OiBwYWdlLmNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IHBhZ2UudXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiBwYWdlLmxhc3RTeW5jZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHBhZ2UubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcGFnZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogcGFnZS5zeW5jU3RhdHVzLFxuXHRcdGlzRXBoZW1lcmFsOiBwYWdlLmlzRXBoZW1lcmFsXG5cdH07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bik6IFNldHRpbmdSZWNvcmQge1xuXHRyZXR1cm4ge1xuXHRcdHVzZXJJZCxcblx0XHRrZXksXG5cdFx0dmFsdWUsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcblx0fTtcbn1cblxuZnVuY3Rpb24gcmVhZFBhZ2VzQnlVcGRhdGVkQXREZXNjKGluZGV4OiBJREJJbmRleCwgdXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPFBhZ2VSZWNvcmRbXT4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGNvbnN0IHBhZ2VzOiBQYWdlUmVjb3JkW10gPSBbXTtcblx0XHRjb25zdCByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFt1c2VySWQsICcnXSwgW3VzZXJJZCwgJ1xcdWZmZmYnXSk7XG5cdFx0Y29uc3QgcmVxdWVzdCA9IGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UsICdwcmV2Jyk7XG5cblx0XHRyZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcblx0XHRcdGNvbnN0IGN1cnNvciA9IHJlcXVlc3QucmVzdWx0O1xuXHRcdFx0aWYgKCFjdXJzb3IpIHtcblx0XHRcdFx0cmVzb2x2ZShwYWdlcyk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0cGFnZXMucHVzaChjdXJzb3IudmFsdWUgYXMgUGFnZVJlY29yZCk7XG5cdFx0XHRjdXJzb3IuY29udGludWUoKTtcblx0XHR9O1xuXG5cdFx0cmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvUHJvbWlzZTxUPihyZXF1ZXN0OiBJREJSZXF1ZXN0PFQ+KTogUHJvbWlzZTxUPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiB0cmFuc2FjdGlvblRvUHJvbWlzZSh0cmFuc2FjdGlvbjogSURCVHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHR0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gcmVzb2x2ZSgpO1xuXHRcdHRyYW5zYWN0aW9uLm9uZXJyb3IgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuXHRcdHRyYW5zYWN0aW9uLm9uYWJvcnQgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IgPz8gbmV3IEVycm9yKCdJbmRleGVkREIgdHJhbnNhY3Rpb24gYWJvcnRlZCcpKTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDUVosSUFBTSxzQkFBeUM7QUFBQSxFQUNyRCxXQUFXO0FBQUEsRUFDWCxtQkFBbUI7QUFBQSxFQUNuQixpQkFBaUI7QUFDbEI7QUFFQSxJQUFNLHlCQUE0QyxDQUFDLFVBQVUsUUFBUSxRQUFRO0FBRXRFLFNBQVMscUJBQXFCLE9BQW1DO0FBQ3ZFLE1BQUksQ0FBQyxTQUFTLE9BQU8sVUFBVSxVQUFVO0FBQ3hDLFdBQU87QUFBQSxFQUNSO0FBRUEsUUFBTSxZQUFZO0FBRWxCLFNBQU87QUFBQSxJQUNOLFdBQVcsVUFBVSxjQUFjLFNBQVMsU0FBUztBQUFBLElBQ3JELG1CQUNDLE9BQU8sVUFBVSxzQkFBc0IsWUFDcEMsVUFBVSxvQkFDVixvQkFBb0I7QUFBQSxJQUN4QixpQkFBaUIsdUJBQXVCLFNBQVMsVUFBVSxlQUFrQyxJQUN6RixVQUFVLGtCQUNYLG9CQUFvQjtBQUFBLEVBQ3hCO0FBQ0Q7OztBQ2xDTyxJQUFNLGdCQUFnQjtBQUN0QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLHNCQUFzQjtBQUM1QixJQUFNLGdCQUFnQjtBQUN0QixJQUFNLG1CQUFtQjtBQUV6QixJQUFNLG1CQUFtQjtBQTRCekIsSUFBTSx5QkFBeUI7QUFDL0IsSUFBTSxnQkFBZ0I7QUFDdEIsSUFBTSxnQ0FBZ0M7QUFDdEMsSUFBTSw2QkFBNkI7QUFDbkMsSUFBTSw0Q0FBNEM7OztBQ3pCbEQsSUFBTSxnQkFB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
