import {
	applyRemotePageState,
	createConflictCopy,
	markPageDeleted,
	markPageSynced,
	type EditorPage,
	type EditorSession
} from '../core/session';
import type { RemoteAppState, RemotePageRecord } from './remote-session';

export interface VersionedSyncMeta {
	pageVersions: Record<string, string | null>;
}

export interface VersionedSyncResolution {
	session: EditorSession;
	conflictCount: number;
	updatedFromRemote: boolean;
	pageVersions: Record<string, string | null>;
}

interface PageLogicalState {
	title: string;
	content: string;
	deleted: boolean;
}

interface PageSyncContext {
	localExists: boolean;
	remoteExists: boolean;
	localDeleted: boolean;
	remoteDeleted: boolean;
	localChangedSinceSync: boolean;
	remoteChangedSinceSync: boolean;
	localState: PageLogicalState | null;
	remoteState: PageLogicalState | null;
}

export function resolveVersionedSession(
	localSession: EditorSession,
	remote: RemoteAppState,
	meta: VersionedSyncMeta,
	now = new Date()
): VersionedSyncResolution {
	const localPages = new Map(localSession.pages.map((page) => [page.id, page]));
	const nextPages: EditorPage[] = [];
	const nextPageVersions: Record<string, string | null> = {};
	const processedLocalIds = new Set<string>();
	let conflictCount = 0;
	let updatedFromRemote = false;
	let conflictActivePageId: string | null = null;

	for (const remotePage of remote.pages) {
		const localPage = localPages.get(remotePage.id) ?? null;
		const context = buildPageSyncContext(localPage, remotePage, meta.pageVersions[remotePage.id] ?? null);

		// Safety check: identical logical page state is never a conflict, even when timestamps differ.
		if (context.localExists && context.remoteExists && sameLogicalState(context.localState, context.remoteState)) {
			nextPages.push(markPageSynced(localPage!, remoteVersion(remotePage) ?? localPage!.updatedAt));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 1: Local missing, remote exists and remote is active.
		if (!context.localExists && context.remoteExists && !context.remoteDeleted) {
			nextPages.push(buildLocalPageFromRemote(remotePage));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			updatedFromRemote = true;
			continue;
		}

		// Case 2: Local missing, remote exists and remote is deleted.
		if (!context.localExists && context.remoteExists && context.remoteDeleted) {
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			continue;
		}

		// Case 4: Remote deleted, local unchanged.
		if (context.localExists && context.remoteExists && context.remoteDeleted && !context.localChangedSinceSync) {
			nextPages.push(applyRemotePageState(localPage!, toRemotePageState(remotePage, localPage!)));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			updatedFromRemote = true;
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 5: Remote deleted, local changed.
		if (context.localExists && context.remoteExists && context.remoteDeleted && context.localChangedSinceSync) {
			const deletedLocalPage = markPageDeleted(localPage!);
			const conflictCopy = createConflictCopy(localPage!, buildLocalConflictSuffix(now), now);

			nextPages.push(conflictCopy);
			nextPages.push(deletedLocalPage);
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			updatedFromRemote = true;
			conflictActivePageId ??= conflictCopy.id;
			conflictCount += 1;
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Local delete wins when remote has not observed the tombstone yet.
		// This avoids eventual-consistency resurrection after a local delete.
		if (context.localExists && context.remoteExists && context.localDeleted && !context.remoteDeleted) {
			nextPages.push(markPageSynced(localPage!, remoteVersion(remotePage) ?? localPage!.updatedAt));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 6: Both exist, neither deleted, neither side changed.
		if (
			context.localExists &&
			context.remoteExists &&
			!context.localDeleted &&
			!context.remoteDeleted &&
			!context.localChangedSinceSync &&
			!context.remoteChangedSinceSync
		) {
			nextPages.push(markPageSynced(localPage!, remoteVersion(remotePage) ?? localPage!.updatedAt));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 7: Only local changed.
		if (
			context.localExists &&
			context.remoteExists &&
			!context.localDeleted &&
			!context.remoteDeleted &&
			context.localChangedSinceSync &&
			!context.remoteChangedSinceSync
		) {
			nextPages.push(markPageSynced(localPage!, remoteVersion(remotePage) ?? localPage!.updatedAt));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 8: Only remote changed.
		if (
			context.localExists &&
			context.remoteExists &&
			!context.localDeleted &&
			!context.remoteDeleted &&
			!context.localChangedSinceSync &&
			context.remoteChangedSinceSync
		) {
			nextPages.push(buildLocalPageFromRemote(remotePage));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			updatedFromRemote = true;
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 9: Both changed.
		if (
			context.localExists &&
			context.remoteExists &&
			!context.localDeleted &&
			!context.remoteDeleted &&
			context.localChangedSinceSync &&
			context.remoteChangedSinceSync
		) {
			const conflictCopy = createConflictCopy(localPage!, buildLocalConflictSuffix(now), now);
			nextPages.push(conflictCopy);
			nextPages.push(applyRemotePageState(localPage!, toRemotePageState(remotePage, localPage!)));
			nextPageVersions[remotePage.id] = remoteVersion(remotePage);
			updatedFromRemote = true;
			conflictActivePageId ??= conflictCopy.id;
			conflictCount += 1;
			processedLocalIds.add(remotePage.id);
			continue;
		}

		// Case 3 is handled in the local-only pass below when remote rows are missing.
		nextPages.push(applyRemotePageState(localPage!, toRemotePageState(remotePage, localPage!)));
		nextPageVersions[remotePage.id] = remoteVersion(remotePage);
		processedLocalIds.add(remotePage.id);
	}

	for (const localPage of localSession.pages) {
		if (processedLocalIds.has(localPage.id)) {
			continue;
		}

		const lastSyncedState = getLastSyncedState(localPage, meta.pageVersions[localPage.id] ?? null);
		const localState = getLocalLogicalState(localPage);
		const localChangedSinceSync = !sameLogicalState(localState, lastSyncedState);

		// Case 3: Local exists, remote missing.
		if (!lastSyncedState && localPage.syncStatus === 'local-only') {
			nextPages.push(localPage);
			nextPageVersions[localPage.id] = localPage.lastSyncedVersion;
			continue;
		}

		if (!lastSyncedState) {
			console.warn(`Sync inconsistency: remote page ${localPage.id} is missing but local data exists.`);
			nextPages.push(localPage);
			nextPageVersions[localPage.id] = localPage.lastSyncedVersion ?? null;
			continue;
		}

		if (localChangedSinceSync) {
			console.warn(`Sync inconsistency: remote page ${localPage.id} is missing after a prior sync.`);
		}

		nextPages.push(localPage);
		nextPageVersions[localPage.id] = localPage.lastSyncedVersion ?? meta.pageVersions[localPage.id] ?? null;
	}

	return {
		session: {
			pages: nextPages,
			activePageId:
				conflictActivePageId ??
				nextPages.find((page) => page.id === localSession.activePageId && !page.deletedAt)?.id ??
				nextPages.find((page) => !page.deletedAt)?.id ??
				nextPages[0]?.id ??
				localSession.activePageId
		},
		conflictCount,
		updatedFromRemote,
		pageVersions: nextPageVersions
	};
}

function buildPageSyncContext(
	localPage: EditorPage | null,
	remotePage: RemotePageRecord,
	lastVersion: string | null
): PageSyncContext {
	const localState = localPage ? getLocalLogicalState(localPage) : null;
	const remoteState = getRemoteLogicalState(remotePage);
	const lastSyncedState = localPage ? getLastSyncedState(localPage, lastVersion) : null;

	return {
		localExists: localPage !== null,
		remoteExists: true,
		localDeleted: localPage?.deletedAt != null,
		remoteDeleted: remoteState.deleted,
		localChangedSinceSync: localPage
			? !sameLogicalState(localState, lastSyncedState) || (!lastSyncedState && localPage.dirty)
			: false,
		remoteChangedSinceSync: !sameLogicalState(remoteState, lastSyncedState),
		localState,
		remoteState
	};
}

function getLocalLogicalState(page: EditorPage): PageLogicalState {
	return {
		title: page.title,
		content: page.content,
		deleted: page.deletedAt != null
	};
}

function getRemoteLogicalState(page: RemotePageRecord): PageLogicalState {
	return {
		title: page.title,
		content: page.content,
		deleted: page.deleted_at != null
	};
}

function getLastSyncedState(page: EditorPage, fallbackVersion: string | null): PageLogicalState | null {
	const lastSyncedAt = page.lastSyncedAt ?? fallbackVersion;
	if (!lastSyncedAt) {
		return null;
	}

	return {
		title: page.lastSyncedTitle ?? page.title,
		content: page.lastSyncedContent ?? page.content,
		deleted: (page.lastSyncedDeletedAt ?? page.deletedAt) != null
	};
}

function sameLogicalState(a: PageLogicalState | null, b: PageLogicalState | null): boolean {
	if (!a || !b) {
		return false;
	}

	return a.title === b.title && a.content === b.content && a.deleted === b.deleted;
}

function remoteVersion(page: RemotePageRecord): string | null {
	return page.updated_at ?? page.created_at ?? null;
}

function buildLocalPageFromRemote(remotePage: RemotePageRecord): EditorPage {
	const createdAt = remotePage.created_at ?? remotePage.updated_at ?? new Date().toISOString();
	return applyRemotePageState(
		{
			id: remotePage.id,
			title: remotePage.title,
			content: remotePage.content,
			text: remotePage.content,
			selectionStart: 0,
			selectionEnd: 0,
			createdAt,
			updatedAt: createdAt,
			deletedAt: null,
			lastSyncedAt: null,
			lastSyncedTitle: null,
			lastSyncedContent: null,
			lastSyncedDeletedAt: null,
			dirty: true,
			syncStatus: 'local-only',
			lastSyncedVersion: null
		},
		toRemotePageState(remotePage, { createdAt, updatedAt: createdAt })
	);
}

function toRemotePageState(
	remotePage: RemotePageRecord,
	fallback: Pick<EditorPage, 'createdAt' | 'updatedAt'>
) {
	const createdAt = remotePage.created_at ?? fallback.createdAt;
	const updatedAt = remoteVersion(remotePage) ?? fallback.updatedAt;
	return {
		title: remotePage.title,
		content: remotePage.content,
		deletedAt: remotePage.deleted_at ?? null,
		createdAt,
		updatedAt
	};
}

function buildLocalConflictSuffix(now: Date): string {
	const timestamp = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(now);

	return `(Local conflict ${timestamp})`;
}
