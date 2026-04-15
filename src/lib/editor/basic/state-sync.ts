import type { EditorState } from './history';

export function shouldApplyExternalState(
	nextState: EditorState,
	currentState: EditorState
): boolean {
	return (
		nextState.text !== currentState.text ||
		nextState.selectionStart !== currentState.selectionStart ||
		nextState.selectionEnd !== currentState.selectionEnd
	);
}
