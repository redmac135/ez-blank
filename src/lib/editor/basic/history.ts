export interface EditorState {
	text: string;
	selectionStart: number;
	selectionEnd: number;
}

export class EditorHistory {
	private undoStack: EditorState[] = [];
	private redoStack: EditorState[] = [];
	private isApplyingHistory = false;
	private MAX_HISTORY = 100;

	private getState: () => EditorState;
	private applyState: (state: EditorState) => void;

	constructor(getState: () => EditorState, applyState: (state: EditorState) => void) {
		this.getState = getState;
		this.applyState = applyState;
	}

	push(state: EditorState) {
		if (this.isApplyingHistory) return;

		this.undoStack.push(state);

		if (this.undoStack.length > this.MAX_HISTORY) {
			this.undoStack.shift();
		}

		this.redoStack = [];
	}

	undo() {
		if (this.undoStack.length === 0) return;

		this.isApplyingHistory = true;
		const currentState = this.getState();
		this.redoStack.push(currentState);

		const prevState = this.undoStack.pop()!;
		this.applyState(prevState);

		requestAnimationFrame(() => {
			this.isApplyingHistory = false;
		});
	}

	redo() {
		if (this.redoStack.length === 0) return;

		this.isApplyingHistory = true;
		const currentState = this.getState();
		this.undoStack.push(currentState);

		const nextState = this.redoStack.pop()!;
		this.applyState(nextState);

		requestAnimationFrame(() => {
			this.isApplyingHistory = false;
		});
	}
}
