<script lang="ts">
	import { onMount } from 'svelte';
	import { buildDocument, type EditorDocument } from './editor/basic/parser';
	import { syncEditorDom } from './editor/basic/dom';
	import { extractText, getTextOffset, restoreTextOffset } from './editor/basic/selection';
	import { cutSelection, pasteText, writeSelectionToClipboard } from './editor/basic/clipboard';
	import {
		applyDeleteBackward,
		applyDeleteForward,
		applyEnterKey,
		applyTabKey
	} from './editor/basic/commands';
	import { EditorHistory, type EditorState } from './editor/basic/history';
	import { replaceRange } from './editor/basic/text';
	import { shouldApplyExternalState } from './editor/basic/state-sync';

	export let initialState: EditorState = { text: '', selectionStart: 0, selectionEnd: 0 };
	export let onChange: (state: EditorState) => void = () => {};
	export let spellcheckEnabled = true;

	let text = initialState.text;
	let selectionStart = initialState.selectionStart;
	let selectionEnd = initialState.selectionEnd;
	let documentModel: EditorDocument = buildDocument('');
	let editor: HTMLDivElement;
	let editorHistory: EditorHistory;
	let mounted = false;

	type EditType = 'typing' | 'deleting' | 'command';
	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;
	let isApplyingControlledEdit = false;

	function commitText(nextText: string, nextSelectionStart?: number, nextSelectionEnd?: number) {
		const previousDocument = documentModel;
		const nextDocument = buildDocument(nextText);

		text = nextDocument.text;
		documentModel = nextDocument;
		syncEditorDom(editor, previousDocument, nextDocument);

		const start = Math.max(0, Math.min(nextSelectionStart ?? 0, nextDocument.text.length));
		const end = Math.max(0, Math.min(nextSelectionEnd ?? start, nextDocument.text.length));
		selectionStart = start;
		selectionEnd = end;
		restoreTextOffset(editor, documentModel, start, end);
	}

	function applyState(state: EditorState, forceRerender = false) {
		if (forceRerender) {
			const nextDocument = buildDocument(state.text);
			text = nextDocument.text;
			documentModel = nextDocument;
			syncEditorDom(editor, null, nextDocument);
			restoreTextOffset(editor, documentModel, state.selectionStart, state.selectionEnd);
			return;
		}

		commitText(state.text, state.selectionStart, state.selectionEnd);
	}

	function emitState(nextSelectionStart: number, nextSelectionEnd: number) {
		selectionStart = Math.max(0, Math.min(nextSelectionStart, text.length));
		selectionEnd = Math.max(0, Math.min(nextSelectionEnd, text.length));
		onChange({ text, selectionStart, selectionEnd });
	}

	function reportSelection() {
		if (!editor) return;
		const { start, end } = getTextOffset(editor, documentModel);
		emitState(start, end);
	}

	function onCopy(event: ClipboardEvent) {
		event.preventDefault();
		const { start, end } = getTextOffset(editor, documentModel);
		writeSelectionToClipboard(event.clipboardData, text, documentModel, { start, end });
	}

	function onCut(event: ClipboardEvent) {
		event.preventDefault();
		const { start, end } = getTextOffset(editor, documentModel);
		writeSelectionToClipboard(event.clipboardData, text, documentModel, { start, end });
		editorHistory.push({ text, selectionStart: start, selectionEnd: end });
		const change = cutSelection(text, { start, end });
		commitText(change.text, change.selectionStart, change.selectionEnd);
		emitState(change.selectionStart, change.selectionEnd);
	}

	function onPaste(event: ClipboardEvent) {
		event.preventDefault();
		const pasted = event.clipboardData?.getData('text/plain') ?? '';
		if (!pasted) return;

		const { start, end } = getTextOffset(editor, documentModel);
		editorHistory.push({ text, selectionStart: start, selectionEnd: end });
		const change = pasteText(text, { start, end }, pasted);
		commitText(change.text, change.selectionStart, change.selectionEnd);
		emitState(change.selectionStart, change.selectionEnd);
	}

	function applyControlledEdit(
		nextText: string,
		selectionStart: number,
		selectionEnd = selectionStart
	) {
		isApplyingControlledEdit = true;
		commitText(nextText, selectionStart, selectionEnd);
		isApplyingControlledEdit = false;
		emitState(selectionStart, selectionEnd);
	}

	function onBeforeInput(event: InputEvent) {
		const now = Date.now();
		const isTyping = event.inputType === 'insertText' && !event.data?.includes('\n');
		const isDeleting =
			event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward';
		const currentEditType: EditType = isTyping ? 'typing' : isDeleting ? 'deleting' : 'command';

		const { start, end } = getTextOffset(editor, documentModel);
		const hasSelection = start !== end;
		const shouldPush =
			currentEditType === 'command' ||
			lastEditType !== currentEditType ||
			now - lastEditTime > TYPING_WINDOW ||
			(isDeleting && hasSelection);

		if (shouldPush) {
			editorHistory.push({ text, selectionStart: start, selectionEnd: end });
		}

		lastEditType = currentEditType;
		lastEditTime = now;

		if (event.isComposing) return;

		if (event.inputType === 'insertText' && event.data) {
			event.preventDefault();
			const change = replaceRange(text, { start, end }, event.data);
			applyControlledEdit(change.text, change.selectionStart, change.selectionEnd);
			return;
		}

		if (event.inputType === 'deleteContentBackward') {
			event.preventDefault();
			const change = applyDeleteBackward(text, { start, end });
			applyControlledEdit(change.text, change.selectionStart, change.selectionEnd);
			return;
		}

		if (event.inputType === 'deleteContentForward') {
			event.preventDefault();
			const change = applyDeleteForward(text, { start, end });
			applyControlledEdit(change.text, change.selectionStart, change.selectionEnd);
			return;
		}

		if (event.inputType === 'insertParagraph') {
			event.preventDefault();
			const change = replaceRange(text, { start, end }, '\n');
			applyControlledEdit(change.text, change.selectionStart, change.selectionEnd);
		}
	}

	function onInput() {
		if (isApplyingControlledEdit) return;

		requestAnimationFrame(() => {
			const { start, end } = getTextOffset(editor, documentModel);
			commitText(extractText(editor), start, end);
			emitState(start, end);
		});
	}

	function onKeydown(event: KeyboardEvent) {
		const { start, end } = getTextOffset(editor, documentModel);

		if (event.key === 'Tab' && !(event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			editorHistory.push({ text, selectionStart: start, selectionEnd: end });
			const change = applyTabKey(text, { start, end }, event.shiftKey);
			commitText(change.text, change.selectionStart, change.selectionEnd);
			emitState(change.selectionStart, change.selectionEnd);
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			editorHistory.push({ text, selectionStart: start, selectionEnd: end });
			const change = applyEnterKey(text, { start, end });
			commitText(change.text, change.selectionStart, change.selectionEnd);
			emitState(change.selectionStart, change.selectionEnd);
			return;
		}

		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
			event.preventDefault();
			editorHistory.undo();
			return;
		}

		if (
			(event.ctrlKey || event.metaKey) &&
			((event.shiftKey && event.key === 'Z') || event.key === 'y')
		) {
			event.preventDefault();
			editorHistory.redo();
		}
	}

	onMount(() => {
		editorHistory = new EditorHistory(
			() => {
				const { start, end } = getTextOffset(editor, documentModel);
				return { text, selectionStart: start, selectionEnd: end };
			},
			(state: EditorState) => {
				applyState(state);
				emitState(state.selectionStart, state.selectionEnd);
			}
		);

		editorHistory.push(initialState);
		applyState(initialState, true);
		mounted = true;
		editor.focus();
	});

	$: if (
		mounted &&
		shouldApplyExternalState(initialState, { text, selectionStart, selectionEnd })
	) {
		applyState(initialState);
	}
