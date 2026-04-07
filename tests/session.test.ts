import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createSession,
	derivePageTitle,
	normalizeSession,
	updatePageState
} from '../src/lib/editor/session.ts';

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

test('derivePageTitle falls back to Untitled for blank content', () => {
	assert.equal(derivePageTitle('   \n  '), 'Untitled');
});
