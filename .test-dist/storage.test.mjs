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
var NOTES_STORE_NAME = "notes";
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
    syncStatus: "dirty"
  };
}
function createSession(userId = ANONYMOUS_USERID) {
  const page = createPage("", { userId });
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
    syncStatus: nextDirtyStatus(page.syncStatus)
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
  const page = updatePageState(createPage(state.text, { userId }), state);
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
    syncStatus: normalizeSyncStatus(value.syncStatus)
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
  return `note-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
function createFallbackPageId(index) {
  return `note-${index + 1}`;
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
  const notes = /* @__PURE__ */ new Map();
  const settings = /* @__PURE__ */ new Map();
  return {
    async saveSession(userId, session) {
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
    async loadSession(userId) {
      const userNotes = [...notes.values()].filter((note) => note.userId === userId).sort(compareNotes).map((note) => toEditorPage(note));
      if (userNotes.length === 0) {
        return null;
      }
      const activePageId = settings.get(buildCompositeKey(userId, SETTING_ACTIVE_PAGE_ID))?.value;
      return normalizeSession(
        { pages: userNotes, activePageId: typeof activePageId === "string" ? activePageId : userNotes[0].id },
        userId
      );
    },
    async loadPage(userId, pageId) {
      const note = notes.get(buildCompositeKey(userId, pageId));
      return note ? toEditorPage(note) : null;
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
      const tx = db.transaction([NOTES_STORE_NAME, SETTINGS_STORE_NAME], "readwrite");
      const notesStore = tx.objectStore(NOTES_STORE_NAME);
      const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
      const userIndex = notesStore.index(USER_ID_INDEX);
      const existing = await requestToPromise(userIndex.getAll(IDBKeyRange.only(userId)));
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
    async loadSession(userId) {
      const tx = db.transaction([NOTES_STORE_NAME, SETTINGS_STORE_NAME], "readonly");
      const notesStore = tx.objectStore(NOTES_STORE_NAME);
      const settingsStore = tx.objectStore(SETTINGS_STORE_NAME);
      const userIndex = notesStore.index(USER_ID_INDEX);
      const [notes, activePageSetting] = await Promise.all([
        requestToPromise(userIndex.getAll(IDBKeyRange.only(userId))),
        requestToPromise(settingsStore.get([userId, SETTING_ACTIVE_PAGE_ID]))
      ]);
      await transactionToPromise(tx);
      if (notes.length === 0) {
        return null;
      }
      return normalizeSession(
        {
          pages: notes.sort(compareNotes).map((note) => toEditorPage(note)),
          activePageId: typeof activePageSetting?.value === "string" ? activePageSetting.value : notes[0].id
        },
        userId
      );
    },
    async loadPage(userId, pageId) {
      const tx = db.transaction(NOTES_STORE_NAME, "readonly");
      const note = await requestToPromise(
        tx.objectStore(NOTES_STORE_NAME).get([userId, pageId])
      );
      await transactionToPromise(tx);
      return note ? toEditorPage(note) : null;
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
      if (!db.objectStoreNames.contains(NOTES_STORE_NAME)) {
        const notesStore = db.createObjectStore(NOTES_STORE_NAME, {
          keyPath: ["userId", "id"]
        });
        notesStore.createIndex(USER_ID_INDEX, "userId", { unique: false });
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
function toNoteRecord(page, userId) {
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
function toEditorPage(note) {
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
function createSettingRecord(userId, key, value) {
  return {
    userId,
    key,
    value,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function compareNotes(left, right) {
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
  const pageA = createPage("alpha", { id: "page-a", userId, now: "2026-04-14T00:00:00.000Z" });
  pageA.title = "A";
  pageA.updatedAt = "2026-04-14T00:00:00.000Z";
  const pageB = createPage("beta", { id: "page-b", userId, now: "2026-04-15T00:00:00.000Z" });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3RvcmFnZS50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvcmUvcHJlZmVyZW5jZXMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IERFRkFVTFRfUFJFRkVSRU5DRVMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3ByZWZlcmVuY2VzLnRzJztcbmltcG9ydCB7IGNyZWF0ZVBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL2NvcmUvc2Vzc2lvbi50cyc7XG5pbXBvcnQgeyBFZGl0b3JTdG9yYWdlIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2Uvc3RvcmFnZS50cyc7XG5pbXBvcnQgeyBBTk9OWU1PVVNfVVNFUklEIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbmZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkOiBzdHJpbmcsIGFjdGl2ZVBhZ2VJZCA9ICdwYWdlLWEnKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2VBID0gY3JlYXRlUGFnZSgnYWxwaGEnLCB7IGlkOiAncGFnZS1hJywgdXNlcklkLCBub3c6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonIH0pO1xuXHRwYWdlQS50aXRsZSA9ICdBJztcblx0cGFnZUEudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWic7XG5cblx0Y29uc3QgcGFnZUIgPSBjcmVhdGVQYWdlKCdiZXRhJywgeyBpZDogJ3BhZ2UtYicsIHVzZXJJZCwgbm93OiAnMjAyNi0wNC0xNVQwMDowMDowMC4wMDBaJyB9KTtcblx0cGFnZUIudGl0bGUgPSAnQic7XG5cdHBhZ2VCLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE1VDAwOjAwOjAwLjAwMFonO1xuXG5cdHJldHVybiB7XG5cdFx0YWN0aXZlUGFnZUlkLFxuXHRcdHBhZ2VzOiBbcGFnZUEsIHBhZ2VCXVxuXHR9O1xufVxuXG50ZXN0LmJlZm9yZUVhY2goKCkgPT4ge1xuXHRFZGl0b3JTdG9yYWdlLnJlc2V0Rm9yVGVzdHMoKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHNhdmVzIGFuZCBsb2FkcyBhbm9ueW1vdXMgc3RhdGUgdGhyb3VnaCB0aGUgYmxhbmsgZGF0YWJhc2Ugc2hhcGUnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKEFOT05ZTU9VU19VU0VSSUQsICdwYWdlLWInKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLnNhdmVBbm9ueW1vdXNTdGF0ZShzZXNzaW9uKTtcblxuXHRjb25zdCBsb2FkZWQgPSBhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRBbm9ueW1vdXNTdGF0ZSgpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLnBhZ2VzLmxlbmd0aCwgc2Vzc2lvbi5wYWdlcy5sZW5ndGgpO1xuXHRhc3NlcnQuZXF1YWwobG9hZGVkLnBhZ2VzWzBdPy51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Ugc2F2ZXMgYW5kIGxvYWRzIHVzZXItc2NvcGVkIHN0YXRlIHNlcGFyYXRlbHkgcGVyIGFjY291bnQnLCBhc3luYyAoKSA9PiB7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVVzZXJTdGF0ZSgndXNlci1hJywgY3JlYXRlU2Vzc2lvbigndXNlci1hJywgJ3BhZ2UtYScpKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlVXNlclN0YXRlKCd1c2VyLWInLCBjcmVhdGVTZXNzaW9uKCd1c2VyLWInLCAncGFnZS1iJykpO1xuXG5cdGFzc2VydC5lcXVhbCgoYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkVXNlclN0YXRlKCd1c2VyLWEnKSk/LmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYScpO1xuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1iJykpPy5hY3RpdmVQYWdlSWQsICdwYWdlLWInKTtcblx0YXNzZXJ0LmVxdWFsKChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRVc2VyU3RhdGUoJ3VzZXItYScpKT8ucGFnZXNbMF0/LnVzZXJJZCwgJ3VzZXItYScpO1xuXHRhc3NlcnQuZXF1YWwoKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJTdGF0ZSgndXNlci1iJykpPy5wYWdlc1swXT8udXNlcklkLCAndXNlci1iJyk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSBsb2FkcyBhIHNpbmdsZSBwYWdlIHdpdGhvdXQgcmVxdWlyaW5nIGZ1bGwgc2Vzc2lvbiBjb25zdW1lcnMnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnLCAncGFnZS1hJyk7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVVzZXJTdGF0ZSgndXNlci1hJywgc2Vzc2lvbik7XG5cblx0Y29uc3QgcGFnZSA9IGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFVzZXJQYWdlKCd1c2VyLWEnLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlPy5pZCwgJ3BhZ2UtYicpO1xuXHRhc3NlcnQuZXF1YWwocGFnZT8uY29udGVudCwgJ2JldGEnKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2U/LnVzZXJJZCwgJ3VzZXItYScpO1xufSk7XG5cbnRlc3QoJ0VkaXRvclN0b3JhZ2Uga2VlcHMgcGFnZSBsb29rdXBzIGluIHN5bmMgYWZ0ZXIgaGFyZCByZW1vdmFscyBhcmUgc2F2ZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKEFOT05ZTU9VU19VU0VSSUQsICdwYWdlLWEnKTtcblx0YXdhaXQgRWRpdG9yU3RvcmFnZS5zYXZlQW5vbnltb3VzU3RhdGUoc2Vzc2lvbik7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZUFub255bW91c1N0YXRlKHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWEnLFxuXHRcdHBhZ2VzOiBbc2Vzc2lvbi5wYWdlc1swXSFdXG5cdH0pO1xuXG5cdGNvbnN0IGRlbGV0ZWRQYWdlID0gYXdhaXQgRWRpdG9yU3RvcmFnZS5sb2FkQW5vbnltb3VzUGFnZSgncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChkZWxldGVkUGFnZSwgbnVsbCk7XG59KTtcblxudGVzdCgnRWRpdG9yU3RvcmFnZSByZXR1cm5zIGRlZmF1bHQgcHJlZmVyZW5jZXMgd2hlbiBubyBzZXR0aW5ncyBhcmUgc3RvcmVkJywgYXN5bmMgKCkgPT4ge1xuXHRhc3NlcnQuZGVlcEVxdWFsKGF3YWl0IEVkaXRvclN0b3JhZ2UubG9hZFByZWZlcmVuY2VzKEFOT05ZTU9VU19VU0VSSUQpLCBERUZBVUxUX1BSRUZFUkVOQ0VTKTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHNhdmVzIGFuZCBsb2FkcyBwcmVmZXJlbmNlcyB0aHJvdWdoIHNldHRpbmdzIHJlY29yZHMnLCBhc3luYyAoKSA9PiB7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2Uuc2F2ZVByZWZlcmVuY2VzKCd1c2VyLWEnLCB7XG5cdFx0dGhlbWVNb2RlOiAnZGFyaycsXG5cdFx0c3BlbGxjaGVja0VuYWJsZWQ6IGZhbHNlLFxuXHRcdGNvdW50VmlzaWJpbGl0eTogJ3Bpbm5lZCdcblx0fSk7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChhd2FpdCBFZGl0b3JTdG9yYWdlLmxvYWRQcmVmZXJlbmNlcygndXNlci1hJyksIHtcblx0XHR0aGVtZU1vZGU6ICdkYXJrJyxcblx0XHRzcGVsbGNoZWNrRW5hYmxlZDogZmFsc2UsXG5cdFx0Y291bnRWaXNpYmlsaXR5OiAncGlubmVkJ1xuXHR9KTtcbn0pO1xuXG50ZXN0KCdFZGl0b3JTdG9yYWdlIHRyYWNrcyB3aGV0aGVyIGFuIGFjY291bnQgaGFzIGJlZW4gcHJvbXB0ZWQgdG8gaW1wb3J0IGFub255bW91cyBkYXRhJywgYXN5bmMgKCkgPT4ge1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCgndXNlci1hJyksIGZhbHNlKTtcblxuXHRhd2FpdCBFZGl0b3JTdG9yYWdlLm1hcmtQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCgndXNlci1hJyk7XG5cdGF3YWl0IEVkaXRvclN0b3JhZ2UubWFya1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0KCd1c2VyLWEnKTtcblxuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCgndXNlci1hJyksIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgRWRpdG9yU3RvcmFnZS5oYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCgndXNlci1iJyksIGZhbHNlKTtcbn0pO1xuIiwgImV4cG9ydCB0eXBlIFRoZW1lTW9kZSA9ICdsaWdodCcgfCAnZGFyayc7XG5leHBvcnQgdHlwZSBDb3VudFZpc2liaWxpdHkgPSAncGlubmVkJyB8ICdhdXRvJyB8ICdoaWRkZW4nO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclByZWZlcmVuY2VzIHtcblx0dGhlbWVNb2RlOiBUaGVtZU1vZGU7XG5cdHNwZWxsY2hlY2tFbmFibGVkOiBib29sZWFuO1xuXHRjb3VudFZpc2liaWxpdHk6IENvdW50VmlzaWJpbGl0eTtcbn1cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfUFJFRkVSRU5DRVM6IEVkaXRvclByZWZlcmVuY2VzID0ge1xuXHR0aGVtZU1vZGU6ICdsaWdodCcsXG5cdHNwZWxsY2hlY2tFbmFibGVkOiB0cnVlLFxuXHRjb3VudFZpc2liaWxpdHk6ICdhdXRvJ1xufTtcblxuY29uc3QgQ09VTlRfVklTSUJJTElUWV9PUkRFUjogQ291bnRWaXNpYmlsaXR5W10gPSBbJ3Bpbm5lZCcsICdhdXRvJywgJ2hpZGRlbiddO1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUHJlZmVyZW5jZXModmFsdWU6IHVua25vd24pOiBFZGl0b3JQcmVmZXJlbmNlcyB7XG5cdGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuXHRcdHJldHVybiBERUZBVUxUX1BSRUZFUkVOQ0VTO1xuXHR9XG5cblx0Y29uc3QgY2FuZGlkYXRlID0gdmFsdWUgYXMgUGFydGlhbDxFZGl0b3JQcmVmZXJlbmNlcz47XG5cblx0cmV0dXJuIHtcblx0XHR0aGVtZU1vZGU6IGNhbmRpZGF0ZS50aGVtZU1vZGUgPT09ICdkYXJrJyA/ICdkYXJrJyA6ICdsaWdodCcsXG5cdFx0c3BlbGxjaGVja0VuYWJsZWQ6XG5cdFx0XHR0eXBlb2YgY2FuZGlkYXRlLnNwZWxsY2hlY2tFbmFibGVkID09PSAnYm9vbGVhbidcblx0XHRcdFx0PyBjYW5kaWRhdGUuc3BlbGxjaGVja0VuYWJsZWRcblx0XHRcdFx0OiBERUZBVUxUX1BSRUZFUkVOQ0VTLnNwZWxsY2hlY2tFbmFibGVkLFxuXHRcdGNvdW50VmlzaWJpbGl0eTogQ09VTlRfVklTSUJJTElUWV9PUkRFUi5pbmNsdWRlcyhjYW5kaWRhdGUuY291bnRWaXNpYmlsaXR5IGFzIENvdW50VmlzaWJpbGl0eSlcblx0XHRcdD8gKGNhbmRpZGF0ZS5jb3VudFZpc2liaWxpdHkgYXMgQ291bnRWaXNpYmlsaXR5KVxuXHRcdFx0OiBERUZBVUxUX1BSRUZFUkVOQ0VTLmNvdW50VmlzaWJpbGl0eVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3ljbGVDb3VudFZpc2liaWxpdHkodmFsdWU6IENvdW50VmlzaWJpbGl0eSk6IENvdW50VmlzaWJpbGl0eSB7XG5cdGNvbnN0IGN1cnJlbnRJbmRleCA9IENPVU5UX1ZJU0lCSUxJVFlfT1JERVIuaW5kZXhPZih2YWx1ZSk7XG5cdHJldHVybiBDT1VOVF9WSVNJQklMSVRZX09SREVSWyhjdXJyZW50SW5kZXggKyAxKSAlIENPVU5UX1ZJU0lCSUxJVFlfT1JERVIubGVuZ3RoXSE7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDb3VudFZpc2liaWxpdHlMYWJlbCh2YWx1ZTogQ291bnRWaXNpYmlsaXR5KTogc3RyaW5nIHtcblx0c3dpdGNoICh2YWx1ZSkge1xuXHRcdGNhc2UgJ3Bpbm5lZCc6XG5cdFx0XHRyZXR1cm4gJ0NvdW50IHBpbm5lZCc7XG5cdFx0Y2FzZSAnaGlkZGVuJzpcblx0XHRcdHJldHVybiAnQ291bnQgaGlkZGVuJztcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuICdDb3VudCBzaG93bic7XG5cdH1cbn1cbiIsICJleHBvcnQgY29uc3QgQkxBTktfREJfTkFNRSA9ICdibGFuayc7XG5leHBvcnQgY29uc3QgQkxBTktfREJfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgTk9URVNfU1RPUkVfTkFNRSA9ICdub3Rlcyc7XG5leHBvcnQgY29uc3QgU0VUVElOR1NfU1RPUkVfTkFNRSA9ICdzZXR0aW5ncyc7XG5leHBvcnQgY29uc3QgVVNFUl9JRF9JTkRFWCA9ICd1c2VySWQnO1xuXG5leHBvcnQgY29uc3QgQU5PTllNT1VTX1VTRVJJRCA9ICdhbm9ueW1vdXMnO1xuXG5leHBvcnQgdHlwZSBOb3RlU3luY1N0YXR1cyA9ICdzeW5jZWQnIHwgJ2RpcnR5JyB8ICdwZW5kaW5nX3B1c2gnIHwgJ2NvbmZsaWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBOb3RlUmVjb3JkIHtcblx0aWQ6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdHN5bmNTdGF0dXM6IE5vdGVTeW5jU3RhdHVzO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmcgfCBudWxsO1xuXHR2YWx1ZTogdW5rbm93bjtcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEID0gJ2FjdGl2ZVBhZ2VJZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19USEVNRSA9ICd0aGVtZSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFkgPSAnd29yZENvdW50VmlzaWJpbGl0eSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQgPSAnc3BlbGxjaGVja0VuYWJsZWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JUID0gJ2hhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0JztcbiIsICJpbXBvcnQgdHlwZSB7IEVkaXRvclN0YXRlIH0gZnJvbSAnLi4vYmFzaWMvaGlzdG9yeSc7XG5pbXBvcnQge1xuXHRBTk9OWU1PVVNfVVNFUklELFxuXHR0eXBlIE5vdGVSZWNvcmQsXG5cdHR5cGUgTm90ZVN5bmNTdGF0dXNcbn0gZnJvbSAnLi4vcGVyc2lzdGVuY2UvcmVjb3Jkcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlLCBOb3RlUmVjb3JkIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yU2Vzc2lvbiB7XG5cdHBhZ2VzOiBFZGl0b3JQYWdlW107XG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgVU5USVRMRURfUEFHRSA9ICdVbnRpdGxlZCc7XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVQYWdlVGl0bGUoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZmlyc3RMaW5lID0gY29udGVudFxuXHRcdC5zcGxpdCgnXFxuJylcblx0XHQubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcblx0XHQuZmluZCgobGluZSkgPT4gbGluZS5sZW5ndGggPiAwKTtcblxuXHRpZiAoIWZpcnN0TGluZSkge1xuXHRcdHJldHVybiBVTlRJVExFRF9QQUdFO1xuXHR9XG5cblx0cmV0dXJuIGZpcnN0TGluZS5yZXBsYWNlKC9cXHMrL2csICcgJykuc2xpY2UoMCwgNDgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUGFnZShcblx0Y29udGVudCA9ICcnLFxuXHRvcHRpb25zOiB7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0dXNlcklkPzogc3RyaW5nO1xuXHRcdG5vdz86IHN0cmluZztcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgnJywgeyB1c2VySWQgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRpZiAoc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLnBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlVGl0bGUocGFnZTogRWRpdG9yUGFnZSwgdGl0bGU6IHN0cmluZyk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0cmltbWVkID0gdGl0bGUudHJpbSgpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dGl0bGU6IHRyaW1tZWQubGVuZ3RoID4gMCA/IHRyaW1tZWQuc2xpY2UoMCwgNDgpIDogVU5USVRMRURfUEFHRSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5jbG9uZWQsXG5cdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdHRleHQ6IHBhZ2UuY29udGVudCxcblx0XHRkZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHRcdC5zb3J0KGNvbXBhcmVQYWdlcyk7XG5cblx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKHVzZXJJZCk7XG5cdH1cblxuXHRjb25zdCBhY3RpdmVQYWdlSWQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5hY3RpdmVQYWdlSWQgPT09ICdzdHJpbmcnICYmXG5cdFx0cGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gdmFsdWUuYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKVxuXHRcdFx0PyB2YWx1ZS5hY3RpdmVQYWdlSWRcblx0XHRcdDogKHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKT8uaWQgPz8gcGFnZXNbMF0uaWQpO1xuXG5cdHJldHVybiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UoeyBwYWdlcywgYWN0aXZlUGFnZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUxlZ2FjeVN0YXRlKHN0YXRlOiBFZGl0b3JTdGF0ZSwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGNyZWF0ZVBhZ2Uoc3RhdGUudGV4dCwgeyB1c2VySWQgfSksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2UgfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jb250ZW50ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5jb250ZW50XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLnRleHRcblx0XHRcdFx0OiAnJztcblx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xuXHRjb25zdCBzZWxlY3Rpb25TdGFydCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25TdGFydCA6IDAsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IHNlbGVjdGlvbkVuZCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uRW5kIDogc2VsZWN0aW9uU3RhcnQsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUuY3JlYXRlZEF0LCB2YWx1ZS5jcmVhdGVkX2F0KTtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS51cGRhdGVkQXQsIHZhbHVlLnVwZGF0ZWRfYXQpID8/IGNyZWF0ZWRBdDtcblx0Y29uc3QgZGVsZXRlZEF0ID0gcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmRlbGV0ZWRBdCwgdmFsdWUuZGVsZXRlZF9hdCk7XG5cblx0cmV0dXJuIHtcblx0XHRpZDogdHlwZW9mIHZhbHVlLmlkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5pZC5sZW5ndGggPiAwID8gdmFsdWUuaWQgOiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleCksXG5cdFx0dXNlcklkOiB0eXBlb2YgdmFsdWUudXNlcklkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51c2VySWQubGVuZ3RoID4gMCA/IHZhbHVlLnVzZXJJZCA6IHVzZXJJZCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0U3luY2VkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0KSxcblx0XHRzeW5jU3RhdHVzOiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYG5vdGUtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYG5vdGUtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogTm90ZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogTm90ZVN5bmNTdGF0dXMpOiBOb3RlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gY29tcGFyZVBhZ2VzKGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgQ291bnRWaXNpYmlsaXR5LCBFZGl0b3JQcmVmZXJlbmNlcywgVGhlbWVNb2RlIH0gZnJvbSAnLi4vY29yZS9wcmVmZXJlbmNlcyc7XG5pbXBvcnQgeyBERUZBVUxUX1BSRUZFUkVOQ0VTLCBub3JtYWxpemVQcmVmZXJlbmNlcyB9IGZyb20gJy4uL2NvcmUvcHJlZmVyZW5jZXMnO1xuaW1wb3J0IHtcblx0Y3JlYXRlUGFnZSxcblx0Y3JlYXRlU2Vzc2lvbixcblx0bm9ybWFsaXplU2Vzc2lvbixcblx0dHlwZSBFZGl0b3JQYWdlLFxuXHR0eXBlIEVkaXRvclNlc3Npb25cbn0gZnJvbSAnLi4vY29yZS9zZXNzaW9uJztcbmltcG9ydCB7XG5cdEFOT05ZTU9VU19VU0VSSUQsXG5cdEJMQU5LX0RCX05BTUUsXG5cdEJMQU5LX0RCX1ZFUlNJT04sXG5cdE5PVEVTX1NUT1JFX05BTUUsXG5cdFNFVFRJTkdTX1NUT1JFX05BTUUsXG5cdFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQsXG5cdFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JULFxuXHRTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCxcblx0U0VUVElOR19USEVNRSxcblx0U0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFksXG5cdFVTRVJfSURfSU5ERVgsXG5cdHR5cGUgTm90ZVJlY29yZCxcblx0dHlwZSBTZXR0aW5nUmVjb3JkXG59IGZyb20gJy4vcmVjb3Jkcyc7XG5cbmV4cG9ydCBjbGFzcyBFZGl0b3JTdG9yYWdlIHtcblx0cHJpdmF0ZSBzdGF0aWMgYmFja2VuZFByb21pc2U6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc3RhdGljIG1lbW9yeUJhY2tlbmQgPSBjcmVhdGVNZW1vcnlCYWNrZW5kKCk7XG5cblx0c3RhdGljIGFzeW5jIHNhdmVBbm9ueW1vdXNTdGF0ZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0YXdhaXQgdGhpcy5zYXZlVXNlclN0YXRlKEFOT05ZTU9VU19VU0VSSUQsIHNlc3Npb24pO1xuXHR9XG5cblx0c3RhdGljIGFzeW5jIGxvYWRBbm9ueW1vdXNTdGF0ZSgpOiBQcm9taXNlPEVkaXRvclNlc3Npb24+IHtcblx0XHRyZXR1cm4gKGF3YWl0IHRoaXMubG9hZFVzZXJTdGF0ZShBTk9OWU1PVVNfVVNFUklEKSkgPz8gY3JlYXRlU2Vzc2lvbihBTk9OWU1PVVNfVVNFUklEKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBzYXZlVXNlclN0YXRlKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdGF3YWl0IGJhY2tlbmQuc2F2ZVNlc3Npb24odXNlcklkLCBzZXNzaW9uKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkVXNlclN0YXRlKHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uIHwgbnVsbD4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRyZXR1cm4gYXdhaXQgYmFja2VuZC5sb2FkU2Vzc2lvbih1c2VySWQpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9hZCB1c2VyIGVkaXRvciBzZXNzaW9uOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBudWxsO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkQW5vbnltb3VzUGFnZShwYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yUGFnZSB8IG51bGw+IHtcblx0XHRyZXR1cm4gdGhpcy5sb2FkVXNlclBhZ2UoQU5PTllNT1VTX1VTRVJJRCwgcGFnZUlkKTtcblx0fVxuXG5cdHN0YXRpYyBhc3luYyBsb2FkVXNlclBhZ2UodXNlcklkOiBzdHJpbmcsIHBhZ2VJZDogc3RyaW5nKTogUHJvbWlzZTxFZGl0b3JQYWdlIHwgbnVsbD4ge1xuXHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRyZXR1cm4gYmFja2VuZC5sb2FkUGFnZSh1c2VySWQsIHBhZ2VJZCk7XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgbG9hZFByZWZlcmVuY2VzKHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBQcm9taXNlPEVkaXRvclByZWZlcmVuY2VzPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGJhY2tlbmQgPSBhd2FpdCB0aGlzLmdldEJhY2tlbmQoKTtcblx0XHRcdGNvbnN0IFt0aGVtZU1vZGUsIGNvdW50VmlzaWJpbGl0eSwgc3BlbGxjaGVja0VuYWJsZWRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0XHRiYWNrZW5kLmdldFNldHRpbmc8VGhlbWVNb2RlPih1c2VySWQsIFNFVFRJTkdfVEhFTUUpLFxuXHRcdFx0XHRiYWNrZW5kLmdldFNldHRpbmc8Q291bnRWaXNpYmlsaXR5Pih1c2VySWQsIFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZKSxcblx0XHRcdFx0YmFja2VuZC5nZXRTZXR0aW5nPGJvb2xlYW4+KHVzZXJJZCwgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQpXG5cdFx0XHRdKTtcblxuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZVByZWZlcmVuY2VzKHtcblx0XHRcdFx0dGhlbWVNb2RlLFxuXHRcdFx0XHRjb3VudFZpc2liaWxpdHksXG5cdFx0XHRcdHNwZWxsY2hlY2tFbmFibGVkXG5cdFx0XHR9KTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIGxvYWQgZWRpdG9yIHByZWZlcmVuY2VzOicsIGVycm9yKTtcblx0XHRcdHJldHVybiBERUZBVUxUX1BSRUZFUkVOQ0VTO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyBhc3luYyBzYXZlUHJlZmVyZW5jZXModXNlcklkOiBzdHJpbmcsIHByZWZlcmVuY2VzOiBFZGl0b3JQcmVmZXJlbmNlcykge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBiYWNrZW5kID0gYXdhaXQgdGhpcy5nZXRCYWNrZW5kKCk7XG5cdFx0XHRhd2FpdCBQcm9taXNlLmFsbChbXG5cdFx0XHRcdGJhY2tlbmQuc2V0U2V0dGluZyh1c2VySWQsIFNFVFRJTkdfVEhFTUUsIHByZWZlcmVuY2VzLnRoZW1lTW9kZSksXG5cdFx0XHRcdGJhY2tlbmQuc2V0U2V0dGluZyh1c2VySWQsIFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZLCBwcmVmZXJlbmNlcy5jb3VudFZpc2liaWxpdHkpLFxuXHRcdFx0XHRiYWNrZW5kLnNldFNldHRpbmcodXNlcklkLCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCwgcHJlZmVyZW5jZXMuc3BlbGxjaGVja0VuYWJsZWQpXG5cdFx0XHRdKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Y29uc29sZS5lcnJvcignRmFpbGVkIHRvIHNhdmUgZWRpdG9yIHByZWZlcmVuY2VzOicsIGVycm9yKTtcblx0XHR9XG5cdH1cblxuXHRzdGF0aWMgYXN5bmMgaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQodXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0cmV0dXJuIChhd2FpdCBiYWNrZW5kLmdldFNldHRpbmc8Ym9vbGVhbj4odXNlcklkLCBTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCkpID09PSB0cnVlO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gbG9hZCBhbm9ueW1vdXMgaW1wb3J0IHByb21wdCBzdGF0dXM6JywgZXJyb3IpO1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyBhc3luYyBtYXJrUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQodXNlcklkOiBzdHJpbmcpIHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYmFja2VuZCA9IGF3YWl0IHRoaXMuZ2V0QmFja2VuZCgpO1xuXHRcdFx0YXdhaXQgYmFja2VuZC5zZXRTZXR0aW5nKHVzZXJJZCwgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQsIHRydWUpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gc2F2ZSBhbm9ueW1vdXMgaW1wb3J0IHByb21wdCBzdGF0dXM6JywgZXJyb3IpO1xuXHRcdH1cblx0fVxuXG5cdHN0YXRpYyByZXNldEZvclRlc3RzKCkge1xuXHRcdHRoaXMuYmFja2VuZFByb21pc2UgPSBudWxsO1xuXHRcdHRoaXMubWVtb3J5QmFja2VuZCA9IGNyZWF0ZU1lbW9yeUJhY2tlbmQoKTtcblx0fVxuXG5cdHByaXZhdGUgc3RhdGljIGFzeW5jIGdldEJhY2tlbmQoKTogUHJvbWlzZTxTdG9yYWdlQmFja2VuZD4ge1xuXHRcdGlmICghdGhpcy5iYWNrZW5kUHJvbWlzZSkge1xuXHRcdFx0dGhpcy5iYWNrZW5kUHJvbWlzZSA9IHR5cGVvZiBpbmRleGVkREIgPT09ICd1bmRlZmluZWQnID8gUHJvbWlzZS5yZXNvbHZlKHRoaXMubWVtb3J5QmFja2VuZCkgOiBjcmVhdGVJbmRleGVkRGJCYWNrZW5kKCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHRoaXMuYmFja2VuZFByb21pc2U7XG5cdH1cbn1cblxuaW50ZXJmYWNlIFN0b3JhZ2VCYWNrZW5kIHtcblx0c2F2ZVNlc3Npb24odXNlcklkOiBzdHJpbmcsIHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBQcm9taXNlPHZvaWQ+O1xuXHRsb2FkU2Vzc2lvbih1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8RWRpdG9yU2Vzc2lvbiB8IG51bGw+O1xuXHRsb2FkUGFnZSh1c2VySWQ6IHN0cmluZywgcGFnZUlkOiBzdHJpbmcpOiBQcm9taXNlPEVkaXRvclBhZ2UgfCBudWxsPjtcblx0Z2V0U2V0dGluZzxUPih1c2VySWQ6IHN0cmluZywga2V5OiBzdHJpbmcpOiBQcm9taXNlPFQgfCB1bmRlZmluZWQ+O1xuXHRzZXRTZXR0aW5nKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNZW1vcnlCYWNrZW5kKCk6IFN0b3JhZ2VCYWNrZW5kIHtcblx0Y29uc3Qgbm90ZXMgPSBuZXcgTWFwPHN0cmluZywgTm90ZVJlY29yZD4oKTtcblx0Y29uc3Qgc2V0dGluZ3MgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ1JlY29yZD4oKTtcblxuXHRyZXR1cm4ge1xuXHRcdGFzeW5jIHNhdmVTZXNzaW9uKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0XHRjb25zdCBuZXh0S2V5cyA9IG5ldyBTZXQoc2Vzc2lvbi5wYWdlcy5tYXAoKHBhZ2UpID0+IGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwgcGFnZS5pZCkpKTtcblx0XHRcdGZvciAoY29uc3Qga2V5IG9mIFsuLi5ub3Rlcy5rZXlzKCldKSB7XG5cdFx0XHRcdGlmIChrZXkuc3RhcnRzV2l0aChgJHt1c2VySWR9OjpgKSAmJiAhbmV4dEtleXMuaGFzKGtleSkpIHtcblx0XHRcdFx0XHRub3Rlcy5kZWxldGUoa2V5KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IHBhZ2Ugb2Ygc2Vzc2lvbi5wYWdlcykge1xuXHRcdFx0XHRub3Rlcy5zZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBwYWdlLmlkKSwgdG9Ob3RlUmVjb3JkKHBhZ2UsIHVzZXJJZCkpO1xuXHRcdFx0fVxuXG5cdFx0XHRzZXR0aW5ncy5zZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEKSwgY3JlYXRlU2V0dGluZ1JlY29yZCh1c2VySWQsIFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQsIHNlc3Npb24uYWN0aXZlUGFnZUlkKSk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkU2Vzc2lvbih1c2VySWQ6IHN0cmluZykge1xuXHRcdFx0Y29uc3QgdXNlck5vdGVzID0gWy4uLm5vdGVzLnZhbHVlcygpXVxuXHRcdFx0XHQuZmlsdGVyKChub3RlKSA9PiBub3RlLnVzZXJJZCA9PT0gdXNlcklkKVxuXHRcdFx0XHQuc29ydChjb21wYXJlTm90ZXMpXG5cdFx0XHRcdC5tYXAoKG5vdGUpID0+IHRvRWRpdG9yUGFnZShub3RlKSk7XG5cblx0XHRcdGlmICh1c2VyTm90ZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBhY3RpdmVQYWdlSWQgPSBzZXR0aW5ncy5nZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEKSk/LnZhbHVlO1xuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZVNlc3Npb24oXG5cdFx0XHRcdHsgcGFnZXM6IHVzZXJOb3RlcywgYWN0aXZlUGFnZUlkOiB0eXBlb2YgYWN0aXZlUGFnZUlkID09PSAnc3RyaW5nJyA/IGFjdGl2ZVBhZ2VJZCA6IHVzZXJOb3Rlc1swXS5pZCB9LFxuXHRcdFx0XHR1c2VySWRcblx0XHRcdCk7XG5cdFx0fSxcblx0XHRhc3luYyBsb2FkUGFnZSh1c2VySWQ6IHN0cmluZywgcGFnZUlkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IG5vdGUgPSBub3Rlcy5nZXQoYnVpbGRDb21wb3NpdGVLZXkodXNlcklkLCBwYWdlSWQpKTtcblx0XHRcdHJldHVybiBub3RlID8gdG9FZGl0b3JQYWdlKG5vdGUpIDogbnVsbDtcblx0XHR9LFxuXHRcdGFzeW5jIGdldFNldHRpbmc8VD4odXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nKSB7XG5cdFx0XHRyZXR1cm4gc2V0dGluZ3MuZ2V0KGJ1aWxkQ29tcG9zaXRlS2V5KHVzZXJJZCwga2V5KSk/LnZhbHVlIGFzIFQgfCB1bmRlZmluZWQ7XG5cdFx0fSxcblx0XHRhc3luYyBzZXRTZXR0aW5nKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pIHtcblx0XHRcdHNldHRpbmdzLnNldChidWlsZENvbXBvc2l0ZUtleSh1c2VySWQsIGtleSksIGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkLCBrZXksIHZhbHVlKSk7XG5cdFx0fVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVJbmRleGVkRGJCYWNrZW5kKCk6IFByb21pc2U8U3RvcmFnZUJhY2tlbmQ+IHtcblx0Y29uc3QgZGIgPSBhd2FpdCBvcGVuRGF0YWJhc2UoKTtcblxuXHRyZXR1cm4ge1xuXHRcdGFzeW5jIHNhdmVTZXNzaW9uKHVzZXJJZDogc3RyaW5nLCBzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdFx0XHRjb25zdCB0eCA9IGRiLnRyYW5zYWN0aW9uKFtOT1RFU19TVE9SRV9OQU1FLCBTRVRUSU5HU19TVE9SRV9OQU1FXSwgJ3JlYWR3cml0ZScpO1xuXHRcdFx0Y29uc3Qgbm90ZXNTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKE5PVEVTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3Qgc2V0dGluZ3NTdG9yZSA9IHR4Lm9iamVjdFN0b3JlKFNFVFRJTkdTX1NUT1JFX05BTUUpO1xuXHRcdFx0Y29uc3QgdXNlckluZGV4ID0gbm90ZXNTdG9yZS5pbmRleChVU0VSX0lEX0lOREVYKTtcblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgcmVxdWVzdFRvUHJvbWlzZTxOb3RlUmVjb3JkW10+KHVzZXJJbmRleC5nZXRBbGwoSURCS2V5UmFuZ2Uub25seSh1c2VySWQpKSk7XG5cdFx0XHRjb25zdCBuZXh0SWRzID0gbmV3IFNldChzZXNzaW9uLnBhZ2VzLm1hcCgocGFnZSkgPT4gcGFnZS5pZCkpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IG5vdGUgb2YgZXhpc3RpbmcpIHtcblx0XHRcdFx0aWYgKCFuZXh0SWRzLmhhcyhub3RlLmlkKSkge1xuXHRcdFx0XHRcdG5vdGVzU3RvcmUuZGVsZXRlKFt1c2VySWQsIG5vdGUuaWRdKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IHBhZ2Ugb2Ygc2Vzc2lvbi5wYWdlcykge1xuXHRcdFx0XHRub3Rlc1N0b3JlLnB1dCh0b05vdGVSZWNvcmQocGFnZSwgdXNlcklkKSk7XG5cdFx0XHR9XG5cblx0XHRcdHNldHRpbmdzU3RvcmUucHV0KGNyZWF0ZVNldHRpbmdSZWNvcmQodXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lELCBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCkpO1xuXHRcdFx0YXdhaXQgdHJhbnNhY3Rpb25Ub1Byb21pc2UodHgpO1xuXHRcdH0sXG5cdFx0YXN5bmMgbG9hZFNlc3Npb24odXNlcklkOiBzdHJpbmcpIHtcblx0XHRcdGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oW05PVEVTX1NUT1JFX05BTUUsIFNFVFRJTkdTX1NUT1JFX05BTUVdLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IG5vdGVzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShOT1RFU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHNldHRpbmdzU3RvcmUgPSB0eC5vYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FKTtcblx0XHRcdGNvbnN0IHVzZXJJbmRleCA9IG5vdGVzU3RvcmUuaW5kZXgoVVNFUl9JRF9JTkRFWCk7XG5cblx0XHRcdGNvbnN0IFtub3RlcywgYWN0aXZlUGFnZVNldHRpbmddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuXHRcdFx0XHRyZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmRbXT4odXNlckluZGV4LmdldEFsbChJREJLZXlSYW5nZS5vbmx5KHVzZXJJZCkpKSxcblx0XHRcdFx0cmVxdWVzdFRvUHJvbWlzZTxTZXR0aW5nUmVjb3JkIHwgdW5kZWZpbmVkPihzZXR0aW5nc1N0b3JlLmdldChbdXNlcklkLCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEXSkpXG5cdFx0XHRdKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblxuXHRcdFx0aWYgKG5vdGVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZVNlc3Npb24oXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwYWdlczogbm90ZXMuc29ydChjb21wYXJlTm90ZXMpLm1hcCgobm90ZSkgPT4gdG9FZGl0b3JQYWdlKG5vdGUpKSxcblx0XHRcdFx0XHRhY3RpdmVQYWdlSWQ6XG5cdFx0XHRcdFx0XHR0eXBlb2YgYWN0aXZlUGFnZVNldHRpbmc/LnZhbHVlID09PSAnc3RyaW5nJ1xuXHRcdFx0XHRcdFx0XHQ/IGFjdGl2ZVBhZ2VTZXR0aW5nLnZhbHVlXG5cdFx0XHRcdFx0XHRcdDogbm90ZXNbMF0hLmlkXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHVzZXJJZFxuXHRcdFx0KTtcblx0XHR9LFxuXHRcdGFzeW5jIGxvYWRQYWdlKHVzZXJJZDogc3RyaW5nLCBwYWdlSWQ6IHN0cmluZykge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihOT1RFU19TVE9SRV9OQU1FLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IG5vdGUgPSBhd2FpdCByZXF1ZXN0VG9Qcm9taXNlPE5vdGVSZWNvcmQgfCB1bmRlZmluZWQ+KFxuXHRcdFx0XHR0eC5vYmplY3RTdG9yZShOT1RFU19TVE9SRV9OQU1FKS5nZXQoW3VzZXJJZCwgcGFnZUlkXSlcblx0XHRcdCk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0XHRyZXR1cm4gbm90ZSA/IHRvRWRpdG9yUGFnZShub3RlKSA6IG51bGw7XG5cdFx0fSxcblx0XHRhc3luYyBnZXRTZXR0aW5nPFQ+KHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZykge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihTRVRUSU5HU19TVE9SRV9OQU1FLCAncmVhZG9ubHknKTtcblx0XHRcdGNvbnN0IHNldHRpbmcgPSBhd2FpdCByZXF1ZXN0VG9Qcm9taXNlPFNldHRpbmdSZWNvcmQgfCB1bmRlZmluZWQ+KFxuXHRcdFx0XHR0eC5vYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FKS5nZXQoW3VzZXJJZCwga2V5XSlcblx0XHRcdCk7XG5cdFx0XHRhd2FpdCB0cmFuc2FjdGlvblRvUHJvbWlzZSh0eCk7XG5cdFx0XHRyZXR1cm4gc2V0dGluZz8udmFsdWUgYXMgVCB8IHVuZGVmaW5lZDtcblx0XHR9LFxuXHRcdGFzeW5jIHNldFNldHRpbmcodXNlcklkOiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuXHRcdFx0Y29uc3QgdHggPSBkYi50cmFuc2FjdGlvbihTRVRUSU5HU19TVE9SRV9OQU1FLCAncmVhZHdyaXRlJyk7XG5cdFx0XHR0eC5vYmplY3RTdG9yZShTRVRUSU5HU19TVE9SRV9OQU1FKS5wdXQoY3JlYXRlU2V0dGluZ1JlY29yZCh1c2VySWQsIGtleSwgdmFsdWUpKTtcblx0XHRcdGF3YWl0IHRyYW5zYWN0aW9uVG9Qcm9taXNlKHR4KTtcblx0XHR9XG5cdH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG9wZW5EYXRhYmFzZSgpOiBQcm9taXNlPElEQkRhdGFiYXNlPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0Y29uc3QgcmVxdWVzdCA9IGluZGV4ZWREQi5vcGVuKEJMQU5LX0RCX05BTUUsIEJMQU5LX0RCX1ZFUlNJT04pO1xuXG5cdFx0cmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoKSA9PiB7XG5cdFx0XHRjb25zdCBkYiA9IHJlcXVlc3QucmVzdWx0O1xuXHRcdFx0aWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKE5PVEVTX1NUT1JFX05BTUUpKSB7XG5cdFx0XHRcdGNvbnN0IG5vdGVzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZShOT1RFU19TVE9SRV9OQU1FLCB7XG5cdFx0XHRcdFx0a2V5UGF0aDogWyd1c2VySWQnLCAnaWQnXVxuXHRcdFx0XHR9KTtcblx0XHRcdFx0bm90ZXNTdG9yZS5jcmVhdGVJbmRleChVU0VSX0lEX0lOREVYLCAndXNlcklkJywgeyB1bmlxdWU6IGZhbHNlIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIWRiLm9iamVjdFN0b3JlTmFtZXMuY29udGFpbnMoU0VUVElOR1NfU1RPUkVfTkFNRSkpIHtcblx0XHRcdFx0Y29uc3Qgc2V0dGluZ3NTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKFNFVFRJTkdTX1NUT1JFX05BTUUsIHtcblx0XHRcdFx0XHRrZXlQYXRoOiBbJ3VzZXJJZCcsICdrZXknXVxuXHRcdFx0XHR9KTtcblx0XHRcdFx0c2V0dGluZ3NTdG9yZS5jcmVhdGVJbmRleChVU0VSX0lEX0lOREVYLCAndXNlcklkJywgeyB1bmlxdWU6IGZhbHNlIH0pO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHRyZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuXHRcdHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29tcG9zaXRlS2V5KGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZykge1xuXHRyZXR1cm4gYCR7bGVmdH06OiR7cmlnaHR9YDtcbn1cblxuZnVuY3Rpb24gdG9Ob3RlUmVjb3JkKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogTm90ZVJlY29yZCB7XG5cdHJldHVybiB7XG5cdFx0aWQ6IHBhZ2UuaWQsXG5cdFx0dXNlcklkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHRjcmVhdGVkQXQ6IHBhZ2UuY3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogcGFnZS51cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0OiBwYWdlLmRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHBhZ2UubGFzdFN5bmNlZEF0LFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcGFnZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBwYWdlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXNcblx0fTtcbn1cblxuZnVuY3Rpb24gdG9FZGl0b3JQYWdlKG5vdGU6IE5vdGVSZWNvcmQpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2Uobm90ZS5jb250ZW50LCB7XG5cdFx0aWQ6IG5vdGUuaWQsXG5cdFx0dXNlcklkOiBub3RlLnVzZXJJZCxcblx0XHRub3c6IG5vdGUuY3JlYXRlZEF0XG5cdH0pO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogbm90ZS50aXRsZSxcblx0XHRjb250ZW50OiBub3RlLmNvbnRlbnQsXG5cdFx0dGV4dDogbm90ZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogbm90ZS5jcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBub3RlLnVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQ6IG5vdGUuZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogbm90ZS5sYXN0U3luY2VkQXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBub3RlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG5vdGUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5vdGUuc3luY1N0YXR1c1xuXHR9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVTZXR0aW5nUmVjb3JkKHVzZXJJZDogc3RyaW5nLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBTZXR0aW5nUmVjb3JkIHtcblx0cmV0dXJuIHtcblx0XHR1c2VySWQsXG5cdFx0a2V5LFxuXHRcdHZhbHVlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdH07XG59XG5cbmZ1bmN0aW9uIGNvbXBhcmVOb3RlcyhsZWZ0OiBOb3RlUmVjb3JkLCByaWdodDogTm90ZVJlY29yZCkge1xuXHRpZiAobGVmdC5jcmVhdGVkQXQgIT09IHJpZ2h0LmNyZWF0ZWRBdCkge1xuXHRcdHJldHVybiBsZWZ0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKHJpZ2h0LmNyZWF0ZWRBdCk7XG5cdH1cblxuXHRyZXR1cm4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKTtcbn1cblxuZnVuY3Rpb24gcmVxdWVzdFRvUHJvbWlzZTxUPihyZXF1ZXN0OiBJREJSZXF1ZXN0PFQ+KTogUHJvbWlzZTxUPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0cmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcblx0XHRyZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiB0cmFuc2FjdGlvblRvUHJvbWlzZSh0cmFuc2FjdGlvbjogSURCVHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHR0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gcmVzb2x2ZSgpO1xuXHRcdHRyYW5zYWN0aW9uLm9uZXJyb3IgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuXHRcdHRyYW5zYWN0aW9uLm9uYWJvcnQgPSAoKSA9PiByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IgPz8gbmV3IEVycm9yKCdJbmRleGVkREIgdHJhbnNhY3Rpb24gYWJvcnRlZCcpKTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDUVosSUFBTSxzQkFBeUM7QUFBQSxFQUNyRCxXQUFXO0FBQUEsRUFDWCxtQkFBbUI7QUFBQSxFQUNuQixpQkFBaUI7QUFDbEI7QUFFQSxJQUFNLHlCQUE0QyxDQUFDLFVBQVUsUUFBUSxRQUFRO0FBRXRFLFNBQVMscUJBQXFCLE9BQW1DO0FBQ3ZFLE1BQUksQ0FBQyxTQUFTLE9BQU8sVUFBVSxVQUFVO0FBQ3hDLFdBQU87QUFBQSxFQUNSO0FBRUEsUUFBTSxZQUFZO0FBRWxCLFNBQU87QUFBQSxJQUNOLFdBQVcsVUFBVSxjQUFjLFNBQVMsU0FBUztBQUFBLElBQ3JELG1CQUNDLE9BQU8sVUFBVSxzQkFBc0IsWUFDcEMsVUFBVSxvQkFDVixvQkFBb0I7QUFBQSxJQUN4QixpQkFBaUIsdUJBQXVCLFNBQVMsVUFBVSxlQUFrQyxJQUN6RixVQUFVLGtCQUNYLG9CQUFvQjtBQUFBLEVBQ3hCO0FBQ0Q7OztBQ2xDTyxJQUFNLGdCQUFnQjtBQUN0QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLHNCQUFzQjtBQUM1QixJQUFNLGdCQUFnQjtBQUV0QixJQUFNLG1CQUFtQjtBQXlCekIs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
