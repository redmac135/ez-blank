import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersionedSession } from '../src/lib/editor/versioned-sync.ts';
import { createSession } from '../src/lib/editor/session.ts';

test('resolveVersionedSession keeps local changes when remote has not changed', () => {
	const session = createSession();
	const page = session.pages[0]!;
	page.title = 'Note Title';
	page.content = 'local body';
	page.text = 'local body';
	page.updatedAt = '2026-04-15T16:12:00.000Z';
	page.lastSyncedVersion = '2026-04-14T16:12:00.000Z';

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
