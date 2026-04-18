import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettledAppSyncStatus, hasUnsyncedRealPages } from '../src/lib/editor/app-sync-status.ts';
import { createPage, type EditorSession } from '../src/lib/editor/core/session.ts';
import type { PageSyncStatus } from '../src/lib/editor/persistence/records.ts';

function buildPage(
	id: string,
	options: {
		isEphemeral?: boolean;
		deletedAt?: string | null;
		syncStatus?: PageSyncStatus;
		content?: string;
	} = {}
) {
	const page = createPage(options.content ?? id, {
		id,
		userId: 'user-a',
		now: '2026-04-18T12:00:00.000Z',
		isEphemeral: options.isEphemeral ?? false
	});
	page.title = id;
	page.deletedAt = options.deletedAt ?? null;
	page.syncStatus = options.syncStatus ?? 'synced';
	page.isEphemeral = options.isEphemeral ?? false;
	return page;
}

function buildSession(pages: ReturnType<typeof buildPage>[], activePageId = pages[0]!.id): EditorSession {
	return { pages, activePageId };
}

test('hasUnsyncedRealPages is false when every real page is synced', () => {
	const session = buildSession([buildPage('page-a'), buildPage('page-b')]);
	assert.equal(hasUnsyncedRealPages(session), false);
	assert.equal(getSettledAppSyncStatus(session, true), 'synced');
});

test('hasUnsyncedRealPages is true when one real page is dirty', () => {
	const session = buildSession([buildPage('page-a'), buildPage('page-b', { syncStatus: 'dirty' })]);
	assert.equal(hasUnsyncedRealPages(session), true);
	assert.equal(getSettledAppSyncStatus(session, true), 'saved_locally');
});

test('hasUnsyncedRealPages is true when one real page is conflict', () => {
	const session = buildSession([buildPage('page-a'), buildPage('page-b', { syncStatus: 'conflict' })]);
	assert.equal(hasUnsyncedRealPages(session), true);
	assert.equal(getSettledAppSyncStatus(session, true), 'saved_locally');
});

test('ephemeral dirty pages do not block synced status', () => {
	const session = buildSession([
		buildPage('page-a', { syncStatus: 'synced' }),
		buildPage('page-b', { isEphemeral: true, syncStatus: 'dirty', content: '' })
	]);
	assert.equal(hasUnsyncedRealPages(session), false);
	assert.equal(getSettledAppSyncStatus(session, true), 'synced');
});

test('deleted dirty pages do not block synced status', () => {
	const session = buildSession([
		buildPage('page-a'),
		buildPage('page-b', { syncStatus: 'dirty', deletedAt: '2026-04-18T12:05:00.000Z' })
	]);
	assert.equal(hasUnsyncedRealPages(session), false);
	assert.equal(getSettledAppSyncStatus(session, true), 'synced');
});

test('a mix of synced, deleted, and ephemeral pages stays synced when no real visible page is dirty', () => {
	const session = buildSession([
		buildPage('page-a'),
		buildPage('page-b', { deletedAt: '2026-04-18T12:05:00.000Z', syncStatus: 'dirty' }),
		buildPage('page-c', { isEphemeral: true, syncStatus: 'dirty', content: '' })
	]);
	assert.equal(hasUnsyncedRealPages(session), false);
	assert.equal(getSettledAppSyncStatus(session, true), 'synced');
});

test('multiple real dirty pages still report saved locally', () => {
	const session = buildSession([
		buildPage('page-a', { syncStatus: 'dirty' }),
		buildPage('page-b', { syncStatus: 'conflict' }),
		buildPage('page-c')
	]);
	assert.equal(hasUnsyncedRealPages(session), true);
	assert.equal(getSettledAppSyncStatus(session, true), 'saved_locally');
});

test('offline status wins even when all pages are synced', () => {
	const session = buildSession([buildPage('page-a'), buildPage('page-b')]);
	assert.equal(getSettledAppSyncStatus(session, false), 'offline');
});

test('offline status wins even when pages are dirty', () => {
	const session = buildSession([buildPage('page-a', { syncStatus: 'dirty' })]);
	assert.equal(getSettledAppSyncStatus(session, false), 'offline');
});
