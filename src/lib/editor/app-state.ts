import type { EditorState } from './history';
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

export function applyHydratedSession(state: PageAppState, session: EditorSession): PageAppState {
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
	editorState: EditorState
): PageAppTransition {
	return applySessionUpdate(state, {
		...state.session,
		pages: state.session.pages.map((page) =>
			page.id === state.session.activePageId ? updatePageState(page, editorState) : page
		)
	});
}
