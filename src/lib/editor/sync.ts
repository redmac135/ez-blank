import type { SupabaseClient } from '@supabase/supabase-js';
import { createPage, ensureValidActivePage, type EditorPage, type EditorSession } from './core/session';

const REMOTE_NOTE_COLUMNS = 'id,user_id,title,content,created_at,updated_at,deleted_at';

interface RemoteNoteRow {
	id: string;
	user_id: string;
	title: string;
	content: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

export interface SyncRunResult {
	session: EditorSession;
	pushedCount: number;
	pulledCount: number;
	conflictCount: number;
}

// One manual sync pass works against one remote snapshot.
// We pull once, decide everything against that snapshot, trust write responses,
// and only then build the next local session.
export async function syncUserNotes(
	supabase: SupabaseClient,
	userId: string,
	localSession: EditorSession,
	now = new Date()
): Promise<SyncRunResult> {
	const remoteSnapshot = await pullRemoteSnapshot(supabase, userId);
	const remoteById = new Map(remoteSnapshot.map((note) => [note.id, note]));
	const processedRemoteIds = new Set<string>();
	const nextPages: EditorPage[] = [];
	let pushedCount = 0;
	let pulledCount = 0;
	let conflictCount = 0;
	let nextActivePageId = localSession.activePageId;

	for (const localPage of sortPages(localSession.pages.filter((page) => page.userId === userId))) {
		const remote = remoteById.get(localPage.id) ?? null;
		if (!remote) {
			const pushed = await pushLocalNote(supabase, userId, localPage);
			nextPages.push(toSyncedLocalPage(pushed, localPage));
			pushedCount += 1;
			continue;
		}

		processedRemoteIds.add(remote.id);
		const localChanged = hasLocalChangedSinceSync(localPage);
		const remoteChanged = hasRemoteChangedSinceSync(localPage, remote);
		const sameState = noteStatesMatch(localPage, remote);

		if (!localChanged && !remoteChanged) {
			nextPages.push(toSyncedLocalPage(remote, localPage));
			continue;
		}

		if (sameState) {
			nextPages.push(toSyncedLocalPage(remote, localPage));
			continue;
		}

		if (localChanged && !remoteChanged) {
			const pushed = await pushLocalNote(supabase, userId, localPage);
			nextPages.push(toSyncedLocalPage(pushed, localPage));
			pushedCount += 1;
			continue;
		}

		if (!localChanged && remoteChanged) {
			nextPages.push(toSyncedLocalPage(remote, localPage));
			pulledCount += 1;
			continue;
		}

		const remotePage = toSyncedLocalPage(remote, localPage);
		nextPages.push(remotePage);
		conflictCount += 1;

		const conflictFork = forkConflictNote(localPage, now);
		const pushedFork = await pushLocalNote(supabase, userId, conflictFork);
		const syncedFork = toSyncedLocalPage(pushedFork, conflictFork);
		nextPages.push(syncedFork);
		pushedCount += 1;

		if (localSession.activePageId === localPage.id && remotePage.deletedAt !== null) {
			nextActivePageId = syncedFork.id;
		}
	}

	for (const remote of remoteSnapshot) {
		if (processedRemoteIds.has(remote.id)) {
			continue;
		}

		nextPages.push(toSyncedLocalPage(remote, null));
		pulledCount += 1;
	}

	return {
		session: ensureValidActivePage({
			pages: sortPages(nextPages),
			activePageId: nextActivePageId
		}),
		pushedCount,
		pulledCount,
		conflictCount
	};
}

export function forkConflictNote(page: EditorPage, now = new Date()): EditorPage {
	const timestamp = now.toISOString();
	const fork = createPage(page.content, { userId: page.userId, now: timestamp });
	return {
		...fork,
		title: `${page.title} ${buildConflictSuffix(now)}`.trim(),
		content: page.content,
		text: page.content,
		selectionStart: page.selectionStart,
		selectionEnd: page.selectionEnd,
		deletedAt: null,
		syncStatus: 'dirty'
	};
}

async function pullRemoteSnapshot(supabase: SupabaseClient, userId: string): Promise<RemoteNoteRow[]> {
	const { data, error } = await supabase
		.from('notes')
		.select(REMOTE_NOTE_COLUMNS)
		.eq('user_id', userId)
		.order('created_at', { ascending: true })
		.order('id', { ascending: true });

	if (error) {
		throw error;
	}

	return (data ?? []) as RemoteNoteRow[];
}

async function pushLocalNote(
	supabase: SupabaseClient,
	userId: string,
	localPage: EditorPage
): Promise<RemoteNoteRow> {
	const { data, error } = await supabase
		.from('notes')
		.upsert(
			{
				id: localPage.id,
				user_id: userId,
				title: localPage.title,
				content: localPage.content,
				created_at: localPage.createdAt,
				updated_at: localPage.updatedAt,
				deleted_at: localPage.deletedAt
			},
			{ onConflict: 'id' }
		)
		.select(REMOTE_NOTE_COLUMNS)
		.single();

	if (error) {
		throw error;
	}

	return data as RemoteNoteRow;
}

function toSyncedLocalPage(
	remote: RemoteNoteRow,
	localPage: EditorPage | null
): EditorPage {
	const base =
		localPage ??
		createPage(remote.content, {
			id: remote.id,
			userId: remote.user_id,
			now: remote.created_at
		});

	return {
		...base,
		id: remote.id,
		userId: remote.user_id,
		title: remote.title,
		content: remote.content,
		text: remote.content,
		createdAt: remote.created_at,
		updatedAt: remote.updated_at,
		deletedAt: remote.deleted_at,
		lastSyncedAt: remote.updated_at,
		lastKnownRemoteUpdatedAt: remote.updated_at,
		lastKnownRemoteDeletedAt: remote.deleted_at,
		syncStatus: 'synced'
	};
}

function hasLocalChangedSinceSync(localPage: EditorPage) {
	if (localPage.lastSyncedAt === null) {
		return true;
	}

	return latestLocalMutationAt(localPage) > localPage.lastSyncedAt;
}

function hasRemoteChangedSinceSync(localPage: EditorPage, remote: RemoteNoteRow) {
	if (localPage.lastSyncedAt === null) {
		return true;
	}

	return latestRemoteMutationAt(remote) > localPage.lastSyncedAt;
}

function latestLocalMutationAt(localPage: EditorPage) {
	return localPage.deletedAt && localPage.deletedAt > localPage.updatedAt
		? localPage.deletedAt
		: localPage.updatedAt;
}

function latestRemoteMutationAt(remote: RemoteNoteRow) {
	return remote.deleted_at && remote.deleted_at > remote.updated_at ? remote.deleted_at : remote.updated_at;
}

function noteStatesMatch(localPage: EditorPage, remote: RemoteNoteRow) {
	return (
		localPage.title === remote.title &&
		localPage.content === remote.content &&
		(localPage.deletedAt ?? null) === (remote.deleted_at ?? null)
	);
}

function buildConflictSuffix(now: Date) {
	const label = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(now);

	return `(Local conflict ${label})`;
}

function sortPages(pages: EditorPage[]) {
	return [...pages].sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt.localeCompare(right.createdAt);
		}

		return left.id.localeCompare(right.id);
	});
}
