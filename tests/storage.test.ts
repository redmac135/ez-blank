import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorStorage } from '../src/lib/editor/persistence/storage.ts';
import { createPage, type EditorSession } from '../src/lib/editor/core/session.ts';

class MemoryStorage {
	private values = new Map<string, string>();

	get length() {
		return this.values.size;
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
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
	const pageA = createPage('alpha');
	pageA.id = 'page-a';
	pageA.title = 'A';
	pageA.createdAt = '2026-04-14T00:00:00.000Z';
	pageA.updatedAt = '2026-04-14T00:00:00.000Z';
	pageA.deletedAt = null;

	const pageB = createPage('beta');
	pageB.id = 'page-b';
	pageB.title = 'B';
	pageB.createdAt = '2026-04-14T00:00:00.000Z';
	pageB.updatedAt = '2026-04-14T00:00:00.000Z';
	pageB.deletedAt = null;

	return {
		activePageId,
		pages: [pageA, pageB]
	};
}

test.beforeEach(() => {
	EditorStorage.resetForTests();
	Object.defineProperty(globalThis, 'localStorage', {
		value: new MemoryStorage(),
		configurable: true
	});
});

test('EditorStorage saves and loads anonymous state through the database', async () => {
	const session = createSession('page-b');

	await EditorStorage.saveAnonymousState(session);

	const loaded = await EditorStorage.loadAnonymousState();
	assert.equal(loaded.activePageId, 'page-b');
	assert.equal(loaded.pages.length, session.pages.length);
});

test('EditorStorage saves and loads user-scoped state separately per account', async () => {
	await EditorStorage.saveUserState('user-a', createSession('page-a'));
	await EditorStorage.saveUserState('user-b', createSession('page-b'));

	assert.equal((await EditorStorage.loadUserState('user-a'))?.activePageId, 'page-a');
	assert.equal((await EditorStorage.loadUserState('user-b'))?.activePageId, 'page-b');
});

test('EditorStorage loads a single page without requiring full session consumers', async () => {
	const session = createSession('page-a');
	await EditorStorage.saveUserState('user-a', session);

	const page = await EditorStorage.loadUserPage('user-a', 'page-b');
	assert.equal(page?.id, 'page-b');
	assert.equal(page?.content, 'beta');
});

test('EditorStorage migrates the legacy anonymous JSON session into the database', async () => {
	localStorage.setItem(
		EditorStorage.ANONYMOUS_STATE_KEY,
		JSON.stringify({
			pages: createSession('page-b').pages,
			activePageId: 'page-b'
		})
	);

	const session = await EditorStorage.loadAnonymousState();

	assert.equal(session.activePageId, 'page-b');
	assert.equal(localStorage.getItem(EditorStorage.ANONYMOUS_STATE_KEY), null);
});

test('EditorStorage keeps page lookups in sync after deletions are saved', async () => {
	const session = createSession('page-a');
	await EditorStorage.saveAnonymousState(session);
	await EditorStorage.saveAnonymousState({
		activePageId: 'page-a',
		pages: [session.pages[0]!]
	});

	const deletedPage = await EditorStorage.loadAnonymousPage('page-b');
	assert.equal(deletedPage, null);
});

test('EditorStorage tracks prompted user ids without duplicates', async () => {
	assert.equal(await EditorStorage.hasPromptedUserId('user-a'), false);

	await EditorStorage.markPromptedUserId('user-a');
	await EditorStorage.markPromptedUserId('user-a');

	assert.equal(await EditorStorage.hasPromptedUserId('user-a'), true);
	assert.deepEqual(await EditorStorage.loadPromptedUserIds(), ['user-a']);
});

test('EditorStorage ignores malformed prompted user id payloads', async () => {
	localStorage.setItem(EditorStorage.PROMPTED_USER_IDS_KEY, JSON.stringify(['user-a', 42, null]));

	assert.deepEqual(await EditorStorage.loadPromptedUserIds(), ['user-a']);
	assert.equal(await EditorStorage.hasPromptedUserId('user-a'), true);
	assert.equal(await EditorStorage.hasPromptedUserId('user-b'), false);
});
