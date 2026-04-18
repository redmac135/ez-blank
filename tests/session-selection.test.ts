import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEditorSelections } from '../src/lib/editor/persistence/session-selection.ts';
import { createSession } from '../src/lib/editor/core/session.ts';

test('mergeEditorSelections preserves selection by page id and clamps it to the new content length', () => {
	const source = createSession();
	source.pages[0]!.selectionStart = 7;
	source.pages[0]!.selectionEnd = 12;

	const next = createSession();
	next.pages[0]!.id = source.pages[0]!.id;
	next.activePageId = source.activePageId;
	next.pages[0]!.content = 'abc';
	next.pages[0]!.text = 'abc';

	const merged = mergeEditorSelections(next, source);

	assert.equal(merged.pages[0]?.selectionStart, 3);
	assert.equal(merged.pages[0]?.selectionEnd, 3);
});
