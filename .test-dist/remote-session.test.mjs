// tests/remote-session.test.ts
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
function createPageId() {
  return `page-${Math.random().toString(36).slice(2, 10)}`;
}

// src/lib/editor/sync/remote-session.ts
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function hasSessionContent(session) {
  if (session.pages.length > 1) {
    return true;
  }
  const [page] = session.pages;
  if (!page) {
    return false;
  }
  return page.content.trim().length > 0 || page.title !== UNTITLED_PAGE;
}
function hasRemoteContent(remote) {
  return remote.pages.length > 0;
}
function buildSessionFromRemote(remote) {
  if (remote.pages.length === 0) {
    return createSession();
  }
  const pages = remote.pages.map((page) => {
    const createdAt = page.created_at ?? page.updated_at ?? (/* @__PURE__ */ new Date()).toISOString();
    const updatedAt = page.updated_at ?? page.created_at ?? createdAt;
    return applyRemotePageState(
      {
        id: page.id,
        title: page.title,
        content: page.content,
        text: page.content,
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
      {
        title: page.title,
        content: page.content,
        deletedAt: page.deleted_at ?? null,
        createdAt,
        updatedAt
      }
    );
  });
  const activePageId = remote.activePageId && pages.some((page) => page.id === remote.activePageId) ? remote.activePageId : pages[0]?.id ?? createSession().activePageId;
  return {
    pages,
    activePageId
  };
}
function applyPageIdMap(session, pageIdMap, activePageId = session.activePageId) {
  if (pageIdMap.size === 0 && activePageId === session.activePageId) {
    return session;
  }
  return {
    pages: session.pages.map((page) => ({
      ...page,
      id: pageIdMap.get(page.id) ?? page.id
    })),
    activePageId: pageIdMap.get(activePageId) ?? activePageId
  };
}
async function readRemoteSession(supabase, userId) {
  const [{ data: pages, error: pagesError }, { data: settings, error: settingsError }] = await Promise.all([
    supabase.from("pages").select("id,title,content,created_at,updated_at,deleted_at").eq("user_id", userId).order("created_at", { ascending: true }),
    supabase.from("user_settings").select("active_page_id").eq("user_id", userId).maybeSingle()
  ]);
  if (pagesError) {
    throw pagesError;
  }
  if (settingsError) {
    throw settingsError;
  }
  return {
    activePageId: settings?.active_page_id ?? null,
    pages: pages ?? []
  };
}
async function saveRemoteSession(supabase, userId, session, currentRemote) {
  const normalizedSession = ensureValidActivePage(session);
  const currentRemotePages = currentRemote?.pages ?? (await readRemoteSession(supabase, userId)).pages;
  const remotePageMap = new Map(currentRemotePages.map((page) => [page.id, page]));
  const remotePagesToSave = normalizedSession.pages.filter((page) => isRemotePageId(page.id));
  const localPages = normalizedSession.pages.filter(
    (page) => !isRemotePageId(page.id) && shouldInsertLocalPage(normalizedSession, page)
  );
  const pagesToUpdate = remotePagesToSave.filter((page) => {
    const currentPage = remotePageMap.get(page.id);
    const currentDeletedAt = currentPage?.deleted_at ?? null;
    const localDeletedAt = page.deletedAt ?? null;
    return !currentPage || currentPage.title !== page.title || currentPage.content !== page.content || currentDeletedAt !== localDeletedAt;
  });
  if (pagesToUpdate.length > 0) {
    const { error: upsertError } = await supabase.from("pages").upsert(
      pagesToUpdate.map((page) => ({
        id: page.id,
        user_id: userId,
        title: page.title,
        content: page.content,
        deleted_at: page.deletedAt ?? null,
        updated_at: page.updatedAt
      }))
    );
    if (upsertError) {
      throw upsertError;
    }
  }
  const pageIdMap = await insertPages(supabase, userId, localPages);
  const activePageId = pageIdMap.get(normalizedSession.activePageId) ?? normalizedSession.activePageId;
  const remoteActivePageId = currentRemote?.activePageId ?? null;
  if (remoteActivePageId !== (isRemotePageId(activePageId) ? activePageId : null)) {
    await upsertUserSettings(supabase, userId, isRemotePageId(activePageId) ? activePageId : null);
  }
  return {
    pageIdMap,
    activePageId: isRemotePageId(activePageId) ? activePageId : null
  };
}
function isRemotePageId(id) {
  return UUID_PATTERN.test(id);
}
function shouldInsertLocalPage(session, page) {
  const isBootstrapPlaceholder = session.pages.length === 1 && session.activePageId === page.id && page.deletedAt === null && page.content.length === 0 && page.title === UNTITLED_PAGE && page.lastSyncedAt === null && page.lastSyncedVersion === null && page.syncStatus === "local-only";
  return !isBootstrapPlaceholder;
}
async function insertPages(supabase, userId, pages) {
  const pageIdMap = /* @__PURE__ */ new Map();
  for (const page of pages) {
    const { data, error } = await supabase.from("pages").insert({
      user_id: userId,
      title: page.title,
      content: page.content,
      deleted_at: page.deletedAt ?? null,
      updated_at: page.updatedAt
    }).select("id").single();
    if (error) {
      throw error;
    }
    pageIdMap.set(page.id, data.id);
  }
  return pageIdMap;
}
async function upsertUserSettings(supabase, userId, activePageId) {
  const { error } = await supabase.from("user_settings").upsert({
    user_id: userId,
    active_page_id: activePageId
  });
  if (error) {
    throw error;
  }
}

// tests/remote-session.test.ts
var SupabaseStub = class {
  constructor(pages = []) {
    this.pages = pages;
  }
  pages;
  pageUpserts = [];
  pageInserts = [];
  settingUpserts = [];
  removedIds = [];
  from(table) {
    if (table === "pages") {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: this.pages, error: null })
          })
        }),
        upsert: async (value) => {
          this.pageUpserts.push(value);
          return { error: null };
        },
        delete: () => ({
          in: async (value) => {
            this.removedIds.push(value);
            return { error: null };
          }
        }),
        insert: (value) => {
          this.pageInserts.push(value);
          return {
            select: () => ({
              single: async () => ({
                data: { id: "f16d9a88-8e66-4db4-a0a5-8090c05690a2" },
                error: null
              })
            })
          };
        }
      };
    }
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { active_page_id: null },
            error: null
          })
        })
      }),
      upsert: async (value) => {
        this.settingUpserts.push(value);
        return { data: value, error: null };
      }
    };
  }
};
test("hasSessionContent treats the default blank session as empty", () => {
  assert.equal(hasSessionContent(createSession()), false);
});
test("hasSessionContent detects non-empty local data", () => {
  const session = createSession();
  session.pages[0].content = "alpha";
  session.pages[0].text = "alpha";
  assert.equal(hasSessionContent(session), true);
});
test("hasRemoteContent is based on stored pages", () => {
  assert.equal(hasRemoteContent({ activePageId: null, pages: [] }), false);
  assert.equal(
    hasRemoteContent({
      activePageId: "page-1",
      pages: [{ id: "page-1", title: "A", content: "alpha" }]
    }),
    true
  );
});
test("buildSessionFromRemote rebuilds an editor session from Supabase rows", () => {
  const remote = {
    activePageId: "page-2",
    pages: [
      { id: "page-1", title: "One", content: "alpha" },
      { id: "page-2", title: "Two", content: "beta" }
    ]
  };
  const session = buildSessionFromRemote(remote);
  assert.equal(session.activePageId, "page-2");
  assert.equal(session.pages[0]?.text, "alpha");
  assert.equal(session.pages[1]?.selectionStart, 0);
});
test("applyPageIdMap replaces local ids with remote ids without dropping content", () => {
  const session = createSession();
  const remapped = applyPageIdMap(
    session,
    /* @__PURE__ */ new Map([[session.pages[0].id, "f16d9a88-8e66-4db4-a0a5-8090c05690a2"]])
  );
  assert.equal(remapped.pages[0]?.id, "f16d9a88-8e66-4db4-a0a5-8090c05690a2");
  assert.equal(remapped.pages[0]?.content, session.pages[0]?.content);
  assert.equal(remapped.activePageId, "f16d9a88-8e66-4db4-a0a5-8090c05690a2");
});
test("saveRemoteSession repairs a missing active page before writing user settings", async () => {
  const session = createSession();
  session.pages[0].content = "seed";
  session.pages[0].text = "seed";
  session.pages[0].title = "seed";
  const result = await saveRemoteSession(new SupabaseStub(), "user-a", {
    ...session,
    activePageId: "missing"
  });
  assert.equal(result.activePageId, "f16d9a88-8e66-4db4-a0a5-8090c05690a2");
});
test("saveRemoteSession does not sync the initial bootstrap empty note", async () => {
  const session = createSession();
  const stub = new SupabaseStub();
  const result = await saveRemoteSession(stub, "user-a", session, {
    activePageId: null,
    pages: []
  });
  assert.equal(stub.pageInserts.length, 0);
  assert.equal(result.pageIdMap.size, 0);
  assert.equal(result.activePageId, null);
});
test("saveRemoteSession syncs an explicitly created empty untitled note", async () => {
  const session = createSession();
  const explicitNote = createPage("");
  session.pages.push(explicitNote);
  session.activePageId = explicitNote.id;
  const stub = new SupabaseStub();
  const result = await saveRemoteSession(stub, "user-a", session, {
    activePageId: null,
    pages: []
  });
  assert.equal(stub.pageInserts.length > 0, true);
  assert.equal(result.pageIdMap.has(explicitNote.id), true);
});
test("saveRemoteSession skips unchanged remote rows and only writes diffs", async () => {
  const stub = new SupabaseStub([
    { id: "f16d9a88-8e66-4db4-a0a5-8090c05690a2", title: "Remote title", content: "remote body" }
  ]);
  const session = createSession();
  session.pages = [
    {
      id: "f16d9a88-8e66-4db4-a0a5-8090c05690a2",
      title: "Remote title",
      content: "remote body",
      text: "remote body",
      selectionStart: 0,
      selectionEnd: 0,
      createdAt: "2026-04-15T16:12:00.000Z",
      updatedAt: "2026-04-15T16:12:00.000Z",
      deletedAt: null,
      lastSyncedAt: "2026-04-15T16:12:00.000Z",
      lastSyncedTitle: "Remote title",
      lastSyncedContent: "remote body",
      lastSyncedDeletedAt: null,
      dirty: false,
      syncStatus: "synced",
      lastSyncedVersion: "2026-04-15T16:12:00.000Z"
    },
    createPage("local body")
  ];
  session.activePageId = "f16d9a88-8e66-4db4-a0a5-8090c05690a2";
  await saveRemoteSession(stub, "user-a", session, {
    activePageId: "f16d9a88-8e66-4db4-a0a5-8090c05690a2",
    pages: [
      {
        id: "f16d9a88-8e66-4db4-a0a5-8090c05690a2",
        title: "Remote title",
        content: "remote body"
      }
    ]
  });
  assert.equal(stub.pageUpserts.length, 0);
  assert.equal(stub.settingUpserts.length, 0);
  assert.equal(stub.removedIds.length, 0);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvcmVtb3RlLXNlc3Npb24udGVzdC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb3JlL3Nlc3Npb24udHMiLCAiLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy9yZW1vdGUtc2Vzc2lvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7XG5cdGFwcGx5UGFnZUlkTWFwLFxuXHRidWlsZFNlc3Npb25Gcm9tUmVtb3RlLFxuXHRoYXNSZW1vdGVDb250ZW50LFxuXHRoYXNTZXNzaW9uQ29udGVudCxcblx0c2F2ZVJlbW90ZVNlc3Npb24sXG5cdHR5cGUgUmVtb3RlQXBwU3RhdGVcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3Ivc3luYy9yZW1vdGUtc2Vzc2lvbi50cyc7XG5pbXBvcnQgeyBjcmVhdGVQYWdlLCBjcmVhdGVTZXNzaW9uIH0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29yZS9zZXNzaW9uLnRzJztcblxuY2xhc3MgU3VwYWJhc2VTdHViIHtcblx0cGFnZVVwc2VydHM6IEFycmF5PHVua25vd24+ID0gW107XG5cdHBhZ2VJbnNlcnRzOiBBcnJheTx1bmtub3duPiA9IFtdO1xuXHRzZXR0aW5nVXBzZXJ0czogQXJyYXk8dW5rbm93bj4gPSBbXTtcblx0cmVtb3ZlZElkczogQXJyYXk8c3RyaW5nW10+ID0gW107XG5cblx0Y29uc3RydWN0b3IocHJpdmF0ZSBwYWdlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZT86IHN0cmluZzsgY29udGVudD86IHN0cmluZyB9PiA9IFtdKSB7fVxuXG5cdGZyb20odGFibGU6IHN0cmluZykge1xuXHRcdGlmICh0YWJsZSA9PT0gJ3BhZ2VzJykge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0c2VsZWN0OiAoKSA9PiAoe1xuXHRcdFx0XHRcdGVxOiAoKSA9PiAoe1xuXHRcdFx0XHRcdFx0b3JkZXI6IGFzeW5jICgpID0+ICh7IGRhdGE6IHRoaXMucGFnZXMsIGVycm9yOiBudWxsIH0pXG5cdFx0XHRcdFx0fSlcblx0XHRcdFx0fSksXG5cdFx0XHRcdHVwc2VydDogYXN5bmMgKHZhbHVlOiB1bmtub3duKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5wYWdlVXBzZXJ0cy5wdXNoKHZhbHVlKTtcblx0XHRcdFx0XHRyZXR1cm4geyBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRkZWxldGU6ICgpID0+ICh7XG5cdFx0XHRcdFx0aW46IGFzeW5jICh2YWx1ZTogc3RyaW5nW10pID0+IHtcblx0XHRcdFx0XHRcdHRoaXMucmVtb3ZlZElkcy5wdXNoKHZhbHVlKTtcblx0XHRcdFx0XHRcdHJldHVybiB7IGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KSxcblx0XHRcdFx0aW5zZXJ0OiAodmFsdWU6IHVua25vd24pID0+IHtcblx0XHRcdFx0XHR0aGlzLnBhZ2VJbnNlcnRzLnB1c2godmFsdWUpO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRzZWxlY3Q6ICgpID0+ICh7XG5cdFx0XHRcdFx0XHRcdHNpbmdsZTogYXN5bmMgKCkgPT4gKHtcblx0XHRcdFx0XHRcdFx0XHRkYXRhOiB7IGlkOiAnZjE2ZDlhODgtOGU2Ni00ZGI0LWEwYTUtODA5MGMwNTY5MGEyJyB9LFxuXHRcdFx0XHRcdFx0XHRcdGVycm9yOiBudWxsXG5cdFx0XHRcdFx0XHRcdH0pXG5cdFx0XHRcdFx0XHR9KVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdHNlbGVjdDogKCkgPT4gKHtcblx0XHRcdFx0ZXE6ICgpID0+ICh7XG5cdFx0XHRcdFx0bWF5YmVTaW5nbGU6IGFzeW5jICgpID0+ICh7XG5cdFx0XHRcdFx0XHRkYXRhOiB7IGFjdGl2ZV9wYWdlX2lkOiBudWxsIH0sXG5cdFx0XHRcdFx0XHRlcnJvcjogbnVsbFxuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdH0pXG5cdFx0XHR9KSxcblx0XHRcdHVwc2VydDogYXN5bmMgKHZhbHVlOiB7IGFjdGl2ZV9wYWdlX2lkOiBzdHJpbmcgfCBudWxsIH0pID0+IHtcblx0XHRcdFx0dGhpcy5zZXR0aW5nVXBzZXJ0cy5wdXNoKHZhbHVlKTtcblx0XHRcdFx0cmV0dXJuIHsgZGF0YTogdmFsdWUsIGVycm9yOiBudWxsIH07XG5cdFx0XHR9XG5cdFx0fTtcblx0fVxufVxuXG50ZXN0KCdoYXNTZXNzaW9uQ29udGVudCB0cmVhdHMgdGhlIGRlZmF1bHQgYmxhbmsgc2Vzc2lvbiBhcyBlbXB0eScsICgpID0+IHtcblx0YXNzZXJ0LmVxdWFsKGhhc1Nlc3Npb25Db250ZW50KGNyZWF0ZVNlc3Npb24oKSksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KCdoYXNTZXNzaW9uQ29udGVudCBkZXRlY3RzIG5vbi1lbXB0eSBsb2NhbCBkYXRhJywgKCkgPT4ge1xuXHRjb25zdCBzZXNzaW9uID0gY3JlYXRlU2Vzc2lvbigpO1xuXHRzZXNzaW9uLnBhZ2VzWzBdIS5jb250ZW50ID0gJ2FscGhhJztcblx0c2Vzc2lvbi5wYWdlc1swXSEudGV4dCA9ICdhbHBoYSc7XG5cblx0YXNzZXJ0LmVxdWFsKGhhc1Nlc3Npb25Db250ZW50KHNlc3Npb24pLCB0cnVlKTtcbn0pO1xuXG50ZXN0KCdoYXNSZW1vdGVDb250ZW50IGlzIGJhc2VkIG9uIHN0b3JlZCBwYWdlcycsICgpID0+IHtcblx0YXNzZXJ0LmVxdWFsKGhhc1JlbW90ZUNvbnRlbnQoeyBhY3RpdmVQYWdlSWQ6IG51bGwsIHBhZ2VzOiBbXSB9KSwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0aGFzUmVtb3RlQ29udGVudCh7XG5cdFx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLTEnLFxuXHRcdFx0cGFnZXM6IFt7IGlkOiAncGFnZS0xJywgdGl0bGU6ICdBJywgY29udGVudDogJ2FscGhhJyB9XVxuXHRcdH0pLFxuXHRcdHRydWVcblx0KTtcbn0pO1xuXG50ZXN0KCdidWlsZFNlc3Npb25Gcm9tUmVtb3RlIHJlYnVpbGRzIGFuIGVkaXRvciBzZXNzaW9uIGZyb20gU3VwYWJhc2Ugcm93cycsICgpID0+IHtcblx0Y29uc3QgcmVtb3RlOiBSZW1vdGVBcHBTdGF0ZSA9IHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdwYWdlLTInLFxuXHRcdHBhZ2VzOiBbXG5cdFx0XHR7IGlkOiAncGFnZS0xJywgdGl0bGU6ICdPbmUnLCBjb250ZW50OiAnYWxwaGEnIH0sXG5cdFx0XHR7IGlkOiAncGFnZS0yJywgdGl0bGU6ICdUd28nLCBjb250ZW50OiAnYmV0YScgfVxuXHRcdF1cblx0fTtcblxuXHRjb25zdCBzZXNzaW9uID0gYnVpbGRTZXNzaW9uRnJvbVJlbW90ZShyZW1vdGUpO1xuXG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLmFjdGl2ZVBhZ2VJZCwgJ3BhZ2UtMicpO1xuXHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wYWdlc1swXT8udGV4dCwgJ2FscGhhJyk7XG5cdGFzc2VydC5lcXVhbChzZXNzaW9uLnBhZ2VzWzFdPy5zZWxlY3Rpb25TdGFydCwgMCk7XG59KTtcblxudGVzdCgnYXBwbHlQYWdlSWRNYXAgcmVwbGFjZXMgbG9jYWwgaWRzIHdpdGggcmVtb3RlIGlkcyB3aXRob3V0IGRyb3BwaW5nIGNvbnRlbnQnLCAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IHJlbWFwcGVkID0gYXBwbHlQYWdlSWRNYXAoXG5cdFx0c2Vzc2lvbixcblx0XHRuZXcgTWFwKFtbc2Vzc2lvbi5wYWdlc1swXSEuaWQsICdmMTZkOWE4OC04ZTY2LTRkYjQtYTBhNS04MDkwYzA1NjkwYTInXV0pXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKHJlbWFwcGVkLnBhZ2VzWzBdPy5pZCwgJ2YxNmQ5YTg4LThlNjYtNGRiNC1hMGE1LTgwOTBjMDU2OTBhMicpO1xuXHRhc3NlcnQuZXF1YWwocmVtYXBwZWQucGFnZXNbMF0/LmNvbnRlbnQsIHNlc3Npb24ucGFnZXNbMF0/LmNvbnRlbnQpO1xuXHRhc3NlcnQuZXF1YWwocmVtYXBwZWQuYWN0aXZlUGFnZUlkLCAnZjE2ZDlhODgtOGU2Ni00ZGI0LWEwYTUtODA5MGMwNTY5MGEyJyk7XG59KTtcblxudGVzdCgnc2F2ZVJlbW90ZVNlc3Npb24gcmVwYWlycyBhIG1pc3NpbmcgYWN0aXZlIHBhZ2UgYmVmb3JlIHdyaXRpbmcgdXNlciBzZXR0aW5ncycsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0c2Vzc2lvbi5wYWdlc1swXSEuY29udGVudCA9ICdzZWVkJztcblx0c2Vzc2lvbi5wYWdlc1swXSEudGV4dCA9ICdzZWVkJztcblx0c2Vzc2lvbi5wYWdlc1swXSEudGl0bGUgPSAnc2VlZCc7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNhdmVSZW1vdGVTZXNzaW9uKG5ldyBTdXBhYmFzZVN0dWIoKSBhcyBuZXZlciwgJ3VzZXItYScsIHtcblx0XHQuLi5zZXNzaW9uLFxuXHRcdGFjdGl2ZVBhZ2VJZDogJ21pc3NpbmcnXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aXZlUGFnZUlkLCAnZjE2ZDlhODgtOGU2Ni00ZGI0LWEwYTUtODA5MGMwNTY5MGEyJyk7XG59KTtcblxudGVzdCgnc2F2ZVJlbW90ZVNlc3Npb24gZG9lcyBub3Qgc3luYyB0aGUgaW5pdGlhbCBib290c3RyYXAgZW1wdHkgbm90ZScsIGFzeW5jICgpID0+IHtcblx0Y29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZVNlc3Npb24oKTtcblx0Y29uc3Qgc3R1YiA9IG5ldyBTdXBhYmFzZVN0dWIoKTtcblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2F2ZVJlbW90ZVNlc3Npb24oc3R1YiBhcyBuZXZlciwgJ3VzZXItYScsIHNlc3Npb24sIHtcblx0XHRhY3RpdmVQYWdlSWQ6IG51bGwsXG5cdFx0cGFnZXM6IFtdXG5cdH0pO1xuXG5cdGFzc2VydC5lcXVhbChzdHViLnBhZ2VJbnNlcnRzLmxlbmd0aCwgMCk7XG5cdGFzc2VydC5lcXVhbChyZXN1bHQucGFnZUlkTWFwLnNpemUsIDApO1xuXHRhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGl2ZVBhZ2VJZCwgbnVsbCk7XG59KTtcblxudGVzdCgnc2F2ZVJlbW90ZVNlc3Npb24gc3luY3MgYW4gZXhwbGljaXRseSBjcmVhdGVkIGVtcHR5IHVudGl0bGVkIG5vdGUnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdGNvbnN0IGV4cGxpY2l0Tm90ZSA9IGNyZWF0ZVBhZ2UoJycpO1xuXHRzZXNzaW9uLnBhZ2VzLnB1c2goZXhwbGljaXROb3RlKTtcblx0c2Vzc2lvbi5hY3RpdmVQYWdlSWQgPSBleHBsaWNpdE5vdGUuaWQ7XG5cdGNvbnN0IHN0dWIgPSBuZXcgU3VwYWJhc2VTdHViKCk7XG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNhdmVSZW1vdGVTZXNzaW9uKHN0dWIgYXMgbmV2ZXIsICd1c2VyLWEnLCBzZXNzaW9uLCB7XG5cdFx0YWN0aXZlUGFnZUlkOiBudWxsLFxuXHRcdHBhZ2VzOiBbXVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoc3R1Yi5wYWdlSW5zZXJ0cy5sZW5ndGggPiAwLCB0cnVlKTtcblx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5wYWdlSWRNYXAuaGFzKGV4cGxpY2l0Tm90ZS5pZCksIHRydWUpO1xufSk7XG5cbnRlc3QoJ3NhdmVSZW1vdGVTZXNzaW9uIHNraXBzIHVuY2hhbmdlZCByZW1vdGUgcm93cyBhbmQgb25seSB3cml0ZXMgZGlmZnMnLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHN0dWIgPSBuZXcgU3VwYWJhc2VTdHViKFtcblx0XHR7IGlkOiAnZjE2ZDlhODgtOGU2Ni00ZGI0LWEwYTUtODA5MGMwNTY5MGEyJywgdGl0bGU6ICdSZW1vdGUgdGl0bGUnLCBjb250ZW50OiAncmVtb3RlIGJvZHknIH1cblx0XSk7XG5cdGNvbnN0IHNlc3Npb24gPSBjcmVhdGVTZXNzaW9uKCk7XG5cdHNlc3Npb24ucGFnZXMgPSBbXG5cdFx0e1xuXHRcdFx0aWQ6ICdmMTZkOWE4OC04ZTY2LTRkYjQtYTBhNS04MDkwYzA1NjkwYTInLFxuXHRcdFx0dGl0bGU6ICdSZW1vdGUgdGl0bGUnLFxuXHRcdFx0Y29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdHRleHQ6ICdyZW1vdGUgYm9keScsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogMCxcblx0XHRcdHNlbGVjdGlvbkVuZDogMCxcblx0XHRcdGNyZWF0ZWRBdDogJzIwMjYtMDQtMTVUMTY6MTI6MDAuMDAwWicsXG5cdFx0XHR1cGRhdGVkQXQ6ICcyMDI2LTA0LTE1VDE2OjEyOjAwLjAwMFonLFxuXHRcdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdFx0bGFzdFN5bmNlZEF0OiAnMjAyNi0wNC0xNVQxNjoxMjowMC4wMDBaJyxcblx0XHRcdGxhc3RTeW5jZWRUaXRsZTogJ1JlbW90ZSB0aXRsZScsXG5cdFx0XHRsYXN0U3luY2VkQ29udGVudDogJ3JlbW90ZSBib2R5Jyxcblx0XHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRkaXJ0eTogZmFsc2UsXG5cdFx0XHRzeW5jU3RhdHVzOiAnc3luY2VkJyxcblx0XHRcdGxhc3RTeW5jZWRWZXJzaW9uOiAnMjAyNi0wNC0xNVQxNjoxMjowMC4wMDBaJ1xuXHRcdH0sXG5cdFx0Y3JlYXRlUGFnZSgnbG9jYWwgYm9keScpXG5cdF07XG5cdHNlc3Npb24uYWN0aXZlUGFnZUlkID0gJ2YxNmQ5YTg4LThlNjYtNGRiNC1hMGE1LTgwOTBjMDU2OTBhMic7XG5cblx0YXdhaXQgc2F2ZVJlbW90ZVNlc3Npb24oc3R1YiBhcyBuZXZlciwgJ3VzZXItYScsIHNlc3Npb24sIHtcblx0XHRhY3RpdmVQYWdlSWQ6ICdmMTZkOWE4OC04ZTY2LTRkYjQtYTBhNS04MDkwYzA1NjkwYTInLFxuXHRcdHBhZ2VzOiBbXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiAnZjE2ZDlhODgtOGU2Ni00ZGI0LWEwYTUtODA5MGMwNTY5MGEyJyxcblx0XHRcdFx0dGl0bGU6ICdSZW1vdGUgdGl0bGUnLFxuXHRcdFx0XHRjb250ZW50OiAncmVtb3RlIGJvZHknXG5cdFx0XHR9XG5cdFx0XVxuXHR9KTtcblxuXHRhc3NlcnQuZXF1YWwoc3R1Yi5wYWdlVXBzZXJ0cy5sZW5ndGgsIDApO1xuXHRhc3NlcnQuZXF1YWwoc3R1Yi5zZXR0aW5nVXBzZXJ0cy5sZW5ndGgsIDApO1xuXHRhc3NlcnQuZXF1YWwoc3R1Yi5yZW1vdmVkSWRzLmxlbmd0aCwgMCk7XG59KTtcbiIsICJpbXBvcnQgdHlwZSB7IEVkaXRvclN0YXRlIH0gZnJvbSAnLi4vYmFzaWMvaGlzdG9yeSc7XG5cbmV4cG9ydCB0eXBlIFBhZ2VTeW5jU3RhdHVzID0gJ2xvY2FsLW9ubHknIHwgJ3N5bmNlZCcgfCAnZGlydHknIHwgJ2RlbGV0ZWQnIHwgJ2NvbmZsaWN0JyB8ICdpbmNvbnNpc3RlbnQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvclBhZ2UgZXh0ZW5kcyBFZGl0b3JTdGF0ZSB7XG5cdGlkOiBzdHJpbmc7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZztcblx0Y3JlYXRlZEF0OiBzdHJpbmc7XG5cdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRkZWxldGVkQXQ6IHN0cmluZyB8IG51bGw7XG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZFRpdGxlOiBzdHJpbmcgfCBudWxsO1xuXHRsYXN0U3luY2VkQ29udGVudDogc3RyaW5nIHwgbnVsbDtcblx0bGFzdFN5bmNlZERlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0ZGlydHk6IGJvb2xlYW47XG5cdHN5bmNTdGF0dXM6IFBhZ2VTeW5jU3RhdHVzO1xuXHRsYXN0U3luY2VkVmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JTZXNzaW9uIHtcblx0cGFnZXM6IEVkaXRvclBhZ2VbXTtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBVTlRJVExFRF9QQUdFID0gJ1VudGl0bGVkJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVBhZ2VUaXRsZShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmaXJzdExpbmUgPSBjb250ZW50XG5cdFx0LnNwbGl0KCdcXG4nKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG5cdGlmICghZmlyc3RMaW5lKSB7XG5cdFx0cmV0dXJuIFVOVElUTEVEX1BBR0U7XG5cdH1cblxuXHRyZXR1cm4gZmlyc3RMaW5lLnJlcGxhY2UoL1xccysvZywgJyAnKS5zbGljZSgwLCA0OCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQYWdlKGNvbnRlbnQgPSAnJywgaWQgPSBjcmVhdGVQYWdlSWQoKSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjcmVhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdHJldHVybiB7XG5cdFx0aWQsXG5cdFx0dGl0bGU6IGRlcml2ZVBhZ2VUaXRsZShjb250ZW50KSxcblx0XHRjb250ZW50LFxuXHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0c2VsZWN0aW9uRW5kOiAwLFxuXHRcdGNyZWF0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IGNyZWF0ZWRBdCxcblx0XHRkZWxldGVkQXQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRUaXRsZTogbnVsbCxcblx0XHRsYXN0U3luY2VkQ29udGVudDogbnVsbCxcblx0XHRsYXN0U3luY2VkRGVsZXRlZEF0OiBudWxsLFxuXHRcdGRpcnR5OiB0cnVlLFxuXHRcdHN5bmNTdGF0dXM6ICdsb2NhbC1vbmx5Jyxcblx0XHRsYXN0U3luY2VkVmVyc2lvbjogbnVsbFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbigpOiBFZGl0b3JTZXNzaW9uIHtcblx0Y29uc3QgcGFnZSA9IGNyZWF0ZVBhZ2UoKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlVmFsaWRBY3RpdmVQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcblx0fVxuXG5cdGlmIChzZXNzaW9uLnBhZ2VzLnNvbWUoKHBhZ2UpID0+IHBhZ2UuaWQgPT09IHNlc3Npb24uYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKSkge1xuXHRcdHJldHVybiBzZXNzaW9uO1xuXHR9XG5cblx0Y29uc3QgZmlyc3RWaXNpYmxlUGFnZSA9IHNlc3Npb24ucGFnZXMuZmluZCgocGFnZSkgPT4gcGFnZS5kZWxldGVkQXQgPT09IG51bGwpO1xuXHRpZiAoZmlyc3RWaXNpYmxlUGFnZSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHQuLi5zZXNzaW9uLFxuXHRcdFx0YWN0aXZlUGFnZUlkOiBmaXJzdFZpc2libGVQYWdlLmlkXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Li4uc2Vzc2lvbixcblx0XHRhY3RpdmVQYWdlSWQ6IHNlc3Npb24ucGFnZXNbMF0hLmlkXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlU3RhdGUocGFnZTogRWRpdG9yUGFnZSwgc3RhdGU6IEVkaXRvclN0YXRlKTogRWRpdG9yUGFnZSB7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdC4uLnN0YXRlLFxuXHRcdGNvbnRlbnQ6IHN0YXRlLnRleHQsXG5cdFx0dGl0bGU6IGRlcml2ZVBhZ2VUaXRsZShzdGF0ZS50ZXh0KSxcblx0XHR1cGRhdGVkQXQsXG5cdFx0ZGlydHk6IHRydWUsXG5cdFx0c3luY1N0YXR1czogcGFnZS5kZWxldGVkQXQgPyAnZGVsZXRlZCcgOiAnZGlydHknXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQYWdlVGl0bGUocGFnZTogRWRpdG9yUGFnZSwgdGl0bGU6IHN0cmluZyk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCB1cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IHRyaW1tZWQgPSB0aXRsZS50cmltKCk7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZC5zbGljZSgwLCA0OCkgOiBVTlRJVExFRF9QQUdFLFxuXHRcdHVwZGF0ZWRBdCxcblx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdkaXJ0eSdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYWdlRGVsZXRlZChwYWdlOiBFZGl0b3JQYWdlLCBkZWxldGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpOiBFZGl0b3JQYWdlIHtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdGRlbGV0ZWRBdCxcblx0XHR1cGRhdGVkQXQ6IGRlbGV0ZWRBdCxcblx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRzeW5jU3RhdHVzOiAnZGVsZXRlZCdcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UmVtb3RlUGFnZVN0YXRlKFxuXHRwYWdlOiBFZGl0b3JQYWdlLFxuXHRzdGF0ZToge1xuXHRcdHRpdGxlOiBzdHJpbmc7XG5cdFx0Y29udGVudDogc3RyaW5nO1xuXHRcdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcblx0XHRjcmVhdGVkQXQ6IHN0cmluZztcblx0XHR1cGRhdGVkQXQ6IHN0cmluZztcblx0fVxuKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHR0aXRsZTogc3RhdGUudGl0bGUsXG5cdFx0Y29udGVudDogc3RhdGUuY29udGVudCxcblx0XHR0ZXh0OiBzdGF0ZS5jb250ZW50LFxuXHRcdGNyZWF0ZWRBdDogcGFnZS5jcmVhdGVkQXQgPz8gc3RhdGUuY3JlYXRlZEF0LFxuXHRcdHVwZGF0ZWRBdDogc3RhdGUudXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdDogc3RhdGUuZGVsZXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRBdDogc3RhdGUudXBkYXRlZEF0LFxuXHRcdGxhc3RTeW5jZWRUaXRsZTogc3RhdGUudGl0bGUsXG5cdFx0bGFzdFN5bmNlZENvbnRlbnQ6IHN0YXRlLmNvbnRlbnQsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdDogc3RhdGUuZGVsZXRlZEF0LFxuXHRcdGRpcnR5OiBmYWxzZSxcblx0XHRzeW5jU3RhdHVzOiBzdGF0ZS5kZWxldGVkQXQgPyAnZGVsZXRlZCcgOiAnc3luY2VkJyxcblx0XHRsYXN0U3luY2VkVmVyc2lvbjogc3RhdGUudXBkYXRlZEF0XG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrUGFnZVN5bmNlZChcblx0cGFnZTogRWRpdG9yUGFnZSxcblx0c3luY2VkQXQ6IHN0cmluZyxcblx0bGFzdFN5bmNlZFZlcnNpb24gPSBzeW5jZWRBdFxuKTogRWRpdG9yUGFnZSB7XG5cdHJldHVybiB7XG5cdFx0Li4ucGFnZSxcblx0XHRsYXN0U3luY2VkQXQ6IHN5bmNlZEF0LFxuXHRcdGxhc3RTeW5jZWRUaXRsZTogcGFnZS50aXRsZSxcblx0XHRsYXN0U3luY2VkQ29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZEF0LFxuXHRcdGRpcnR5OiBmYWxzZSxcblx0XHRzeW5jU3RhdHVzOiBwYWdlLmRlbGV0ZWRBdCA/ICdkZWxldGVkJyA6ICdzeW5jZWQnLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDb25mbGljdENvcHkocGFnZTogRWRpdG9yUGFnZSwgdGl0bGVTdWZmaXg6IHN0cmluZywgbm93ID0gbmV3IERhdGUoKSk6IEVkaXRvclBhZ2Uge1xuXHRjb25zdCBjcmVhdGVkQXQgPSBub3cudG9JU09TdHJpbmcoKTtcblx0cmV0dXJuIHtcblx0XHQuLi5wYWdlLFxuXHRcdGlkOiBjcmVhdGVQYWdlSWQoKSxcblx0XHR0aXRsZTogYCR7cGFnZS50aXRsZS50cmltKCkubGVuZ3RoID4gMCA/IHBhZ2UudGl0bGUudHJpbSgpIDogVU5USVRMRURfUEFHRX0gJHt0aXRsZVN1ZmZpeH1gLnRyaW0oKSxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0OiBjcmVhdGVkQXQsXG5cdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdGxhc3RTeW5jZWRBdDogbnVsbCxcblx0XHRsYXN0U3luY2VkVGl0bGU6IG51bGwsXG5cdFx0bGFzdFN5bmNlZENvbnRlbnQ6IG51bGwsXG5cdFx0bGFzdFN5bmNlZERlbGV0ZWRBdDogbnVsbCxcblx0XHRkaXJ0eTogdHJ1ZSxcblx0XHRzeW5jU3RhdHVzOiAnY29uZmxpY3QnLFxuXHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBudWxsXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXNzaW9uKHZhbHVlOiB1bmtub3duKTogRWRpdG9yU2Vzc2lvbiB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0aWYgKGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWUpKSB7XG5cdFx0cmV0dXJuIG1pZ3JhdGVMZWdhY3lTdGF0ZSh2YWx1ZSk7XG5cdH1cblxuXHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUucGFnZXMpKSB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRjb25zdCBwYWdlcyA9IHZhbHVlLnBhZ2VzXG5cdFx0Lm1hcCgocGFnZSwgaW5kZXgpID0+IG5vcm1hbGl6ZVBhZ2UocGFnZSwgaW5kZXgpKVxuXHRcdC5maWx0ZXIoKHBhZ2UpOiBwYWdlIGlzIEVkaXRvclBhZ2UgPT4gcGFnZSAhPT0gbnVsbCk7XG5cblx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRjb25zdCBhY3RpdmVQYWdlSWQgPVxuXHRcdHR5cGVvZiB2YWx1ZS5hY3RpdmVQYWdlSWQgPT09ICdzdHJpbmcnICYmXG5cdFx0cGFnZXMuc29tZSgocGFnZSkgPT4gcGFnZS5pZCA9PT0gdmFsdWUuYWN0aXZlUGFnZUlkICYmIHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKVxuXHRcdFx0PyB2YWx1ZS5hY3RpdmVQYWdlSWRcblx0XHRcdDogKHBhZ2VzLmZpbmQoKHBhZ2UpID0+IHBhZ2UuZGVsZXRlZEF0ID09PSBudWxsKT8uaWQgPz8gcGFnZXNbMF0uaWQpO1xuXG5cdHJldHVybiBlbnN1cmVWYWxpZEFjdGl2ZVBhZ2UoeyBwYWdlcywgYWN0aXZlUGFnZUlkIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUxlZ2FjeVN0YXRlKHN0YXRlOiBFZGl0b3JTdGF0ZSk6IEVkaXRvclNlc3Npb24ge1xuXHRjb25zdCBwYWdlID0gdXBkYXRlUGFnZVN0YXRlKGNyZWF0ZVBhZ2Uoc3RhdGUudGV4dCksIHN0YXRlKTtcblx0cmV0dXJuIHtcblx0XHRwYWdlczogW3BhZ2VdLFxuXHRcdGFjdGl2ZVBhZ2VJZDogcGFnZS5pZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVQYWdlKHZhbHVlOiB1bmtub3duLCBpbmRleDogbnVtYmVyKTogRWRpdG9yUGFnZSB8IG51bGwge1xuXHRpZiAoIWlzUmVjb3JkKHZhbHVlKSkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgY29udGVudCA9XG5cdFx0dHlwZW9mIHZhbHVlLmNvbnRlbnQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmNvbnRlbnRcblx0XHRcdDogdHlwZW9mIHZhbHVlLnRleHQgPT09ICdzdHJpbmcnXG5cdFx0XHRcdD8gdmFsdWUudGV4dFxuXHRcdFx0XHQ6ICcnO1xuXHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IGNvbnRlbnQucmVwbGFjZSgvXFxyXFxuPy9nLCAnXFxuJyk7XG5cdGNvbnN0IHNlbGVjdGlvblN0YXJ0ID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvblN0YXJ0ID09PSAnbnVtYmVyJyA/IHZhbHVlLnNlbGVjdGlvblN0YXJ0IDogMCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3Qgc2VsZWN0aW9uRW5kID0gY2xhbXBTZWxlY3Rpb24oXG5cdFx0dHlwZW9mIHZhbHVlLnNlbGVjdGlvbkVuZCA9PT0gJ251bWJlcicgPyB2YWx1ZS5zZWxlY3Rpb25FbmQgOiBzZWxlY3Rpb25TdGFydCxcblx0XHRub3JtYWxpemVkQ29udGVudC5sZW5ndGhcblx0KTtcblx0Y29uc3QgY3JlYXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUuY3JlYXRlZEF0ID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5jcmVhdGVkQXQubGVuZ3RoID4gMFxuXHRcdFx0PyB2YWx1ZS5jcmVhdGVkQXRcblx0XHRcdDogdHlwZW9mIHZhbHVlLmNyZWF0ZWRfYXQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmNyZWF0ZWRfYXQubGVuZ3RoID4gMFxuXHRcdFx0XHQ/IHZhbHVlLmNyZWF0ZWRfYXRcblx0XHRcdFx0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdGNvbnN0IHVwZGF0ZWRBdCA9XG5cdFx0dHlwZW9mIHZhbHVlLnVwZGF0ZWRBdCA9PT0gJ3N0cmluZycgJiYgdmFsdWUudXBkYXRlZEF0Lmxlbmd0aCA+IDBcblx0XHRcdD8gdmFsdWUudXBkYXRlZEF0XG5cdFx0XHQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblx0Y29uc3QgZGVsZXRlZEF0ID1cblx0XHR0eXBlb2YgdmFsdWUuZGVsZXRlZEF0ID09PSAnc3RyaW5nJ1xuXHRcdFx0PyB2YWx1ZS5kZWxldGVkQXRcblx0XHRcdDogdHlwZW9mIHZhbHVlLmRlbGV0ZWRfYXQgPT09ICdzdHJpbmcnXG5cdFx0XHRcdD8gdmFsdWUuZGVsZXRlZF9hdFxuXHRcdFx0XHQ6IG51bGw7XG5cdGNvbnN0IGxhc3RTeW5jZWRBdCA9XG5cdFx0dHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRBdCA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZEF0XG5cdFx0XHQ6IHR5cGVvZiB2YWx1ZS5sYXN0U3luY2VkVmVyc2lvbiA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkVmVyc2lvblxuXHRcdFx0XHQ6IG51bGw7XG5cdGNvbnN0IGxhc3RTeW5jZWRUaXRsZSA9XG5cdFx0dHlwZW9mIHZhbHVlLmxhc3RTeW5jZWRUaXRsZSA9PT0gJ3N0cmluZydcblx0XHRcdD8gdmFsdWUubGFzdFN5bmNlZFRpdGxlXG5cdFx0XHQ6IGxhc3RTeW5jZWRBdFxuXHRcdFx0XHQ/IHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZydcblx0XHRcdFx0XHQ/IHZhbHVlLnRpdGxlLnRyaW0oKVxuXHRcdFx0XHRcdDogZGVyaXZlUGFnZVRpdGxlKG5vcm1hbGl6ZWRDb250ZW50KVxuXHRcdFx0XHQ6IG51bGw7XG5cdGNvbnN0IGxhc3RTeW5jZWRDb250ZW50ID1cblx0XHR0eXBlb2YgdmFsdWUubGFzdFN5bmNlZENvbnRlbnQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWRDb250ZW50XG5cdFx0XHQ6IGxhc3RTeW5jZWRBdFxuXHRcdFx0XHQ/IG5vcm1hbGl6ZWRDb250ZW50XG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgbGFzdFN5bmNlZERlbGV0ZWRBdCA9XG5cdFx0dHlwZW9mIHZhbHVlLmxhc3RTeW5jZWREZWxldGVkQXQgPT09ICdzdHJpbmcnXG5cdFx0XHQ/IHZhbHVlLmxhc3RTeW5jZWREZWxldGVkQXRcblx0XHRcdDogbGFzdFN5bmNlZEF0XG5cdFx0XHRcdD8gZGVsZXRlZEF0XG5cdFx0XHRcdDogbnVsbDtcblx0Y29uc3QgZGlydHkgPVxuXHRcdHR5cGVvZiB2YWx1ZS5kaXJ0eSA9PT0gJ2Jvb2xlYW4nXG5cdFx0XHQ/IHZhbHVlLmRpcnR5XG5cdFx0XHQ6IGxhc3RTeW5jZWRBdCA9PT0gbnVsbDtcblx0Y29uc3Qgc3luY1N0YXR1cyA9IG5vcm1hbGl6ZVN5bmNTdGF0dXModmFsdWUuc3luY1N0YXR1cywgZGVsZXRlZEF0LCBkaXJ0eSwgbGFzdFN5bmNlZEF0KTtcblxuXHRyZXR1cm4ge1xuXHRcdGlkOiB0eXBlb2YgdmFsdWUuaWQgPT09ICdzdHJpbmcnICYmIHZhbHVlLmlkLmxlbmd0aCA+IDAgPyB2YWx1ZS5pZCA6IGBwYWdlLSR7aW5kZXggKyAxfWAsXG5cdFx0dGl0bGU6XG5cdFx0XHR0eXBlb2YgdmFsdWUudGl0bGUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRpdGxlLnRyaW0oKS5sZW5ndGggPiAwXG5cdFx0PyB2YWx1ZS50aXRsZS50cmltKClcblx0XHRcdFx0OiBkZXJpdmVQYWdlVGl0bGUobm9ybWFsaXplZENvbnRlbnQpLFxuXHRcdGNvbnRlbnQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHRleHQ6IG5vcm1hbGl6ZWRDb250ZW50LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZCxcblx0XHRjcmVhdGVkQXQsXG5cdFx0dXBkYXRlZEF0LFxuXHRcdGRlbGV0ZWRBdCxcblx0XHRsYXN0U3luY2VkQXQsXG5cdFx0bGFzdFN5bmNlZFRpdGxlLFxuXHRcdGxhc3RTeW5jZWRDb250ZW50LFxuXHRcdGxhc3RTeW5jZWREZWxldGVkQXQsXG5cdFx0ZGlydHksXG5cdFx0c3luY1N0YXR1cyxcblx0XHRsYXN0U3luY2VkVmVyc2lvbjpcblx0XHRcdHR5cGVvZiB2YWx1ZS5sYXN0U3luY2VkVmVyc2lvbiA9PT0gJ3N0cmluZydcblx0XHRcdFx0PyB2YWx1ZS5sYXN0U3luY2VkVmVyc2lvblxuXHRcdFx0XHQ6IGxhc3RTeW5jZWRBdFxuXHRcdFx0XHRcdD8gbGFzdFN5bmNlZEF0XG5cdFx0XHRcdFx0OiB0eXBlb2YgdmFsdWUuc2VydmVyVmVyc2lvbiA9PT0gJ3N0cmluZydcblx0XHRcdFx0XHRcdD8gdmFsdWUuc2VydmVyVmVyc2lvblxuXHRcdFx0XHRcdFx0OiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzTGVnYWN5RWRpdG9yU3RhdGUodmFsdWU6IG9iamVjdCk6IHZhbHVlIGlzIEVkaXRvclN0YXRlIHtcblx0cmV0dXJuICd0ZXh0JyBpbiB2YWx1ZSAmJiAnc2VsZWN0aW9uU3RhcnQnIGluIHZhbHVlICYmICdzZWxlY3Rpb25FbmQnIGluIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jztcbn1cblxuZnVuY3Rpb24gY2xhbXBTZWxlY3Rpb24odmFsdWU6IG51bWJlciwgbWF4OiBudW1iZXIpIHtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3luY1N0YXR1cyhcblx0dmFsdWU6IHVua25vd24sXG5cdGRlbGV0ZWRBdDogc3RyaW5nIHwgbnVsbCxcblx0ZGlydHk6IGJvb2xlYW4sXG5cdGxhc3RTeW5jZWRBdDogc3RyaW5nIHwgbnVsbFxuKTogUGFnZVN5bmNTdGF0dXMge1xuXHRpZiAoXG5cdFx0dmFsdWUgPT09ICdsb2NhbC1vbmx5JyB8fFxuXHRcdHZhbHVlID09PSAnc3luY2VkJyB8fFxuXHRcdHZhbHVlID09PSAnZGlydHknIHx8XG5cdFx0dmFsdWUgPT09ICdkZWxldGVkJyB8fFxuXHRcdHZhbHVlID09PSAnY29uZmxpY3QnIHx8XG5cdFx0dmFsdWUgPT09ICdpbmNvbnNpc3RlbnQnXG5cdCkge1xuXHRcdHJldHVybiB2YWx1ZTtcblx0fVxuXG5cdGlmIChkZWxldGVkQXQpIHtcblx0XHRyZXR1cm4gJ2RlbGV0ZWQnO1xuXHR9XG5cblx0aWYgKGRpcnR5KSB7XG5cdFx0cmV0dXJuIGxhc3RTeW5jZWRBdCA/ICdkaXJ0eScgOiAnbG9jYWwtb25seSc7XG5cdH1cblxuXHRyZXR1cm4gbGFzdFN5bmNlZEF0ID8gJ3N5bmNlZCcgOiAnbG9jYWwtb25seSc7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVBhZ2VJZCgpIHtcblx0cmV0dXJuIGBwYWdlLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfWA7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBTdXBhYmFzZUNsaWVudCB9IGZyb20gJ0BzdXBhYmFzZS9zdXBhYmFzZS1qcyc7XG5pbXBvcnQge1xuXHRhcHBseVJlbW90ZVBhZ2VTdGF0ZSxcblx0Y3JlYXRlU2Vzc2lvbixcblx0ZW5zdXJlVmFsaWRBY3RpdmVQYWdlLFxuXHR0eXBlIEVkaXRvclBhZ2UsXG5cdHR5cGUgRWRpdG9yU2Vzc2lvbixcblx0VU5USVRMRURfUEFHRVxufSBmcm9tICcuLi9jb3JlL3Nlc3Npb24nO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZVBhZ2VSZWNvcmQge1xuXHRpZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRjb250ZW50OiBzdHJpbmc7XG5cdGNyZWF0ZWRfYXQ/OiBzdHJpbmc7XG5cdHVwZGF0ZWRfYXQ/OiBzdHJpbmc7XG5cdGRlbGV0ZWRfYXQ/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZUFwcFN0YXRlIHtcblx0YWN0aXZlUGFnZUlkOiBzdHJpbmcgfCBudWxsO1xuXHRwYWdlczogUmVtb3RlUGFnZVJlY29yZFtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZVN5bmNSZXN1bHQge1xuXHRwYWdlSWRNYXA6IE1hcDxzdHJpbmcsIHN0cmluZz47XG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nIHwgbnVsbDtcbn1cblxuY29uc3QgVVVJRF9QQVRURVJOID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMS01XVswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcblxuZXhwb3J0IGZ1bmN0aW9uIGhhc1Nlc3Npb25Db250ZW50KHNlc3Npb246IEVkaXRvclNlc3Npb24pOiBib29sZWFuIHtcblx0aWYgKHNlc3Npb24ucGFnZXMubGVuZ3RoID4gMSkge1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0Y29uc3QgW3BhZ2VdID0gc2Vzc2lvbi5wYWdlcztcblx0aWYgKCFwYWdlKSB7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0cmV0dXJuIHBhZ2UuY29udGVudC50cmltKCkubGVuZ3RoID4gMCB8fCBwYWdlLnRpdGxlICE9PSBVTlRJVExFRF9QQUdFO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzUmVtb3RlQ29udGVudChyZW1vdGU6IFJlbW90ZUFwcFN0YXRlKTogYm9vbGVhbiB7XG5cdHJldHVybiByZW1vdGUucGFnZXMubGVuZ3RoID4gMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2Vzc2lvbkZyb21SZW1vdGUocmVtb3RlOiBSZW1vdGVBcHBTdGF0ZSk6IEVkaXRvclNlc3Npb24ge1xuXHRpZiAocmVtb3RlLnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG5cdH1cblxuXHRjb25zdCBwYWdlczogRWRpdG9yUGFnZVtdID0gcmVtb3RlLnBhZ2VzLm1hcCgocGFnZSkgPT4ge1xuXHRcdGNvbnN0IGNyZWF0ZWRBdCA9IHBhZ2UuY3JlYXRlZF9hdCA/PyBwYWdlLnVwZGF0ZWRfYXQgPz8gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRcdGNvbnN0IHVwZGF0ZWRBdCA9IHBhZ2UudXBkYXRlZF9hdCA/PyBwYWdlLmNyZWF0ZWRfYXQgPz8gY3JlYXRlZEF0O1xuXHRcdHJldHVybiBhcHBseVJlbW90ZVBhZ2VTdGF0ZShcblx0XHRcdHtcblx0XHRcdFx0aWQ6IHBhZ2UuaWQsXG5cdFx0XHRcdHRpdGxlOiBwYWdlLnRpdGxlLFxuXHRcdFx0XHRjb250ZW50OiBwYWdlLmNvbnRlbnQsXG5cdFx0XHRcdHRleHQ6IHBhZ2UuY29udGVudCxcblx0XHRcdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0XHRcdHNlbGVjdGlvbkVuZDogMCxcblx0XHRcdFx0Y3JlYXRlZEF0LFxuXHRcdFx0XHR1cGRhdGVkQXQ6IGNyZWF0ZWRBdCxcblx0XHRcdFx0ZGVsZXRlZEF0OiBudWxsLFxuXHRcdFx0XHRsYXN0U3luY2VkQXQ6IG51bGwsXG5cdFx0XHRcdGxhc3RTeW5jZWRUaXRsZTogbnVsbCxcblx0XHRcdFx0bGFzdFN5bmNlZENvbnRlbnQ6IG51bGwsXG5cdFx0XHRcdGxhc3RTeW5jZWREZWxldGVkQXQ6IG51bGwsXG5cdFx0XHRcdGRpcnR5OiB0cnVlLFxuXHRcdFx0XHRzeW5jU3RhdHVzOiAnbG9jYWwtb25seScsXG5cdFx0XHRcdGxhc3RTeW5jZWRWZXJzaW9uOiBudWxsXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRcdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdFx0XHRkZWxldGVkQXQ6IHBhZ2UuZGVsZXRlZF9hdCA/PyBudWxsLFxuXHRcdFx0XHRjcmVhdGVkQXQsXG5cdFx0XHRcdHVwZGF0ZWRBdFxuXHRcdFx0fVxuXHRcdCk7XG5cdH0pO1xuXG5cdGNvbnN0IGFjdGl2ZVBhZ2VJZCA9XG5cdFx0cmVtb3RlLmFjdGl2ZVBhZ2VJZCAmJiBwYWdlcy5zb21lKChwYWdlKSA9PiBwYWdlLmlkID09PSByZW1vdGUuYWN0aXZlUGFnZUlkKVxuXHRcdFx0PyByZW1vdGUuYWN0aXZlUGFnZUlkXG5cdFx0XHQ6IChwYWdlc1swXT8uaWQgPz8gY3JlYXRlU2Vzc2lvbigpLmFjdGl2ZVBhZ2VJZCk7XG5cblx0cmV0dXJuIHtcblx0XHRwYWdlcyxcblx0XHRhY3RpdmVQYWdlSWRcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UGFnZUlkTWFwKFxuXHRzZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRwYWdlSWRNYXA6IE1hcDxzdHJpbmcsIHN0cmluZz4sXG5cdGFjdGl2ZVBhZ2VJZCA9IHNlc3Npb24uYWN0aXZlUGFnZUlkXG4pOiBFZGl0b3JTZXNzaW9uIHtcblx0aWYgKHBhZ2VJZE1hcC5zaXplID09PSAwICYmIGFjdGl2ZVBhZ2VJZCA9PT0gc2Vzc2lvbi5hY3RpdmVQYWdlSWQpIHtcblx0XHRyZXR1cm4gc2Vzc2lvbjtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0cGFnZXM6IHNlc3Npb24ucGFnZXMubWFwKChwYWdlKSA9PiAoe1xuXHRcdFx0Li4ucGFnZSxcblx0XHRcdGlkOiBwYWdlSWRNYXAuZ2V0KHBhZ2UuaWQpID8/IHBhZ2UuaWRcblx0XHR9KSksXG5cdFx0YWN0aXZlUGFnZUlkOiBwYWdlSWRNYXAuZ2V0KGFjdGl2ZVBhZ2VJZCkgPz8gYWN0aXZlUGFnZUlkXG5cdH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUmVtb3RlU2Vzc2lvbihcblx0c3VwYWJhc2U6IFN1cGFiYXNlQ2xpZW50LFxuXHR1c2VySWQ6IHN0cmluZ1xuKTogUHJvbWlzZTxSZW1vdGVBcHBTdGF0ZT4ge1xuXHRjb25zdCBbeyBkYXRhOiBwYWdlcywgZXJyb3I6IHBhZ2VzRXJyb3IgfSwgeyBkYXRhOiBzZXR0aW5ncywgZXJyb3I6IHNldHRpbmdzRXJyb3IgfV0gPVxuXHRcdGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdHN1cGFiYXNlXG5cdFx0XHRcdC5mcm9tKCdwYWdlcycpXG5cdFx0XHRcdC5zZWxlY3QoJ2lkLHRpdGxlLGNvbnRlbnQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0LGRlbGV0ZWRfYXQnKVxuXHRcdFx0XHQuZXEoJ3VzZXJfaWQnLCB1c2VySWQpXG5cdFx0XHRcdC5vcmRlcignY3JlYXRlZF9hdCcsIHsgYXNjZW5kaW5nOiB0cnVlIH0pLFxuXHRcdFx0c3VwYWJhc2UuZnJvbSgndXNlcl9zZXR0aW5ncycpLnNlbGVjdCgnYWN0aXZlX3BhZ2VfaWQnKS5lcSgndXNlcl9pZCcsIHVzZXJJZCkubWF5YmVTaW5nbGUoKVxuXHRcdF0pO1xuXG5cdGlmIChwYWdlc0Vycm9yKSB7XG5cdFx0dGhyb3cgcGFnZXNFcnJvcjtcblx0fVxuXG5cdGlmIChzZXR0aW5nc0Vycm9yKSB7XG5cdFx0dGhyb3cgc2V0dGluZ3NFcnJvcjtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0YWN0aXZlUGFnZUlkOiBzZXR0aW5ncz8uYWN0aXZlX3BhZ2VfaWQgPz8gbnVsbCxcblx0XHRwYWdlczogcGFnZXMgPz8gW11cblx0fTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVSZW1vdGVTZXNzaW9uKFxuXHRzdXBhYmFzZTogU3VwYWJhc2VDbGllbnQsXG5cdHVzZXJJZDogc3RyaW5nLFxuXHRzZXNzaW9uOiBFZGl0b3JTZXNzaW9uLFxuXHRjdXJyZW50UmVtb3RlPzogUmVtb3RlQXBwU3RhdGVcbik6IFByb21pc2U8UmVtb3RlU3luY1Jlc3VsdD4ge1xuXHRjb25zdCBub3JtYWxpemVkU2Vzc2lvbiA9IGVuc3VyZVZhbGlkQWN0aXZlUGFnZShzZXNzaW9uKTtcblx0Y29uc3QgY3VycmVudFJlbW90ZVBhZ2VzID1cblx0XHRjdXJyZW50UmVtb3RlPy5wYWdlcyA/PyAoYXdhaXQgcmVhZFJlbW90ZVNlc3Npb24oc3VwYWJhc2UsIHVzZXJJZCkpLnBhZ2VzO1xuXHRjb25zdCByZW1vdGVQYWdlTWFwID0gbmV3IE1hcChjdXJyZW50UmVtb3RlUGFnZXMubWFwKChwYWdlKSA9PiBbcGFnZS5pZCwgcGFnZV0pKTtcblx0Y29uc3QgcmVtb3RlUGFnZXNUb1NhdmUgPSBub3JtYWxpemVkU2Vzc2lvbi5wYWdlcy5maWx0ZXIoKHBhZ2UpID0+IGlzUmVtb3RlUGFnZUlkKHBhZ2UuaWQpKTtcblx0Y29uc3QgbG9jYWxQYWdlcyA9IG5vcm1hbGl6ZWRTZXNzaW9uLnBhZ2VzLmZpbHRlcihcblx0XHQocGFnZSkgPT4gIWlzUmVtb3RlUGFnZUlkKHBhZ2UuaWQpICYmIHNob3VsZEluc2VydExvY2FsUGFnZShub3JtYWxpemVkU2Vzc2lvbiwgcGFnZSlcblx0KTtcblx0Y29uc3QgcGFnZXNUb1VwZGF0ZSA9IHJlbW90ZVBhZ2VzVG9TYXZlLmZpbHRlcigocGFnZSkgPT4ge1xuXHRcdGNvbnN0IGN1cnJlbnRQYWdlID0gcmVtb3RlUGFnZU1hcC5nZXQocGFnZS5pZCk7XG5cdFx0Y29uc3QgY3VycmVudERlbGV0ZWRBdCA9IGN1cnJlbnRQYWdlPy5kZWxldGVkX2F0ID8/IG51bGw7XG5cdFx0Y29uc3QgbG9jYWxEZWxldGVkQXQgPSBwYWdlLmRlbGV0ZWRBdCA/PyBudWxsO1xuXHRcdHJldHVybiAoXG5cdFx0XHQhY3VycmVudFBhZ2UgfHxcblx0XHRcdGN1cnJlbnRQYWdlLnRpdGxlICE9PSBwYWdlLnRpdGxlIHx8XG5cdFx0XHRjdXJyZW50UGFnZS5jb250ZW50ICE9PSBwYWdlLmNvbnRlbnQgfHxcblx0XHRcdGN1cnJlbnREZWxldGVkQXQgIT09IGxvY2FsRGVsZXRlZEF0XG5cdFx0KTtcblx0fSk7XG5cblx0aWYgKHBhZ2VzVG9VcGRhdGUubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IHsgZXJyb3I6IHVwc2VydEVycm9yIH0gPSBhd2FpdCBzdXBhYmFzZS5mcm9tKCdwYWdlcycpLnVwc2VydChcblx0XHRcdHBhZ2VzVG9VcGRhdGUubWFwKChwYWdlKSA9PiAoe1xuXHRcdFx0XHRpZDogcGFnZS5pZCxcblx0XHRcdFx0dXNlcl9pZDogdXNlcklkLFxuXHRcdFx0XHR0aXRsZTogcGFnZS50aXRsZSxcblx0XHRcdFx0Y29udGVudDogcGFnZS5jb250ZW50LFxuXHRcdFx0XHRkZWxldGVkX2F0OiBwYWdlLmRlbGV0ZWRBdCA/PyBudWxsLFxuXHRcdFx0XHR1cGRhdGVkX2F0OiBwYWdlLnVwZGF0ZWRBdFxuXHRcdFx0fSkpXG5cdFx0KTtcblxuXHRcdGlmICh1cHNlcnRFcnJvcikge1xuXHRcdFx0dGhyb3cgdXBzZXJ0RXJyb3I7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgcGFnZUlkTWFwID0gYXdhaXQgaW5zZXJ0UGFnZXMoc3VwYWJhc2UsIHVzZXJJZCwgbG9jYWxQYWdlcyk7XG5cblx0Y29uc3QgYWN0aXZlUGFnZUlkID1cblx0XHRwYWdlSWRNYXAuZ2V0KG5vcm1hbGl6ZWRTZXNzaW9uLmFjdGl2ZVBhZ2VJZCkgPz8gbm9ybWFsaXplZFNlc3Npb24uYWN0aXZlUGFnZUlkO1xuXHRjb25zdCByZW1vdGVBY3RpdmVQYWdlSWQgPSBjdXJyZW50UmVtb3RlPy5hY3RpdmVQYWdlSWQgPz8gbnVsbDtcblx0aWYgKHJlbW90ZUFjdGl2ZVBhZ2VJZCAhPT0gKGlzUmVtb3RlUGFnZUlkKGFjdGl2ZVBhZ2VJZCkgPyBhY3RpdmVQYWdlSWQgOiBudWxsKSkge1xuXHRcdGF3YWl0IHVwc2VydFVzZXJTZXR0aW5ncyhzdXBhYmFzZSwgdXNlcklkLCBpc1JlbW90ZVBhZ2VJZChhY3RpdmVQYWdlSWQpID8gYWN0aXZlUGFnZUlkIDogbnVsbCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHBhZ2VJZE1hcCxcblx0XHRhY3RpdmVQYWdlSWQ6IGlzUmVtb3RlUGFnZUlkKGFjdGl2ZVBhZ2VJZCkgPyBhY3RpdmVQYWdlSWQgOiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIGlzUmVtb3RlUGFnZUlkKGlkOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIFVVSURfUEFUVEVSTi50ZXN0KGlkKTtcbn1cblxuZnVuY3Rpb24gc2hvdWxkSW5zZXJ0TG9jYWxQYWdlKHNlc3Npb246IEVkaXRvclNlc3Npb24sIHBhZ2U6IEVkaXRvclBhZ2UpOiBib29sZWFuIHtcblx0Ly8gVGhlIGluaXRpYWwgYm9vdHN0cmFwIG5vdGUgaXMgYSBzaW5nbGUsIGFjdGl2ZSwgZW1wdHkvdW50aXRsZWQgbG9jYWwtb25seSBwYWdlLlxuXHQvLyBEbyBub3Qgc3luYyB0aGF0IHBsYWNlaG9sZGVyIHVudGlsIHRoZSB1c2VyIGNyZWF0ZXMgcmVhbCBjb250ZW50L25vdGVzLlxuXHRjb25zdCBpc0Jvb3RzdHJhcFBsYWNlaG9sZGVyID1cblx0XHRzZXNzaW9uLnBhZ2VzLmxlbmd0aCA9PT0gMSAmJlxuXHRcdHNlc3Npb24uYWN0aXZlUGFnZUlkID09PSBwYWdlLmlkICYmXG5cdFx0cGFnZS5kZWxldGVkQXQgPT09IG51bGwgJiZcblx0XHRwYWdlLmNvbnRlbnQubGVuZ3RoID09PSAwICYmXG5cdFx0cGFnZS50aXRsZSA9PT0gVU5USVRMRURfUEFHRSAmJlxuXHRcdHBhZ2UubGFzdFN5bmNlZEF0ID09PSBudWxsICYmXG5cdFx0cGFnZS5sYXN0U3luY2VkVmVyc2lvbiA9PT0gbnVsbCAmJlxuXHRcdHBhZ2Uuc3luY1N0YXR1cyA9PT0gJ2xvY2FsLW9ubHknO1xuXG5cdHJldHVybiAhaXNCb290c3RyYXBQbGFjZWhvbGRlcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW5zZXJ0UGFnZXMoXG5cdHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCxcblx0dXNlcklkOiBzdHJpbmcsXG5cdHBhZ2VzOiBFZGl0b3JQYWdlW11cbik6IFByb21pc2U8TWFwPHN0cmluZywgc3RyaW5nPj4ge1xuXHRjb25zdCBwYWdlSWRNYXAgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXG5cdGZvciAoY29uc3QgcGFnZSBvZiBwYWdlcykge1xuXHRcdGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlXG5cdFx0XHQuZnJvbSgncGFnZXMnKVxuXHRcdFx0Lmluc2VydCh7XG5cdFx0XHRcdHVzZXJfaWQ6IHVzZXJJZCxcblx0XHRcdFx0dGl0bGU6IHBhZ2UudGl0bGUsXG5cdFx0XHRcdGNvbnRlbnQ6IHBhZ2UuY29udGVudCxcblx0XHRcdFx0ZGVsZXRlZF9hdDogcGFnZS5kZWxldGVkQXQgPz8gbnVsbCxcblx0XHRcdFx0dXBkYXRlZF9hdDogcGFnZS51cGRhdGVkQXRcblx0XHRcdH0pXG5cdFx0XHQuc2VsZWN0KCdpZCcpXG5cdFx0XHQuc2luZ2xlKCk7XG5cblx0XHRpZiAoZXJyb3IpIHtcblx0XHRcdHRocm93IGVycm9yO1xuXHRcdH1cblxuXHRcdHBhZ2VJZE1hcC5zZXQocGFnZS5pZCwgZGF0YS5pZCk7XG5cdH1cblxuXHRyZXR1cm4gcGFnZUlkTWFwO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1cHNlcnRVc2VyU2V0dGluZ3MoXG5cdHN1cGFiYXNlOiBTdXBhYmFzZUNsaWVudCxcblx0dXNlcklkOiBzdHJpbmcsXG5cdGFjdGl2ZVBhZ2VJZDogc3RyaW5nIHwgbnVsbFxuKSB7XG5cdGNvbnN0IHsgZXJyb3IgfSA9IGF3YWl0IHN1cGFiYXNlLmZyb20oJ3VzZXJfc2V0dGluZ3MnKS51cHNlcnQoe1xuXHRcdHVzZXJfaWQ6IHVzZXJJZCxcblx0XHRhY3RpdmVfcGFnZV9pZDogYWN0aXZlUGFnZUlkXG5cdH0pO1xuXG5cdGlmIChlcnJvcikge1xuXHRcdHRocm93IGVycm9yO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDd0JaLElBQU0sZ0JBQWdCO0FBRXRCLFNBQVMsZ0JBQWdCLFNBQXlCO0FBQ3hELFFBQU0sWUFBWSxRQUNoQixNQUFNLElBQUksRUFDVixJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixLQUFLLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQztBQUVoQyxNQUFJLENBQUMsV0FBVztBQUNmLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTyxVQUFVLFFBQVEsUUFBUSxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFDbEQ7QUFFTyxTQUFTLFdBQVcsVUFBVSxJQUFJLEtBQUssYUFBYSxHQUFlO0FBQ3pFLFFBQU0sYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUN6QyxTQUFPO0FBQUEsSUFDTjtBQUFBLElBQ0EsT0FBTyxnQkFBZ0Is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
