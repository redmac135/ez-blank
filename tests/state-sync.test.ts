import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyExternalState } from '../src/lib/editor/basic/state-sync.ts';

test('shouldApplyExternalState ignores echoed local editor state', () => {
	const state = { text: 'alpha', selectionStart: 5, selectionEnd: 5 };

	assert.equal(shouldApplyExternalState(state, state), false);
});

test('shouldApplyExternalState detects cross-tab content changes for the active page', () => {
	assert.equal(
		shouldApplyExternalState(
			{ text: 'updated in another tab', selectionStart: 22, selectionEnd: 22 },
			{ text: 'stale local content', selectionStart: 18, selectionEnd: 18 }
		),
		true
	);
});

test('shouldApplyExternalState detects external selection changes when text matches', () => {
	assert.equal(
		shouldApplyExternalState(
			{ text: 'shared text', selectionStart: 2, selectionEnd: 4 },
			{ text: 'shared text', selectionStart: 2, selectionEnd: 2 }
		),
		true
	);
});
