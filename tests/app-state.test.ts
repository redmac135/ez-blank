import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEditorStateUpdate,
	applyHydratedSession,
	applySessionUpdate,
	type PageAppState
} from '../src/lib/editor/core/app-state.ts';
import { createPage, createSession } from '../src/lib/editor/core/session.ts';

function createLoadedSession(text: string) {
	const session = createSession();
	const [page] = session.pages;
	assert.ok(page);
	page.content = text;
	page.text = text;
	page.title = text.split('\n')[0] || 'Untitled';
	return session;
}

test('applyEditorStateUpdate does not persist changes before hydration completes', () => {
	const initialState: PageAppState = {
		session: createSession(),
		loaded: false
	};

	const transition = applyEditorStateUpdate(initialState, {
		pageId: initialState.session.activePageId,
		state: {
			text: '',
			selectionStart: 0,
			selectionEnd: 0
		}
	});

	assert.equal(transition.persistedSession, null);
	assert.equal(transition.state.loaded, false);
});

test('hydration after a pre-load empty editor update restores the stored content', () => {
	const initialState: PageAppState = {
		session: createSession(),
		loaded: false
	};

	const preHydrationEdit = applyEditorStateUpdate(initialState, {
		pageId: initialState.session.activePageId,
		state: {
			text: '',
			selectionStart: 0,
			selectionEnd: 0
		}
	});
	assert.equal(preHydrationEdit.state.loaded, false);
	const hydrated = applyHydratedSession(createLoadedSession('latest content'));

	assert.equal(hydrated.loaded, true);
	assert.equal(hydrated.session.pages[0]?.content, 'latest content');
	assert.equal(hydrated.session.pages[0]?.text, 'latest content');
});

test('applySessionUpdate persists only after hydration completes', () => {
	const hydratedState: PageAppState = {
		session: createLoadedSession('alpha'),
		loaded: true
	};
	const nextSession = createLoadedSession('beta');

	const transition = applySessionUpdate(hydratedState, nextSession);

	assert.equal(transition.persistedSession, nextSession);
	assert.equal(transition.state.session.pages[0]?.content, 'beta');
});

test('applyEditorStateUpdate updates the targeted page even when it is not active', () => {
	const session = createSession('user-a');
	const secondPage = createPage('beta', {
		id: 'page-b',
		userId: 'user-a',
		now: '2026-04-17T18:00:00.000Z',
		isEphemeral: false
	});
	secondPage.title = 'Beta';

	const state: PageAppState = {
		session: {
			activePageId: session.pages[0]!.id,
			pages: [session.pages[0]!, secondPage]
		},
		loaded: true
	};

	const transition = applyEditorStateUpdate(state, {
		pageId: 'page-b',
		state: {
			text: 'beta updated',
			selectionStart: 12,
			selectionEnd: 12
		}
	});

	assert.equal(transition.state.session.pages[1]?.content, 'beta updated');
	assert.equal(transition.state.session.pages[0]?.content, '');
	assert.equal(transition.persistedSession?.pages[1]?.content, 'beta updated');
});

test('applyEditorStateUpdate ignores updates for missing page ids', () => {
	const initialState: PageAppState = {
		session: createSession(),
		loaded: true
	};

	const transition = applyEditorStateUpdate(initialState, {
		pageId: 'missing-page',
		state: {
			text: 'should be ignored',
			selectionStart: 0,
			selectionEnd: 0
		}
	});

	assert.equal(transition.state, initialState);
	assert.equal(transition.persistedSession, null);
});
