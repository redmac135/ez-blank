<script lang="ts">
	import { onMount } from 'svelte';

	let text: string = '';
	let textarea: HTMLTextAreaElement;

	interface EditorState {
		text: string;
		selectionStart: number;
		selectionEnd: number;
	}

	const STORAGE_KEY = 'ez-blank-session-v1';
	let saveTimeout: number;

	let undoStack: EditorState[] = [];
	let redoStack: EditorState[] = [];
	let isUndoing = false;

	type EditType = 'typing' | 'deleting' | 'command';

	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;

	function pushState() {
		if (isUndoing) return; // don't push state while undoing

		const state: EditorState = {
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		};

		undoStack.push(state);
		persistState(state);

		// limit undo stack size
		if (undoStack.length > 100) undoStack.shift();

		// clear redo stack on new input
		redoStack = [];
	}

	function undo() {
		if (undoStack.length === 0) return;

		isUndoing = true;
		const state = undoStack.pop()!;
		redoStack.push({
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		});

		text = state.text;
		requestAnimationFrame(() => {
			textarea.selectionStart = state.selectionStart;
			textarea.selectionEnd = state.selectionEnd;
			textarea.focus();
			persistState(state);
			isUndoing = false;
		});
	}

	function redo() {
		if (redoStack.length === 0) return;

		isUndoing = true;
		const state = redoStack.pop()!;
		undoStack.push({
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		});

		text = state.text;
		requestAnimationFrame(() => {
			textarea.selectionStart = state.selectionStart;
			textarea.selectionEnd = state.selectionEnd;
			textarea.focus();
			persistState(state);
			isUndoing = false;
		});
	}

	function onBeforeInput(e: Event) {
		if (isUndoing) return;

		const ie = e as InputEvent;
		const now = Date.now();

		const isTyping = ie.inputType === 'insertText' && !ie.data?.includes('\n');

		const isDeleting =
			ie.inputType === 'deleteContentBackward' || ie.inputType === 'deleteContentForward';

		let currentEditType: EditType = isTyping ? 'typing' : isDeleting ? 'deleting' : 'command';

		const shouldPush =
			currentEditType === 'command' ||
			lastEditType !== currentEditType ||
			now - lastEditTime > TYPING_WINDOW ||
			(isDeleting && textarea.selectionStart !== textarea.selectionEnd); // always push before deleting a selection

		if (shouldPush) {
			pushState();
		}

		lastEditType = currentEditType;
		lastEditTime = now;
	}

	function onKeydown(e: KeyboardEvent) {
		// insert tab
		if (e.key === 'Tab') {
			e.preventDefault();

			const TAB = '\t';

			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;

			const before = text.slice(0, start);
			const after = text.slice(end);

			// if there's a selection, replace it with a tab
			text = before + TAB + after;

			requestAnimationFrame(() => {
				const pos = start + TAB.length;
				textarea.selectionStart = pos;
				textarea.selectionEnd = pos;
				persistText();
			});
			return;
		}

		// undo redo
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
			e.preventDefault();
			undo();
			return;
		}
		if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key === 'Z') || e.key === 'y')) {
			e.preventDefault();
			redo();
			return;
		}
	}

	function persistState(state: EditorState) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	}

	function persistText() {
		const state: EditorState = {
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		};

		clearTimeout(saveTimeout);
		saveTimeout = window.setTimeout(() => {
			persistState(state);
		}, 300);
	}

	function onInput() {
		persistText();
	}

	function handleBeforeUnload() {
		const state: EditorState = {
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		};
		persistState(state);
	}

	function handleStorage(e: StorageEvent) {
		if (e.key === STORAGE_KEY && e.newValue) {
			const state: EditorState = JSON.parse(e.newValue);
			text = state.text;
			requestAnimationFrame(() => {
				textarea.selectionStart = state.selectionStart;
				textarea.selectionEnd = state.selectionEnd;
			});
		}
	}

	onMount(() => {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const state: EditorState = JSON.parse(saved);
			text = state.text;
			requestAnimationFrame(() => {
				textarea.selectionStart = state.selectionStart;
				textarea.selectionEnd = state.selectionEnd;

				pushState(); // push loaded state to undo stack
			});
		} else {
			pushState(); // push initial empty state
		}
	});
</script>

<svelte:window on:beforeunload={handleBeforeUnload} on:storage={handleStorage} />

<textarea
	bind:this={textarea}
	bind:value={text}
	on:keydown={onKeydown}
	on:beforeinput={onBeforeInput}
	on:input={onInput}
	placeholder="Start typing..."
></textarea>

<style>
	textarea {
		width: 100%;
		min-height: 100vh;
		padding: 1.5rem;

		font-family:
			'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
		font-size: 18px;
		line-height: 1.7;
		font-variant-ligatures: contextual;

		color: #111;
		background: transparent;
		border: none;
		outline: none;

		resize: none;
		caret-color: #555;

		/* Don't allow scrolling */
		overflow: hidden;

		tab-size: 4;
	}

	textarea::selection {
		background: #e5e7eb;
	}

	@media (min-width: 768px) {
		textarea {
			max-width: 680px;
			margin: 0 auto;
			padding: 8rem 1.5rem;
			display: block;
		}
	}
</style>
