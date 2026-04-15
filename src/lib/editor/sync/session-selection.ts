import type { EditorSession } from '../core/session';

// Runtime helper for preserving selection when session content is reloaded.

export function mergeEditorSelections(
	nextSession: EditorSession,
	selectionSource: EditorSession
): EditorSession {
	const sourcePages = new Map(selectionSource.pages.map((page) => [page.id, page]));

	return {
		...nextSession,
		pages: nextSession.pages.map((page) => {
			const sourcePage = sourcePages.get(page.id);
			if (!sourcePage) {
				return page;
			}

			return {
				...page,
				selectionStart: clampSelection(sourcePage.selectionStart, page.content.length),
				selectionEnd: clampSelection(sourcePage.selectionEnd, page.content.length)
			};
		})
	};
}

function clampSelection(value: number, max: number) {
	return Math.max(0, Math.min(value, max));
}
