import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createSession,
	derivePageTitle,
	ensureValidActivePage,
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
	assert.equal(session.activePageId, session.pages[0]?.id);
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

test('updatePageState keeps page metadata stable for selection-only updates', () => {
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
				title: 'A',
				content: 'alpha',
				text: 'alpha',
				selectionStart: 0,
				selectionEnd: 0,
				createdAt: '2026-04-14T00:00:00.000Z',
				updatedAt: '2026-04-14T00:00:00.000Z',
				deletedAt: null
			}
		]
	});

	assert.equal(repaired.activePageId, 'page-a');
});
