import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ANONYMOUS_USERID,
	type NoteSyncStatus
} from '../src/lib/editor/persistence/records.ts';
import {
	clonePageForUser,
	createSession,
	derivePageTitle,
	ensureValidActivePage,
	markPageDirty,
	normalizeSession,
	updatePageState
} from '../src/lib/editor/core/session.ts';

test('normalizeSession migrates the legacy single-document state into one page', () => {
	const session = normalizeSession({
		text: '# Title\nbody',
		selectionStart: 2,
		selectionEnd: 2
	});

	assert.ok(session);
	assert.equal(session.pages.length, 1);
	assert.equal(session.pages[0]?.content, '# Title\nbody');
	assert.equal(session.pages[0]?.text, '# Title\nbody');
	assert.equal(session.pages[0]?.title, '# Title');
	assert.equal(session.pages[0]?.userId, ANONYMOUS_USERID);
	assert.equal(session.pages[0]?.syncStatus, 'dirty');
	assert.equal(session.activePageId, session.pages[0]?.id);
});

test('normalizeSession repairs incomplete page data and keeps the first page active', () => {
	const session = normalizeSession({
		pages: [{ content: 'alpha\r\nbeta' }, { id: 'p-2', title: 'Saved', content: '' }],
		activePageId: 'missing'
	});

	assert.ok(session);
	assert.equal(session.pages.length, 2);
	assert.equal(session.pages[0]?.content, 'alpha\nbeta');
	assert.equal(session.pages[0]?.title, 'alpha');
	assert.equal(session.pages[1]?.title, 'Saved');
	assert.equal(session.pages[0]?.userId, ANONYMOUS_USERID);
	assert.equal(session.activePageId, session.pages[0]?.id);
});

test('createSession seeds a locally-owned dirty note by default', () => {
	const session = createSession();
	const page = session.pages[0]!;

	assert.equal(page.title, 'Untitled');
	assert.equal(page.userId, ANONYMOUS_USERID);
	assert.equal(page.deletedAt, null);
	assert.equal(page.lastSyncedAt, null);
	assert.equal(page.lastKnownRemoteUpdatedAt, null);
	assert.equal(page.lastKnownRemoteDeletedAt, null);
	assert.equal(page.syncStatus, 'dirty');
});

test('updatePageState refreshes content and derives titles from the first non-empty line', () => {
	const session = createSession();
	const page = updatePageState(session.pages[0]!, {
		text: '\n\nconst value = 1;',
		selectionStart: 4,
		selectionEnd: 4
	});

	assert.equal(page.content, '\n\nconst value = 1;');
	assert.equal(page.title, 'const value = 1;');
	assert.equal(page.selectionStart, 4);
	assert.equal(page.selectionEnd, 4);
	assert.equal(page.syncStatus, 'dirty');
});

test('updatePageState keeps custom titles during content edits', () => {
	const session = createSession();
	const initial = session.pages[0]!;
	const customTitlePage = {
		...initial,
		title: 'Custom title'
	};

	const page = updatePageState(customTitlePage, {
		text: 'first line\nbody',
		selectionStart: 1,
		selectionEnd: 1
	});

	assert.equal(page.title, 'Custom title');
	assert.equal(page.content, 'first line\nbody');
});

test('updatePageState keeps note sync metadata stable for selection-only updates', () => {
	const session = createSession();
	const initial = updatePageState(session.pages[0]!, {
		text: 'alpha',
		selectionStart: 0,
		selectionEnd: 0
	});
	const selectionOnly = updatePageState(initial, {
		text: 'alpha',
		selectionStart: 2,
		selectionEnd: 2
	});

	assert.equal(selectionOnly.title, 'alpha');
	assert.equal(selectionOnly.updatedAt, initial.updatedAt);
	assert.equal(selectionOnly.selectionStart, 2);
	assert.equal(selectionOnly.selectionEnd, 2);
	assert.equal(selectionOnly.syncStatus, initial.syncStatus);
});

test('markPageDirty retargets copied notes to a new owner and clears remote state', () => {
	const session = createSession('user-a');
	const copied = markPageDirty(
		{
			...session.pages[0]!,
			syncStatus: 'synced' as NoteSyncStatus,
			lastSyncedAt: '2026-04-14T00:00:00.000Z',
			lastKnownRemoteUpdatedAt: '2026-04-14T00:00:00.000Z',
			lastKnownRemoteDeletedAt: null
		},
		'user-b'
	);

	assert.equal(copied.userId, 'user-b');
	assert.equal(copied.syncStatus, 'dirty');
	assert.equal(copied.lastSyncedAt, null);
	assert.equal(copied.lastKnownRemoteUpdatedAt, null);
	assert.equal(copied.lastKnownRemoteDeletedAt, null);
});

test('clonePageForUser creates a fresh local note id for imported anonymous data', () => {
	const session = createSession(ANONYMOUS_USERID);
	const source = {
		...session.pages[0]!,
		id: 'anon-note-1',
		title: 'Imported title',
		content: 'imported body',
		text: 'imported body',
		deletedAt: null
	};

	const cloned = clonePageForUser(source, 'user-a');

	assert.notEqual(cloned.id, source.id);
	assert.equal(cloned.userId, 'user-a');
	assert.equal(cloned.title, 'Imported title');
	assert.equal(cloned.content, 'imported body');
	assert.equal(cloned.syncStatus, 'dirty');
});

test('derivePageTitle falls back to Untitled for blank content', () => {
	assert.equal(derivePageTitle('   \n  '), 'Untitled');
});

test('ensureValidActivePage falls back to the first page when the active page is missing', () => {
	const repaired = ensureValidActivePage({
		activePageId: 'missing',
		pages: [
			{
				id: 'page-a',
				userId: ANONYMOUS_USERID,
				title: 'A',
				content: 'alpha',
				text: 'alpha',
				selectionStart: 0,
				selectionEnd: 0,
				createdAt: '2026-04-14T00:00:00.000Z',
				updatedAt: '2026-04-14T00:00:00.000Z',
				deletedAt: null,
				lastSyncedAt: null,
				lastKnownRemoteUpdatedAt: null,
				lastKnownRemoteDeletedAt: null,
				syncStatus: 'dirty'
			}
		]
	});

	assert.equal(repaired.activePageId, 'page-a');
});
