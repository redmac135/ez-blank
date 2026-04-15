import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocument } from '../src/lib/editor/basic/parser.ts';
import { getEditorContainerOffset } from '../src/lib/editor/basic/selection.ts';
import { applyDeleteBackward } from '../src/lib/editor/basic/commands.ts';

test('getEditorContainerOffset maps editor child boundaries to text offsets', () => {
	const document = buildDocument('```js\nconst x = 1;\n```');

	assert.equal(getEditorContainerOffset(document, 0), 0);
	assert.equal(getEditorContainerOffset(document, 1), document.lines[1]?.range.start);
	assert.equal(getEditorContainerOffset(document, 2), document.lines[2]?.range.start);
	assert.equal(getEditorContainerOffset(document, 3), document.text.length);
});

test('getEditorContainerOffset preserves boundaries around empty lines', () => {
	const document = buildDocument('```\n\n```');

	assert.equal(getEditorContainerOffset(document, 1), document.lines[1]?.range.start);
	assert.equal(getEditorContainerOffset(document, 2), document.lines[2]?.range.start);
});

test('deleting backward from the start of a pasted line removes the line break in one step', () => {
	const document = buildDocument('alpha\r\nbeta');
	const cursor = document.lines[1]?.range.start ?? 0;

	const change = applyDeleteBackward(document.text, { start: cursor, end: cursor });

	assert.equal(change.text, 'alphabeta');
	assert.equal(change.selectionStart, 'alpha'.length);
	assert.equal(change.selectionEnd, change.selectionStart);
});
