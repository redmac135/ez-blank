import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEditorStateUpdate,
	applyHydratedSession,
	applySessionUpdate,
	type PageAppState
} from '../src/lib/editor/core/app-state.ts';
import { createSession } from '../src/lib/editor/core/session.ts';

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
		text: '',
		selectionStart: 0,
		selectionEnd: 0
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
		text: '',
		selectionStart: 0,
		selectionEnd: 0
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
