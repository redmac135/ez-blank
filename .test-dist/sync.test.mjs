// tests/sync.test.ts
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
function createPageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `page-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
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

// src/lib/editor/sync.ts
var REMOTE_PAGE_COLUMNS = "id,user_id,title,content,created_at,updated_at,deleted_at";
var syncInProgress = false;
function isSyncInProgress() {
  return syncInProgress;
}
function reconcileSyncResult(currentSession, syncSourceSession, syncedSession) {
  const sourceById = new Map(syncSourceSession.pages.map((page) => [page.id, page]));
  const syncedById = new Map(syncedSession.pages.map((page) => [page.id, page]));
  const mergedPages = [];
  const seenPageIds = /* @__PURE__ */ new Set();
  for (const currentPage of currentSession.pages) {
    const sourcePage = sourceById.get(currentPage.id) ?? null;
    const syncedPage = syncedById.get(currentPage.id) ?? null;
    if (!sourcePage || !syncedPage) {
      mergedPages.push(currentPage);
      seenPageIds.add(currentPage.id);
      continue;
    }
    if (!hasPageChangedSinceSource(currentPage, sourcePage)) {
      mergedPages.push(preserveLocalSelection(syncedPage, currentPage));
      seenPageIds.add(currentPage.id);
      continue;
    }
    if (pageStatesMatch(sourcePage, toRemoteShape(syncedPage))) {
      mergedPages.push(mergeSyncedBaselineIntoCurrentPage(currentPage, syncedPage));
      seenPageIds.add(currentPage.id);
      continue;
    }
    mergedPages.push(currentPage);
    seenPageIds.add(currentPage.id);
  }
  for (const syncedPage of syncedSession.pages) {
    if (seenPageIds.has(syncedPage.id)) {
      continue;
    }
    mergedPages.push(syncedPage);
  }
  return ensureValidActivePage({
    pages: sortPages(mergedPages),
    activePageId: currentSession.activePageId
  });
}
async function syncUserPages(supabase, userId, localSession, now = /* @__PURE__ */ new Date()) {
  if (syncInProgress) {
    throw new Error("Sync already in progress.");
  }
  syncInProgress = true;
  try {
    const remoteSnapshot = await pullRemoteSnapshot(supabase, userId);
    const remoteById = new Map(remoteSnapshot.map((page) => [page.id, page]));
    const processedRemoteIds = /* @__PURE__ */ new Set();
    const nextPages = [];
    let pushedCount = 0;
    let pulledCount = 0;
    let conflictCount = 0;
    let nextActivePageId = localSession.activePageId;
    for (const localPage of sortPages(localSession.pages.filter((page) => page.userId === userId))) {
      if (localPage.isEphemeral) {
        nextPages.push(localPage);
        continue;
      }
      const remote = remoteById.get(localPage.id) ?? null;
      if (!remote) {
        if (localPage.deletedAt !== null) {
          continue;
        }
        const pushed = await pushLocalPage(supabase, userId, localPage);
        nextPages.push(toSyncedLocalPage(pushed, localPage));
        pushedCount += 1;
        continue;
      }
      processedRemoteIds.add(remote.id);
      const localChanged = hasLocalChangedSinceSync(localPage);
      const remoteChanged = hasRemoteChangedSinceSync(localPage, remote);
      const sameState = pageStatesMatch(localPage, remote);
      if (!localChanged && !remoteChanged) {
        if (shouldKeepRemotePageLocally(remote)) {
          nextPages.push(toSyncedLocalPage(remote, localPage));
        }
        continue;
      }
      if (sameState) {
        if (shouldKeepRemotePageLocally(remote)) {
          nextPages.push(toSyncedLocalPage(remote, localPage));
        }
        continue;
      }
      if (localChanged && !remoteChanged) {
        const pushed = await pushLocalPage(supabase, userId, localPage);
        nextPages.push(toSyncedLocalPage(pushed, localPage));
        pushedCount += 1;
        continue;
      }
      if (!localChanged && remoteChanged) {
        if (shouldKeepRemotePageLocally(remote)) {
          nextPages.push(toSyncedLocalPage(remote, localPage));
        }
        pulledCount += 1;
        continue;
      }
      const remotePage = toSyncedLocalPage(remote, localPage);
      conflictCount += 1;
      if (shouldKeepRemotePageLocally(remote)) {
        nextPages.push(remotePage);
      }
      const conflictFork = forkConflictPage(localPage, now);
      const pushedFork = await pushLocalPage(supabase, userId, conflictFork);
      const syncedFork = toSyncedLocalPage(pushedFork, conflictFork);
      nextPages.push(syncedFork);
      pushedCount += 1;
      if (localSession.activePageId === localPage.id && remotePage.deletedAt !== null) {
        nextActivePageId = syncedFork.id;
      }
    }
    for (const remote of remoteSnapshot) {
      if (processedRemoteIds.has(remote.id)) {
        continue;
      }
      if (!shouldKeepRemotePageLocally(remote)) {
        continue;
      }
      nextPages.push(toSyncedLocalPage(remote, null));
      pulledCount += 1;
    }
    const nextSession = ensureValidActivePage({
      pages: sortPages(nextPages),
      activePageId: nextActivePageId
    });
    return {
      session: nextSession,
      pushedCount,
      pulledCount,
      conflictCount
    };
  } finally {
    syncInProgress = false;
  }
}
async function fetchRemoteActivePageId(supabase, userId) {
  const { data, error } = await supabase.from("user_settings").select("active_page_id,user_id,created_at,updated_at").eq("user_id", userId).maybeSingle();
  if (error) {
    throw error;
  }
  return data?.active_page_id ?? null;
}
function forkConflictPage(page, now = /* @__PURE__ */ new Date()) {
  const timestamp = now.toISOString();
  const fork = createPage(page.content, { userId: page.userId, now: timestamp, isEphemeral: false });
  return {
    ...fork,
    title: `${page.title} ${buildConflictSuffix(now)}`.trim(),
    content: page.content,
    text: page.content,
    selectionStart: page.selectionStart,
    selectionEnd: page.selectionEnd,
    deletedAt: null,
    syncStatus: "dirty",
    isEphemeral: false
  };
}
async function pullRemoteSnapshot(supabase, userId) {
  const { data, error } = await supabase.from("pages").select(REMOTE_PAGE_COLUMNS).eq("user_id", userId).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) {
    throw error;
  }
  return data ?? [];
}
async function pushLocalPage(supabase, userId, localPage) {
  const { data, error } = await supabase.from("pages").upsert(
    {
      id: localPage.id,
      user_id: userId,
      title: localPage.title,
      content: localPage.content,
      created_at: localPage.createdAt,
      updated_at: localPage.updatedAt,
      deleted_at: localPage.deletedAt
    },
    { onConflict: "id" }
  ).select(REMOTE_PAGE_COLUMNS).single();
  if (error) {
    throw error;
  }
  return data;
}
function toSyncedLocalPage(remote, localPage) {
  const base = localPage ?? createPage(remote.content, {
    id: remote.id,
    userId: remote.user_id,
    now: remote.created_at,
    isEphemeral: false
  });
  return {
    ...base,
    id: remote.id,
    userId: remote.user_id,
    title: remote.title,
    content: remote.content,
    text: remote.content,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
    deletedAt: remote.deleted_at,
    lastSyncedAt: remote.updated_at,
    lastKnownRemoteUpdatedAt: remote.updated_at,
    lastKnownRemoteDeletedAt: remote.deleted_at,
    syncStatus: "synced",
    isEphemeral: false
  };
}
function preserveLocalSelection(page, selectionSource) {
  return {
    ...page,
    selectionStart: Math.max(0, Math.min(selectionSource.selectionStart, page.content.length)),
    selectionEnd: Math.max(0, Math.min(selectionSource.selectionEnd, page.content.length))
  };
}
function toRemoteShape(page) {
  return {
    id: page.id,
    user_id: page.userId,
    title: page.title,
    content: page.content,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
    deleted_at: page.deletedAt
  };
}
function hasPageChangedSinceSource(currentPage, sourcePage) {
  return currentPage.title !== sourcePage.title || currentPage.content !== sourcePage.content || currentPage.deletedAt !== sourcePage.deletedAt || currentPage.updatedAt !== sourcePage.updatedAt || currentPage.isEphemeral !== sourcePage.isEphemeral;
}
function mergeSyncedBaselineIntoCurrentPage(currentPage, syncedPage) {
  const nextPage = {
    ...currentPage,
    userId: syncedPage.userId,
    createdAt: syncedPage.createdAt,
    lastSyncedAt: syncedPage.lastSyncedAt,
    lastKnownRemoteUpdatedAt: syncedPage.lastKnownRemoteUpdatedAt,
    lastKnownRemoteDeletedAt: syncedPage.lastKnownRemoteDeletedAt
  };
  return {
    ...nextPage,
    syncStatus: syncedPage.lastSyncedAt !== null && latestLocalMutationAt(nextPage) > syncedPage.lastSyncedAt ? "dirty" : "synced"
  };
}
function hasLocalChangedSinceSync(localPage) {
  if (localPage.lastSyncedAt === null) {
    return true;
  }
  return latestLocalMutationAt(localPage) > localPage.lastSyncedAt;
}
function hasRemoteChangedSinceSync(localPage, remote) {
  if (localPage.lastSyncedAt === null) {
    return true;
  }
  return latestRemoteMutationAt(remote) > localPage.lastSyncedAt;
}
function latestLocalMutationAt(localPage) {
  return localPage.deletedAt && localPage.deletedAt > localPage.updatedAt ? localPage.deletedAt : localPage.updatedAt;
}
function latestRemoteMutationAt(remote) {
  return remote.deleted_at && remote.deleted_at > remote.updated_at ? remote.deleted_at : remote.updated_at;
}
function pageStatesMatch(localPage, remote) {
  return localPage.title === remote.title && localPage.content === remote.content && (localPage.deletedAt ?? null) === (remote.deleted_at ?? null);
}
function shouldKeepRemotePageLocally(remote) {
  return remote.deleted_at === null;
}
function buildConflictSuffix(now) {
  const label = new Intl.DateTimeFormat(void 0, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(now);
  return `(Local conflict ${label})`;
}
function sortPages(pages) {
  return [...pages].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
    if (left.createdAt !== right.createdAt) {
      return right.createdAt.localeCompare(left.createdAt);
    }
    return left.id.localeCompare(right.id);
  });
}

// tests/sync.test.ts
var FakeSupabase = class {
  pages = /* @__PURE__ */ new Map();
  userSettings = /* @__PURE__ */ new Map();
  constructor(rows = [], settings = []) {
    for (const row of rows) {
      this.pages.set(row.id, { ...row });
    }
    for (const setting of settings) {
      this.userSettings.set(setting.user_id, { ...setting });
    }
  }
  from(table) {
    if (table === "pages") {
      const api = this;
      return {
        select() {
          let userId = "";
          return {
            eq(column, value) {
              assert.equal(column, "user_id");
              userId = value;
              return this;
            },
            order() {
              return this;
            },
            then(resolve) {
              const rows = [...api.pages.values()].filter((row) => row.user_id === userId);
              return Promise.resolve(resolve({ data: rows, error: null }));
            }
          };
        },
        upsert(payload) {
          api.pages.set(payload.id, { ...payload });
          return {
            select() {
              return {
                async single() {
                  return { data: api.pages.get(payload.id) ?? null, error: null };
                }
              };
            }
          };
        }
      };
    }
    if (table === "user_settings") {
      const api = this;
      return {
        select() {
          let userId = "";
          return {
            eq(column, value) {
              assert.equal(column, "user_id");
              userId = value;
              return this;
            },
            async maybeSingle() {
              return { data: api.userSettings.get(userId) ?? null, error: null };
            }
          };
        },
        async upsert(payload) {
          api.userSettings.set(payload.user_id, { ...payload });
          return { error: null };
        }
      };
    }
    throw new Error(`Unexpected table ${table}`);
  }
  getRows(userId) {
    return [...this.pages.values()].filter((row) => row.user_id === userId);
  }
  getActivePageId(userId) {
    return this.userSettings.get(userId)?.active_page_id ?? null;
  }
};
function buildSession(page, activePageId = page.id) {
  return {
    pages: [page],
    activePageId
  };
}
test("forkConflictPage creates a visible local fork with a new id and suffix", () => {
  const source = createPage("body", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  source.title = "My Page";
  source.deletedAt = "2026-04-17T18:05:00.000Z";
  const fork = forkConflictPage(source, /* @__PURE__ */ new Date("2026-04-17T18:10:00.000Z"));
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.userId, "user-a");
  assert.equal(fork.deletedAt, null);
  assert.equal(fork.syncStatus, "dirty");
  assert.equal(fork.isEphemeral, false);
  assert.match(fork.title, /^My Page \(Local conflict /);
});
test("fetchRemoteActivePageId reads remote user settings only when asked", async () => {
  const supabase = new FakeSupabase([], [{ user_id: "user-a", active_page_id: "page-2" }]);
  assert.equal(await fetchRemoteActivePageId(supabase, "user-a"), "page-2");
  assert.equal(await fetchRemoteActivePageId(supabase, "user-b"), null);
});
test("syncUserPages ignores ephemeral placeholder pages", async () => {
  const local = createPage("", { id: "page-ephemeral", userId: "user-a", isEphemeral: true });
  const supabase = new FakeSupabase();
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:02:00.000Z"));
  assert.equal(result.pushedCount, 0);
  assert.equal(result.session.pages[0]?.id, "page-ephemeral");
  assert.equal(result.session.pages[0]?.isEphemeral, true);
  assert.equal(supabase.getRows("user-a").length, 0);
});
test("syncUserPages pushes local-only real pages and trusts the write response", async () => {
  const local = createPage("local body", {
    id: "local-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  local.title = "Local";
  local.updatedAt = "2026-04-17T18:01:00.000Z";
  const supabase = new FakeSupabase();
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:02:00.000Z"));
  assert.equal(result.pushedCount, 1);
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.equal(result.session.pages[0]?.lastSyncedAt, "2026-04-17T18:01:00.000Z");
  assert.equal(supabase.getRows("user-a").length, 1);
  assert.equal(supabase.getRows("user-a")[0]?.id, "local-1");
});
test("syncUserPages removes locally deleted pages when the remote row is already gone", async () => {
  const local = createPage("local body", {
    id: "local-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  local.title = "Local";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.deletedAt = "2026-04-17T18:02:00.000Z";
  local.updatedAt = "2026-04-17T18:02:00.000Z";
  local.syncStatus = "dirty";
  const supabase = new FakeSupabase();
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:03:00.000Z"));
  assert.equal(result.pushedCount, 0);
  assert.equal(result.pulledCount, 0);
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.isEphemeral, true);
  assert.notEqual(result.session.pages[0]?.id, "local-1");
  assert.equal(supabase.getRows("user-a").length, 0);
});
test("syncUserPages pulls remote-only pages into the local session", async () => {
  const supabase = new FakeSupabase([
    {
      id: "remote-1",
      user_id: "user-a",
      title: "Remote",
      content: "remote body",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:00:00.000Z",
      deleted_at: null
    }
  ]);
  const emptyLocal = { pages: [], activePageId: "missing" };
  const result = await syncUserPages(supabase, "user-a", emptyLocal, /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.pulledCount, 1);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.id, "remote-1");
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.equal(result.session.pages[0]?.lastSyncedAt, "2026-04-17T18:00:00.000Z");
  assert.equal(result.session.pages[0]?.isEphemeral, false);
});
test("syncUserPages ignores remote-only pages that are already deleted", async () => {
  const supabase = new FakeSupabase([
    {
      id: "remote-1",
      user_id: "user-a",
      title: "Remote",
      content: "remote body",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:00:00.000Z",
      deleted_at: "2026-04-17T18:00:00.000Z"
    }
  ]);
  const emptyLocal = { pages: [], activePageId: "missing" };
  const result = await syncUserPages(supabase, "user-a", emptyLocal, /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.pulledCount, 0);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.isEphemeral, true);
});
test("reconcileSyncResult advances sync metadata without discarding newer local edits", () => {
  const source = createPage("alpha", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  source.title = "Alpha";
  source.updatedAt = "2026-04-17T18:01:00.000Z";
  source.lastSyncedAt = "2026-04-17T18:00:00.000Z";
  source.lastKnownRemoteUpdatedAt = "2026-04-17T18:00:00.000Z";
  source.lastKnownRemoteDeletedAt = null;
  source.syncStatus = "dirty";
  const current = {
    ...source,
    content: "alpha beta",
    text: "alpha beta",
    title: "Alpha beta",
    updatedAt: "2026-04-17T18:02:00.000Z",
    syncStatus: "dirty"
  };
  const synced = {
    ...source,
    lastSyncedAt: "2026-04-17T18:01:00.000Z",
    lastKnownRemoteUpdatedAt: "2026-04-17T18:01:00.000Z",
    syncStatus: "synced"
  };
  const result = reconcileSyncResult(buildSession(current), buildSession(source), buildSession(synced));
  assert.equal(result.pages[0]?.content, "alpha beta");
  assert.equal(result.pages[0]?.title, "Alpha beta");
  assert.equal(result.pages[0]?.lastSyncedAt, "2026-04-17T18:01:00.000Z");
  assert.equal(result.pages[0]?.lastKnownRemoteUpdatedAt, "2026-04-17T18:01:00.000Z");
  assert.equal(result.pages[0]?.syncStatus, "dirty");
});
test("reconcileSyncResult appends new synced pages while preserving current local pages", () => {
  const source = createPage("alpha", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  source.title = "Alpha";
  source.updatedAt = "2026-04-17T18:01:00.000Z";
  const current = {
    ...source,
    content: "alpha beta",
    text: "alpha beta",
    title: "Alpha beta",
    updatedAt: "2026-04-17T18:02:00.000Z",
    syncStatus: "dirty"
  };
  const conflictFork = createPage("fork body", {
    id: "page-fork",
    userId: "user-a",
    now: "2026-04-17T18:03:00.000Z",
    isEphemeral: false
  });
  conflictFork.title = "Fork";
  conflictFork.updatedAt = "2026-04-17T18:03:00.000Z";
  conflictFork.lastSyncedAt = "2026-04-17T18:03:00.000Z";
  conflictFork.lastKnownRemoteUpdatedAt = "2026-04-17T18:03:00.000Z";
  conflictFork.lastKnownRemoteDeletedAt = null;
  conflictFork.syncStatus = "synced";
  const synced = {
    ...source,
    lastSyncedAt: "2026-04-17T18:01:00.000Z",
    lastKnownRemoteUpdatedAt: "2026-04-17T18:01:00.000Z",
    syncStatus: "synced"
  };
  const result = reconcileSyncResult(
    buildSession(current),
    buildSession(source),
    { pages: [synced, conflictFork], activePageId: current.id }
  );
  assert.equal(result.pages.some((page) => page.id === "page-1" && page.content === "alpha beta"), true);
  assert.equal(result.pages.some((page) => page.id === "page-fork" && page.content === "fork body"), true);
});
test("syncUserPages forks when local and remote both changed", async () => {
  const local = createPage("local edit", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  local.title = "Shared";
  local.updatedAt = "2026-04-17T18:03:00.000Z";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.syncStatus = "dirty";
  const supabase = new FakeSupabase([
    {
      id: "page-1",
      user_id: "user-a",
      title: "Shared",
      content: "remote edit",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: null
    }
  ]);
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.conflictCount, 1);
  assert.equal(result.pushedCount, 1);
  assert.equal(result.session.pages.length, 2);
  assert.notEqual(result.session.pages[0]?.id, "page-1");
  assert.match(result.session.pages[0]?.title ?? "", /^Shared \(Local conflict /);
  assert.equal(result.session.pages[0]?.content, "local edit");
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.equal(result.session.pages[0]?.lastSyncedAt, result.session.pages[0]?.updatedAt);
  assert.equal(result.session.pages[0]?.isEphemeral, false);
  assert.equal(result.session.pages[1]?.id, "page-1");
  assert.equal(result.session.pages[1]?.content, "remote edit");
  assert.equal(result.session.pages[1]?.syncStatus, "synced");
  assert.equal(supabase.getRows("user-a").length, 2);
  assert.equal(supabase.getRows("user-a").some((row) => row.content === "local edit"), true);
});
test("syncUserPages handles remote delete versus local edit by forking the local edit", async () => {
  const local = createPage("keep me locally", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  local.title = "Conflict";
  local.updatedAt = "2026-04-17T18:03:00.000Z";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.syncStatus = "dirty";
  const supabase = new FakeSupabase([
    {
      id: "page-1",
      user_id: "user-a",
      title: "Conflict",
      content: "server copy",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: "2026-04-17T18:04:00.000Z"
    }
  ]);
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.conflictCount, 1);
  assert.equal(result.pushedCount, 1);
  assert.equal(result.session.pages.length, 1);
  assert.notEqual(result.session.pages[0]?.id, "page-1");
  assert.equal(result.session.pages[0]?.deletedAt, null);
  assert.equal(result.session.pages[0]?.content, "keep me locally");
  assert.match(result.session.pages[0]?.title ?? "", /^Conflict \(Local conflict /);
  assert.equal(supabase.getRows("user-a").length, 2);
  assert.equal(supabase.getRows("user-a").some((row) => row.id === "page-1" && row.deleted_at !== null), true);
  assert.equal(supabase.getRows("user-a").some((row) => row.content === "keep me locally" && row.deleted_at === null), true);
});
test("syncUserPages removes local pages when the remote version is deleted without a local edit", async () => {
  const local = createPage("server body", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  local.title = "Conflict";
  local.updatedAt = "2026-04-17T18:01:00.000Z";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.syncStatus = "synced";
  const supabase = new FakeSupabase([
    {
      id: "page-1",
      user_id: "user-a",
      title: "Conflict",
      content: "server body",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: "2026-04-17T18:04:00.000Z"
    }
  ]);
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.pulledCount, 1);
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.isEphemeral, true);
});
test("syncUserPages rejects concurrent sync passes with the global guard", async () => {
  let releaseSnapshot;
  const snapshotBlocked = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const supabase = {
    from(table) {
      if (table === "pages") {
        return {
          select() {
            return {
              eq() {
                return this;
              },
              order() {
                return this;
              },
              then(resolve) {
                return snapshotBlocked.then(() => resolve({ data: [], error: null }));
              }
            };
          },
          upsert(payload) {
            return {
              select() {
                return {
                  async single() {
                    return { data: payload, error: null };
                  }
                };
              }
            };
          }
        };
      }
      if (table === "user_settings") {
        return {
          async upsert() {
            return { error: null };
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };
  const local = createPage("local body", {
    id: "page-1",
    userId: "user-a",
    now: "2026-04-17T18:00:00.000Z",
    isEphemeral: false
  });
  const firstSync = syncUserPages(supabase, "user-a", buildSession(local));
  assert.equal(isSyncInProgress(), true);
  await assert.rejects(
    () => syncUserPages(supabase, "user-a", buildSession(local)),
    /Sync already in progress\./i
  );
  releaseSnapshot();
  await firstSync;
  assert.equal(isSyncInProgress(), false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3luYy50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuaW1wb3J0IHtcblx0ZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQsXG5cdGZvcmtDb25mbGljdFBhZ2UsXG5cdGlzU3luY0luUHJvZ3Jlc3MsXG5cdHJlY29uY2lsZVN5bmNSZXN1bHQsXG5cdHN5bmNVc2VyUGFnZXNcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy50cyc7XG5pbXBvcnQgdHlwZSB7IFBhZ2VTeW5jU3RhdHVzIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbnR5cGUgUmVtb3RlUGFnZVJvdyA9IHtcblx0aWQ6IHN0cmluZztcblx0dXNlcl9pZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRfYXQ6IHN0cmluZztcblx0dXBkYXRlZF9hdDogc3RyaW5nO1xuXHRkZWxldGVkX2F0OiBzdHJpbmcgfCBudWxsO1xufTtcblxudHlwZSBVc2VyU2V0dGluZ3NSb3cgPSB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59O1xuXG5jbGFzcyBGYWtlU3VwYWJhc2Uge1xuXHRwcml2YXRlIHBhZ2VzID0gbmV3IE1hcDxzdHJpbmcsIFJlbW90ZVBhZ2VSb3c+KCk7XG5cdHByaXZhdGUgdXNlclNldHRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIFVzZXJTZXR0aW5nc1Jvdz4oKTtcblxuXHRjb25zdHJ1Y3Rvcihyb3dzOiBSZW1vdGVQYWdlUm93W10gPSBbXSwgc2V0dGluZ3M6IFVzZXJTZXR0aW5nc1Jvd1tdID0gW10pIHtcblx0XHRmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSB7XG5cdFx0XHR0aGlzLnBhZ2VzLnNldChyb3cuaWQsIHsgLi4ucm93IH0pO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHNldHRpbmcgb2Ygc2V0dGluZ3MpIHtcblx0XHRcdHRoaXMudXNlclNldHRpbmdzLnNldChzZXR0aW5nLnVzZXJfaWQsIHsgLi4uc2V0dGluZyB9KTtcblx0XHR9XG5cdH1cblxuXHRmcm9tKHRhYmxlOiBzdHJpbmcpIHtcblx0XHRpZiAodGFibGUgPT09ICdwYWdlcycpIHtcblx0XHRcdGNvbnN0IGFwaSA9IHRoaXM7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0bGV0IHVzZXJJZCA9ICcnO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRlcShjb2x1bW46IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuXHRcdFx0XHRcdFx0XHRhc3NlcnQuZXF1YWwoY29sdW1uLCAndXNlcl9pZCcpO1xuXHRcdFx0XHRcdFx0XHR1c2VySWQgPSB2YWx1ZTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0b3JkZXIoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHRoZW4ocmVzb2x2ZTogKHZhbHVlOiB1bmtub3duKSA9PiB1bmtub3duKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJvd3MgPSBbLi4uYXBpLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzb2x2ZSh7IGRhdGE6IHJvd3MsIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR1cHNlcnQocGF5bG9hZDogUmVtb3RlUGFnZVJvdykge1xuXHRcdFx0XHRcdGFwaS5wYWdlcy5zZXQocGF5bG9hZC5pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0YXN5bmMgc2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogYXBpLnBhZ2VzLmdldChwYXlsb2FkLmlkKSA/PyBudWxsLCBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdGlmICh0YWJsZSA9PT0gJ3VzZXJfc2V0dGluZ3MnKSB7XG5cdFx0XHRjb25zdCBhcGkgPSB0aGlzO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdGxldCB1c2VySWQgPSAnJztcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0ZXEoY29sdW1uOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdFx0XHRcdFx0YXNzZXJ0LmVxdWFsKGNvbHVtbiwgJ3VzZXJfaWQnKTtcblx0XHRcdFx0XHRcdFx0dXNlcklkID0gdmFsdWU7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdGFzeW5jIG1heWJlU2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4geyBkYXRhOiBhcGkudXNlclNldHRpbmdzLmdldCh1c2VySWQpID8/IG51bGwsIGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fSxcblx0XHRcdFx0YXN5bmMgdXBzZXJ0KHBheWxvYWQ6IFVzZXJTZXR0aW5nc1Jvdykge1xuXHRcdFx0XHRcdGFwaS51c2VyU2V0dGluZ3Muc2V0KHBheWxvYWQudXNlcl9pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7IGVycm9yOiBudWxsIH07XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdH1cblxuXHRnZXRSb3dzKHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIFsuLi50aGlzLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdH1cblxuXHRnZXRBY3RpdmVQYWdlSWQodXNlcklkOiBzdHJpbmcpIHtcblx0XHRyZXR1cm4gdGhpcy51c2VyU2V0dGluZ3MuZ2V0KHVzZXJJZCk/LmFjdGl2ZV9wYWdlX2lkID8/IG51bGw7XG5cdH1cbn1cblxuZnVuY3Rpb24gYnVpbGRTZXNzaW9uKHBhZ2U6IFJldHVyblR5cGU8dHlwZW9mIGNyZWF0ZVBhZ2U+LCBhY3RpdmVQYWdlSWQgPSBwYWdlLmlkKTogRWRpdG9yU2Vzc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWRcblx0fTtcbn1cblxudGVzdCgnZm9ya0NvbmZsaWN0UGFnZSBjcmVhdGVzIGEgdmlzaWJsZSBsb2NhbCBmb3JrIHdpdGggYSBuZXcgaWQgYW5kIHN1ZmZpeCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gY3JlYXRlUGFnZSgnYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0c291cmNlLnRpdGxlID0gJ015IFBhZ2UnO1xuXHRzb3VyY2UuZGVsZXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWic7XG5cblx0Y29uc3QgZm9yayA9IGZvcmtDb25mbGljdFBhZ2Uoc291cmNlLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODoxMDowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5ub3RFcXVhbChmb3JrLmlkLCBzb3VyY2UuaWQpO1xuXHRhc3NlcnQuZXF1YWwoZm9yay51c2VySWQsICd1c2VyLWEnKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuZGVsZXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChmb3JrLmlzRXBoZW1lcmFsLCBmYWxzZSk7XG5cdGFzc2VydC5tYXRjaChmb3JrLnRpdGxlLCAvXk15IFBhZ2UgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG59KTtcblxudGVzdCgnZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQgcmVhZHMgcmVtb3RlIHVzZXIgc2V0dGluZ3Mgb25seSB3aGVuIGFza2VkJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW10sIFt7IHVzZXJfaWQ6ICd1c2VyLWEnLCBhY3RpdmVfcGFnZV9pZDogJ3BhZ2UtMicgfV0pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnKSwgJ3BhZ2UtMicpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWInKSwgbnVsbCk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBpZ25vcmVzIGVwaGVtZXJhbCBwbGFjZWhvbGRlciBwYWdlcycsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCcnLCB7IGlkOiAncGFnZS1lcGhlbWVyYWwnLCB1c2VySWQ6ICd1c2VyLWEnLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKCk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowMjowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlkLCAncGFnZS1lcGhlbWVyYWwnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgcHVzaGVzIGxvY2FsLW9ubHkgcmVhbCBwYWdlcyBhbmQgdHJ1c3RzIHRoZSB3cml0ZSByZXNwb25zZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdsb2NhbCBib2R5Jywge1xuXHRcdGlkOiAnbG9jYWwtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0bG9jYWwudGl0bGUgPSAnTG9jYWwnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpWzBdPy5pZCwgJ2xvY2FsLTEnKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlbW92ZXMgbG9jYWxseSBkZWxldGVkIHBhZ2VzIHdoZW4gdGhlIHJlbW90ZSByb3cgaXMgYWxyZWFkeSBnb25lJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2xvY2FsIGJvZHknLCB7XG5cdFx0aWQ6ICdsb2NhbC0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdMb2NhbCc7XG5cdGxvY2FsLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0ID0gbnVsbDtcblx0bG9jYWwuZGVsZXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDI6MDAuMDAwWic7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBQYWdlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVsbGVkQ291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG5cdGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdsb2NhbC0xJyk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgcHVsbHMgcmVtb3RlLW9ubHkgcGFnZXMgaW50byB0aGUgbG9jYWwgc2Vzc2lvbicsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3JlbW90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblx0Y29uc3QgZW1wdHlMb2NhbDogRWRpdG9yU2Vzc2lvbiA9IHsgcGFnZXM6IFtdLCBhY3RpdmVQYWdlSWQ6ICdtaXNzaW5nJyB9O1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBlbXB0eUxvY2FsLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVsbGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3JlbW90ZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBpZ25vcmVzIHJlbW90ZS1vbmx5IHBhZ2VzIHRoYXQgYXJlIGFscmVhZHkgZGVsZXRlZCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3JlbW90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJ1xuXHRcdH1cblx0XSk7XG5cdGNvbnN0IGVtcHR5TG9jYWw6IEVkaXRvclNlc3Npb24gPSB7IHBhZ2VzOiBbXSwgYWN0aXZlUGFnZUlkOiAnbWlzc2luZycgfTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgZW1wdHlMb2NhbCwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1bGxlZENvdW50LCAwKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaXNFcGhlbWVyYWwsIHRydWUpO1xufSk7XG5cbnRlc3QoJ3JlY29uY2lsZVN5bmNSZXN1bHQgYWR2YW5jZXMgc3luYyBtZXRhZGF0YSB3aXRob3V0IGRpc2NhcmRpbmcgbmV3ZXIgbG9jYWwgZWRpdHMnLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9IGNyZWF0ZVBhZ2UoJ2FscGhhJywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRzb3VyY2UudGl0bGUgPSAnQWxwaGEnO1xuXHRzb3VyY2UudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdHNvdXJjZS5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJztcblx0c291cmNlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonO1xuXHRzb3VyY2UubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0ID0gbnVsbDtcblx0c291cmNlLnN5bmNTdGF0dXMgPSAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IGN1cnJlbnQgPSB7XG5cdFx0Li4uc291cmNlLFxuXHRcdGNvbnRlbnQ6ICdhbHBoYSBiZXRhJyxcblx0XHR0ZXh0OiAnYWxwaGEgYmV0YScsXG5cdFx0dGl0bGU6ICdBbHBoYSBiZXRhJyxcblx0XHR1cGRhdGVkQXQ6ICcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScgYXMgUGFnZVN5bmNTdGF0dXNcblx0fTtcblxuXHRjb25zdCBzeW5jZWQgPSB7XG5cdFx0Li4uc291cmNlLFxuXHRcdGxhc3RTeW5jZWRBdDogJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWicsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJyxcblx0XHRzeW5jU3RhdHVzOiAnc3luY2VkJyBhcyBQYWdlU3luY1N0YXR1c1xuXHR9O1xuXG5cdGNvbnN0IHJlc3VsdCA9IHJlY29uY2lsZVN5bmNSZXN1bHQoYnVpbGRTZXNzaW9uKGN1cnJlbnQpLCBidWlsZFNlc3Npb24oc291cmNlKSwgYnVpbGRTZXNzaW9uKHN5bmNlZCkpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXNbMF0/LmNvbnRlbnQsICdhbHBoYSBiZXRhJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXNbMF0/LnRpdGxlLCAnQWxwaGEgYmV0YScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnBhZ2VzWzBdPy5sYXN0U3luY2VkQXQsICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wYWdlc1swXT8ubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0LCAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdkaXJ0eScpO1xufSk7XG5cbnRlc3QoJ3JlY29uY2lsZVN5bmNSZXN1bHQgYXBwZW5kcyBuZXcgc3luY2VkIHBhZ2VzIHdoaWxlIHByZXNlcnZpbmcgY3VycmVudCBsb2NhbCBwYWdlcycsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gY3JlYXRlUGFnZSgnYWxwaGEnLCB7XG5cdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdHVzZXJJZDogJ3VzZXItYScsXG5cdFx0bm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fSk7XG5cdHNvdXJjZS50aXRsZSA9ICdBbHBoYSc7XG5cdHNvdXJjZS51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblxuXHRjb25zdCBjdXJyZW50ID0ge1xuXHRcdC4uLnNvdXJjZSxcblx0XHRjb250ZW50OiAnYWxwaGEgYmV0YScsXG5cdFx0dGV4dDogJ2FscGhhIGJldGEnLFxuXHRcdHRpdGxlOiAnQWxwaGEgYmV0YScsXG5cdFx0dXBkYXRlZEF0OiAnMjAyNi0wNC0xN1QxODowMjowMC4wMDBaJyxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzXG5cdH07XG5cblx0Y29uc3QgY29uZmxpY3RGb3JrID0gY3JlYXRlUGFnZSgnZm9yayBib2R5Jywge1xuXHRcdGlkOiAncGFnZS1mb3JrJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDM6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRjb25mbGljdEZvcmsudGl0bGUgPSAnRm9yayc7XG5cdGNvbmZsaWN0Rm9yay51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMzowMC4wMDBaJztcblx0Y29uZmxpY3RGb3JrLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonO1xuXHRjb25mbGljdEZvcmsubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDM6MDAuMDAwWic7XG5cdGNvbmZsaWN0Rm9yay5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRjb25mbGljdEZvcmsuc3luY1N0YXR1cyA9ICdzeW5jZWQnIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IHN5bmNlZCA9IHtcblx0XHQuLi5zb3VyY2UsXG5cdFx0bGFzdFN5bmNlZEF0OiAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJyxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonLFxuXHRcdHN5bmNTdGF0dXM6ICdzeW5jZWQnIGFzIFBhZ2VTeW5jU3RhdHVzXG5cdH07XG5cblx0Y29uc3QgcmVzdWx0ID0gcmVjb25jaWxlU3luY1Jlc3VsdChcblx0XHRidWlsZFNlc3Npb24oY3VycmVudCksXG5cdFx0YnVpbGRTZXNzaW9uKHNvdXJjZSksXG5cdFx0eyBwYWdlczogW3N5bmNlZCwgY29uZmxpY3RGb3JrXSwgYWN0aXZlUGFnZUlkOiBjdXJyZW50LmlkIH1cblx0KTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09ICdwYWdlLTEnICYmIHBhZ2UuY29udGVudCA9PT0gJ2FscGhhIGJldGEnKSwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gJ3BhZ2UtZm9yaycgJiYgcGFnZS5jb250ZW50ID09PSAnZm9yayBib2R5JyksIHRydWUpO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgZm9ya3Mgd2hlbiBsb2NhbCBhbmQgcmVtb3RlIGJvdGggY2hhbmdlZCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdsb2NhbCBlZGl0Jywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdTaGFyZWQnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMzowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBQYWdlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW1xuXHRcdHtcblx0XHRcdGlkOiAncGFnZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdTaGFyZWQnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBlZGl0Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1c2hlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdwYWdlLTEnKTtcblx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy50aXRsZSA/PyAnJywgL15TaGFyZWQgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ2xvY2FsIGVkaXQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5zeW5jU3RhdHVzLCAnc3luY2VkJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8ubGFzdFN5bmNlZEF0LCByZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8udXBkYXRlZEF0KTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmlkLCAncGFnZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uY29udGVudCwgJ3JlbW90ZSBlZGl0Jyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLnNvbWUoKHJvdykgPT4gcm93LmNvbnRlbnQgPT09ICdsb2NhbCBlZGl0JyksIHRydWUpO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgaGFuZGxlcyByZW1vdGUgZGVsZXRlIHZlcnN1cyBsb2NhbCBlZGl0IGJ5IGZvcmtpbmcgdGhlIGxvY2FsIGVkaXQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgna2VlcCBtZSBsb2NhbGx5Jywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdDb25mbGljdCc7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCA9IG51bGw7XG5cdGxvY2FsLnN5bmNTdGF0dXMgPSAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdFx0dXNlcl9pZDogJ3VzZXItYScsXG5cdFx0XHR0aXRsZTogJ0NvbmZsaWN0Jyxcblx0XHRcdGNvbnRlbnQ6ICdzZXJ2ZXIgY29weScsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWidcblx0XHR9XG5cdF0pO1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3BhZ2UtMScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmRlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ2tlZXAgbWUgbG9jYWxseScpO1xuXHRhc3NlcnQubWF0Y2gocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnRpdGxlID8/ICcnLCAvXkNvbmZsaWN0IFxcKExvY2FsIGNvbmZsaWN0IC8pO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLnNvbWUoKHJvdykgPT4gcm93LmlkID09PSAncGFnZS0xJyAmJiByb3cuZGVsZXRlZF9hdCAhPT0gbnVsbCksIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykuc29tZSgocm93KSA9PiByb3cuY29udGVudCA9PT0gJ2tlZXAgbWUgbG9jYWxseScgJiYgcm93LmRlbGV0ZWRfYXQgPT09IG51bGwpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlbW92ZXMgbG9jYWwgcGFnZXMgd2hlbiB0aGUgcmVtb3RlIHZlcnNpb24gaXMgZGVsZXRlZCB3aXRob3V0IGEgbG9jYWwgZWRpdCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdzZXJ2ZXIgYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0bG9jYWwudGl0bGUgPSAnQ29uZmxpY3QnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ3N5bmNlZCcgYXMgUGFnZVN5bmNTdGF0dXM7XG5cblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnQ29uZmxpY3QnLFxuXHRcdFx0Y29udGVudDogJ3NlcnZlciBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJ1xuXHRcdH1cblx0XSk7XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjA1OjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdWxsZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlamVjdHMgY29uY3VycmVudCBzeW5jIHBhc3NlcyB3aXRoIHRoZSBnbG9iYWwgZ3VhcmQnLCBhc3luYyAoKSA9PiB7XG5cdGxldCByZWxlYXNlU25hcHNob3QhOiAoKSA9PiB2b2lkO1xuXHRjb25zdCBzbmFwc2hvdEJsb2NrZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdHJlbGVhc2VTbmFwc2hvdCA9IHJlc29sdmU7XG5cdH0pO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0ge1xuXHRcdGZyb20odGFibGU6IHN0cmluZykge1xuXHRcdFx0aWYgKHRhYmxlID09PSAncGFnZXMnKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0ZXEoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdG9yZGVyKCkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR0aGVuKHJlc29sdmU6ICh2YWx1ZTogdW5rbm93bikgPT4gdW5rbm93bikge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiBzbmFwc2hvdEJsb2NrZWQudGhlbigoKSA9PiByZXNvbHZlKHsgZGF0YTogW10sIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHVwc2VydChwYXlsb2FkOiBSZW1vdGVQYWdlUm93KSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRcdGFzeW5jIHNpbmdsZSgpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogcGF5bG9hZCwgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHRhYmxlID09PSAndXNlcl9zZXR0aW5ncycpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRhc3luYyB1cHNlcnQoKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdFx0fVxuXHR9O1xuXG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0Y29uc3QgZmlyc3RTeW5jID0gc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCkpO1xuXHRhc3NlcnQuZXF1YWwoaXNTeW5jSW5Qcm9ncmVzcygpLCB0cnVlKTtcblxuXHRhd2FpdCBhc3NlcnQucmVqZWN0cyhcblx0XHQoKSA9PiBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSksXG5cdFx0L1N5bmMgYWxyZWFkeSBpbiBwcm9ncmVzc1xcLi9pXG5cdCk7XG5cblx0cmVsZWFzZVNuYXBzaG90KCk7XG5cdGF3YWl0IGZpcnN0U3luYztcblx0YXNzZXJ0LmVxdWFsKGlzU3luY0luUHJvZ3Jlc3MoKSwgZmFsc2UpO1xufSk7XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcbmV4cG9ydCBjb25zdCBVUERBVEVEX0FUX0lOREVYID0gJ3VwZGF0ZWRBdCc7XG5cbmV4cG9ydCBjb25zdCBBTk9OWU1PVVNfVVNFUklEID0gJ2Fub255bW91cyc7XG5cbmV4cG9ydCB0eXBlIFBhZ2VTeW5jU3RhdHVzID0gJ3N5bmNlZCcgfCAnZGlydHknIHwgJ3BlbmRpbmdfcHVzaCcgfCAnY29uZmxpY3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VSZWNvcmQge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRzZWxlY3Rpb25TdGFydDogbnVtYmVyO1xuXHRzZWxlY3Rpb25FbmQ6IG51bWJlcjtcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdHN5bmNTdGF0dXM6IFBhZ2VTeW5jU3RhdHVzO1xuXHRpc0VwaGVtZXJhbDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nUmVjb3JkIHtcblx0a2V5OiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nIHwgbnVsbDtcblx0dmFsdWU6IHVua25vd247XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgU0VUVElOR19BQ1RJVkVfUEFHRV9JRCA9ICdhY3RpdmVQYWdlSWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfVEhFTUUgPSAndGhlbWUnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfV09SRF9DT1VOVF9WSVNJQklMSVRZID0gJ3dvcmRDb3VudFZpc2liaWxpdHknO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfU1BFTExDSEVDS19FTkFCTEVEID0gJ3NwZWxsY2hlY2tFbmFibGVkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX0hBU19QUk9NUFRFRF9GT1JfQU5PTllNT1VTX0lNUE9SVCA9ICdoYXNQcm9tcHRlZEZvckFub255bW91c0ltcG9ydCc7XG4iLCAiaW1wb3J0IHR5cGUgeyBFZGl0b3JTdGF0ZSB9IGZyb20gJy4uL2Jhc2ljL2hpc3RvcnknO1xuaW1wb3J0IHtcblx0QU5PTllNT1VTX1VTRVJJRCxcblx0dHlwZSBQYWdlUmVjb3JkLFxuXHR0eXBlIFBhZ2VTeW5jU3RhdHVzXG59IGZyb20gJy4uL3BlcnNpc3RlbmNlL3JlY29yZHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclBhZ2UgZXh0ZW5kcyBFZGl0b3JTdGF0ZSwgUGFnZVJlY29yZCB7fVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuXHRwYWdlczogRWRpdG9yUGFnZVtdO1xuXHRhY3RpdmVQYWdlSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFVOVElUTEVEX1BBR0UgPSAnVW50aXRsZWQnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGZpcnN0TGluZSA9IGNvbnRlbnRcblx0XHQuc3BsaXQoJ1xcbicpXG5cdFx0Lm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG5cdFx0LmZpbmQoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCk7XG5cblx0aWYgKCFmaXJzdExpbmUpIHtcblx0XHRyZXR1cm4gVU5USVRMRURfUEFHRTtcblx0fVxuXG5cdHJldHVybiBmaXJzdExpbmUucmVwbGFjZSgvXFxzKy9nLCAnICcpLnNsaWNlKDAsIDQ4KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2UoXG5cdGNvbnRlbnQgPSAnJyxcblx0b3B0aW9uczoge1xuXHRcdGlkPzogc3RyaW5nO1xuXHRcdHVzZXJJZD86IHN0cmluZztcblx0XHRub3c/OiBzdHJpbmc7XG5cdFx0aXNFcGhlbWVyYWw/OiBib29sZWFuO1xuXHR9ID0ge31cbik6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0aW1lc3RhbXAgPSBvcHRpb25zLm5vdyA/PyBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdHJldHVybiB7XG5cdFx0aWQ6IG9wdGlvbnMuaWQgPz8gY3JlYXRlUGFnZUlkKCksXG5cdFx0dXNlcklkOiBvcHRpb25zLnVzZXJJZCA/PyBBTk9OWU1PVVNfVVNFUklELFxuXHRcdHRpdGxlOiBkZXJpdmVQYWdlVGl0bGUoY29udGVudCksXG5cdFx0Y29udGVudCxcblx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdHNlbGVjdGlvbkVuZDogMCxcblx0XHRjcmVhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHR1cGRhdGVkQXQ6IHRpbWVzdGFtcCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IG51bGwsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogb3B0aW9ucy5pc0VwaGVtZXJhbCA/PyB0cnVlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2UoJycsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gc29ydFBhZ2VzQnlSZWNlbmN5KHNlc3Npb24ucGFnZXMpO1xuXHRpZiAocGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRwYWdlc1xuXHRcdH07XG5cdH1cblxuXHRjb25zdCBmaXJzdFZpc2libGVQYWdlID0gcGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpO1xuXHRpZiAoZmlyc3RWaXNpYmxlUGFnZSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0cGFnZXMsXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IGZpcnN0VmlzaWJsZVBhZ2UuaWRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdHBhZ2VzLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZXNbMF0hLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNWaXNpYmxlRXBoZW1lcmFsQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRyZXR1cm4gISFhY3RpdmVQYWdlICYmIGFjdGl2ZVBhZ2UuZGVsZXRlZEF0ID09PSBudWxsICYmIGFjdGl2ZVBhZ2UuaXNFcGhlbWVyYWw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVFbGlnaWJsZUFjdGl2ZVBhZ2VJZChzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRpZiAoIWFjdGl2ZVBhZ2UgfHwgYWN0aXZlUGFnZS5kZWxldGVkQXQgIT09IG51bGwgfHwgYWN0aXZlUGFnZS5pc0VwaGVtZXJhbCkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIGFjdGl2ZVBhZ2UuaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZW1vdGVBY3RpdmVQYWdlVXBkYXRlVGFyZ2V0KFxuXHRwcmV2aW91c1Nlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdG5leHRTZXNzaW9uOiBFZGl0b3JTZXNzaW9uXG4pOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgbmV4dEFjdGl2ZVBhZ2VJZCA9IGdldFJlbW90ZUVsaWdpYmxlQWN0aXZlUGFnZUlkKG5leHRTZXNzaW9uKTtcblx0aWYgKG5leHRBY3RpdmVQYWdlSWQgJiYgbmV4dEFjdGl2ZVBhZ2VJZCAhPT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkge1xuXHRcdHJldHVybiBuZXh0QWN0aXZlUGFnZUlkO1xuXHR9XG5cblx0Y29uc3QgcHJldmlvdXNBY3RpdmVCZWZvcmUgPSBwcmV2aW91c1Nlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0Y29uc3QgcHJldmlvdXNBY3RpdmVBZnRlciA9IG5leHRTZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHByZXZpb3VzU2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGlmIChcblx0XHRwcmV2aW91c0FjdGl2ZUJlZm9yZSAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmRlbGV0ZWRBdCA9PT0gbnVsbCAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlLmlzRXBoZW1lcmFsICYmXG5cdFx0cHJldmlvdXNBY3RpdmVBZnRlciAmJlxuXHRcdHByZXZpb3VzQWN0aXZlQWZ0ZXIuZGVsZXRlZEF0ID09PSBudWxsICYmXG5cdFx0IXByZXZpb3VzQWN0aXZlQWZ0ZXIuaXNFcGhlbWVyYWxcblx0KSB7XG5cdFx0cmV0dXJuIHByZXZpb3VzQWN0aXZlQWZ0ZXIuaWQ7XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VTdGF0ZShwYWdlOiBFZGl0b3JQYWdlLCBzdGF0ZTogRWRpdG9yU3RhdGUpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY29udGVudENoYW5nZWQgPSBzdGF0ZS50ZXh0ICE9PSBwYWdlLmNvbnRlbnQ7XG5cdGNvbnN0IHNlbGVjdGlvbkNoYW5nZWQgPVxuXHRcdHN0YXRlLnNlbGVjdGlvblN0YXJ0ICE9PSBwYWdlLnNlbGVjdGlvblN0YXJ0IHx8IHN0YXRlLnNlbGVjdGlvbkVuZCAhPT0gcGFnZS5zZWxlY3Rpb25FbmQ7XG5cdGlmICghY29udGVudENoYW5nZWQgJiYgIXNlbGVjdGlvbkNoYW5nZWQpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdGNvbnN0IG5leHRQYWdlOiBFZGl0b3JQYWdlID0ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0Li4uc3RhdGUsXG5cdFx0Y29udGVudDogc3RhdGUudGV4dFxuXHR9O1xuXG5cdGlmICghY29udGVudENoYW5nZWQpIHtcblx0XHRyZXR1cm4gbmV4dFBhZ2U7XG5cdH1cblxuXHRjb25zdCBwcmV2aW91c0Rlcml2ZWRUaXRsZSA9IGRlcml2ZVBhZ2VUaXRsZShwYWdlLmNvbnRlbnQpO1xuXHRjb25zdCBuZXh0RGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHN0YXRlLnRleHQpO1xuXHRjb25zdCBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPSBwYWdlLnRpdGxlID09PSBwcmV2aW91c0Rlcml2ZWRUaXRsZTtcblxuXHRyZXR1cm4ge1xuXHRcdC4uLm5leHRQYWdlLFxuXHRcdHRpdGxlOiBzaG91bGRBdXRvRGVyaXZlVGl0bGUgPyBuZXh0RGVyaXZlZFRpdGxlIDogcGFnZS50aXRsZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhZ2VUaXRsZShwYWdlOiBFZGl0b3JQYWdlLCB0aXRsZTogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0ZXJpYWxpemVQYWdlKHBhZ2U6IEVkaXRvclBhZ2UpOiBFZGl0b3JQYWdlIHtcblx0aWYgKCFwYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0cmV0dXJuIHBhZ2U7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IGZhbHNlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdC4uLmNsb25lZCxcblx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdGRlbGV0ZWRBdDogcGFnZS5kZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHQuc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xuXG5cdGlmIChwYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbih1c2VySWQpO1xuXHR9XG5cblx0Y29uc3QgYWN0aXZlUGFnZUlkID1cblx0XHR0eXBlb2YgdmFsdWUuYWN0aXZlUGFnZUlkID09PSAnc3RyaW5nJyAmJlxuXHRcdHBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHZhbHVlLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbClcblx0XHRcdD8gdmFsdWUuYWN0aXZlUGFnZUlkXG5cdFx0XHQ6IChwYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk/LmlkID8/IHBhZ2VzWzBdLmlkKTtcblxuXHRyZXR1cm4gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHsgcGFnZXMsIGFjdGl2ZVBhZ2VJZCB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1pZ3JhdGVMZWdhY3lTdGF0ZShzdGF0ZTogRWRpdG9yU3RhdGUsIHVzZXJJZCA9IEFOT05ZTU9VU19VU0VSSUQpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IHVwZGF0ZVBhZ2VTdGF0ZShjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2UgfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jb250ZW50ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5jb250ZW50XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLnRleHRcblx0XHRcdFx0OiAnJztcblx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xuXHRjb25zdCBzZWxlY3Rpb25TdGFydCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25TdGFydCA6IDAsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IHNlbGVjdGlvbkVuZCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uRW5kIDogc2VsZWN0aW9uU3RhcnQsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUuY3JlYXRlZEF0LCB2YWx1ZS5jcmVhdGVkX2F0KTtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS51cGRhdGVkQXQsIHZhbHVlLnVwZGF0ZWRfYXQpID8/IGNyZWF0ZWRBdDtcblx0Y29uc3QgZGVsZXRlZEF0ID0gcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmRlbGV0ZWRBdCwgdmFsdWUuZGVsZXRlZF9hdCk7XG5cblx0cmV0dXJuIHtcblx0XHRpZDogdHlwZW9mIHZhbHVlLmlkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5pZC5sZW5ndGggPiAwID8gdmFsdWUuaWQgOiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleCksXG5cdFx0dXNlcklkOiB0eXBlb2YgdmFsdWUudXNlcklkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51c2VySWQubGVuZ3RoID4gMCA/IHZhbHVlLnVzZXJJZCA6IHVzZXJJZCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0U3luY2VkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0KSxcblx0XHRzeW5jU3RhdHVzOiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiB0eXBlb2YgdmFsdWUuaXNFcGhlbWVyYWwgPT09ICdib29sZWFuJyA/IHZhbHVlLmlzRXBoZW1lcmFsIDogZmFsc2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gaXNMZWdhY3lFZGl0b3JTdGF0ZSh2YWx1ZTogb2JqZWN0KTogdmFsdWUgaXMgRWRpdG9yU3RhdGUge1xuXHRyZXR1cm4gJ3RleHQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25TdGFydCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvbkVuZCcgaW4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRyZXR1cm4gISF2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnO1xufVxuXG5mdW5jdGlvbiBjbGFtcFNlbGVjdGlvbih2YWx1ZTogbnVtYmVyLCBtYXg6IG51bWJlcikge1xuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4odmFsdWUsIG1heCkpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQYWdlSWQoKSB7XG5cdGlmICh0eXBlb2YgY3J5cHRvICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgY3J5cHRvLnJhbmRvbVVVSUQgPT09ICdmdW5jdGlvbicpIHtcblx0XHRyZXR1cm4gY3J5cHRvLnJhbmRvbVVVSUQoKTtcblx0fVxuXG5cdHJldHVybiBgcGFnZS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDEwKX0tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleDogbnVtYmVyKSB7XG5cdHJldHVybiBgcGFnZS0ke2luZGV4ICsgMX1gO1xufVxuXG5mdW5jdGlvbiByZWFkVGltZXN0YW1wKC4uLnZhbHVlczogdW5rbm93bltdKSB7XG5cdGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCkge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIHJlYWROdWxsYWJsZVRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWU6IHVua25vd24pOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiB2YWx1ZSA9PT0gJ3N5bmNlZCcgfHwgdmFsdWUgPT09ICdwZW5kaW5nX3B1c2gnIHx8IHZhbHVlID09PSAnY29uZmxpY3QnID8gdmFsdWUgOiAnZGlydHknO1xufVxuXG5mdW5jdGlvbiBuZXh0RGlydHlTdGF0dXMoc3RhdHVzOiBQYWdlU3luY1N0YXR1cyk6IFBhZ2VTeW5jU3RhdHVzIHtcblx0cmV0dXJuIHN0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc29ydFBhZ2VzQnlSZWNlbmN5KHBhZ2VzOiBFZGl0b3JQYWdlW10pIHtcblx0cmV0dXJuIFsuLi5wYWdlc10uc29ydChjb21wYXJlUGFnZXNCeVJlY2VuY3kpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVBhZ2VzQnlSZWNlbmN5KGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LnVwZGF0ZWRBdCAhPT0gcmlnaHQudXBkYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LnVwZGF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQudXBkYXRlZEF0KTtcblx0fVxuXG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIHJpZ2h0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKGxlZnQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU3VwYWJhc2VDbGllbnQgfSBmcm9tICdAc3VwYWJhc2Uvc3VwYWJhc2UtanMnO1xuaW1wb3J0IHtcblx0Y3JlYXRlUGFnZSxcblx0ZW5zdXJlVmFsaWRBY3RpdmVQYWdlLFxuXHR0eXBlIEVkaXRvclBhZ2UsXG5cdHR5cGUgRWRpdG9yU2Vzc2lvblxufSBmcm9tICcuL2NvcmUvc2Vzc2lvbic7XG5cbmNvbnN0IFJFTU9URV9QQUdFX0NPTFVNTlMgPSAnaWQsdXNlcl9pZCx0aXRsZSxjb250ZW50LGNyZWF0ZWRfYXQsdXBkYXRlZF9hdCxkZWxldGVkX2F0JztcblxuaW50ZXJmYWNlIFJlbW90ZVBhZ2VSb3cge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VyX2lkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZF9hdDogc3RyaW5nO1xuXHR1cGRhdGVkX2F0OiBzdHJpbmc7XG5cdGRlbGV0ZWRfYXQ6IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBSZW1vdGVVc2VyU2V0dGluZ3NSb3cge1xuXHR1c2VyX2lkOiBzdHJpbmc7XG5cdGFjdGl2ZV9wYWdlX2lkOiBzdHJpbmcgfCBudWxsO1xuXHRjcmVhdGVkX2F0Pzogc3RyaW5nO1xuXHR1cGRhdGVkX2F0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNSdW5SZXN1bHQge1xuXHRzZXNzaW9uOiBFZGl0b3JTZXNzaW9uO1xuXHRwdXNoZWRDb3VudDogbnVtYmVyO1xuXHRwdWxsZWRDb3VudDogbnVtYmVyO1xuXHRjb25mbGljdENvdW50OiBudW1iZXI7XG59XG5cbmxldCBzeW5jSW5Qcm9ncmVzcyA9IGZhbHNlO1xuXG5leHBvcnQgZnVuY3Rpb24gaXNTeW5jSW5Qcm9ncmVzcygpIHtcblx0cmV0dXJuIHN5bmNJblByb2dyZXNzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVjb25jaWxlU3luY1Jlc3VsdChcblx0Y3VycmVudFNlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdHN5bmNTb3VyY2VTZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRzeW5jZWRTZXNzaW9uOiBFZGl0b3JTZXNzaW9uXG4pOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3Qgc291cmNlQnlJZCA9IG5ldyBNYXAoc3luY1NvdXJjZVNlc3Npb24ucGFnZXMubWFwKChwYWdlKSA9PiBbcGFnZS5pZCwgcGFnZV0pKTtcblx0Y29uc3Qgc3luY2VkQnlJZCA9IG5ldyBNYXAoc3luY2VkU2Vzc2lvbi5wYWdlcy5tYXAoKHBhZ2UpID0+IFtwYWdlLmlkLCBwYWdlXSkpO1xuXHRjb25zdCBtZXJnZWRQYWdlczogRWRpdG9yUGFnZVtdID0gW107XG5cdGNvbnN0IHNlZW5QYWdlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cblx0Zm9yIChjb25zdCBjdXJyZW50UGFnZSBvZiBjdXJyZW50U2Vzc2lvbi5wYWdlcykge1xuXHRcdGNvbnN0IHNvdXJjZVBhZ2UgPSBzb3VyY2VCeUlkLmdldChjdXJyZW50UGFnZS5pZCkgPz8gbnVsbDtcblx0XHRjb25zdCBzeW5jZWRQYWdlID0gc3luY2VkQnlJZC5nZXQoY3VycmVudFBhZ2UuaWQpID8/IG51bGw7XG5cblx0XHRpZiAoIXNvdXJjZVBhZ2UgfHwgIXN5bmNlZFBhZ2UpIHtcblx0XHRcdG1lcmdlZFBhZ2VzLnB1c2goY3VycmVudFBhZ2UpO1xuXHRcdFx0c2VlblBhZ2VJZHMuYWRkKGN1cnJlbnRQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmICghaGFzUGFnZUNoYW5nZWRTaW5jZVNvdXJjZShjdXJyZW50UGFnZSwgc291cmNlUGFnZSkpIHtcblx0XHRcdG1lcmdlZFBhZ2VzLnB1c2gocHJlc2VydmVMb2NhbFNlbGVjdGlvbihzeW5jZWRQYWdlLCBjdXJyZW50UGFnZSkpO1xuXHRcdFx0c2VlblBhZ2VJZHMuYWRkKGN1cnJlbnRQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwYWdlU3RhdGVzTWF0Y2goc291cmNlUGFnZSwgdG9SZW1vdGVTaGFwZShzeW5jZWRQYWdlKSkpIHtcblx0XHRcdG1lcmdlZFBhZ2VzLnB1c2gobWVyZ2VTeW5jZWRCYXNlbGluZUludG9DdXJyZW50UGFnZShjdXJyZW50UGFnZSwgc3luY2VkUGFnZSkpO1xuXHRcdFx0c2VlblBhZ2VJZHMuYWRkKGN1cnJlbnRQYWdlLmlkKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdG1lcmdlZFBhZ2VzLnB1c2goY3VycmVudFBhZ2UpO1xuXHRcdHNlZW5QYWdlSWRzLmFkZChjdXJyZW50UGFnZS5pZCk7XG5cdH1cblxuXHRmb3IgKGNvbnN0IHN5bmNlZFBhZ2Ugb2Ygc3luY2VkU2Vzc2lvbi5wYWdlcykge1xuXHRcdGlmIChzZWVuUGFnZUlkcy5oYXMoc3luY2VkUGFnZS5pZCkpIHtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdG1lcmdlZFBhZ2VzLnB1c2goc3luY2VkUGFnZSk7XG5cdH1cblxuXHRyZXR1cm4gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHtcblx0XHRwYWdlczogc29ydFBhZ2VzKG1lcmdlZFBhZ2VzKSxcblx0XHRhY3RpdmVQYWdlSWQ6IGN1cnJlbnRTZXNzaW9uLmFjdGl2ZVBhZ2VJZFxuXHR9KTtcbn1cblxuLy8gT25lIG1hbnVhbCBzeW5jIHBhc3Mgd29ya3MgYWdhaW5zdCBvbmUgcmVtb3RlIHNuYXBzaG90LlxuLy8gV2UgcHVsbCBvbmNlLCBkZWNpZGUgZXZlcnl0aGluZyBhZ2FpbnN0IHRoYXQgc25hcHNob3QsIHRydXN0IHdyaXRlIHJlc3BvbnNlcyxcbi8vIGFuZCBvbmx5IHRoZW4gYnVpbGQgdGhlIG5leHQgbG9jYWwgc2Vzc2lvbi5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzeW5jVXNlclBhZ2VzKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nLFxuXHRsb2NhbFNlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdG5vdyA9IG5ldyBEYXRlKClcbik6IFByb21pc2U8U3luY1J1blJlc3VsdD4ge1xuXHRpZiAoc3luY0luUHJvZ3Jlc3MpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgYWxyZWFkeSBpbiBwcm9ncmVzcy4nKTtcblx0fVxuXG5cdHN5bmNJblByb2dyZXNzID0gdHJ1ZTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IHJlbW90ZVNuYXBzaG90ID0gYXdhaXQgcHVsbFJlbW90ZVNuYXBzaG90KHN1cGFiYXNlLCB1c2VySWQpO1xuXHRcdGNvbnN0IHJlbW90ZUJ5SWQgPSBuZXcgTWFwKHJlbW90ZVNuYXBzaG90Lm1hcCgocGFnZSkgPT4gW3BhZ2UuaWQsIHBhZ2VdKSk7XG5cdFx0Y29uc3QgcHJvY2Vzc2VkUmVtb3RlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0Y29uc3QgbmV4dFBhZ2VzOiBFZGl0b3JQYWdlW10gPSBbXTtcblx0XHRsZXQgcHVzaGVkQ291bnQgPSAwO1xuXHRcdGxldCBwdWxsZWRDb3VudCA9IDA7XG5cdFx0bGV0IGNvbmZsaWN0Q291bnQgPSAwO1xuXHRcdGxldCBuZXh0QWN0aXZlUGFnZUlkID0gbG9jYWxTZXNzaW9uLmFjdGl2ZVBhZ2VJZDtcblxuXHRcdGZvciAoY29uc3QgbG9jYWxQYWdlIG9mIHNvcnRQYWdlcyhsb2NhbFNlc3Npb24ucGFnZXMuZmlsdGVyKChwYWdlKSA9PiBwYWdlLnVzZXJJZCA9PT0gdXNlcklkKSkpIHtcblx0XHRcdGlmIChsb2NhbFBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRcdFx0bmV4dFBhZ2VzLnB1c2gobG9jYWxQYWdlKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJlbW90ZSA9IHJlbW90ZUJ5SWQuZ2V0KGxvY2FsUGFnZS5pZCkgPz8gbnVsbDtcblx0XHRcdGlmICghcmVtb3RlKSB7XG5cdFx0XHRcdGlmIChsb2NhbFBhZ2UuZGVsZXRlZEF0ICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGxvY2FsUGFnZSk7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZCwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdHB1c2hlZENvdW50ICs9IDE7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRwcm9jZXNzZWRSZW1vdGVJZHMuYWRkKHJlbW90ZS5pZCk7XG5cdFx0XHRjb25zdCBsb2NhbENoYW5nZWQgPSBoYXNMb2NhbENoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlKTtcblx0XHRcdGNvbnN0IHJlbW90ZUNoYW5nZWQgPSBoYXNSZW1vdGVDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZSwgcmVtb3RlKTtcblx0XHRcdGNvbnN0IHNhbWVTdGF0ZSA9IHBhZ2VTdGF0ZXNNYXRjaChsb2NhbFBhZ2UsIHJlbW90ZSk7XG5cblx0XHRcdGlmICghbG9jYWxDaGFuZ2VkICYmICFyZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRcdGlmIChzaG91bGRLZWVwUmVtb3RlUGFnZUxvY2FsbHkocmVtb3RlKSkge1xuXHRcdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzYW1lU3RhdGUpIHtcblx0XHRcdFx0aWYgKHNob3VsZEtlZXBSZW1vdGVQYWdlTG9jYWxseShyZW1vdGUpKSB7XG5cdFx0XHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKGxvY2FsQ2hhbmdlZCAmJiAhcmVtb3RlQ2hhbmdlZCkge1xuXHRcdFx0XHRjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGxvY2FsUGFnZSk7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZCwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdHB1c2hlZENvdW50ICs9IDE7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIWxvY2FsQ2hhbmdlZCAmJiByZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRcdGlmIChzaG91bGRLZWVwUmVtb3RlUGFnZUxvY2FsbHkocmVtb3RlKSkge1xuXHRcdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cHVsbGVkQ291bnQgKz0gMTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJlbW90ZVBhZ2UgPSB0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIGxvY2FsUGFnZSk7XG5cdFx0XHRjb25mbGljdENvdW50ICs9IDE7XG5cdFx0XHRpZiAoc2hvdWxkS2VlcFJlbW90ZVBhZ2VMb2NhbGx5KHJlbW90ZSkpIHtcblx0XHRcdFx0bmV4dFBhZ2VzLnB1c2gocmVtb3RlUGFnZSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGNvbmZsaWN0Rm9yayA9IGZvcmtDb25mbGljdFBhZ2UobG9jYWxQYWdlLCBub3cpO1xuXHRcdFx0Y29uc3QgcHVzaGVkRm9yayA9IGF3YWl0IHB1c2hMb2NhbFBhZ2Uoc3VwYWJhc2UsIHVzZXJJZCwgY29uZmxpY3RGb3JrKTtcblx0XHRcdGNvbnN0IHN5bmNlZEZvcmsgPSB0b1N5bmNlZExvY2FsUGFnZShwdXNoZWRGb3JrLCBjb25mbGljdEZvcmspO1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2goc3luY2VkRm9yayk7XG5cdFx0XHRwdXNoZWRDb3VudCArPSAxO1xuXG5cdFx0XHRpZiAobG9jYWxTZXNzaW9uLmFjdGl2ZVBhZ2VJZCA9PT0gbG9jYWxQYWdlLmlkICYmIHJlbW90ZVBhZ2UuZGVsZXRlZEF0ICE9PSBudWxsKSB7XG5cdFx0XHRcdG5leHRBY3RpdmVQYWdlSWQgPSBzeW5jZWRGb3JrLmlkO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGZvciAoY29uc3QgcmVtb3RlIG9mIHJlbW90ZVNuYXBzaG90KSB7XG5cdFx0XHRpZiAocHJvY2Vzc2VkUmVtb3RlSWRzLmhhcyhyZW1vdGUuaWQpKSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIXNob3VsZEtlZXBSZW1vdGVQYWdlTG9jYWxseShyZW1vdGUpKSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIG51bGwpKTtcblx0XHRcdHB1bGxlZENvdW50ICs9IDE7XG5cdFx0fVxuXG5cdFx0Y29uc3QgbmV4dFNlc3Npb24gPSBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoe1xuXHRcdFx0cGFnZXM6IHNvcnRQYWdlcyhuZXh0UGFnZXMpLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBuZXh0QWN0aXZlUGFnZUlkXG5cdFx0fSk7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHNlc3Npb246IG5leHRTZXNzaW9uLFxuXHRcdFx0cHVzaGVkQ291bnQsXG5cdFx0XHRwdWxsZWRDb3VudCxcblx0XHRcdGNvbmZsaWN0Q291bnRcblx0XHR9O1xuXHR9IGZpbmFsbHkge1xuXHRcdHN5bmNJblByb2dyZXNzID0gZmFsc2U7XG5cdH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUmVtb3RlQWN0aXZlUGFnZUlkKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcblx0Y29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2Vcblx0XHQuZnJvbSgndXNlcl9zZXR0aW5ncycpXG5cdFx0LnNlbGVjdCgnYWN0aXZlX3BhZ2VfaWQsdXNlcl9pZCxjcmVhdGVkX2F0LHVwZGF0ZWRfYXQnKVxuXHRcdC5lcSgndXNlcl9pZCcsIHVzZXJJZClcblx0XHQubWF5YmVTaW5nbGUoKTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxuXG5cdHJldHVybiAoKGRhdGEgYXMgUmVtb3RlVXNlclNldHRpbmdzUm93IHwgbnVsbCk/LmFjdGl2ZV9wYWdlX2lkID8/IG51bGwpIGFzIHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JrQ29uZmxpY3RQYWdlKHBhZ2U6IEVkaXRvclBhZ2UsIG5vdyA9IG5ldyBEYXRlKCkpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gbm93LnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IGZvcmsgPSBjcmVhdGVQYWdlKHBhZ2UuY29udGVudCwgeyB1c2VySWQ6IHBhZ2UudXNlcklkLCBub3c6IHRpbWVzdGFtcCwgaXNFcGhlbWVyYWw6IGZhbHNlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdC4uLmZvcmssXG5cdFx0dGl0bGU6IGAke3BhZ2UudGl0bGV9ICR7YnVpbGRDb25mbGljdFN1ZmZpeChub3cpfWAudHJpbSgpLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHR0ZXh0OiBwYWdlLmNvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IHBhZ2Uuc2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kOiBwYWdlLnNlbGVjdGlvbkVuZCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0c3luY1N0YXR1czogJ2RpcnR5Jyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVsbFJlbW90ZVNuYXBzaG90KHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCwgdXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPFJlbW90ZVBhZ2VSb3dbXT4ge1xuXHRjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZVxuXHRcdC5mcm9tKCdwYWdlcycpXG5cdFx0LnNlbGVjdChSRU1PVEVfUEFHRV9DT0xVTU5TKVxuXHRcdC5lcSgndXNlcl9pZCcsIHVzZXJJZClcblx0XHQub3JkZXIoJ2NyZWF0ZWRfYXQnLCB7IGFzY2VuZGluZzogdHJ1ZSB9KVxuXHRcdC5vcmRlcignaWQnLCB7IGFzY2VuZGluZzogdHJ1ZSB9KTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxuXG5cdHJldHVybiAoZGF0YSA/PyBbXSkgYXMgUmVtb3RlUGFnZVJvd1tdO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwdXNoTG9jYWxQYWdlKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nLFxuXHRsb2NhbFBhZ2U6IEVkaXRvclBhZ2Vcbik6IFByb21pc2U8UmVtb3RlUGFnZVJvdz4ge1xuXHRjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZVxuXHRcdC5mcm9tKCdwYWdlcycpXG5cdFx0LnVwc2VydChcblx0XHRcdHtcblx0XHRcdFx0aWQ6IGxvY2FsUGFnZS5pZCxcblx0XHRcdFx0dXNlcl9pZDogdXNlcklkLFxuXHRcdFx0XHR0aXRsZTogbG9jYWxQYWdlLnRpdGxlLFxuXHRcdFx0XHRjb250ZW50OiBsb2NhbFBhZ2UuY29udGVudCxcblx0XHRcdFx0Y3JlYXRlZF9hdDogbG9jYWxQYWdlLmNyZWF0ZWRBdCxcblx0XHRcdFx0dXBkYXRlZF9hdDogbG9jYWxQYWdlLnVwZGF0ZWRBdCxcblx0XHRcdFx0ZGVsZXRlZF9hdDogbG9jYWxQYWdlLmRlbGV0ZWRBdFxuXHRcdFx0fSxcblx0XHRcdHsgb25Db25mbGljdDogJ2lkJyB9XG5cdFx0KVxuXHRcdC5zZWxlY3QoUkVNT1RFX1BBR0VfQ09MVU1OUylcblx0XHQuc2luZ2xlKCk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gZGF0YSBhcyBSZW1vdGVQYWdlUm93O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHVzaFJlbW90ZUFjdGl2ZVBhZ2VJZChzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsIHVzZXJJZDogc3RyaW5nLCBhY3RpdmVQYWdlSWQ6IHN0cmluZykge1xuXHRjb25zdCB7IGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZS5mcm9tKCd1c2VyX3NldHRpbmdzJykudXBzZXJ0KHtcblx0XHR1c2VyX2lkOiB1c2VySWQsXG5cdFx0YWN0aXZlX3BhZ2VfaWQ6IGFjdGl2ZVBhZ2VJZFxuXHR9KTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxufVxuXG5mdW5jdGlvbiB0b1N5bmNlZExvY2FsUGFnZShyZW1vdGU6IFJlbW90ZVBhZ2VSb3csIGxvY2FsUGFnZTogRWRpdG9yUGFnZSB8IG51bGwpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgYmFzZSA9XG5cdFx0bG9jYWxQYWdlID8/XG5cdFx0Y3JlYXRlUGFnZShyZW1vdGUuY29udGVudCwge1xuXHRcdFx0aWQ6IHJlbW90ZS5pZCxcblx0XHRcdHVzZXJJZDogcmVtb3RlLnVzZXJfaWQsXG5cdFx0XHRub3c6IHJlbW90ZS5jcmVhdGVkX2F0LFxuXHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5iYXNlLFxuXHRcdGlkOiByZW1vdGUuaWQsXG5cdFx0dXNlcklkOiByZW1vdGUudXNlcl9pZCxcblx0XHR0aXRsZTogcmVtb3RlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdHRleHQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogcmVtb3RlLmNyZWF0ZWRfYXQsXG5cdFx0dXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRkZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdGxhc3RTeW5jZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdHN5bmNTdGF0dXM6ICdzeW5jZWQnLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwcmVzZXJ2ZUxvY2FsU2VsZWN0aW9uKHBhZ2U6IEVkaXRvclBhZ2UsIHNlbGVjdGlvblNvdXJjZTogRWRpdG9yUGFnZSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IE1hdGgubWF4KDAsIE1hdGgubWluKHNlbGVjdGlvblNvdXJjZS5zZWxlY3Rpb25TdGFydCwgcGFnZS5jb250ZW50Lmxlbmd0aCkpLFxuXHRcdHNlbGVjdGlvbkVuZDogTWF0aC5tYXgoMCwgTWF0aC5taW4oc2VsZWN0aW9uU291cmNlLnNlbGVjdGlvbkVuZCwgcGFnZS5jb250ZW50Lmxlbmd0aCkpXG5cdH07XG59XG5cbmZ1bmN0aW9uIHRvUmVtb3RlU2hhcGUocGFnZTogRWRpdG9yUGFnZSk6IFJlbW90ZVBhZ2VSb3cge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBwYWdlLmlkLFxuXHRcdHVzZXJfaWQ6IHBhZ2UudXNlcklkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHRjcmVhdGVkX2F0OiBwYWdlLmNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkX2F0OiBwYWdlLnVwZGF0ZWRBdCxcblx0XHRkZWxldGVkX2F0OiBwYWdlLmRlbGV0ZWRBdFxuXHR9O1xufVxuXG5mdW5jdGlvbiBoYXNQYWdlQ2hhbmdlZFNpbmNlU291cmNlKGN1cnJlbnRQYWdlOiBFZGl0b3JQYWdlLCBzb3VyY2VQYWdlOiBFZGl0b3JQYWdlKSB7XG5cdHJldHVybiAoXG5cdFx0Y3VycmVudFBhZ2UudGl0bGUgIT09IHNvdXJjZVBhZ2UudGl0bGUgfHxcblx0XHRjdXJyZW50UGFnZS5jb250ZW50ICE9PSBzb3VyY2VQYWdlLmNvbnRlbnQgfHxcblx0XHRjdXJyZW50UGFnZS5kZWxldGVkQXQgIT09IHNvdXJjZVBhZ2UuZGVsZXRlZEF0IHx8XG5cdFx0Y3VycmVudFBhZ2UudXBkYXRlZEF0ICE9PSBzb3VyY2VQYWdlLnVwZGF0ZWRBdCB8fFxuXHRcdGN1cnJlbnRQYWdlLmlzRXBoZW1lcmFsICE9PSBzb3VyY2VQYWdlLmlzRXBoZW1lcmFsXG5cdCk7XG59XG5cbmZ1bmN0aW9uIG1lcmdlU3luY2VkQmFzZWxpbmVJbnRvQ3VycmVudFBhZ2UoY3VycmVudFBhZ2U6IEVkaXRvclBhZ2UsIHN5bmNlZFBhZ2U6IEVkaXRvclBhZ2UpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4uY3VycmVudFBhZ2UsXG5cdFx0dXNlcklkOiBzeW5jZWRQYWdlLnVzZXJJZCxcblx0XHRjcmVhdGVkQXQ6IHN5bmNlZFBhZ2UuY3JlYXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogc3luY2VkUGFnZS5sYXN0U3luY2VkQXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzeW5jZWRQYWdlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN5bmNlZFBhZ2UubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0XG5cdH07XG5cblx0cmV0dXJuIHtcblx0XHQuLi5uZXh0UGFnZSxcblx0XHRzeW5jU3RhdHVzOlxuXHRcdFx0c3luY2VkUGFnZS5sYXN0U3luY2VkQXQgIT09IG51bGwgJiYgbGF0ZXN0TG9jYWxNdXRhdGlvbkF0KG5leHRQYWdlKSA+IHN5bmNlZFBhZ2UubGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gJ2RpcnR5J1xuXHRcdFx0XHQ6ICdzeW5jZWQnXG5cdH07XG59XG5cbmZ1bmN0aW9uIGhhc0xvY2FsQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2U6IEVkaXRvclBhZ2UpIHtcblx0aWYgKGxvY2FsUGFnZS5sYXN0U3luY2VkQXQgPT09IG51bGwpIHtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdHJldHVybiBsYXRlc3RMb2NhbE11dGF0aW9uQXQobG9jYWxQYWdlKSA+IGxvY2FsUGFnZS5sYXN0U3luY2VkQXQ7XG59XG5cbmZ1bmN0aW9uIGhhc1JlbW90ZUNoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlOiBFZGl0b3JQYWdlLCByZW1vdGU6IFJlbW90ZVBhZ2VSb3cpIHtcblx0aWYgKGxvY2FsUGFnZS5sYXN0U3luY2VkQXQgPT09IG51bGwpIHtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdHJldHVybiBsYXRlc3RSZW1vdGVNdXRhdGlvbkF0KHJlbW90ZSkgPiBsb2NhbFBhZ2UubGFzdFN5bmNlZEF0O1xufVxuXG5mdW5jdGlvbiBsYXRlc3RMb2NhbE11dGF0aW9uQXQobG9jYWxQYWdlOiBFZGl0b3JQYWdlKSB7XG5cdHJldHVybiBsb2NhbFBhZ2UuZGVsZXRlZEF0ICYmIGxvY2FsUGFnZS5kZWxldGVkQXQgPiBsb2NhbFBhZ2UudXBkYXRlZEF0XG5cdFx0PyBsb2NhbFBhZ2UuZGVsZXRlZEF0XG5cdFx0OiBsb2NhbFBhZ2UudXBkYXRlZEF0O1xufVxuXG5mdW5jdGlvbiBsYXRlc3RSZW1vdGVNdXRhdGlvbkF0KHJlbW90ZTogUmVtb3RlUGFnZVJvdykge1xuXHRyZXR1cm4gcmVtb3RlLmRlbGV0ZWRfYXQgJiYgcmVtb3RlLmRlbGV0ZWRfYXQgPiByZW1vdGUudXBkYXRlZF9hdCA/IHJlbW90ZS5kZWxldGVkX2F0IDogcmVtb3RlLnVwZGF0ZWRfYXQ7XG59XG5cbmZ1bmN0aW9uIHBhZ2VTdGF0ZXNNYXRjaChsb2NhbFBhZ2U6IEVkaXRvclBhZ2UsIHJlbW90ZTogUmVtb3RlUGFnZVJvdykge1xuXHRyZXR1cm4gKFxuXHRcdGxvY2FsUGFnZS50aXRsZSA9PT0gcmVtb3RlLnRpdGxlICYmXG5cdFx0bG9jYWxQYWdlLmNvbnRlbnQgPT09IHJlbW90ZS5jb250ZW50ICYmXG5cdFx0KGxvY2FsUGFnZS5kZWxldGVkQXQgPz8gbnVsbCkgPT09IChyZW1vdGUuZGVsZXRlZF9hdCA/PyBudWxsKVxuXHQpO1xufVxuXG5mdW5jdGlvbiBzaG91bGRLZWVwUmVtb3RlUGFnZUxvY2FsbHkocmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdHJldHVybiByZW1vdGUuZGVsZXRlZF9hdCA9PT0gbnVsbDtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb25mbGljdFN1ZmZpeChub3c6IERhdGUpIHtcblx0Y29uc3QgbGFiZWwgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCh1bmRlZmluZWQsIHtcblx0XHRkYXRlU3R5bGU6ICdtZWRpdW0nLFxuXHRcdHRpbWVTdHlsZTogJ3Nob3J0J1xuXHR9KS5mb3JtYXQobm93KTtcblxuXHRyZXR1cm4gYChMb2NhbCBjb25mbGljdCAke2xhYmVsfSlgO1xufVxuXG5mdW5jdGlvbiBzb3J0UGFnZXMocGFnZXM6IEVkaXRvclBhZ2VbXSkge1xuXHRyZXR1cm4gWy4uLnBhZ2VzXS5zb3J0KChsZWZ0LCByaWdodCkgPT4ge1xuXHRcdGlmIChsZWZ0LnVwZGF0ZWRBdCAhPT0gcmlnaHQudXBkYXRlZEF0KSB7XG5cdFx0XHRyZXR1cm4gcmlnaHQudXBkYXRlZEF0LmxvY2FsZUNvbXBhcmUobGVmdC51cGRhdGVkQXQpO1xuXHRcdH1cblxuXHRcdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0XHRyZXR1cm4gcmlnaHQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUobGVmdC5jcmVhdGVkQXQpO1xuXHRcdH1cblxuXHRcdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUNNWixJQUFNLG1CQUFtQjs7O0FDT3pCLElBQU0sZ0JBQWdCO0FBRXRCLFNBQVMsZ0JBQWdCLFNBQXlCO0FBQ3hELFFBQU0sWUFBWSxRQUNoQixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQztBQUVoQyxNQUFJLENBQUMsV0FBVztBQUNmLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTyxVQUFVLFFBQVEsUUFBUSxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFDbEQ7QUFFTyxTQUFTLFdBQ2YsVUFBVSxJQUNWLFVBS0ksQ0FBQyxH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
