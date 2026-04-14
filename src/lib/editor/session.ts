import type { EditorState } from './history';

export interface EditorPage extends EditorState {
	id: string;
	title: string;
	content: string;
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
	return {
		id,
		title: derivePageTitle(content),
		content,
		text: content,
		selectionStart: 0,
		selectionEnd: 0
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

	if (session.pages.some((page) => page.id === session.activePageId)) {
		return session;
	}

	return {
		...session,
		activePageId: session.pages[0]!.id
	};
}

export function updatePageState(page: EditorPage, state: EditorState): EditorPage {
	return {
		...page,
		...state,
		content: state.text,
		title: derivePageTitle(state.text)
	};
}

export function updatePageTitle(page: EditorPage, title: string): EditorPage {
	const trimmed = title.trim();
	return {
		...page,
		title: trimmed.length > 0 ? trimmed.slice(0, 48) : UNTITLED_PAGE
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
		typeof value.activePageId === 'string' && pages.some((page) => page.id === value.activePageId)
			? value.activePageId
			: pages[0].id;

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

	return {
		id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `page-${index + 1}`,
		title:
			typeof value.title === 'string' && value.title.trim().length > 0
				? value.title.trim()
				: derivePageTitle(normalizedContent),
		content: normalizedContent,
		text: normalizedContent,
		selectionStart,
		selectionEnd
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
