import type { SupabaseClient } from '@supabase/supabase-js';
import {
	createPage,
	ensureValidActivePage,
	type EditorPage,
	type EditorSession
} from './core/session';

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

export function reconcileSyncResult(
	currentSession: EditorSession,
	syncSourceSession: EditorSession,
	syncedSession: EditorSession
): EditorSession {
	const sourceById = new Map(syncSourceSession.pages.map((page) => [page.id, page]));
	const syncedById = new Map(syncedSession.pages.map((page) => [page.id, page]));
	const mergedPages: EditorPage[] = [];
	const seenPageIds = new Set<string>();

	for (const currentPage of currentSession.pages) {
		const sourcePage = sourceById.get(currentPage.id) ?? null;
		const syncedPage = syncedById.get(currentPage.id) ?? null;

		if (!sourcePage || !syncedPage) {
			mergedPages.push(currentPage);
			seenPageIds.add(currentPage.id);
			continue;
		}

		if (!hasPageChangedSinceSource(currentPage, sourcePage)) {
			mergedPages.push(preserveLocalSelection(syncedPage, currentPage));
			seenPageIds.add(currentPage.id);
			continue;
		}

		if (pageStatesMatch(sourcePage, toRemoteShape(syncedPage))) {
			mergedPages.push(mergeSyncedBaselineIntoCurrentPage(currentPage, syncedPage));
			seenPageIds.add(currentPage.id);
			continue;
		}

		mergedPages.push(currentPage);
		seenPageIds.add(currentPage.id);
	}

	for (const syncedPage of syncedSession.pages) {
		if (seenPageIds.has(syncedPage.id)) {
			continue;
		}

		mergedPages.push(syncedPage);
	}

	return ensureValidActivePage({
		pages: sortPages(mergedPages),
		activePageId: currentSession.activePageId
	});
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
				if (localPage.deletedAt !== null) {
					continue;
				}

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
				if (shouldKeepRemotePageLocally(remote)) {
					nextPages.push(toSyncedLocalPage(remote, localPage));
				}
				continue;
			}

			if (sameState) {
				if (shouldKeepRemotePageLocally(remote)) {
					nextPages.push(toSyncedLocalPage(remote, localPage));
				}
				continue;
			}

			if (localChanged && !remoteChanged) {
				const pushed = await pushLocalPage(supabase, userId, localPage);
				nextPages.push(toSyncedLocalPage(pushed, localPage));
				pushedCount += 1;
				continue;
			}

			if (!localChanged && remoteChanged) {
				if (shouldKeepRemotePageLocally(remote)) {
					nextPages.push(toSyncedLocalPage(remote, localPage));
				}
				pulledCount += 1;
				continue;
			}

			const remotePage = toSyncedLocalPage(remote, localPage);
			conflictCount += 1;
			if (shouldKeepRemotePageLocally(remote)) {
				nextPages.push(remotePage);
			}

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

			if (!shouldKeepRemotePageLocally(remote)) {
				continue;
			}

			nextPages.push(toSyncedLocalPage(remote, null));
			pulledCount += 1;
		}

		const nextSession = ensureValidActivePage({
			pages: sortPages(nextPages),
			activePageId: nextActivePageId
		});
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

export async function pushRemoteActivePageId(supabase: SupabaseClient, userId: string, activePageId: string) {
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

function preserveLocalSelection(page: EditorPage, selectionSource: EditorPage): EditorPage {
	return {
		...page,
		selectionStart: Math.max(0, Math.min(selectionSource.selectionStart, page.content.length)),
		selectionEnd: Math.max(0, Math.min(selectionSource.selectionEnd, page.content.length))
	};
}

function toRemoteShape(page: EditorPage): RemotePageRow {
	return {
		id: page.id,
		user_id: page.userId,
		title: page.title,
		content: page.content,
		created_at: page.createdAt,
		updated_at: page.updatedAt,
		deleted_at: page.deletedAt
	};
}

function hasPageChangedSinceSource(currentPage: EditorPage, sourcePage: EditorPage) {
	return (
		currentPage.title !== sourcePage.title ||
		currentPage.content !== sourcePage.content ||
		currentPage.deletedAt !== sourcePage.deletedAt ||
		currentPage.updatedAt !== sourcePage.updatedAt ||
		currentPage.isEphemeral !== sourcePage.isEphemeral
	);
}

function mergeSyncedBaselineIntoCurrentPage(currentPage: EditorPage, syncedPage: EditorPage): EditorPage {
	const nextPage: EditorPage = {
		...currentPage,
		userId: syncedPage.userId,
		createdAt: syncedPage.createdAt,
		lastSyncedAt: syncedPage.lastSyncedAt,
		lastKnownRemoteUpdatedAt: syncedPage.lastKnownRemoteUpdatedAt,
		lastKnownRemoteDeletedAt: syncedPage.lastKnownRemoteDeletedAt
	};

	return {
		...nextPage,
		syncStatus:
			syncedPage.lastSyncedAt !== null && latestLocalMutationAt(nextPage) > syncedPage.lastSyncedAt
				? 'dirty'
				: 'synced'
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

function shouldKeepRemotePageLocally(remote: RemotePageRow) {
	return remote.deleted_at === null;
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
		if (left.updatedAt !== right.updatedAt) {
			return right.updatedAt.localeCompare(left.updatedAt);
		}

		if (left.createdAt !== right.createdAt) {
			return right.createdAt.localeCompare(left.createdAt);
		}

		return left.id.localeCompare(right.id);
	});
}
