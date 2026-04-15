// tests/versioned-sync.test.ts
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
function markPageDeleted(page, deletedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    ...page,
    deletedAt,
    updatedAt: deletedAt,
    dirty: true,
    syncStatus: "deleted"
  };
}
function applyRemotePageState(page, state) {
  return {
    ...page,
    title: state.title,
    content: state.content,
    text: state.content,
    createdAt: page.createdAt ?? state.createdAt,
    updatedAt: state.updatedAt,
    deletedAt: state.deletedAt,
    lastSyncedAt: state.updatedAt,
    lastSyncedTitle: state.title,
    lastSyncedContent: state.content,
    lastSyncedDeletedAt: state.deletedAt,
    dirty: false,
    syncStatus: state.deletedAt ? "deleted" : "synced",
    lastSyncedVersion: state.updatedAt
  };
}
function markPageSynced(page, syncedAt, lastSyncedVersion = syncedAt) {
  return {
    ...page,
    lastSyncedAt: syncedAt,
    lastSyncedTitle: page.title,
    lastSyncedContent: page.content,
    lastSyncedDeletedAt: page.deletedAt,
    dirty: false,
    syncStatus: page.deletedAt ? "deleted" : "synced",
    lastSyncedVersion
  };
}
function createConflictCopy(page, titleSuffix, now = /* @__PURE__ */ new Date()) {
  const createdAt = now.toISOString();
  return {
    ...page,
    id: createPageId(),
    title: `${page.title.trim().length > 0 ? page.title.trim() : UNTITLED_PAGE} ${titleSuffix}`.trim(),
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    lastSyncedAt: null,
    lastSyncedTitle: null,
    lastSyncedContent: null,
    lastSyncedDeletedAt: null,
    dirty: true,
    syncStatus: "conflict",
    lastSyncedVersion: null
  };
}
function createPageId() {
  return `page-${Math.random().toString(36).slice(2, 10)}`;
}

