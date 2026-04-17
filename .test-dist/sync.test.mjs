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
function createPageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `page-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

// src/lib/editor/sync.ts
var REMOTE_PAGE_COLUMNS = "id,user_id,title,content,created_at,updated_at,deleted_at";
async function syncUserPages(supabase, userId, localSession, now = /* @__PURE__ */ new Date()) {
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
      nextPages.push(toSyncedLocalPage(remote, localPage));
      continue;
    }
    if (sameState) {
      nextPages.push(toSyncedLocalPage(remote, localPage));
      continue;
    }
    if (localChanged && !remoteChanged) {
      const pushed = await pushLocalPage(supabase, userId, localPage);
      nextPages.push(toSyncedLocalPage(pushed, localPage));
      pushedCount += 1;
      continue;
    }
    if (!localChanged && remoteChanged) {
      nextPages.push(toSyncedLocalPage(remote, localPage));
      pulledCount += 1;
      continue;
    }
    const remotePage = toSyncedLocalPage(remote, localPage);
    nextPages.push(remotePage);
    conflictCount += 1;
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
    nextPages.push(toSyncedLocalPage(remote, null));
    pulledCount += 1;
  }
  const nextSession = ensureValidActivePage({
    pages: sortPages(nextPages),
    activePageId: nextActivePageId
  });
  const remoteActivePageId = getRemoteActivePageId(nextSession);
  if (remoteActivePageId) {
    await pushRemoteActivePageId(supabase, userId, remoteActivePageId);
  }
  return {
    session: nextSession,
    pushedCount,
    pulledCount,
    conflictCount
  };
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
async function pushRemoteActivePageId(supabase, userId, activePageId) {
  const { error } = await supabase.from("user_settings").upsert({
    user_id: userId,
    active_page_id: activePageId
  });
  if (error) {
    throw error;
  }
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
function buildConflictSuffix(now) {
  const label = new Intl.DateTimeFormat(void 0, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(now);
  return `(Local conflict ${label})`;
}
function sortPages(pages) {
  return [...pages].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.id.localeCompare(right.id);
  });
}
function getRemoteActivePageId(session) {
  const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
  if (!activePage || activePage.isEphemeral || activePage.deletedAt !== null) {
    return null;
  }
  return activePage.id;
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
  assert.equal(supabase.getActivePageId("user-a"), null);
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
  assert.equal(supabase.getActivePageId("user-a"), "local-1");
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
  assert.equal(supabase.getActivePageId("user-a"), "remote-1");
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
  assert.equal(result.session.pages[0]?.id, "page-1");
  assert.equal(result.session.pages[0]?.content, "remote edit");
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.notEqual(result.session.pages[1]?.id, "page-1");
  assert.match(result.session.pages[1]?.title ?? "", /^Shared \(Local conflict /);
  assert.equal(result.session.pages[1]?.content, "local edit");
  assert.equal(result.session.pages[1]?.syncStatus, "synced");
  assert.equal(result.session.pages[1]?.lastSyncedAt, result.session.pages[1]?.updatedAt);
  assert.equal(result.session.pages[1]?.isEphemeral, false);
  assert.equal(supabase.getRows("user-a").length, 2);
  assert.equal(supabase.getRows("user-a").some((row) => row.content === "local edit"), true);
});
test("syncUserPages handles remote delete versus local edit by forking the local edit", async () => {
  const local = createPage("keep me", {
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
      content: "keep me",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: "2026-04-17T18:04:00.000Z"
    }
  ]);
  const result = await syncUserPages(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.conflictCount, 1);
  assert.equal(result.session.pages.length, 2);
  assert.equal(result.session.pages[0]?.deletedAt, "2026-04-17T18:04:00.000Z");
  assert.equal(result.session.pages[1]?.deletedAt, null);
  assert.match(result.session.pages[1]?.title ?? "", /^Conflict \(Local conflict /);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3luYy50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuaW1wb3J0IHsgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQsIGZvcmtDb25mbGljdFBhZ2UsIHN5bmNVc2VyUGFnZXMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9zeW5jLnRzJztcbmltcG9ydCB0eXBlIHsgUGFnZVN5bmNTdGF0dXMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9wZXJzaXN0ZW5jZS9yZWNvcmRzLnRzJztcblxudHlwZSBSZW1vdGVQYWdlUm93ID0ge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VyX2lkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZF9hdDogc3RyaW5nO1xuXHR1cGRhdGVkX2F0OiBzdHJpbmc7XG5cdGRlbGV0ZWRfYXQ6IHN0cmluZyB8IG51bGw7XG59O1xuXG50eXBlIFVzZXJTZXR0aW5nc1JvdyA9IHtcblx0dXNlcl9pZDogc3RyaW5nO1xuXHRhY3RpdmVfcGFnZV9pZDogc3RyaW5nIHwgbnVsbDtcblx0Y3JlYXRlZF9hdD86IHN0cmluZztcblx0dXBkYXRlZF9hdD86IHN0cmluZztcbn07XG5cbmNsYXNzIEZha2VTdXBhYmFzZSB7XG5cdHByaXZhdGUgcGFnZXMgPSBuZXcgTWFwPHN0cmluZywgUmVtb3RlUGFnZVJvdz4oKTtcblx0cHJpdmF0ZSB1c2VyU2V0dGluZ3MgPSBuZXcgTWFwPHN0cmluZywgVXNlclNldHRpbmdzUm93PigpO1xuXG5cdGNvbnN0cnVjdG9yKHJvd3M6IFJlbW90ZVBhZ2VSb3dbXSA9IFtdLCBzZXR0aW5nczogVXNlclNldHRpbmdzUm93W10gPSBbXSkge1xuXHRcdGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcblx0XHRcdHRoaXMucGFnZXMuc2V0KHJvdy5pZCwgeyAuLi5yb3cgfSk7XG5cdFx0fVxuXHRcdGZvciAoY29uc3Qgc2V0dGluZyBvZiBzZXR0aW5ncykge1xuXHRcdFx0dGhpcy51c2VyU2V0dGluZ3Muc2V0KHNldHRpbmcudXNlcl9pZCwgeyAuLi5zZXR0aW5nIH0pO1xuXHRcdH1cblx0fVxuXG5cdGZyb20odGFibGU6IHN0cmluZykge1xuXHRcdGlmICh0YWJsZSA9PT0gJ3BhZ2VzJykge1xuXHRcdFx0Y29uc3QgYXBpID0gdGhpcztcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHNlbGVjdCgpIHtcblx0XHRcdFx0XHRsZXQgdXNlcklkID0gJyc7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGVxKGNvbHVtbjogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSB7XG5cdFx0XHRcdFx0XHRcdGFzc2VydC5lcXVhbChjb2x1bW4sICd1c2VyX2lkJyk7XG5cdFx0XHRcdFx0XHRcdHVzZXJJZCA9IHZhbHVlO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gdGhpcztcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRvcmRlcigpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0dGhlbihyZXNvbHZlOiAodmFsdWU6IHVua25vd24pID0+IHVua25vd24pIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgcm93cyA9IFsuLi5hcGkucGFnZXMudmFsdWVzKCldLmZpbHRlcigocm93KSA9PiByb3cudXNlcl9pZCA9PT0gdXNlcklkKTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXNvbHZlKHsgZGF0YTogcm93cywgZXJyb3I6IG51bGwgfSkpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHVwc2VydChwYXlsb2FkOiBSZW1vdGVQYWdlUm93KSB7XG5cdFx0XHRcdFx0YXBpLnBhZ2VzLnNldChwYXlsb2FkLmlkLCB7IC4uLnBheWxvYWQgfSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdHNlbGVjdCgpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRhc3luYyBzaW5nbGUoKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyBkYXRhOiBhcGkucGFnZXMuZ2V0KHBheWxvYWQuaWQpID8/IG51bGwsIGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0aWYgKHRhYmxlID09PSAndXNlcl9zZXR0aW5ncycpIHtcblx0XHRcdGNvbnN0IGFwaSA9IHRoaXM7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0bGV0IHVzZXJJZCA9ICcnO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRlcShjb2x1bW46IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuXHRcdFx0XHRcdFx0XHRhc3NlcnQuZXF1YWwoY29sdW1uLCAndXNlcl9pZCcpO1xuXHRcdFx0XHRcdFx0XHR1c2VySWQgPSB2YWx1ZTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0YXN5bmMgbWF5YmVTaW5nbGUoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7IGRhdGE6IGFwaS51c2VyU2V0dGluZ3MuZ2V0KHVzZXJJZCkgPz8gbnVsbCwgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRhc3luYyB1cHNlcnQocGF5bG9hZDogVXNlclNldHRpbmdzUm93KSB7XG5cdFx0XHRcdFx0YXBpLnVzZXJTZXR0aW5ncy5zZXQocGF5bG9hZC51c2VyX2lkLCB7IC4uLnBheWxvYWQgfSk7XG5cdFx0XHRcdFx0cmV0dXJuIHsgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0fVxuXHRcdFx0fTtcblx0XHR9XG5cblx0XHR0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgdGFibGUgJHt0YWJsZX1gKTtcblx0fVxuXG5cdGdldFJvd3ModXNlcklkOiBzdHJpbmcpIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMucGFnZXMudmFsdWVzKCldLmZpbHRlcigocm93KSA9PiByb3cudXNlcl9pZCA9PT0gdXNlcklkKTtcblx0fVxuXG5cdGdldEFjdGl2ZVBhZ2VJZCh1c2VySWQ6IHN0cmluZykge1xuXHRcdHJldHVybiB0aGlzLnVzZXJTZXR0aW5ncy5nZXQodXNlcklkKT8uYWN0aXZlX3BhZ2VfaWQgPz8gbnVsbDtcblx0fVxufVxuXG5mdW5jdGlvbiBidWlsZFNlc3Npb24ocGFnZTogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlUGFnZT4sIGFjdGl2ZVBhZ2VJZCA9IHBhZ2UuaWQpOiBFZGl0b3JTZXNzaW9uIHtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZFxuXHR9O1xufVxuXG50ZXN0KCdmb3JrQ29uZmxpY3RQYWdlIGNyZWF0ZXMgYSB2aXNpYmxlIGxvY2FsIGZvcmsgd2l0aCBhIG5ldyBpZCBhbmQgc3VmZml4JywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSBjcmVhdGVQYWdlKCdib2R5Jywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRzb3VyY2UudGl0bGUgPSAnTXkgUGFnZSc7XG5cdHNvdXJjZS5kZWxldGVkQXQgPSAnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJztcblxuXHRjb25zdCBmb3JrID0gZm9ya0NvbmZsaWN0UGFnZShzb3VyY2UsIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjEwOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0Lm5vdEVxdWFsKGZvcmsuaWQsIHNvdXJjZS5pZCk7XG5cdGFzc2VydC5lcXVhbChmb3JrLnVzZXJJZCwgJ3VzZXItYScpO1xuXHRhc3NlcnQuZXF1YWwoZm9yay5kZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQuZXF1YWwoZm9yay5zeW5jU3RhdHVzLCAnZGlydHknKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuaXNFcGhlbWVyYWwsIGZhbHNlKTtcblx0YXNzZXJ0Lm1hdGNoKGZvcmsudGl0bGUsIC9eTXkgUGFnZSBcXChMb2NhbCBjb25mbGljdCAvKTtcbn0pO1xuXG50ZXN0KCdmZXRjaFJlbW90ZUFjdGl2ZVBhZ2VJZCByZWFkcyByZW1vdGUgdXNlciBzZXR0aW5ncyBvbmx5IHdoZW4gYXNrZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXSwgW3sgdXNlcl9pZDogJ3VzZXItYScsIGFjdGl2ZV9wYWdlX2lkOiAncGFnZS0yJyB9XSk7XG5cdGFzc2VydC5lcXVhbChhd2FpdCBmZXRjaFJlbW90ZUFjdGl2ZVBhZ2VJZChzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScpLCAncGFnZS0yJyk7XG5cdGFzc2VydC5lcXVhbChhd2FpdCBmZXRjaFJlbW90ZUFjdGl2ZVBhZ2VJZChzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYicpLCBudWxsKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIGlnbm9yZXMgZXBoZW1lcmFsIHBsYWNlaG9sZGVyIHBhZ2VzJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJycsIHsgaWQ6ICdwYWdlLWVwaGVtZXJhbCcsIHVzZXJJZDogJ3VzZXItYScsIGlzRXBoZW1lcmFsOiB0cnVlIH0pO1xuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdwYWdlLWVwaGVtZXJhbCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCB0cnVlKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLmxlbmd0aCwgMCk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRBY3RpdmVQYWdlSWQoJ3VzZXItYScpLCBudWxsKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHB1c2hlcyBsb2NhbC1vbmx5IHJlYWwgcGFnZXMgYW5kIHRydXN0cyB0aGUgd3JpdGUgcmVzcG9uc2UnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgYm9keScsIHtcblx0XHRpZDogJ2xvY2FsLTEnLFxuXHRcdHVzZXJJZDogJ3VzZXItYScsXG5cdFx0bm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fSk7XG5cdGxvY2FsLnRpdGxlID0gJ0xvY2FsJztcblx0bG9jYWwudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKCk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowMjowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdzeW5jZWQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5sYXN0U3luY2VkQXQsICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKVswXT8uaWQsICdsb2NhbC0xJyk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRBY3RpdmVQYWdlSWQoJ3VzZXItYScpLCAnbG9jYWwtMScpO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgcHVsbHMgcmVtb3RlLW9ubHkgcGFnZXMgaW50byB0aGUgbG9jYWwgc2Vzc2lvbicsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3JlbW90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblx0Y29uc3QgZW1wdHlMb2NhbDogRWRpdG9yU2Vzc2lvbiA9IHsgcGFnZXM6IFtdLCBhY3RpdmVQYWdlSWQ6ICdtaXNzaW5nJyB9O1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBlbXB0eUxvY2FsLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVsbGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3JlbW90ZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRBY3RpdmVQYWdlSWQoJ3VzZXItYScpLCAncmVtb3RlLTEnKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIGZvcmtzIHdoZW4gbG9jYWwgYW5kIHJlbW90ZSBib3RoIGNoYW5nZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgZWRpdCcsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0bG9jYWwudGl0bGUgPSAnU2hhcmVkJztcblx0bG9jYWwudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDM6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0ID0gbnVsbDtcblx0bG9jYWwuc3luY1N0YXR1cyA9ICdkaXJ0eScgYXMgUGFnZVN5bmNTdGF0dXM7XG5cblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnU2hhcmVkJyxcblx0XHRcdGNvbnRlbnQ6ICdyZW1vdGUgZWRpdCcsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogbnVsbFxuXHRcdH1cblx0XSk7XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjA1OjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb25mbGljdENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlkLCAncGFnZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ3JlbW90ZSBlZGl0Jyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQubm90RXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmlkLCAncGFnZS0xJyk7XG5cdGFzc2VydC5tYXRjaChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8udGl0bGUgPz8gJycsIC9eU2hhcmVkIFxcKExvY2FsIGNvbmZsaWN0IC8pO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmNvbnRlbnQsICdsb2NhbCBlZGl0Jyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/Lmxhc3RTeW5jZWRBdCwgcmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LnVwZGF0ZWRBdCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uaXNFcGhlbWVyYWwsIGZhbHNlKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5zb21lKChyb3cpID0+IHJvdy5jb250ZW50ID09PSAnbG9jYWwgZWRpdCcpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIGhhbmRsZXMgcmVtb3RlIGRlbGV0ZSB2ZXJzdXMgbG9jYWwgZWRpdCBieSBmb3JraW5nIHRoZSBsb2NhbCBlZGl0JywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2tlZXAgbWUnLCB7XG5cdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdHVzZXJJZDogJ3VzZXItYScsXG5cdFx0bm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fSk7XG5cdGxvY2FsLnRpdGxlID0gJ0NvbmZsaWN0Jztcblx0bG9jYWwudXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDM6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0ID0gbnVsbDtcblx0bG9jYWwuc3luY1N0YXR1cyA9ICdkaXJ0eScgYXMgUGFnZVN5bmNTdGF0dXM7XG5cblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnQ29uZmxpY3QnLFxuXHRcdFx0Y29udGVudDogJ2tlZXAgbWUnLFxuXHRcdFx0Y3JlYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHR1cGRhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJyxcblx0XHRcdGRlbGV0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonXG5cdFx0fVxuXHRdKTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5kZWxldGVkQXQsICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5kZWxldGVkQXQsIG51bGwpO1xuXHRhc3NlcnQubWF0Y2gocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LnRpdGxlID8/ICcnLCAvXkNvbmZsaWN0IFxcKExvY2FsIGNvbmZsaWN0IC8pO1xufSk7XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcblxuZXhwb3J0IGNvbnN0IEFOT05ZTU9VU19VU0VSSUQgPSAnYW5vbnltb3VzJztcblxuZXhwb3J0IHR5cGUgUGFnZVN5bmNTdGF0dXMgPSAnc3luY2VkJyB8ICdkaXJ0eScgfCAncGVuZGluZ19wdXNoJyB8ICdjb25mbGljdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFnZVJlY29yZCB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRzeW5jU3RhdHVzOiBQYWdlU3luY1N0YXR1cztcblx0aXNFcGhlbWVyYWw6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ1JlY29yZCB7XG5cdGtleTogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZyB8IG51bGw7XG5cdHZhbHVlOiB1bmtub3duO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQgPSAnYWN0aXZlUGFnZUlkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1RIRU1FID0gJ3RoZW1lJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSA9ICd3b3JkQ291bnRWaXNpYmlsaXR5JztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCA9ICdzcGVsbGNoZWNrRW5hYmxlZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQgPSAnaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQnO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcbmltcG9ydCB7XG5cdEFOT05ZTU9VU19VU0VSSUQsXG5cdHR5cGUgUGFnZVJlY29yZCxcblx0dHlwZSBQYWdlU3luY1N0YXR1c1xufSBmcm9tICcuLi9wZXJzaXN0ZW5jZS9yZWNvcmRzJztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQYWdlIGV4dGVuZHMgRWRpdG9yU3RhdGUsIFBhZ2VSZWNvcmQge31cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JTZXNzaW9uIHtcblx0cGFnZXM6IEVkaXRvclBhZ2VbXTtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBVTlRJVExFRF9QQUdFID0gJ1VudGl0bGVkJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVBhZ2VUaXRsZShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaXJzdExpbmUgPSBjb250ZW50XG5cdFx0LnNwbGl0KCdcXG4nKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG5cdGlmICghZmlyc3RMaW5lKSB7XG5cdFx0cmV0dXJuIFVOVElUTEVEX1BBR0U7XG5cdH1cblxuXHRyZXR1cm4gZmlyc3RMaW5lLnJlcGxhY2UoL1xccysvZywgJyAnKS5zbGljZSgwLCA0OCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYWdlKFxuXHRjb250ZW50ID0gJycsXG5cdG9wdGlvbnM6IHtcblx0XHRpZD86IHN0cmluZztcblx0XHR1c2VySWQ/OiBzdHJpbmc7XG5cdFx0bm93Pzogc3RyaW5nO1xuXHRcdGlzRXBoZW1lcmFsPzogYm9vbGVhbjtcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IG9wdGlvbnMuaXNFcGhlbWVyYWwgPz8gdHJ1ZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbih1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSBjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRpZiAoc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLnBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVRpdGxlKHBhZ2U6IEVkaXRvclBhZ2UsIHRpdGxlOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURlbGV0ZWQocGFnZTogRWRpdG9yUGFnZSwgZGVsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRkZWxldGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBkZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZVBhZ2UocGFnZTogRWRpdG9yUGFnZSk6IEVkaXRvclBhZ2Uge1xuXHRpZiAoIXBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb25lUGFnZUZvclVzZXIocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY2xvbmVkID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogZmFsc2UgfSk7XG5cdHJldHVybiB7XG5cdFx0Li4uY2xvbmVkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHR0ZXh0OiBwYWdlLmNvbnRlbnQsXG5cdFx0ZGVsZXRlZEF0OiBwYWdlLmRlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEaXJ0eShwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQgPSBwYWdlLnVzZXJJZCk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXNlcklkLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uKHZhbHVlOiB1bmtub3duLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0aWYgKGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWUpKSB7XG5cdFx0cmV0dXJuIG1pZ3JhdGVMZWdhY3lTdGF0ZSh2YWx1ZSwgdXNlcklkKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCwgdXNlcklkKSlcblx0XHQuZmlsdGVyKChwYWdlKTogcGFnZSBpcyBFZGl0b3JQYWdlID0+IHBhZ2UgIT09IG51bGwpXG5cdFx0LnNvcnQoY29tcGFyZVBhZ2VzKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24odXNlcklkKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pLCBzdGF0ZSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGFnZSh2YWx1ZTogdW5rbm93biwgaW5kZXg6IG51bWJlciwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLmNyZWF0ZWRBdCwgdmFsdWUuY3JlYXRlZF9hdCk7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUudXBkYXRlZEF0LCB2YWx1ZS51cGRhdGVkX2F0KSA/PyBjcmVhdGVkQXQ7XG5cdGNvbnN0IGRlbGV0ZWRBdCA9IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5kZWxldGVkQXQsIHZhbHVlLmRlbGV0ZWRfYXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXgpLFxuXHRcdHVzZXJJZDogdHlwZW9mIHZhbHVlLnVzZXJJZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUudXNlcklkLmxlbmd0aCA+IDAgPyB2YWx1ZS51c2VySWQgOiB1c2VySWQsXG5cdFx0dGl0bGU6XG5cdFx0XHR0eXBlb2YgdmFsdWUudGl0bGUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdDogZGVyaXZlUGFnZVRpdGxlKG5vcm1hbGl6ZWRDb250ZW50KSxcblx0XHRjb250ZW50OiBub3JtYWxpemVkQ29udGVudCxcblx0XHR0ZXh0OiBub3JtYWxpemVkQ29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdFN5bmNlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCksXG5cdFx0c3luY1N0YXR1czogbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogdHlwZW9mIHZhbHVlLmlzRXBoZW1lcmFsID09PSAnYm9vbGVhbicgPyB2YWx1ZS5pc0VwaGVtZXJhbCA6IGZhbHNlXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYHBhZ2UtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogUGFnZVN5bmNTdGF0dXMpOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gY29tcGFyZVBhZ2VzKGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU3VwYWJhc2VDbGllbnQgfSBmcm9tICdAc3VwYWJhc2Uvc3VwYWJhc2UtanMnO1xuaW1wb3J0IHsgY3JlYXRlUGFnZSwgZW5zdXJlVmFsaWRBY3RpdmVQYWdlLCB0eXBlIEVkaXRvclBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4vY29yZS9zZXNzaW9uJztcblxuY29uc3QgUkVNT1RFX1BBR0VfQ09MVU1OUyA9ICdpZCx1c2VyX2lkLHRpdGxlLGNvbnRlbnQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0LGRlbGV0ZWRfYXQnO1xuXG5pbnRlcmZhY2UgUmVtb3RlUGFnZVJvdyB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkX2F0OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ6IHN0cmluZztcblx0ZGVsZXRlZF9hdDogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFJlbW90ZVVzZXJTZXR0aW5nc1JvdyB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY1J1blJlc3VsdCB7XG5cdHNlc3Npb246IEVkaXRvclNlc3Npb247XG5cdHB1c2hlZENvdW50OiBudW1iZXI7XG5cdHB1bGxlZENvdW50OiBudW1iZXI7XG5cdGNvbmZsaWN0Q291bnQ6IG51bWJlcjtcbn1cblxuLy8gT25lIG1hbnVhbCBzeW5jIHBhc3Mgd29ya3MgYWdhaW5zdCBvbmUgcmVtb3RlIHNuYXBzaG90LlxuLy8gV2UgcHVsbCBvbmNlLCBkZWNpZGUgZXZlcnl0aGluZyBhZ2FpbnN0IHRoYXQgc25hcHNob3QsIHRydXN0IHdyaXRlIHJlc3BvbnNlcyxcbi8vIGFuZCBvbmx5IHRoZW4gYnVpbGQgdGhlIG5leHQgbG9jYWwgc2Vzc2lvbi5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzeW5jVXNlclBhZ2VzKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nLFxuXHRsb2NhbFNlc3Npb246IEVkaXRvclNlc3Npb24sXG5cdG5vdyA9IG5ldyBEYXRlKClcbik6IFByb21pc2U8U3luY1J1blJlc3VsdD4ge1xuXHRjb25zdCByZW1vdGVTbmFwc2hvdCA9IGF3YWl0IHB1bGxSZW1vdGVTbmFwc2hvdChzdXBhYmFzZSwgdXNlcklkKTtcblx0Y29uc3QgcmVtb3RlQnlJZCA9IG5ldyBNYXAocmVtb3RlU25hcHNob3QubWFwKChwYWdlKSA9PiBbcGFnZS5pZCwgcGFnZV0pKTtcblx0Y29uc3QgcHJvY2Vzc2VkUmVtb3RlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdGNvbnN0IG5leHRQYWdlczogRWRpdG9yUGFnZVtdID0gW107XG5cdGxldCBwdXNoZWRDb3VudCA9IDA7XG5cdGxldCBwdWxsZWRDb3VudCA9IDA7XG5cdGxldCBjb25mbGljdENvdW50ID0gMDtcblx0bGV0IG5leHRBY3RpdmVQYWdlSWQgPSBsb2NhbFNlc3Npb24uYWN0aXZlUGFnZUlkO1xuXG5cdGZvciAoY29uc3QgbG9jYWxQYWdlIG9mIHNvcnRQYWdlcyhsb2NhbFNlc3Npb24ucGFnZXMuZmlsdGVyKChwYWdlKSA9PiBwYWdlLnVzZXJJZCA9PT0gdXNlcklkKSkpIHtcblx0XHRpZiAobG9jYWxQYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChsb2NhbFBhZ2UpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcmVtb3RlID0gcmVtb3RlQnlJZC5nZXQobG9jYWxQYWdlLmlkKSA/PyBudWxsO1xuXHRcdGlmICghcmVtb3RlKSB7XG5cdFx0XHRjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGxvY2FsUGFnZSk7XG5cdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShwdXNoZWQsIGxvY2FsUGFnZSkpO1xuXHRcdFx0cHVzaGVkQ291bnQgKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHByb2Nlc3NlZFJlbW90ZUlkcy5hZGQocmVtb3RlLmlkKTtcblx0XHRjb25zdCBsb2NhbENoYW5nZWQgPSBoYXNMb2NhbENoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlKTtcblx0XHRjb25zdCByZW1vdGVDaGFuZ2VkID0gaGFzUmVtb3RlQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2UsIHJlbW90ZSk7XG5cdFx0Y29uc3Qgc2FtZVN0YXRlID0gcGFnZVN0YXRlc01hdGNoKGxvY2FsUGFnZSwgcmVtb3RlKTtcblxuXHRcdGlmICghbG9jYWxDaGFuZ2VkICYmICFyZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIGxvY2FsUGFnZSkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHNhbWVTdGF0ZSkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChsb2NhbENoYW5nZWQgJiYgIXJlbW90ZUNoYW5nZWQpIHtcblx0XHRcdGNvbnN0IHB1c2hlZCA9IGF3YWl0IHB1c2hMb2NhbFBhZ2Uoc3VwYWJhc2UsIHVzZXJJZCwgbG9jYWxQYWdlKTtcblx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZCwgbG9jYWxQYWdlKSk7XG5cdFx0XHRwdXNoZWRDb3VudCArPSAxO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKCFsb2NhbENoYW5nZWQgJiYgcmVtb3RlQ2hhbmdlZCkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpKTtcblx0XHRcdHB1bGxlZENvdW50ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCByZW1vdGVQYWdlID0gdG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpO1xuXHRcdG5leHRQYWdlcy5wdXNoKHJlbW90ZVBhZ2UpO1xuXHRcdGNvbmZsaWN0Q291bnQgKz0gMTtcblxuXHRcdGNvbnN0IGNvbmZsaWN0Rm9yayA9IGZvcmtDb25mbGljdFBhZ2UobG9jYWxQYWdlLCBub3cpO1xuXHRcdGNvbnN0IHB1c2hlZEZvcmsgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGNvbmZsaWN0Rm9yayk7XG5cdFx0Y29uc3Qgc3luY2VkRm9yayA9IHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZEZvcmssIGNvbmZsaWN0Rm9yayk7XG5cdFx0bmV4dFBhZ2VzLnB1c2goc3luY2VkRm9yayk7XG5cdFx0cHVzaGVkQ291bnQgKz0gMTtcblxuXHRcdGlmIChsb2NhbFNlc3Npb24uYWN0aXZlUGFnZUlkID09PSBsb2NhbFBhZ2UuaWQgJiYgcmVtb3RlUGFnZS5kZWxldGVkQXQgIT09IG51bGwpIHtcblx0XHRcdG5leHRBY3RpdmVQYWdlSWQgPSBzeW5jZWRGb3JrLmlkO1xuXHRcdH1cblx0fVxuXG5cdGZvciAoY29uc3QgcmVtb3RlIG9mIHJlbW90ZVNuYXBzaG90KSB7XG5cdFx0aWYgKHByb2Nlc3NlZFJlbW90ZUlkcy5oYXMocmVtb3RlLmlkKSkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBudWxsKSk7XG5cdFx0cHVsbGVkQ291bnQgKz0gMTtcblx0fVxuXG5cdGNvbnN0IG5leHRTZXNzaW9uID0gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHtcblx0XHRwYWdlczogc29ydFBhZ2VzKG5leHRQYWdlcyksXG5cdFx0YWN0aXZlUGFnZUlkOiBuZXh0QWN0aXZlUGFnZUlkXG5cdH0pO1xuXHRjb25zdCByZW1vdGVBY3RpdmVQYWdlSWQgPSBnZXRSZW1vdGVBY3RpdmVQYWdlSWQobmV4dFNlc3Npb24pO1xuXHRpZiAocmVtb3RlQWN0aXZlUGFnZUlkKSB7XG5cdFx0YXdhaXQgcHVzaFJlbW90ZUFjdGl2ZVBhZ2VJZChzdXBhYmFzZSwgdXNlcklkLCByZW1vdGVBY3RpdmVQYWdlSWQpO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRzZXNzaW9uOiBuZXh0U2Vzc2lvbixcblx0XHRwdXNoZWRDb3VudCxcblx0XHRwdWxsZWRDb3VudCxcblx0XHRjb25mbGljdENvdW50XG5cdH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFJlbW90ZUFjdGl2ZVBhZ2VJZChcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZ1xuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlXG5cdFx0LmZyb20oJ3VzZXJfc2V0dGluZ3MnKVxuXHRcdC5zZWxlY3QoJ2FjdGl2ZV9wYWdlX2lkLHVzZXJfaWQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0Jylcblx0XHQuZXEoJ3VzZXJfaWQnLCB1c2VySWQpXG5cdFx0Lm1heWJlU2luZ2xlKCk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gKChkYXRhIGFzIFJlbW90ZVVzZXJTZXR0aW5nc1JvdyB8IG51bGwpPy5hY3RpdmVfcGFnZV9pZCA/PyBudWxsKSBhcyBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ya0NvbmZsaWN0UGFnZShwYWdlOiBFZGl0b3JQYWdlLCBub3cgPSBuZXcgRGF0ZSgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRpbWVzdGFtcCA9IG5vdy50b0lTT1N0cmluZygpO1xuXHRjb25zdCBmb3JrID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkOiBwYWdlLnVzZXJJZCwgbm93OiB0aW1lc3RhbXAsIGlzRXBoZW1lcmFsOiBmYWxzZSB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5mb3JrLFxuXHRcdHRpdGxlOiBgJHtwYWdlLnRpdGxlfSAke2J1aWxkQ29uZmxpY3RTdWZmaXgobm93KX1gLnRyaW0oKSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwYWdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZDogcGFnZS5zZWxlY3Rpb25FbmQsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1bGxSZW1vdGVTbmFwc2hvdChzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsIHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxSZW1vdGVQYWdlUm93W10+IHtcblx0Y29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2Vcblx0XHQuZnJvbSgncGFnZXMnKVxuXHRcdC5zZWxlY3QoUkVNT1RFX1BBR0VfQ09MVU1OUylcblx0XHQuZXEoJ3VzZXJfaWQnLCB1c2VySWQpXG5cdFx0Lm9yZGVyKCdjcmVhdGVkX2F0JywgeyBhc2NlbmRpbmc6IHRydWUgfSlcblx0XHQub3JkZXIoJ2lkJywgeyBhc2NlbmRpbmc6IHRydWUgfSk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gKGRhdGEgPz8gW10pIGFzIFJlbW90ZVBhZ2VSb3dbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVzaExvY2FsUGFnZShcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZyxcblx0bG9jYWxQYWdlOiBFZGl0b3JQYWdlXG4pOiBQcm9taXNlPFJlbW90ZVBhZ2VSb3c+IHtcblx0Y29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2Vcblx0XHQuZnJvbSgncGFnZXMnKVxuXHRcdC51cHNlcnQoXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBsb2NhbFBhZ2UuaWQsXG5cdFx0XHRcdHVzZXJfaWQ6IHVzZXJJZCxcblx0XHRcdFx0dGl0bGU6IGxvY2FsUGFnZS50aXRsZSxcblx0XHRcdFx0Y29udGVudDogbG9jYWxQYWdlLmNvbnRlbnQsXG5cdFx0XHRcdGNyZWF0ZWRfYXQ6IGxvY2FsUGFnZS5jcmVhdGVkQXQsXG5cdFx0XHRcdHVwZGF0ZWRfYXQ6IGxvY2FsUGFnZS51cGRhdGVkQXQsXG5cdFx0XHRcdGRlbGV0ZWRfYXQ6IGxvY2FsUGFnZS5kZWxldGVkQXRcblx0XHRcdH0sXG5cdFx0XHR7IG9uQ29uZmxpY3Q6ICdpZCcgfVxuXHRcdClcblx0XHQuc2VsZWN0KFJFTU9URV9QQUdFX0NPTFVNTlMpXG5cdFx0LnNpbmdsZSgpO1xuXG5cdGlmIChlcnJvcikge1xuXHRcdHRocm93IGVycm9yO1xuXHR9XG5cblx0cmV0dXJuIGRhdGEgYXMgUmVtb3RlUGFnZVJvdztcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVzaFJlbW90ZUFjdGl2ZVBhZ2VJZChzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsIHVzZXJJZDogc3RyaW5nLCBhY3RpdmVQYWdlSWQ6IHN0cmluZykge1xuXHRjb25zdCB7IGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZS5mcm9tKCd1c2VyX3NldHRpbmdzJykudXBzZXJ0KHtcblx0XHR1c2VyX2lkOiB1c2VySWQsXG5cdFx0YWN0aXZlX3BhZ2VfaWQ6IGFjdGl2ZVBhZ2VJZFxuXHR9KTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxufVxuXG5mdW5jdGlvbiB0b1N5bmNlZExvY2FsUGFnZShyZW1vdGU6IFJlbW90ZVBhZ2VSb3csIGxvY2FsUGFnZTogRWRpdG9yUGFnZSB8IG51bGwpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgYmFzZSA9XG5cdFx0bG9jYWxQYWdlID8/XG5cdFx0Y3JlYXRlUGFnZShyZW1vdGUuY29udGVudCwge1xuXHRcdFx0aWQ6IHJlbW90ZS5pZCxcblx0XHRcdHVzZXJJZDogcmVtb3RlLnVzZXJfaWQsXG5cdFx0XHRub3c6IHJlbW90ZS5jcmVhdGVkX2F0LFxuXHRcdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdFx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5iYXNlLFxuXHRcdGlkOiByZW1vdGUuaWQsXG5cdFx0dXNlcklkOiByZW1vdGUudXNlcl9pZCxcblx0XHR0aXRsZTogcmVtb3RlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdHRleHQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogcmVtb3RlLmNyZWF0ZWRfYXQsXG5cdFx0dXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRkZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdGxhc3RTeW5jZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdHN5bmNTdGF0dXM6ICdzeW5jZWQnLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBoYXNMb2NhbENoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlOiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsb2NhbFBhZ2UubGFzdFN5bmNlZEF0ID09PSBudWxsKSB7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHRyZXR1cm4gbGF0ZXN0TG9jYWxNdXRhdGlvbkF0KGxvY2FsUGFnZSkgPiBsb2NhbFBhZ2UubGFzdFN5bmNlZEF0O1xufVxuXG5mdW5jdGlvbiBoYXNSZW1vdGVDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZTogRWRpdG9yUGFnZSwgcmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdGlmIChsb2NhbFBhZ2UubGFzdFN5bmNlZEF0ID09PSBudWxsKSB7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHRyZXR1cm4gbGF0ZXN0UmVtb3RlTXV0YXRpb25BdChyZW1vdGUpID4gbG9jYWxQYWdlLmxhc3RTeW5jZWRBdDtcbn1cblxuZnVuY3Rpb24gbGF0ZXN0TG9jYWxNdXRhdGlvbkF0KGxvY2FsUGFnZTogRWRpdG9yUGFnZSkge1xuXHRyZXR1cm4gbG9jYWxQYWdlLmRlbGV0ZWRBdCAmJiBsb2NhbFBhZ2UuZGVsZXRlZEF0ID4gbG9jYWxQYWdlLnVwZGF0ZWRBdFxuXHRcdD8gbG9jYWxQYWdlLmRlbGV0ZWRBdFxuXHRcdDogbG9jYWxQYWdlLnVwZGF0ZWRBdDtcbn1cblxuZnVuY3Rpb24gbGF0ZXN0UmVtb3RlTXV0YXRpb25BdChyZW1vdGU6IFJlbW90ZVBhZ2VSb3cpIHtcblx0cmV0dXJuIHJlbW90ZS5kZWxldGVkX2F0ICYmIHJlbW90ZS5kZWxldGVkX2F0ID4gcmVtb3RlLnVwZGF0ZWRfYXQgPyByZW1vdGUuZGVsZXRlZF9hdCA6IHJlbW90ZS51cGRhdGVkX2F0O1xufVxuXG5mdW5jdGlvbiBwYWdlU3RhdGVzTWF0Y2gobG9jYWxQYWdlOiBFZGl0b3JQYWdlLCByZW1vdGU6IFJlbW90ZVBhZ2VSb3cpIHtcblx0cmV0dXJuIChcblx0XHRsb2NhbFBhZ2UudGl0bGUgPT09IHJlbW90ZS50aXRsZSAmJlxuXHRcdGxvY2FsUGFnZS5jb250ZW50ID09PSByZW1vdGUuY29udGVudCAmJlxuXHRcdChsb2NhbFBhZ2UuZGVsZXRlZEF0ID8/IG51bGwpID09PSAocmVtb3RlLmRlbGV0ZWRfYXQgPz8gbnVsbClcblx0KTtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb25mbGljdFN1ZmZpeChub3c6IERhdGUpIHtcblx0Y29uc3QgbGFiZWwgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCh1bmRlZmluZWQsIHtcblx0XHRkYXRlU3R5bGU6ICdtZWRpdW0nLFxuXHRcdHRpbWVTdHlsZTogJ3Nob3J0J1xuXHR9KS5mb3JtYXQobm93KTtcblxuXHRyZXR1cm4gYChMb2NhbCBjb25mbGljdCAke2xhYmVsfSlgO1xufVxuXG5mdW5jdGlvbiBzb3J0UGFnZXMocGFnZXM6IEVkaXRvclBhZ2VbXSkge1xuXHRyZXR1cm4gWy4uLnBhZ2VzXS5zb3J0KChsZWZ0LCByaWdodCkgPT4ge1xuXHRcdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0XHRyZXR1cm4gbGVmdC5jcmVhdGVkQXQubG9jYWxlQ29tcGFyZShyaWdodC5jcmVhdGVkQXQpO1xuXHRcdH1cblxuXHRcdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gZ2V0UmVtb3RlQWN0aXZlUGFnZUlkKHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0Y29uc3QgYWN0aXZlUGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGlmICghYWN0aXZlUGFnZSB8fCBhY3RpdmVQYWdlLmlzRXBoZW1lcmFsIHx8IGFjdGl2ZVBhZ2UuZGVsZXRlZEF0ICE9PSBudWxsKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRyZXR1cm4gYWN0aXZlUGFnZS5pZDtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUNLWixJQUFNLG1CQUFtQjs7O0FDUXpCLElBQU0sZ0JBQWdCO0FBRXRCLFNBQVMsZ0JBQWdCLFNBQXlCO0FBQ3hELFFBQU0sWUFBWSxRQUNoQixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQztBQUVoQyxNQUFJLENBQUMsV0FBVztBQUNmLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTyxVQUFVLFFBQVEsUUFBUSxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFDbEQ7QUFFTyxTQUFTLFdBQ2YsVUFBVSxJQUNWLFVBS0ksQ0FBQyxHQUNRO0FBQ2IsUUFBTSxZQUFZLFFBQVEsUUFBTyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUN4RCxTQUFPO0FBQUEsSUFDTixJQUFJLFFBQVEsTUFBTSxhQUFhO0FBQUEsSUFDL0IsUUFBUSxRQUFRLFVBQVU7QUFBQSxJQUMxQixPQUFPLGdCQUFnQixPQUFPO0FBQUEsSUFDOUI7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUNOLGdCQUFnQjtBQUFBLElBQ2hCLGNBQWM7QUFBQSxJQUNk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
