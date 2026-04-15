import { createPage, type EditorPage, type EditorSession } from './session';
import type { RemoteAppState, RemotePageRecord } from './remote-session';

export interface VersionedSyncMeta {
	pageVersions: Record<string, string | null>;
}

export interface VersionedSyncResolution {
	session: EditorSession;
	conflictCount: number;
	pageVersions: Record<string, string | null>;
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
	let conflictActivePageId: string | null = null;
	let conflictCount = 0;

	for (const remotePage of remote.pages) {
		const localPage = localPages.get(remotePage.id);
		const baseVersion = localPage?.lastSyncedVersion ?? meta.pageVersions[remotePage.id] ?? null;

		if (!localPage) {
			if (baseVersion && remotePage.updated_at === baseVersion) {
				continue;
			}

			nextPages.push(toLocalPage(remotePage));
			nextPageVersions[remotePage.id] = remotePage.updated_at ?? baseVersion;
			continue;
		}

		const localChanged = hasLocalChanges(localPage, baseVersion);
		const remoteChanged = hasRemoteChanges(remotePage, baseVersion);

		if (localChanged && remoteChanged) {
			const conflictCopy = buildConflictCopy(localPage, now);
			nextPages.push(conflictCopy);
			nextPages.push(toLocalPage(remotePage));
			nextPageVersions[remotePage.id] = remotePage.updated_at ?? baseVersion;
			conflictActivePageId ??= conflictCopy.id;
			conflictCount++;
		} else if (remoteChanged && !localChanged) {
			nextPages.push(toLocalPage(remotePage));
			nextPageVersions[remotePage.id] = remotePage.updated_at ?? baseVersion;
		} else {
			nextPages.push(localPage);
			nextPageVersions[localPage.id] = localPage.lastSyncedVersion ?? baseVersion;
		}

		processedLocalIds.add(localPage.id);
	}

	for (const localPage of localSession.pages) {
		if (processedLocalIds.has(localPage.id)) {
			continue;
		}

		const baseVersion = localPage.lastSyncedVersion ?? meta.pageVersions[localPage.id] ?? null;
		const localChanged = hasLocalChanges(localPage, baseVersion);

		if (baseVersion && localChanged) {
			const conflictCopy = buildConflictCopy(localPage, now);
			nextPages.push(conflictCopy);
			conflictActivePageId ??= conflictCopy.id;
			conflictCount++;
			continue;
		}

		if (!baseVersion) {
			nextPages.push(localPage);
			nextPageVersions[localPage.id] = localPage.lastSyncedVersion;
		}
	}

	return {
		session: {
			pages: nextPages,
			activePageId:
				conflictActivePageId ??
				nextPages.find((page) => page.id === localSession.activePageId)?.id ??
				nextPages[0]?.id ??
				localSession.activePageId
		},
		conflictCount,
		pageVersions: nextPageVersions
	};
}

export function buildLocalConflictTitle(title: string, now = new Date()): string {
	const baseTitle = title.trim().length > 0 ? title.trim() : 'Untitled';
	const timestamp = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(now);

	return `${baseTitle} (Local conflict ${timestamp})`;
}

function toLocalPage(page: RemotePageRecord): EditorPage {
	const updatedAt = page.updated_at ?? page.created_at ?? new Date().toISOString();
	return {
		id: page.id,
		title: page.title,
		content: page.content,
		text: page.content,
		selectionStart: 0,
		selectionEnd: 0,
		updatedAt,
		lastSyncedVersion: updatedAt
	};
}

function buildConflictCopy(page: EditorPage, now: Date): EditorPage {
	return {
		...page,
		id: createPage(page.content).id,
		title: buildLocalConflictTitle(page.title, now),
		updatedAt: now.toISOString(),
		lastSyncedVersion: null
	};
}

function hasLocalChanges(page: EditorPage, baseVersion: string | null) {
	if (!baseVersion) {
		return true;
	}

	return page.updatedAt !== baseVersion;
}

function hasRemoteChanges(page: RemotePageRecord, baseVersion: string | null) {
	if (!baseVersion) {
		return true;
	}

	return (page.updated_at ?? page.created_at ?? null) !== baseVersion;
}
