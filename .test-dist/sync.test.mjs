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
function createPageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `note-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

// src/lib/editor/sync.ts
var REMOTE_NOTE_COLUMNS = "id,user_id,title,content,created_at,updated_at,deleted_at";
async function syncUserNotes(supabase, userId, localSession, now = /* @__PURE__ */ new Date()) {
  const remoteSnapshot = await pullRemoteSnapshot(supabase, userId);
  const remoteById = new Map(remoteSnapshot.map((note) => [note.id, note]));
  const processedRemoteIds = /* @__PURE__ */ new Set();
  const nextPages = [];
  let pushedCount = 0;
  let pulledCount = 0;
  let conflictCount = 0;
  let nextActivePageId = localSession.activePageId;
  for (const localPage of sortPages(localSession.pages.filter((page) => page.userId === userId))) {
    const remote = remoteById.get(localPage.id) ?? null;
    if (!remote) {
      const pushed = await pushLocalNote(supabase, userId, localPage);
      nextPages.push(toSyncedLocalPage(pushed, localPage));
      pushedCount += 1;
      continue;
    }
    processedRemoteIds.add(remote.id);
    const localChanged = hasLocalChangedSinceSync(localPage);
    const remoteChanged = hasRemoteChangedSinceSync(localPage, remote);
    const sameState = noteStatesMatch(localPage, remote);
    if (!localChanged && !remoteChanged) {
      nextPages.push(toSyncedLocalPage(remote, localPage));
      continue;
    }
    if (sameState) {
      nextPages.push(toSyncedLocalPage(remote, localPage));
      continue;
    }
    if (localChanged && !remoteChanged) {
      const pushed = await pushLocalNote(supabase, userId, localPage);
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
    const conflictFork = forkConflictNote(localPage, now);
    const pushedFork = await pushLocalNote(supabase, userId, conflictFork);
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
  return {
    session: ensureValidActivePage({
      pages: sortPages(nextPages),
      activePageId: nextActivePageId
    }),
    pushedCount,
    pulledCount,
    conflictCount
  };
}
function forkConflictNote(page, now = /* @__PURE__ */ new Date()) {
  const timestamp = now.toISOString();
  const fork = createPage(page.content, { userId: page.userId, now: timestamp });
  return {
    ...fork,
    title: `${page.title} ${buildConflictSuffix(now)}`.trim(),
    content: page.content,
    text: page.content,
    selectionStart: page.selectionStart,
    selectionEnd: page.selectionEnd,
    deletedAt: null,
    syncStatus: "dirty"
  };
}
async function pullRemoteSnapshot(supabase, userId) {
  const { data, error } = await supabase.from("notes").select(REMOTE_NOTE_COLUMNS).eq("user_id", userId).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) {
    throw error;
  }
  return data ?? [];
}
async function pushLocalNote(supabase, userId, localPage) {
  const { data, error } = await supabase.from("notes").upsert(
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
  ).select(REMOTE_NOTE_COLUMNS).single();
  if (error) {
    throw error;
  }
  return data;
}
function toSyncedLocalPage(remote, localPage) {
  const base = localPage ?? createPage(remote.content, {
    id: remote.id,
    userId: remote.user_id,
    now: remote.created_at
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
    syncStatus: "synced"
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
function noteStatesMatch(localPage, remote) {
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

// tests/sync.test.ts
var FakeSupabase = class {
  notes = /* @__PURE__ */ new Map();
  constructor(rows = []) {
    for (const row of rows) {
      this.notes.set(row.id, { ...row });
    }
  }
  from(table) {
    assert.equal(table, "notes");
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
            const rows = [...api.notes.values()].filter((row) => row.user_id === userId);
            return Promise.resolve(resolve({ data: rows, error: null }));
          }
        };
      },
      upsert(payload) {
        api.notes.set(payload.id, { ...payload });
        return {
          select() {
            return {
              async single() {
                return { data: api.notes.get(payload.id) ?? null, error: null };
              }
            };
          }
        };
      }
    };
  }
  getRows(userId) {
    return [...this.notes.values()].filter((row) => row.user_id === userId);
  }
};
function buildSession(page, activePageId = page.id) {
  return {
    pages: [page],
    activePageId
  };
}
test("forkConflictNote creates a visible local fork with a new id and suffix", () => {
  const source = createPage("body", { id: "note-1", userId: "user-a", now: "2026-04-17T18:00:00.000Z" });
  source.title = "My Note";
  source.deletedAt = "2026-04-17T18:05:00.000Z";
  const fork = forkConflictNote(source, /* @__PURE__ */ new Date("2026-04-17T18:10:00.000Z"));
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.userId, "user-a");
  assert.equal(fork.deletedAt, null);
  assert.equal(fork.syncStatus, "dirty");
  assert.match(fork.title, /^My Note \(Local conflict /);
});
test("syncUserNotes pushes local-only dirty notes and trusts the write response", async () => {
  const local = createPage("local body", { id: "local-1", userId: "user-a", now: "2026-04-17T18:00:00.000Z" });
  local.title = "Local";
  local.updatedAt = "2026-04-17T18:01:00.000Z";
  const supabase = new FakeSupabase();
  const result = await syncUserNotes(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:02:00.000Z"));
  assert.equal(result.pushedCount, 1);
  assert.equal(result.conflictCount, 0);
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.equal(result.session.pages[0]?.lastSyncedAt, "2026-04-17T18:01:00.000Z");
  assert.equal(supabase.getRows("user-a").length, 1);
  assert.equal(supabase.getRows("user-a")[0]?.id, "local-1");
});
test("syncUserNotes pulls remote-only notes into the local session", async () => {
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
  const result = await syncUserNotes(supabase, "user-a", emptyLocal, /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.pulledCount, 1);
  assert.equal(result.session.pages.length, 1);
  assert.equal(result.session.pages[0]?.id, "remote-1");
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.equal(result.session.pages[0]?.lastSyncedAt, "2026-04-17T18:00:00.000Z");
});
test("syncUserNotes forks when local and remote both changed", async () => {
  const local = createPage("local edit", { id: "note-1", userId: "user-a", now: "2026-04-17T18:00:00.000Z" });
  local.title = "Shared";
  local.updatedAt = "2026-04-17T18:03:00.000Z";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.syncStatus = "dirty";
  const supabase = new FakeSupabase([
    {
      id: "note-1",
      user_id: "user-a",
      title: "Shared",
      content: "remote edit",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: null
    }
  ]);
  const result = await syncUserNotes(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.conflictCount, 1);
  assert.equal(result.pushedCount, 1);
  assert.equal(result.session.pages.length, 2);
  assert.equal(result.session.pages[0]?.id, "note-1");
  assert.equal(result.session.pages[0]?.content, "remote edit");
  assert.equal(result.session.pages[0]?.syncStatus, "synced");
  assert.notEqual(result.session.pages[1]?.id, "note-1");
  assert.match(result.session.pages[1]?.title ?? "", /^Shared \(Local conflict /);
  assert.equal(result.session.pages[1]?.content, "local edit");
  assert.equal(result.session.pages[1]?.syncStatus, "synced");
  assert.equal(result.session.pages[1]?.lastSyncedAt, result.session.pages[1]?.updatedAt);
  assert.equal(supabase.getRows("user-a").length, 2);
  assert.equal(supabase.getRows("user-a").some((row) => row.content === "local edit"), true);
});
test("syncUserNotes handles remote delete versus local edit by forking the local edit", async () => {
  const local = createPage("keep me", { id: "note-1", userId: "user-a", now: "2026-04-17T18:00:00.000Z" });
  local.title = "Conflict";
  local.updatedAt = "2026-04-17T18:03:00.000Z";
  local.lastSyncedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteUpdatedAt = "2026-04-17T18:01:00.000Z";
  local.lastKnownRemoteDeletedAt = null;
  local.syncStatus = "dirty";
  const supabase = new FakeSupabase([
    {
      id: "note-1",
      user_id: "user-a",
      title: "Conflict",
      content: "keep me",
      created_at: "2026-04-17T18:00:00.000Z",
      updated_at: "2026-04-17T18:04:00.000Z",
      deleted_at: "2026-04-17T18:04:00.000Z"
    }
  ]);
  const result = await syncUserNotes(supabase, "user-a", buildSession(local), /* @__PURE__ */ new Date("2026-04-17T18:05:00.000Z"));
  assert.equal(result.conflictCount, 1);
  assert.equal(result.session.pages.length, 2);
  assert.equal(result.session.pages[0]?.deletedAt, "2026-04-17T18:04:00.000Z");
  assert.equal(result.session.pages[1]?.deletedAt, null);
  assert.match(result.session.pages[1]?.title ?? "", /^Conflict \(Local conflict /);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc3luYy50ZXN0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCB0eXBlIEVkaXRvclNlc3Npb24gfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMnO1xuaW1wb3J0IHsgZm9ya0NvbmZsaWN0Tm90ZSwgc3luY1VzZXJOb3RlcyB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3N5bmMudHMnO1xuaW1wb3J0IHR5cGUgeyBOb3RlU3luY1N0YXR1cyB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BlcnNpc3RlbmNlL3JlY29yZHMudHMnO1xuXG50eXBlIFJlbW90ZVJvdyA9IHtcblx0aWQ6IHN0cmluZztcblx0dXNlcl9pZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRfYXQ6IHN0cmluZztcblx0dXBkYXRlZF9hdDogc3RyaW5nO1xuXHRkZWxldGVkX2F0OiBzdHJpbmcgfCBudWxsO1xufTtcblxuY2xhc3MgRmFrZVN1cGFiYXNlIHtcblx0cHJpdmF0ZSBub3RlcyA9IG5ldyBNYXA8c3RyaW5nLCBSZW1vdGVSb3c+KCk7XG5cblx0Y29uc3RydWN0b3Iocm93czogUmVtb3RlUm93W10gPSBbXSkge1xuXHRcdGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcblx0XHRcdHRoaXMubm90ZXMuc2V0KHJvdy5pZCwgeyAuLi5yb3cgfSk7XG5cdFx0fVxuXHR9XG5cblx0ZnJvbSh0YWJsZTogc3RyaW5nKSB7XG5cdFx0YXNzZXJ0LmVxdWFsKHRhYmxlLCAnbm90ZXMnKTtcblx0XHRjb25zdCBhcGkgPSB0aGlzO1xuXHRcdHJldHVybiB7XG5cdFx0XHRzZWxlY3QoKSB7XG5cdFx0XHRcdGxldCB1c2VySWQgPSAnJztcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRlcShjb2x1bW46IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuXHRcdFx0XHRcdFx0YXNzZXJ0LmVxdWFsKGNvbHVtbiwgJ3VzZXJfaWQnKTtcblx0XHRcdFx0XHRcdHVzZXJJZCA9IHZhbHVlO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHRoaXM7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvcmRlcigpIHtcblx0XHRcdFx0XHRcdHJldHVybiB0aGlzO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0dGhlbihyZXNvbHZlOiAodmFsdWU6IHVua25vd24pID0+IHVua25vd24pIHtcblx0XHRcdFx0XHRcdGNvbnN0IHJvd3MgPSBbLi4uYXBpLm5vdGVzLnZhbHVlcygpXS5maWx0ZXIoKHJvdykgPT4gcm93LnVzZXJfaWQgPT09IHVzZXJJZCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc29sdmUoeyBkYXRhOiByb3dzLCBlcnJvcjogbnVsbCB9KSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0fSxcblx0XHRcdHVwc2VydChwYXlsb2FkOiBSZW1vdGVSb3cpIHtcblx0XHRcdFx0YXBpLm5vdGVzLnNldChwYXlsb2FkLmlkLCB7IC4uLnBheWxvYWQgfSk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0c2VsZWN0KCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0YXN5bmMgc2luZ2xlKCkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7IGRhdGE6IGFwaS5ub3Rlcy5nZXQocGF5bG9hZC5pZCkgPz8gbnVsbCwgZXJyb3I6IG51bGwgfTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fTtcblx0fVxuXG5cdGdldFJvd3ModXNlcklkOiBzdHJpbmcpIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMubm90ZXMudmFsdWVzKCldLmZpbHRlcigocm93KSA9PiByb3cudXNlcl9pZCA9PT0gdXNlcklkKTtcblx0fVxufVxuXG5mdW5jdGlvbiBidWlsZFNlc3Npb24ocGFnZTogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlUGFnZT4sIGFjdGl2ZVBhZ2VJZCA9IHBhZ2UuaWQpOiBFZGl0b3JTZXNzaW9uIHtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZFxuXHR9O1xufVxuXG50ZXN0KCdmb3JrQ29uZmxpY3ROb3RlIGNyZWF0ZXMgYSB2aXNpYmxlIGxvY2FsIGZvcmsgd2l0aCBhIG5ldyBpZCBhbmQgc3VmZml4JywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSBjcmVhdGVQYWdlKCdib2R5JywgeyBpZDogJ25vdGUtMScsIHVzZXJJZDogJ3VzZXItYScsIG5vdzogJzIwMjYtMDQtMTdUMTg6MDA6MDAuMDAwWicgfSk7XG5cdHNvdXJjZS50aXRsZSA9ICdNeSBOb3RlJztcblx0c291cmNlLmRlbGV0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjA1OjAwLjAwMFonO1xuXG5cdGNvbnN0IGZvcmsgPSBmb3JrQ29uZmxpY3ROb3RlKHNvdXJjZSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MTA6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQubm90RXF1YWwoZm9yay5pZCwgc291cmNlLmlkKTtcblx0YXNzZXJ0LmVxdWFsKGZvcmsudXNlcklkLCAndXNlci1hJyk7XG5cdGFzc2VydC5lcXVhbChmb3JrLmRlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5lcXVhbChmb3JrLnN5bmNTdGF0dXMsICdkaXJ0eScpO1xuXHRhc3NlcnQubWF0Y2goZm9yay50aXRsZSwgL15NeSBOb3RlIFxcKExvY2FsIGNvbmZsaWN0IC8pO1xufSk7XG5cbnRlc3QoJ3N5bmNVc2VyTm90ZXMgcHVzaGVzIGxvY2FsLW9ubHkgZGlydHkgbm90ZXMgYW5kIHRydXN0cyB0aGUgd3JpdGUgcmVzcG9uc2UnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgYm9keScsIHsgaWQ6ICdsb2NhbC0xJywgdXNlcklkOiAndXNlci1hJywgbm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyB9KTtcblx0bG9jYWwudGl0bGUgPSAnTG9jYWwnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMTowMC4wMDBaJztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc3luY1VzZXJOb3RlcyhzdXBhYmFzZSBhcyBuZXZlciwgJ3VzZXItYScsIGJ1aWxkU2Vzc2lvbihsb2NhbCksIG5ldyBEYXRlKCcyMDI2LTA0LTE3VDE4OjAyOjAwLjAwMFonKSk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWRDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uc3luY1N0YXR1cywgJ3N5bmNlZCcpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/Lmxhc3RTeW5jZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwoc3VwYWJhc2UuZ2V0Um93cygndXNlci1hJykubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpWzBdPy5pZCwgJ2xvY2FsLTEnKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlck5vdGVzIHB1bGxzIHJlbW90ZS1vbmx5IG5vdGVzIGludG8gdGhlIGxvY2FsIHNlc3Npb24nLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHN1cGFiYXNlID0gbmV3IEZha2VTdXBhYmFzZShbXG5cdFx0e1xuXHRcdFx0aWQ6ICdyZW1vdGUtMScsXG5cdFx0XHR1c2VyX2lkOiAndXNlci1hJyxcblx0XHRcdHRpdGxlOiAnUmVtb3RlJyxcblx0XHRcdGNvbnRlbnQ6ICdyZW1vdGUgYm9keScsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogbnVsbFxuXHRcdH1cblx0XSk7XG5cdGNvbnN0IGVtcHR5TG9jYWw6IEVkaXRvclNlc3Npb24gPSB7IHBhZ2VzOiBbXSwgYWN0aXZlUGFnZUlkOiAnbWlzc2luZycgfTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlck5vdGVzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgZW1wdHlMb2NhbCwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1bGxlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdyZW1vdGUtMScpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LnN5bmNTdGF0dXMsICdzeW5jZWQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5sYXN0U3luY2VkQXQsICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlck5vdGVzIGZvcmtzIHdoZW4gbG9jYWwgYW5kIHJlbW90ZSBib3RoIGNoYW5nZWQnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IGxvY2FsID0gY3JlYXRlUGFnZSgnbG9jYWwgZWRpdCcsIHsgaWQ6ICdub3RlLTEnLCB1c2VySWQ6ICd1c2VyLWEnLCBub3c6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonIH0pO1xuXHRsb2NhbC50aXRsZSA9ICdTaGFyZWQnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMzowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBOb3RlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW1xuXHRcdHtcblx0XHRcdGlkOiAnbm90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdTaGFyZWQnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBlZGl0Jyxcblx0XHRcdGNyZWF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjAwOjAwLjAwMFonLFxuXHRcdFx0dXBkYXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicsXG5cdFx0XHRkZWxldGVkX2F0OiBudWxsXG5cdFx0fVxuXHRdKTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBzeW5jVXNlck5vdGVzKHN1cGFiYXNlIGFzIG5ldmVyLCAndXNlci1hJywgYnVpbGRTZXNzaW9uKGxvY2FsKSwgbmV3IERhdGUoJzIwMjYtMDQtMTdUMTg6MDU6MDAuMDAwWicpKTtcblxuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmNvbmZsaWN0Q291bnQsIDEpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnB1c2hlZENvdW50LCAxKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1swXT8uaWQsICdub3RlLTEnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5jb250ZW50LCAncmVtb3RlIGVkaXQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzBdPy5zeW5jU3RhdHVzLCAnc3luY2VkJyk7XG5cdGFzc2VydC5ub3RFcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uaWQsICdub3RlLTEnKTtcblx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy50aXRsZSA/PyAnJywgL15TaGFyZWQgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8uY29udGVudCwgJ2xvY2FsIGVkaXQnKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uLnBhZ2VzWzFdPy5zeW5jU3RhdHVzLCAnc3luY2VkJyk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8ubGFzdFN5bmNlZEF0LCByZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8udXBkYXRlZEF0KTtcblx0YXNzZXJ0LmVxdWFsKHN1cGFiYXNlLmdldFJvd3MoJ3VzZXItYScpLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChzdXBhYmFzZS5nZXRSb3dzKCd1c2VyLWEnKS5zb21lKChyb3cpID0+IHJvdy5jb250ZW50ID09PSAnbG9jYWwgZWRpdCcpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdzeW5jVXNlck5vdGVzIGhhbmRsZXMgcmVtb3RlIGRlbGV0ZSB2ZXJzdXMgbG9jYWwgZWRpdCBieSBmb3JraW5nIHRoZSBsb2NhbCBlZGl0JywgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBsb2NhbCA9IGNyZWF0ZVBhZ2UoJ2tlZXAgbWUnLCB7IGlkOiAnbm90ZS0xJywgdXNlcklkOiAndXNlci1hJywgbm93OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyB9KTtcblx0bG9jYWwudGl0bGUgPSAnQ29uZmxpY3QnO1xuXHRsb2NhbC51cGRhdGVkQXQgPSAnMjAyNi0wNC0xN1QxODowMzowMC4wMDBaJztcblx0bG9jYWwubGFzdFN5bmNlZEF0ID0gJzIwMjYtMDQtMTdUMTg6MDE6MDAuMDAwWic7XG5cdGxvY2FsLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCA9ICcyMDI2LTA0LTE3VDE4OjAxOjAwLjAwMFonO1xuXHRsb2NhbC5sYXN0S25vd25SZW1vdGVEZWxldGVkQXQgPSBudWxsO1xuXHRsb2NhbC5zeW5jU3RhdHVzID0gJ2RpcnR5JyBhcyBOb3RlU3luY1N0YXR1cztcblxuXHRjb25zdCBzdXBhYmFzZSA9IG5ldyBGYWtlU3VwYWJhc2UoW1xuXHRcdHtcblx0XHRcdGlkOiAnbm90ZS0xJyxcblx0XHRcdHVzZXJfaWQ6ICd1c2VyLWEnLFxuXHRcdFx0dGl0bGU6ICdDb25mbGljdCcsXG5cdFx0XHRjb250ZW50OiAna2VlcCBtZScsXG5cdFx0XHRjcmVhdGVkX2F0OiAnMjAyNi0wNC0xN1QxODowMDowMC4wMDBaJyxcblx0XHRcdHVwZGF0ZWRfYXQ6ICcyMDI2LTA0LTE3VDE4OjA0OjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZF9hdDogJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWidcblx0XHR9XG5cdF0pO1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN5bmNVc2VyTm90ZXMoc3VwYWJhc2UgYXMgbmV2ZXIsICd1c2VyLWEnLCBidWlsZFNlc3Npb24obG9jYWwpLCBuZXcgRGF0ZSgnMjAyNi0wNC0xN1QxODowNTowMC4wMDBaJykpO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RDb3VudCwgMSk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQuc2Vzc2lvbi5wYWdlcy5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMF0/LmRlbGV0ZWRBdCwgJzIwMjYtMDQtMTdUMTg6MDQ6MDAuMDAwWicpO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb24ucGFnZXNbMV0/LmRlbGV0ZWRBdCwgbnVsbCk7XG5cdGFzc2VydC5tYXRjaChyZXN1bHQuc2Vzc2lvbi5wYWdlc1sxXT8udGl0bGUgPz8gJycsIC9eQ29uZmxpY3QgXFwoTG9jYWwgY29uZmxpY3QgLyk7XG59KTtcbiIsICJleHBvcnQgY29uc3QgQkxBTktfREJfTkFNRSA9ICdibGFuayc7XG5leHBvcnQgY29uc3QgQkxBTktfREJfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgTk9URVNfU1RPUkVfTkFNRSA9ICdub3Rlcyc7XG5leHBvcnQgY29uc3QgU0VUVElOR1NfU1RPUkVfTkFNRSA9ICdzZXR0aW5ncyc7XG5leHBvcnQgY29uc3QgVVNFUl9JRF9JTkRFWCA9ICd1c2VySWQnO1xuXG5leHBvcnQgY29uc3QgQU5PTllNT1VTX1VTRVJJRCA9ICdhbm9ueW1vdXMnO1xuXG5leHBvcnQgdHlwZSBOb3RlU3luY1N0YXR1cyA9ICdzeW5jZWQnIHwgJ2RpcnR5JyB8ICdwZW5kaW5nX3B1c2gnIHwgJ2NvbmZsaWN0JztcblxuZXhwb3J0IGludGVyZmFjZSBOb3RlUmVjb3JkIHtcblx0aWQ6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdHN5bmNTdGF0dXM6IE5vdGVTeW5jU3RhdHVzO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdSZWNvcmQge1xuXHRrZXk6IHN0cmluZztcblx0dXNlcklkOiBzdHJpbmcgfCBudWxsO1xuXHR2YWx1ZTogdW5rbm93bjtcblx0dXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBTRVRUSU5HX0FDVElWRV9QQUdFX0lEID0gJ2FjdGl2ZVBhZ2VJZCc7XG5leHBvcnQgY29uc3QgU0VUVElOR19USEVNRSA9ICd0aGVtZSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19XT1JEX0NPVU5UX1ZJU0lCSUxJVFkgPSAnd29yZENvdW50VmlzaWJpbGl0eSc7XG5leHBvcnQgY29uc3QgU0VUVElOR19TUEVMTENIRUNLX0VOQUJMRUQgPSAnc3BlbGxjaGVja0VuYWJsZWQnO1xuZXhwb3J0IGNvbnN0IFNFVFRJTkdfSEFTX1BST01QVEVEX0ZPUl9BTk9OWU1PVVNfSU1QT1JUID0gJ2hhc1Byb21wdGVkRm9yQW5vbnltb3VzSW1wb3J0JztcbiIsICJpbXBvcnQgdHlwZSB7IEVkaXRvclN0YXRlIH0gZnJvbSAnLi4vYmFzaWMvaGlzdG9yeSc7XG5pbXBvcnQge1xuXHRBTk9OWU1PVVNfVVNFUklELFxuXHR0eXBlIE5vdGVSZWNvcmQsXG5cdHR5cGUgTm90ZVN5bmNTdGF0dXNcbn0gZnJvbSAnLi4vcGVyc2lzdGVuY2UvcmVjb3Jkcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yUGFnZSBleHRlbmRzIEVkaXRvclN0YXRlLCBOb3RlUmVjb3JkIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yU2Vzc2lvbiB7XG5cdHBhZ2VzOiBFZGl0b3JQYWdlW107XG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgVU5USVRMRURfUEFHRSA9ICdVbnRpdGxlZCc7XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVQYWdlVGl0bGUoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZmlyc3RMaW5lID0gY29udGVudFxuXHRcdC5zcGxpdCgnXFxuJylcblx0XHQubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcblx0XHQuZmluZCgobGluZSkgPT4gbGluZS5sZW5ndGggPiAwKTtcblxuXHRpZiAoIWZpcnN0TGluZSkge1xuXHRcdHJldHVybiBVTlRJVExFRF9QQUdFO1xuXHR9XG5cblx0cmV0dXJuIGZpcnN0TGluZS5yZXBsYWNlKC9cXHMrL2csICcgJykuc2xpY2UoMCwgNDgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUGFnZShcblx0Y29udGVudCA9ICcnLFxuXHRvcHRpb25zOiB7XG5cdFx0aWQ/OiBzdHJpbmc7XG5cdFx0dXNlcklkPzogc3RyaW5nO1xuXHRcdG5vdz86IHN0cmluZztcblx0fSA9IHt9XG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gb3B0aW9ucy5ub3cgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBvcHRpb25zLmlkID8/IGNyZWF0ZVBhZ2VJZCgpLFxuXHRcdHVzZXJJZDogb3B0aW9ucy51c2VySWQgPz8gQU5PTllNT1VTX1VTRVJJRCxcblx0XHR0aXRsZTogZGVyaXZlUGFnZVRpdGxlKGNvbnRlbnQpLFxuXHRcdGNvbnRlbnQsXG5cdFx0dGV4dDogY29udGVudCxcblx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRzZWxlY3Rpb25FbmQ6IDAsXG5cdFx0Y3JlYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0dXBkYXRlZEF0OiB0aW1lc3RhbXAsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0S25vd25SZW1vdGVVcGRhdGVkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24odXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gY3JlYXRlUGFnZSgnJywgeyB1c2VySWQgfSk7XG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IFtwYWdlXSxcblx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2UuaWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uOiBFZGl0b3JTZXNzaW9uKTogRWRpdG9yU2Vzc2lvbiB7XG5cdGlmIChzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRpZiAoc2Vzc2lvbi5wYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSBzZXNzaW9uLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlLmRlbGV0ZWRBdCA9PT0gbnVsbCkpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdGNvbnN0IGZpcnN0VmlzaWJsZVBhZ2UgPSBzZXNzaW9uLnBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKTtcblx0aWYgKGZpcnN0VmlzaWJsZVBhZ2UpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uc2Vzc2lvbixcblx0XHRcdGFjdGl2ZVBhZ2VJZDogZmlyc3RWaXNpYmxlUGFnZS5pZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdC4uLnNlc3Npb24sXG5cdFx0YWN0aXZlUGFnZUlkOiBzZXNzaW9uLnBhZ2VzWzBdIS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUGFnZVN0YXRlKHBhZ2U6IEVkaXRvclBhZ2UsIHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjb250ZW50Q2hhbmdlZCA9IHN0YXRlLnRleHQgIT09IHBhZ2UuY29udGVudDtcblx0Y29uc3Qgc2VsZWN0aW9uQ2hhbmdlZCA9XG5cdFx0c3RhdGUuc2VsZWN0aW9uU3RhcnQgIT09IHBhZ2Uuc2VsZWN0aW9uU3RhcnQgfHwgc3RhdGUuc2VsZWN0aW9uRW5kICE9PSBwYWdlLnNlbGVjdGlvbkVuZDtcblx0aWYgKCFjb250ZW50Q2hhbmdlZCAmJiAhc2VsZWN0aW9uQ2hhbmdlZCkge1xuXHRcdHJldHVybiBwYWdlO1xuXHR9XG5cblx0Y29uc3QgbmV4dFBhZ2U6IEVkaXRvclBhZ2UgPSB7XG5cdFx0Li4ucGFnZSxcblx0XHQuLi5zdGF0ZSxcblx0XHRjb250ZW50OiBzdGF0ZS50ZXh0XG5cdH07XG5cblx0aWYgKCFjb250ZW50Q2hhbmdlZCkge1xuXHRcdHJldHVybiBuZXh0UGFnZTtcblx0fVxuXG5cdGNvbnN0IHByZXZpb3VzRGVyaXZlZFRpdGxlID0gZGVyaXZlUGFnZVRpdGxlKHBhZ2UuY29udGVudCk7XG5cdGNvbnN0IG5leHREZXJpdmVkVGl0bGUgPSBkZXJpdmVQYWdlVGl0bGUoc3RhdGUudGV4dCk7XG5cdGNvbnN0IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA9IHBhZ2UudGl0bGUgPT09IHByZXZpb3VzRGVyaXZlZFRpdGxlO1xuXG5cdHJldHVybiB7XG5cdFx0Li4ubmV4dFBhZ2UsXG5cdFx0dGl0bGU6IHNob3VsZEF1dG9EZXJpdmVUaXRsZSA/IG5leHREZXJpdmVkVGl0bGUgOiBwYWdlLnRpdGxlLFxuXHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlVGl0bGUocGFnZTogRWRpdG9yUGFnZSwgdGl0bGU6IHN0cmluZyk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB0cmltbWVkID0gdGl0bGUudHJpbSgpO1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0dGl0bGU6IHRyaW1tZWQubGVuZ3RoID4gMCA/IHRyaW1tZWQuc2xpY2UoMCwgNDgpIDogVU5USVRMRURfUEFHRSxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRzeW5jU3RhdHVzOiBuZXh0RGlydHlTdGF0dXMocGFnZS5zeW5jU3RhdHVzKVxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFya1BhZ2VEZWxldGVkKHBhZ2U6IEVkaXRvclBhZ2UsIGRlbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk6IEVkaXRvclBhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdC4uLnBhZ2UsXG5cdFx0ZGVsZXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6IG5leHREaXJ0eVN0YXR1cyhwYWdlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9uZVBhZ2VGb3JVc2VyKHBhZ2U6IEVkaXRvclBhZ2UsIHVzZXJJZDogc3RyaW5nKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IGNsb25lZCA9IGNyZWF0ZVBhZ2UocGFnZS5jb250ZW50LCB7IHVzZXJJZCB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5jbG9uZWQsXG5cdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdHRleHQ6IHBhZ2UuY29udGVudCxcblx0XHRkZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZEF0LFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGlydHkocGFnZTogRWRpdG9yUGFnZSwgdXNlcklkID0gcGFnZS51c2VySWQpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdHVzZXJJZCxcblx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiBudWxsLFxuXHRcdGxhc3RLbm93blJlbW90ZURlbGV0ZWRBdDogbnVsbCxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLnN5bmNTdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5J1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU2Vzc2lvbih2YWx1ZTogdW5rbm93biwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24gfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGlmIChpc0xlZ2FjeUVkaXRvclN0YXRlKHZhbHVlKSkge1xuXHRcdHJldHVybiBtaWdyYXRlTGVnYWN5U3RhdGUodmFsdWUsIHVzZXJJZCk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgsIHVzZXJJZCkpXG5cdFx0LmZpbHRlcigocGFnZSk6IHBhZ2UgaXMgRWRpdG9yUGFnZSA9PiBwYWdlICE9PSBudWxsKVxuXHRcdC5zb3J0KGNvbXBhcmVQYWdlcyk7XG5cblx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKHVzZXJJZCk7XG5cdH1cblxuXHRjb25zdCBhY3RpdmVQYWdlSWQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5hY3RpdmVQYWdlSWQgPT09ICdzdHJpbmcnICYmXG5cdFx0cGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gdmFsdWUuYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKVxuXHRcdFx0PyB2YWx1ZS5hY3RpdmVQYWdlSWRcblx0XHRcdDogKHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKT8uaWQgPz8gcGFnZXNbMF0uaWQpO1xuXG5cdHJldHVybiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UoeyBwYWdlcywgYWN0aXZlUGFnZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUxlZ2FjeVN0YXRlKHN0YXRlOiBFZGl0b3JTdGF0ZSwgdXNlcklkID0gQU5PTllNT1VTX1VTRVJJRCk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGNyZWF0ZVBhZ2Uoc3RhdGUudGV4dCwgeyB1c2VySWQgfSksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyLCB1c2VySWQ6IHN0cmluZyk6IEVkaXRvclBhZ2UgfCBudWxsIHtcblx0aWYgKCFpc1JlY29yZCh2YWx1ZSkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGNvbnRlbnQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5jb250ZW50ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5jb250ZW50XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJ1xuXHRcdFx0XHQ/IHZhbHVlLnRleHRcblx0XHRcdFx0OiAnJztcblx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xuXHRjb25zdCBzZWxlY3Rpb25TdGFydCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25TdGFydCA6IDAsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IHNlbGVjdGlvbkVuZCA9IGNsYW1wU2VsZWN0aW9uKFxuXHRcdHR5cGVvZiB2YWx1ZS5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gdmFsdWUuc2VsZWN0aW9uRW5kIDogc2VsZWN0aW9uU3RhcnQsXG5cdFx0bm9ybWFsaXplZENvbnRlbnQubGVuZ3RoXG5cdCk7XG5cdGNvbnN0IGNyZWF0ZWRBdCA9IHJlYWRUaW1lc3RhbXAodmFsdWUuY3JlYXRlZEF0LCB2YWx1ZS5jcmVhdGVkX2F0KTtcblx0Y29uc3QgdXBkYXRlZEF0ID0gcmVhZFRpbWVzdGFtcCh2YWx1ZS51cGRhdGVkQXQsIHZhbHVlLnVwZGF0ZWRfYXQpID8/IGNyZWF0ZWRBdDtcblx0Y29uc3QgZGVsZXRlZEF0ID0gcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmRlbGV0ZWRBdCwgdmFsdWUuZGVsZXRlZF9hdCk7XG5cblx0cmV0dXJuIHtcblx0XHRpZDogdHlwZW9mIHZhbHVlLmlkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5pZC5sZW5ndGggPiAwID8gdmFsdWUuaWQgOiBjcmVhdGVGYWxsYmFja1BhZ2VJZChpbmRleCksXG5cdFx0dXNlcklkOiB0eXBlb2YgdmFsdWUudXNlcklkID09PSAnc3RyaW5nJyAmJiB2YWx1ZS51c2VySWQubGVuZ3RoID4gMCA/IHZhbHVlLnVzZXJJZCA6IHVzZXJJZCxcblx0XHR0aXRsZTpcblx0XHRcdHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudGl0bGUudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQ6IHJlYWROdWxsYWJsZVRpbWVzdGFtcCh2YWx1ZS5sYXN0U3luY2VkQXQpLFxuXHRcdGxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdDogcmVhZE51bGxhYmxlVGltZXN0YW1wKHZhbHVlLmxhc3RLbm93blJlbW90ZVVwZGF0ZWRBdCksXG5cdFx0bGFzdEtub3duUmVtb3RlRGVsZXRlZEF0OiByZWFkTnVsbGFibGVUaW1lc3RhbXAodmFsdWUubGFzdEtub3duUmVtb3RlRGVsZXRlZEF0KSxcblx0XHRzeW5jU3RhdHVzOiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlLnN5bmNTdGF0dXMpXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUGFnZUlkKCkge1xuXHRpZiAodHlwZW9mIGNyeXB0byAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIGNyeXB0by5yYW5kb21VVUlEID09PSAnZnVuY3Rpb24nKSB7XG5cdFx0cmV0dXJuIGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdH1cblxuXHRyZXR1cm4gYG5vdGUtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCl9LSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRmFsbGJhY2tQYWdlSWQoaW5kZXg6IG51bWJlcikge1xuXHRyZXR1cm4gYG5vdGUtJHtpbmRleCArIDF9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFRpbWVzdGFtcCguLi52YWx1ZXM6IHVua25vd25bXSkge1xuXHRmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuXHRcdGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDApIHtcblx0XHRcdHJldHVybiB2YWx1ZTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiByZWFkTnVsbGFibGVUaW1lc3RhbXAoLi4udmFsdWVzOiB1bmtub3duW10pIHtcblx0Zm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTeW5jU3RhdHVzKHZhbHVlOiB1bmtub3duKTogTm90ZVN5bmNTdGF0dXMge1xuXHRyZXR1cm4gdmFsdWUgPT09ICdzeW5jZWQnIHx8IHZhbHVlID09PSAncGVuZGluZ19wdXNoJyB8fCB2YWx1ZSA9PT0gJ2NvbmZsaWN0JyA/IHZhbHVlIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gbmV4dERpcnR5U3RhdHVzKHN0YXR1czogTm90ZVN5bmNTdGF0dXMpOiBOb3RlU3luY1N0YXR1cyB7XG5cdHJldHVybiBzdGF0dXMgPT09ICdjb25mbGljdCcgPyAnY29uZmxpY3QnIDogJ2RpcnR5Jztcbn1cblxuZnVuY3Rpb24gY29tcGFyZVBhZ2VzKGxlZnQ6IEVkaXRvclBhZ2UsIHJpZ2h0OiBFZGl0b3JQYWdlKSB7XG5cdGlmIChsZWZ0LmNyZWF0ZWRBdCAhPT0gcmlnaHQuY3JlYXRlZEF0KSB7XG5cdFx0cmV0dXJuIGxlZnQuY3JlYXRlZEF0LmxvY2FsZUNvbXBhcmUocmlnaHQuY3JlYXRlZEF0KTtcblx0fVxuXG5cdHJldHVybiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU3VwYWJhc2VDbGllbnQgfSBmcm9tICdAc3VwYWJhc2Uvc3VwYWJhc2UtanMnO1xuaW1wb3J0IHsgY3JlYXRlUGFnZSwgZW5zdXJlVmFsaWRBY3RpdmVQYWdlLCB0eXBlIEVkaXRvclBhZ2UsIHR5cGUgRWRpdG9yU2Vzc2lvbiB9IGZyb20gJy4vY29yZS9zZXNzaW9uJztcblxuY29uc3QgUkVNT1RFX05PVEVfQ09MVU1OUyA9ICdpZCx1c2VyX2lkLHRpdGxlLGNvbnRlbnQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0LGRlbGV0ZWRfYXQnO1xuXG5pbnRlcmZhY2UgUmVtb3RlTm90ZVJvdyB7XG5cdGlkOiBzdHJpbmc7XG5cdHVzZXJfaWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjcmVhdGVkX2F0OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ6IHN0cmluZztcblx0ZGVsZXRlZF9hdDogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTeW5jUnVuUmVzdWx0IHtcblx0c2Vzc2lvbjogRWRpdG9yU2Vzc2lvbjtcblx0cHVzaGVkQ291bnQ6IG51bWJlcjtcblx0cHVsbGVkQ291bnQ6IG51bWJlcjtcblx0Y29uZmxpY3RDb3VudDogbnVtYmVyO1xufVxuXG4vLyBPbmUgbWFudWFsIHN5bmMgcGFzcyB3b3JrcyBhZ2FpbnN0IG9uZSByZW1vdGUgc25hcHNob3QuXG4vLyBXZSBwdWxsIG9uY2UsIGRlY2lkZSBldmVyeXRoaW5nIGFnYWluc3QgdGhhdCBzbmFwc2hvdCwgdHJ1c3Qgd3JpdGUgcmVzcG9uc2VzLFxuLy8gYW5kIG9ubHkgdGhlbiBidWlsZCB0aGUgbmV4dCBsb2NhbCBzZXNzaW9uLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN5bmNVc2VyTm90ZXMoXG5cdHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCxcblx0dXNlcklkOiBzdHJpbmcsXG5cdGxvY2FsU2Vzc2lvbjogRWRpdG9yU2Vzc2lvbixcblx0bm93ID0gbmV3IERhdGUoKVxuKTogUHJvbWlzZTxTeW5jUnVuUmVzdWx0PiB7XG5cdGNvbnN0IHJlbW90ZVNuYXBzaG90ID0gYXdhaXQgcHVsbFJlbW90ZVNuYXBzaG90KHN1cGFiYXNlLCB1c2VySWQpO1xuXHRjb25zdCByZW1vdGVCeUlkID0gbmV3IE1hcChyZW1vdGVTbmFwc2hvdC5tYXAoKG5vdGUpID0+IFtub3RlLmlkLCBub3RlXSkpO1xuXHRjb25zdCBwcm9jZXNzZWRSZW1vdGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Y29uc3QgbmV4dFBhZ2VzOiBFZGl0b3JQYWdlW10gPSBbXTtcblx0bGV0IHB1c2hlZENvdW50ID0gMDtcblx0bGV0IHB1bGxlZENvdW50ID0gMDtcblx0bGV0IGNvbmZsaWN0Q291bnQgPSAwO1xuXHRsZXQgbmV4dEFjdGl2ZVBhZ2VJZCA9IGxvY2FsU2Vzc2lvbi5hY3RpdmVQYWdlSWQ7XG5cblx0Zm9yIChjb25zdCBsb2NhbFBhZ2Ugb2Ygc29ydFBhZ2VzKGxvY2FsU2Vzc2lvbi5wYWdlcy5maWx0ZXIoKHBhZ2UpID0+IHBhZ2UudXNlcklkID09PSB1c2VySWQpKSkge1xuXHRcdGNvbnN0IHJlbW90ZSA9IHJlbW90ZUJ5SWQuZ2V0KGxvY2FsUGFnZS5pZCkgPz8gbnVsbDtcblx0XHRpZiAoIXJlbW90ZSkge1xuXHRcdFx0Y29uc3QgcHVzaGVkID0gYXdhaXQgcHVzaExvY2FsTm90ZShzdXBhYmFzZSwgdXNlcklkLCBsb2NhbFBhZ2UpO1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocHVzaGVkLCBsb2NhbFBhZ2UpKTtcblx0XHRcdHB1c2hlZENvdW50ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRwcm9jZXNzZWRSZW1vdGVJZHMuYWRkKHJlbW90ZS5pZCk7XG5cdFx0Y29uc3QgbG9jYWxDaGFuZ2VkID0gaGFzTG9jYWxDaGFuZ2VkU2luY2VTeW5jKGxvY2FsUGFnZSk7XG5cdFx0Y29uc3QgcmVtb3RlQ2hhbmdlZCA9IGhhc1JlbW90ZUNoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlLCByZW1vdGUpO1xuXHRcdGNvbnN0IHNhbWVTdGF0ZSA9IG5vdGVTdGF0ZXNNYXRjaChsb2NhbFBhZ2UsIHJlbW90ZSk7XG5cblx0XHRpZiAoIWxvY2FsQ2hhbmdlZCAmJiAhcmVtb3RlQ2hhbmdlZCkge1xuXHRcdFx0bmV4dFBhZ2VzLnB1c2godG9TeW5jZWRMb2NhbFBhZ2UocmVtb3RlLCBsb2NhbFBhZ2UpKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChzYW1lU3RhdGUpIHtcblx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobG9jYWxDaGFuZ2VkICYmICFyZW1vdGVDaGFuZ2VkKSB7XG5cdFx0XHRjb25zdCBwdXNoZWQgPSBhd2FpdCBwdXNoTG9jYWxOb3RlKHN1cGFiYXNlLCB1c2VySWQsIGxvY2FsUGFnZSk7XG5cdFx0XHRuZXh0UGFnZXMucHVzaCh0b1N5bmNlZExvY2FsUGFnZShwdXNoZWQsIGxvY2FsUGFnZSkpO1xuXHRcdFx0cHVzaGVkQ291bnQgKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmICghbG9jYWxDaGFuZ2VkICYmIHJlbW90ZUNoYW5nZWQpIHtcblx0XHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKSk7XG5cdFx0XHRwdWxsZWRDb3VudCArPSAxO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcmVtb3RlUGFnZSA9IHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbG9jYWxQYWdlKTtcblx0XHRuZXh0UGFnZXMucHVzaChyZW1vdGVQYWdlKTtcblx0XHRjb25mbGljdENvdW50ICs9IDE7XG5cblx0XHRjb25zdCBjb25mbGljdEZvcmsgPSBmb3JrQ29uZmxpY3ROb3RlKGxvY2FsUGFnZSwgbm93KTtcblx0XHRjb25zdCBwdXNoZWRGb3JrID0gYXdhaXQgcHVzaExvY2FsTm90ZShzdXBhYmFzZSwgdXNlcklkLCBjb25mbGljdEZvcmspO1xuXHRcdGNvbnN0IHN5bmNlZEZvcmsgPSB0b1N5bmNlZExvY2FsUGFnZShwdXNoZWRGb3JrLCBjb25mbGljdEZvcmspO1xuXHRcdG5leHRQYWdlcy5wdXNoKHN5bmNlZEZvcmspO1xuXHRcdHB1c2hlZENvdW50ICs9IDE7XG5cblx0XHRpZiAobG9jYWxTZXNzaW9uLmFjdGl2ZVBhZ2VJZCA9PT0gbG9jYWxQYWdlLmlkICYmIHJlbW90ZVBhZ2UuZGVsZXRlZEF0ICE9PSBudWxsKSB7XG5cdFx0XHRuZXh0QWN0aXZlUGFnZUlkID0gc3luY2VkRm9yay5pZDtcblx0XHR9XG5cdH1cblxuXHRmb3IgKGNvbnN0IHJlbW90ZSBvZiByZW1vdGVTbmFwc2hvdCkge1xuXHRcdGlmIChwcm9jZXNzZWRSZW1vdGVJZHMuaGFzKHJlbW90ZS5pZCkpIHtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdG5leHRQYWdlcy5wdXNoKHRvU3luY2VkTG9jYWxQYWdlKHJlbW90ZSwgbnVsbCkpO1xuXHRcdHB1bGxlZENvdW50ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHNlc3Npb246IGVuc3VyZVZhbGlkQWN0aXZlUGFnZSh7XG5cdFx0XHRwYWdlczogc29ydFBhZ2VzKG5leHRQYWdlcyksXG5cdFx0XHRhY3RpdmVQYWdlSWQ6IG5leHRBY3RpdmVQYWdlSWRcblx0XHR9KSxcblx0XHRwdXNoZWRDb3VudCxcblx0XHRwdWxsZWRDb3VudCxcblx0XHRjb25mbGljdENvdW50XG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JrQ29uZmxpY3ROb3RlKHBhZ2U6IEVkaXRvclBhZ2UsIG5vdyA9IG5ldyBEYXRlKCkpOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgdGltZXN0YW1wID0gbm93LnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IGZvcmsgPSBjcmVhdGVQYWdlKHBhZ2UuY29udGVudCwgeyB1c2VySWQ6IHBhZ2UudXNlcklkLCBub3c6IHRpbWVzdGFtcCB9KTtcblx0cmV0dXJuIHtcblx0XHQuLi5mb3JrLFxuXHRcdHRpdGxlOiBgJHtwYWdlLnRpdGxlfSAke2J1aWxkQ29uZmxpY3RTdWZmaXgobm93KX1gLnRyaW0oKSxcblx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0dGV4dDogcGFnZS5jb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwYWdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZDogcGFnZS5zZWxlY3Rpb25FbmQsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdHN5bmNTdGF0dXM6ICdkaXJ0eSdcblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHVsbFJlbW90ZVNuYXBzaG90KHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCwgdXNlcklkOiBzdHJpbmcpOiBQcm9taXNlPFJlbW90ZU5vdGVSb3dbXT4ge1xuXHRjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZVxuXHRcdC5mcm9tKCdub3RlcycpXG5cdFx0LnNlbGVjdChSRU1PVEVfTk9URV9DT0xVTU5TKVxuXHRcdC5lcSgndXNlcl9pZCcsIHVzZXJJZClcblx0XHQub3JkZXIoJ2NyZWF0ZWRfYXQnLCB7IGFzY2VuZGluZzogdHJ1ZSB9KVxuXHRcdC5vcmRlcignaWQnLCB7IGFzY2VuZGluZzogdHJ1ZSB9KTtcblxuXHRpZiAoZXJyb3IpIHtcblx0XHR0aHJvdyBlcnJvcjtcblx0fVxuXG5cdHJldHVybiAoZGF0YSA/PyBbXSkgYXMgUmVtb3RlTm90ZVJvd1tdO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwdXNoTG9jYWxOb3RlKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nLFxuXHRsb2NhbFBhZ2U6IEVkaXRvclBhZ2Vcbik6IFByb21pc2U8UmVtb3RlTm90ZVJvdz4ge1xuXHRjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZVxuXHRcdC5mcm9tKCdub3RlcycpXG5cdFx0LnVwc2VydChcblx0XHRcdHtcblx0XHRcdFx0aWQ6IGxvY2FsUGFnZS5pZCxcblx0XHRcdFx0dXNlcl9pZDogdXNlcklkLFxuXHRcdFx0XHR0aXRsZTogbG9jYWxQYWdlLnRpdGxlLFxuXHRcdFx0XHRjb250ZW50OiBsb2NhbFBhZ2UuY29udGVudCxcblx0XHRcdFx0Y3JlYXRlZF9hdDogbG9jYWxQYWdlLmNyZWF0ZWRBdCxcblx0XHRcdFx0dXBkYXRlZF9hdDogbG9jYWxQYWdlLnVwZGF0ZWRBdCxcblx0XHRcdFx0ZGVsZXRlZF9hdDogbG9jYWxQYWdlLmRlbGV0ZWRBdFxuXHRcdFx0fSxcblx0XHRcdHsgb25Db25mbGljdDogJ2lkJyB9XG5cdFx0KVxuXHRcdC5zZWxlY3QoUkVNT1RFX05PVEVfQ09MVU1OUylcblx0XHQuc2luZ2xlKCk7XG5cblx0aWYgKGVycm9yKSB7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH1cblxuXHRyZXR1cm4gZGF0YSBhcyBSZW1vdGVOb3RlUm93O1xufVxuXG5mdW5jdGlvbiB0b1N5bmNlZExvY2FsUGFnZShcblx0cmVtb3RlOiBSZW1vdGVOb3RlUm93LFxuXHRsb2NhbFBhZ2U6IEVkaXRvclBhZ2UgfCBudWxsXG4pOiBFZGl0b3JQYWdlIHtcblx0Y29uc3QgYmFzZSA9XG5cdFx0bG9jYWxQYWdlID8/XG5cdFx0Y3JlYXRlUGFnZShyZW1vdGUuY29udGVudCwge1xuXHRcdFx0aWQ6IHJlbW90ZS5pZCxcblx0XHRcdHVzZXJJZDogcmVtb3RlLnVzZXJfaWQsXG5cdFx0XHRub3c6IHJlbW90ZS5jcmVhdGVkX2F0XG5cdFx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHQuLi5iYXNlLFxuXHRcdGlkOiByZW1vdGUuaWQsXG5cdFx0dXNlcklkOiByZW1vdGUudXNlcl9pZCxcblx0XHR0aXRsZTogcmVtb3RlLnRpdGxlLFxuXHRcdGNvbnRlbnQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdHRleHQ6IHJlbW90ZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogcmVtb3RlLmNyZWF0ZWRfYXQsXG5cdFx0dXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRkZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdGxhc3RTeW5jZWRBdDogcmVtb3RlLnVwZGF0ZWRfYXQsXG5cdFx0bGFzdEtub3duUmVtb3RlVXBkYXRlZEF0OiByZW1vdGUudXBkYXRlZF9hdCxcblx0XHRsYXN0S25vd25SZW1vdGVEZWxldGVkQXQ6IHJlbW90ZS5kZWxldGVkX2F0LFxuXHRcdHN5bmNTdGF0dXM6ICdzeW5jZWQnXG5cdH07XG59XG5cbmZ1bmN0aW9uIGhhc0xvY2FsQ2hhbmdlZFNpbmNlU3luYyhsb2NhbFBhZ2U6IEVkaXRvclBhZ2UpIHtcblx0aWYgKGxvY2FsUGFnZS5sYXN0U3luY2VkQXQgPT09IG51bGwpIHtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdHJldHVybiBsYXRlc3RMb2NhbE11dGF0aW9uQXQobG9jYWxQYWdlKSA+IGxvY2FsUGFnZS5sYXN0U3luY2VkQXQ7XG59XG5cbmZ1bmN0aW9uIGhhc1JlbW90ZUNoYW5nZWRTaW5jZVN5bmMobG9jYWxQYWdlOiBFZGl0b3JQYWdlLCByZW1vdGU6IFJlbW90ZU5vdGVSb3cpIHtcblx0aWYgKGxvY2FsUGFnZS5sYXN0U3luY2VkQXQgPT09IG51bGwpIHtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdHJldHVybiBsYXRlc3RSZW1vdGVNdXRhdGlvbkF0KHJlbW90ZSkgPiBsb2NhbFBhZ2UubGFzdFN5bmNlZEF0O1xufVxuXG5mdW5jdGlvbiBsYXRlc3RMb2NhbE11dGF0aW9uQXQobG9jYWxQYWdlOiBFZGl0b3JQYWdlKSB7XG5cdHJldHVybiBsb2NhbFBhZ2UuZGVsZXRlZEF0ICYmIGxvY2FsUGFnZS5kZWxldGVkQXQgPiBsb2NhbFBhZ2UudXBkYXRlZEF0XG5cdFx0PyBsb2NhbFBhZ2UuZGVsZXRlZEF0XG5cdFx0OiBsb2NhbFBhZ2UudXBkYXRlZEF0O1xufVxuXG5mdW5jdGlvbiBsYXRlc3RSZW1vdGVNdXRhdGlvbkF0KHJlbW90ZTogUmVtb3RlTm90ZVJvdykge1xuXHRyZXR1cm4gcmVtb3RlLmRlbGV0ZWRfYXQgJiYgcmVtb3RlLmRlbGV0ZWRfYXQgPiByZW1vdGUudXBkYXRlZF9hdCA/IHJlbW90ZS5kZWxldGVkX2F0IDogcmVtb3RlLnVwZGF0ZWRfYXQ7XG59XG5cbmZ1bmN0aW9uIG5vdGVTdGF0ZXNNYXRjaChsb2NhbFBhZ2U6IEVkaXRvclBhZ2UsIHJlbW90ZTogUmVtb3RlTm90ZVJvdykge1xuXHRyZXR1cm4gKFxuXHRcdGxvY2FsUGFnZS50aXRsZSA9PT0gcmVtb3RlLnRpdGxlICYmXG5cdFx0bG9jYWxQYWdlLmNvbnRlbnQgPT09IHJlbW90ZS5jb250ZW50ICYmXG5cdFx0KGxvY2FsUGFnZS5kZWxldGVkQXQgPz8gbnVsbCkgPT09IChyZW1vdGUuZGVsZXRlZF9hdCA/PyBudWxsKVxuXHQpO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbmZsaWN0U3VmZml4KG5vdzogRGF0ZSkge1xuXHRjb25zdCBsYWJlbCA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KHVuZGVmaW5lZCwge1xuXHRcdGRhdGVTdHlsZTogJ21lZGl1bScsXG5cdFx0dGltZVN0eWxlOiAnc2hvcnQnXG5cdH0pLmZvcm1hdChub3cpO1xuXG5cdHJldHVybiBgKExvY2FsIGNvbmZsaWN0ICR7bGFiZWx9KWA7XG59XG5cbmZ1bmN0aW9uIHNvcnRQYWdlcyhwYWdlczogRWRpdG9yUGFnZVtdKSB7XG5cdHJldHVybiBbLi4ucGFnZXNdLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiB7XG5cdFx0aWYgKGxlZnQuY3JlYXRlZEF0ICE9PSByaWdodC5jcmVhdGVkQXQpIHtcblx0XHRcdHJldHVybiBsZWZ0LmNyZWF0ZWRBdC5sb2NhbGVDb21wYXJlKHJpZ2h0LmNyZWF0ZWRBdCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdo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