// src/lib/editor/sync/versioned-sync.ts
function resolveVersionedSession(localSession, remote, meta, now = /* @__PURE__ */ new Date()) {
  const localPages = new Map(localSession.pages.map((page) => [page.id, page]));
  const nextPages = [];
  const nextPageVersions = {};
  const processedLocalIds = /* @__PURE__ */ new Set();
  let conflictCount = 0;
  let updatedFromRemote = false;
  let conflictActivePageId = null;
  for (const remotePage of remote.pages) {
    const localPage = localPages.get(remotePage.id) ?? null;
    const context = buildPageSyncContext(localPage, remotePage, meta.pageVersions[remotePage.id] ?? null);
    if (context.localExists && context.remoteExists && sameLogicalState(context.localState, context.remoteState)) {
      nextPages.push(markPageSynced(localPage, remoteVersion(remotePage) ?? localPage.updatedAt));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (!context.localExists && context.remoteExists && !context.remoteDeleted) {
      nextPages.push(buildLocalPageFromRemote(remotePage));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      updatedFromRemote = true;
      continue;
    }
    if (!context.localExists && context.remoteExists && context.remoteDeleted) {
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      continue;
    }
    if (context.localExists && context.remoteExists && context.remoteDeleted && !context.localChangedSinceSync) {
      nextPages.push(applyRemotePageState(localPage, toRemotePageState(remotePage, localPage)));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      updatedFromRemote = true;
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && context.remoteDeleted && context.localChangedSinceSync) {
      const deletedLocalPage = markPageDeleted(localPage);
      const conflictCopy = createConflictCopy(localPage, buildLocalConflictSuffix(now), now);
      nextPages.push(conflictCopy);
      nextPages.push(deletedLocalPage);
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      updatedFromRemote = true;
      conflictActivePageId ??= conflictCopy.id;
      conflictCount += 1;
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && context.localDeleted && !context.remoteDeleted) {
      nextPages.push(markPageSynced(localPage, remoteVersion(remotePage) ?? localPage.updatedAt));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && !context.localDeleted && !context.remoteDeleted && !context.localChangedSinceSync && !context.remoteChangedSinceSync) {
      nextPages.push(markPageSynced(localPage, remoteVersion(remotePage) ?? localPage.updatedAt));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && !context.localDeleted && !context.remoteDeleted && context.localChangedSinceSync && !context.remoteChangedSinceSync) {
      nextPages.push(markPageSynced(localPage, remoteVersion(remotePage) ?? localPage.updatedAt));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && !context.localDeleted && !context.remoteDeleted && !context.localChangedSinceSync && context.remoteChangedSinceSync) {
      nextPages.push(buildLocalPageFromRemote(remotePage));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      updatedFromRemote = true;
      processedLocalIds.add(remotePage.id);
      continue;
    }
    if (context.localExists && context.remoteExists && !context.localDeleted && !context.remoteDeleted && context.localChangedSinceSync && context.remoteChangedSinceSync) {
      const conflictCopy = createConflictCopy(localPage, buildLocalConflictSuffix(now), now);
      nextPages.push(conflictCopy);
      nextPages.push(applyRemotePageState(localPage, toRemotePageState(remotePage, localPage)));
      nextPageVersions[remotePage.id] = remoteVersion(remotePage);
      updatedFromRemote = true;
      conflictActivePageId ??= conflictCopy.id;
      conflictCount += 1;
      processedLocalIds.add(remotePage.id);
      continue;
    }
    nextPages.push(applyRemotePageState(localPage, toRemotePageState(remotePage, localPage)));
    nextPageVersions[remotePage.id] = remoteVersion(remotePage);
    processedLocalIds.add(remotePage.id);
  }
  for (const localPage of localSession.pages) {
    if (processedLocalIds.has(localPage.id)) {
      continue;
    }
    const lastSyncedState = getLastSyncedState(localPage, meta.pageVersions[localPage.id] ?? null);
    const localState = getLocalLogicalState(localPage);
    const localChangedSinceSync = !sameLogicalState(localState, lastSyncedState);
    if (!lastSyncedState && localPage.syncStatus === "local-only") {
      nextPages.push(localPage);
      nextPageVersions[localPage.id] = localPage.lastSyncedVersion;
      continue;
    }
    if (!lastSyncedState) {
      console.warn(`Sync inconsistency: remote page ${localPage.id} is missing but local data exists.`);
      nextPages.push(localPage);
      nextPageVersions[localPage.id] = localPage.lastSyncedVersion ?? null;
      continue;
    }
    if (localChangedSinceSync) {
      console.warn(`Sync inconsistency: remote page ${localPage.id} is missing after a prior sync.`);
    }
    nextPages.push(localPage);
    nextPageVersions[localPage.id] = localPage.lastSyncedVersion ?? meta.pageVersions[localPage.id] ?? null;
  }
  return {
    session: {
      pages: nextPages,
      activePageId: conflictActivePageId ?? nextPages.find((page) => page.id === localSession.activePageId && !page.deletedAt)?.id ?? nextPages.find((page) => !page.deletedAt)?.id ?? nextPages[0]?.id ?? localSession.activePageId
    },
    conflictCount,
    updatedFromRemote,
    pageVersions: nextPageVersions
  };
}
function buildPageSyncContext(localPage, remotePage, lastVersion) {
  const localState = localPage ? getLocalLogicalState(localPage) : null;
  const remoteState = getRemoteLogicalState(remotePage);
  const lastSyncedState = localPage ? getLastSyncedState(localPage, lastVersion) : null;
  return {
    localExists: localPage !== null,
    remoteExists: true,
    localDeleted: localPage?.deletedAt != null,
    remoteDeleted: remoteState.deleted,
    localChangedSinceSync: localPage ? !sameLogicalState(localState, lastSyncedState) || !lastSyncedState && localPage.dirty : false,
    remoteChangedSinceSync: !sameLogicalState(remoteState, lastSyncedState),
    localState,
    remoteState
  };
}
function getLocalLogicalState(page) {
  return {
    title: page.title,
    content: page.content,
    deleted: page.deletedAt != null
  };
}
function getRemoteLogicalState(page) {
  return {
    title: page.title,
    content: page.content,
    deleted: page.deleted_at != null
  };
}
function getLastSyncedState(page, fallbackVersion) {
  const lastSyncedAt = page.lastSyncedAt ?? fallbackVersion;
  if (!lastSyncedAt) {
    return null;
  }
  return {
    title: page.lastSyncedTitle ?? page.title,
    content: page.lastSyncedContent ?? page.content,
    deleted: (page.lastSyncedDeletedAt ?? page.deletedAt) != null
  };
}
function sameLogicalState(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.title === b.title && a.content === b.content && a.deleted === b.deleted;
}
function remoteVersion(page) {
  return page.updated_at ?? page.created_at ?? null;
}
function buildLocalPageFromRemote(remotePage) {
  const createdAt = remotePage.created_at ?? remotePage.updated_at ?? (/* @__PURE__ */ new Date()).toISOString();
  return applyRemotePageState(
    {
      id: remotePage.id,
      title: remotePage.title,
      content: remotePage.content,
      text: remotePage.content,
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
    },
    toRemotePageState(remotePage, { createdAt, updatedAt: createdAt })
  );
}
function toRemotePageState(remotePage, fallback) {
  const createdAt = remotePage.created_at ?? fallback.createdAt;
  const updatedAt = remoteVersion(remotePage) ?? fallback.updatedAt;
  return {
    title: remotePage.title,
    content: remotePage.content,
    deletedAt: remotePage.deleted_at ?? null,
    createdAt,
    updatedAt
  };
}
function buildLocalConflictSuffix(now) {
  const timestamp = new Intl.DateTimeFormat(void 0, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(now);
  return `(Local conflict ${timestamp})`;
}

// tests/versioned-sync.test.ts
test("resolveVersionedSession keeps local changes when remote has not changed", () => {
  const session = createSession();
  const page = session.pages[0];
  page.title = "Note Title";
  page.content = "local body";
  page.text = "local body";
  page.updatedAt = "2026-04-15T16:12:00.000Z";
  page.lastSyncedVersion = "2026-04-14T16:12:00.000Z";
  page.lastSyncedAt = "2026-04-14T16:12:00.000Z";
  page.lastSyncedTitle = "Note Title";
  page.lastSyncedContent = "remote body";
  page.lastSyncedDeletedAt = null;
  page.dirty = true;
  page.syncStatus = "dirty";
  const result = resolveVersionedSession(
    session,
    {
      activePageId: page.id,
      pages: [
        {
          id: page.id,
          title: "Note Title",
          content: "remote body",
          updated_at: "2026-04-14T16:12:00.000Z"
        }
      ]
    },
    {
      pageVersions: {
        [page.id]: "2026-04-14T16:12:00.000Z"
      }
    },
    /* @__PURE__ */ new Date("2026-04-15T16:12:00.000Z")
  );
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages[0]?.content, "local body");
});
test("resolveVersionedSession creates a local conflict copy when both versions changed", () => {
  const session = createSession();
  const page = session.pages[0];
  page.title = "Note Title";
  page.content = "local body";
  page.text = "local body";
  page.updatedAt = "2026-04-15T16:12:00.000Z";
  page.lastSyncedVersion = "2026-04-14T16:12:00.000Z";
  page.lastSyncedAt = "2026-04-14T16:12:00.000Z";
  page.lastSyncedTitle = "Note Title";
  page.lastSyncedContent = "base body";
  page.lastSyncedDeletedAt = null;
  page.dirty = true;
  page.syncStatus = "dirty";
  const result = resolveVersionedSession(
    session,
    {
      activePageId: page.id,
      pages: [
        {
          id: page.id,
          title: "Note Title",
          content: "remote body",
          updated_at: "2026-04-15T15:12:00.000Z"
        }
      ]
    },
    {
      pageVersions: {
        [page.id]: "2026-04-14T16:12:00.000Z"
      }
    },
    /* @__PURE__ */ new Date("2026-04-15T16:12:00.000Z")
  );
  assert.equal(result.conflictCount, 1);
  assert.equal(result.session.pages.length, 2);
  assert.equal(result.session.pages[0]?.content, "local body");
  assert.match(result.session.pages[0]?.title ?? "", /^Note Title \(Local conflict /);
  assert.equal(result.session.pages[1]?.content, "remote body");
});
test("resolveVersionedSession does not create a conflict when content is identical", () => {
  const session = createSession();
  const page = session.pages[0];
  page.title = "Note Title";
  page.content = "shared body";
  page.text = "shared body";
  page.updatedAt = "2026-04-15T16:12:00.000Z";
  page.lastSyncedVersion = "2026-04-14T16:12:00.000Z";
  page.lastSyncedAt = "2026-04-14T16:12:00.000Z";
  page.lastSyncedTitle = "Note Title";
  page.lastSyncedContent = "shared body";
  page.lastSyncedDeletedAt = null;
  page.dirty = true;
  page.syncStatus = "dirty";
  const result = resolveVersionedSession(
    session,
    {
      activePageId: page.id,
      pages: [
        {
          id: page.id,
          title: "Different title",
          content: "shared body",
          updated_at: "2026-04-15T15:12:00.000Z"
        }
      ]
    },
    {
      pageVersions: {
        [page.id]: "2026-04-14T16:12:00.000Z"
      }
    },
    /* @__PURE__ */ new Date("2026-04-15T16:12:00.000Z")
  );
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.content, "shared body");
});
test("resolveVersionedSession keeps local tombstone when remote has stale non-deleted row", () => {
  const session = createSession();
  const page = session.pages[0];
  page.title = "Deleted note";
  page.content = "old body";
  page.text = "old body";
  page.deletedAt = "2026-04-15T16:10:00.000Z";
  page.updatedAt = "2026-04-15T16:10:00.000Z";
  page.lastSyncedVersion = "2026-04-15T16:00:00.000Z";
  page.lastSyncedAt = "2026-04-15T16:00:00.000Z";
  page.lastSyncedTitle = "Deleted note";
  page.lastSyncedContent = "old body";
  page.lastSyncedDeletedAt = null;
  page.dirty = true;
  page.syncStatus = "deleted";
  const result = resolveVersionedSession(
    session,
    {
      activePageId: page.id,
      pages: [
        {
          id: page.id,
          title: "Deleted note",
          content: "old body",
          updated_at: "2026-04-15T16:05:00.000Z",
          deleted_at: null
        }
      ]
    },
    {
      pageVersions: {
        [page.id]: "2026-04-15T16:05:00.000Z"
      }
    },
    /* @__PURE__ */ new Date("2026-04-15T16:12:00.000Z")
  );
  assert.equal(result.conflictCount, 0);
  assert.equal(result.updatedFromRemote, false);
  assert.equal(result.session.pages[0]?.deletedAt, "2026-04-15T16:10:00.000Z");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvdmVyc2lvbmVkLXN5bmMudGVzdC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMiLCAiLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy92ZXJzaW9uZWQtc3luYy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IHJlc29sdmVWZXJzaW9uZWRTZXNzaW9uIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy92ZXJzaW9uZWQtc3luYy50cyc7XG5pbXBvcnQgeyBjcmVhdGVTZXNzaW9uIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxudGVzdCgncmVzb2x2ZVZlcnNpb25lZFNlc3Npb24ga2VlcHMgbG9jYWwgY2hhbmdlcyB3aGVuIHJlbW90ZSBoYXMgbm90IGNoYW5nZWQnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IHBhZ2UgPSBzZXNzaW9uLnBhZ2VzWzBdITtcblx0cGFnZS50aXRsZSA9ICdOb3RlIFRpdGxlJztcblx0cGFnZS5jb250ZW50ID0gJ2xvY2FsIGJvZHknO1xuXHRwYWdlLnRleHQgPSAnbG9jYWwgYm9keSc7XG5cdHBhZ2UudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTVUMTY6MTI6MDAuMDAwWic7XG5cdHBhZ2UubGFzdFN5bmNlZFZlcnNpb24gPSAnMjAyNi0wNC0xNFQxNjoxMjowMC4wMDBaJztcblx0cGFnZS5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xNFQxNjoxMjowMC4wMDBaJztcblx0cGFnZS5sYXN0U3luY2VkVGl0bGUgPSAnTm90ZSBUaXRsZSc7XG5cdHBhZ2UubGFzdFN5bmNlZENvbnRlbnQgPSAncmVtb3RlIGJvZHknO1xuXHRwYWdlLmxhc3RTeW5jZWREZWxldGVkQXQgPSBudWxsO1xuXHRwYWdlLmRpcnR5ID0gdHJ1ZTtcblx0cGFnZS5zeW5jU3RhdHVzID0gJ2RpcnR5JztcblxuXHRjb25zdCByZXN1bHQgPSByZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbihcblx0XHRzZXNzaW9uLFxuXHRcdHtcblx0XHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZCxcblx0XHRcdHBhZ2VzOiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0XHR0aXRsZTogJ05vdGUgVGl0bGUnLFxuXHRcdFx0XHRcdGNvbnRlbnQ6ICdyZW1vdGUgYm9keScsXG5cdFx0XHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTRUMTY6MTI6MDAuMDAwWidcblx0XHRcdFx0fVxuXHRcdFx0XVxuXHRcdH0sXG5cdFx0e1xuXHRcdFx0cGFnZVZlcnNpb25zOiB7XG5cdFx0XHRcdFtwYWdlLmlkXTogJzIwMjYtMDQtMTRUMTY6MTI6MDAuMDAwWidcblx0XHRcdH1cblx0XHR9LFxuXHRcdG5ldyBEYXRlKCcyMDI2LTA0LTE1VDE2OjEyOjAwLjAwMFonKVxuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ2xvY2FsIGJvZHknKTtcbn0pO1xuXG50ZXN0KCdyZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbiBjcmVhdGVzIGEgbG9jYWwgY29uZmxpY3QgY29weSB3aGVuIGJvdGggdmVyc2lvbnMgY2hhbmdlZCcsICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3QgcGFnZSA9IHNlc3Npb24ucGFnZXNbMF0hO1xuXHRwYWdlLnRpdGxlID0gJ05vdGUgVGl0bGUnO1xuXHRwYWdlLmNvbnRlbnQgPSAnbG9jYWwgYm9keSc7XG5cdHBhZ2UudGV4dCA9ICdsb2NhbCBib2R5Jztcblx0cGFnZS51cGRhdGVkQXQgPSAnMjAyNi0wNC0xNVQxNjoxMjowMC4wMDBaJztcblx0cGFnZS5sYXN0U3luY2VkVmVyc2lvbiA9ICcyMDI2LTA0LTE0VDE2OjEyOjAwLjAwMFonO1xuXHRwYWdlLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE0VDE2OjEyOjAwLjAwMFonO1xuXHRwYWdlLmxhc3RTeW5jZWRUaXRsZSA9ICdOb3RlIFRpdGxlJztcblx0cGFnZS5sYXN0U3luY2VkQ29udGVudCA9ICdiYXNlIGJvZHknO1xuXHRwYWdlLmxhc3RTeW5jZWREZWxldGVkQXQgPSBudWxsO1xuXHRwYWdlLmRpcnR5ID0gdHJ1ZTtcblx0cGFnZS5zeW5jU3RhdHVzID0gJ2RpcnR5JztcblxuXHRjb25zdCByZXN1bHQgPSByZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbihcblx0XHRzZXNzaW9uLFxuXHRcdHtcblx0XHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZCxcblx0XHRcdHBhZ2VzOiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0XHR0aXRsZTogJ05vdGUgVGl0bGUnLFxuXHRcdFx0XHRcdGNvbnRlbnQ6ICdyZW1vdGUgYm9keScsXG5cdFx0XHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTVUMTU6MTI6MDAuMDAwWidcblx0XHRcdFx0fVxuXHRcdFx0XVxuXHRcdH0sXG5cdFx0e1xuXHRcdFx0cGFnZVZlcnNpb25zOiB7XG5cdFx0XHRcdFtwYWdlLmlkXTogJzIwMjYtMDQtMTRUMTY6MTI6MDAuMDAwWidcblx0XHRcdH1cblx0XHR9LFxuXHRcdG5ldyBEYXRlKCcyMDI2LTA0LTE1VDE2OjEyOjAwLjAwMFonKVxuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmNvbnRlbnQsICdsb2NhbCBib2R5Jyk7XG5cdGFzc2VydC5tYXRjaChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8udGl0bGUgPz8gJycsIC9eTm90ZSBUaXRsZSBcXChMb2NhbCBjb25mbGljdCAvKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5jb250ZW50LCAncmVtb3RlIGJvZHknKTtcbn0pO1xuXG50ZXN0KCdyZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbiBkb2VzIG5vdCBjcmVhdGUgYSBjb25mbGljdCB3aGVuIGNvbnRlbnQgaXMgaWRlbnRpY2FsJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRjb25zdCBwYWdlID0gc2Vzc2lvbi5wYWdlc1swXSE7XG5cdHBhZ2UudGl0bGUgPSAnTm90ZSBUaXRsZSc7XG5cdHBhZ2UuY29udGVudCA9ICdzaGFyZWQgYm9keSc7XG5cdHBhZ2UudGV4dCA9ICdzaGFyZWQgYm9keSc7XG5cdHBhZ2UudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTVUMTY6MTI6MDAuMDAwWic7XG5cdHBhZ2UubGFzdFN5bmNlZFZlcnNpb24gPSAnMjAyNi0wNC0xNFQxNjoxMjowMC4wMDBaJztcblx0cGFnZS5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xNFQxNjoxMjowMC4wMDBaJztcblx0cGFnZS5sYXN0U3luY2VkVGl0bGUgPSAnTm90ZSBUaXRsZSc7XG5cdHBhZ2UubGFzdFN5bmNlZENvbnRlbnQgPSAnc2hhcmVkIGJvZHknO1xuXHRwYWdlLmxhc3RTeW5jZWREZWxldGVkQXQgPSBudWxsO1xuXHRwYWdlLmRpcnR5ID0gdHJ1ZTtcblx0cGFnZS5zeW5jU3RhdHVzID0gJ2RpcnR5JztcblxuXHRjb25zdCByZXN1bHQgPSByZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbihcblx0XHRzZXNzaW9uLFxuXHRcdHtcblx0XHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZCxcblx0XHRcdHBhZ2VzOiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0XHR0aXRsZTogJ0RpZmZlcmVudCB0aXRsZScsXG5cdFx0XHRcdFx0Y29udGVudDogJ3NoYXJlZCBib2R5Jyxcblx0XHRcdFx0XHR1cGRhdGVkX2F0OiAnMjAyNi0wNC0xNVQxNToxMjowMC4wMDBaJ1xuXHRcdFx0XHR9XG5cdFx0XHRdXG5cdFx0fSxcblx0XHR7XG5cdFx0XHRwYWdlVmVyc2lvbnM6IHtcblx0XHRcdFx0W3BhZ2UuaWRdOiAnMjAyNi0wNC0xNFQxNjoxMjowMC4wMDBaJ1xuXHRcdFx0fVxuXHRcdH0sXG5cdFx0bmV3IERhdGUoJzIwMjYtMDQtMTVUMTY6MTI6MDAuMDAwWicpXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb25mbGljdENvdW50LCAwKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ3NoYXJlZCBib2R5Jyk7XG59KTtcblxudGVzdCgncmVzb2x2ZVZlcnNpb25lZFNlc3Npb24ga2VlcHMgbG9jYWwgdG9tYnN0b25lIHdoZW4gcmVtb3RlIGhhcyBzdGFsZSBub24tZGVsZXRlZCByb3cnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IHBhZ2UgPSBzZXNzaW9uLnBhZ2VzWzBdITtcblx0cGFnZS50aXRsZSA9ICdEZWxldGVkIG5vdGUnO1xuXHRwYWdlLmNvbnRlbnQgPSAnb2xkIGJvZHknO1xuXHRwYWdlLnRleHQgPSAnb2xkIGJvZHknO1xuXHRwYWdlLmRlbGV0ZWRBdCA9ICcyMDI2LTA0LTE1VDE2OjEwOjAwLjAwMFonO1xuXHRwYWdlLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE1VDE2OjEwOjAwLjAwMFonO1xuXHRwYWdlLmxhc3RTeW5jZWRWZXJzaW9uID0gJzIwMjYtMDQtMTVUMTY6MDA6MDAuMDAwWic7XG5cdHBhZ2UubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTVUMTY6MDA6MDAuMDAwWic7XG5cdHBhZ2UubGFzdFN5bmNlZFRpdGxlID0gJ0RlbGV0ZWQgbm90ZSc7XG5cdHBhZ2UubGFzdFN5bmNlZENvbnRlbnQgPSAnb2xkIGJvZHknO1xuXHRwYWdlLmxhc3RTeW5jZWREZWxldGVkQXQgPSBudWxsO1xuXHRwYWdlLmRpcnR5ID0gdHJ1ZTtcblx0cGFnZS5zeW5jU3RhdHVzID0gJ2RlbGV0ZWQnO1xuXG5cdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVWZXJzaW9uZWRTZXNzaW9uKFxuXHRcdHNlc3Npb24sXG5cdFx0e1xuXHRcdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkLFxuXHRcdFx0cGFnZXM6IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdGlkOiBwYWdlLmlkLFxuXHRcdFx0XHRcdHRpdGxlOiAnRGVsZXRlZCBub3RlJyxcblx0XHRcdFx0XHRjb250ZW50OiAnb2xkIGJvZHknLFxuXHRcdFx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE1VDE2OjA1OjAwLjAwMFonLFxuXHRcdFx0XHRcdGRlbGV0ZWRfYXQ6IG51bGxcblx0XHRcdFx0fVxuXHRcdFx0XVxuXHRcdH0sXG5cdFx0e1xuXHRcdFx0cGFnZVZlcnNpb25zOiB7XG5cdFx0XHRcdFtwYWdlLmlkXTogJzIwMjYtMDQtMTVUMTY6MDU6MDAuMDAwWidcblx0XHRcdH1cblx0XHR9LFxuXHRcdG5ldyBEYXRlKCcyMDI2LTA0LTE1VDE2OjEyOjAwLjAwMFonKVxuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQudXBkYXRlZEZyb21SZW1vdGUsIGZhbHNlKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5kZWxldGVkQXQsICcyMDI2LTA0LTE1VDE2OjEwOjAwLjAwMFonKTtcbn0pO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcblxuZXhwb3J0IHR5cGUgUGFnZVN5bmNTdGF0dXMgPSAnbG9jYWwtb25seScgfCAnc3luY2VkJyB8ICdkaXJ0eScgfCAnZGVsZXRlZCcgfCAnY29uZmxpY3QnIHwgJ2luY29uc2lzdGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlIHtcblx0aWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkQXQ6IHN0cmluZztcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG5cdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkVGl0bGU6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRDb250ZW50OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRkaXJ0eTogYm9vbGVhbjtcblx0c3luY1N0YXR1czogUGFnZVN5bmNTdGF0dXM7XG5cdGxhc3RTeW5jZWRWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoY29udGVudCA9ICcnLCBpZCA9IGNyZWF0ZVBhZ2VJZCgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHRpZCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogY3JlYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBudWxsLFxuXHRcdGxhc3RTeW5jZWRDb250ZW50OiBudWxsLFxuXHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IG51bGwsXG5cdFx0ZGlydHk6IHRydWUsXG5cdFx0c3luY1N0YXR1czogJ2xvY2FsLW9ubHknLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBudWxsXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IEVkaXRvclNlc3Npb24ge1xuXHRpZiAoc2Vzc2lvbi5wYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xuXHR9XG5cblx0aWYgKHNlc3Npb24ucGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHNlc3Npb247XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gc2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk7XG5cdGlmIChmaXJzdFZpc2libGVQYWdlKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdGFjdGl2ZVBhZ2VJZDogc2Vzc2lvbi5wYWdlc1swXSEuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpLFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2UuZGVsZXRlZEF0ID8gJ2RlbGV0ZWQnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6ICdkZWxldGVkJ1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlSZW1vdGVQYWdlU3RhdGUoXG5cdHBhZ2U6IEVkaXRvclBhZ2UsXG5cdHN0YXRlOiB7XG5cdFx0dGl0bGU6IHN0cmluZztcblx0XHRjb250ZW50OiBzdHJpbmc7XG5cdFx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRcdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHRcdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHR9XG4pOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiBzdGF0ZS50aXRsZSxcblx0XHRjb250ZW50OiBzdGF0ZS5jb250ZW50LFxuXHRcdHRleHQ6IHN0YXRlLmNvbnRlbnQsXG5cdFx0Y3JlYXRlZEF0OiBwYWdlLmNyZWF0ZWRBdCA/PyBzdGF0ZS5jcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBzdGF0ZS51cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0OiBzdGF0ZS5kZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiBzdGF0ZS51cGRhdGVkQXQsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBzdGF0ZS50aXRsZSxcblx0XHRsYXN0U3luY2VkQ29udGVudDogc3RhdGUuY29udGVudCxcblx0XHRsYXN0U3luY2VkRGVsZXRlZEF0OiBzdGF0ZS5kZWxldGVkQXQsXG5cdFx0ZGlydHk6IGZhbHNlLFxuXHRcdHN5bmNTdGF0dXM6IHN0YXRlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdzeW5jZWQnLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBzdGF0ZS51cGRhdGVkQXRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlU3luY2VkKFxuXHRwYWdlOiBFZGl0b3JQYWdlLFxuXHRzeW5jZWRBdDogc3RyaW5nLFxuXHRsYXN0U3luY2VkVmVyc2lvbiA9IHN5bmNlZEF0XG4pOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdGxhc3RTeW5jZWRBdDogc3luY2VkQXQsXG5cdFx0bGFzdFN5bmNlZFRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGxhc3RTeW5jZWRDb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0ZGlydHk6IGZhbHNlLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2UuZGVsZXRlZEF0ID8gJ2RlbGV0ZWQnIDogJ3N5bmNlZCcsXG5cdFx0bGFzdFN5bmNlZFZlcnNpb25cblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUNvbmZsaWN0Q29weShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZVN1ZmZpeDogc3RyaW5nLCBub3cgPSBuZXcgRGF0ZSgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IG5vdy50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0aWQ6IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHRpdGxlOiBgJHtwYWdlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwID8gcGFnZS50aXRsZS50cmltKCkgOiBVTlRJVExFRF9QQUdFfSAke3RpdGxlU3VmZml4fWAudHJpbSgpLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IGNyZWF0ZWRBdCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRUaXRsZTogbnVsbCxcblx0XHRsYXN0U3luY2VkQ29udGVudDogbnVsbCxcblx0XHRsYXN0U3luY2VkRGVsZXRlZEF0OiBudWxsLFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6ICdjb25mbGljdCcsXG5cdFx0bGFzdFN5bmNlZFZlcnNpb246IG51bGxcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb24odmFsdWU6IHVua25vd24pOiBFZGl0b3JTZXNzaW9uIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRpZiAoaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZSkpIHtcblx0XHRyZXR1cm4gbWlncmF0ZUxlZ2FjeVN0YXRlKHZhbHVlKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZShzdGF0ZS50ZXh0KSwgc3RhdGUpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2UodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jcmVhdGVkQXQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmNyZWF0ZWRBdC5sZW5ndGggPiAwXG5cdFx0XHQ/IHZhbHVlLmNyZWF0ZWRBdFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUuY3JlYXRlZF9hdCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuY3JlYXRlZF9hdC5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUuY3JlYXRlZF9hdFxuXHRcdFx0XHQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgdXBkYXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUudXBkYXRlZEF0ID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51cGRhdGVkQXQubGVuZ3RoID4gMFxuXHRcdFx0PyB2YWx1ZS51cGRhdGVkQXRcblx0XHRcdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRjb25zdCBkZWxldGVkQXQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5kZWxldGVkQXQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmRlbGV0ZWRBdFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUuZGVsZXRlZF9hdCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS5kZWxldGVkX2F0XG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZEF0ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkQXRcblx0XHRcdDogdHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uXG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZFRpdGxlID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZFRpdGxlID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkVGl0bGVcblx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gdHlwZW9mIHZhbHVlLnRpdGxlID09PSAnc3RyaW5nJ1xuXHRcdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpXG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZENvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5sYXN0U3luY2VkQ29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZENvbnRlbnRcblx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gbm9ybWFsaXplZENvbnRlbnRcblx0XHRcdFx0OiBudWxsO1xuXHRjb25zdCBsYXN0U3luY2VkRGVsZXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZERlbGV0ZWRBdCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZERlbGV0ZWRBdFxuXHRcdFx0OiBsYXN0U3luY2VkQXRcblx0XHRcdFx0PyBkZWxldGVkQXRcblx0XHRcdFx0OiBudWxsO1xuXHRjb25zdCBkaXJ0eSA9XG5cdFx0dHlwZW9mIHZhbHVlLmRpcnR5ID09PSAnYm9vbGVhbidcblx0XHRcdD8gdmFsdWUuZGlydHlcblx0XHRcdDogbGFzdFN5bmNlZEF0ID09PSBudWxsO1xuXHRjb25zdCBzeW5jU3RhdHVzID0gbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzLCBkZWxldGVkQXQsIGRpcnR5LCBsYXN0U3luY2VkQXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogYHBhZ2UtJHtpbmRleCArIDF9YCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHQ/IHZhbHVlLnRpdGxlLnRyaW0oKVxuXHRcdFx0XHQ6IGRlcml2ZVBhZ2VUaXRsZShub3JtYWxpemVkQ29udGVudCksXG5cdFx0Y29udGVudDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0dGV4dDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdCxcblx0XHRsYXN0U3luY2VkVGl0bGUsXG5cdFx0bGFzdFN5bmNlZENvbnRlbnQsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdCxcblx0XHRkaXJ0eSxcblx0XHRzeW5jU3RhdHVzLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOlxuXHRcdFx0dHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWRWZXJzaW9uXG5cdFx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdFx0PyBsYXN0U3luY2VkQXRcblx0XHRcdFx0XHQ6IHR5cGVvZiB2YWx1ZS5zZXJ2ZXJWZXJzaW9uID09PSAnc3RyaW5nJ1xuXHRcdFx0XHRcdFx0PyB2YWx1ZS5zZXJ2ZXJWZXJzaW9uXG5cdFx0XHRcdFx0XHQ6IG51bGxcblx0fTtcbn1cblxuZnVuY3Rpb24gaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZTogb2JqZWN0KTogdmFsdWUgaXMgRWRpdG9yU3RhdGUge1xuXHRyZXR1cm4gJ3RleHQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25TdGFydCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvbkVuZCcgaW4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRyZXR1cm4gISF2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnO1xufVxuXG5mdW5jdGlvbiBjbGFtcFNlbGVjdGlvbih2YWx1ZTogbnVtYmVyLCBtYXg6IG51bWJlcikge1xuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4odmFsdWUsIG1heCkpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKFxuXHR2YWx1ZTogdW5rbm93bixcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsLFxuXHRkaXJ0eTogYm9vbGVhbixcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsXG4pOiBQYWdlU3luY1N0YXR1cyB7XG5cdGlmIChcblx0XHR2YWx1ZSA9PT0gJ2xvY2FsLW9ubHknIHx8XG5cdFx0dmFsdWUgPT09ICdzeW5jZWQnIHx8XG5cdFx0dmFsdWUgPT09ICdkaXJ0eScgfHxcblx0XHR2YWx1ZSA9PT0gJ2RlbGV0ZWQnIHx8XG5cdFx0dmFsdWUgPT09ICdjb25mbGljdCcgfHxcblx0XHR2YWx1ZSA9PT0gJ2luY29uc2lzdGVudCdcblx0KSB7XG5cdFx0cmV0dXJuIHZhbHVlO1xuXHR9XG5cblx0aWYgKGRlbGV0ZWRBdCkge1xuXHRcdHJldHVybiAnZGVsZXRlZCc7XG5cdH1cblxuXHRpZiAoZGlydHkpIHtcblx0XHRyZXR1cm4gbGFzdFN5bmNlZEF0ID8gJ2RpcnR5JyA6ICdsb2NhbC1vbmx5Jztcblx0fVxuXG5cdHJldHVybiBsYXN0U3luY2VkQXQgPyAnc3luY2VkJyA6ICdsb2NhbC1vbmx5Jztcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9YDtcbn1cbiIsICJpbXBvcnQge1xuXHRhcHBseVJlbW90ZVBhZ2VTdGF0ZSxcblx0Y3JlYXRlQ29uZmxpY3RDb3B5LFxuXHRtYXJrUGFnZURlbGV0ZWQsXG5cdG1hcmtQYWdlU3luY2VkLFxuXHR0eXBlIEVkaXRvclBhZ2UsXG5cdHR5cGUgRWRpdG9yU2Vzc2lvblxufSBmcm9tICcuLi9jb3JlL3Nlc3Npb24nO1xuaW1wb3J0IHR5cGUgeyBSZW1vdGVBcHBTdGF0ZSwgUmVtb3RlUGFnZVJlY29yZCB9IGZyb20gJy4vcmVtb3RlLXNlc3Npb24nO1xuXG5leHBvcnQgaW50ZXJmYWNlIFZlcnNpb25lZFN5bmNNZXRhIHtcblx0cGFnZVZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWZXJzaW9uZWRTeW5jUmVzb2x1dGlvbiB7XG5cdHNlc3Npb246IEVkaXRvclNlc3Npb247XG5cdGNvbmZsaWN0Q291bnQ6IG51bWJlcjtcblx0dXBkYXRlZEZyb21SZW1vdGU6IGJvb2xlYW47XG5cdHBhZ2VWZXJzaW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD47XG59XG5cbmludGVyZmFjZSBQYWdlTG9naWNhbFN0YXRlIHtcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRkZWxldGVkOiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgUGFnZVN5bmNDb250ZXh0IHtcblx0bG9jYWxFeGlzdHM6IGJvb2xlYW47XG5cdHJlbW90ZUV4aXN0czogYm9vbGVhbjtcblx0bG9jYWxEZWxldGVkOiBib29sZWFuO1xuXHRyZW1vdGVEZWxldGVkOiBib29sZWFuO1xuXHRsb2NhbENoYW5nZWRTaW5jZVN5bmM6IGJvb2xlYW47XG5cdHJlbW90ZUNoYW5nZWRTaW5jZVN5bmM6IGJvb2xlYW47XG5cdGxvY2FsU3RhdGU6IFBhZ2VMb2dpY2FsU3RhdGUgfCBudWxsO1xuXHRyZW1vdGVTdGF0ZTogUGFnZUxvZ2ljYWxTdGF0ZSB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVmVyc2lvbmVkU2Vzc2lvbihcblx0bG9jYWxTZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRyZW1vdGU6IFJlbW90ZUFwcFN0YXRlLFxuXHRtZXRhOiBWZXJzaW9uZWRTeW5jTWV0YSxcblx0bm93ID0gbmV3IERhdGUoKVxuKTogVmVyc2lvbmVkU3luY1Jlc29sdXRpb24ge1xuXHRjb25zdCBsb2NhbFBhZ2VzID0gbmV3IE1hcChsb2NhbFNlc3Npb24ucGFnZXMubWFwKChwYWdlKSA9PiBbcGFnZS5pZCwgcGFnZV0pKTtcblx0Y29uc3QgbmV4dFBhZ2VzOiBFZGl0b3JQYWdlW10gPSBbXTtcblx0Y29uc3QgbmV4dFBhZ2VWZXJzaW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4gPSB7fTtcblx0Y29uc3QgcHJvY2Vzc2VkTG9jYWxJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0bGV0IGNvbmZsaWN0Q291bnQgPSAwO1xuXHRsZXQgdXBkYXRlZEZyb21SZW1vdGUgPSBmYWxzZTtcblx0bGV0IGNvbmZsaWN0QWN0aXZlUGFnZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuXHRmb3IgKGNvbnN0IHJlbW90ZVBhZ2Ugb2YgcmVtb3RlLnBhZ2VzKSB7XG5cdFx0Y29uc3QgbG9jYWxQYWdlID0gbG9jYWxQYWdlcy5nZXQocmVtb3RlUGFnZS5pZCkgPz8gbnVsbDtcblx0XHRjb25zdCBjb250ZXh0ID0gYnVpbGRQYWdlU3luY0NvbnRleHQobG9jYWxQYWdlLCByZW1vdGVQYWdlLCBtZXRhLnBhZ2VWZXJzaW9uc1tyZW1vdGVQYWdlLmlkXSA/PyBudWxsKTtcblxuXHRcdC8vIFNhZmV0eSBjaGVjazogaWRlbnRpY2FsIGxvZ2ljYWwgcGFnZSBzdGF0ZSBpcyBuZXZlciBhIGNvbmZsaWN0LCBldmVuIHdoZW4gdGltZXN0YW1wcyBkaWZmZXIuXG5cdFx0aWYgKGNvbnRleHQubG9jYWxFeGlzdHMgJiYgY29udGV4dC5yZW1vdGVFeGlzdHMgJiYgc2FtZUxvZ2ljYWxTdGF0ZShjb250ZXh0LmxvY2FsU3RhdGUsIGNvbnRleHQucmVtb3RlU3RhdGUpKSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChtYXJrUGFnZVN5bmNlZChsb2NhbFBhZ2UhLCByZW1vdGVWZXJzaW9uKHJlbW90ZVBhZ2UpID8/IGxvY2FsUGFnZSEudXBkYXRlZEF0KSk7XG5cdFx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRcdHByb2Nlc3NlZExvY2FsSWRzLmFkZChyZW1vdGVQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIENhc2UgMTogTG9jYWwgbWlzc2luZywgcmVtb3RlIGV4aXN0cyBhbmQgcmVtb3RlIGlzIGFjdGl2ZS5cblx0XHRpZiAoIWNvbnRleHQubG9jYWxFeGlzdHMgJiYgY29udGV4dC5yZW1vdGVFeGlzdHMgJiYgIWNvbnRleHQucmVtb3RlRGVsZXRlZCkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2goYnVpbGRMb2NhbFBhZ2VGcm9tUmVtb3RlKHJlbW90ZVBhZ2UpKTtcblx0XHRcdG5leHRQYWdlVmVyc2lvbnNbcmVtb3RlUGFnZS5pZF0gPSByZW1vdGVWZXJzaW9uKHJlbW90ZVBhZ2UpO1xuXHRcdFx0dXBkYXRlZEZyb21SZW1vdGUgPSB0cnVlO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FzZSAyOiBMb2NhbCBtaXNzaW5nLCByZW1vdGUgZXhpc3RzIGFuZCByZW1vdGUgaXMgZGVsZXRlZC5cblx0XHRpZiAoIWNvbnRleHQubG9jYWxFeGlzdHMgJiYgY29udGV4dC5yZW1vdGVFeGlzdHMgJiYgY29udGV4dC5yZW1vdGVEZWxldGVkKSB7XG5cdFx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIENhc2UgNDogUmVtb3RlIGRlbGV0ZWQsIGxvY2FsIHVuY2hhbmdlZC5cblx0XHRpZiAoY29udGV4dC5sb2NhbEV4aXN0cyAmJiBjb250ZXh0LnJlbW90ZUV4aXN0cyAmJiBjb250ZXh0LnJlbW90ZURlbGV0ZWQgJiYgIWNvbnRleHQubG9jYWxDaGFuZ2VkU2luY2VTeW5jKSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChhcHBseVJlbW90ZVBhZ2VTdGF0ZShsb2NhbFBhZ2UhLCB0b1JlbW90ZVBhZ2VTdGF0ZShyZW1vdGVQYWdlLCBsb2NhbFBhZ2UhKSkpO1xuXHRcdFx0bmV4dFBhZ2VWZXJzaW9uc1tyZW1vdGVQYWdlLmlkXSA9IHJlbW90ZVZlcnNpb24ocmVtb3RlUGFnZSk7XG5cdFx0XHR1cGRhdGVkRnJvbVJlbW90ZSA9IHRydWU7XG5cdFx0XHRwcm9jZXNzZWRMb2NhbElkcy5hZGQocmVtb3RlUGFnZS5pZCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHQvLyBDYXNlIDU6IFJlbW90ZSBkZWxldGVkLCBsb2NhbCBjaGFuZ2VkLlxuXHRcdGlmIChjb250ZXh0LmxvY2FsRXhpc3RzICYmIGNvbnRleHQucmVtb3RlRXhpc3RzICYmIGNvbnRleHQucmVtb3RlRGVsZXRlZCAmJiBjb250ZXh0LmxvY2FsQ2hhbmdlZFNpbmNlU3luYykge1xuXHRcdFx0Y29uc3QgZGVsZXRlZExvY2FsUGFnZSA9IG1hcmtQYWdlRGVsZXRlZChsb2NhbFBhZ2UhKTtcblx0XHRcdGNvbnN0IGNvbmZsaWN0Q29weSA9IGNyZWF0ZUNvbmZsaWN0Q29weShsb2NhbFBhZ2UhLCBidWlsZExvY2FsQ29uZmxpY3RTdWZmaXgobm93KSwgbm93KTtcblxuXHRcdFx0bmV4dFBhZ2VzLnB1c2goY29uZmxpY3RDb3B5KTtcblx0XHRcdG5leHRQYWdlcy5wdXNoKGRlbGV0ZWRMb2NhbFBhZ2UpO1xuXHRcdFx0bmV4dFBhZ2VWZXJzaW9uc1tyZW1vdGVQYWdlLmlkXSA9IHJlbW90ZVZlcnNpb24ocmVtb3RlUGFnZSk7XG5cdFx0XHR1cGRhdGVkRnJvbVJlbW90ZSA9IHRydWU7XG5cdFx0XHRjb25mbGljdEFjdGl2ZVBhZ2VJZCA/Pz0gY29uZmxpY3RDb3B5LmlkO1xuXHRcdFx0Y29uZmxpY3RDb3VudCArPSAxO1xuXHRcdFx0cHJvY2Vzc2VkTG9jYWxJZHMuYWRkKHJlbW90ZVBhZ2UuaWQpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Ly8gTG9jYWwgZGVsZXRlIHdpbnMgd2hlbiByZW1vdGUgaGFzIG5vdCBvYnNlcnZlZCB0aGUgdG9tYnN0b25lIHlldC5cblx0XHQvLyBUaGlzIGF2b2lkcyBldmVudHVhbC1jb25zaXN0ZW5jeSByZXN1cnJlY3Rpb24gYWZ0ZXIgYSBsb2NhbCBkZWxldGUuXG5cdFx0aWYgKGNvbnRleHQubG9jYWxFeGlzdHMgJiYgY29udGV4dC5yZW1vdGVFeGlzdHMgJiYgY29udGV4dC5sb2NhbERlbGV0ZWQgJiYgIWNvbnRleHQucmVtb3RlRGVsZXRlZCkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2gobWFya1BhZ2VTeW5jZWQobG9jYWxQYWdlISwgcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKSA/PyBsb2NhbFBhZ2UhLnVwZGF0ZWRBdCkpO1xuXHRcdFx0bmV4dFBhZ2VWZXJzaW9uc1tyZW1vdGVQYWdlLmlkXSA9IHJlbW90ZVZlcnNpb24ocmVtb3RlUGFnZSk7XG5cdFx0XHRwcm9jZXNzZWRMb2NhbElkcy5hZGQocmVtb3RlUGFnZS5pZCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHQvLyBDYXNlIDY6IEJvdGggZXhpc3QsIG5laXRoZXIgZGVsZXRlZCwgbmVpdGhlciBzaWRlIGNoYW5nZWQuXG5cdFx0aWYgKFxuXHRcdFx0Y29udGV4dC5sb2NhbEV4aXN0cyAmJlxuXHRcdFx0Y29udGV4dC5yZW1vdGVFeGlzdHMgJiZcblx0XHRcdCFjb250ZXh0LmxvY2FsRGVsZXRlZCAmJlxuXHRcdFx0IWNvbnRleHQucmVtb3RlRGVsZXRlZCAmJlxuXHRcdFx0IWNvbnRleHQubG9jYWxDaGFuZ2VkU2luY2VTeW5jICYmXG5cdFx0XHQhY29udGV4dC5yZW1vdGVDaGFuZ2VkU2luY2VTeW5jXG5cdFx0KSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChtYXJrUGFnZVN5bmNlZChsb2NhbFBhZ2UhLCByZW1vdGVWZXJzaW9uKHJlbW90ZVBhZ2UpID8/IGxvY2FsUGFnZSEudXBkYXRlZEF0KSk7XG5cdFx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRcdHByb2Nlc3NlZExvY2FsSWRzLmFkZChyZW1vdGVQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIENhc2UgNzogT25seSBsb2NhbCBjaGFuZ2VkLlxuXHRcdGlmIChcblx0XHRcdGNvbnRleHQubG9jYWxFeGlzdHMgJiZcblx0XHRcdGNvbnRleHQucmVtb3RlRXhpc3RzICYmXG5cdFx0XHQhY29udGV4dC5sb2NhbERlbGV0ZWQgJiZcblx0XHRcdCFjb250ZXh0LnJlbW90ZURlbGV0ZWQgJiZcblx0XHRcdGNvbnRleHQubG9jYWxDaGFuZ2VkU2luY2VTeW5jICYmXG5cdFx0XHQhY29udGV4dC5yZW1vdGVDaGFuZ2VkU2luY2VTeW5jXG5cdFx0KSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChtYXJrUGFnZVN5bmNlZChsb2NhbFBhZ2UhLCByZW1vdGVWZXJzaW9uKHJlbW90ZVBhZ2UpID8/IGxvY2FsUGFnZSEudXBkYXRlZEF0KSk7XG5cdFx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRcdHByb2Nlc3NlZExvY2FsSWRzLmFkZChyZW1vdGVQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIENhc2UgODogT25seSByZW1vdGUgY2hhbmdlZC5cblx0XHRpZiAoXG5cdFx0XHRjb250ZXh0LmxvY2FsRXhpc3RzICYmXG5cdFx0XHRjb250ZXh0LnJlbW90ZUV4aXN0cyAmJlxuXHRcdFx0IWNvbnRleHQubG9jYWxEZWxldGVkICYmXG5cdFx0XHQhY29udGV4dC5yZW1vdGVEZWxldGVkICYmXG5cdFx0XHQhY29udGV4dC5sb2NhbENoYW5nZWRTaW5jZVN5bmMgJiZcblx0XHRcdGNvbnRleHQucmVtb3RlQ2hhbmdlZFNpbmNlU3luY1xuXHRcdCkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2goYnVpbGRMb2NhbFBhZ2VGcm9tUmVtb3RlKHJlbW90ZVBhZ2UpKTtcblx0XHRcdG5leHRQYWdlVmVyc2lvbnNbcmVtb3RlUGFnZS5pZF0gPSByZW1vdGVWZXJzaW9uKHJlbW90ZVBhZ2UpO1xuXHRcdFx0dXBkYXRlZEZyb21SZW1vdGUgPSB0cnVlO1xuXHRcdFx0cHJvY2Vzc2VkTG9jYWxJZHMuYWRkKHJlbW90ZVBhZ2UuaWQpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FzZSA5OiBCb3RoIGNoYW5nZWQuXG5cdFx0aWYgKFxuXHRcdFx0Y29udGV4dC5sb2NhbEV4aXN0cyAmJlxuXHRcdFx0Y29udGV4dC5yZW1vdGVFeGlzdHMgJiZcblx0XHRcdCFjb250ZXh0LmxvY2FsRGVsZXRlZCAmJlxuXHRcdFx0IWNvbnRleHQucmVtb3RlRGVsZXRlZCAmJlxuXHRcdFx0Y29udGV4dC5sb2NhbENoYW5nZWRTaW5jZVN5bmMgJiZcblx0XHRcdGNvbnRleHQucmVtb3RlQ2hhbmdlZFNpbmNlU3luY1xuXHRcdCkge1xuXHRcdFx0Y29uc3QgY29uZmxpY3RDb3B5ID0gY3JlYXRlQ29uZmxpY3RDb3B5KGxvY2FsUGFnZSEsIGJ1aWxkTG9jYWxDb25mbGljdFN1ZmZpeChub3cpLCBub3cpO1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2goY29uZmxpY3RDb3B5KTtcblx0XHRcdG5leHRQYWdlcy5wdXNoKGFwcGx5UmVtb3RlUGFnZVN0YXRlKGxvY2FsUGFnZSEsIHRvUmVtb3RlUGFnZVN0YXRlKHJlbW90ZVBhZ2UsIGxvY2FsUGFnZSEpKSk7XG5cdFx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRcdHVwZGF0ZWRGcm9tUmVtb3RlID0gdHJ1ZTtcblx0XHRcdGNvbmZsaWN0QWN0aXZlUGFnZUlkID8/PSBjb25mbGljdENvcHkuaWQ7XG5cdFx0XHRjb25mbGljdENvdW50ICs9IDE7XG5cdFx0XHRwcm9jZXNzZWRMb2NhbElkcy5hZGQocmVtb3RlUGFnZS5pZCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHQvLyBDYXNlIDMgaXMgaGFuZGxlZCBpbiB0aGUgbG9jYWwtb25seSBwYXNzIGJlbG93IHdoZW4gcmVtb3RlIHJvd3MgYXJlIG1pc3NpbmcuXG5cdFx0bmV4dFBhZ2VzLnB1c2goYXBwbHlSZW1vdGVQYWdlU3RhdGUobG9jYWxQYWdlISwgdG9SZW1vdGVQYWdlU3RhdGUocmVtb3RlUGFnZSwgbG9jYWxQYWdlISkpKTtcblx0XHRuZXh0UGFnZVZlcnNpb25zW3JlbW90ZVBhZ2UuaWRdID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKTtcblx0XHRwcm9jZXNzZWRMb2NhbElkcy5hZGQocmVtb3RlUGFnZS5pZCk7XG5cdH1cblxuXHRmb3IgKGNvbnN0IGxvY2FsUGFnZSBvZiBsb2NhbFNlc3Npb24ucGFnZXMpIHtcblx0XHRpZiAocHJvY2Vzc2VkTG9jYWxJZHMuaGFzKGxvY2FsUGFnZS5pZCkpIHtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IGxhc3RTeW5jZWRTdGF0ZSA9IGdldExhc3RTeW5jZWRTdGF0ZShsb2NhbFBhZ2UsIG1ldGEucGFnZVZlcnNpb25zW2xvY2FsUGFnZS5pZF0gPz8gbnVsbCk7XG5cdFx0Y29uc3QgbG9jYWxTdGF0ZSA9IGdldExvY2FsTG9naWNhbFN0YXRlKGxvY2FsUGFnZSk7XG5cdFx0Y29uc3QgbG9jYWxDaGFuZ2VkU2luY2VTeW5jID0gIXNhbWVMb2dpY2FsU3RhdGUobG9jYWxTdGF0ZSwgbGFzdFN5bmNlZFN0YXRlKTtcblxuXHRcdC8vIENhc2UgMzogTG9jYWwgZXhpc3RzLCByZW1vdGUgbWlzc2luZy5cblx0XHRpZiAoIWxhc3RTeW5jZWRTdGF0ZSAmJiBsb2NhbFBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2xvY2FsLW9ubHknKSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChsb2NhbFBhZ2UpO1xuXHRcdFx0bmV4dFBhZ2VWZXJzaW9uc1tsb2NhbFBhZ2UuaWRdID0gbG9jYWxQYWdlLmxhc3RTeW5jZWRWZXJzaW9uO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKCFsYXN0U3luY2VkU3RhdGUpIHtcblx0XHRcdGNvbnNvbGUud2FybihgU3luYyBpbmNvbnNpc3RlbmN5OiByZW1vdGUgcGFnZSAke2xvY2FsUGFnZS5pZH0gaXMgbWlzc2luZyBidXQgbG9jYWwgZGF0YSBleGlzdHMuYCk7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChsb2NhbFBhZ2UpO1xuXHRcdFx0bmV4dFBhZ2VWZXJzaW9uc1tsb2NhbFBhZ2UuaWRdID0gbG9jYWxQYWdlLmxhc3RTeW5jZWRWZXJzaW9uID8/IG51bGw7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobG9jYWxDaGFuZ2VkU2luY2VTeW5jKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFN5bmMgaW5jb25zaXN0ZW5jeTogcmVtb3RlIHBhZ2UgJHtsb2NhbFBhZ2UuaWR9IGlzIG1pc3NpbmcgYWZ0ZXIgYSBwcmlvciBzeW5jLmApO1xuXHRcdH1cblxuXHRcdG5leHRQYWdlcy5wdXNoKGxvY2FsUGFnZSk7XG5cdFx0bmV4dFBhZ2VWZXJzaW9uc1tsb2NhbFBhZ2UuaWRdID0gbG9jYWxQYWdlLmxhc3RTeW5jZWRWZXJzaW9uID8/IG1ldGEucGFnZVZlcnNpb25zW2xvY2FsUGFnZS5pZF0gPz8gbnVsbDtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0c2Vzc2lvbjoge1xuXHRcdFx0cGFnZXM6IG5leHRQYWdlcyxcblx0XHRcdGFjdGl2ZVBhZ2VJZDpcblx0XHRcdFx0Y29uZmxpY3RBY3RpdmVQYWdlSWQgPz9cblx0XHRcdFx0bmV4dFBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IGxvY2FsU2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgIXBhZ2UuZGVsZXRlZEF0KT8uaWQgPz9cblx0XHRcdFx0bmV4dFBhZ2VzLmZpbmQoKHBhZ2UpID0+ICFwYWdlLmRlbGV0ZWRBdCk/LmlkID8/XG5cdFx0XHRcdG5leHRQYWdlc1swXT8uaWQgPz9cblx0XHRcdFx0bG9jYWxTZXNzaW9uLmFjdGl2ZVBhZ2VJZFxuXHRcdH0sXG5cdFx0Y29uZmxpY3RDb3VudCxcblx0XHR1cGRhdGVkRnJvbVJlbW90ZSxcblx0XHRwYWdlVmVyc2lvbnM6IG5leHRQYWdlVmVyc2lvbnNcblx0fTtcbn1cblxuZnVuY3Rpb24gYnVpbGRQYWdlU3luY0NvbnRleHQoXG5cdGxvY2FsUGFnZTogRWRpdG9yUGFnZSB8IG51bGwsXG5cdHJlbW90ZVBhZ2U6IFJlbW90ZVBhZ2VSZWNvcmQsXG5cdGxhc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsXG4pOiBQYWdlU3luY0NvbnRleHQge1xuXHRjb25zdCBsb2NhbFN0YXRlID0gbG9jYWxQYWdlID8gZ2V0TG9jYWxMb2dpY2FsU3RhdGUobG9jYWxQYWdlKSA6IG51bGw7XG5cdGNvbnN0IHJlbW90ZVN0YXRlID0gZ2V0UmVtb3RlTG9naWNhbFN0YXRlKHJlbW90ZVBhZ2UpO1xuXHRjb25zdCBsYXN0U3luY2VkU3RhdGUgPSBsb2NhbFBhZ2UgPyBnZXRMYXN0U3luY2VkU3RhdGUobG9jYWxQYWdlLCBsYXN0VmVyc2lvbikgOiBudWxsO1xuXG5cdHJldHVybiB7XG5cdFx0bG9jYWxFeGlzdHM6IGxvY2FsUGFnZSAhPT0gbnVsbCxcblx0XHRyZW1vdGVFeGlzdHM6IHRydWUsXG5cdFx0bG9jYWxEZWxldGVkOiBsb2NhbFBhZ2U/LmRlbGV0ZWRBdCAhPSBudWxsLFxuXHRcdHJlbW90ZURlbGV0ZWQ6IHJlbW90ZVN0YXRlLmRlbGV0ZWQsXG5cdFx0bG9jYWxDaGFuZ2VkU2luY2VTeW5jOiBsb2NhbFBhZ2Vcblx0XHRcdD8gIXNhbWVMb2dpY2FsU3RhdGUobG9jYWxTdGF0ZSwgbGFzdFN5bmNlZFN0YXRlKSB8fCAoIWxhc3RTeW5jZWRTdGF0ZSAmJiBsb2NhbFBhZ2UuZGlydHkpXG5cdFx0XHQ6IGZhbHNlLFxuXHRcdHJlbW90ZUNoYW5nZWRTaW5jZVN5bmM6ICFzYW1lTG9naWNhbFN0YXRlKHJlbW90ZVN0YXRlLCBsYXN0U3luY2VkU3RhdGUpLFxuXHRcdGxvY2FsU3RhdGUsXG5cdFx0cmVtb3RlU3RhdGVcblx0fTtcbn1cblxuZnVuY3Rpb24gZ2V0TG9jYWxMb2dpY2FsU3RhdGUocGFnZTogRWRpdG9yUGFnZSk6IFBhZ2VMb2dpY2FsU3RhdGUge1xuXHRyZXR1cm4ge1xuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHRkZWxldGVkOiBwYWdlLmRlbGV0ZWRBdCAhPSBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIGdldFJlbW90ZUxvZ2ljYWxTdGF0ZShwYWdlOiBSZW1vdGVQYWdlUmVjb3JkKTogUGFnZUxvZ2ljYWxTdGF0ZSB7XG5cdHJldHVybiB7XG5cdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWQ6IHBhZ2UuZGVsZXRlZF9hdCAhPSBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIGdldExhc3RTeW5jZWRTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBmYWxsYmFja1ZlcnNpb246IHN0cmluZyB8IG51bGwpOiBQYWdlTG9naWNhbFN0YXRlIHwgbnVsbCB7XG5cdGNvbnN0IGxhc3RTeW5jZWRBdCA9IHBhZ2UubGFzdFN5bmNlZEF0ID8/IGZhbGxiYWNrVmVyc2lvbjtcblx0aWYgKCFsYXN0U3luY2VkQXQpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0dGl0bGU6IHBhZ2UubGFzdFN5bmNlZFRpdGxlID8/IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5sYXN0U3luY2VkQ29udGVudCA/PyBwYWdlLmNvbnRlbnQsXG5cdFx0ZGVsZXRlZDogKHBhZ2UubGFzdFN5bmNlZERlbGV0ZWRBdCA/PyBwYWdlLmRlbGV0ZWRBdCkgIT0gbnVsbFxuXHR9O1xufVxuXG5mdW5jdGlvbiBzYW1lTG9naWNhbFN0YXRlKGE6IFBhZ2VMb2dpY2FsU3RhdGUgfCBudWxsLCBiOiBQYWdlTG9naWNhbFN0YXRlIHwgbnVsbCk6IGJvb2xlYW4ge1xuXHRpZiAoIWEgfHwgIWIpIHtcblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cblxuXHRyZXR1cm4gYS50aXRsZSA9PT0gYi50aXRsZSAmJiBhLmNvbnRlbnQgPT09IGIuY29udGVudCAmJiBhLmRlbGV0ZWQgPT09IGIuZGVsZXRlZDtcbn1cblxuZnVuY3Rpb24gcmVtb3RlVmVyc2lvbihwYWdlOiBSZW1vdGVQYWdlUmVjb3JkKTogc3RyaW5nIHwgbnVsbCB7XG5cdHJldHVybiBwYWdlLnVwZGF0ZWRfYXQgPz8gcGFnZS5jcmVhdGVkX2F0ID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTG9jYWxQYWdlRnJvbVJlbW90ZShyZW1vdGVQYWdlOiBSZW1vdGVQYWdlUmVjb3JkKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlbW90ZVBhZ2UuY3JlYXRlZF9hdCA/PyByZW1vdGVQYWdlLnVwZGF0ZWRfYXQgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4gYXBwbHlSZW1vdGVQYWdlU3RhdGUoXG5cdFx0e1xuXHRcdFx0aWQ6IHJlbW90ZVBhZ2UuaWQsXG5cdFx0XHR0aXRsZTogcmVtb3RlUGFnZS50aXRsZSxcblx0XHRcdGNvbnRlbnQ6IHJlbW90ZVBhZ2UuY29udGVudCxcblx0XHRcdHRleHQ6IHJlbW90ZVBhZ2UuY29udGVudCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0c2VsZWN0aW9uRW5kOiAwLFxuXHRcdFx0Y3JlYXRlZEF0LFxuXHRcdFx0dXBkYXRlZEF0OiBjcmVhdGVkQXQsXG5cdFx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0XHRsYXN0U3luY2VkVGl0bGU6IG51bGwsXG5cdFx0XHRsYXN0U3luY2VkQ29udGVudDogbnVsbCxcblx0XHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRcdHN5bmNTdGF0dXM6ICdsb2NhbC1vbmx5Jyxcblx0XHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBudWxsXG5cdFx0fSxcblx0XHR0b1JlbW90ZVBhZ2VTdGF0ZShyZW1vdGVQYWdlLCB7IGNyZWF0ZWRBdCwgdXBkYXRlZEF0OiBjcmVhdGVkQXQgfSlcblx0KTtcbn1cblxuZnVuY3Rpb24gdG9SZW1vdGVQYWdlU3RhdGUoXG5cdHJlbW90ZVBhZ2U6IFJlbW90ZVBhZ2VSZWNvcmQsXG5cdGZhbGxiYWNrOiBQaWNrPEVkaXRvclBhZ2UsICdjcmVhdGVkQXQnIHwgJ3VwZGF0ZWRBdCc+XG4pIHtcblx0Y29uc3QgY3JlYXRlZEF0ID0gcmVtb3RlUGFnZS5jcmVhdGVkX2F0ID8/IGZhbGxiYWNrLmNyZWF0ZWRBdDtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVtb3RlVmVyc2lvbihyZW1vdGVQYWdlKSA/PyBmYWxsYmFjay51cGRhdGVkQXQ7XG5cdHJldHVybiB7XG5cdFx0dGl0bGU6IHJlbW90ZVBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcmVtb3RlUGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWRBdDogcmVtb3RlUGFnZS5kZWxldGVkX2F0ID8/IG51bGwsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdFxuXHR9O1xufVxuXG5mdW5jdGlvbiBidWlsZExvY2FsQ29uZmxpY3RTdWZmaXgobm93OiBEYXRlKTogc3RyaW5nIHtcblx0Y29uc3QgdGltZXN0YW1wID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQodW5kZWZpbmVkLCB7XG5cdFx0ZGF0ZVN0eWxlOiAnbWVkaXVtJyxcblx0XHR0aW1lU3R5bGU6ICdzaG9ydCdcblx0fSkuZm9ybWF0KG5vdyk7XG5cblx0cmV0dXJuIGAoTG9jYWwgY29uZmxpY3QgJHt0aW1lc3RhbXB9KWA7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDd0JaLElBQU0sZ0JBQWdCO0FBRXRCLFNBQVMsZ0JBQWdCLFNBQXlCO0FBQ3hELFFBQU0sWUFBWSxRQUNoQixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQztBQUVoQyxNQUFJLENBQUMsV0FBVztBQUNmLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTyxVQUFVLFFBQVEsUUFBUSxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFDbEQ7QUFFTyxTQUFTLFdBQVcsVUFBVSxJQUFJLEtBQUssYUFBYSxHQUFlO0FBQ3pFLFFBQU0sYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUN6QyxTQUFPO0FBQUEsSUFDTjtBQUFBLElBQ0EsT0FBTyxnQkFBZ0IsT0FBTztBQUFBLElBQzlCO0FBQUEsSUFDQSxNQUFNO0FBQUEsSUFDTixnQkFBZ0I7QUFBQSxJQUNoQixjQUFjO0FBQUEsSUFDZDtBQUFBLElBQ0EsV0FBVztBQUFBLElBQ1gsV0FBVztBQUFBLElBQ1gsY0FBYztBQUFBLElBQ2QsaUJBQWlCO0FBQUEsSUFDakIsbUJBQW1CO0FBQUEsSUFDbkIscUJBQXFCO0FBQUEsSUFDckIsT0FBTztBQUFBLElBQ1AsWUFBWTtBQUFBLElBQ1osbUJBQW1CO0FBQUEsRUFDcEI7QUFDRDtBQUVPLFNBQVMsZ0JBQStCO0FBQzlDLFFBQU0sT0FBTyxXQUFXO0FBQ3hCLFNBQU87QUFBQSxJQUNOLE9BQU8sQ0FBQyxJQUFJO0FBQUEsSUFDWixjQUFjLEtBQUs7QUFBQSxFQUNwQjtBQUNEO0FBa0RPLFNBQVMsZ0JBQWdCLE1BQWtCLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVks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
