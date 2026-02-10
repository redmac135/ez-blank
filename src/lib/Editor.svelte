<script lang="ts">
	import { onMount } from 'svelte';

	let text: string = '';
	let textarea: HTMLTextAreaElement;

	interface EditorState {
		text: string;
		selectionStart: number;
		selectionEnd: number;
	}

	const SESSION_KEY = 'ez-blank-session-v1';
	let saveTimeout: number | null = null;

	let undoStack: EditorState[] = [];
	let redoStack: EditorState[] = [];
	let isUndoing = false;

	type EditType = 'typing' | 'deleting' | 'command';

	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;

	function pushState() {
		if (isUndoing) return; // don't push state while undoing

		console.table({ undoStack, redoStack });

		undoStack.push({
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		});

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
			isUndoing = false;
		});
	}

	function redo() {
		console.log('redo', { undoStack, redoStack });
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
		// undo redo
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
			e.preventDefault();
			undo();
		}
		if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key === 'Z') || e.key === 'y')) {
			e.preventDefault();
			redo();
		}
	}

	function persistText() {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = window.setTimeout(() => {
			const state: EditorState = {
				text,
				selectionStart: textarea.selectionStart,
				selectionEnd: textarea.selectionEnd
			};
			sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
		}, 500);
	}

	function onInput() {
		persistText();
	}

	onMount(() => {
		const saved = sessionStorage.getItem(SESSION_KEY);
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
