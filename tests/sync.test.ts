import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, type EditorSession } from '../src/lib/editor/core/session.ts';
import { forkConflictNote, syncUserNotes } from '../src/lib/editor/sync.ts';
import type { NoteSyncStatus } from '../src/lib/editor/persistence/records.ts';

type RemoteRow = {
	id: string;
	user_id: string;
	title: string;
	content: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
};

class FakeSupabase {
	private notes = new Map<string, RemoteRow>();

	constructor(rows: RemoteRow[] = []) {
		for (const row of rows) {
			this.notes.set(row.id, { ...row });
		}
	}

	from(table: string) {
		assert.equal(table, 'notes');
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
						const rows = [...api.notes.values()].filter((row) => row.user_id === userId);
						return Promise.resolve(resolve({ data: rows, error: null }));
					}
				};
			},
			upsert(payload: RemoteRow) {
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

	getRows(userId: string) {
		return [...this.notes.values()].filter((row) => row.user_id === userId);
	}
}

function buildSession(page: ReturnType<typeof createPage>, activePageId = page.id): EditorSession {
	return {
		pages: [page],
		activePageId
	};
}

test('forkConflictNote creates a visible local fork with a new id and suffix', () => {
	const source = createPage('body', { id: 'note-1', userId: 'user-a', now: '2026-04-17T18:00:00.000Z' });
	source.title = 'My Note';
	source.deletedAt = '2026-04-17T18:05:00.000Z';

	const fork = forkConflictNote(source, new Date('2026-04-17T18:10:00.000Z'));

	assert.notEqual(fork.id, source.id);
	assert.equal(fork.userId, 'user-a');
	assert.equal(fork.deletedAt, null);
	assert.equal(fork.syncStatus, 'dirty');
	assert.match(fork.title, /^My Note \(Local conflict /);
});

test('syncUserNotes pushes local-only dirty notes and trusts the write response', async () => {
	const local = createPage('local body', { id: 'local-1', userId: 'user-a', now: '2026-04-17T18:00:00.000Z' });
	local.title = 'Local';
	local.updatedAt = '2026-04-17T18:01:00.000Z';

	const supabase = new FakeSupabase();
	const result = await syncUserNotes(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:02:00.000Z'));

	assert.equal(result.pushedCount, 1);
	assert.equal(result.conflictCount, 0);
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.equal(result.session.pages[0]?.lastSyncedAt, '2026-04-17T18:01:00.000Z');
	assert.equal(supabase.getRows('user-a').length, 1);
	assert.equal(supabase.getRows('user-a')[0]?.id, 'local-1');
});

test('syncUserNotes pulls remote-only notes into the local session', async () => {
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

	const result = await syncUserNotes(supabase as never, 'user-a', emptyLocal, new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.pulledCount, 1);
	assert.equal(result.session.pages.length, 1);
	assert.equal(result.session.pages[0]?.id, 'remote-1');
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.equal(result.session.pages[0]?.lastSyncedAt, '2026-04-17T18:00:00.000Z');
});

test('syncUserNotes forks when local and remote both changed', async () => {
	const local = createPage('local edit', { id: 'note-1', userId: 'user-a', now: '2026-04-17T18:00:00.000Z' });
	local.title = 'Shared';
	local.updatedAt = '2026-04-17T18:03:00.000Z';
	local.lastSyncedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteUpdatedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteDeletedAt = null;
	local.syncStatus = 'dirty' as NoteSyncStatus;

	const supabase = new FakeSupabase([
		{
			id: 'note-1',
			user_id: 'user-a',
			title: 'Shared',
			content: 'remote edit',
			created_at: '2026-04-17T18:00:00.000Z',
			updated_at: '2026-04-17T18:04:00.000Z',
			deleted_at: null
		}
	]);

	const result = await syncUserNotes(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.conflictCount, 1);
	assert.equal(result.pushedCount, 1);
	assert.equal(result.session.pages.length, 2);
	assert.equal(result.session.pages[0]?.id, 'note-1');
	assert.equal(result.session.pages[0]?.content, 'remote edit');
	assert.equal(result.session.pages[0]?.syncStatus, 'synced');
	assert.notEqual(result.session.pages[1]?.id, 'note-1');
	assert.match(result.session.pages[1]?.title ?? '', /^Shared \(Local conflict /);
	assert.equal(result.session.pages[1]?.content, 'local edit');
	assert.equal(result.session.pages[1]?.syncStatus, 'synced');
	assert.equal(result.session.pages[1]?.lastSyncedAt, result.session.pages[1]?.updatedAt);
	assert.equal(supabase.getRows('user-a').length, 2);
	assert.equal(supabase.getRows('user-a').some((row) => row.content === 'local edit'), true);
});

test('syncUserNotes handles remote delete versus local edit by forking the local edit', async () => {
	const local = createPage('keep me', { id: 'note-1', userId: 'user-a', now: '2026-04-17T18:00:00.000Z' });
	local.title = 'Conflict';
	local.updatedAt = '2026-04-17T18:03:00.000Z';
	local.lastSyncedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteUpdatedAt = '2026-04-17T18:01:00.000Z';
	local.lastKnownRemoteDeletedAt = null;
	local.syncStatus = 'dirty' as NoteSyncStatus;

	const supabase = new FakeSupabase([
		{
			id: 'note-1',
			user_id: 'user-a',
			title: 'Conflict',
			content: 'keep me',
			created_at: '2026-04-17T18:00:00.000Z',
			updated_at: '2026-04-17T18:04:00.000Z',
			deleted_at: '2026-04-17T18:04:00.000Z'
		}
	]);

	const result = await syncUserNotes(supabase as never, 'user-a', buildSession(local), new Date('2026-04-17T18:05:00.000Z'));

	assert.equal(result.conflictCount, 1);
	assert.equal(result.session.pages.length, 2);
	assert.equal(result.session.pages[0]?.deletedAt, '2026-04-17T18:04:00.000Z');
	assert.equal(result.session.pages[1]?.deletedAt, null);
	assert.match(result.session.pages[1]?.title ?? '', /^Conflict \(Local conflict /);
});
