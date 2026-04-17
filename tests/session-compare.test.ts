import test from 'node:test';
import assert from 'node:assert/strict';
import {
	areEditorSessionsEquivalent,
	getChangedPageEvents
} from '../src/lib/editor/persistence/session-events.ts';
import { createSession } from '../src/lib/editor/core/session.ts';

test('areEditorSessionsEquivalent ignores selection-only differences', () => {
	const left = createSession();
	const right = createSession();
	right.pages[0]!.id = left.pages[0]!.id;
	right.activePageId = left.activePageId;

	left.pages[0]!.content = 'alpha';
	left.pages[0]!.text = 'alpha';
	left.pages[0]!.selectionStart = 5;
	left.pages[0]!.selectionEnd = 5;

	right.pages[0]!.content = 'alpha';
	right.pages[0]!.text = 'alpha';
	right.pages[0]!.selectionStart = 0;
	right.pages[0]!.selectionEnd = 0;

	assert.equal(areEditorSessionsEquivalent(left, right), true);
});

test('areEditorSessionsEquivalent detects content and page-order changes', () => {
	const left = createSession();
	const right = createSession();
	right.pages[0]!.id = left.pages[0]!.id;
	right.activePageId = left.activePageId;

	left.pages[0]!.content = 'alpha';
	left.pages[0]!.text = 'alpha';
	right.pages[0]!.content = 'beta';
	right.pages[0]!.text = 'beta';

	assert.equal(areEditorSessionsEquivalent(left, right), false);

	const reordered = createSession();
	reordered.pages[0]!.id = left.pages[0]!.id;
	reordered.pages.push({
		...reordered.pages[0]!,
		id: 'page-2'
	});

	assert.equal(areEditorSessionsEquivalent(left, reordered), false);
});

test('areEditorSessionsEquivalent detects soft-delete changes', () => {
	const left = createSession();
	const right = createSession();
	right.pages[0]!.id = left.pages[0]!.id;
	right.activePageId = left.activePageId;

	left.pages[0]!.deletedAt = null;
	right.pages[0]!.deletedAt = '2026-04-15T16:12:00.000Z';

	assert.equal(areEditorSessionsEquivalent(left, right), false);
});

test('getChangedPageEvents emits typed local note events', () => {
	const previous = createSession();
	const page = previous.pages[0]!;
	page.id = 'note-1';
	page.title = 'Old';
	page.content = 'old body';
	page.text = 'old body';

	const next = createSession();
	next.pages[0]!.id = 'note-1';
	next.pages[0]!.title = 'New';
	next.pages[0]!.content = 'new body';
	next.pages[0]!.text = 'new body';
	next.pages.push({
		...next.pages[0]!,
		id: 'note-2',
		title: 'Second',
		content: 'second',
		text: 'second',
		deletedAt: null
	});

	const events = getChangedPageEvents(previous, next);
	assert.equal(events.some((event) => event.type === 'title-updated' && event.id === 'note-1'), true);
	assert.equal(events.some((event) => event.type === 'note-updated' && event.id === 'note-1'), true);
	assert.equal(events.some((event) => event.type === 'new-note' && event.id === 'note-2'), true);
});
