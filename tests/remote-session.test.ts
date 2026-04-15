import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyPageIdMap,
	buildSessionFromRemote,
	hasRemoteContent,
	hasSessionContent,
	saveRemoteSession,
	type RemoteAppState
} from '../src/lib/editor/remote-session.ts';
import { createPage, createSession } from '../src/lib/editor/session.ts';

class SupabaseStub {
	pageUpserts: Array<unknown> = [];
	settingUpserts: Array<unknown> = [];
	removedIds: Array<string[]> = [];

	constructor(private pages: Array<{ id: string; title?: string; content?: string }> = []) {}

	from(table: string) {
		if (table === 'pages') {
			return {
				select: () => ({
					eq: () => ({
						order: async () => ({ data: this.pages, error: null })
					})
				}),
				upsert: async (value: unknown) => {
					this.pageUpserts.push(value);
					return { error: null };
				},
				delete: () => ({
					in: async (value: string[]) => {
						this.removedIds.push(value);
						return { error: null };
					}
				}),
				insert: (value: unknown) => {
					void value;
					return {
						select: () => ({
							single: async () => ({
								data: { id: 'f16d9a88-8e66-4db4-a0a5-8090c05690a2' },
								error: null
							})
						})
					};
				}
			};
		}

		return {
			select: () => ({
				eq: () => ({
					maybeSingle: async () => ({
						data: { active_page_id: null },
						error: null
					})
				})
			}),
			upsert: async (value: { active_page_id: string | null }) => {
				this.settingUpserts.push(value);
				return { data: value, error: null };
			}
		};
	}
}

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

test('saveRemoteSession repairs a missing active page before writing user settings', async () => {
	const session = createSession();
	const result = await saveRemoteSession(new SupabaseStub() as never, 'user-a', {
		...session,
		activePageId: 'missing'
	});

	assert.equal(result.activePageId, 'f16d9a88-8e66-4db4-a0a5-8090c05690a2');
});

test('saveRemoteSession skips unchanged remote rows and only writes diffs', async () => {
	const stub = new SupabaseStub([
		{ id: 'f16d9a88-8e66-4db4-a0a5-8090c05690a2', title: 'Remote title', content: 'remote body' }
	]);
	const session = createSession();
	session.pages = [
		{
			id: 'f16d9a88-8e66-4db4-a0a5-8090c05690a2',
			title: 'Remote title',
			content: 'remote body',
			text: 'remote body',
			selectionStart: 0,
			selectionEnd: 0,
			updatedAt: '2026-04-15T16:12:00.000Z',
			lastSyncedVersion: '2026-04-15T16:12:00.000Z'
		},
		createPage('local body')
	];
	session.activePageId = 'f16d9a88-8e66-4db4-a0a5-8090c05690a2';

	await saveRemoteSession(stub as never, 'user-a', session, {
		activePageId: 'f16d9a88-8e66-4db4-a0a5-8090c05690a2',
		pages: [
			{
				id: 'f16d9a88-8e66-4db4-a0a5-8090c05690a2',
				title: 'Remote title',
				content: 'remote body'
			}
		]
	});

	assert.equal(stub.pageUpserts.length, 0);
	assert.equal(stub.settingUpserts.length, 0);
	assert.equal(stub.removedIds.length, 0);
});
