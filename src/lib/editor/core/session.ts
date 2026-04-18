import type { EditorState } from '../basic/history';
import {
	ANONYMOUS_USERID,
	type PageRecord,
	type PageSyncStatus
} from '../persistence/records';

export interface EditorPage extends EditorState, PageRecord {}

export interface EditorSession {
	pages: EditorPage[];
	activePageId: string;
}

export const UNTITLED_PAGE = 'Untitled';

export function derivePageTitle(content: string): string {
	const firstLine = content
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstLine) {
		return UNTITLED_PAGE;
	}

	return firstLine.replace(/\s+/g, ' ').slice(0, 48);
}

export function createPage(
	content = '',
	options: {
		id?: string;
		userId?: string;
		now?: string;
		isEphemeral?: boolean;
	} = {}
): EditorPage {
	const timestamp = options.now ?? new Date().toISOString();
	return {
		id: options.id ?? createPageId(),
		userId: options.userId ?? ANONYMOUS_USERID,
		title: derivePageTitle(content),
		content,
		text: content,
		selectionStart: 0,
		selectionEnd: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		deletedAt: null,
		lastSyncedAt: null,
		lastKnownRemoteUpdatedAt: null,
		lastKnownRemoteDeletedAt: null,
		syncStatus: 'dirty',
		isEphemeral: options.isEphemeral ?? true
	};
}

export function createSession(userId = ANONYMOUS_USERID): EditorSession {
	const page = createPage('', { userId, isEphemeral: true });
	return {
		pages: [page],
		activePageId: page.id
	};
}

export function ensureValidActivePage(session: EditorSession): EditorSession {
	if (session.pages.length === 0) {
		return createSession();
	}

	const pages = sortPagesByRecency(session.pages);
	if (pages.some((page) => page.id === session.activePageId && page.deletedAt === null)) {
		return {
			...session,
			pages
		};
	}

	const firstVisiblePage = pages.find((page) => page.deletedAt === null);
	if (firstVisiblePage) {
		return {
			...session,
			pages,
			activePageId: firstVisiblePage.id
		};
	}

	return {
		...session,
		pages,
		activePageId: pages[0]!.id
	};
}

export function hasVisibleEphemeralActivePage(session: EditorSession) {
	const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
	return !!activePage && activePage.deletedAt === null && activePage.isEphemeral;
}

export function getRemoteEligibleActivePageId(session: EditorSession): string | null {
	const activePage = session.pages.find((page) => page.id === session.activePageId) ?? null;
	if (!activePage || activePage.deletedAt !== null || activePage.isEphemeral) {
		return null;
	}

	return activePage.id;
}

export function getRemoteActivePageUpdateTarget(
	previousSession: EditorSession,
	nextSession: EditorSession
): string | null {
	const nextActivePageId = getRemoteEligibleActivePageId(nextSession);
	if (nextActivePageId && nextActivePageId !== previousSession.activePageId) {
		return nextActivePageId;
	}

	const previousActiveBefore = previousSession.pages.find((page) => page.id === previousSession.activePageId) ?? null;
	const previousActiveAfter = nextSession.pages.find((page) => page.id === previousSession.activePageId) ?? null;
	if (
		previousActiveBefore &&
		previousActiveBefore.deletedAt === null &&
		previousActiveBefore.isEphemeral &&
		previousActiveAfter &&
		previousActiveAfter.deletedAt === null &&
		!previousActiveAfter.isEphemeral
	) {
		return previousActiveAfter.id;
	}

	return null;
}

export function updatePageState(page: EditorPage, state: EditorState): EditorPage {
	const contentChanged = state.text !== page.content;
	const selectionChanged =
		state.selectionStart !== page.selectionStart || state.selectionEnd !== page.selectionEnd;
	if (!contentChanged && !selectionChanged) {
		return page;
	}

	const nextPage: EditorPage = {
		...page,
		...state,
		content: state.text
	};

	if (!contentChanged) {
		return nextPage;
	}

	const previousDerivedTitle = derivePageTitle(page.content);
	const nextDerivedTitle = derivePageTitle(state.text);
	const shouldAutoDeriveTitle = page.title === previousDerivedTitle;

	return {
		...nextPage,
		title: shouldAutoDeriveTitle ? nextDerivedTitle : page.title,
		updatedAt: new Date().toISOString(),
		syncStatus: nextDirtyStatus(page.syncStatus),
		isEphemeral: false
	};
}

export function updatePageTitle(page: EditorPage, title: string): EditorPage {
	const trimmed = title.trim();
	return {
		...page,
		title: trimmed.length > 0 ? trimmed.slice(0, 48) : UNTITLED_PAGE,
		updatedAt: new Date().toISOString(),
		syncStatus: nextDirtyStatus(page.syncStatus),
		isEphemeral: false
	};
}

export function markPageDeleted(page: EditorPage, deletedAt = new Date().toISOString()): EditorPage {
	return {
		...page,
		deletedAt,
		updatedAt: deletedAt,
		syncStatus: nextDirtyStatus(page.syncStatus),
		isEphemeral: false
	};
}

