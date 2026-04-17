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
var syncInProgress = false;
function isSyncInProgress() {
  return syncInProgress;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3luYy50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuaW1wb3J0IHtcblx0ZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQsXG5cdGZvcmtDb25mbGljdFBhZ2UsXG5cdGlzU3luY0luUHJvZ3Jlc3MsXG5cdHN5bmNVc2VyUGFnZXNcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy50cyc7XG5pbXBvcnQgdHlwZSB7IFBhZ2VTeW5jU3RhdHVzIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbnR5cGUgUmVtb3RlUGFnZVJvdyA9IHtcblx0aWQ6IHN0cmluZztcblx0dXNlcl9pZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRfYXQ6IHN0cmluZztcblx0dXBkYXRlZF9hdDogc3RyaW5nO1xuXHRkZWxldGVkX2F0OiBzdHJpbmcgfCBudWxsO1xufTtcblxudHlwZSBVc2VyU2V0dGluZ3NSb3cgPSB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59O1xuXG5jbGFzcyBGYWtlU3VwYWJhc2Uge1xuXHRwcml2YXRlIHBhZ2VzID0gbmV3IE1hcDxzdHJpbmcsIFJlbW90ZVBhZ2VSb3c+KCk7XG5cdHByaXZhdGUgdXNlclNldHRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIFVzZXJTZXR0aW5nc1Jvdz4oKTtcblxuXHRjb25zdHJ1Y3Rvcihyb3dzOiBSZW1vdGVQYWdlUm93W10gPSBbXSwgc2V0dGluZ3M6IFVzZXJTZXR0aW5nc1Jvd1tdID0gW10pIHtcblx0XHRmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSB7XG5cdFx0XHR0aGlzLnBhZ2VzLnNldChyb3cuaWQsIHsgLi4ucm93IH0pO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHNldHRpbmcgb2Ygc2V0dGluZ3MpIHtcblx0XHRcdHRoaXMudXNlclNldHRpbmdzLnNldChzZXR0aW5nLnVzZXJfaWQsIHsgLi4uc2V0dGluZyB9KTtcblx0XHR9XG5cdH1cblxuXHRmcm9tKHRhYmxlOiBzdHJpbmcpIHtcblx0XHRpZiAodGFibGUgPT09ICdwYWdlcycpIHtcblx0XHRcdGNvbnN0IGFwaSA9IHRoaXM7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0bGV0IHVzZXJJZCA9ICcnO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRlcShjb2x1bW46IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuXHRcdFx0XHRcdFx0XHRhc3NlcnQuZXF1YWwoY29sdW1uLCAndXNlcl9pZCcpO1xuXHRcdFx0XHRcdFx0XHR1c2VySWQgPSB2YWx1ZTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0b3JkZXIoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHRoZW4ocmVzb2x2ZTogKHZhbHVlOiB1bmtub3duKSA9PiB1bmtub3duKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJvd3MgPSBbLi4uYXBpLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzb2x2ZSh7IGRhdGE6IHJvd3MsIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR1cHNlcnQocGF5bG9hZDogUmVtb3RlUGFnZVJvdykge1xuXHRcdFx0XHRcdGFwaS5wYWdlcy5zZXQocGF5bG9hZC5pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0YXN5bmMgc2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogYXBpLnBhZ2VzLmdldChwYXlsb2FkLmlkKSA/PyBudWxsLCBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdGlmICh0YWJsZSA9PT0gJ3VzZXJfc2V0dGluZ3MnKSB7XG5cdFx0XHRjb25zdCBhcGkgPSB0aGlzO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdGxldCB1c2VySWQgPSAnJztcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0ZXEoY29sdW1uOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdFx0XHRcdFx0YXNzZXJ0LmVxdWFsKGNvbHVtbiwgJ3VzZXJfaWQnKTtcblx0XHRcdFx0XHRcdFx0dXNlcklkID0gdmFsdWU7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdGFzeW5jIG1heWJlU2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4geyBkYXRhOiBhcGkudXNlclNldHRpbmdzLmdldCh1c2VySWQpID8/IG51bGwsIGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fSxcblx0XHRcdFx0YXN5bmMgdXBzZXJ0KHBheWxvYWQ6IFVzZXJTZXR0aW5nc1Jvdykge1xuXHRcdFx0XHRcdGFwaS51c2VyU2V0dGluZ3Muc2V0KHBheWxvYWQudXNlcl9pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7IGVycm9yOiBudWxsIH07XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdH1cblxuXHRnZXRSb3dzKHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIFsuLi50aGlzLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdH1cblxuXHRnZXRBY3RpdmVQYWdlSWQodXNlcklkOiBzdHJpbmcpIHtcblx0XHRyZXR1cm4gdGhpcy51c2VyU2V0dGluZ3MuZ2V0KHVzZXJJZCk/LmFjdGl2ZV9wYWdlX2lkID8/IG51bGw7XG5cdH1cbn1cblxuZnVuY3Rpb24gYnVpbGRTZXNzaW9uKHBhZ2U6IFJldHVyblR5cGU8dHlwZW9mIGNyZWF0ZVBhZ2U+LCBhY3RpdmVQYWdlSWQgPSBwYWdlLmlkKTogRWRpdG9yU2Vzc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWRcblx0fTtcbn1cblxudGVzdCgnZm9ya0NvbmZsaWN0UGFnZSBjcmVhdGVzIGEgdmlzaWJsZSBsb2NhbCBmb3JrIHdpdGggYSBuZXcgaWQgYW5kIHN1ZmZpeCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gY3JlYXRlUGFnZSgnYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0c291cmNlLnRpdGxlID0gJ015IFBhZ2UnO1xuXHRzb3VyY2UuZGVsZXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWic7XG5cblx0Y29uc3QgZm9yayA9IGZvcmtDb25mbGljdFBhZ2Uoc291cmNlLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODoxMDowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5ub3RFcXVhbChmb3JrLmlkLCBzb3VyY2UuaWQpO1xuXHRhc3NlcnQuZXF1YWwoZm9yay51c2VySWQsICd1c2VyLWEnKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuZGVsZXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChmb3JrLmlzRXBoZW1lcmFsLCBmYWxzZSk7XG5cdGFzc2VydC5tYXRjaChmb3JrLnRpdGxlLCAvXk15IFBhZ2UgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG59KTtcblxudGVzdCgnZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQgcmVhZHMgcmVtb3RlIHVzZXIgc2V0dGluZ3Mgb25seSB3aGVuIGFza2VkJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW10sIFt7IHVzZXJfaWQ6ICd1c2VyLWEnLCBhY3RpdmVfcGFnZV9pZDogJ3BhZ2UtMicgfV0pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnKSwgJ3BhZ2UtMicpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWInKSwgbnVsbCk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBpZ25vcmVzIGVwaGVtZXJhbCBwbGFjZWhvbGRlciBwYWdlcycsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCcnLCB7IGlkOiAncGFnZS1lcGhlbWVyYWwnLCB1c2VySWQ6ICd1c2VyLWEnLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKCk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowMjowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlkLCAncGFnZS1lcGhlbWVyYWwnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDApO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0QWN0aXZlUGFnZUlkKCd1c2VyLWEnKSwgbnVsbCk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBwdXNoZXMgbG9jYWwtb25seSByZWFsIHBhZ2VzIGFuZCB0cnVzdHMgdGhlIHdyaXRlIHJlc3BvbnNlJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2xvY2FsIGJvZHknLCB7XG5cdFx0aWQ6ICdsb2NhbC0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdMb2NhbCc7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZSgpO1xuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDI6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1c2hlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb25mbGljdENvdW50LCAwKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5zeW5jU3RhdHVzLCAnc3luY2VkJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8ubGFzdFN5bmNlZEF0LCAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJyk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJylbMF0/LmlkLCAnbG9jYWwtMScpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0QWN0aXZlUGFnZUlkKCd1c2VyLWEnKSwgJ2xvY2FsLTEnKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHB1bGxzIHJlbW90ZS1vbmx5IHBhZ2VzIGludG8gdGhlIGxvY2FsIHNlc3Npb24nLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdyZW1vdGUtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnUmVtb3RlJyxcblx0XHRcdGNvbnRlbnQ6ICdyZW1vdGUgYm9keScsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogbnVsbFxuXHRcdH1cblx0XSk7XG5cdGNvbnN0IGVtcHR5TG9jYWw6IEVkaXRvclNlc3Npb24gPSB7IHBhZ2VzOiBbXSwgYWN0aXZlUGFnZUlkOiAnbWlzc2luZycgfTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgZW1wdHlMb2NhbCwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1bGxlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdyZW1vdGUtMScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdzeW5jZWQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5sYXN0U3luY2VkQXQsICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0QWN0aXZlUGFnZUlkKCd1c2VyLWEnKSwgJ3JlbW90ZS0xJyk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBmb3JrcyB3aGVuIGxvY2FsIGFuZCByZW1vdGUgYm90aCBjaGFuZ2VkJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2xvY2FsIGVkaXQnLCB7XG5cdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdHVzZXJJZDogJ3VzZXItYScsXG5cdFx0bm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fSk7XG5cdGxvY2FsLnRpdGxlID0gJ1NoYXJlZCc7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCA9IG51bGw7XG5cdGxvY2FsLnN5bmNTdGF0dXMgPSAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdFx0dXNlcl9pZDogJ3VzZXItYScsXG5cdFx0XHR0aXRsZTogJ1NoYXJlZCcsXG5cdFx0XHRjb250ZW50OiAncmVtb3RlIGVkaXQnLFxuXHRcdFx0Y3JlYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHR1cGRhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJyxcblx0XHRcdGRlbGV0ZWRfYXQ6IG51bGxcblx0XHR9XG5cdF0pO1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3BhZ2UtMScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmNvbnRlbnQsICdyZW1vdGUgZWRpdCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdzeW5jZWQnKTtcblx0YXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5pZCwgJ3BhZ2UtMScpO1xuXHRhc3NlcnQubWF0Y2gocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LnRpdGxlID8/ICcnLCAvXlNoYXJlZCBcXChMb2NhbCBjb25mbGljdCAvKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5jb250ZW50LCAnbG9jYWwgZWRpdCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LnN5bmNTdGF0dXMsICdzeW5jZWQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5sYXN0U3luY2VkQXQsIHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy51cGRhdGVkQXQpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykuc29tZSgocm93KSA9PiByb3cuY29udGVudCA9PT0gJ2xvY2FsIGVkaXQnKSwgdHJ1ZSk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBoYW5kbGVzIHJlbW90ZSBkZWxldGUgdmVyc3VzIGxvY2FsIGVkaXQgYnkgZm9ya2luZyB0aGUgbG9jYWwgZWRpdCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdrZWVwIG1lJywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdDb25mbGljdCc7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCA9IG51bGw7XG5cdGxvY2FsLnN5bmNTdGF0dXMgPSAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdFx0dXNlcl9pZDogJ3VzZXItYScsXG5cdFx0XHR0aXRsZTogJ0NvbmZsaWN0Jyxcblx0XHRcdGNvbnRlbnQ6ICdrZWVwIG1lJyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJ1xuXHRcdH1cblx0XSk7XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjA1OjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb25mbGljdENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uZGVsZXRlZEF0LCAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uZGVsZXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy50aXRsZSA/PyAnJywgL15Db25mbGljdCBcXChMb2NhbCBjb25mbGljdCAvKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlamVjdHMgY29uY3VycmVudCBzeW5jIHBhc3NlcyB3aXRoIHRoZSBnbG9iYWwgZ3VhcmQnLCBhc3luYyAoKSA9PiB7XG5cdGxldCByZWxlYXNlU25hcHNob3QhOiAoKSA9PiB2b2lkO1xuXHRjb25zdCBzbmFwc2hvdEJsb2NrZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdHJlbGVhc2VTbmFwc2hvdCA9IHJlc29sdmU7XG5cdH0pO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0ge1xuXHRcdGZyb20odGFibGU6IHN0cmluZykge1xuXHRcdFx0aWYgKHRhYmxlID09PSAncGFnZXMnKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0ZXEoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdG9yZGVyKCkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR0aGVuKHJlc29sdmU6ICh2YWx1ZTogdW5rbm93bikgPT4gdW5rbm93bikge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiBzbmFwc2hvdEJsb2NrZWQudGhlbigoKSA9PiByZXNvbHZlKHsgZGF0YTogW10sIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHVwc2VydChwYXlsb2FkOiBSZW1vdGVQYWdlUm93KSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRcdGFzeW5jIHNpbmdsZSgpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogcGF5bG9hZCwgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHRhYmxlID09PSAndXNlcl9zZXR0aW5ncycpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRhc3luYyB1cHNlcnQoKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdFx0fVxuXHR9O1xuXG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0Y29uc3QgZmlyc3RTeW5jID0gc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCkpO1xuXHRhc3NlcnQuZXF1YWwoaXNTeW5jSW5Qcm9ncmVzcygpLCB0cnVlKTtcblxuXHRhd2FpdCBhc3NlcnQucmVqZWN0cyhcblx0XHQoKSA9PiBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSksXG5cdFx0L1N5bmMgYWxyZWFkeSBpbiBwcm9ncmVzc1xcLi9pXG5cdCk7XG5cblx0cmVsZWFzZVNuYXBzaG90KCk7XG5cdGF3YWl0IGZpcnN0U3luYztcblx0YXNzZXJ0LmVxdWFsKGlzU3luY0luUHJvZ3Jlc3MoKSwgZmFsc2UpO1xufSk7XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcblxuZXhwb3J0IGNvbnN0IEFOT05ZTU9VU19VU0VSSUQgPSAnYW5vbnltb3VzJztcblxuZXhwb3J0IHR5cGUgUGFnZVN5bmNTdGF0dXMgPSAnc3luY2VkJyB8ICdkaXJ0eScgfCAncGVuZGluZ19wdXNoJyB8ICdjb25mbGljdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFnZVJlY29yZCB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJJZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRBdDogc3RyaW5nO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcblx0ZGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRzeW5jU3RhdHVzOiBQYWdlU3luY1N0YXR1cztcblx0aXNFcGhlbWVyYWw6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ1JlY29yZCB7XG5cdGtleTogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZyB8IG51bGw7XG5cdHZhbHVlOiB1bmtub3duO1xuXHR1cGRhdGVkQXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFNFVFRJTkdfQUNUSVZFX1BBR0VfSUQgPSAnYWN0aXZlUGFnZUlkJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1RIRU1FID0gJ3RoZW1lJztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1dPUkRfQ09VTlRfVklTSUJJTElUWSA9ICd3b3JkQ291bnRWaXNpYmlsaXR5JztcbmV4cG9ydCBjb25zdCBTRVRUSU5HX1NQRUxMQ0hFQ0tfRU5BQkxFRCA9ICdzcGVsbGNoZWNrRW5hYmxlZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19IQVNfUFJPTVBURURfRk9SX0FOT05ZTU9VU19JTVBPUlQgPSAnaGFzUHJvbXB0ZWRGb3JBbm9ueW1vdXNJbXBvcnQnO1xuIiwgImltcG9ydCB0eXBlIHsgRWRpdG9yU3RhdGUgfSBmcm9tICcuLi9iYXNpYy9oaXN0b3J5JztcbmltcG9ydCB7XG5cdEFOT05ZTU9VU19VU0VSSUQsXG5cdHR5cGUgUGFnZVJlY29yZCxcblx0dHlwZSBQYWdlU3luY1N0YXR1c1xufSBmcm9tICcuLi9wZXJzaXN0ZW5jZS9yZWNvcmRzJztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JQYWdlIGV4dGVuZHMgRWRpdG9yU3RhdGUsIFBhZ2VSZWNvcmQge31cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JTZXNzaW9uIHtcblx0cGFnZXM6IEVkaXRvclBhZ2VbXTtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBVTlRJVExFRF9QQUdFID0gJ1VudGl0bGVkJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVBhZ2VUaXRsZShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaXJzdExpbmUgPSBjb250ZW50XG5cdFx0LnNwbGl0KCdcXG4nKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG5cdGlmICghZmlyc3RMaW5lKSB7XG5cdFx0cmV0dXJuIFVOVElUTEVEX1BBR0U7XG5cdH1cblxuXHRyZXR1cm4gZmlyc3RMaW5lLnJlcGxhY2UoL1xccysvZywgJyAnKS5zbGljZSgwLCA0OCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYWdlKFxuXHRjb250ZW50ID0gJycsXG5cdG9wdGlvbnM6IHtcblx0XHRpZD86IHN0cmluZztcblx0XHR1c2VySWQ/OiBzdHJpbmc7XG5cdFx0bm93Pzogc3RyaW5nO1xuXHRcdGlzRXBoZW1lcmFsPzogYm9vbGVhbjtcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IG9wdGlvbnMuaXNFcGhlbWVyYWwgPz8gdHJ1ZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbih1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSBjcmVhdGVQYWdlKCcnLCB7IHVzZXJJZCwgaXNFcGhlbWVyYWw6IHRydWUgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRpZiAoc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLnBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVRpdGxlKHBhZ2U6IEVkaXRvclBhZ2UsIHRpdGxlOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURlbGV0ZWQocGFnZTogRWRpdG9yUGFnZSwgZGVsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRkZWxldGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBkZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZVBhZ2UocGFnZTogRWRpdG9yUGFnZSk6IEVkaXRvclBhZ2Uge1xuXHRpZiAoIXBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb25lUGFnZUZvclVzZXIocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY2xvbmVkID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogZmFsc2UgfSk7XG5cdHJldHVybiB7XG5cdFx0Li4uY2xvbmVkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHR0ZXh0OiBwYWdlLmNvbnRlbnQsXG5cdFx0ZGVsZXRlZEF0OiBwYWdlLmRlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEaXJ0eShwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQgPSBwYWdlLnVzZXJJZCk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXNlcklkLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uKHZhbHVlOiB1bmtub3duLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0aWYgKGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWUpKSB7XG5cdFx0cmV0dXJuIG1pZ3JhdGVMZWdhY3lTdGF0ZSh2YWx1ZSwgdXNlcklkKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCwgdXNlcklkKSlcblx0XHQuZmlsdGVyKChwYWdlKTogcGFnZSBpcyBFZGl0b3JQYWdlID0+IHBhZ2UgIT09IG51bGwpXG5cdFx0LnNvcnQoY29tcGFyZVBhZ2VzKTtcblxuXHRpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24odXNlcklkKTtcblx0fVxuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0dHlwZW9mIHZhbHVlLmFjdGl2ZVBhZ2VJZCA9PT0gJ3N0cmluZycgJiZcblx0XHRwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSB2YWx1ZS5hY3RpdmVQYWdlSWQgJiYgcGFnZS5kZWxldGVkQXQgPT09IG51bGwpXG5cdFx0XHQ/IHZhbHVlLmFjdGl2ZVBhZ2VJZFxuXHRcdFx0OiAocGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpPy5pZCA/PyBwYWdlc1swXS5pZCk7XG5cblx0cmV0dXJuIGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7IHBhZ2VzLCBhY3RpdmVQYWdlSWQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlTGVnYWN5U3RhdGUoc3RhdGU6IEVkaXRvclN0YXRlLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGNvbnN0IHBhZ2UgPSB1cGRhdGVQYWdlU3RhdGUoY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pLCBzdGF0ZSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUGFnZSh2YWx1ZTogdW5rbm93biwgaW5kZXg6IG51bWJlciwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHwgbnVsbCB7XG5cdGlmICghaXNSZWNvcmQodmFsdWUpKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBjb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUuY29udGVudFxuXHRcdFx0OiB0eXBlb2YgdmFsdWUudGV4dCA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS50ZXh0XG5cdFx0XHRcdDogJyc7XG5cdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcblx0Y29uc3Qgc2VsZWN0aW9uU3RhcnQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uU3RhcnQgOiAwLFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBzZWxlY3Rpb25FbmQgPSBjbGFtcFNlbGVjdGlvbihcblx0XHR0eXBlb2YgdmFsdWUuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvbkVuZCA6IHNlbGVjdGlvblN0YXJ0LFxuXHRcdG5vcm1hbGl6ZWRDb250ZW50Lmxlbmd0aFxuXHQpO1xuXHRjb25zdCBjcmVhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLmNyZWF0ZWRBdCwgdmFsdWUuY3JlYXRlZF9hdCk7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUudXBkYXRlZEF0LCB2YWx1ZS51cGRhdGVkX2F0KSA/PyBjcmVhdGVkQXQ7XG5cdGNvbnN0IGRlbGV0ZWRBdCA9IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5kZWxldGVkQXQsIHZhbHVlLmRlbGV0ZWRfYXQpO1xuXG5cdHJldHVybiB7XG5cdFx0aWQ6IHR5cGVvZiB2YWx1ZS5pZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUuaWQubGVuZ3RoID4gMCA/IHZhbHVlLmlkIDogY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXgpLFxuXHRcdHVzZXJJZDogdHlwZW9mIHZhbHVlLnVzZXJJZCA9PT0gJ3N0cmluZycgJiYgdmFsdWUudXNlcklkLmxlbmd0aCA+IDAgPyB2YWx1ZS51c2VySWQgOiB1c2VySWQsXG5cdFx0dGl0bGU6XG5cdFx0XHR0eXBlb2YgdmFsdWUudGl0bGUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwXG5cdFx0XHRcdD8gdmFsdWUudGl0bGUudHJpbSgpXG5cdFx0XHRcdDogZGVyaXZlUGFnZVRpdGxlKG5vcm1hbGl6ZWRDb250ZW50KSxcblx0XHRjb250ZW50OiBub3JtYWxpemVkQ29udGVudCxcblx0XHR0ZXh0OiBub3JtYWxpemVkQ29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmQsXG5cdFx0Y3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkZWxldGVkQXQsXG5cdFx0bGFzdFN5bmNlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdFN5bmNlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCksXG5cdFx0c3luY1N0YXR1czogbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZS5zeW5jU3RhdHVzKSxcblx0XHRpc0VwaGVtZXJhbDogdHlwZW9mIHZhbHVlLmlzRXBoZW1lcmFsID09PSAnYm9vbGVhbicgPyB2YWx1ZS5pc0VwaGVtZXJhbCA6IGZhbHNlXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYHBhZ2UtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYHBhZ2UtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogUGFnZVN5bmNTdGF0dXMpOiBQYWdlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gY29tcGFyZVBhZ2VzKGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU3VwYWJhc2VDbGllbnQgfSBmcm9tICdAc3VwYWJhc2Uvc3VwYWJhc2UtanMnO1xuaW1wb3J0IHsgY3JlYXRlUGFnZSwgZW5zdXJlVmFsaWRBY3RpdmVQYWdlLCB0eXBlIEVkaXRvclBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4vY29yZS9zZXNzaW9uJztcblxuY29uc3QgUkVNT1RFX1BBR0VfQ09MVU1OUyA9ICdpZCx1c2VyX2lkLHRpdGxlLGNvbnRlbnQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0LGRlbGV0ZWRfYXQnO1xuXG5pbnRlcmZhY2UgUmVtb3RlUGFnZVJvdyB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkX2F0OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ6IHN0cmluZztcblx0ZGVsZXRlZF9hdDogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFJlbW90ZVVzZXJTZXR0aW5nc1JvdyB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY1J1blJlc3VsdCB7XG5cdHNlc3Npb246IEVkaXRvclNlc3Npb247XG5cdHB1c2hlZENvdW50OiBudW1iZXI7XG5cdHB1bGxlZENvdW50OiBudW1iZXI7XG5cdGNvbmZsaWN0Q291bnQ6IG51bWJlcjtcbn1cblxubGV0IHN5bmNJblByb2dyZXNzID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNJblByb2dyZXNzKCkge1xuXHRyZXR1cm4gc3luY0luUHJvZ3Jlc3M7XG59XG5cbi8vIE9uZSBtYW51YWwgc3luYyBwYXNzIHdvcmtzIGFnYWluc3Qgb25lIHJlbW90ZSBzbmFwc2hvdC5cbi8vIFdlIHB1bGwgb25jZSwgZGVjaWRlIGV2ZXJ5dGhpbmcgYWdhaW5zdCB0aGF0IHNuYXBzaG90LCB0cnVzdCB3cml0ZSByZXNwb25zZXMsXG4vLyBhbmQgb25seSB0aGVuIGJ1aWxkIHRoZSBuZXh0IGxvY2FsIHNlc3Npb24uXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3luY1VzZXJQYWdlcyhcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZyxcblx0bG9jYWxTZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRub3cgPSBuZXcgRGF0ZSgpXG4pOiBQcm9taXNlPFN5bmNSdW5SZXN1bHQ+IHtcblx0aWYgKHN5bmNJblByb2dyZXNzKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdTeW5jIGFscmVhZHkgaW4gcHJvZ3Jlc3MuJyk7XG5cdH1cblxuXHRzeW5jSW5Qcm9ncmVzcyA9IHRydWU7XG5cblx0dHJ5IHtcblx0XHRjb25zdCByZW1vdGVTbmFwc2hvdCA9IGF3YWl0IHB1bGxSZW1vdGVTbmFwc2hvdChzdXBhYmFzZSwgdXNlcklkKTtcblx0XHRjb25zdCByZW1vdGVCeUlkID0gbmV3IE1hcChyZW1vdGVTbmFwc2hvdC5tYXAoKHBhZ2UpID0+IFtwYWdlLmlkLCBwYWdlXSkpO1xuXHRcdGNvbnN0IHByb2Nlc3NlZFJlbW90ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdGNvbnN0IG5leHRQYWdlczogRWRpdG9yUGFnZVtdID0gW107XG5cdFx0bGV0IHB1c2hlZENvdW50ID0gMDtcblx0XHRsZXQgcHVsbGVkQ291bnQgPSAwO1xuXHRcdGxldCBjb25mbGljdENvdW50ID0gMDtcblx0XHRsZXQgbmV4dEFjdGl2ZVBhZ2VJZCA9IGxvY2FsU2Vzc2lvbi5hY3RpdmVQYWdlSWQ7XG5cblx0XHRmb3IgKGNvbnN0IGxvY2FsUGFnZSBvZiBzb3J0UGFnZXMobG9jYWxTZXNzaW9uLnBhZ2VzLmZpbHRlcigocGFnZSkgPT4gcGFnZS51c2VySWQgPT09IHVzZXJJZCkpKSB7XG5cdFx0XHRpZiAobG9jYWxQYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKGxvY2FsUGFnZSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZW1vdGUgPSByZW1vdGVCeUlkLmdldChsb2NhbFBhZ2UuaWQpID8/IG51bGw7XG5cdFx0XHRpZiAoIXJlbW90ZSkge1xuXHRcdFx0XHRjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGxvY2FsUGFnZSk7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZCwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdHB1c2hlZENvdW50ICs9IDE7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRwcm9jZXNzZWRSZW1vdGVJZHMuYWRkKHJlbW90ZS5pZCk7XG5cdFx0XHRjb25zdCBsb2NhbENoYW5nZWQgPSBoYXNMb2NhbENoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlKTtcblx0XHRcdGNvbnN0IHJlbW90ZUNoYW5nZWQgPSBoYXNSZW1vdGVDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZSwgcmVtb3RlKTtcblx0XHRcdGNvbnN0IHNhbWVTdGF0ZSA9IHBhZ2VTdGF0ZXNNYXRjaChsb2NhbFBhZ2UsIHJlbW90ZSk7XG5cblx0XHRcdGlmICghbG9jYWxDaGFuZ2VkICYmICFyZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc2FtZVN0YXRlKSB7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobG9jYWxDaGFuZ2VkICYmICFyZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRcdGNvbnN0IHB1c2hlZCA9IGF3YWl0IHB1c2hMb2NhbFBhZ2Uoc3VwYWJhc2UsIHVzZXJJZCwgbG9jYWxQYWdlKTtcblx0XHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocHVzaGVkLCBsb2NhbFBhZ2UpKTtcblx0XHRcdFx0cHVzaGVkQ291bnQgKz0gMTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghbG9jYWxDaGFuZ2VkICYmIHJlbW90ZUNoYW5nZWQpIHtcblx0XHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpKTtcblx0XHRcdFx0cHVsbGVkQ291bnQgKz0gMTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHJlbW90ZVBhZ2UgPSB0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIGxvY2FsUGFnZSk7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChyZW1vdGVQYWdlKTtcblx0XHRcdGNvbmZsaWN0Q291bnQgKz0gMTtcblxuXHRcdFx0Y29uc3QgY29uZmxpY3RGb3JrID0gZm9ya0NvbmZsaWN0UGFnZShsb2NhbFBhZ2UsIG5vdyk7XG5cdFx0XHRjb25zdCBwdXNoZWRGb3JrID0gYXdhaXQgcHVzaExvY2FsUGFnZShzdXBhYmFzZSwgdXNlcklkLCBjb25mbGljdEZvcmspO1xuXHRcdFx0Y29uc3Qgc3luY2VkRm9yayA9IHRvU3luY2VkTG9jYWxQYWdlKHB1c2hlZEZvcmssIGNvbmZsaWN0Rm9yayk7XG5cdFx0XHRuZXh0UGFnZXMucHVzaChzeW5jZWRGb3JrKTtcblx0XHRcdHB1c2hlZENvdW50ICs9IDE7XG5cblx0XHRcdGlmIChsb2NhbFNlc3Npb24uYWN0aXZlUGFnZUlkID09PSBsb2NhbFBhZ2UuaWQgJiYgcmVtb3RlUGFnZS5kZWxldGVkQXQgIT09IG51bGwpIHtcblx0XHRcdFx0bmV4dEFjdGl2ZVBhZ2VJZCA9IHN5bmNlZEZvcmsuaWQ7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCByZW1vdGUgb2YgcmVtb3RlU25hcHNob3QpIHtcblx0XHRcdGlmIChwcm9jZXNzZWRSZW1vdGVJZHMuaGFzKHJlbW90ZS5pZCkpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbnVsbCkpO1xuXHRcdFx0cHVsbGVkQ291bnQgKz0gMTtcblx0XHR9XG5cblx0XHRjb25zdCBuZXh0U2Vzc2lvbiA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0XHRwYWdlczogc29ydFBhZ2VzKG5leHRQYWdlcyksXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IG5leHRBY3RpdmVQYWdlSWRcblx0XHR9KTtcblx0XHRjb25zdCByZW1vdGVBY3RpdmVQYWdlSWQgPSBnZXRSZW1vdGVBY3RpdmVQYWdlSWQobmV4dFNlc3Npb24pO1xuXHRcdGlmIChyZW1vdGVBY3RpdmVQYWdlSWQpIHtcblx0XHRcdGF3YWl0IHB1c2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UsIHVzZXJJZCwgcmVtb3RlQWN0aXZlUGFnZUlkKTtcblx0XHR9XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0c2Vzc2lvbjogbmV4dFNlc3Npb24sXG5cdFx0XHRwdXNoZWRDb3VudCxcblx0XHRcdHB1bGxlZENvdW50LFxuXHRcdFx0Y29uZmxpY3RDb3VudFxuXHRcdH07XG5cdH0gZmluYWxseSB7XG5cdFx0c3luY0luUHJvZ3Jlc3MgPSBmYWxzZTtcblx0fVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoXG5cdHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCxcblx0dXNlcklkOiBzdHJpbmdcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuXHRjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZVxuXHRcdC5mcm9tKCd1c2VyX3NldHRpbmdzJylcblx0XHQuc2VsZWN0KCdhY3RpdmVfcGFnZV9pZCx1c2VyX2lkLGNyZWF0ZWRfYXQsdXBkYXRlZF9hdCcpXG5cdFx0LmVxKCd1c2VyX2lkJywgdXNlcklkKVxuXHRcdC5tYXliZVNpbmdsZSgpO1xuXG5cdGlmIChlcnJvcikge1xuXHRcdHRocm93IGVycm9yO1xuXHR9XG5cblx0cmV0dXJuICgoZGF0YSBhcyBSZW1vdGVVc2VyU2V0dGluZ3NSb3cgfCBudWxsKT8uYWN0aXZlX3BhZ2VfaWQgPz8gbnVsbCkgYXMgc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcmtDb25mbGljdFBhZ2UocGFnZTogRWRpdG9yUGFnZSwgbm93ID0gbmV3IERhdGUoKSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0aW1lc3RhbXAgPSBub3cudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgZm9yayA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZDogcGFnZS51c2VySWQsIG5vdzogdGltZXN0YW1wLCBpc0VwaGVtZXJhbDogZmFsc2UgfSk7XG5cdHJldHVybiB7XG5cdFx0Li4uZm9yayxcblx0XHR0aXRsZTogYCR7cGFnZS50aXRsZX0gJHtidWlsZENvbmZsaWN0U3VmZml4KG5vdyl9YC50cmltKCksXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdHRleHQ6IHBhZ2UuY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogcGFnZS5zZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmQ6IHBhZ2Uuc2VsZWN0aW9uRW5kLFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwdWxsUmVtb3RlU25hcHNob3Qoc3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LCB1c2VySWQ6IHN0cmluZyk6IFByb21pc2U8UmVtb3RlUGFnZVJvd1tdPiB7XG5cdGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlXG5cdFx0LmZyb20oJ3BhZ2VzJylcblx0XHQuc2VsZWN0KFJFTU9URV9QQUdFX0NPTFVNTlMpXG5cdFx0LmVxKCd1c2VyX2lkJywgdXNlcklkKVxuXHRcdC5vcmRlcignY3JlYXRlZF9hdCcsIHsgYXNjZW5kaW5nOiB0cnVlIH0pXG5cdFx0Lm9yZGVyKCdpZCcsIHsgYXNjZW5kaW5nOiB0cnVlIH0pO1xuXG5cdGlmIChlcnJvcikge1xuXHRcdHRocm93IGVycm9yO1xuXHR9XG5cblx0cmV0dXJuIChkYXRhID8/IFtdKSBhcyBSZW1vdGVQYWdlUm93W107XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1c2hMb2NhbFBhZ2UoXG5cdHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCxcblx0dXNlcklkOiBzdHJpbmcsXG5cdGxvY2FsUGFnZTogRWRpdG9yUGFnZVxuKTogUHJvbWlzZTxSZW1vdGVQYWdlUm93PiB7XG5cdGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlXG5cdFx0LmZyb20oJ3BhZ2VzJylcblx0XHQudXBzZXJ0KFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogbG9jYWxQYWdlLmlkLFxuXHRcdFx0XHR1c2VyX2lkOiB1c2VySWQsXG5cdFx0XHRcdHRpdGxlOiBsb2NhbFBhZ2UudGl0bGUsXG5cdFx0XHRcdGNvbnRlbnQ6IGxvY2FsUGFnZS5jb250ZW50LFxuXHRcdFx0XHRjcmVhdGVkX2F0OiBsb2NhbFBhZ2UuY3JlYXRlZEF0LFxuXHRcdFx0XHR1cGRhdGVkX2F0OiBsb2NhbFBhZ2UudXBkYXRlZEF0LFxuXHRcdFx0XHRkZWxldGVkX2F0OiBsb2NhbFBhZ2UuZGVsZXRlZEF0XG5cdFx0XHR9LFxuXHRcdFx0eyBvbkNvbmZsaWN0OiAnaWQnIH1cblx0XHQpXG5cdFx0LnNlbGVjdChSRU1PVEVfUEFHRV9DT0xVTU5TKVxuXHRcdC5zaW5nbGUoKTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxuXG5cdHJldHVybiBkYXRhIGFzIFJlbW90ZVBhZ2VSb3c7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1c2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LCB1c2VySWQ6IHN0cmluZywgYWN0aXZlUGFnZUlkOiBzdHJpbmcpIHtcblx0Y29uc3QgeyBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2UuZnJvbSgndXNlcl9zZXR0aW5ncycpLnVwc2VydCh7XG5cdFx0dXNlcl9pZDogdXNlcklkLFxuXHRcdGFjdGl2ZV9wYWdlX2lkOiBhY3RpdmVQYWdlSWRcblx0fSk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cbn1cblxuZnVuY3Rpb24gdG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlOiBSZW1vdGVQYWdlUm93LCBsb2NhbFBhZ2U6IEVkaXRvclBhZ2UgfCBudWxsKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGJhc2UgPVxuXHRcdGxvY2FsUGFnZSA/P1xuXHRcdGNyZWF0ZVBhZ2UocmVtb3RlLmNvbnRlbnQsIHtcblx0XHRcdGlkOiByZW1vdGUuaWQsXG5cdFx0XHR1c2VySWQ6IHJlbW90ZS51c2VyX2lkLFxuXHRcdFx0bm93OiByZW1vdGUuY3JlYXRlZF9hdCxcblx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdH0pO1xuXG5cdHJldHVybiB7XG5cdFx0Li4uYmFzZSxcblx0XHRpZDogcmVtb3RlLmlkLFxuXHRcdHVzZXJJZDogcmVtb3RlLnVzZXJfaWQsXG5cdFx0dGl0bGU6IHJlbW90ZS50aXRsZSxcblx0XHRjb250ZW50OiByZW1vdGUuY29udGVudCxcblx0XHR0ZXh0OiByZW1vdGUuY29udGVudCxcblx0XHRjcmVhdGVkQXQ6IHJlbW90ZS5jcmVhdGVkX2F0LFxuXHRcdHVwZGF0ZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0ZGVsZXRlZEF0OiByZW1vdGUuZGVsZXRlZF9hdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlbW90ZS51cGRhdGVkX2F0LFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZW1vdGUuZGVsZXRlZF9hdCxcblx0XHRzeW5jU3RhdHVzOiAnc3luY2VkJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gaGFzTG9jYWxDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZTogRWRpdG9yUGFnZSkge1xuXHRpZiAobG9jYWxQYWdlLmxhc3RTeW5jZWRBdCA9PT0gbnVsbCkge1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGxhdGVzdExvY2FsTXV0YXRpb25BdChsb2NhbFBhZ2UpID4gbG9jYWxQYWdlLmxhc3RTeW5jZWRBdDtcbn1cblxuZnVuY3Rpb24gaGFzUmVtb3RlQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2U6IEVkaXRvclBhZ2UsIHJlbW90ZTogUmVtb3RlUGFnZVJvdykge1xuXHRpZiAobG9jYWxQYWdlLmxhc3RTeW5jZWRBdCA9PT0gbnVsbCkge1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGxhdGVzdFJlbW90ZU11dGF0aW9uQXQocmVtb3RlKSA+IGxvY2FsUGFnZS5sYXN0U3luY2VkQXQ7XG59XG5cbmZ1bmN0aW9uIGxhdGVzdExvY2FsTXV0YXRpb25BdChsb2NhbFBhZ2U6IEVkaXRvclBhZ2UpIHtcblx0cmV0dXJuIGxvY2FsUGFnZS5kZWxldGVkQXQgJiYgbG9jYWxQYWdlLmRlbGV0ZWRBdCA+IGxvY2FsUGFnZS51cGRhdGVkQXRcblx0XHQ/IGxvY2FsUGFnZS5kZWxldGVkQXRcblx0XHQ6IGxvY2FsUGFnZS51cGRhdGVkQXQ7XG59XG5cbmZ1bmN0aW9uIGxhdGVzdFJlbW90ZU11dGF0aW9uQXQocmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdHJldHVybiByZW1vdGUuZGVsZXRlZF9hdCAmJiByZW1vdGUuZGVsZXRlZF9hdCA+IHJlbW90ZS51cGRhdGVkX2F0ID8gcmVtb3RlLmRlbGV0ZWRfYXQgOiByZW1vdGUudXBkYXRlZF9hdDtcbn1cblxuZnVuY3Rpb24gcGFnZVN0YXRlc01hdGNoKGxvY2FsUGFnZTogRWRpdG9yUGFnZSwgcmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdHJldHVybiAoXG5cdFx0bG9jYWxQYWdlLnRpdGxlID09PSByZW1vdGUudGl0bGUgJiZcblx0XHRsb2NhbFBhZ2UuY29udGVudCA9PT0gcmVtb3RlLmNvbnRlbnQgJiZcblx0XHQobG9jYWxQYWdlLmRlbGV0ZWRBdCA/PyBudWxsKSA9PT0gKHJlbW90ZS5kZWxldGVkX2F0ID8/IG51bGwpXG5cdCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29uZmxpY3RTdWZmaXgobm93OiBEYXRlKSB7XG5cdGNvbnN0IGxhYmVsID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQodW5kZWZpbmVkLCB7XG5cdFx0ZGF0ZVN0eWxlOiAnbWVkaXVtJyxcblx0XHR0aW1lU3R5bGU6ICdzaG9ydCdcblx0fSkuZm9ybWF0KG5vdyk7XG5cblx0cmV0dXJuIGAoTG9jYWwgY29uZmxpY3QgJHtsYWJlbH0pYDtcbn1cblxuZnVuY3Rpb24gc29ydFBhZ2VzKHBhZ2VzOiBFZGl0b3JQYWdlW10pIHtcblx0cmV0dXJuIFsuLi5wYWdlc10uc29ydCgobGVmdCwgcmlnaHQpID0+IHtcblx0XHRpZiAobGVmdC5jcmVhdGVkQXQgIT09IHJpZ2h0LmNyZWF0ZWRBdCkge1xuXHRcdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0XHR9XG5cblx0XHRyZXR1cm4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKTtcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGdldFJlbW90ZUFjdGl2ZVBhZ2VJZChzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKSB7XG5cdGNvbnN0IGFjdGl2ZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRpZiAoIWFjdGl2ZVBhZ2UgfHwgYWN0aXZlUGFnZS5pc0VwaGVtZXJhbCB8fCBhY3RpdmVQYWdlLmRlbGV0ZWRBdCAhPT0gbnVsbCkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0cmV0dXJuIGFjdGl2ZVBhZ2UuaWQ7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDS1osSUFBTSxtQkFBbUI7OztBQ1F6QixJQUFNLGdCQUFnQjtBQUV0QixTQUFTLGdCQUFnQixTQUF5QjtBQUN4RCxRQUFNLFlB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
