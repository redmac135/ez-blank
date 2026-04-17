import type { EditorState } from '../basic/history';

export interface EditorPage extends EditorState {
	id: string;
	title: string;
	content: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

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

export function createPage(content = '', id = createPageId()): EditorPage {
	const createdAt = new Date().toISOString();
	return {
		id,
		title: derivePageTitle(content),
		content,
		text: content,
		selectionStart: 0,
		selectionEnd: 0,
		createdAt,
		updatedAt: createdAt,
		deletedAt: null
	};
}

export function createSession(): EditorSession {
	const page = createPage();
	return {
		pages: [page],
		activePageId: page.id
	};
}

export function ensureValidActivePage(session: EditorSession): EditorSession {
	if (session.pages.length === 0) {
		return createSession();
	}

	if (session.pages.some((page) => page.id === session.activePageId && page.deletedAt === null)) {
		return session;
	}

	const firstVisiblePage = session.pages.find((page) => page.deletedAt === null);
	if (firstVisiblePage) {
		return {
			...session,
			activePageId: firstVisiblePage.id
		};
	}

	return {
		...session,
		activePageId: session.pages[0]!.id
	};
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
		updatedAt: new Date().toISOString()
	};
}

export function updatePageTitle(page: EditorPage, title: string): EditorPage {
	const trimmed = title.trim();
	return {
		...page,
		title: trimmed.length > 0 ? trimmed.slice(0, 48) : UNTITLED_PAGE,
		updatedAt: new Date().toISOString()
	};
}

export function markPageDeleted(page: EditorPage, deletedAt = new Date().toISOString()): EditorPage {
	return {
		...page,
		deletedAt,
		updatedAt: deletedAt
	};
}

export function normalizeSession(value: unknown): EditorSession | null {
	if (!isRecord(value)) return null;

	if (isLegacyEditorState(value)) {
		return migrateLegacyState(value);
	}

	if (!Array.isArray(value.pages)) {
		return null;
	}

	const pages = value.pages
		.map((page, index) => normalizePage(page, index))
		.filter((page): page is EditorPage => page !== null);

	if (pages.length === 0) {
		return createSession();
	}

	const activePageId =
		typeof value.activePageId === 'string' &&
		pages.some((page) => page.id === value.activePageId && page.deletedAt === null)
			? value.activePageId
			: (pages.find((page) => page.deletedAt === null)?.id ?? pages[0].id);

	return ensureValidActivePage({ pages, activePageId });
}

export function migrateLegacyState(state: EditorState): EditorSession {
	const page = updatePageState(createPage(state.text), state);
	return {
		pages: [page],
		activePageId: page.id
	};
}

function normalizePage(value: unknown, index: number): EditorPage | null {
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
	const createdAt =
		typeof value.createdAt === 'string' && value.createdAt.length > 0
			? value.createdAt
			: typeof value.created_at === 'string' && value.created_at.length > 0
				? value.created_at
				: new Date().toISOString();
	const updatedAt =
		typeof value.updatedAt === 'string' && value.updatedAt.length > 0
			? value.updatedAt
			: typeof value.updated_at === 'string' && value.updated_at.length > 0
				? value.updated_at
				: createdAt;
	const deletedAt =
		typeof value.deletedAt === 'string'
			? value.deletedAt
			: typeof value.deleted_at === 'string'
				? value.deleted_at
				: null;

	return {
		id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `page-${index + 1}`,
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
		deletedAt
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
	return `page-${Math.random().toString(36).slice(2, 10)}`;
}
