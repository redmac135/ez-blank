import type { SupabaseClient } from '@supabase/supabase-js';
import {
	applyRemotePageState,
	createSession,
	ensureValidActivePage,
	type EditorPage,
	type EditorSession,
	UNTITLED_PAGE
} from '../core/session';

export interface RemotePageRecord {
	id: string;
	title: string;
	content: string;
	created_at?: string;
	updated_at?: string;
	deleted_at?: string | null;
}

export interface RemoteAppState {
	activePageId: string | null;
	pages: RemotePageRecord[];
}

export interface RemoteSyncResult {
	pageIdMap: Map<string, string>;
	activePageId: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hasSessionContent(session: EditorSession): boolean {
	if (session.pages.length > 1) {
		return true;
	}

	const [page] = session.pages;
	if (!page) {
		return false;
	}

	return page.content.trim().length > 0 || page.title !== UNTITLED_PAGE;
}

export function hasRemoteContent(remote: RemoteAppState): boolean {
	return remote.pages.length > 0;
}

export function buildSessionFromRemote(remote: RemoteAppState): EditorSession {
	if (remote.pages.length === 0) {
		return createSession();
	}

	const pages: EditorPage[] = remote.pages.map((page) => {
		const createdAt = page.created_at ?? page.updated_at ?? new Date().toISOString();
		const updatedAt = page.updated_at ?? page.created_at ?? createdAt;
		return applyRemotePageState(
			{
				id: page.id,
				title: page.title,
				content: page.content,
				text: page.content,
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
			{
				title: page.title,
				content: page.content,
				deletedAt: page.deleted_at ?? null,
				createdAt,
				updatedAt
			}
		);
	});

	const activePageId =
		remote.activePageId && pages.some((page) => page.id === remote.activePageId)
			? remote.activePageId
			: (pages[0]?.id ?? createSession().activePageId);

	return {
		pages,
		activePageId
	};
}

export function applyPageIdMap(
	session: EditorSession,
	pageIdMap: Map<string, string>,
	activePageId = session.activePageId
): EditorSession {
	if (pageIdMap.size === 0 && activePageId === session.activePageId) {
		return session;
	}

	return {
		pages: session.pages.map((page) => ({
			...page,
			id: pageIdMap.get(page.id) ?? page.id
		})),
		activePageId: pageIdMap.get(activePageId) ?? activePageId
	};
}

export async function readRemoteSession(
	supabase: SupabaseClient,
	userId: string
): Promise<RemoteAppState> {
	const [{ data: pages, error: pagesError }, { data: settings, error: settingsError }] =
		await Promise.all([
			supabase
				.from('pages')
				.select('id,title,content,created_at,updated_at,deleted_at')
				.eq('user_id', userId)
				.order('created_at', { ascending: true }),
			supabase.from('user_settings').select('active_page_id').eq('user_id', userId).maybeSingle()
		]);

	if (pagesError) {
		throw pagesError;
	}

	if (settingsError) {
		throw settingsError;
	}

	return {
		activePageId: settings?.active_page_id ?? null,
		pages: pages ?? []
	};
}

export async function saveRemoteSession(
	supabase: SupabaseClient,
	userId: string,
	session: EditorSession,
	currentRemote?: RemoteAppState
): Promise<RemoteSyncResult> {
	const normalizedSession = ensureValidActivePage(session);
	const currentRemotePages =
		currentRemote?.pages ?? (await readRemoteSession(supabase, userId)).pages;
	const remotePageMap = new Map(currentRemotePages.map((page) => [page.id, page]));
	const remotePagesToSave = normalizedSession.pages.filter((page) => isRemotePageId(page.id));
	const localPages = normalizedSession.pages.filter(
		(page) => !isRemotePageId(page.id) && shouldInsertLocalPage(normalizedSession, page)
	);
	const pagesToUpdate = remotePagesToSave.filter((page) => {
		const currentPage = remotePageMap.get(page.id);
		const currentDeletedAt = currentPage?.deleted_at ?? null;
		const localDeletedAt = page.deletedAt ?? null;
		return (
			!currentPage ||
			currentPage.title !== page.title ||
			currentPage.content !== page.content ||
			currentDeletedAt !== localDeletedAt
		);
	});

	if (pagesToUpdate.length > 0) {
		const { error: upsertError } = await supabase.from('pages').upsert(
			pagesToUpdate.map((page) => ({
				id: page.id,
				user_id: userId,
				title: page.title,
				content: page.content,
				deleted_at: page.deletedAt ?? null,
				updated_at: page.updatedAt
			}))
		);

		if (upsertError) {
			throw upsertError;
		}
	}

	const pageIdMap = await insertPages(supabase, userId, localPages);

	const activePageId =
		pageIdMap.get(normalizedSession.activePageId) ?? normalizedSession.activePageId;
	const remoteActivePageId = currentRemote?.activePageId ?? null;
	if (remoteActivePageId !== (isRemotePageId(activePageId) ? activePageId : null)) {
		await upsertUserSettings(supabase, userId, isRemotePageId(activePageId) ? activePageId : null);
	}

	return {
		pageIdMap,
		activePageId: isRemotePageId(activePageId) ? activePageId : null
	};
}

function isRemotePageId(id: string): boolean {
	return UUID_PATTERN.test(id);
}

function shouldInsertLocalPage(session: EditorSession, page: EditorPage): boolean {
	// The initial bootstrap note is a single, active, empty/untitled local-only page.
	// Do not sync that placeholder until the user creates real content/notes.
	const isBootstrapPlaceholder =
		session.pages.length === 1 &&
		session.activePageId === page.id &&
		page.deletedAt === null &&
		page.content.length === 0 &&
		page.title === UNTITLED_PAGE &&
		page.lastSyncedAt === null &&
		page.lastSyncedVersion === null &&
		page.syncStatus === 'local-only';

	return !isBootstrapPlaceholder;
}

async function insertPages(
	supabase: SupabaseClient,
	userId: string,
	pages: EditorPage[]
): Promise<Map<string, string>> {
	const pageIdMap = new Map<string, string>();

	for (const page of pages) {
		const { data, error } = await supabase
			.from('pages')
			.insert({
				user_id: userId,
				title: page.title,
				content: page.content,
				deleted_at: page.deletedAt ?? null,
				updated_at: page.updatedAt
			})
			.select('id')
			.single();

		if (error) {
			throw error;
		}

		pageIdMap.set(page.id, data.id);
	}

	return pageIdMap;
}

async function upsertUserSettings(
	supabase: SupabaseClient,
	userId: string,
	activePageId: string | null
) {
	const { error } = await supabase.from('user_settings').upsert({
		user_id: userId,
		active_page_id: activePageId
	});

	if (error) {
		throw error;
	}
}
