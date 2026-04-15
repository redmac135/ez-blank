import test from 'node:test';
import assert from 'node:assert/strict';
import {
	cycleCountVisibility,
	getCountVisibilityLabel,
	normalizePreferences
} from '../src/lib/editor/core/preferences.ts';

test('normalizePreferences falls back to safe defaults', () => {
	assert.deepEqual(normalizePreferences(null), {
		themeMode: 'light',
		spellcheckEnabled: true,
		countVisibility: 'auto'
	});
});

test('normalizePreferences keeps valid saved values', () => {
	assert.deepEqual(
		normalizePreferences({
			themeMode: 'dark',
			spellcheckEnabled: false,
			countVisibility: 'pinned'
		}),
		{
			themeMode: 'dark',
			spellcheckEnabled: false,
			countVisibility: 'pinned'
		}
	);
});

test('cycleCountVisibility rotates pinned, toolbar, hidden states', () => {
	assert.equal(cycleCountVisibility('pinned'), 'auto');
	assert.equal(cycleCountVisibility('auto'), 'hidden');
	assert.equal(cycleCountVisibility('hidden'), 'pinned');
});

test('getCountVisibilityLabel uses concise menu labels', () => {
	assert.equal(getCountVisibilityLabel('pinned'), 'Count pinned');
	assert.equal(getCountVisibilityLabel('auto'), 'Count shown');
	assert.equal(getCountVisibilityLabel('hidden'), 'Count hidden');
});
