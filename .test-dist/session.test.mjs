// tests/session.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/editor/persistence/records.ts
var ANONYMOUS_USERID = "anonymous";

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
function clonePageForUser(page, userId) {
  const cloned = createPage(page.content, { userId, isEphemeral: false });
  return {
    ...cloned,
    title: page.title,
    content: page.content,
    text: page.content,
    deletedAt: page.deletedAt,
    syncStatus: "dirty",
    isEphemeral: false
  };
}
function markPageDirty(page, userId = page.userId) {
  return {
    ...page,
    userId,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    lastSyncedAt: null,
    lastKnownRemoteUpdatedAt: null,
    lastKnownRemoteDeletedAt: null,
    syncStatus: page.syncStatus === "conflict" ? "conflict" : "dirty"
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

// tests/session.test.ts
test("normalizeSession migrates the legacy single-document state into one page", () => {
  const session = normalizeSession({
    text: "# Title\nbody",
    selectionStart: 2,
    selectionEnd: 2
  });
  assert.ok(session);
  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0]?.content, "# Title\nbody");
  assert.equal(session.pages[0]?.text, "# Title\nbody");
  assert.equal(session.pages[0]?.title, "# Title");
  assert.equal(session.pages[0]?.userId, ANONYMOUS_USERID);
  assert.equal(session.pages[0]?.syncStatus, "dirty");
  assert.equal(session.pages[0]?.isEphemeral, false);
  assert.equal(session.activePageId, session.pages[0]?.id);
});
test("normalizeSession repairs incomplete page data and keeps the first page active", () => {
  const session = normalizeSession({
    pages: [{ content: "alpha\r\nbeta" }, { id: "p-2", title: "Saved", content: "" }],
    activePageId: "missing"
  });
  assert.ok(session);
  assert.equal(session.pages.length, 2);
  const repairedPage = session.pages.find((page) => page.content === "alpha\nbeta");
  const savedPage = session.pages.find((page) => page.id === "p-2");
  assert.ok(repairedPage);
  assert.ok(savedPage);
  assert.equal(repairedPage.content, "alpha\nbeta");
  assert.equal(repairedPage.title, "alpha");
  assert.equal(savedPage.title, "Saved");
  assert.equal(repairedPage.userId, ANONYMOUS_USERID);
  assert.ok(session.pages.some((page) => page.id === session.activePageId && page.deletedAt === null));
});
test("createSession seeds a locally-owned dirty ephemeral page by default", () => {
  const session = createSession();
  const page = session.pages[0];
  assert.equal(page.title, "Untitled");
  assert.equal(page.userId, ANONYMOUS_USERID);
  assert.equal(page.deletedAt, null);
  assert.equal(page.lastSyncedAt, null);
  assert.equal(page.lastKnownRemoteUpdatedAt, null);
  assert.equal(page.lastKnownRemoteDeletedAt, null);
  assert.equal(page.syncStatus, "dirty");
  assert.equal(page.isEphemeral, true);
});
test("updatePageState refreshes content, derives titles, and materializes the page", () => {
  const session = createSession();
  const page = updatePageState(session.pages[0], {
    text: "\n\nconst value = 1;",
    selectionStart: 4,
    selectionEnd: 4
  });
  assert.equal(page.content, "\n\nconst value = 1;");
  assert.equal(page.title, "const value = 1;");
  assert.equal(page.selectionStart, 4);
  assert.equal(page.selectionEnd, 4);
  assert.equal(page.syncStatus, "dirty");
  assert.equal(page.isEphemeral, false);
});
test("updatePageState keeps custom titles during content edits", () => {
  const session = createSession();
  const initial = session.pages[0];
  const customTitlePage = {
    ...initial,
    title: "Custom title"
  };
  const page = updatePageState(customTitlePage, {
    text: "first line\nbody",
    selectionStart: 1,
    selectionEnd: 1
  });
  assert.equal(page.title, "Custom title");
  assert.equal(page.content, "first line\nbody");
  assert.equal(page.isEphemeral, false);
});
test("updatePageState keeps page sync metadata stable for selection-only updates", () => {
  const session = createSession();
  const initial = updatePageState(session.pages[0], {
    text: "alpha",
    selectionStart: 0,
    selectionEnd: 0
  });
  const selectionOnly = updatePageState(initial, {
    text: "alpha",
    selectionStart: 2,
    selectionEnd: 2
  });
  assert.equal(selectionOnly.title, "alpha");
  assert.equal(selectionOnly.updatedAt, initial.updatedAt);
  assert.equal(selectionOnly.selectionStart, 2);
  assert.equal(selectionOnly.selectionEnd, 2);
  assert.equal(selectionOnly.syncStatus, initial.syncStatus);
  assert.equal(selectionOnly.isEphemeral, initial.isEphemeral);
});
test("markPageDirty retargets copied pages to a new owner and clears remote state", () => {
  const session = createSession("user-a");
  const copied = markPageDirty(
    {
      ...session.pages[0],
      syncStatus: "synced",
      lastSyncedAt: "2026-04-14T00:00:00.000Z",
      lastKnownRemoteUpdatedAt: "2026-04-14T00:00:00.000Z",
      lastKnownRemoteDeletedAt: null,
      isEphemeral: false
    },
    "user-b"
  );
  assert.equal(copied.userId, "user-b");
  assert.equal(copied.syncStatus, "dirty");
  assert.equal(copied.lastSyncedAt, null);
  assert.equal(copied.lastKnownRemoteUpdatedAt, null);
  assert.equal(copied.lastKnownRemoteDeletedAt, null);
});
test("clonePageForUser creates a fresh local page id for imported anonymous data", () => {
  const session = createSession(ANONYMOUS_USERID);
  const source = {
    ...session.pages[0],
    id: "anon-page-1",
    title: "Imported title",
    content: "imported body",
    text: "imported body",
    deletedAt: null,
    isEphemeral: false
  };
  const cloned = clonePageForUser(source, "user-a");
  assert.notEqual(cloned.id, source.id);
  assert.equal(cloned.userId, "user-a");
  assert.equal(cloned.title, "Imported title");
  assert.equal(cloned.content, "imported body");
  assert.equal(cloned.syncStatus, "dirty");
  assert.equal(cloned.isEphemeral, false);
});
test("derivePageTitle falls back to Untitled for blank content", () => {
  assert.equal(derivePageTitle("   \n  "), "Untitled");
});
test("ensureValidActivePage falls back to the first page when the active page is missing", () => {
  const repaired = ensureValidActivePage({
    activePageId: "missing",
    pages: [
      {
        id: "page-a",
        userId: ANONYMOUS_USERID,
        title: "A",
        content: "alpha",
        text: "alpha",
        selectionStart: 0,
        selectionEnd: 0,
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
        deletedAt: null,
        lastSyncedAt: null,
        lastKnownRemoteUpdatedAt: null,
        lastKnownRemoteDeletedAt: null,
        syncStatus: "dirty",
        isEphemeral: false
      }
    ]
  });
  assert.equal(repaired.activePageId, "page-a");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc2Vzc2lvbi50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgQU5PTllNT1VTX1VTRVJJRCwgdHlwZSBQYWdlU3luY1N0YXR1cyB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMnO1xuaW1wb3J0IHtcblx0Y2xvbmVQYWdlRm9yVXNlcixcblx0Y3JlYXRlU2Vzc2lvbixcblx0ZGVyaXZlUGFnZVRpdGxlLFxuXHRlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UsXG5cdG1hcmtQYWdlRGlydHksXG5cdG5vcm1hbGl6ZVNlc3Npb24sXG5cdHVwZGF0ZVBhZ2VTdGF0ZVxufSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuXG50ZXN0KCdub3JtYWxpemVTZXNzaW9uIG1pZ3JhdGVzIHRoZSBsZWdhY3kgc2luZ2xlLWRvY3VtZW50IHN0YXRlIGludG8gb25lIHBhZ2UnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBub3JtYWxpemVTZXNzaW9uKHtcblx0XHR0ZXh0OiAnIyBUaXRsZVxcbmJvZHknLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAyLFxuXHRcdHNlbGVjdGlvbkVuZDogMlxuXHR9KTtcblxuXHRhc3NlcnQub2soc2Vzc2lvbik7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzBdPy5jb250ZW50LCAnIyBUaXRsZVxcbmJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXNbMF0/LnRleHQsICcjIFRpdGxlXFxuYm9keScpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8udGl0bGUsICcjIFRpdGxlJyk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzBdPy51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5hY3RpdmVQYWdlSWQsIHNlc3Npb24ucGFnZXNbMF0/LmlkKTtcbn0pO1xuXG50ZXN0KCdub3JtYWxpemVTZXNzaW9uIHJlcGFpcnMgaW5jb21wbGV0ZSBwYWdlIGRhdGEgYW5kIGtlZXBzIHRoZSBmaXJzdCBwYWdlIGFjdGl2ZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IG5vcm1hbGl6ZVNlc3Npb24oe1xuXHRcdHBhZ2VzOiBbeyBjb250ZW50OiAnYWxwaGFcXHJcXG5iZXRhJyB9LCB7IGlkOiAncC0yJywgdGl0bGU6ICdTYXZlZCcsIGNvbnRlbnQ6ICcnIH1dLFxuXHRcdGFjdGl2ZVBhZ2VJZDogJ21pc3NpbmcnXG5cdH0pO1xuXG5cdGFzc2VydC5vayhzZXNzaW9uKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXMubGVuZ3RoLCAyKTtcblx0Y29uc3QgcmVwYWlyZWRQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmNvbnRlbnQgPT09ICdhbHBoYVxcbmJldGEnKTtcblx0Y29uc3Qgc2F2ZWRQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmlkID09PSAncC0yJyk7XG5cdGFzc2VydC5vayhyZXBhaXJlZFBhZ2UpO1xuXHRhc3NlcnQub2soc2F2ZWRQYWdlKTtcblx0YXNzZXJ0LmVxdWFsKHJlcGFpcmVkUGFnZS5jb250ZW50LCAnYWxwaGFcXG5iZXRhJyk7XG5cdGFzc2VydC5lcXVhbChyZXBhaXJlZFBhZ2UudGl0bGUsICdhbHBoYScpO1xuXHRhc3NlcnQuZXF1YWwoc2F2ZWRQYWdlLnRpdGxlLCAnU2F2ZWQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlcGFpcmVkUGFnZS51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQub2soc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpO1xufSk7XG5cbnRlc3QoJ2NyZWF0ZVNlc3Npb24gc2VlZHMgYSBsb2NhbGx5LW93bmVkIGRpcnR5IGVwaGVtZXJhbCBwYWdlIGJ5IGRlZmF1bHQnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IHBhZ2UgPSBzZXNzaW9uLnBhZ2VzWzBdITtcblxuXHRhc3NlcnQuZXF1YWwocGFnZS50aXRsZSwgJ1VudGl0bGVkJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlLnVzZXJJZCwgQU5PTllNT1VTX1VTRVJJRCk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmRlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmxhc3RTeW5jZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChwYWdlLnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG59KTtcblxudGVzdCgndXBkYXRlUGFnZVN0YXRlIHJlZnJlc2hlcyBjb250ZW50LCBkZXJpdmVzIHRpdGxlcywgYW5kIG1hdGVyaWFsaXplcyB0aGUgcGFnZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3QgcGFnZSA9IHVwZGF0ZVBhZ2VTdGF0ZShzZXNzaW9uLnBhZ2VzWzBdISwge1xuXHRcdHRleHQ6ICdcXG5cXG5jb25zdCB2YWx1ZSA9IDE7Jyxcblx0XHRzZWxlY3Rpb25TdGFydDogNCxcblx0XHRzZWxlY3Rpb25FbmQ6IDRcblx0fSk7XG5cblx0YXNzZXJ0LmVxdWFsKHBhZ2UuY29udGVudCwgJ1xcblxcbmNvbnN0IHZhbHVlID0gMTsnKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UudGl0bGUsICdjb25zdCB2YWx1ZSA9IDE7Jyk7XG5cdGFzc2VydC5lcXVhbChwYWdlLnNlbGVjdGlvblN0YXJ0LCA0KTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2Uuc2VsZWN0aW9uRW5kLCA0KTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2Uuc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmlzRXBoZW1lcmFsLCBmYWxzZSk7XG59KTtcblxudGVzdCgndXBkYXRlUGFnZVN0YXRlIGtlZXBzIGN1c3RvbSB0aXRsZXMgZHVyaW5nIGNvbnRlbnQgZWRpdHMnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IGluaXRpYWwgPSBzZXNzaW9uLnBhZ2VzWzBdITtcblx0Y29uc3QgY3VzdG9tVGl0bGVQYWdlID0ge1xuXHRcdC4uLmluaXRpYWwsXG5cdFx0dGl0bGU6ICdDdXN0b20gdGl0bGUnXG5cdH07XG5cblx0Y29uc3QgcGFnZSA9IHVwZGF0ZVBhZ2VTdGF0ZShjdXN0b21UaXRsZVBhZ2UsIHtcblx0XHR0ZXh0OiAnZmlyc3QgbGluZVxcbmJvZHknLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAxLFxuXHRcdHNlbGVjdGlvbkVuZDogMVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwocGFnZS50aXRsZSwgJ0N1c3RvbSB0aXRsZScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5jb250ZW50LCAnZmlyc3QgbGluZVxcbmJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UuaXNFcGhlbWVyYWwsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCd1cGRhdGVQYWdlU3RhdGUga2VlcHMgcGFnZSBzeW5jIG1ldGFkYXRhIHN0YWJsZSBmb3Igc2VsZWN0aW9uLW9ubHkgdXBkYXRlcycsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3QgaW5pdGlhbCA9IHVwZGF0ZVBhZ2VTdGF0ZShzZXNzaW9uLnBhZ2VzWzBdISwge1xuXHRcdHRleHQ6ICdhbHBoYScsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0c2VsZWN0aW9uRW5kOiAwXG5cdH0pO1xuXHRjb25zdCBzZWxlY3Rpb25Pbmx5ID0gdXBkYXRlUGFnZVN0YXRlKGluaXRpYWwsIHtcblx0XHR0ZXh0OiAnYWxwaGEnLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAyLFxuXHRcdHNlbGVjdGlvbkVuZDogMlxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoc2VsZWN0aW9uT25seS50aXRsZSwgJ2FscGhhJyk7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnVwZGF0ZWRBdCwgaW5pdGlhbC51cGRhdGVkQXQpO1xuXHRhc3NlcnQuZXF1YWwoc2VsZWN0aW9uT25seS5zZWxlY3Rpb25TdGFydCwgMik7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnNlbGVjdGlvbkVuZCwgMik7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnN5bmNTdGF0dXMsIGluaXRpYWwuc3luY1N0YXR1cyk7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LmlzRXBoZW1lcmFsLCBpbml0aWFsLmlzRXBoZW1lcmFsKTtcbn0pO1xuXG50ZXN0KCdtYXJrUGFnZURpcnR5IHJldGFyZ2V0cyBjb3BpZWQgcGFnZXMgdG8gYSBuZXcgb3duZXIgYW5kIGNsZWFycyByZW1vdGUgc3RhdGUnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnKTtcblx0Y29uc3QgY29waWVkID0gbWFya1BhZ2VEaXJ0eShcblx0XHR7XG5cdFx0XHQuLi5zZXNzaW9uLnBhZ2VzWzBdISxcblx0XHRcdHN5bmNTdGF0dXM6ICdzeW5jZWQnIGFzIFBhZ2VTeW5jU3RhdHVzLFxuXHRcdFx0bGFzdFN5bmNlZEF0OiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJyxcblx0XHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0XHR9LFxuXHRcdCd1c2VyLWInXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKGNvcGllZC51c2VySWQsICd1c2VyLWInKTtcblx0YXNzZXJ0LmVxdWFsKGNvcGllZC5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKGNvcGllZC5sYXN0U3luY2VkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwoY29waWVkLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChjb3BpZWQubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0LCBudWxsKTtcbn0pO1xuXG50ZXN0KCdjbG9uZVBhZ2VGb3JVc2VyIGNyZWF0ZXMgYSBmcmVzaCBsb2NhbCBwYWdlIGlkIGZvciBpbXBvcnRlZCBhbm9ueW1vdXMgZGF0YScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oQU5PTllNT1VTX1VTRVJJRCk7XG5cdGNvbnN0IHNvdXJjZSA9IHtcblx0XHQuLi5zZXNzaW9uLnBhZ2VzWzBdISxcblx0XHRpZDogJ2Fub24tcGFnZS0xJyxcblx0XHR0aXRsZTogJ0ltcG9ydGVkIHRpdGxlJyxcblx0XHRjb250ZW50OiAnaW1wb3J0ZWQgYm9keScsXG5cdFx0dGV4dDogJ2ltcG9ydGVkIGJvZHknLFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcblxuXHRjb25zdCBjbG9uZWQgPSBjbG9uZVBhZ2VGb3JVc2VyKHNvdXJjZSwgJ3VzZXItYScpO1xuXG5cdGFzc2VydC5ub3RFcXVhbChjbG9uZWQuaWQsIHNvdXJjZS5pZCk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQudXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQudGl0bGUsICdJbXBvcnRlZCB0aXRsZScpO1xuXHRhc3NlcnQuZXF1YWwoY2xvbmVkLmNvbnRlbnQsICdpbXBvcnRlZCBib2R5Jyk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQuc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQuaXNFcGhlbWVyYWwsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCdkZXJpdmVQYWdlVGl0bGUgZmFsbHMgYmFjayB0byBVbnRpdGxlZCBmb3IgYmxhbmsgY29udGVudCcsICgpID0+IHtcblx0YXNzZXJ0LmVxdWFsKGRlcml2ZVBhZ2VUaXRsZSgnICAgXFxuICAnKSwgJ1VudGl0bGVkJyk7XG59KTtcblxudGVzdCgnZW5zdXJlVmFsaWRBY3RpdmVQYWdlIGZhbGxzIGJhY2sgdG8gdGhlIGZpcnN0IHBhZ2Ugd2hlbiB0aGUgYWN0aXZlIHBhZ2UgaXMgbWlzc2luZycsICgpID0+IHtcblx0Y29uc3QgcmVwYWlyZWQgPSBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoe1xuXHRcdGFjdGl2ZVBhZ2VJZDogJ21pc3NpbmcnLFxuXHRcdHBhZ2VzOiBbXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiAncGFnZS1hJyxcblx0XHRcdFx0dXNlcklkOiBBTk9OWU1PVVNfVVNFUklELFxuXHRcdFx0XHR0aXRsZTogJ0EnLFxuXHRcdFx0XHRjb250ZW50OiAnYWxwaGEnLFxuXHRcdFx0XHR0ZXh0OiAnYWxwaGEnLFxuXHRcdFx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRcdFx0c2VsZWN0aW9uRW5kOiAwLFxuXHRcdFx0XHRjcmVhdGVkQXQ6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdFx0XHR1cGRhdGVkQXQ6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdFx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRcdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdFx0fVxuXHRcdF1cblx0fSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlcGFpcmVkLmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtYScpO1xufSk7XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcblxuZXhwb3J0IGNvbnN0IEFOT05ZTU9VU19VU0VSSUQgPSAnYW5vbnltb3VzJztcblxuZXhwb3J0IHR5cGUgUGFnZVN5bmNTdGF0dXMgPSAnc3luY2VkJyB8ICdkaXJ0eScgfCAncGVuZGluZ19wdXNoJyB8ICdjb25mbGljdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFnZVJlY29yZCB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRzeW5jU3RhdHVzOiBQYWdlU3luY1N0YXR1cztcblx0aXNFcGhlbWVyYWw6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ1JlY29yZCB7XG5cdGtleTogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZyB8IG51bGw7XG5cdHZhbHVlOiB1bmtub3duO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQgPSAnYWN0aXZlUGFnZUlkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1RIRU1FID0gJ3RoZW1lJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSA9ICd3b3JkQ291bnRWaXNpYmlsaXR5JztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCA9ICdzcGVsbGNoZWNrRW5hYmxlZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQgPSAnaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQnO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcbmltcG9ydCB7XG5cdEFOT05ZTU9VU19VU0VSSUQsXG5cdHR5cGUgUGFnZVJlY29yZCxcblx0dHlwZSBQYWdlU3luY1N0YXR1c1xufSBmcm9tICcuLi9wZXJzaXN0ZW5jZS9yZWNvcmRzJztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQYWdlIGV4dGVuZHMgRWRpdG9yU3RhdGUsIFBhZ2VSZWNvcmQge31cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JTZXNzaW9uIHtcblx0cGFnZXM6IEVkaXRvclBhZ2VbXTtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBVTlRJVExFRF9QQUdFID0gJ1VudGl0bGVkJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVBhZ2VUaXRsZShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaXJzdExpbmUgPSBjb250ZW50XG5cdFx0LnNwbGl0KCdcXG4nKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG5cdGlmICghZmlyc3RMaW5lKSB7XG5cdFx0cmV0dXJuIFVOVElUTEVEX1BBR0U7XG5cdH1cblxuXHRyZXR1cm4gZmlyc3RMaW5lLnJlcGxhY2UoL1xccysvZywgJyAnKS5zbGljZSgwLCA0OCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYWdlKFxuXHRjb250ZW50ID0gJycsXG5cdG9wdGlvbnM6IHtcblx0XHRpZD86IHN0cmluZztcblx0XHR1c2VySWQ/OiBzdHJpbmc7XG5cdFx0bm93Pzogc3RyaW5nO1xuXHRcdGlzRXBoZW1lcmFsPzogYm9vbGVhbjtcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IG9wdGlvbnMuaXNFcGhlbWVyYWwgPz8gdHJ1ZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbih1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSBjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRpZiAoc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLnBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVRpdGxlKHBhZ2U6IEVkaXRvclBhZ2UsIHRpdGxlOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURlbGV0ZWQocGFnZTogRWRpdG9yUGFnZSwgZGVsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRkZWxldGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBkZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZVBhZ2UocGFnZTogRWRpdG9yUGFnZSk6IEVkaXRvclBhZ2Uge1xuXHRpZiAoIXBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb25lUGFnZUZvclVzZXIocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY2xvbmVkID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogZmFsc2UgfSk7XG5cdHJldHVybiB7XG5cdFx0Li4uY2xvbmVkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHR0ZXh0OiBwYWdlLmNvbnRlbnQsXG5cdFx0ZGVsZXRlZEF0OiBwYWdlLmRlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEaXJ0eShwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQgPSBwYWdlLnVzZXJJZCk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXNlcklkLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uKHZhbHVlOiB1bmtub3duLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0aWYgKGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWUpKSB7XG5cdFx0cmV0dXJuIG1pZ3JhdGVMZWdhY3lTdGF0ZSh2YWx1ZSwgdXNlcklkKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCwgdXNlcklkKSlcblx0XHQuZmlsdGVyKChwYWdlKTogcGFnZSBpcyBFZGl0b3JQYWdlID0+IHBhZ2UgIT09IG51bGwpXG5cdFx0LnNvcnQoY29tcGFyZVBhZ2VzKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24odXNlcklkKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pLCBzdGF0ZSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGFnZSh2YWx1ZTogdW5rbm93biwgaW5kZXg6IG51bWJlciwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLmNyZWF0ZWRBdCwgdmFsdWUuY3JlYXRlZF9hdCk7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUudXBkYXRlZEF0LCB2YWx1ZS51cGRhdGVkX2F0KSA/PyBjcmVhdGVkQXQ7XG5cdGNvbnN0IGRlbGV0ZWRBdCA9IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5kZWxldGVkQXQsIHZhbHVlLmRlbGV0ZWRfYXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXgpLFxuXHRcdHVzZXJJZDogdHlwZW9mIHZhbHVlLnVzZXJJZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUudXNlcklkLmxlbmd0aCA+IDAgPyB2YWx1ZS51c2VySWQgOiB1c2VySWQsXG5cdFx0dGl0bGU6XG5cdFx0XHR0eXBlb2YgdmFsdWUudGl0bGUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdDogZGVyaXZlUGFnZVRpdGxlKG5vcm1hbGl6ZWRDb250ZW50KSxcblx0XHRjb250ZW50OiBub3JtYWxpemVkQ29udGVudCxcblx0XHR0ZXh0OiBub3JtYWxpemVkQ29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdFN5bmNlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCksXG5cdFx0c3luY1N0YXR1czogbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogdHlwZW9mIHZhbHVlLmlzRXBoZW1lcmFsID09PSAnYm9vbGVhbicgPyB2YWx1ZS5pc0VwaGVtZXJhbCA6IGZhbHNlXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYHBhZ2UtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogUGFnZVN5bmNTdGF0dXMpOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gY29tcGFyZVBhZ2VzKGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ0taLElBQU0sbUJBQW1COzs7QUNRekIsSUFBTSxnQkFBZ0I7QUFFdEIsU0FBUyxnQkFBZ0IsU0FBeUI7QUFDeEQsUUFBTSxZQUFZLFFBQ2hCLE1BQU0sSUFBSSxF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
