import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyPageIdMap,
	buildSessionFromRemote,
	hasRemoteContent,
	hasSessionContent,
	type RemoteAppState
} from '../src/lib/editor/remote-session.ts';
import { createSession } from '../src/lib/editor/session.ts';

test('hasSessionContent treats the default blank session as empty', () => {
	assert.equal(hasSessionContent(createSession()), false);
});

test('hasSessionContent detects non-empty local data', () => {
	const session = createSession();
	session.pages[0]!.content = 'alpha';
	session.pages[0]!.text = 'alpha';

	assert.equal(hasSessionContent(session), true);
});

test('hasRemoteContent is based on stored pages', () => {
	assert.equal(hasRemoteContent({ activePageId: null, pages: [] }), false);
	assert.equal(
		hasRemoteContent({
			activePageId: 'page-1',
			pages: [{ id: 'page-1', title: 'A', content: 'alpha' }]
		}),
		true
	);
});

test('buildSessionFromRemote rebuilds an editor session from Supabase rows', () => {
	const remote: RemoteAppState = {
		activePageId: 'page-2',
		pages: [
			{ id: 'page-1', title: 'One', content: 'alpha' },
			{ id: 'page-2', title: 'Two', content: 'beta' }
		]
	};

	const session = buildSessionFromRemote(remote);

	assert.equal(session.activePageId, 'page-2');
	assert.equal(session.pages[0]?.text, 'alpha');
	assert.equal(session.pages[1]?.selectionStart, 0);
});

test('applyPageIdMap replaces local ids with remote ids without dropping content', () => {
	const session = createSession();
	const remapped = applyPageIdMap(
		session,
		new Map([[session.pages[0]!.id, 'f16d9a88-8e66-4db4-a0a5-8090c05690a2']])
	);

	assert.equal(remapped.pages[0]?.id, 'f16d9a88-8e66-4db4-a0a5-8090c05690a2');
	assert.equal(remapped.pages[0]?.content, session.pages[0]?.content);
	assert.equal(remapped.activePageId, 'f16d9a88-8e66-4db4-a0a5-8090c05690a2');
});
