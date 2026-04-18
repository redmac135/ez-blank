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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc2Vzc2lvbi50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgQU5PTllNT1VTX1VTRVJJRCwgdHlwZSBQYWdlU3luY1N0YXR1cyB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMnO1xuaW1wb3J0IHtcblx0Y2xvbmVQYWdlRm9yVXNlcixcblx0Y3JlYXRlU2Vzc2lvbixcblx0ZGVyaXZlUGFnZVRpdGxlLFxuXHRlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UsXG5cdGdldFJlbW90ZUFjdGl2ZVBhZ2VVcGRhdGVUYXJnZXQsXG5cdGhhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlLFxuXHRtYXJrUGFnZURpcnR5LFxuXHRub3JtYWxpemVTZXNzaW9uLFxuXHR1cGRhdGVQYWdlU3RhdGVcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxudGVzdCgnbm9ybWFsaXplU2Vzc2lvbiBtaWdyYXRlcyB0aGUgbGVnYWN5IHNpbmdsZS1kb2N1bWVudCBzdGF0ZSBpbnRvIG9uZSBwYWdlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbih7XG5cdFx0dGV4dDogJyMgVGl0bGVcXG5ib2R5Jyxcblx0XHRzZWxlY3Rpb25TdGFydDogMixcblx0XHRzZWxlY3Rpb25FbmQ6IDJcblx0fSk7XG5cblx0YXNzZXJ0Lm9rKHNlc3Npb24pO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJyMgVGl0bGVcXG5ib2R5Jyk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzBdPy50ZXh0LCAnIyBUaXRsZVxcbmJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXNbMF0/LnRpdGxlLCAnIyBUaXRsZScpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8udXNlcklkLCBBTk9OWU1PVVNfVVNFUklEKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8uaXNFcGhlbWVyYWwsIGZhbHNlKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uYWN0aXZlUGFnZUlkLCBzZXNzaW9uLnBhZ2VzWzBdPy5pZCk7XG59KTtcblxudGVzdCgnbm9ybWFsaXplU2Vzc2lvbiByZXBhaXJzIGluY29tcGxldGUgcGFnZSBkYXRhIGFuZCBrZWVwcyB0aGUgbW9zdCByZWNlbnRseSB1cGRhdGVkIHBhZ2UgYWN0aXZlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gbm9ybWFsaXplU2Vzc2lvbih7XG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwLTEnLFxuXHRcdFx0XHRjb250ZW50OiAnYWxwaGFcXHJcXG5iZXRhJyxcblx0XHRcdFx0dXBkYXRlZEF0OiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJ1xuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwLTInLFxuXHRcdFx0XHR0aXRsZTogJ1NhdmVkJyxcblx0XHRcdFx0Y29udGVudDogJycsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWidcblx0XHRcdH1cblx0XHRdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogJ21pc3NpbmcnXG5cdH0pO1xuXG5cdGFzc2VydC5vayhzZXNzaW9uKTtcblx0YXNzZXJ0LmVxdWFsKHNlc3Npb24ucGFnZXMubGVuZ3RoLCAyKTtcblx0Y29uc3Qgc2F2ZWRQYWdlID0gc2Vzc2lvbi5wYWdlc1swXTtcblx0Y29uc3QgcmVwYWlyZWRQYWdlID0gc2Vzc2lvbi5wYWdlc1sxXTtcblx0YXNzZXJ0Lm9rKHJlcGFpcmVkUGFnZSk7XG5cdGFzc2VydC5vayhzYXZlZFBhZ2UpO1xuXHRhc3NlcnQuZXF1YWwoc2F2ZWRQYWdlPy50aXRsZSwgJ1NhdmVkJyk7XG5cdGFzc2VydC5lcXVhbChyZXBhaXJlZFBhZ2U/LmNvbnRlbnQsICdhbHBoYVxcbmJldGEnKTtcblx0YXNzZXJ0LmVxdWFsKHJlcGFpcmVkUGFnZT8udGl0bGUsICdhbHBoYScpO1xuXHRhc3NlcnQuZXF1YWwocmVwYWlyZWRQYWdlPy51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5hY3RpdmVQYWdlSWQsICdwLTInKTtcbn0pO1xuXG50ZXN0KCdjcmVhdGVTZXNzaW9uIHNlZWRzIGEgbG9jYWxseS1vd25lZCBkaXJ0eSBlcGhlbWVyYWwgcGFnZSBieSBkZWZhdWx0JywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBwYWdlID0gc2Vzc2lvbi5wYWdlc1swXSE7XG5cblx0YXNzZXJ0LmVxdWFsKHBhZ2UudGl0bGUsICdVbnRpdGxlZCcpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS51c2VySWQsIEFOT05ZTU9VU19VU0VSSUQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5kZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0U3luY2VkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UuaXNFcGhlbWVyYWwsIHRydWUpO1xufSk7XG5cbnRlc3QoJ2hhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlIGRldGVjdHMgYSB2aXNpYmxlIHBsYWNlaG9sZGVyIGFzIGFjdGl2ZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0YXNzZXJ0LmVxdWFsKGhhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlKHNlc3Npb24pLCB0cnVlKTtcblxuXHRjb25zdCBtYXRlcmlhbGl6ZWQgPSB1cGRhdGVQYWdlU3RhdGUoc2Vzc2lvbi5wYWdlc1swXSEsIHtcblx0XHR0ZXh0OiAncmVhbCBub3RlJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRoYXNWaXNpYmxlRXBoZW1lcmFsQWN0aXZlUGFnZSh7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXM6IFttYXRlcmlhbGl6ZWRdXG5cdFx0fSksXG5cdFx0ZmFsc2Vcblx0KTtcbn0pO1xuXG50ZXN0KCdnZXRSZW1vdGVBY3RpdmVQYWdlVXBkYXRlVGFyZ2V0IHJldHVybnMgdGhlIG5ld2x5IHNlbGVjdGVkIHJlYWwgcGFnZScsICgpID0+IHtcblx0Y29uc3QgcHJldmlvdXMgPSBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoe1xuXHRcdGFjdGl2ZVBhZ2VJZDogJ3BhZ2UtYScsXG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0Li4uY3JlYXRlU2Vzc2lvbigpLnBhZ2VzWzBdISxcblx0XHRcdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdFx0XHR0aXRsZTogJ0EnLFxuXHRcdFx0XHRjb250ZW50OiAnYWxwaGEnLFxuXHRcdFx0XHR0ZXh0OiAnYWxwaGEnLFxuXHRcdFx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdC4uLmNyZWF0ZVNlc3Npb24oKS5wYWdlc1swXSEsXG5cdFx0XHRcdGlkOiAncGFnZS1iJyxcblx0XHRcdFx0dGl0bGU6ICdCJyxcblx0XHRcdFx0Y29udGVudDogJ2JldGEnLFxuXHRcdFx0XHR0ZXh0OiAnYmV0YScsXG5cdFx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdFx0fVxuXHRcdF1cblx0fSk7XG5cblx0Y29uc3QgbmV4dCA9IHtcblx0XHQuLi5wcmV2aW91cyxcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLWInXG5cdH07XG5cblx0YXNzZXJ0LmVxdWFsKGdldFJlbW90ZUFjdGl2ZVBhZ2VVcGRhdGVUYXJnZXQocHJldmlvdXMsIG5leHQpLCAncGFnZS1iJyk7XG59KTtcblxudGVzdCgnZ2V0UmVtb3RlQWN0aXZlUGFnZVVwZGF0ZVRhcmdldCByZXR1cm5zIHRoZSBwcmV2aW91cyBhY3RpdmUgcGFnZSB3aGVuIGFkZCBwYWdlIHByb21vdGVzIGl0JywgKCkgPT4ge1xuXHRjb25zdCBwcmV2aW91cyA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScpO1xuXHRjb25zdCBwcm9tb3RlZCA9IHVwZGF0ZVBhZ2VTdGF0ZShwcmV2aW91cy5wYWdlc1swXSEsIHtcblx0XHR0ZXh0OiAncmVhbCBub3RlJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGNvbnN0IG5leHRFcGhlbWVyYWwgPSBjcmVhdGVTZXNzaW9uKCd1c2VyLWEnKS5wYWdlc1swXSE7XG5cblx0Y29uc3QgbmV4dCA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0cGFnZXM6IFtwcm9tb3RlZCwgeyAuLi5uZXh0RXBoZW1lcmFsLCBpZDogJ3BhZ2UtYicsIHVzZXJJZDogJ3VzZXItYScgfV0sXG5cdFx0YWN0aXZlUGFnZUlkOiAncGFnZS1iJ1xuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoZ2V0UmVtb3RlQWN0aXZlUGFnZVVwZGF0ZVRhcmdldChwcmV2aW91cywgbmV4dCksIHByb21vdGVkLmlkKTtcbn0pO1xuXG50ZXN0KCd1cGRhdGVQYWdlU3RhdGUgcmVmcmVzaGVzIGNvbnRlbnQsIGRlcml2ZXMgdGl0bGVzLCBhbmQgbWF0ZXJpYWxpemVzIHRoZSBwYWdlJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKHNlc3Npb24ucGFnZXNbMF0hLCB7XG5cdFx0dGV4dDogJ1xcblxcbmNvbnN0IHZhbHVlID0gMTsnLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiA0LFxuXHRcdHNlbGVjdGlvbkVuZDogNFxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwocGFnZS5jb250ZW50LCAnXFxuXFxuY29uc3QgdmFsdWUgPSAxOycpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS50aXRsZSwgJ2NvbnN0IHZhbHVlID0gMTsnKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2Uuc2VsZWN0aW9uU3RhcnQsIDQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zZWxlY3Rpb25FbmQsIDQpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKHBhZ2UuaXNFcGhlbWVyYWwsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCd1cGRhdGVQYWdlU3RhdGUga2VlcHMgY3VzdG9tIHRpdGxlcyBkdXJpbmcgY29udGVudCBlZGl0cycsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3QgaW5pdGlhbCA9IHNlc3Npb24ucGFnZXNbMF0hO1xuXHRjb25zdCBjdXN0b21UaXRsZVBhZ2UgPSB7XG5cdFx0Li4uaW5pdGlhbCxcblx0XHR0aXRsZTogJ0N1c3RvbSB0aXRsZSdcblx0fTtcblxuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGN1c3RvbVRpdGxlUGFnZSwge1xuXHRcdHRleHQ6ICdmaXJzdCBsaW5lXFxuYm9keScsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDEsXG5cdFx0c2VsZWN0aW9uRW5kOiAxXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChwYWdlLnRpdGxlLCAnQ3VzdG9tIHRpdGxlJyk7XG5cdGFzc2VydC5lcXVhbChwYWdlLmNvbnRlbnQsICdmaXJzdCBsaW5lXFxuYm9keScpO1xuXHRhc3NlcnQuZXF1YWwocGFnZS5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ3VwZGF0ZVBhZ2VTdGF0ZSBrZWVwcyBwYWdlIHN5bmMgbWV0YWRhdGEgc3RhYmxlIGZvciBzZWxlY3Rpb24tb25seSB1cGRhdGVzJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBpbml0aWFsID0gdXBkYXRlUGFnZVN0YXRlKHNlc3Npb24ucGFnZXNbMF0hLCB7XG5cdFx0dGV4dDogJ2FscGhhJyxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0fSk7XG5cdGNvbnN0IHNlbGVjdGlvbk9ubHkgPSB1cGRhdGVQYWdlU3RhdGUoaW5pdGlhbCwge1xuXHRcdHRleHQ6ICdhbHBoYScsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDIsXG5cdFx0c2VsZWN0aW9uRW5kOiAyXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnRpdGxlLCAnYWxwaGEnKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkudXBkYXRlZEF0LCBpbml0aWFsLnVwZGF0ZWRBdCk7XG5cdGFzc2VydC5lcXVhbChzZWxlY3Rpb25Pbmx5LnNlbGVjdGlvblN0YXJ0LCAyKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuc2VsZWN0aW9uRW5kLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuc3luY1N0YXR1cywgaW5pdGlhbC5zeW5jU3RhdHVzKTtcblx0YXNzZXJ0LmVxdWFsKHNlbGVjdGlvbk9ubHkuaXNFcGhlbWVyYWwsIGluaXRpYWwuaXNFcGhlbWVyYWwpO1xufSk7XG5cbnRlc3QoJ21hcmtQYWdlRGlydHkgcmV0YXJnZXRzIGNvcGllZCBwYWdlcyB0byBhIG5ldyBvd25lciBhbmQgY2xlYXJzIHJlbW90ZSBzdGF0ZScsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oJ3VzZXItYScpO1xuXHRjb25zdCBjb3BpZWQgPSBtYXJrUGFnZURpcnR5KFxuXHRcdHtcblx0XHRcdC4uLnNlc3Npb24ucGFnZXNbMF0hLFxuXHRcdFx0c3luY1N0YXR1czogJ3N5bmNlZCcgYXMgUGFnZVN5bmNTdGF0dXMsXG5cdFx0XHRsYXN0U3luY2VkQXQ6ICcyMDI2LTA0LTE0VDAwOjAwOjAwLjAwMFonLFxuXHRcdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiAnMjAyNi0wNC0xNFQwMDowMDowMC4wMDBaJyxcblx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdH0sXG5cdFx0J3VzZXItYidcblx0KTtcblxuXHRhc3NlcnQuZXF1YWwoY29waWVkLnVzZXJJZCwgJ3VzZXItYicpO1xuXHRhc3NlcnQuZXF1YWwoY29waWVkLnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQuZXF1YWwoY29waWVkLmxhc3RTeW5jZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChjb3BpZWQubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0LmVxdWFsKGNvcGllZC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQsIG51bGwpO1xufSk7XG5cbnRlc3QoJ2Nsb25lUGFnZUZvclVzZXIgY3JlYXRlcyBhIGZyZXNoIGxvY2FsIHBhZ2UgaWQgZm9yIGltcG9ydGVkIGFub255bW91cyBkYXRhJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbihBTk9OWU1PVVNfVVNFUklEKTtcblx0Y29uc3Qgc291cmNlID0ge1xuXHRcdC4uLnNlc3Npb24ucGFnZXNbMF0hLFxuXHRcdGlkOiAnYW5vbi1wYWdlLTEnLFxuXHRcdHRpdGxlOiAnSW1wb3J0ZWQgdGl0bGUnLFxuXHRcdGNvbnRlbnQ6ICdpbXBvcnRlZCBib2R5Jyxcblx0XHR0ZXh0OiAnaW1wb3J0ZWQgYm9keScsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xuXG5cdGNvbnN0IGNsb25lZCA9IGNsb25lUGFnZUZvclVzZXIoc291cmNlLCAndXNlci1hJyk7XG5cblx0YXNzZXJ0Lm5vdEVxdWFsKGNsb25lZC5pZCwgc291cmNlLmlkKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC51c2VySWQsICd1c2VyLWEnKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC50aXRsZSwgJ0ltcG9ydGVkIHRpdGxlJyk7XG5cdGFzc2VydC5lcXVhbChjbG9uZWQuY29udGVudCwgJ2ltcG9ydGVkIGJvZHknKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKGNsb25lZC5pc0VwaGVtZXJhbCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoJ2Rlcml2ZVBhZ2VUaXRsZSBmYWxscyBiYWNrIHRvIFVudGl0bGVkIGZvciBibGFuayBjb250ZW50JywgKCkgPT4ge1xuXHRhc3NlcnQuZXF1YWwoZGVyaXZlUGFnZVRpdGxlKCcgICBcXG4gICcpLCAnVW50aXRsZWQnKTtcbn0pO1xuXG50ZXN0KCdlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UgZmFsbHMgYmFjayB0byB0aGUgbW9zdCByZWNlbnRseSB1cGRhdGVkIHZpc2libGUgcGFnZSB3aGVuIHRoZSBhY3RpdmUgcGFnZSBpcyBtaXNzaW5nJywgKCkgPT4ge1xuXHRjb25zdCByZXBhaXJlZCA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0YWN0aXZlUGFnZUlkOiAnbWlzc2luZycsXG5cdFx0cGFnZXM6IFtcblx0XHRcdHtcblx0XHRcdFx0aWQ6ICdwYWdlLWEnLFxuXHRcdFx0XHR1c2VySWQ6IEFOT05ZTU9VU19VU0VSSUQsXG5cdFx0XHRcdHRpdGxlOiAnQScsXG5cdFx0XHRcdGNvbnRlbnQ6ICdhbHBoYScsXG5cdFx0XHRcdHRleHQ6ICdhbHBoYScsXG5cdFx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0XHRcdGNyZWF0ZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTRUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogJ3BhZ2UtYicsXG5cdFx0XHRcdHVzZXJJZDogQU5PTllNT1VTX1VTRVJJRCxcblx0XHRcdFx0dGl0bGU6ICdCJyxcblx0XHRcdFx0Y29udGVudDogJ2JldGEnLFxuXHRcdFx0XHR0ZXh0OiAnYmV0YScsXG5cdFx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0XHRcdGNyZWF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdHVwZGF0ZWRBdDogJzIwMjYtMDQtMTVUMDA6MDA6MDAuMDAwWicsXG5cdFx0XHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRcdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0XHR9XG5cdFx0XVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwocmVwYWlyZWQucGFnZXNbMF0/LmlkLCAncGFnZS1iJyk7XG5cdGFzc2VydC5lcXVhbChyZXBhaXJlZC5hY3RpdmVQYWdlSWQsICdwYWdlLWInKTtcbn0pO1xuIiwgImV4cG9ydCBjb25zdCBCTEFOS19EQl9OQU1FID0gJ2JsYW5rJztcbmV4cG9ydCBjb25zdCBCTEFOS19EQl9WRVJTSU9OID0gMTtcbmV4cG9ydCBjb25zdCBQQUdFU19TVE9SRV9OQU1FID0gJ3BhZ2VzJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HU19TVE9SRV9OQU1FID0gJ3NldHRpbmdzJztcbmV4cG9ydCBjb25zdCBVU0VSX0lEX0lOREVYID0gJ3VzZXJJZCc7XG5leHBvcnQgY29uc3QgVVBEQVRFRF9BVF9JTkRFWCA9ICd1cGRhdGVkQXQnO1xuXG5leHBvcnQgY29uc3QgQU5PTllNT1VTX1VTRVJJRCA9ICdhbm9ueW1vdXMnO1xuXG5leHBvcnQgdHlwZSBQYWdlU3luY1N0YXR1cyA9ICdzeW5jZWQnIHwgJ2RpcnR5JyB8ICdwZW5kaW5nX3B1c2gnIHwgJ2NvbmZsaWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBQYWdlUmVjb3JkIHtcblx0aWQ6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdHN5bmNTdGF0dXM6IFBhZ2VTeW5jU3RhdHVzO1xuXHRpc0VwaGVtZXJhbDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nUmVjb3JkIHtcblx0a2V5OiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nIHwgbnVsbDtcblx0dmFsdWU6IHVua25vd247XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCA9ICdhY3RpdmVQYWdlSWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfVEhFTUUgPSAndGhlbWUnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZID0gJ3dvcmRDb3VudFZpc2liaWxpdHknO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVEID0gJ3NwZWxsY2hlY2tFbmFibGVkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCA9ICdoYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCc7XG4iLCAiaW1wb3J0IHR5cGUgeyBFZGl0b3JTdGF0ZSB9IGZyb20gJy4uL2Jhc2ljL2hpc3RvcnknO1xuaW1wb3J0IHtcblx0QU5PTllNT1VTX1VTRVJJRCxcblx0dHlwZSBQYWdlUmVjb3JkLFxuXHR0eXBlIFBhZ2VTeW5jU3RhdHVzXG59IGZyb20gJy4uL3BlcnNpc3RlbmNlL3JlY29yZHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclBhZ2UgZXh0ZW5kcyBFZGl0b3JTdGF0ZSwgUGFnZVJlY29yZCB7fVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoXG5cdGNvbnRlbnQgPSAnJyxcblx0b3B0aW9uczoge1xuXHRcdGlkPzogc3RyaW5nO1xuXHRcdHVzZXJJZD86IHN0cmluZztcblx0XHRub3c/OiBzdHJpbmc7XG5cdFx0aXNFcGhlbWVyYWw/OiBib29sZWFuO1xuXHR9ID0ge31cbik6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0aW1lc3RhbXAgPSBvcHRpb25zLm5vdyA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdHJldHVybiB7XG5cdFx0aWQ6IG9wdGlvbnMuaWQgPz8gY3JlYXRlUGFnZUlkKCksXG5cdFx0dXNlcklkOiBvcHRpb25zLnVzZXJJZCA/PyBBTk9OWU1PVVNfVVNFUklELFxuXHRcdHRpdGxlOiBkZXJpdmVQYWdlVGl0bGUoY29udGVudCksXG5cdFx0Y29udGVudCxcblx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdHNlbGVjdGlvbkVuZDogMCxcblx0XHRjcmVhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHR1cGRhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogb3B0aW9ucy5pc0VwaGVtZXJhbCA/PyB0cnVlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2UoJycsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gc29ydFBhZ2VzQnlSZWNlbmN5KHNlc3Npb24ucGFnZXMpO1xuXHRpZiAocGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRwYWdlc1xuXHRcdH07XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gcGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpO1xuXHRpZiAoZmlyc3RWaXNpYmxlUGFnZSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXMsXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdHBhZ2VzLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZXNbMF0hLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNWaXNpYmxlRXBoZW1lcmFsQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRyZXR1cm4gISFhY3RpdmVQYWdlICYmIGFjdGl2ZVBhZ2UuZGVsZXRlZEF0ID09PSBudWxsICYmIGFjdGl2ZVBhZ2UuaXNFcGhlbWVyYWw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVFbGlnaWJsZUFjdGl2ZVBhZ2VJZChzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRpZiAoIWFjdGl2ZVBhZ2UgfHwgYWN0aXZlUGFnZS5kZWxldGVkQXQgIT09IG51bGwgfHwgYWN0aXZlUGFnZS5pc0VwaGVtZXJhbCkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIGFjdGl2ZVBhZ2UuaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVBY3RpdmVQYWdlVXBkYXRlVGFyZ2V0KFxuXHRwcmV2aW91c1Nlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdG5leHRTZXNzaW9uOiBFZGl0b3JTZXNzaW9uXG4pOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgbmV4dEFjdGl2ZVBhZ2VJZCA9IGdldFJlbW90ZUVsaWdpYmxlQWN0aXZlUGFnZUlkKG5leHRTZXNzaW9uKTtcblx0aWYgKG5leHRBY3RpdmVQYWdlSWQgJiYgbmV4dEFjdGl2ZVBhZ2VJZCAhPT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkge1xuXHRcdHJldHVybiBuZXh0QWN0aXZlUGFnZUlkO1xuXHR9XG5cblx0Y29uc3QgcHJldmlvdXNBY3RpdmVCZWZvcmUgPSBwcmV2aW91c1Nlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0Y29uc3QgcHJldmlvdXNBY3RpdmVBZnRlciA9IG5leHRTZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHByZXZpb3VzU2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGlmIChcblx0XHRwcmV2aW91c0FjdGl2ZUJlZm9yZSAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmRlbGV0ZWRBdCA9PT0gbnVsbCAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmlzRXBoZW1lcmFsICYmXG5cdFx0cHJldmlvdXNBY3RpdmVBZnRlciAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQWZ0ZXIuZGVsZXRlZEF0ID09PSBudWxsICYmXG5cdFx0IXByZXZpb3VzQWN0aXZlQWZ0ZXIuaXNFcGhlbWVyYWxcblx0KSB7XG5cdFx0cmV0dXJuIHByZXZpb3VzQWN0aXZlQWZ0ZXIuaWQ7XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY29udGVudENoYW5nZWQgPSBzdGF0ZS50ZXh0ICE9PSBwYWdlLmNvbnRlbnQ7XG5cdGNvbnN0IHNlbGVjdGlvbkNoYW5nZWQgPVxuXHRcdHN0YXRlLnNlbGVjdGlvblN0YXJ0ICE9PSBwYWdlLnNlbGVjdGlvblN0YXJ0IHx8IHN0YXRlLnNlbGVjdGlvbkVuZCAhPT0gcGFnZS5zZWxlY3Rpb25FbmQ7XG5cdGlmICghY29udGVudENoYW5nZWQgJiYgIXNlbGVjdGlvbkNoYW5nZWQpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdGNvbnN0IG5leHRQYWdlOiBFZGl0b3JQYWdlID0ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dFxuXHR9O1xuXG5cdGlmICghY29udGVudENoYW5nZWQpIHtcblx0XHRyZXR1cm4gbmV4dFBhZ2U7XG5cdH1cblxuXHRjb25zdCBwcmV2aW91c0Rlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShwYWdlLmNvbnRlbnQpO1xuXHRjb25zdCBuZXh0RGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpO1xuXHRjb25zdCBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPSBwYWdlLnRpdGxlID09PSBwcmV2aW91c0Rlcml2ZWRUaXRsZTtcblxuXHRyZXR1cm4ge1xuXHRcdC4uLm5leHRQYWdlLFxuXHRcdHRpdGxlOiBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPyBuZXh0RGVyaXZlZFRpdGxlIDogcGFnZS50aXRsZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVQYWdlKHBhZ2U6IEVkaXRvclBhZ2UpOiBFZGl0b3JQYWdlIHtcblx0aWYgKCFwYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IGZhbHNlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdC4uLmNsb25lZCxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHQuc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xuXG5cdGlmIChwYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbih1c2VySWQpO1xuXHR9XG5cblx0Y29uc3QgYWN0aXZlUGFnZUlkID1cblx0XHR0eXBlb2YgdmFsdWUuYWN0aXZlUGFnZUlkID09PSAnc3RyaW5nJyAmJlxuXHRcdHBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHZhbHVlLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbClcblx0XHRcdD8gdmFsdWUuYWN0aXZlUGFnZUlkXG5cdFx0XHQ6IChwYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk/LmlkID8/IHBhZ2VzWzBdLmlkKTtcblxuXHRyZXR1cm4gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHsgcGFnZXMsIGFjdGl2ZVBhZ2VJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1pZ3JhdGVMZWdhY3lTdGF0ZShzdGF0ZTogRWRpdG9yU3RhdGUsIHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IHVwZGF0ZVBhZ2VTdGF0ZShjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2UgfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jb250ZW50ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5jb250ZW50XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLnRleHRcblx0XHRcdFx0OiAnJztcblx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xuXHRjb25zdCBzZWxlY3Rpb25TdGFydCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25TdGFydCA6IDAsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IHNlbGVjdGlvbkVuZCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uRW5kIDogc2VsZWN0aW9uU3RhcnQsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUuY3JlYXRlZEF0LCB2YWx1ZS5jcmVhdGVkX2F0KTtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS51cGRhdGVkQXQsIHZhbHVlLnVwZGF0ZWRfYXQpID8/IGNyZWF0ZWRBdDtcblx0Y29uc3QgZGVsZXRlZEF0ID0gcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmRlbGV0ZWRBdCwgdmFsdWUuZGVsZXRlZF9hdCk7XG5cblx0cmV0dXJuIHtcblx0XHRpZDogdHlwZW9mIHZhbHVlLmlkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5pZC5sZW5ndGggPiAwID8gdmFsdWUuaWQgOiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleCksXG5cdFx0dXNlcklkOiB0eXBlb2YgdmFsdWUudXNlcklkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51c2VySWQubGVuZ3RoID4gMCA/IHZhbHVlLnVzZXJJZCA6IHVzZXJJZCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0U3luY2VkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0KSxcblx0XHRzeW5jU3RhdHVzOiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiB0eXBlb2YgdmFsdWUuaXNFcGhlbWVyYWwgPT09ICdib29sZWFuJyA/IHZhbHVlLmlzRXBoZW1lcmFsIDogZmFsc2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZTogb2JqZWN0KTogdmFsdWUgaXMgRWRpdG9yU3RhdGUge1xuXHRyZXR1cm4gJ3RleHQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25TdGFydCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvbkVuZCcgaW4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRyZXR1cm4gISF2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnO1xufVxuXG5mdW5jdGlvbiBjbGFtcFNlbGVjdGlvbih2YWx1ZTogbnVtYmVyLCBtYXg6IG51bWJlcikge1xuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4odmFsdWUsIG1heCkpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQYWdlSWQoKSB7XG5cdGlmICh0eXBlb2YgY3J5cHRvICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgY3J5cHRvLnJhbmRvbVVVSUQgPT09ICdmdW5jdGlvbicpIHtcblx0XHRyZXR1cm4gY3J5cHRvLnJhbmRvbVVVSUQoKTtcblx0fVxuXG5cdHJldHVybiBgcGFnZS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKX0tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleDogbnVtYmVyKSB7XG5cdHJldHVybiBgcGFnZS0ke2luZGV4ICsgMX1gO1xufVxuXG5mdW5jdGlvbiByZWFkVGltZXN0YW1wKC4uLnZhbHVlczogdW5rbm93bltdKSB7XG5cdGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCkge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIHJlYWROdWxsYWJsZVRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWU6IHVua25vd24pOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiB2YWx1ZSA9PT0gJ3N5bmNlZCcgfHwgdmFsdWUgPT09ICdwZW5kaW5nX3B1c2gnIHx8IHZhbHVlID09PSAnY29uZmxpY3QnID8gdmFsdWUgOiAnZGlydHknO1xufVxuXG5mdW5jdGlvbiBuZXh0RGlydHlTdGF0dXMoc3RhdHVzOiBQYWdlU3luY1N0YXR1cyk6IFBhZ2VTeW5jU3RhdHVzIHtcblx0cmV0dXJuIHN0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc29ydFBhZ2VzQnlSZWNlbmN5KHBhZ2VzOiBFZGl0b3JQYWdlW10pIHtcblx0cmV0dXJuIFsuLi5wYWdlc10uc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVBhZ2VzQnlSZWNlbmN5KGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LnVwZGF0ZWRBdCAhPT0gcmlnaHQudXBkYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LnVwZGF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQudXBkYXRlZEF0KTtcblx0fVxuXG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ01aLElBQU0sbUJBQW1COzs7QUNPekIsSUFBTSxnQkFBZ0I7QUFFdEIsU0FBUyxnQkFBZ0IsU0FBeUI7QUFDeEQsUUFBTSxZQUFZLFFBQ2hCLE1BQU0sSUFBSSxFQUNWLElBQUksQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLEVBQ3pCLEtBQUssQ0FBQyxTQUFTLEtBQUssU0FBUyxDQUFDO0FBRWhDLE1BQUksQ0FBQyxXQUFXO0FBQ2YsV0FBTztBQUFBLEVBQ1I7QUFFQSxTQUFPLFVBQVUsUUFBUSxRQUFRLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUNsRDtBQUVPLFNBQVMsV0FDZixVQUFVLElBQ1YsVUFLSSxDQUFDLEdBQ1E7QUFDYixRQUFN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
