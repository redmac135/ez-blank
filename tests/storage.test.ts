import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorStorage } from '../src/lib/editor/storage.ts';
import { type EditorSession } from '../src/lib/editor/session.ts';

class MemoryStorage {
	private values = new Map<string, string>();

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		this.values.set(key, value);
	}

	removeItem(key: string) {
		this.values.delete(key);
	}

	clear() {
		this.values.clear();
	}
}

function createSession(activePageId = 'page-a'): EditorSession {
	return {
		activePageId,
		pages: [
			{
				id: 'page-a',
				title: 'A',
				content: 'alpha',
				text: 'alpha',
				selectionStart: 0,
				selectionEnd: 0
			},
			{
				id: 'page-b',
				title: 'B',
				content: 'beta',
				text: 'beta',
				selectionStart: 0,
				selectionEnd: 0
			}
		]
	};
}

test.beforeEach(() => {
	Object.defineProperty(globalThis, 'localStorage', {
		value: new MemoryStorage(),
		configurable: true
	});
});

test('EditorStorage saves and loads anonymous state under the scoped key', () => {
	const session = createSession('page-b');

	EditorStorage.saveAnonymousState(session);

	assert.deepEqual(JSON.parse(localStorage.getItem(EditorStorage.ANONYMOUS_STATE_KEY) ?? 'null'), {
		pages: session.pages,
		activePageId: 'page-b'
	});
	assert.equal(EditorStorage.loadAnonymousState().activePageId, 'page-b');
});

test('EditorStorage saves and loads user-scoped state separately per account', () => {
	EditorStorage.saveUserState('user-a', createSession('page-a'));
	EditorStorage.saveUserState('user-b', createSession('page-b'));

	assert.equal(EditorStorage.loadUserState('user-a')?.activePageId, 'page-a');
	assert.equal(EditorStorage.loadUserState('user-b')?.activePageId, 'page-b');
});

test('EditorStorage loads default sync metadata when none exists', () => {
	assert.deepEqual(EditorStorage.loadUserSyncMeta('user-a'), {
		dirty: false,
		lastSyncedAt: null
	});
});

test('EditorStorage saves and loads user sync metadata', () => {
	EditorStorage.saveUserSyncMeta('user-a', {
		dirty: true,
		lastSyncedAt: '2026-04-14T00:00:00.000Z'
	});

	assert.deepEqual(EditorStorage.loadUserSyncMeta('user-a'), {
		dirty: true,
		lastSyncedAt: '2026-04-14T00:00:00.000Z'
	});
});

test('EditorStorage migrates the v2 shared session into anonymous state', () => {
	localStorage.setItem(
		EditorStorage.LEGACY_STORAGE_KEY,
		JSON.stringify({
			pages: createSession('page-b').pages,
			activePageId: 'page-b'
		})
	);

	const session = EditorStorage.loadAnonymousState();

	assert.equal(session.activePageId, 'page-b');
	assert.equal(localStorage.getItem(EditorStorage.LEGACY_STORAGE_KEY), null);
	assert.ok(localStorage.getItem(EditorStorage.ANONYMOUS_STATE_KEY));
});

test('EditorStorage tracks prompted user ids without duplicates', () => {
	assert.equal(EditorStorage.hasPromptedUserId('user-a'), false);

	EditorStorage.markPromptedUserId('user-a');
	EditorStorage.markPromptedUserId('user-a');

	assert.equal(EditorStorage.hasPromptedUserId('user-a'), true);
	assert.deepEqual(EditorStorage.loadPromptedUserIds(), ['user-a']);
});

test('EditorStorage ignores malformed prompted user id payloads', () => {
	localStorage.setItem(EditorStorage.PROMPTED_USER_IDS_KEY, JSON.stringify(['user-a', 42, null]));

	assert.deepEqual(EditorStorage.loadPromptedUserIds(), ['user-a']);
	assert.equal(EditorStorage.hasPromptedUserId('user-a'), true);
	assert.equal(EditorStorage.hasPromptedUserId('user-b'), false);
});
