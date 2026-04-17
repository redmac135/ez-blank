import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, type EditorSession } from '../src/lib/editor/core/session.ts';
import { fetchRemoteActivePageId, forkConflictPage, syncUserPages } from '../src/lib/editor/sync.ts';
import type { PageSyncStatus } from '../src/lib/editor/persistence/records.ts';

type RemotePageRow = {
	id: string;
	user_id: string;
	title: string;
	content: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
};

type UserSettingsRow = {
	user_id: string;
	active_page_id: string | null;
	created_at?: string;
	updated_at?: string;
};

class FakeSupabase {
	private pages = new Map<string, RemotePageRow>();
	private userSettings = new Map<string, UserSettingsRow>();

	constructor(rows: RemotePageRow[] = [], settings: UserSettingsRow[] = []) {
		for (const row of rows) {
			this.pages.set(row.id, { ...row });
		}
		for (const setting of settings) {
			this.userSettings.set(setting.user_id, { ...setting });
		}
	}

	from(table: string) {
		if (table === 'pages') {
			const api = this;
			return {
				select() {
					let userId = '';
					return {
						eq(column: string, value: string) {
							assert.equal(column, 'user_id');
							userId = value;
							return this;
						},
						order() {
							return this;
						},
						then(resolve: (value: unknown) => unknown) {
							const rows = [...api.pages.values()].filter((row) => row.user_id === userId);
							return Promise.resolve(resolve({ data: rows, error: null }));
						}
					};
				},
				upsert(payload: RemotePageRow) {
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

		if (table === 'user_settings') {
			const api = this;
			return {
				select() {
					let userId = '';
					return {
						eq(column: string, value: string) {
							assert.equal(column, 'user_id');
							userId = value;
							return this;
						},
						async maybeSingle() {
							return { data: api.userSettings.get(userId) ?? null, error: null };
						}
					};
				},
				async upsert(payload: UserSettingsRow) {
					api.userSettings.set(payload.user_id, { ...payload });
					return { error: null };
				}
			};
		}

		throw new Error(`Unexpected table ${table}`);
	}

	getRows(userId: string) {
		return [...this.pages.values()].filter((row) => row.user_id === userId);
	}

	getActivePageId(userId: string) {
		return this.userSettings.get(userId)?.active_page_id ?? null;
	}
}

function buildSession(page: ReturnType<typeof createPage>, activePageId = page.id): EditorSession {
	return {
		pages: [page],
		activePageId
	};
}

test('forkConflictPage creates a visible local fork with a new id and suffix', () => {
	const source = createPage('body', {
		id: 'page-1',
		userId: 'user-a',
		now: '2026-04-17T18:00:00.000Z',
		isEphemeral: false
	});
	source.title = 'My Page';
	source.deletedAt = '2026-04-17T18:05:00.000Z';

	const fork = forkConflictPage(source, new Date('2026-04-17T18:10:00.000Z'));

	assert.notEqual(fork.id, source.id);
	assert.equal(fork.userId, 'user-a');
	assert.equal(fork.deletedAt, null);
	assert.equal(fork.syncStatus, 'dirty');
	assert.equal(fork.isEphemeral, false);
	assert.match(fork.title, /^My Page \(Local conflict /);
});

test('fetchRemoteActivePageId reads remote user settings only when asked', async () => {
	const supabase = new FakeSupabase([], [{ user_id: 'user-a', active_page_id: 'page-2' }]);
	assert.equal(await fetchRemoteActivePageId(supabase as never, 'user-a'), 'page-2');
	assert.equal(await fetchRemoteActivePageId(supabase as never, 'user-b'), null);
});

test('syncUserPages ignores ephemeral placeholder pages', async () => {
	const local = createPage('', { id: 'page-ephemeral', userId: 'user-a', isEphemeral: true });
	const supabase = new FakeSupabase();
	const result = await syncUserPages(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:02:00.000Z'));

	assert.equal(result.pushedCount, 0);
	assert.equal(result.session.pages[0]?.id, 'page-ephemeral');
	assert.equal(result.session.pages[0]?.isEphemeral, true);
	assert.equal(supabase.getRows('user-a').length, 0);
	assert.equal(supabase.getActivePageId('user-a'), null);
});

test('syncUserPages pushes local-only real pages and trusts the write response', async () => {
	const local = createPage('local body', {
		id: 'local-1',
		userId: 'user-a',
		now: '2026-04-17T18:00:00.000Z',
		isEphemeral: false
	});
	local.title = 'Local';
	local.updatedAt = '2026-04-17T18:01:00.000Z';

	const supabase = new FakeSupabase();
	const result = await syncUserPages(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:02:00.000Z'));

	assert.equal(result.pushedCount, 1);
	assert.equal(result.conflictCount, 0);
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.equal(result.session.pages[0]?.lastSyncedAt, '2026-04-17T18:01:00.000Z');
	assert.equal(supabase.getRows('user-a').length, 1);
	assert.equal(supabase.getRows('user-a')[0]?.id, 'local-1');
	assert.equal(supabase.getActivePageId('user-a'), 'local-1');
});

test('syncUserPages pulls remote-only pages into the local session', async () => {
	const supabase = new FakeSupabase([
		{
			id: 'remote-1',
			user_id: 'user-a',
			title: 'Remote',
			content: 'remote body',
			created_at: '2026-04-17T18:00:00.000Z',
			updated_at: '2026-04-17T18:00:00.000Z',
			deleted_at: null
		}
	]);
	const emptyLocal: EditorSession = { pages: [], activePageId: 'missing' };

	const result = await syncUserPages(supabase as never, 'user-a', emptyLocal, new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.pulledCount, 1);
	assert.equal(result.session.pages.length, 1);
	assert.equal(result.session.pages[0]?.id, 'remote-1');
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.equal(result.session.pages[0]?.lastSyncedAt, '2026-04-17T18:00:00.000Z');
	assert.equal(result.session.pages[0]?.isEphemeral, false);
	assert.equal(supabase.getActivePageId('user-a'), 'remote-1');
});

test('syncUserPages forks when local and remote both changed', async () => {
	const local = createPage('local edit', {
		id: 'page-1',
		userId: 'user-a',
		now: '2026-04-17T18:00:00.000Z',
		isEphemeral: false
	});
	local.title = 'Shared';
	local.updatedAt = '2026-04-17T18:03:00.000Z';
	local.lastSyncedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteUpdatedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteDeletedAt = null;
	local.syncStatus = 'dirty' as PageSyncStatus;

	const supabase = new FakeSupabase([
		{
			id: 'page-1',
			user_id: 'user-a',
			title: 'Shared',
			content: 'remote edit',
			created_at: '2026-04-17T18:00:00.000Z',
			updated_at: '2026-04-17T18:04:00.000Z',
			deleted_at: null
		}
	]);

	const result = await syncUserPages(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.conflictCount, 1);
	assert.equal(result.pushedCount, 1);
	assert.equal(result.session.pages.length, 2);
	assert.equal(result.session.pages[0]?.id, 'page-1');
	assert.equal(result.session.pages[0]?.content, 'remote edit');
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.notEqual(result.session.pages[1]?.id, 'page-1');
	assert.match(result.session.pages[1]?.title ?? '', /^Shared \(Local conflict /);
	assert.equal(result.session.pages[1]?.content, 'local edit');
	assert.equal(result.session.pages[1]?.syncStatus, 'synced');
	assert.equal(result.session.pages[1]?.lastSyncedAt, result.session.pages[1]?.updatedAt);
	assert.equal(result.session.pages[1]?.isEphemeral, false);
	assert.equal(supabase.getRows('user-a').length, 2);
	assert.equal(supabase.getRows('user-a').some((row) => row.content === 'local edit'), true);
});

test('syncUserPages handles remote delete versus local edit by forking the local edit', async () => {
	const local = createPage('keep me', {
		id: 'page-1',
		userId: 'user-a',
		now: '2026-04-17T18:00:00.000Z',
		isEphemeral: false
	});
	local.title = 'Conflict';
	local.updatedAt = '2026-04-17T18:03:00.000Z';
	local.lastSyncedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteUpdatedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteDeletedAt = null;
	local.syncStatus = 'dirty' as PageSyncStatus;

	const supabase = new FakeSupabase([
		{
			id: 'page-1',
			user_id: 'user-a',
			title: 'Conflict',
			content: 'keep me',
			created_at: '2026-04-17T18:00:00.000Z',
			updated_at: '2026-04-17T18:04:00.000Z',
			deleted_at: '2026-04-17T18:04:00.000Z'
		}
	]);

	const result = await syncUserPages(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.conflictCount, 1);
	assert.equal(result.session.pages.length, 2);
	assert.equal(result.session.pages[0]?.deletedAt, '2026-04-17T18:04:00.000Z');
	assert.equal(result.session.pages[1]?.deletedAt, null);
	assert.match(result.session.pages[1]?.title ?? '', /^Conflict \(Local conflict /);
});