</script>

<main class="editor">
	<div
		class="editable"
		class:empty={text.length === 0}
		contenteditable="true"
		spellcheck={spellcheckEnabled}
		bind:this={editor}
		on:beforeinput={onBeforeInput}
		on:input={onInput}
		on:keydown={onKeydown}
		on:copy={onCopy}
		on:cut={onCut}
		on:paste={onPaste}
		on:mouseup={reportSelection}
		on:keyup={reportSelection}
		on:focusout={reportSelection}
		aria-label="Markdown editor"
		role="textbox"
		tabindex="0"
	></div>
</main>

<style>
	.editor {
		position: relative;
		width: 100%;
		font-family: 'Roboto Mono', monospace;
		font-size: 18px;
		line-height: 1.7;
		box-sizing: border-box;
	}

	.editable {
		width: 100%;
		box-sizing: border-box;
		padding: 4rem 1.5rem;
		outline: none;
		white-space: pre-wrap;
		word-break: break-word;
		caret-color: var(--editor-caret-color, #555);
	}

	.editable::selection {
		background: var(--editor-selection-color, rgba(180, 213, 255, 0.6));
	}

	.editable.empty::before {
		content: 'Start typing...';
		color: var(--editor-placeholder-color, #999);
		pointer-events: none;
		position: absolute;
	}

	:global(.editable .line) {
		display: block;
		min-height: 1.7em;
		margin: 0;
		padding: 0;
	}

	:global(.editable .line.list) {
		padding-left: calc(var(--prefix-width) * 1ch + var(--list-level) * 4ch);
		text-indent: calc(-1 * (var(--prefix-width) * 1ch + var(--list-level) * 4ch));
	}

	:global(.editable .line.heading) {
		font-weight: 700;
	}

	:global(.editable .line.code) {
		background: var(--editor-code-background, rgba(0, 0, 0, 0.04));
		font-family: 'Roboto Mono', monospace;
	}

	:global(.editable .line.code.code_fence) {
		color: var(--editor-muted-color, #666);
	}

	:global(.editable .line.code.code_content) {
		padding-left: 0;
	}

	:global(.editable .inline-code) {
		background: var(--editor-code-background, rgba(0, 0, 0, 0.04));
		font-family: 'Roboto Mono', monospace;
		border-radius: 0.2rem;
		padding: 0 0.15rem;
	}

	:global(.editable .inline-code .code-marker) {
		font-weight: inherit;
		font-style: inherit;
	}

	:global(.editable .syntax-marker) {
		font-weight: 400;
		font-style: normal;
	}

	@media (min-width: 768px) {
		.editor {
			max-width: 680px;
			margin: 0 auto;
			display: block;
		}

		.editable {
			padding: 8rem 1.5rem;
		}
	}
</style>
