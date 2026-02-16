export interface EditorState {
	text: string;
	selectionStart: number;
	selectionEnd: number;
}


export class EditorHistory {
	private undoStack: EditorState[] = [];
	private redoStack: EditorState[] = [];
	private textArea: HTMLTextAreaElement;
	private setText: (text: string) => void;
	private isApplyingHistory = false;

	private MAX_HISTORY = 100;

	constructor(textArea: HTMLTextAreaElement, setText: (text: string) => void) {
		this.textArea = textArea;
		this.setText = setText;
	}

	private setState(state: EditorState) {
		requestAnimationFrame(() => {
			this.setText(state.text);
			this.textArea.selectionStart = state.selectionStart;
			this.textArea.selectionEnd = state.selectionEnd;
			this.textArea.focus();
			this.isApplyingHistory = false;
		})
	}

	push(state: EditorState) {
		if (this.isApplyingHistory) return;

		this.undoStack.push(state);

		// limit undo stack size
		if (this.undoStack.length > this.MAX_HISTORY) {
			this.undoStack.shift();
		}

		// clear redo stack on new action
		this.redoStack = [];
	}

	undo() {
		if (this.undoStack.length === 0) return;

		this.isApplyingHistory = true;
		const currentState = {
			text: this.textArea.value,
			selectionStart: this.textArea.selectionStart,
			selectionEnd: this.textArea.selectionEnd
		};
		this.redoStack.push(currentState);

		const prevState = this.undoStack.pop()!;
		this.setState(prevState);
	}

	redo() {
		if (this.redoStack.length === 0) return;

		this.isApplyingHistory = true;
		const currentState = {
			text: this.textArea.value,
			selectionStart: this.textArea.selectionStart,
			selectionEnd: this.textArea.selectionEnd
		};
		this.undoStack.push(currentState);

		const nextState = this.redoStack.pop()!;
		this.setState(nextState);
	}
}