export function materializePage(page: EditorPage): EditorPage {
	if (!page.isEphemeral) {
		return page;
	}

	return {
		...page,
		updatedAt: new Date().toISOString(),
		isEphemeral: false
	};
}

export function clonePageForUser(page: EditorPage, userId: string): EditorPage {
	const cloned = createPage(page.content, { userId, isEphemeral: false });
	return {
		...cloned,
		title: page.title,
		content: page.content,
		text: page.content,
		deletedAt: page.deletedAt,
		syncStatus: 'dirty',
		isEphemeral: false
	};
}

export function markPageDirty(page: EditorPage, userId = page.userId): EditorPage {
	return {
		...page,
		userId,
		updatedAt: new Date().toISOString(),
		lastSyncedAt: null,
		lastKnownRemoteUpdatedAt: null,
		lastKnownRemoteDeletedAt: null,
		syncStatus: page.syncStatus === 'conflict' ? 'conflict' : 'dirty'
	};
}

export function normalizeSession(value: unknown, userId = ANONYMOUS_USERID): EditorSession | null {
	if (!isRecord(value)) return null;

	if (isLegacyEditorState(value)) {
		return migrateLegacyState(value, userId);
	}

	if (!Array.isArray(value.pages)) {
		return null;
	}

	const pages = value.pages
		.map((page, index) => normalizePage(page, index, userId))
		.filter((page): page is EditorPage => page !== null)
	.sort(comparePagesByRecency);

	if (pages.length === 0) {
		return createSession(userId);
	}

	const activePageId =
		typeof value.activePageId === 'string' &&
		pages.some((page) => page.id === value.activePageId && page.deletedAt === null)
			? value.activePageId
			: (pages.find((page) => page.deletedAt === null)?.id ?? pages[0].id);

	return ensureValidActivePage({ pages, activePageId });
}

export function migrateLegacyState(state: EditorState, userId = ANONYMOUS_USERID): EditorSession {
	const page = updatePageState(createPage('', { userId, isEphemeral: true }), state);
	return {
		pages: [page],
		activePageId: page.id
	};
}

function normalizePage(value: unknown, index: number, userId: string): EditorPage | null {
	if (!isRecord(value)) return null;

	const content =
		typeof value.content === 'string'
			? value.content
			: typeof value.text === 'string'
				? value.text
				: '';
	const normalizedContent = content.replace(/\r\n?/g, '\n');
	const selectionStart = clampSelection(
		typeof value.selectionStart === 'number' ? value.selectionStart : 0,
		normalizedContent.length
	);
	const selectionEnd = clampSelection(
		typeof value.selectionEnd === 'number' ? value.selectionEnd : selectionStart,
		normalizedContent.length
	);
	const createdAt = readTimestamp(value.createdAt, value.created_at);
	const updatedAt = readTimestamp(value.updatedAt, value.updated_at) ?? createdAt;
	const deletedAt = readNullableTimestamp(value.deletedAt, value.deleted_at);

	return {
		id: typeof value.id === 'string' && value.id.length > 0 ? value.id : createFallbackPageId(index),
		userId: typeof value.userId === 'string' && value.userId.length > 0 ? value.userId : userId,
		title:
			typeof value.title === 'string' && value.title.trim().length > 0
				? value.title.trim()
				: derivePageTitle(normalizedContent),
		content: normalizedContent,
		text: normalizedContent,
		selectionStart,
		selectionEnd,
		createdAt,
		updatedAt,
		deletedAt,
		lastSyncedAt: readNullableTimestamp(value.lastSyncedAt),
		lastKnownRemoteUpdatedAt: readNullableTimestamp(value.lastKnownRemoteUpdatedAt),
		lastKnownRemoteDeletedAt: readNullableTimestamp(value.lastKnownRemoteDeletedAt),
		syncStatus: normalizeSyncStatus(value.syncStatus),
		isEphemeral: typeof value.isEphemeral === 'boolean' ? value.isEphemeral : false
	};
}

function isLegacyEditorState(value: object): value is EditorState {
	return 'text' in value && 'selectionStart' in value && 'selectionEnd' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function clampSelection(value: number, max: number) {
	return Math.max(0, Math.min(value, max));
}

function createPageId() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	return `page-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function createFallbackPageId(index: number) {
	return `page-${index + 1}`;
}

function readTimestamp(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}

	return new Date().toISOString();
}

function readNullableTimestamp(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string') {
			return value;
		}
	}

	return null;
}

function normalizeSyncStatus(value: unknown): PageSyncStatus {
	return value === 'synced' || value === 'pending_push' || value === 'conflict' ? value : 'dirty';
}

function nextDirtyStatus(status: PageSyncStatus): PageSyncStatus {
	return status === 'conflict' ? 'conflict' : 'dirty';
}

export function sortPagesByRecency(pages: EditorPage[]) {
	return [...pages].sort(comparePagesByRecency);
}

export function comparePagesByRecency(left: EditorPage, right: EditorPage) {
	if (left.updatedAt !== right.updatedAt) {
		return right.updatedAt.localeCompare(left.updatedAt);
	}

	if (left.createdAt !== right.createdAt) {
		return right.createdAt.localeCompare(left.createdAt);
	}

	return left.id.localeCompare(right.id);
}
