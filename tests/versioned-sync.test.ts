import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersionedSession } from '../src/lib/editor/sync/versioned-sync.ts';
import { createSession } from '../src/lib/editor/core/session.ts';

test('resolveVersionedSession keeps local changes when remote has not changed', () => {
	const session = createSession();
	const page = session.pages[0]!;
	page.title = 'Note Title';
	page.content = 'local body';
	page.text = 'local body';
	page.updatedAt = '2026-04-15T16:12:00.000Z';
	page.lastSyncedVersion = '2026-04-14T16:12:00.000Z';
	page.lastSyncedAt = '2026-04-14T16:12:00.000Z';
	page.lastSyncedTitle = 'Note Title';
	page.lastSyncedContent = 'remote body';
	page.lastSyncedDeletedAt = null;
	page.dirty = true;
	page.syncStatus = 'dirty';

	const result = resolveVersionedSession(
		session,
		{
			activePageId: page.id,
			pages: [
				{
					id: page.id,
					title: 'Note Title',
					content: 'remote body',
					updated_at: '2026-04-14T16:12:00.000Z'
				}
			]
		},
		{
			pageVersions: {
				[page.id]: '2026-04-14T16:12:00.000Z'
			}
		},
		new Date('2026-04-15T16:12:00.000Z')
	);

	assert.equal(result.conflictCount, 0);
	assert.equal(result.session.pages[0]?.content, 'local body');
});

test('resolveVersionedSession creates a local conflict copy when both versions changed', () => {
	const session = createSession();
	const page = session.pages[0]!;
	page.title = 'Note Title';
	page.content = 'local body';
	page.text = 'local body';
	page.updatedAt = '2026-04-15T16:12:00.000Z';
	page.lastSyncedVersion = '2026-04-14T16:12:00.000Z';
	page.lastSyncedAt = '2026-04-14T16:12:00.000Z';
	page.lastSyncedTitle = 'Note Title';
	page.lastSyncedContent = 'base body';
	page.lastSyncedDeletedAt = null;
	page.dirty = true;
	page.syncStatus = 'dirty';

	const result = resolveVersionedSession(
		session,
		{
			activePageId: page.id,
			pages: [
				{
					id: page.id,
					title: 'Note Title',
					content: 'remote body',
					updated_at: '2026-04-15T15:12:00.000Z'
				}
			]
		},
		{
			pageVersions: {
				[page.id]: '2026-04-14T16:12:00.000Z'
			}
		},
		new Date('2026-04-15T16:12:00.000Z')
	);

	assert.equal(result.conflictCount, 1);
	assert.equal(result.session.pages.length, 2);
	assert.equal(result.session.pages[0]?.content, 'local body');
	assert.match(result.session.pages[0]?.title ?? '', /^Note Title \(Local conflict /);
	assert.equal(result.session.pages[1]?.content, 'remote body');
});

test('resolveVersionedSession does not create a conflict when content is identical', () => {
	const session = createSession();
	const page = session.pages[0]!;
	page.title = 'Note Title';
	page.content = 'shared body';
	page.text = 'shared body';
	page.updatedAt = '2026-04-15T16:12:00.000Z';
	page.lastSyncedVersion = '2026-04-14T16:12:00.000Z';
	page.lastSyncedAt = '2026-04-14T16:12:00.000Z';
	page.lastSyncedTitle = 'Note Title';
	page.lastSyncedContent = 'shared body';
	page.lastSyncedDeletedAt = null;
	page.dirty = true;
	page.syncStatus = 'dirty';

	const result = resolveVersionedSession(
		session,
		{
			activePageId: page.id,
			pages: [
				{
					id: page.id,
					title: 'Different title',
					content: 'shared body',
					updated_at: '2026-04-15T15:12:00.000Z'
				}
			]
		},
		{
			pageVersions: {
				[page.id]: '2026-04-14T16:12:00.000Z'
			}
		},
		new Date('2026-04-15T16:12:00.000Z')
	);

	assert.equal(result.conflictCount, 0);
	assert.equal(result.session.pages.length, 1);
	assert.equal(result.session.pages[0]?.content, 'shared body');
});

test('resolveVersionedSession keeps local tombstone when remote has stale non-deleted row', () => {
	const session = createSession();
	const page = session.pages[0]!;
	page.title = 'Deleted note';
	page.content = 'old body';
	page.text = 'old body';
	page.deletedAt = '2026-04-15T16:10:00.000Z';
	page.updatedAt = '2026-04-15T16:10:00.000Z';
	page.lastSyncedVersion = '2026-04-15T16:00:00.000Z';
	page.lastSyncedAt = '2026-04-15T16:00:00.000Z';
	page.lastSyncedTitle = 'Deleted note';
	page.lastSyncedContent = 'old body';
	page.lastSyncedDeletedAt = null;
	page.dirty = true;
	page.syncStatus = 'deleted';

	const result = resolveVersionedSession(
		session,
		{
			activePageId: page.id,
			pages: [
				{
					id: page.id,
					title: 'Deleted note',
					content: 'old body',
					updated_at: '2026-04-15T16:05:00.000Z',
					deleted_at: null
				}
			]
		},
		{
			pageVersions: {
				[page.id]: '2026-04-15T16:05:00.000Z'
			}
		},
		new Date('2026-04-15T16:12:00.000Z')
	);

	assert.equal(result.conflictCount, 0);
	assert.equal(result.updatedFromRemote, false);
	assert.equal(result.session.pages[0]?.deletedAt, '2026-04-15T16:10:00.000Z');
});
