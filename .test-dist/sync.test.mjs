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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3luYy50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuaW1wb3J0IHtcblx0ZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQsXG5cdGZvcmtDb25mbGljdFBhZ2UsXG5cdGlzU3luY0luUHJvZ3Jlc3MsXG5cdHN5bmNVc2VyUGFnZXNcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy50cyc7XG5pbXBvcnQgdHlwZSB7IFBhZ2VTeW5jU3RhdHVzIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvcGVyc2lzdGVuY2UvcmVjb3Jkcy50cyc7XG5cbnR5cGUgUmVtb3RlUGFnZVJvdyA9IHtcblx0aWQ6IHN0cmluZztcblx0dXNlcl9pZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRfYXQ6IHN0cmluZztcblx0dXBkYXRlZF9hdDogc3RyaW5nO1xuXHRkZWxldGVkX2F0OiBzdHJpbmcgfCBudWxsO1xufTtcblxudHlwZSBVc2VyU2V0dGluZ3NSb3cgPSB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59O1xuXG5jbGFzcyBGYWtlU3VwYWJhc2Uge1xuXHRwcml2YXRlIHBhZ2VzID0gbmV3IE1hcDxzdHJpbmcsIFJlbW90ZVBhZ2VSb3c+KCk7XG5cdHByaXZhdGUgdXNlclNldHRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIFVzZXJTZXR0aW5nc1Jvdz4oKTtcblxuXHRjb25zdHJ1Y3Rvcihyb3dzOiBSZW1vdGVQYWdlUm93W10gPSBbXSwgc2V0dGluZ3M6IFVzZXJTZXR0aW5nc1Jvd1tdID0gW10pIHtcblx0XHRmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSB7XG5cdFx0XHR0aGlzLnBhZ2VzLnNldChyb3cuaWQsIHsgLi4ucm93IH0pO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHNldHRpbmcgb2Ygc2V0dGluZ3MpIHtcblx0XHRcdHRoaXMudXNlclNldHRpbmdzLnNldChzZXR0aW5nLnVzZXJfaWQsIHsgLi4uc2V0dGluZyB9KTtcblx0XHR9XG5cdH1cblxuXHRmcm9tKHRhYmxlOiBzdHJpbmcpIHtcblx0XHRpZiAodGFibGUgPT09ICdwYWdlcycpIHtcblx0XHRcdGNvbnN0IGFwaSA9IHRoaXM7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0bGV0IHVzZXJJZCA9ICcnO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRlcShjb2x1bW46IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuXHRcdFx0XHRcdFx0XHRhc3NlcnQuZXF1YWwoY29sdW1uLCAndXNlcl9pZCcpO1xuXHRcdFx0XHRcdFx0XHR1c2VySWQgPSB2YWx1ZTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0b3JkZXIoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHRoZW4ocmVzb2x2ZTogKHZhbHVlOiB1bmtub3duKSA9PiB1bmtub3duKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJvd3MgPSBbLi4uYXBpLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzb2x2ZSh7IGRhdGE6IHJvd3MsIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR1cHNlcnQocGF5bG9hZDogUmVtb3RlUGFnZVJvdykge1xuXHRcdFx0XHRcdGFwaS5wYWdlcy5zZXQocGF5bG9hZC5pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0YXN5bmMgc2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogYXBpLnBhZ2VzLmdldChwYXlsb2FkLmlkKSA/PyBudWxsLCBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdGlmICh0YWJsZSA9PT0gJ3VzZXJfc2V0dGluZ3MnKSB7XG5cdFx0XHRjb25zdCBhcGkgPSB0aGlzO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdGxldCB1c2VySWQgPSAnJztcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0ZXEoY29sdW1uOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpIHtcblx0XHRcdFx0XHRcdFx0YXNzZXJ0LmVxdWFsKGNvbHVtbiwgJ3VzZXJfaWQnKTtcblx0XHRcdFx0XHRcdFx0dXNlcklkID0gdmFsdWU7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdGFzeW5jIG1heWJlU2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4geyBkYXRhOiBhcGkudXNlclNldHRpbmdzLmdldCh1c2VySWQpID8/IG51bGwsIGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fSxcblx0XHRcdFx0YXN5bmMgdXBzZXJ0KHBheWxvYWQ6IFVzZXJTZXR0aW5nc1Jvdykge1xuXHRcdFx0XHRcdGFwaS51c2VyU2V0dGluZ3Muc2V0KHBheWxvYWQudXNlcl9pZCwgeyAuLi5wYXlsb2FkIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7IGVycm9yOiBudWxsIH07XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdH1cblxuXHRnZXRSb3dzKHVzZXJJZDogc3RyaW5nKSB7XG5cdFx0cmV0dXJuIFsuLi50aGlzLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdH1cblxuXHRnZXRBY3RpdmVQYWdlSWQodXNlcklkOiBzdHJpbmcpIHtcblx0XHRyZXR1cm4gdGhpcy51c2VyU2V0dGluZ3MuZ2V0KHVzZXJJZCk/LmFjdGl2ZV9wYWdlX2lkID8/IG51bGw7XG5cdH1cbn1cblxuZnVuY3Rpb24gYnVpbGRTZXNzaW9uKHBhZ2U6IFJldHVyblR5cGU8dHlwZW9mIGNyZWF0ZVBhZ2U+LCBhY3RpdmVQYWdlSWQgPSBwYWdlLmlkKTogRWRpdG9yU2Vzc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWRcblx0fTtcbn1cblxudGVzdCgnZm9ya0NvbmZsaWN0UGFnZSBjcmVhdGVzIGEgdmlzaWJsZSBsb2NhbCBmb3JrIHdpdGggYSBuZXcgaWQgYW5kIHN1ZmZpeCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gY3JlYXRlUGFnZSgnYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0c291cmNlLnRpdGxlID0gJ015IFBhZ2UnO1xuXHRzb3VyY2UuZGVsZXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWic7XG5cblx0Y29uc3QgZm9yayA9IGZvcmtDb25mbGljdFBhZ2Uoc291cmNlLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODoxMDowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5ub3RFcXVhbChmb3JrLmlkLCBzb3VyY2UuaWQpO1xuXHRhc3NlcnQuZXF1YWwoZm9yay51c2VySWQsICd1c2VyLWEnKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuZGVsZXRlZEF0LCBudWxsKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsuc3luY1N0YXR1cywgJ2RpcnR5Jyk7XG5cdGFzc2VydC5lcXVhbChmb3JrLmlzRXBoZW1lcmFsLCBmYWxzZSk7XG5cdGFzc2VydC5tYXRjaChmb3JrLnRpdGxlLCAvXk15IFBhZ2UgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG59KTtcblxudGVzdCgnZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQgcmVhZHMgcmVtb3RlIHVzZXIgc2V0dGluZ3Mgb25seSB3aGVuIGFza2VkJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW10sIFt7IHVzZXJfaWQ6ICd1c2VyLWEnLCBhY3RpdmVfcGFnZV9pZDogJ3BhZ2UtMicgfV0pO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnKSwgJ3BhZ2UtMicpO1xuXHRhc3NlcnQuZXF1YWwoYXdhaXQgZmV0Y2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWInKSwgbnVsbCk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBpZ25vcmVzIGVwaGVtZXJhbCBwbGFjZWhvbGRlciBwYWdlcycsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCcnLCB7IGlkOiAncGFnZS1lcGhlbWVyYWwnLCB1c2VySWQ6ICd1c2VyLWEnLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KTtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKCk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowMjowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlkLCAncGFnZS1lcGhlbWVyYWwnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgcHVzaGVzIGxvY2FsLW9ubHkgcmVhbCBwYWdlcyBhbmQgdHJ1c3RzIHRoZSB3cml0ZSByZXNwb25zZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdsb2NhbCBib2R5Jywge1xuXHRcdGlkOiAnbG9jYWwtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0bG9jYWwudGl0bGUgPSAnTG9jYWwnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpWzBdPy5pZCwgJ2xvY2FsLTEnKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlbW92ZXMgbG9jYWxseSBkZWxldGVkIHBhZ2VzIHdoZW4gdGhlIHJlbW90ZSByb3cgaXMgYWxyZWFkeSBnb25lJywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2xvY2FsIGJvZHknLCB7XG5cdFx0aWQ6ICdsb2NhbC0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdMb2NhbCc7XG5cdGxvY2FsLmxhc3RTeW5jZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVVcGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0ID0gbnVsbDtcblx0bG9jYWwuZGVsZXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDI6MDAuMDAwWic7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBQYWdlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVsbGVkQ291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgdHJ1ZSk7XG5cdGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdsb2NhbC0xJyk7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgcHVsbHMgcmVtb3RlLW9ubHkgcGFnZXMgaW50byB0aGUgbG9jYWwgc2Vzc2lvbicsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3JlbW90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblx0Y29uc3QgZW1wdHlMb2NhbDogRWRpdG9yU2Vzc2lvbiA9IHsgcGFnZXM6IFtdLCBhY3RpdmVQYWdlSWQ6ICdtaXNzaW5nJyB9O1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBlbXB0eUxvY2FsLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVsbGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3JlbW90ZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCBmYWxzZSk7XG59KTtcblxudGVzdCgnc3luY1VzZXJQYWdlcyBpZ25vcmVzIHJlbW90ZS1vbmx5IHBhZ2VzIHRoYXQgYXJlIGFscmVhZHkgZGVsZXRlZCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3JlbW90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJ1xuXHRcdH1cblx0XSk7XG5cdGNvbnN0IGVtcHR5TG9jYWw6IEVkaXRvclNlc3Npb24gPSB7IHBhZ2VzOiBbXSwgYWN0aXZlUGFnZUlkOiAnbWlzc2luZycgfTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgZW1wdHlMb2NhbCwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1bGxlZENvdW50LCAwKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaXNFcGhlbWVyYWwsIHRydWUpO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgZm9ya3Mgd2hlbiBsb2NhbCBhbmQgcmVtb3RlIGJvdGggY2hhbmdlZCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdsb2NhbCBlZGl0Jywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdTaGFyZWQnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMzowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBQYWdlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW1xuXHRcdHtcblx0XHRcdGlkOiAncGFnZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdTaGFyZWQnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBlZGl0Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1c2hlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdwYWdlLTEnKTtcblx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy50aXRsZSA/PyAnJywgL15TaGFyZWQgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ2xvY2FsIGVkaXQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5zeW5jU3RhdHVzLCAnc3luY2VkJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8ubGFzdFN5bmNlZEF0LCByZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8udXBkYXRlZEF0KTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pc0VwaGVtZXJhbCwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmlkLCAncGFnZS0xJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uY29udGVudCwgJ3JlbW90ZSBlZGl0Jyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLnNvbWUoKHJvdykgPT4gcm93LmNvbnRlbnQgPT09ICdsb2NhbCBlZGl0JyksIHRydWUpO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyUGFnZXMgaGFuZGxlcyByZW1vdGUgZGVsZXRlIHZlcnN1cyBsb2NhbCBlZGl0IGJ5IGZvcmtpbmcgdGhlIGxvY2FsIGVkaXQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgna2VlcCBtZSBsb2NhbGx5Jywge1xuXHRcdGlkOiAncGFnZS0xJyxcblx0XHR1c2VySWQ6ICd1c2VyLWEnLFxuXHRcdG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH0pO1xuXHRsb2NhbC50aXRsZSA9ICdDb25mbGljdCc7XG5cdGxvY2FsLnVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAzOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0U3luY2VkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZURlbGV0ZWRBdCA9IG51bGw7XG5cdGxvY2FsLnN5bmNTdGF0dXMgPSAnZGlydHknIGFzIFBhZ2VTeW5jU3RhdHVzO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdwYWdlLTEnLFxuXHRcdFx0dXNlcl9pZDogJ3VzZXItYScsXG5cdFx0XHR0aXRsZTogJ0NvbmZsaWN0Jyxcblx0XHRcdGNvbnRlbnQ6ICdzZXJ2ZXIgY29weScsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWidcblx0XHR9XG5cdF0pO1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyUGFnZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkQ291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXMubGVuZ3RoLCAxKTtcblx0YXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5pZCwgJ3BhZ2UtMScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmRlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uY29udGVudCwgJ2tlZXAgbWUgbG9jYWxseScpO1xuXHRhc3NlcnQubWF0Y2gocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnRpdGxlID8/ICcnLCAvXkNvbmZsaWN0IFxcKExvY2FsIGNvbmZsaWN0IC8pO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLnNvbWUoKHJvdykgPT4gcm93LmlkID09PSAncGFnZS0xJyAmJiByb3cuZGVsZXRlZF9hdCAhPT0gbnVsbCksIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykuc29tZSgocm93KSA9PiByb3cuY29udGVudCA9PT0gJ2tlZXAgbWUgbG9jYWxseScgJiYgcm93LmRlbGV0ZWRfYXQgPT09IG51bGwpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlbW92ZXMgbG9jYWwgcGFnZXMgd2hlbiB0aGUgcmVtb3RlIHZlcnNpb24gaXMgZGVsZXRlZCB3aXRob3V0IGEgbG9jYWwgZWRpdCcsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgbG9jYWwgPSBjcmVhdGVQYWdlKCdzZXJ2ZXIgYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0bG9jYWwudGl0bGUgPSAnQ29uZmxpY3QnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ3N5bmNlZCcgYXMgUGFnZVN5bmNTdGF0dXM7XG5cblx0Y29uc3Qgc3VwYWJhc2UgPSBuZXcgRmFrZVN1cGFiYXNlKFtcblx0XHR7XG5cdFx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnQ29uZmxpY3QnLFxuXHRcdFx0Y29udGVudDogJ3NlcnZlciBib2R5Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiAnMjAyNi0wNC0xN1QxODowNDowMC4wMDBaJ1xuXHRcdH1cblx0XSk7XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjA1OjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdWxsZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmlzRXBoZW1lcmFsLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlclBhZ2VzIHJlamVjdHMgY29uY3VycmVudCBzeW5jIHBhc3NlcyB3aXRoIHRoZSBnbG9iYWwgZ3VhcmQnLCBhc3luYyAoKSA9PiB7XG5cdGxldCByZWxlYXNlU25hcHNob3QhOiAoKSA9PiB2b2lkO1xuXHRjb25zdCBzbmFwc2hvdEJsb2NrZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdHJlbGVhc2VTbmFwc2hvdCA9IHJlc29sdmU7XG5cdH0pO1xuXG5cdGNvbnN0IHN1cGFiYXNlID0ge1xuXHRcdGZyb20odGFibGU6IHN0cmluZykge1xuXHRcdFx0aWYgKHRhYmxlID09PSAncGFnZXMnKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0ZXEoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdG9yZGVyKCkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR0aGVuKHJlc29sdmU6ICh2YWx1ZTogdW5rbm93bikgPT4gdW5rbm93bikge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiBzbmFwc2hvdEJsb2NrZWQudGhlbigoKSA9PiByZXNvbHZlKHsgZGF0YTogW10sIGVycm9yOiBudWxsIH0pKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHVwc2VydChwYXlsb2FkOiBSZW1vdGVQYWdlUm93KSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRcdGFzeW5jIHNpbmdsZSgpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogcGF5bG9hZCwgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHRhYmxlID09PSAndXNlcl9zZXR0aW5ncycpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRhc3luYyB1cHNlcnQoKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHRhYmxlICR7dGFibGV9YCk7XG5cdFx0fVxuXHR9O1xuXG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgYm9keScsIHtcblx0XHRpZDogJ3BhZ2UtMScsXG5cdFx0dXNlcklkOiAndXNlci1hJyxcblx0XHRub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9KTtcblx0Y29uc3QgZmlyc3RTeW5jID0gc3luY1VzZXJQYWdlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCkpO1xuXHRhc3NlcnQuZXF1YWwoaXNTeW5jSW5Qcm9ncmVzcygpLCB0cnVlKTtcblxuXHRhd2FpdCBhc3NlcnQucmVqZWN0cyhcblx0XHQoKSA9PiBzeW5jVXNlclBhZ2VzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSksXG5cdFx0L1N5bmMgYWxyZWFkeSBpbiBwcm9ncmVzc1xcLi9pXG5cdCk7XG5cblx0cmVsZWFzZVNuYXBzaG90KCk7XG5cdGF3YWl0IGZpcnN0U3luYztcblx0YXNzZXJ0LmVxdWFsKGlzU3luY0luUHJvZ3Jlc3MoKSwgZmFsc2UpO1xufSk7XG4iLCAiZXhwb3J0IGNvbnN0IEJMQU5LX0RCX05BTUUgPSAnYmxhbmsnO1xuZXhwb3J0IGNvbnN0IEJMQU5LX0RCX1ZFUlNJT04gPSAxO1xuZXhwb3J0IGNvbnN0IFBBR0VTX1NUT1JFX05BTUUgPSAncGFnZXMnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdTX1NUT1JFX05BTUUgPSAnc2V0dGluZ3MnO1xuZXhwb3J0IGNvbnN0IFVTRVJfSURfSU5ERVggPSAndXNlcklkJztcbmV4cG9ydCBjb25zdCBVUERBVEVEX0FUX0lOREVYID0gJ3VwZGF0ZWRBdCc7XG5cbmV4cG9ydCBjb25zdCBBTk9OWU1PVVNfVVNFUklEID0gJ2Fub255bW91cyc7XG5cbmV4cG9ydCB0eXBlIFBhZ2VTeW5jU3RhdHVzID0gJ3N5bmNlZCcgfCAnZGlydHknIHwgJ3BlbmRpbmdfcHVzaCcgfCAnY29uZmxpY3QnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VSZWNvcmQge1xuXHRpZDogc3RyaW5nO1xuXHR1c2VySWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkQXQ6IHN0cmluZztcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG5cdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0c3luY1N0YXR1czogUGFnZVN5bmNTdGF0dXM7XG5cdGlzRXBoZW1lcmFsOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmcgfCBudWxsO1xuXHR2YWx1ZTogdW5rbm93bjtcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEID0gJ2FjdGl2ZVBhZ2VJZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19USEVNRSA9ICd0aGVtZSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFkgPSAnd29yZENvdW50VmlzaWJpbGl0eSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQgPSAnc3BlbGxjaGVja0VuYWJsZWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JUID0gJ2hhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0JztcbiIsICJpbXBvcnQgdHlwZSB7IEVkaXRvclN0YXRlIH0gZnJvbSAnLi4vYmFzaWMvaGlzdG9yeSc7XG5pbXBvcnQge1xuXHRBTk9OWU1PVVNfVVNFUklELFxuXHR0eXBlIFBhZ2VSZWNvcmQsXG5cdHR5cGUgUGFnZVN5bmNTdGF0dXNcbn0gZnJvbSAnLi4vcGVyc2lzdGVuY2UvcmVjb3Jkcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlLCBQYWdlUmVjb3JkIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yU2Vzc2lvbiB7XG5cdHBhZ2VzOiBFZGl0b3JQYWdlW107XG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgVU5USVRMRURfUEFHRSA9ICdVbnRpdGxlZCc7XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVQYWdlVGl0bGUoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZmlyc3RMaW5lID0gY29udGVudFxuXHRcdC5zcGxpdCgnXFxuJylcblx0XHQubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcblx0XHQuZmluZCgobGluZSkgPT4gbGluZS5sZW5ndGggPiAwKTtcblxuXHRpZiAoIWZpcnN0TGluZSkge1xuXHRcdHJldHVybiBVTlRJVExFRF9QQUdFO1xuXHR9XG5cblx0cmV0dXJuIGZpcnN0TGluZS5yZXBsYWNlKC9cXHMrL2csICcgJykuc2xpY2UoMCwgNDgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUGFnZShcblx0Y29udGVudCA9ICcnLFxuXHRvcHRpb25zOiB7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0dXNlcklkPzogc3RyaW5nO1xuXHRcdG5vdz86IHN0cmluZztcblx0XHRpc0VwaGVtZXJhbD86IGJvb2xlYW47XG5cdH0gPSB7fVxuKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRpbWVzdGFtcCA9IG9wdGlvbnMubm93ID8/IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHRpZDogb3B0aW9ucy5pZCA/PyBjcmVhdGVQYWdlSWQoKSxcblx0XHR1c2VySWQ6IG9wdGlvbnMudXNlcklkID8/IEFOT05ZTU9VU19VU0VSSUQsXG5cdFx0dGl0bGU6IGRlcml2ZVBhZ2VUaXRsZShjb250ZW50KSxcblx0XHRjb250ZW50LFxuXHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0c2VsZWN0aW9uRW5kOiAwLFxuXHRcdGNyZWF0ZWRBdDogdGltZXN0YW1wLFxuXHRcdHVwZGF0ZWRBdDogdGltZXN0YW1wLFxuXHRcdGRlbGV0ZWRBdDogbnVsbCxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBvcHRpb25zLmlzRXBoZW1lcmFsID8/IHRydWVcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgnJywgeyB1c2VySWQsIGlzRXBoZW1lcmFsOiB0cnVlIH0pO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2Uoc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbik6IEVkaXRvclNlc3Npb24ge1xuXHRpZiAoc2Vzc2lvbi5wYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gY3JlYXRlU2Vzc2lvbigpO1xuXHR9XG5cblx0Y29uc3QgcGFnZXMgPSBzb3J0UGFnZXNCeVJlY2VuY3koc2Vzc2lvbi5wYWdlcyk7XG5cdGlmIChwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdHBhZ2VzXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBwYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCk7XG5cdGlmIChmaXJzdFZpc2libGVQYWdlKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdC4uLnNlc3Npb24sXG5cdFx0XHRwYWdlcyxcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0cGFnZXMsXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlc1swXSEuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhc1Zpc2libGVFcGhlbWVyYWxBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pIHtcblx0Y29uc3QgYWN0aXZlUGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdHJldHVybiAhIWFjdGl2ZVBhZ2UgJiYgYWN0aXZlUGFnZS5kZWxldGVkQXQgPT09IG51bGwgJiYgYWN0aXZlUGFnZS5pc0VwaGVtZXJhbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlbW90ZUVsaWdpYmxlQWN0aXZlUGFnZUlkKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgYWN0aXZlUGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQpID8/IG51bGw7XG5cdGlmICghYWN0aXZlUGFnZSB8fCBhY3RpdmVQYWdlLmRlbGV0ZWRBdCAhPT0gbnVsbCB8fCBhY3RpdmVQYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRyZXR1cm4gYWN0aXZlUGFnZS5pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlbW90ZUFjdGl2ZVBhZ2VVcGRhdGVUYXJnZXQoXG5cdHByZXZpb3VzU2Vzc2lvbjogRWRpdG9yU2Vzc2lvbixcblx0bmV4dFNlc3Npb246IEVkaXRvclNlc3Npb25cbik6IHN0cmluZyB8IG51bGwge1xuXHRjb25zdCBuZXh0QWN0aXZlUGFnZUlkID0gZ2V0UmVtb3RlRWxpZ2libGVBY3RpdmVQYWdlSWQobmV4dFNlc3Npb24pO1xuXHRpZiAobmV4dEFjdGl2ZVBhZ2VJZCAmJiBuZXh0QWN0aXZlUGFnZUlkICE9PSBwcmV2aW91c1Nlc3Npb24uYWN0aXZlUGFnZUlkKSB7XG5cdFx0cmV0dXJuIG5leHRBY3RpdmVQYWdlSWQ7XG5cdH1cblxuXHRjb25zdCBwcmV2aW91c0FjdGl2ZUJlZm9yZSA9IHByZXZpb3VzU2Vzc2lvbi5wYWdlcy5maW5kKChwYWdlKSA9PiBwYWdlLmlkID09PSBwcmV2aW91c1Nlc3Npb24uYWN0aXZlUGFnZUlkKSA/PyBudWxsO1xuXHRjb25zdCBwcmV2aW91c0FjdGl2ZUFmdGVyID0gbmV4dFNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5pZCA9PT0gcHJldmlvdXNTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbnVsbDtcblx0aWYgKFxuXHRcdHByZXZpb3VzQWN0aXZlQmVmb3JlICYmXG5cdFx0cHJldmlvdXNBY3RpdmVCZWZvcmUuZGVsZXRlZEF0ID09PSBudWxsICYmXG5cdFx0cHJldmlvdXNBY3RpdmVCZWZvcmUuaXNFcGhlbWVyYWwgJiZcblx0XHRwcmV2aW91c0FjdGl2ZUFmdGVyICYmXG5cdFx0cHJldmlvdXNBY3RpdmVBZnRlci5kZWxldGVkQXQgPT09IG51bGwgJiZcblx0XHQhcHJldmlvdXNBY3RpdmVBZnRlci5pc0VwaGVtZXJhbFxuXHQpIHtcblx0XHRyZXR1cm4gcHJldmlvdXNBY3RpdmVBZnRlci5pZDtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVRpdGxlKHBhZ2U6IEVkaXRvclBhZ2UsIHRpdGxlOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRpdGxlLnRyaW0oKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHRpdGxlOiB0cmltbWVkLmxlbmd0aCA+IDAgPyB0cmltbWVkLnNsaWNlKDAsIDQ4KSA6IFVOVElUTEVEX1BBR0UsXG5cdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZURlbGV0ZWQocGFnZTogRWRpdG9yUGFnZSwgZGVsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRkZWxldGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBkZWxldGVkQXQsXG5cdFx0c3luY1N0YXR1czogbmV4dERpcnR5U3RhdHVzKHBhZ2Uuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRlcmlhbGl6ZVBhZ2UocGFnZTogRWRpdG9yUGFnZSk6IEVkaXRvclBhZ2Uge1xuXHRpZiAoIXBhZ2UuaXNFcGhlbWVyYWwpIHtcblx0XHRyZXR1cm4gcGFnZTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb25lUGFnZUZvclVzZXIocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkOiBzdHJpbmcpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgY2xvbmVkID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogZmFsc2UgfSk7XG5cdHJldHVybiB7XG5cdFx0Li4uY2xvbmVkLFxuXHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHR0ZXh0OiBwYWdlLmNvbnRlbnQsXG5cdFx0ZGVsZXRlZEF0OiBwYWdlLmRlbGV0ZWRBdCxcblx0XHRzeW5jU3RhdHVzOiAnZGlydHknLFxuXHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEaXJ0eShwYWdlOiBFZGl0b3JQYWdlLCB1c2VySWQgPSBwYWdlLnVzZXJJZCk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dXNlcklkLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6IHBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2NvbmZsaWN0JyA/ICdjb25mbGljdCcgOiAnZGlydHknXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uKHZhbHVlOiB1bmtub3duLCB1c2VySWQgPSBBTk9OWU1PVVNfVVNFUklEKTogRWRpdG9yU2Vzc2lvbiB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0aWYgKGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWUpKSB7XG5cdFx0cmV0dXJuIG1pZ3JhdGVMZWdhY3lTdGF0ZSh2YWx1ZSwgdXNlcklkKTtcblx0fVxuXG5cdGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZS5wYWdlcykpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhZ2VzID0gdmFsdWUucGFnZXNcblx0XHQubWFwKChwYWdlLCBpbmRleCkgPT4gbm9ybWFsaXplUGFnZShwYWdlLCBpbmRleCwgdXNlcklkKSlcblx0XHQuZmlsdGVyKChwYWdlKTogcGFnZSBpcyBFZGl0b3JQYWdlID0+IHBhZ2UgIT09IG51bGwpXG5cdC5zb3J0KGNvbXBhcmVQYWdlc0J5UmVjZW5jeSk7XG5cblx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKHVzZXJJZCk7XG5cdH1cblxuXHRjb25zdCBhY3RpdmVQYWdlSWQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5hY3RpdmVQYWdlSWQgPT09ICdzdHJpbmcnICYmXG5cdFx0cGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gdmFsdWUuYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKVxuXHRcdFx0PyB2YWx1ZS5hY3RpdmVQYWdlSWRcblx0XHRcdDogKHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKT8uaWQgPz8gcGFnZXNbMF0uaWQpO1xuXG5cdHJldHVybiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UoeyBwYWdlcywgYWN0aXZlUGFnZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUxlZ2FjeVN0YXRlKHN0YXRlOiBFZGl0b3JTdGF0ZSwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGNyZWF0ZVBhZ2UoJycsIHsgdXNlcklkLCBpc0VwaGVtZXJhbDogdHJ1ZSB9KSwgc3RhdGUpO1xuXHRyZXR1cm4ge1xuXHRcdHBhZ2VzOiBbcGFnZV0sXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlLmlkXG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhZ2UodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgY29udGVudCA9XG5cdFx0dHlwZW9mIHZhbHVlLmNvbnRlbnQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmNvbnRlbnRcblx0XHRcdDogdHlwZW9mIHZhbHVlLnRleHQgPT09ICdzdHJpbmcnXG5cdFx0XHRcdD8gdmFsdWUudGV4dFxuXHRcdFx0XHQ6ICcnO1xuXHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IGNvbnRlbnQucmVwbGFjZSgvXFxyXFxuPy9nLCAnXFxuJyk7XG5cdGNvbnN0IHNlbGVjdGlvblN0YXJ0ID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvblN0YXJ0ID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvblN0YXJ0IDogMCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3Qgc2VsZWN0aW9uRW5kID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvbkVuZCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25FbmQgOiBzZWxlY3Rpb25TdGFydCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3QgY3JlYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS5jcmVhdGVkQXQsIHZhbHVlLmNyZWF0ZWRfYXQpO1xuXHRjb25zdCB1cGRhdGVkQXQgPSByZWFkVGltZXN0YW1wKHZhbHVlLnVwZGF0ZWRBdCwgdmFsdWUudXBkYXRlZF9hdCkgPz8gY3JlYXRlZEF0O1xuXHRjb25zdCBkZWxldGVkQXQgPSByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUuZGVsZXRlZEF0LCB2YWx1ZS5kZWxldGVkX2F0KTtcblxuXHRyZXR1cm4ge1xuXHRcdGlkOiB0eXBlb2YgdmFsdWUuaWQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmlkLmxlbmd0aCA+IDAgPyB2YWx1ZS5pZCA6IGNyZWF0ZUZhbGxiYWNrUGFnZUlkKGluZGV4KSxcblx0XHR1c2VySWQ6IHR5cGVvZiB2YWx1ZS51c2VySWQgPT09ICdzdHJpbmcnICYmIHZhbHVlLnVzZXJJZC5sZW5ndGggPiAwID8gdmFsdWUudXNlcklkIDogdXNlcklkLFxuXHRcdHRpdGxlOlxuXHRcdFx0dHlwZW9mIHZhbHVlLnRpdGxlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS50aXRsZS50cmltKCkubGVuZ3RoID4gMFxuXHRcdFx0XHQ/IHZhbHVlLnRpdGxlLnRyaW0oKVxuXHRcdFx0XHQ6IGRlcml2ZVBhZ2VUaXRsZShub3JtYWxpemVkQ29udGVudCksXG5cdFx0Y29udGVudDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0dGV4dDogbm9ybWFsaXplZENvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RTeW5jZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlVXBkYXRlZEF0KSxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQpLFxuXHRcdHN5bmNTdGF0dXM6IG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWUuc3luY1N0YXR1cyksXG5cdFx0aXNFcGhlbWVyYWw6IHR5cGVvZiB2YWx1ZS5pc0VwaGVtZXJhbCA9PT0gJ2Jvb2xlYW4nID8gdmFsdWUuaXNFcGhlbWVyYWwgOiBmYWxzZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlOiBvYmplY3QpOiB2YWx1ZSBpcyBFZGl0b3JTdGF0ZSB7XG5cdHJldHVybiAndGV4dCcgaW4gdmFsdWUgJiYgJ3NlbGVjdGlvblN0YXJ0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uRW5kJyBpbiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG5cdHJldHVybiAhIXZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCc7XG59XG5cbmZ1bmN0aW9uIGNsYW1wU2VsZWN0aW9uKHZhbHVlOiBudW1iZXIsIG1heDogbnVtYmVyKSB7XG5cdHJldHVybiBNYXRoLm1heCgwLCBNYXRoLm1pbih2YWx1ZSwgbWF4KSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhZ2VJZCgpIHtcblx0aWYgKHR5cGVvZiBjcnlwdG8gIT09ICd1bmRlZmluZWQnICYmIHR5cGVvZiBjcnlwdG8ucmFuZG9tVVVJRCA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHR9XG5cblx0cmV0dXJuIGBwYWdlLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfS0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUZhbGxiYWNrUGFnZUlkKGluZGV4OiBudW1iZXIpIHtcblx0cmV0dXJuIGBwYWdlLSR7aW5kZXggKyAxfWA7XG59XG5cbmZ1bmN0aW9uIHJlYWRUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbn1cblxuZnVuY3Rpb24gcmVhZE51bGxhYmxlVGltZXN0YW1wKC4uLnZhbHVlczogdW5rbm93bltdKSB7XG5cdGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3luY1N0YXR1cyh2YWx1ZTogdW5rbm93bik6IFBhZ2VTeW5jU3RhdHVzIHtcblx0cmV0dXJuIHZhbHVlID09PSAnc3luY2VkJyB8fCB2YWx1ZSA9PT0gJ3BlbmRpbmdfcHVzaCcgfHwgdmFsdWUgPT09ICdjb25mbGljdCcgPyB2YWx1ZSA6ICdkaXJ0eSc7XG59XG5cbmZ1bmN0aW9uIG5leHREaXJ0eVN0YXR1cyhzdGF0dXM6IFBhZ2VTeW5jU3RhdHVzKTogUGFnZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gc3RhdHVzID09PSAnY29uZmxpY3QnID8gJ2NvbmZsaWN0JyA6ICdkaXJ0eSc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzb3J0UGFnZXNCeVJlY2VuY3kocGFnZXM6IEVkaXRvclBhZ2VbXSkge1xuXHRyZXR1cm4gWy4uLnBhZ2VzXS5zb3J0KGNvbXBhcmVQYWdlc0J5UmVjZW5jeSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlUGFnZXNCeVJlY2VuY3kobGVmdDogRWRpdG9yUGFnZSwgcmlnaHQ6IEVkaXRvclBhZ2UpIHtcblx0aWYgKGxlZnQudXBkYXRlZEF0ICE9PSByaWdodC51cGRhdGVkQXQpIHtcblx0XHRyZXR1cm4gcmlnaHQudXBkYXRlZEF0LmxvY2FsZUNvbXBhcmUobGVmdC51cGRhdGVkQXQpO1xuXHR9XG5cblx0aWYgKGxlZnQuY3JlYXRlZEF0ICE9PSByaWdodC5jcmVhdGVkQXQpIHtcblx0XHRyZXR1cm4gcmlnaHQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUobGVmdC5jcmVhdGVkQXQpO1xuXHR9XG5cblx0cmV0dXJuIGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdodC5pZCk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBTdXBhYmFzZUNsaWVudCB9IGZyb20gJ0BzdXBhYmFzZS9zdXBhYmFzZS1qcyc7XG5pbXBvcnQge1xuXHRjcmVhdGVQYWdlLFxuXHRlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UsXG5cdHR5cGUgRWRpdG9yUGFnZSxcblx0dHlwZSBFZGl0b3JTZXNzaW9uXG59IGZyb20gJy4vY29yZS9zZXNzaW9uJztcblxuY29uc3QgUkVNT1RFX1BBR0VfQ09MVU1OUyA9ICdpZCx1c2VyX2lkLHRpdGxlLGNvbnRlbnQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0LGRlbGV0ZWRfYXQnO1xuXG5pbnRlcmZhY2UgUmVtb3RlUGFnZVJvdyB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkX2F0OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ6IHN0cmluZztcblx0ZGVsZXRlZF9hdDogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFJlbW90ZVVzZXJTZXR0aW5nc1JvdyB7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0YWN0aXZlX3BhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY1J1blJlc3VsdCB7XG5cdHNlc3Npb246IEVkaXRvclNlc3Npb247XG5cdHB1c2hlZENvdW50OiBudW1iZXI7XG5cdHB1bGxlZENvdW50OiBudW1iZXI7XG5cdGNvbmZsaWN0Q291bnQ6IG51bWJlcjtcbn1cblxubGV0IHN5bmNJblByb2dyZXNzID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNJblByb2dyZXNzKCkge1xuXHRyZXR1cm4gc3luY0luUHJvZ3Jlc3M7XG59XG5cbi8vIE9uZSBtYW51YWwgc3luYyBwYXNzIHdvcmtzIGFnYWluc3Qgb25lIHJlbW90ZSBzbmFwc2hvdC5cbi8vIFdlIHB1bGwgb25jZSwgZGVjaWRlIGV2ZXJ5dGhpbmcgYWdhaW5zdCB0aGF0IHNuYXBzaG90LCB0cnVzdCB3cml0ZSByZXNwb25zZXMsXG4vLyBhbmQgb25seSB0aGVuIGJ1aWxkIHRoZSBuZXh0IGxvY2FsIHNlc3Npb24uXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3luY1VzZXJQYWdlcyhcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZyxcblx0bG9jYWxTZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRub3cgPSBuZXcgRGF0ZSgpXG4pOiBQcm9taXNlPFN5bmNSdW5SZXN1bHQ+IHtcblx0aWYgKHN5bmNJblByb2dyZXNzKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdTeW5jIGFscmVhZHkgaW4gcHJvZ3Jlc3MuJyk7XG5cdH1cblxuXHRzeW5jSW5Qcm9ncmVzcyA9IHRydWU7XG5cblx0dHJ5IHtcblx0XHRjb25zdCByZW1vdGVTbmFwc2hvdCA9IGF3YWl0IHB1bGxSZW1vdGVTbmFwc2hvdChzdXBhYmFzZSwgdXNlcklkKTtcblx0XHRjb25zdCByZW1vdGVCeUlkID0gbmV3IE1hcChyZW1vdGVTbmFwc2hvdC5tYXAoKHBhZ2UpID0+IFtwYWdlLmlkLCBwYWdlXSkpO1xuXHRcdGNvbnN0IHByb2Nlc3NlZFJlbW90ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdGNvbnN0IG5leHRQYWdlczogRWRpdG9yUGFnZVtdID0gW107XG5cdFx0bGV0IHB1c2hlZENvdW50ID0gMDtcblx0XHRsZXQgcHVsbGVkQ291bnQgPSAwO1xuXHRcdGxldCBjb25mbGljdENvdW50ID0gMDtcblx0XHRsZXQgbmV4dEFjdGl2ZVBhZ2VJZCA9IGxvY2FsU2Vzc2lvbi5hY3RpdmVQYWdlSWQ7XG5cblx0XHRmb3IgKGNvbnN0IGxvY2FsUGFnZSBvZiBzb3J0UGFnZXMobG9jYWxTZXNzaW9uLnBhZ2VzLmZpbHRlcigocGFnZSkgPT4gcGFnZS51c2VySWQgPT09IHVzZXJJZCkpKSB7XG5cdFx0XHRpZiAobG9jYWxQYWdlLmlzRXBoZW1lcmFsKSB7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKGxvY2FsUGFnZSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZW1vdGUgPSByZW1vdGVCeUlkLmdldChsb2NhbFBhZ2UuaWQpID8/IG51bGw7XG5cdFx0XHRpZiAoIXJlbW90ZSkge1xuXHRcdFx0XHRpZiAobG9jYWxQYWdlLmRlbGV0ZWRBdCAhPT0gbnVsbCkge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcHVzaGVkID0gYXdhaXQgcHVzaExvY2FsUGFnZShzdXBhYmFzZSwgdXNlcklkLCBsb2NhbFBhZ2UpO1xuXHRcdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShwdXNoZWQsIGxvY2FsUGFnZSkpO1xuXHRcdFx0XHRwdXNoZWRDb3VudCArPSAxO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0cHJvY2Vzc2VkUmVtb3RlSWRzLmFkZChyZW1vdGUuaWQpO1xuXHRcdFx0Y29uc3QgbG9jYWxDaGFuZ2VkID0gaGFzTG9jYWxDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZSk7XG5cdFx0XHRjb25zdCByZW1vdGVDaGFuZ2VkID0gaGFzUmVtb3RlQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2UsIHJlbW90ZSk7XG5cdFx0XHRjb25zdCBzYW1lU3RhdGUgPSBwYWdlU3RhdGVzTWF0Y2gobG9jYWxQYWdlLCByZW1vdGUpO1xuXG5cdFx0XHRpZiAoIWxvY2FsQ2hhbmdlZCAmJiAhcmVtb3RlQ2hhbmdlZCkge1xuXHRcdFx0XHRpZiAoc2hvdWxkS2VlcFJlbW90ZVBhZ2VMb2NhbGx5KHJlbW90ZSkpIHtcblx0XHRcdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIGxvY2FsUGFnZSkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc2FtZVN0YXRlKSB7XG5cdFx0XHRcdGlmIChzaG91bGRLZWVwUmVtb3RlUGFnZUxvY2FsbHkocmVtb3RlKSkge1xuXHRcdFx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChsb2NhbENoYW5nZWQgJiYgIXJlbW90ZUNoYW5nZWQpIHtcblx0XHRcdFx0Y29uc3QgcHVzaGVkID0gYXdhaXQgcHVzaExvY2FsUGFnZShzdXBhYmFzZSwgdXNlcklkLCBsb2NhbFBhZ2UpO1xuXHRcdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShwdXNoZWQsIGxvY2FsUGFnZSkpO1xuXHRcdFx0XHRwdXNoZWRDb3VudCArPSAxO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCFsb2NhbENoYW5nZWQgJiYgcmVtb3RlQ2hhbmdlZCkge1xuXHRcdFx0XHRpZiAoc2hvdWxkS2VlcFJlbW90ZVBhZ2VMb2NhbGx5KHJlbW90ZSkpIHtcblx0XHRcdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShyZW1vdGUsIGxvY2FsUGFnZSkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHB1bGxlZENvdW50ICs9IDE7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZW1vdGVQYWdlID0gdG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpO1xuXHRcdFx0Y29uZmxpY3RDb3VudCArPSAxO1xuXHRcdFx0aWYgKHNob3VsZEtlZXBSZW1vdGVQYWdlTG9jYWxseShyZW1vdGUpKSB7XG5cdFx0XHRcdG5leHRQYWdlcy5wdXNoKHJlbW90ZVBhZ2UpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBjb25mbGljdEZvcmsgPSBmb3JrQ29uZmxpY3RQYWdlKGxvY2FsUGFnZSwgbm93KTtcblx0XHRcdGNvbnN0IHB1c2hlZEZvcmsgPSBhd2FpdCBwdXNoTG9jYWxQYWdlKHN1cGFiYXNlLCB1c2VySWQsIGNvbmZsaWN0Rm9yayk7XG5cdFx0XHRjb25zdCBzeW5jZWRGb3JrID0gdG9TeW5jZWRMb2NhbFBhZ2UocHVzaGVkRm9yaywgY29uZmxpY3RGb3JrKTtcblx0XHRcdG5leHRQYWdlcy5wdXNoKHN5bmNlZEZvcmspO1xuXHRcdFx0cHVzaGVkQ291bnQgKz0gMTtcblxuXHRcdFx0aWYgKGxvY2FsU2Vzc2lvbi5hY3RpdmVQYWdlSWQgPT09IGxvY2FsUGFnZS5pZCAmJiByZW1vdGVQYWdlLmRlbGV0ZWRBdCAhPT0gbnVsbCkge1xuXHRcdFx0XHRuZXh0QWN0aXZlUGFnZUlkID0gc3luY2VkRm9yay5pZDtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IHJlbW90ZSBvZiByZW1vdGVTbmFwc2hvdCkge1xuXHRcdFx0aWYgKHByb2Nlc3NlZFJlbW90ZUlkcy5oYXMocmVtb3RlLmlkKSkge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCFzaG91bGRLZWVwUmVtb3RlUGFnZUxvY2FsbHkocmVtb3RlKSkge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBudWxsKSk7XG5cdFx0XHRwdWxsZWRDb3VudCArPSAxO1xuXHRcdH1cblxuXHRcdGNvbnN0IG5leHRTZXNzaW9uID0gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHtcblx0XHRcdHBhZ2VzOiBzb3J0UGFnZXMobmV4dFBhZ2VzKSxcblx0XHRcdGFjdGl2ZVBhZ2VJZDogbmV4dEFjdGl2ZVBhZ2VJZFxuXHRcdH0pO1xuXHRcdHJldHVybiB7XG5cdFx0XHRzZXNzaW9uOiBuZXh0U2Vzc2lvbixcblx0XHRcdHB1c2hlZENvdW50LFxuXHRcdFx0cHVsbGVkQ291bnQsXG5cdFx0XHRjb25mbGljdENvdW50XG5cdFx0fTtcblx0fSBmaW5hbGx5IHtcblx0XHRzeW5jSW5Qcm9ncmVzcyA9IGZhbHNlO1xuXHR9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFJlbW90ZUFjdGl2ZVBhZ2VJZChcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZ1xuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlXG5cdFx0LmZyb20oJ3VzZXJfc2V0dGluZ3MnKVxuXHRcdC5zZWxlY3QoJ2FjdGl2ZV9wYWdlX2lkLHVzZXJfaWQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0Jylcblx0XHQuZXEoJ3VzZXJfaWQnLCB1c2VySWQpXG5cdFx0Lm1heWJlU2luZ2xlKCk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gKChkYXRhIGFzIFJlbW90ZVVzZXJTZXR0aW5nc1JvdyB8IG51bGwpPy5hY3RpdmVfcGFnZV9pZCA/PyBudWxsKSBhcyBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ya0NvbmZsaWN0UGFnZShwYWdlOiBFZGl0b3JQYWdlLCBub3cgPSBuZXcgRGF0ZSgpKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHRpbWVzdGFtcCA9IG5vdy50b0lTT1N0cmluZygpO1xuXHRjb25zdCBmb3JrID0gY3JlYXRlUGFnZShwYWdlLmNvbnRlbnQsIHsgdXNlcklkOiBwYWdlLnVzZXJJZCwgbm93OiB0aW1lc3RhbXAsIGlzRXBoZW1lcmFsOiBmYWxzZSB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5mb3JrLFxuXHRcdHRpdGxlOiBgJHtwYWdlLnRpdGxlfSAke2J1aWxkQ29uZmxpY3RTdWZmaXgobm93KX1gLnRyaW0oKSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwYWdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZDogcGFnZS5zZWxlY3Rpb25FbmQsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eScsXG5cdFx0aXNFcGhlbWVyYWw6IGZhbHNlXG5cdH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHB1bGxSZW1vdGVTbmFwc2hvdChzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsIHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxSZW1vdGVQYWdlUm93W10+IHtcblx0Y29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2Vcblx0XHQuZnJvbSgncGFnZXMnKVxuXHRcdC5zZWxlY3QoUkVNT1RFX1BBR0VfQ09MVU1OUylcblx0XHQuZXEoJ3VzZXJfaWQnLCB1c2VySWQpXG5cdFx0Lm9yZGVyKCdjcmVhdGVkX2F0JywgeyBhc2NlbmRpbmc6IHRydWUgfSlcblx0XHQub3JkZXIoJ2lkJywgeyBhc2NlbmRpbmc6IHRydWUgfSk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gKGRhdGEgPz8gW10pIGFzIFJlbW90ZVBhZ2VSb3dbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVzaExvY2FsUGFnZShcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZyxcblx0bG9jYWxQYWdlOiBFZGl0b3JQYWdlXG4pOiBQcm9taXNlPFJlbW90ZVBhZ2VSb3c+IHtcblx0Y29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2Vcblx0XHQuZnJvbSgncGFnZXMnKVxuXHRcdC51cHNlcnQoXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBsb2NhbFBhZ2UuaWQsXG5cdFx0XHRcdHVzZXJfaWQ6IHVzZXJJZCxcblx0XHRcdFx0dGl0bGU6IGxvY2FsUGFnZS50aXRsZSxcblx0XHRcdFx0Y29udGVudDogbG9jYWxQYWdlLmNvbnRlbnQsXG5cdFx0XHRcdGNyZWF0ZWRfYXQ6IGxvY2FsUGFnZS5jcmVhdGVkQXQsXG5cdFx0XHRcdHVwZGF0ZWRfYXQ6IGxvY2FsUGFnZS51cGRhdGVkQXQsXG5cdFx0XHRcdGRlbGV0ZWRfYXQ6IGxvY2FsUGFnZS5kZWxldGVkQXRcblx0XHRcdH0sXG5cdFx0XHR7IG9uQ29uZmxpY3Q6ICdpZCcgfVxuXHRcdClcblx0XHQuc2VsZWN0KFJFTU9URV9QQUdFX0NPTFVNTlMpXG5cdFx0LnNpbmdsZSgpO1xuXG5cdGlmIChlcnJvcikge1xuXHRcdHRocm93IGVycm9yO1xuXHR9XG5cblx0cmV0dXJuIGRhdGEgYXMgUmVtb3RlUGFnZVJvdztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHB1c2hSZW1vdGVBY3RpdmVQYWdlSWQoc3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LCB1c2VySWQ6IHN0cmluZywgYWN0aXZlUGFnZUlkOiBzdHJpbmcpIHtcblx0Y29uc3QgeyBlcnJvciB9ID0gYXdhaXQgc3VwYWJhc2UuZnJvbSgndXNlcl9zZXR0aW5ncycpLnVwc2VydCh7XG5cdFx0dXNlcl9pZDogdXNlcklkLFxuXHRcdGFjdGl2ZV9wYWdlX2lkOiBhY3RpdmVQYWdlSWRcblx0fSk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cbn1cblxuZnVuY3Rpb24gdG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlOiBSZW1vdGVQYWdlUm93LCBsb2NhbFBhZ2U6IEVkaXRvclBhZ2UgfCBudWxsKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGJhc2UgPVxuXHRcdGxvY2FsUGFnZSA/P1xuXHRcdGNyZWF0ZVBhZ2UocmVtb3RlLmNvbnRlbnQsIHtcblx0XHRcdGlkOiByZW1vdGUuaWQsXG5cdFx0XHR1c2VySWQ6IHJlbW90ZS51c2VyX2lkLFxuXHRcdFx0bm93OiByZW1vdGUuY3JlYXRlZF9hdCxcblx0XHRcdGlzRXBoZW1lcmFsOiBmYWxzZVxuXHRcdH0pO1xuXG5cdHJldHVybiB7XG5cdFx0Li4uYmFzZSxcblx0XHRpZDogcmVtb3RlLmlkLFxuXHRcdHVzZXJJZDogcmVtb3RlLnVzZXJfaWQsXG5cdFx0dGl0bGU6IHJlbW90ZS50aXRsZSxcblx0XHRjb250ZW50OiByZW1vdGUuY29udGVudCxcblx0XHR0ZXh0OiByZW1vdGUuY29udGVudCxcblx0XHRjcmVhdGVkQXQ6IHJlbW90ZS5jcmVhdGVkX2F0LFxuXHRcdHVwZGF0ZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0ZGVsZXRlZEF0OiByZW1vdGUuZGVsZXRlZF9hdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlbW90ZS51cGRhdGVkX2F0LFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZW1vdGUuZGVsZXRlZF9hdCxcblx0XHRzeW5jU3RhdHVzOiAnc3luY2VkJyxcblx0XHRpc0VwaGVtZXJhbDogZmFsc2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gaGFzTG9jYWxDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZTogRWRpdG9yUGFnZSkge1xuXHRpZiAobG9jYWxQYWdlLmxhc3RTeW5jZWRBdCA9PT0gbnVsbCkge1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGxhdGVzdExvY2FsTXV0YXRpb25BdChsb2NhbFBhZ2UpID4gbG9jYWxQYWdlLmxhc3RTeW5jZWRBdDtcbn1cblxuZnVuY3Rpb24gaGFzUmVtb3RlQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2U6IEVkaXRvclBhZ2UsIHJlbW90ZTogUmVtb3RlUGFnZVJvdykge1xuXHRpZiAobG9jYWxQYWdlLmxhc3RTeW5jZWRBdCA9PT0gbnVsbCkge1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGxhdGVzdFJlbW90ZU11dGF0aW9uQXQocmVtb3RlKSA+IGxvY2FsUGFnZS5sYXN0U3luY2VkQXQ7XG59XG5cbmZ1bmN0aW9uIGxhdGVzdExvY2FsTXV0YXRpb25BdChsb2NhbFBhZ2U6IEVkaXRvclBhZ2UpIHtcblx0cmV0dXJuIGxvY2FsUGFnZS5kZWxldGVkQXQgJiYgbG9jYWxQYWdlLmRlbGV0ZWRBdCA+IGxvY2FsUGFnZS51cGRhdGVkQXRcblx0XHQ/IGxvY2FsUGFnZS5kZWxldGVkQXRcblx0XHQ6IGxvY2FsUGFnZS51cGRhdGVkQXQ7XG59XG5cbmZ1bmN0aW9uIGxhdGVzdFJlbW90ZU11dGF0aW9uQXQocmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdHJldHVybiByZW1vdGUuZGVsZXRlZF9hdCAmJiByZW1vdGUuZGVsZXRlZF9hdCA+IHJlbW90ZS51cGRhdGVkX2F0ID8gcmVtb3RlLmRlbGV0ZWRfYXQgOiByZW1vdGUudXBkYXRlZF9hdDtcbn1cblxuZnVuY3Rpb24gcGFnZVN0YXRlc01hdGNoKGxvY2FsUGFnZTogRWRpdG9yUGFnZSwgcmVtb3RlOiBSZW1vdGVQYWdlUm93KSB7XG5cdHJldHVybiAoXG5cdFx0bG9jYWxQYWdlLnRpdGxlID09PSByZW1vdGUudGl0bGUgJiZcblx0XHRsb2NhbFBhZ2UuY29udGVudCA9PT0gcmVtb3RlLmNvbnRlbnQgJiZcblx0XHQobG9jYWxQYWdlLmRlbGV0ZWRBdCA/PyBudWxsKSA9PT0gKHJlbW90ZS5kZWxldGVkX2F0ID8/IG51bGwpXG5cdCk7XG59XG5cbmZ1bmN0aW9uIHNob3VsZEtlZXBSZW1vdGVQYWdlTG9jYWxseShyZW1vdGU6IFJlbW90ZVBhZ2VSb3cpIHtcblx0cmV0dXJuIHJlbW90ZS5kZWxldGVkX2F0ID09PSBudWxsO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbmZsaWN0U3VmZml4KG5vdzogRGF0ZSkge1xuXHRjb25zdCBsYWJlbCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KHVuZGVmaW5lZCwge1xuXHRcdGRhdGVTdHlsZTogJ21lZGl1bScsXG5cdFx0dGltZVN0eWxlOiAnc2hvcnQnXG5cdH0pLmZvcm1hdChub3cpO1xuXG5cdHJldHVybiBgKExvY2FsIGNvbmZsaWN0ICR7bGFiZWx9KWA7XG59XG5cbmZ1bmN0aW9uIHNvcnRQYWdlcyhwYWdlczogRWRpdG9yUGFnZVtdKSB7XG5cdHJldHVybiBbLi4ucGFnZXNdLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiB7XG5cdFx0aWYgKGxlZnQudXBkYXRlZEF0ICE9PSByaWdodC51cGRhdGVkQXQpIHtcblx0XHRcdHJldHVybiByaWdodC51cGRhdGVkQXQubG9jYWxlQ29tcGFyZShsZWZ0LnVwZGF0ZWRBdCk7XG5cdFx0fVxuXG5cdFx0aWYgKGxlZnQuY3JlYXRlZEF0ICE9PSByaWdodC5jcmVhdGVkQXQpIHtcblx0XHRcdHJldHVybiByaWdodC5jcmVhdGVkQXQubG9jYWxlQ29tcGFyZShsZWZ0LmNyZWF0ZWRBdCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdodC5pZCk7XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ01aLElBQU0sbUJBQW1COzs7QUNPekIsSUFBTSxnQkFBZ0I7QUFFdEIsU0FBUyxnQkFBZ0IsU0FBeUI7QUFDeEQsUUFBTSxZQUFZLFFBQ2hCLE1BQU0sSUFBSSxFQUNWLElBQUksQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLEVBQ3pCLEtBQUssQ0FBQyxTQUFTLEtBQUssU0FBUyxDQUFDO0FBRWhDLE1BQUksQ0FBQyxXQUFXO0FBQ2YsV0FBTztBQUFBLEVB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
