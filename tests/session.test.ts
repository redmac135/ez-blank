import test from 'node:test';
import assert from 'node:assert/strict';
import { ANONYMOUS_USERID, type PageSyncStatus } from '../src/lib/editor/persistence/records.ts';
import {
	clonePageForUser,
	createSession,
	derivePageTitle,
	ensureValidActivePage,
	getRemoteActivePageUpdateTarget,
	hasVisibleEphemeralActivePage,
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
	assert.equal(session.pages[0]?.isEphemeral, false);
	assert.equal(session.activePageId, session.pages[0]?.id);
});

test('normalizeSession repairs incomplete page data and keeps the most recently updated page active', () => {
	const session = normalizeSession({
		pages: [
			{
				id: 'p-1',
				content: 'alpha\r\nbeta',
				updatedAt: '2026-04-14T00:00:00.000Z'
			},
			{
				id: 'p-2',
				title: 'Saved',
				content: '',
				updatedAt: '2026-04-15T00:00:00.000Z'
			}
		],
		activePageId: 'missing'
	});

	assert.ok(session);
	assert.equal(session.pages.length, 2);
	const savedPage = session.pages[0];
	const repairedPage = session.pages[1];
	assert.ok(repairedPage);
	assert.ok(savedPage);
	assert.equal(savedPage?.title, 'Saved');
	assert.equal(repairedPage?.content, 'alpha\nbeta');
	assert.equal(repairedPage?.title, 'alpha');
	assert.equal(repairedPage?.userId, ANONYMOUS_USERID);
	assert.equal(session.activePageId, 'p-2');
});

test('createSession seeds a locally-owned dirty ephemeral page by default', () => {
	const session = createSession();
	const page = session.pages[0]!;

	assert.equal(page.title, 'Untitled');
	assert.equal(page.userId, ANONYMOUS_USERID);
	assert.equal(page.deletedAt, null);
	assert.equal(page.lastSyncedAt, null);
	assert.equal(page.lastKnownRemoteUpdatedAt, null);
	assert.equal(page.lastKnownRemoteDeletedAt, null);
	assert.equal(page.syncStatus, 'dirty');
	assert.equal(page.isEphemeral, true);
});

test('hasVisibleEphemeralActivePage detects a visible placeholder as active', () => {
	const session = createSession();
	assert.equal(hasVisibleEphemeralActivePage(session), true);

	const materialized = updatePageState(session.pages[0]!, {
		text: 'real note',
		selectionStart: 0,
		selectionEnd: 0
	});
	assert.equal(
		hasVisibleEphemeralActivePage({
			...session,
			pages: [materialized]
		}),
		false
	);
});

test('getRemoteActivePageUpdateTarget returns the newly selected real page', () => {
	const previous = ensureValidActivePage({
		activePageId: 'page-a',
		pages: [
			{
				...createSession().pages[0]!,
				id: 'page-a',
				title: 'A',
				content: 'alpha',
				text: 'alpha',
				isEphemeral: false
			},
			{
				...createSession().pages[0]!,
				id: 'page-b',
				title: 'B',
				content: 'beta',
				text: 'beta',
				isEphemeral: false
			}
		]
	});

	const next = {
		...previous,
		activePageId: 'page-b'
	};

	assert.equal(getRemoteActivePageUpdateTarget(previous, next), 'page-b');
});

test('getRemoteActivePageUpdateTarget returns the previous active page when add page promotes it', () => {
	const previous = createSession('user-a');
	const promoted = updatePageState(previous.pages[0]!, {
		text: 'real note',
		selectionStart: 0,
		selectionEnd: 0
	});
	const nextEphemeral = createSession('user-a').pages[0]!;

	const next = ensureValidActivePage({
		pages: [promoted, { ...nextEphemeral, id: 'page-b', userId: 'user-a' }],
		activePageId: 'page-b'
	});

	assert.equal(getRemoteActivePageUpdateTarget(previous, next), promoted.id);
});

test('updatePageState refreshes content, derives titles, and materializes the page', () => {
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
	assert.equal(page.isEphemeral, false);
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
	assert.equal(page.isEphemeral, false);
});

test('updatePageState keeps page sync metadata stable for selection-only updates', () => {
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
	assert.equal(selectionOnly.isEphemeral, initial.isEphemeral);
});

test('markPageDirty retargets copied pages to a new owner and clears remote state', () => {
	const session = createSession('user-a');
	const copied = markPageDirty(
		{
			...session.pages[0]!,
			syncStatus: 'synced' as PageSyncStatus,
			lastSyncedAt: '2026-04-14T00:00:00.000Z',
			lastKnownRemoteUpdatedAt: '2026-04-14T00:00:00.000Z',
			lastKnownRemoteDeletedAt: null,
			isEphemeral: false
		},
		'user-b'
	);

	assert.equal(copied.userId, 'user-b');
	assert.equal(copied.syncStatus, 'dirty');
	assert.equal(copied.lastSyncedAt, null);
	assert.equal(copied.lastKnownRemoteUpdatedAt, null);
	assert.equal(copied.lastKnownRemoteDeletedAt, null);
});

test('clonePageForUser creates a fresh local page id for imported anonymous data', () => {
	const session = createSession(ANONYMOUS_USERID);
	const source = {
		...session.pages[0]!,
		id: 'anon-page-1',
		title: 'Imported title',
		content: 'imported body',
		text: 'imported body',
		deletedAt: null,
		isEphemeral: false
	};

	const cloned = clonePageForUser(source, 'user-a');

	assert.notEqual(cloned.id, source.id);
	assert.equal(cloned.userId, 'user-a');
	assert.equal(cloned.title, 'Imported title');
	assert.equal(cloned.content, 'imported body');
	assert.equal(cloned.syncStatus, 'dirty');
	assert.equal(cloned.isEphemeral, false);
});

test('derivePageTitle falls back to Untitled for blank content', () => {
	assert.equal(derivePageTitle('   \n  '), 'Untitled');
});

test('ensureValidActivePage falls back to the most recently updated visible page when the active page is missing', () => {
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
				syncStatus: 'dirty',
				isEphemeral: false
			},
			{
				id: 'page-b',
				userId: ANONYMOUS_USERID,
				title: 'B',
				content: 'beta',
				text: 'beta',
				selectionStart: 0,
				selectionEnd: 0,
				createdAt: '2026-04-15T00:00:00.000Z',
				updatedAt: '2026-04-15T00:00:00.000Z',
				deletedAt: null,
				lastSyncedAt: null,
				lastKnownRemoteUpdatedAt: null,
				lastKnownRemoteDeletedAt: null,
				syncStatus: 'dirty',
				isEphemeral: false
			}
		]
	});

	assert.equal(repaired.pages[0]?.id, 'page-b');
	assert.equal(repaired.activePageId, 'page-b');
});
