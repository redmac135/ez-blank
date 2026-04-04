import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyDeleteBackward,
	applyDeleteForward,
	applyEnterKey,
	applyTabKey
} from '../src/lib/editor/commands.ts';

test('applyTabKey renumbers the whole ordered sublist when indenting a subset selection', () => {
	const source = '1. one\n2. two\n3. three';
	const start = source.indexOf('2. two');
	const end = source.length;

	const change = applyTabKey(source, { start, end }, false);

	assert.equal(change.text, '1. one\n    1. two\n    2. three');
	assert.equal(change.selectionStart, 7);
	assert.equal(change.selectionEnd, change.text.length);
});

test('applyTabKey renumbers following siblings when indenting a single ordered item', () => {
	const source = '1. one\n2. two\n3. three';
	const cursor = source.indexOf('2. two');

	const change = applyTabKey(source, { start: cursor, end: cursor }, false);

	assert.equal(change.text, '1. one\n    1. two\n2. three');
	assert.equal(change.selectionStart, cursor + 4);
	assert.equal(change.selectionEnd, cursor + 4);
});

test('applyEnterKey inserts a list item and renumbers later ordered siblings', () => {
	const source = '1. one\n2. two\n3. three';
	const cursor = source.indexOf('2. two') + '2. two'.length;

	const change = applyEnterKey(source, { start: cursor, end: cursor });

	assert.equal(change.text, '1. one\n2. two\n3. \n4. three');
	assert.equal(change.selectionStart, '1. one\n2. two\n3. '.length);
	assert.equal(change.selectionEnd, change.selectionStart);
});

test('applyEnterKey preserves plain paragraphs without list normalization', () => {
	const source = 'alpha beta';
	const cursor = 5;

	const change = applyEnterKey(source, { start: cursor, end: cursor });

	assert.equal(change.text, 'alpha\n beta');
	assert.equal(change.selectionStart, 6);
	assert.equal(change.selectionEnd, 6);
});

test('applyEnterKey inserts a nested ordered item and renumbers only that nested list', () => {
	const source = '1. parent\n    1. child\n    2. sibling\n2. outer';
	const cursor = source.indexOf('1. child') + '1. child'.length;

	const change = applyEnterKey(source, { start: cursor, end: cursor });

	assert.equal(change.text, '1. parent\n    1. child\n    2. \n    3. sibling\n2. outer');
	assert.equal(change.selectionStart, '1. parent\n    1. child\n    2. '.length);
	assert.equal(change.selectionEnd, change.selectionStart);
});

test('applyEnterKey on an empty ordered item in the middle resets the lower list to 1', () => {
	const source = '1. one\n2. \n3. three\n4. four';
	const cursor = source.indexOf('2. ');

	const change = applyEnterKey(source, { start: cursor, end: cursor });

	assert.equal(change.text, '1. one\n\n1. three\n2. four');
	assert.equal(change.selectionStart, source.indexOf('2. '));
	assert.equal(change.selectionEnd, change.selectionStart);
});

test('applyDeleteBackward renumbers ordered list siblings after removing a middle item', () => {
	const source = '1. one\n2. two\n3. three';
	const start = source.indexOf('2. two');
	const end = start + '2. two\n'.length;

	const change = applyDeleteBackward(source, { start, end });

	assert.equal(change.text, '1. one\n2. three');
	assert.equal(change.selectionStart, start);
	assert.equal(change.selectionEnd, start);
});

test('applyDeleteForward renumbers ordered list siblings after removing a middle item', () => {
	const source = '1. one\n2. two\n3. three';
	const start = source.indexOf('2. two');
	const end = start + '2. two\n'.length;

	const change = applyDeleteForward(source, { start, end });

	assert.equal(change.text, '1. one\n2. three');
	assert.equal(change.selectionStart, start);
	assert.equal(change.selectionEnd, start);
});
