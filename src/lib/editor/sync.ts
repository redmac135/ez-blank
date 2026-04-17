import type { SupabaseClient } from '@supabase/supabase-js';
import { createPage, ensureValidActivePage, type EditorPage, type EditorSession } from './core/session';

const REMOTE_PAGE_COLUMNS = 'id,user_id,title,content,created_at,updated_at,deleted_at';

interface RemotePageRow {
	id: string;
	user_id: string;
	title: string;
	content: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

interface RemoteUserSettingsRow {
	user_id: string;
	active_page_id: string | null;
	created_at?: string;
	updated_at?: string;
}

export interface SyncRunResult {
	session: EditorSession;
	pushedCount: number;
	pulledCount: number;
	conflictCount: number;
}

let syncInProgress = false;

export function isSyncInProgress() {
	return syncInProgress;
}

// One manual sync pass works against one remote snapshot.
// We pull once, decide everything against that snapshot, trust write responses,
// and only then build the next local session.
export async function syncUserPages(
	supabase: SupabaseClient,
	userId: string,
	localSession: EditorSession,
	now = new Date()
): Promise<SyncRunResult> {
	if (syncInProgress) {
		throw new Error('Sync already in progress.');
	}

	syncInProgress = true;

	try {
		const remoteSnapshot = await pullRemoteSnapshot(supabase, userId);
		const remoteById = new Map(remoteSnapshot.map((page) => [page.id, page]));
		const processedRemoteIds = new Set<string>();
		const nextPages: EditorPage[] = [];
		let pushedCount = 0;
		let pulledCount = 0;
		let conflictCount = 0;
		let nextActivePageId = localSession.activePageId;

		for (const localPage of sortPages(localSession.pages.filter((page) => page.userId === userId))) {
			if (localPage.isEphemeral) {
				nextPages.push(localPage);
				continue;
			}

			const remote = remoteById.get(localPage.id) ?? null;
			if (!remote) {
				const pushed = await pushLocalPage(supabase, userId, localPage);
				nextPages.push(toSyncedLocalPage(pushed, localPage));
				pushedCount += 1;
				continue;
			}

			processedRemoteIds.add(remote.id);
			const localChanged = hasLocalChangedSinceSync(localPage);
			const remoteChanged = hasRemoteChangedSinceSync(localPage, remote);
			const sameState = pageStatesMatch(localPage, remote);

			if (!localChanged && !remoteChanged) {
				nextPages.push(toSyncedLocalPage(remote, localPage));
				continue;
			}

			if (sameState) {
				nextPages.push(toSyncedLocalPage(remote, localPage));
				continue;
			}

			if (localChanged && !remoteChanged) {
				const pushed = await pushLocalPage(supabase, userId, localPage);
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

			const conflictFork = forkConflictPage(localPage, now);
			const pushedFork = await pushLocalPage(supabase, userId, conflictFork);
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

		const nextSession = ensureValidActivePage({
			pages: sortPages(nextPages),
			activePageId: nextActivePageId
		});
		const remoteActivePageId = getRemoteActivePageId(nextSession);
		if (remoteActivePageId) {
			await pushRemoteActivePageId(supabase, userId, remoteActivePageId);
		}

		return {
			session: nextSession,
			pushedCount,
			pulledCount,
			conflictCount
		};
	} finally {
		syncInProgress = false;
	}
}

export async function fetchRemoteActivePageId(
	supabase: SupabaseClient,
	userId: string
): Promise<string | null> {
	const { data, error } = await supabase
		.from('user_settings')
		.select('active_page_id,user_id,created_at,updated_at')
		.eq('user_id', userId)
		.maybeSingle();

	if (error) {
		throw error;
	}

	return ((data as RemoteUserSettingsRow | null)?.active_page_id ?? null) as string | null;
}

export function forkConflictPage(page: EditorPage, now = new Date()): EditorPage {
	const timestamp = now.toISOString();
	const fork = createPage(page.content, { userId: page.userId, now: timestamp, isEphemeral: false });
	return {
		...fork,
		title: `${page.title} ${buildConflictSuffix(now)}`.trim(),
		content: page.content,
		text: page.content,
		selectionStart: page.selectionStart,
		selectionEnd: page.selectionEnd,
		deletedAt: null,
		syncStatus: 'dirty',
		isEphemeral: false
	};
}

async function pullRemoteSnapshot(supabase: SupabaseClient, userId: string): Promise<RemotePageRow[]> {
	const { data, error } = await supabase
		.from('pages')
		.select(REMOTE_PAGE_COLUMNS)
		.eq('user_id', userId)
		.order('created_at', { ascending: true })
		.order('id', { ascending: true });

	if (error) {
		throw error;
	}

	return (data ?? []) as RemotePageRow[];
}

async function pushLocalPage(
	supabase: SupabaseClient,
	userId: string,
	localPage: EditorPage
): Promise<RemotePageRow> {
	const { data, error } = await supabase
		.from('pages')
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
		.select(REMOTE_PAGE_COLUMNS)
		.single();

	if (error) {
		throw error;
	}

	return data as RemotePageRow;
}

async function pushRemoteActivePageId(supabase: SupabaseClient, userId: string, activePageId: string) {
	const { error } = await supabase.from('user_settings').upsert({
		user_id: userId,
		active_page_id: activePageId
	});

	if (error) {
		throw error;
	}
}

function toSyncedLocalPage(remote: RemotePageRow, localPage: EditorPage | null): EditorPage {
	const base =
		localPage ??
		createPage(remote.content, {
			id: remote.id,
			userId: remote.user_id,
			now: remote.created_at,
			isEphemeral: false
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
		syncStatus: 'synced',
		isEphemeral: false
	};
}

function hasLocalChangedSinceSync(localPage: EditorPage) {
	if (localPage.lastSyncedAt === null) {
		return true;
	}

	return latestLocalMutationAt(localPage) > localPage.lastSyncedAt;
}

function hasRemoteChangedSinceSync(localPage: EditorPage, remote: RemotePageRow) {
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

function latestRemoteMutationAt(remote: RemotePageRow) {
	return remote.deleted_at && remote.deleted_at > remote.updated_at ? remote.deleted_at : remote.updated_at;
}

function pageStatesMatch(localPage: EditorPage, remote: RemotePageRow) {
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

function getRemoteActivePageId(session: EditorSession) {
	const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
	if (!activePage || activePage.isEphemeral || activePage.deletedAt !== null) {
		return null;
	}

	return activePage.id;
}
