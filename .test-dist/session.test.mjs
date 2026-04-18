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
function hasVisibleEphemeralActivePage(session) {
  const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
  return !!activePage && activePage.deletedAt === null && activePage.isEphemeral;
}
function getRemoteEligibleActivePageId(session) {
  const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
  if (!activePage || activePage.deletedAt !== null || activePage.isEphemeral) {
    return null;
  }
  return activePage.id;
}
function getRemoteActivePageUpdateTarget(previousSession, nextSession) {
  const nextActivePageId = getRemoteEligibleActivePageId(nextSession);
  if (nextActivePageId && nextActivePageId !== previousSession.activePageId) {
    return nextActivePageId;
  }
  const previousActiveBefore = previousSession.pages.find((page) => page.id === previousSession.activePageId) ?? null;
  const previousActiveAfter = nextSession.pages.find((page) => page.id === previousSession.activePageId) ?? null;
  if (previousActiveBefore && previousActiveBefore.deletedAt === null && previousActiveBefore.isEphemeral && previousActiveAfter && previousActiveAfter.deletedAt === null && !previousActiveAfter.isEphemeral) {
    return previousActiveAfter.id;
  }
  return null;
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
test("normalizeSession repairs incomplete page data and keeps the most recently updated page active", () => {
  const session = normalizeSession({
    pages: [
      {
        id: "p-1",
        content: "alpha\r\nbeta",
        updatedAt: "2026-04-14T00:00:00.000Z"
      },
      {
        id: "p-2",
        title: "Saved",
        content: "",
        updatedAt: "2026-04-15T00:00:00.000Z"
      }
    ],
    activePageId: "missing"
  });
  assert.ok(session);
  assert.equal(session.pages.length, 2);
  const savedPage = session.pages[0];
  const repairedPage = session.pages[1];
  assert.ok(repairedPage);
  assert.ok(savedPage);
  assert.equal(savedPage?.title, "Saved");
  assert.equal(repairedPage?.content, "alpha\nbeta");
  assert.equal(repairedPage?.title, "alpha");
  assert.equal(repairedPage?.userId, ANONYMOUS_USERID);
  assert.equal(session.activePageId, "p-2");
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
test("hasVisibleEphemeralActivePage detects a visible placeholder as active", () => {
  const session = createSession();
  assert.equal(hasVisibleEphemeralActivePage(session), true);
  const materialized = updatePageState(session.pages[0], {
    text: "real note",
    selectionStart: 0,
    selectionEnd: 0
  });
  assert.equal(
    hasVisibleEphemeralActivePage({
      ...session,
      pages: [materialized]
    }),
    false
  );
});
test("getRemoteActivePageUpdateTarget returns the newly selected real page", () => {
  const previous = ensureValidActivePage({
    activePageId: "page-a",
    pages: [
      {
        ...createSession().pages[0],
        id: "page-a",
        title: "A",
        content: "alpha",
        text: "alpha",
        isEphemeral: false
      },
      {
        ...createSession().pages[0],
        id: "page-b",
        title: "B",
        content: "beta",
        text: "beta",
        isEphemeral: false
      }
    ]
  });
  const next = {
    ...previous,
    activePageId: "page-b"
  };
  assert.equal(getRemoteActivePageUpdateTarget(previous, next), "page-b");
});
test("getRemoteActivePageUpdateTarget returns the previous active page when add page promotes it", () => {
  const previous = createSession("user-a");
  const promoted = updatePageState(previous.pages[0], {
    text: "real note",
    selectionStart: 0,
    selectionEnd: 0
  });
  const nextEphemeral = createSession("user-a").pages[0];
  const next = ensureValidActivePage({
    pages: [promoted, { ...nextEphemeral, id: "page-b", userId: "user-a" }],
    activePageId: "page-b"
  });
  assert.equal(getRemoteActivePageUpdateTarget(previous, next), promoted.id);
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
test("ensureValidActivePage falls back to the most recently updated visible page when the active page is missing", () => {
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
      },
      {
        id: "page-b",
        userId: ANONYMOUS_USERID,
        title: "B",
        content: "beta",
        text: "beta",
        selectionStart: 0,
        selectionEnd: 0,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
        deletedAt: null,
        lastSyncedAt: null,
        lastKnownRemoteUpdatedAt: null,
        lastKnownRemoteDeletedAt: null,
        syncStatus: "dirty",
        isEphemeral: false
      }
    ]
  });
  assert.equal(repaired.pages[0]?.id, "page-b");
  assert.equal(repaired.activePageId, "page-b");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc2Vzc2lvbi50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgQU5PTllNT1VTX1VTRVJJRCwgdHlwZSBQYWdlU3luY1N0YXR1cyB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMnO1xuaW1wb3J0IHtcblx0Y2xvbmVQYWdlRm9yVXNlcixcblx0Y3JlYXRlU2Vzc2lvbixcblx0ZGVyaXZlUGFnZVRpdGxlLFxuXHRlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UsXG5cdGdldFJlbW90ZUFjdGl2ZVBhZ2VVcGRhdGVUYXJnZXQsXG5cdGhhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlLFxuXHRtYXJrUGFnZURpcnR5LFxuXHRub3JtYWxpemVTZXNzaW9uLFxuXHR1cGRhdGVQYWdlU3RhdGVcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxudGVzdCgnbm9ybWFsaXplU2Vzc2lvbiBtaWdyYXRlcyB0aGUgbGVnYWN5IHNpbmdsZS1kb2N1bWVudCBzdGF0ZSBpbnRvIG9uZSBwYWdlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbih7XG5cdFx0dGV4dDogJyMgVGl0bGVcXG5ib2R5Jyxcblx0XHRzZWxlY3Rpb25TdGFydDogMixcblx0XHRzZWxlY3Rpb25FbmQ6IDJcblx0fSk7XG5cblx0YXNzZXJ0Lm9rKHNlc3Npb24pO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJyMgVGl0bGVcXG5ib2R5Jyk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzBdPy50ZXh0LCAnIyBUaXRsZVxcbmJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXNbMF0/LnRpdGxlLCAnIyBUaXRsZScpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8udXNlcklkLCBBTk9OWU1PVVNfVVNFUklEKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8uaXNFcGhlbWVyYWwsIGZhbHNlKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uYWN0aXZlUGFnZUlkLCBzZXNzaW9uLnBhZ2VzWzBdPy5pZCk7XG59KTtcblxudGVzdCgnbm9ybWFsaXplU2Vzc2lvbiByZXBhaXJzIGluY29tcGxldGUgcGFnZSBkYXRhIGFuZCBrZWVwcyB0aGUgbW9zdCByZWNlbnRseSB1cGRhdGVkIHBhZ2UgYWN0aXZlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbih7XG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwLTEnLFxuXHRcdFx0XHRjb250ZW50OiAnYWxwaGFcXHJcXG5iZXRhJyxcblx0XHRcdFx0dXBkYXRlZEF0OiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJ1xuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwLTInLFxuXHRcdFx0XHR0aXRsZTogJ1NhdmVkJyxcblx0XHRcdFx0Y29udGVudDogJycsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWidcblx0XHRcdH1cblx0XHRdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogJ21pc3NpbmcnXG5cdH0pO1xuXG5cdGFzc2VydC5vayhzZXNzaW9uKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXMubGVuZ3RoLCAyKTtcblx0Y29uc3Qgc2F2ZWRQYWdlID0gc2Vzc2lvbi5wYWdlc1swXTtcblx0Y29uc3QgcmVwYWlyZWRQYWdlID0gc2Vzc2lvbi5wYWdlc1sxXTtcblx0YXNzZXJ0Lm9rKHJlcGFpcmVkUGFnZSk7XG5cdGFzc2VydC5vayhzYXZlZFBhZ2UpO1xuXHRhc3NlcnQuZXF1YWwoc2F2ZWRQYWdlPy50aXRsZSwgJ1NhdmVkJyk7XG5cdGFzc2VydC5lcXVhbChyZXBhaXJlZFBhZ2U/LmNvbnRlbnQsICdhbHBoYVxcbmJldGEnKTtcblx0YXNzZXJ0LmVxdWFsKHJlcGFpcmVkUGFnZT8udGl0bGUsICdhbHBoYScpO1xuXHRhc3NlcnQuZXF1YWwocmVwYWlyZWRQYWdlPy51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5hY3RpdmVQYWdlSWQsICdwLTInKTtcbn0pO1xuXG50ZXN0KCdjcmVhdGVTZXNzaW9uIHNlZWRzIGEgbG9jYWxseS1vd25lZCBkaXJ0eSBlcGhlbWVyYWwgcGFnZSBieSBkZWZhdWx0JywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBwYWdlID0gc2Vzc2lvbi5wYWdlc1swXSE7XG5cblx0YXNzZXJ0LmVxdWFsKHBhZ2UudGl0bGUsICdVbnRpdGxlZCcpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5kZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0U3luY2VkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UuaXNFcGhlbWVyYWwsIHRydWUpO1xufSk7XG5cbnRlc3QoJ2hhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlIGRldGVjdHMgYSB2aXNpYmxlIHBsYWNlaG9sZGVyIGFzIGFjdGl2ZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0YXNzZXJ0LmVxdWFsKGhhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlKHNlc3Npb24pLCB0cnVlKTtcblxuXHRjb25zdCBtYXRlcmlhbGl6ZWQgPSB1cGRhdGVQYWdlU3RhdGUoc2Vzc2lvbi5wYWdlc1swXSEsIHtcblx0XHR0ZXh0OiAncmVhbCBub3RlJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRoYXNWaXNpYmxlRXBoZW1lcmFsQWN0aXZlUGFnZSh7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXM6IFttYXRlcmlhbGl6ZWRdXG5cdFx0fSksXG5cdFx0ZmFsc2Vcblx0KTtcbn0pO1xuXG50ZXN0KCdnZXRSZW1vdGVBY3RpdmVQYWdlVXBkYXRlVGFyZ2V0IHJldHVybnMgdGhlIG5ld2x5IHNlbGVjdGVkIHJlYWwgcGFnZScsICgpID0+IHtcblx0Y29uc3QgcHJldmlvdXMgPSBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoe1xuXHRcdGFjdGl2ZVBhZ2VJZDogJ3BhZ2UtYScsXG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0Li4uY3JlYXRlU2Vzc2lvbigpLnBhZ2VzWzBdISxcblx0XHRcdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdFx0XHR0aXRsZTogJ0EnLFxuXHRcdFx0XHRjb250ZW50OiAnYWxwaGEnLFxuXHRcdFx0XHR0ZXh0OiAnYWxwaGEnLFxuXHRcdFx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdC4uLmNyZWF0ZVNlc3Npb24oKS5wYWdlc1swXSEsXG5cdFx0XHRcdGlkOiAncGFnZS1iJyxcblx0XHRcdFx0dGl0bGU6ICdCJyxcblx0XHRcdFx0Y29udGVudDogJ2JldGEnLFxuXHRcdFx0XHR0ZXh0OiAnYmV0YScsXG5cdFx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdFx0fVxuXHRcdF1cblx0fSk7XG5cblx0Y29uc3QgbmV4dCA9IHtcblx0XHQuLi5wcmV2aW91cyxcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWInXG5cdH07XG5cblx0YXNzZXJ0LmVxdWFsKGdldFJlbW90ZUFjdGl2ZVBhZ2VVcGRhdGVUYXJnZXQocHJldmlvdXMsIG5leHQpLCAncGFnZS1iJyk7XG59KTtcblxudGVzdCgnZ2V0UmVtb3RlQWN0aXZlUGFnZVVwZGF0ZVRhcmdldCByZXR1cm5zIHRoZSBwcmV2aW91cyBhY3RpdmUgcGFnZSB3aGVuIGFkZCBwYWdlIHByb21vdGVzIGl0JywgKCkgPT4ge1xuXHRjb25zdCBwcmV2aW91cyA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScpO1xuXHRjb25zdCBwcm9tb3RlZCA9IHVwZGF0ZVBhZ2VTdGF0ZShwcmV2aW91cy5wYWdlc1swXSEsIHtcblx0XHR0ZXh0OiAncmVhbCBub3RlJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGNvbnN0IG5leHRFcGhlbWVyYWwgPSBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnKS5wYWdlc1swXSE7XG5cblx0Y29uc3QgbmV4dCA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0cGFnZXM6IFtwcm9tb3RlZCwgeyAuLi5uZXh0RXBoZW1lcmFsLCBpZDogJ3BhZ2UtYicsIHVzZXJJZDogJ3VzZXItYScgfV0sXG5cdFx0YWN0aXZlUGFnZUlkOiAncGFnZS1iJ1xuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoZ2V0UmVtb3RlQWN0aXZlUGFnZVVwZGF0ZVRhcmdldChwcmV2aW91cywgbmV4dCksIHByb21vdGVkLmlkKTtcbn0pO1xuXG50ZXN0KCd1cGRhdGVQYWdlU3RhdGUgcmVmcmVzaGVzIGNvbnRlbnQsIGRlcml2ZXMgdGl0bGVzLCBhbmQgbWF0ZXJpYWxpemVzIHRoZSBwYWdlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKHNlc3Npb24ucGFnZXNbMF0hLCB7XG5cdFx0dGV4dDogJ1xcblxcbmNvbnN0IHZhbHVlID0gMTsnLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiA0LFxuXHRcdHNlbGVjdGlvbkVuZDogNFxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwocGFnZS5jb250ZW50LCAnXFxuXFxuY29uc3QgdmFsdWUgPSAxOycpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS50aXRsZSwgJ2NvbnN0IHZhbHVlID0gMTsnKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2Uuc2VsZWN0aW9uU3RhcnQsIDQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zZWxlY3Rpb25FbmQsIDQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UuaXNFcGhlbWVyYWwsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCd1cGRhdGVQYWdlU3RhdGUga2VlcHMgY3VzdG9tIHRpdGxlcyBkdXJpbmcgY29udGVudCBlZGl0cycsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3QgaW5pdGlhbCA9IHNlc3Npb24ucGFnZXNbMF0hO1xuXHRjb25zdCBjdXN0b21UaXRsZVBhZ2UgPSB7XG5cdFx0Li4uaW5pdGlhbCxcblx0XHR0aXRsZTogJ0N1c3RvbSB0aXRsZSdcblx0fTtcblxuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGN1c3RvbVRpdGxlUGFnZSwge1xuXHRcdHRleHQ6ICdmaXJzdCBsaW5lXFxuYm9keScsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDEsXG5cdFx0c2VsZWN0aW9uRW5kOiAxXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChwYWdlLnRpdGxlLCAnQ3VzdG9tIHRpdGxlJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmNvbnRlbnQsICdmaXJzdCBsaW5lXFxuYm9keScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ3VwZGF0ZVBhZ2VTdGF0ZSBrZWVwcyBwYWdlIHN5bmMgbWV0YWRhdGEgc3RhYmxlIGZvciBzZWxlY3Rpb24tb25seSB1cGRhdGVzJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBpbml0aWFsID0gdXBkYXRlUGFnZVN0YXRlKHNlc3Npb24ucGFnZXNbMF0hLCB7XG5cdFx0dGV4dDogJ2FscGhhJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGNvbnN0IHNlbGVjdGlvbk9ubHkgPSB1cGRhdGVQYWdlU3RhdGUoaW5pdGlhbCwge1xuXHRcdHRleHQ6ICdhbHBoYScsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDIsXG5cdFx0c2VsZWN0aW9uRW5kOiAyXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnRpdGxlLCAnYWxwaGEnKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkudXBkYXRlZEF0LCBpbml0aWFsLnVwZGF0ZWRBdCk7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnNlbGVjdGlvblN0YXJ0LCAyKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuc2VsZWN0aW9uRW5kLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuc3luY1N0YXR1cywgaW5pdGlhbC5zeW5jU3RhdHVzKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuaXNFcGhlbWVyYWwsIGluaXRpYWwuaXNFcGhlbWVyYWwpO1xufSk7XG5cbnRlc3QoJ21hcmtQYWdlRGlydHkgcmV0YXJnZXRzIGNvcGllZCBwYWdlcyB0byBhIG5ldyBvd25lciBhbmQgY2xlYXJzIHJlbW90ZSBzdGF0ZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScpO1xuXHRjb25zdCBjb3BpZWQgPSBtYXJrUGFnZURpcnR5KFxuXHRcdHtcblx0XHRcdC4uLnNlc3Npb24ucGFnZXNbMF0hLFxuXHRcdFx0c3luY1N0YXR1czogJ3N5bmNlZCcgYXMgUGFnZVN5bmNTdGF0dXMsXG5cdFx0XHRsYXN0U3luY2VkQXQ6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJyxcblx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdH0sXG5cdFx0J3VzZXItYidcblx0KTtcblxuXHRhc3NlcnQuZXF1YWwoY29waWVkLnVzZXJJZCwgJ3VzZXItYicpO1xuXHRhc3NlcnQuZXF1YWwoY29waWVkLnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQuZXF1YWwoY29waWVkLmxhc3RTeW5jZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChjb3BpZWQubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0LmVxdWFsKGNvcGllZC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsIG51bGwpO1xufSk7XG5cbnRlc3QoJ2Nsb25lUGFnZUZvclVzZXIgY3JlYXRlcyBhIGZyZXNoIGxvY2FsIHBhZ2UgaWQgZm9yIGltcG9ydGVkIGFub255bW91cyBkYXRhJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbihBTk9OWU1PVVNfVVNFUklEKTtcblx0Y29uc3Qgc291cmNlID0ge1xuXHRcdC4uLnNlc3Npb24ucGFnZXNbMF0hLFxuXHRcdGlkOiAnYW5vbi1wYWdlLTEnLFxuXHRcdHRpdGxlOiAnSW1wb3J0ZWQgdGl0bGUnLFxuXHRcdGNvbnRlbnQ6ICdpbXBvcnRlZCBib2R5Jyxcblx0XHR0ZXh0OiAnaW1wb3J0ZWQgYm9keScsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xuXG5cdGNvbnN0IGNsb25lZCA9IGNsb25lUGFnZUZvclVzZXIoc291cmNlLCAndXNlci1hJyk7XG5cblx0YXNzZXJ0Lm5vdEVxdWFsKGNsb25lZC5pZCwgc291cmNlLmlkKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC51c2VySWQsICd1c2VyLWEnKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC50aXRsZSwgJ0ltcG9ydGVkIHRpdGxlJyk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQuY29udGVudCwgJ2ltcG9ydGVkIGJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ2Rlcml2ZVBhZ2VUaXRsZSBmYWxscyBiYWNrIHRvIFVudGl0bGVkIGZvciBibGFuayBjb250ZW50JywgKCkgPT4ge1xuXHRhc3NlcnQuZXF1YWwoZGVyaXZlUGFnZVRpdGxlKCcgICBcXG4gICcpLCAnVW50aXRsZWQnKTtcbn0pO1xuXG50ZXN0KCdlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UgZmFsbHMgYmFjayB0byB0aGUgbW9zdCByZWNlbnRseSB1cGRhdGVkIHZpc2libGUgcGFnZSB3aGVuIHRoZSBhY3RpdmUgcGFnZSBpcyBtaXNzaW5nJywgKCkgPT4ge1xuXHRjb25zdCByZXBhaXJlZCA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0YWN0aXZlUGFnZUlkOiAnbWlzc2luZycsXG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdFx0XHR1c2VySWQ6IEFOT05ZTU9VU19VU0VSSUQsXG5cdFx0XHRcdHRpdGxlOiAnQScsXG5cdFx0XHRcdGNvbnRlbnQ6ICdhbHBoYScsXG5cdFx0XHRcdHRleHQ6ICdhbHBoYScsXG5cdFx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0XHRcdGNyZWF0ZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogJ3BhZ2UtYicsXG5cdFx0XHRcdHVzZXJJZDogQU5PTllNT1VTX1VTRVJJRCxcblx0XHRcdFx0dGl0bGU6ICdCJyxcblx0XHRcdFx0Y29udGVudDogJ2JldGEnLFxuXHRcdFx0XHR0ZXh0OiAnYmV0YScsXG5cdFx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0XHRcdGNyZWF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0XHR9XG5cdFx0XVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwocmVwYWlyZWQucGFnZXNbMF0/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChyZXBhaXJlZC5hY3RpdmVQYWdlSWQsICdwYWdlLWInKTtcbn0pO1xuIiwgImV4cG9ydCBjb25zdCBCTEFOS19EQl9OQU1FID0gJ2JsYW5rJztcbmV4cG9ydCBjb25zdCBCTEFOS19EQl9WRVJTSU9OID0gMTtcbmV4cG9ydCBjb25zdCBQQUdFU19TVE9SRV9OQU1FID0gJ3BhZ2VzJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HU19TVE9SRV9OQU1FID0gJ3NldHRpbmdzJztcbmV4cG9ydCBjb25zdCBVU0VSX0lEX0lOREVYID0gJ3VzZXJJZCc7XG5leHBvcnQgY29uc3QgVVBEQVRFRF9BVF9JTkRFWCA9ICd1cGRhdGVkQXQnO1xuXG5leHBvcnQgY29uc3QgQU5PTllNT1VTX1VTRVJJRCA9ICdhbm9ueW1vdXMnO1xuXG5leHBvcnQgdHlwZSBQYWdlU3luY1N0YXR1cyA9ICdzeW5jZWQnIHwgJ2RpcnR5JyB8ICdwZW5kaW5nX3B1c2gnIHwgJ2NvbmZsaWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBQYWdlUmVjb3JkIHtcblx0aWQ6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcjtcblx0c2VsZWN0aW9uRW5kOiBudW1iZXI7XG5cdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRzeW5jU3RhdHVzOiBQYWdlU3luY1N0YXR1cztcblx0aXNFcGhlbWVyYWw6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ1JlY29yZCB7XG5cdGtleTogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZyB8IG51bGw7XG5cdHZhbHVlOiB1bmtub3duO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQgPSAnYWN0aXZlUGFnZUlkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1RIRU1FID0gJ3RoZW1lJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSA9ICd3b3JkQ291bnRWaXNpYmlsaXR5JztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCA9ICdzcGVsbGNoZWNrRW5hYmxlZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQgPSAnaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQnO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcbmltcG9ydCB7XG5cdEFOT05ZTU9VU19VU0VSSUQsXG5cdHR5cGUgUGFnZVJlY29yZCxcblx0dHlwZSBQYWdlU3luY1N0YXR1c1xufSBmcm9tICcuLi9wZXJzaXN0ZW5jZS9yZWNvcmRzJztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQYWdlIGV4dGVuZHMgRWRpdG9yU3RhdGUsIFBhZ2VSZWNvcmQge31cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JTZXNzaW9uIHtcblx0cGFnZXM6IEVkaXRvclBhZ2VbXTtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBVTlRJVExFRF9QQUdFID0gJ1VudGl0bGVkJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVBhZ2VUaXRsZShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaXJzdExpbmUgPSBjb250ZW50XG5cdFx0LnNwbGl0KCdcXG4nKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG5cdGlmICghZmlyc3RMaW5lKSB7XG5cdFx0cmV0dXJuIFVOVElUTEVEX1BBR0U7XG5cdH1cblxuXHRyZXR1cm4gZmlyc3RMaW5lLnJlcGxhY2UoL1xccysvZywgJyAnKS5zbGljZSgwLCA0OCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYWdlKFxuXHRjb250ZW50ID0gJycsXG5cdG9wdGlvbnM6IHtcblx0XHRpZD86IHN0cmluZztcblx0XHR1c2VySWQ/OiBzdHJpbmc7XG5cdFx0bm93Pzogc3RyaW5nO1xuXHRcdGlzRXBoZW1lcmFsPzogYm9vbGVhbjtcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IG9wdGlvbnMuaXNFcGhlbWVyYWwgPz8gdHJ1ZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbih1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSBjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHNvcnRQYWdlc0J5UmVjZW5jeShzZXNzaW9uLnBhZ2VzKTtcblx0aWYgKHBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXNcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgZmlyc3RWaXNpYmxlUGFnZSA9IHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdHBhZ2VzLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBmaXJzdFZpc2libGVQYWdlLmlkXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4uc2Vzc2lvbixcblx0XHRwYWdlcyxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzVmlzaWJsZUVwaGVtZXJhbEFjdGl2ZVBhZ2Uoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbikge1xuXHRjb25zdCBhY3RpdmVQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0cmV0dXJuICEhYWN0aXZlUGFnZSAmJiBhY3RpdmVQYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCAmJiBhY3RpdmVQYWdlLmlzRXBoZW1lcmFsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVtb3RlRWxpZ2libGVBY3RpdmVQYWdlSWQoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IHN0cmluZyB8IG51bGwge1xuXHRjb25zdCBhY3RpdmVQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0aWYgKCFhY3RpdmVQYWdlIHx8IGFjdGl2ZVBhZ2UuZGVsZXRlZEF0ICE9PSBudWxsIHx8IGFjdGl2ZVBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdHJldHVybiBhY3RpdmVQYWdlLmlkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVtb3RlQWN0aXZlUGFnZVVwZGF0ZVRhcmdldChcblx0cHJldmlvdXNTZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRuZXh0U2Vzc2lvbjogRWRpdG9yU2Vzc2lvblxuKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IG5leHRBY3RpdmVQYWdlSWQgPSBnZXRSZW1vdGVFbGlnaWJsZUFjdGl2ZVBhZ2VJZChuZXh0U2Vzc2lvbik7XG5cdGlmIChuZXh0QWN0aXZlUGFnZUlkICYmIG5leHRBY3RpdmVQYWdlSWQgIT09IHByZXZpb3VzU2Vzc2lvbi5hY3RpdmVQYWdlSWQpIHtcblx0XHRyZXR1cm4gbmV4dEFjdGl2ZVBhZ2VJZDtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzQWN0aXZlQmVmb3JlID0gcHJldmlvdXNTZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHByZXZpb3VzU2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGNvbnN0IHByZXZpb3VzQWN0aXZlQWZ0ZXIgPSBuZXh0U2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmlkID09PSBwcmV2aW91c1Nlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRpZiAoXG5cdFx0cHJldmlvdXNBY3RpdmVCZWZvcmUgJiZcblx0XHRwcmV2aW91c0FjdGl2ZUJlZm9yZS5kZWxldGVkQXQgPT09IG51bGwgJiZcblx0XHRwcmV2aW91c0FjdGl2ZUJlZm9yZS5pc0VwaGVtZXJhbCAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQWZ0ZXIgJiZcblx0XHRwcmV2aW91c0FjdGl2ZUFmdGVyLmRlbGV0ZWRBdCA9PT0gbnVsbCAmJlxuXHRcdCFwcmV2aW91c0FjdGl2ZUFmdGVyLmlzRXBoZW1lcmFsXG5cdCkge1xuXHRcdHJldHVybiBwcmV2aW91c0FjdGl2ZUFmdGVyLmlkO1xuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlU3RhdGUocGFnZTogRWRpdG9yUGFnZSwgc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNvbnRlbnRDaGFuZ2VkID0gc3RhdGUudGV4dCAhPT0gcGFnZS5jb250ZW50O1xuXHRjb25zdCBzZWxlY3Rpb25DaGFuZ2VkID1cblx0XHRzdGF0ZS5zZWxlY3Rpb25TdGFydCAhPT0gcGFnZS5zZWxlY3Rpb25TdGFydCB8fCBzdGF0ZS5zZWxlY3Rpb25FbmQgIT09IHBhZ2Uuc2VsZWN0aW9uRW5kO1xuXHRpZiAoIWNvbnRlbnRDaGFuZ2VkICYmICFzZWxlY3Rpb25DaGFuZ2VkKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRjb25zdCBuZXh0UGFnZTogRWRpdG9yUGFnZSA9IHtcblx0XHQuLi5wYWdlLFxuXHRcdC4uLnN0YXRlLFxuXHRcdGNvbnRlbnQ6IHN0YXRlLnRleHRcblx0fTtcblxuXHRpZiAoIWNvbnRlbnRDaGFuZ2VkKSB7XG5cdFx0cmV0dXJuIG5leHRQYWdlO1xuXHR9XG5cblx0Y29uc3QgcHJldmlvdXNEZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUocGFnZS5jb250ZW50KTtcblx0Y29uc3QgbmV4dERlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShzdGF0ZS50ZXh0KTtcblx0Y29uc3Qgc2hvdWxkQXV0b0Rlcml2ZVRpdGxlID0gcGFnZS50aXRsZSA9PT0gcHJldmlvdXNEZXJpdmVkVGl0bGU7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5uZXh0UGFnZSxcblx0XHR0aXRsZTogc2hvdWxkQXV0b0Rlcml2ZVRpdGxlID8gbmV4dERlcml2ZWRUaXRsZSA6IHBhZ2UudGl0bGUsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlVGl0bGUocGFnZTogRWRpdG9yUGFnZSwgdGl0bGU6IHN0cmluZyk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0cmltbWVkID0gdGl0bGUudHJpbSgpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dGl0bGU6IHRyaW1tZWQubGVuZ3RoID4gMCA/IHRyaW1tZWQuc2xpY2UoMCwgNDgpIDogVU5USVRMRURfUEFHRSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGVsZXRlZChwYWdlOiBFZGl0b3JQYWdlLCBkZWxldGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdGRlbGV0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IGRlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGVyaWFsaXplUGFnZShwYWdlOiBFZGl0b3JQYWdlKTogRWRpdG9yUGFnZSB7XG5cdGlmICghcGFnZS5pc0VwaGVtZXJhbCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xvbmVQYWdlRm9yVXNlcihwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjbG9uZWQgPSBjcmVhdGVQYWdlKHBhZ2UuY29udGVudCwgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiBmYWxzZSB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5jbG9uZWQsXG5cdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdHRleHQ6IHBhZ2UuY29udGVudCxcblx0XHRkZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURpcnR5KHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZCA9IHBhZ2UudXNlcklkKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR1c2VySWQsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0c3luY1N0YXR1czogcGFnZS5zeW5jU3RhdHVzID09PSAnY29uZmxpY3QnID8gJ2NvbmZsaWN0JyA6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb24odmFsdWU6IHVua25vd24sIHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRpZiAoaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZSkpIHtcblx0XHRyZXR1cm4gbWlncmF0ZUxlZ2FjeVN0YXRlKHZhbHVlLCB1c2VySWQpO1xuXHR9XG5cblx0aWYgKCFBcnJheS5pc0FycmF5KHZhbHVlLnBhZ2VzKSkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0Y29uc3QgcGFnZXMgPSB2YWx1ZS5wYWdlc1xuXHRcdC5tYXAoKHBhZ2UsIGluZGV4KSA9PiBub3JtYWxpemVQYWdlKHBhZ2UsIGluZGV4LCB1c2VySWQpKVxuXHRcdC5maWx0ZXIoKHBhZ2UpOiBwYWdlIGlzIEVkaXRvclBhZ2UgPT4gcGFnZSAhPT0gbnVsbClcblx0LnNvcnQoY29tcGFyZVBhZ2VzQnlSZWNlbmN5KTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24odXNlcklkKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pLCBzdGF0ZSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGFnZSh2YWx1ZTogdW5rbm93biwgaW5kZXg6IG51bWJlciwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLmNyZWF0ZWRBdCwgdmFsdWUuY3JlYXRlZF9hdCk7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUudXBkYXRlZEF0LCB2YWx1ZS51cGRhdGVkX2F0KSA/PyBjcmVhdGVkQXQ7XG5cdGNvbnN0IGRlbGV0ZWRBdCA9IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5kZWxldGVkQXQsIHZhbHVlLmRlbGV0ZWRfYXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXgpLFxuXHRcdHVzZXJJZDogdHlwZW9mIHZhbHVlLnVzZXJJZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUudXNlcklkLmxlbmd0aCA+IDAgPyB2YWx1ZS51c2VySWQgOiB1c2VySWQsXG5cdFx0dGl0bGU6XG5cdFx0XHR0eXBlb2YgdmFsdWUudGl0bGUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdDogZGVyaXZlUGFnZVRpdGxlKG5vcm1hbGl6ZWRDb250ZW50KSxcblx0XHRjb250ZW50OiBub3JtYWxpemVkQ29udGVudCxcblx0XHR0ZXh0OiBub3JtYWxpemVkQ29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdFN5bmNlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCksXG5cdFx0c3luY1N0YXR1czogbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogdHlwZW9mIHZhbHVlLmlzRXBoZW1lcmFsID09PSAnYm9vbGVhbicgPyB2YWx1ZS5pc0VwaGVtZXJhbCA6IGZhbHNlXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYHBhZ2UtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogUGFnZVN5bmNTdGF0dXMpOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNvcnRQYWdlc0J5UmVjZW5jeShwYWdlczogRWRpdG9yUGFnZVtdKSB7XG5cdHJldHVybiBbLi4ucGFnZXNdLnNvcnQoY29tcGFyZVBhZ2VzQnlSZWNlbmN5KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVQYWdlc0J5UmVjZW5jeShsZWZ0OiBFZGl0b3JQYWdlLCByaWdodDogRWRpdG9yUGFnZSkge1xuXHRpZiAobGVmdC51cGRhdGVkQXQgIT09IHJpZ2h0LnVwZGF0ZWRBdCkge1xuXHRcdHJldHVybiByaWdodC51cGRhdGVkQXQubG9jYWxlQ29tcGFyZShsZWZ0LnVwZGF0ZWRBdCk7XG5cdH1cblxuXHRpZiAobGVmdC5jcmVhdGVkQXQgIT09IHJpZ2h0LmNyZWF0ZWRBdCkge1xuXHRcdHJldHVybiByaWdodC5jcmVhdGVkQXQubG9jYWxlQ29tcGFyZShsZWZ0LmNyZWF0ZWRBdCk7XG5cdH1cblxuXHRyZXR1cm4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUNNWixJQUFNLG1CQUFtQjs7O0FDT3pCLElBQU0sZ0JBQWdCO0FBRXRCLFNBQVMsZ0JBQWdCLFNBQXlCO0FBQ3hELFFBQU0sWUFBWSxRQUNoQixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQztBQUVoQyxNQUFJLENBQUMsV0FBVztBQUNmLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTyxVQUFVLFFBQVEsUUFBUSxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFD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QUFBLElBQ0osT0FBTztBQUFBLElBQ1AsU0FBUztBQUFBLElBQ1QsTUFBTTtBQUFBLElBQ04sV0FBVztBQUFBLElBQ1gsYUFBYTtBQUFBLEVBQ2Q7QUFFQSxRQUFNLFNBQVMsaUJBQWlCLFFBQVEsUUFBUTtBQUVoRCxTQUFPLFNBQVMsT0FBTyxJQUFJLE9BQU8sRUFBRTtBQUNwQyxTQUFPLE1BQU0sT0FBTyxRQUFRLFFBQVE7QUFDcEMsU0FBTyxNQUFNLE9BQU8sT0FBTyxnQkFBZ0I7QUFDM0MsU0FBTyxNQUFNLE9BQU8sU0FBUyxlQUFlO0FBQzVDLFNBQU8sTUFBTSxPQUFPLFlBQVksT0FBTztBQUN2QyxTQUFPLE1BQU0sT0FBTyxhQUFhLEtBQUs7QUFDdkMsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDdEUsU0FBTyxNQUFNLGdCQUFnQixTQUFTLEdBQUcsVUFBVTtBQUNwRCxDQUFDO0FBRUQsS0FBSyw4R0FBOEcsTUFBTTtBQUN4SCxRQUFNLFdBQVcsc0JBQXNCO0FBQUEsSUFDdEMsY0FBYztBQUFBLElBQ2QsT0FBTztBQUFBLE1BQ047QUFBQSxRQUNDLElBQUk7QUFBQSxRQUNKLFFBQVE7QUFBQSxRQUNSLE9BQU87QUFBQSxRQUNQLFNBQVM7QUFBQSxRQUNULE1BQU07QUFBQSxRQUNOLGdCQUFnQjtBQUFBLFFBQ2hCLGNBQWM7QUFBQSxRQUNkLFdBQVc7QUFBQSxRQUNYLFdBQVc7QUFBQSxRQUNYLFdBQVc7QUFBQSxRQUNYLGNBQWM7QUFBQSxRQUNkLDBCQUEwQjtBQUFBLFFBQzFCLDBCQUEwQjtBQUFBLFFBQzFCLFlBQVk7QUFBQSxRQUNaLGFBQWE7QUFBQSxNQUNkO0FBQUEsTUFDQTtBQUFBLFFBQ0MsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsT0FBTztBQUFBLFFBQ1AsU0FBUztBQUFBLFFBQ1QsTUFBTTtBQUFBLFFBQ04sZ0JBQWdCO0FBQUEsUUFDaEIsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLFFBQ1gsV0FBVztBQUFBLFFBQ1gsV0FBVztBQUFBLFFBQ1gsY0FBYztBQUFBLFFBQ2QsMEJBQTBCO0FBQUEsUUFDMUIsMEJBQTBCO0FBQUEsUUFDMUIsWUFBWTtBQUFBLFFBQ1osYUFBYTtBQUFBLE1BQ2Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsSUFBSSxRQUFRO0FBQzVDLFNBQU8sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUM3QyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
