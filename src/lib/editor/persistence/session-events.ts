import type { EditorSession } from '../core/session';

export type LocalNoteEventType = 'note-updated' | 'title-updated' | 'new-note' | 'deleted-note';

export interface ChangedPageEvent {
	type: LocalNoteEventType;
	id: string;
}

export function areEditorSessionsEquivalent(a: EditorSession, b: EditorSession): boolean {
	if (a.activePageId !== b.activePageId) {
		return false;
	}

	if (a.pages.length !== b.pages.length) {
		return false;
	}

	for (let index = 0; index < a.pages.length; index += 1) {
		const left = a.pages[index];
		const right = b.pages[index];

		if (!left || !right) {
			return false;
		}

		if (
			left.id !== right.id ||
			left.title !== right.title ||
			left.content !== right.content ||
			left.deletedAt !== right.deletedAt
		) {
			return false;
		}
	}

	return true;
}

export function getChangedPageEvents(
	previousSession: EditorSession,
	nextSession: EditorSession
): ChangedPageEvent[] {
	const previousPages = new Map(previousSession.pages.map((page) => [page.id, page]));
	const nextPages = new Map(nextSession.pages.map((page) => [page.id, page]));
	const events = new Map<string, ChangedPageEvent>();

	for (const [id, nextPage] of nextPages) {
		const previousPage = previousPages.get(id);
		if (!previousPage) {
			events.set(`new-note:${id}`, { type: 'new-note', id });
			continue;
		}

		const titleChanged = previousPage.title !== nextPage.title;
		const contentChanged = previousPage.content !== nextPage.content;
		const deleteChanged = previousPage.deletedAt !== nextPage.deletedAt;
		const becameDeleted = previousPage.deletedAt === null && nextPage.deletedAt !== null;
		const becameActive = previousPage.deletedAt !== null && nextPage.deletedAt === null;

		if (becameDeleted) {
			events.set(`deleted-note:${id}`, { type: 'deleted-note', id });
			continue;
		}

		if (becameActive) {
			events.set(`new-note:${id}`, { type: 'new-note', id });
		}

		if (titleChanged) {
			events.set(`title-updated:${id}`, { type: 'title-updated', id });
		}

		if (contentChanged || deleteChanged) {
			events.set(`note-updated:${id}`, { type: 'note-updated', id });
		}
	}

	for (const [id] of previousPages) {
		if (!nextPages.has(id)) {
			events.set(`deleted-note:${id}`, { type: 'deleted-note', id });
		}
	}

	return [...events.values()];
}
