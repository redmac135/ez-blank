import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES } from '../src/lib/editor/core/preferences.ts';
import { createPage, type EditorSession } from '../src/lib/editor/core/session.ts';
import { EditorStorage } from '../src/lib/editor/persistence/storage.ts';
import { ANONYMOUS_USERID } from '../src/lib/editor/persistence/records.ts';

function createSession(userId: string, activePageId = 'page-a'): EditorSession {
	const pageA = createPage('alpha', {
		id: 'page-a',
		userId,
		now: '2026-04-14T00:00:00.000Z',
		isEphemeral: false
	});
	pageA.title = 'A';
	pageA.updatedAt = '2026-04-14T00:00:00.000Z';

	const pageB = createPage('beta', {
		id: 'page-b',
		userId,
		now: '2026-04-15T00:00:00.000Z',
		isEphemeral: false
	});
	pageB.title = 'B';
	pageB.updatedAt = '2026-04-15T00:00:00.000Z';

	return {
		activePageId,
		pages: [pageA, pageB]
	};
}

test.beforeEach(() => {
	EditorStorage.resetForTests();
});

test('EditorStorage saves and loads anonymous state through the blank database shape', async () => {
	const session = createSession(ANONYMOUS_USERID, 'page-b');

	await EditorStorage.saveAnonymousState(session);

	const loaded = await EditorStorage.loadAnonymousState();
	assert.equal(loaded.activePageId, 'page-b');
	assert.equal(loaded.pages.length, session.pages.length);
	assert.equal(loaded.pages[0]?.userId, ANONYMOUS_USERID);
	assert.equal(loaded.pages[0]?.isEphemeral, false);
});

test('EditorStorage saves and loads user-scoped state separately per account', async () => {
	await EditorStorage.saveUserState('user-a', createSession('user-a', 'page-a'));
	await EditorStorage.saveUserState('user-b', createSession('user-b', 'page-b'));

	assert.equal((await EditorStorage.loadUserState('user-a'))?.activePageId, 'page-a');
	assert.equal((await EditorStorage.loadUserState('user-b'))?.activePageId, 'page-b');
	assert.equal((await EditorStorage.loadUserState('user-a'))?.pages[0]?.userId, 'user-a');
	assert.equal((await EditorStorage.loadUserState('user-b'))?.pages[0]?.userId, 'user-b');
});

test('EditorStorage loads a single page without requiring full session consumers', async () => {
	const session = createSession('user-a', 'page-a');
	await EditorStorage.saveUserState('user-a', session);

	const page = await EditorStorage.loadUserPage('user-a', 'page-b');
	assert.equal(page?.id, 'page-b');
	assert.equal(page?.content, 'beta');
	assert.equal(page?.userId, 'user-a');
	assert.equal(page?.isEphemeral, false);
});

test('EditorStorage keeps page lookups in sync after hard removals are saved', async () => {
	const session = createSession(ANONYMOUS_USERID, 'page-a');
	await EditorStorage.saveAnonymousState(session);
	await EditorStorage.saveAnonymousState({
		activePageId: 'page-a',
		pages: [session.pages[0]!]
	});

	const deletedPage = await EditorStorage.loadAnonymousPage('page-b');
	assert.equal(deletedPage, null);
});

test('EditorStorage preserves ephemeral placeholders', async () => {
	const session: EditorSession = {
		activePageId: 'page-a',
		pages: [createPage('', { id: 'page-a', userId: ANONYMOUS_USERID, isEphemeral: true })]
	};
	await EditorStorage.saveAnonymousState(session);

	const loaded = await EditorStorage.loadAnonymousState();
	assert.equal(loaded.pages[0]?.isEphemeral, true);
});

test('EditorStorage returns default preferences when no settings are stored', async () => {
	assert.deepEqual(await EditorStorage.loadPreferences(ANONYMOUS_USERID), DEFAULT_PREFERENCES);
});

test('EditorStorage saves and loads preferences through settings records', async () => {
	await EditorStorage.savePreferences('user-a', {
		themeMode: 'dark',
		spellcheckEnabled: false,
		countVisibility: 'pinned'
	});

	assert.deepEqual(await EditorStorage.loadPreferences('user-a'), {
		themeMode: 'dark',
		spellcheckEnabled: false,
		countVisibility: 'pinned'
	});
});

test('EditorStorage tracks whether an account has been prompted to import anonymous data', async () => {
	assert.equal(await EditorStorage.hasPromptedForAnonymousImport('user-a'), false);

	await EditorStorage.markPromptedForAnonymousImport('user-a');
	await EditorStorage.markPromptedForAnonymousImport('user-a');

	assert.equal(await EditorStorage.hasPromptedForAnonymousImport('user-a'), true);
	assert.equal(await EditorStorage.hasPromptedForAnonymousImport('user-b'), false);
});
