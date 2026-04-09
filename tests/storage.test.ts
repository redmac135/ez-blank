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

	Object.defineProperty(globalThis, 'sessionStorage', {
		value: new MemoryStorage(),
		configurable: true
	});
});

test('EditorStorage saves shared pages without sharing the active page id', () => {
	const session = createSession('page-b');

	EditorStorage.save(session);

	assert.deepEqual(JSON.parse(localStorage.getItem(EditorStorage.STORAGE_KEY) ?? 'null'), {
		pages: session.pages
	});
	assert.equal(sessionStorage.getItem(EditorStorage.ACTIVE_PAGE_KEY), 'page-b');
});

test('EditorStorage restores the local active page when shared content updates arrive', () => {
	localStorage.setItem(
		EditorStorage.STORAGE_KEY,
		JSON.stringify({
			pages: createSession('page-a').pages,
			activePageId: 'page-a'
		})
	);
	sessionStorage.setItem(EditorStorage.ACTIVE_PAGE_KEY, 'page-b');

	const session = EditorStorage.load();

	assert.equal(session.activePageId, 'page-b');
	assert.equal(session.pages[0]?.content, 'alpha');
	assert.equal(session.pages[1]?.content, 'beta');
});

test('EditorStorage falls back when the local active page no longer exists', () => {
	localStorage.setItem(
		EditorStorage.STORAGE_KEY,
		JSON.stringify({
			pages: [createSession('page-a').pages[0]]
		})
	);
	sessionStorage.setItem(EditorStorage.ACTIVE_PAGE_KEY, 'page-b');

	const session = EditorStorage.load();

	assert.equal(session.activePageId, 'page-a');
	assert.equal(sessionStorage.getItem(EditorStorage.ACTIVE_PAGE_KEY), 'page-a');
});
