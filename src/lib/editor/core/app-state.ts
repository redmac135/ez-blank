import type { EditorState } from '../basic/history';
import type { EditorSession } from './session';
import { updatePageState } from './session';

export interface PageAppState {
	session: EditorSession;
	loaded: boolean;
}

export interface PageAppTransition {
	state: PageAppState;
	persistedSession: EditorSession | null;
}

export interface PageEditorUpdate {
	pageId: string;
	state: EditorState;
}

export function applyHydratedSession(session: EditorSession): PageAppState {
	return {
		session,
		loaded: true
	};
}

export function applySessionUpdate(
	state: PageAppState,
	nextSession: EditorSession
): PageAppTransition {
	return {
		state: {
			...state,
			session: nextSession
		},
		persistedSession: state.loaded ? nextSession : null
	};
}

export function applyEditorStateUpdate(
	state: PageAppState,
	editorUpdate: PageEditorUpdate
): PageAppTransition {
	if (!state.session.pages.some((page) => page.id === editorUpdate.pageId)) {
		return {
			state,
			persistedSession: null
		};
	}

	return applySessionUpdate(state, {
		...state.session,
		pages: state.session.pages.map((page) =>
			page.id === editorUpdate.pageId ? updatePageState(page, editorUpdate.state) : page
		)
	});
}
