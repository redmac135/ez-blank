<script lang="ts">
	import { onMount } from 'svelte';
	import { buildDocument, type EditorDocument } from './editor/parser';
	import { syncEditorDom } from './editor/dom';
	import { extractText, getTextOffset, restoreTextOffset } from './editor/selection';
	import { cutSelection, pasteText, writeSelectionToClipboard } from './editor/clipboard';
	import {
		deleteBackward,
		deleteForward,
		getCurrentLineBounds,
		getListMetadata,
		getSelectedBlockBounds,
		replaceRange
	} from './editor/edits';
	import { EditorHistory, type EditorState } from './editor/history';
	import { EditorStorage } from './editor/storage';

	let text = '';
	let documentModel: EditorDocument = buildDocument('');
	let editor: HTMLDivElement;
	let editorHistory: EditorHistory;
	let saveTimeout: number;

	type EditType = 'typing' | 'deleting' | 'command';
	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;
	let isApplyingControlledEdit = false;

	function commitText(nextText: string, selectionStart?: number, selectionEnd?: number) {
		const previousDocument = documentModel;
		const nextDocument = buildDocument(nextText);

		text = nextDocument.text;
		documentModel = nextDocument;
		syncEditorDom(editor, previousDocument, nextDocument);

		const start = Math.max(0, Math.min(selectionStart ?? 0, nextDocument.text.length));
		const end = Math.max(0, Math.min(selectionEnd ?? start, nextDocument.text.length));
		restoreTextOffset(editor, documentModel, start, end);
	}

	function applyState(state: EditorState) {
		const nextDocument = buildDocument(state.text);
		text = nextDocument.text;
		documentModel = nextDocument;
		syncEditorDom(editor, null, nextDocument);
		restoreTextOffset(editor, documentModel, state.selectionStart, state.selectionEnd);
	}

	function persistText() {
		const { start, end } = getTextOffset(editor, documentModel);
		clearTimeout(saveTimeout);
		saveTimeout = window.setTimeout(() => {
			EditorStorage.save({ text, selectionStart: start, selectionEnd: end });
		}, 300);
	}

	function handleBeforeUnload() {
		const { start, end } = getTextOffset(editor, documentModel);
		EditorStorage.save({ text, selectionStart: start, selectionEnd: end });
	}

	function handleStorage(event: StorageEvent) {
		if (event.key !== EditorStorage.STORAGE_KEY || !event.newValue) return;
		const state = EditorStorage.load();
		if (state) applyState(state);
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
		persistText();
	}

	function onPaste(event: ClipboardEvent) {
		event.preventDefault();
		const pasted = event.clipboardData?.getData('text/plain') ?? '';
		if (!pasted) return;

		const { start, end } = getTextOffset(editor, documentModel);
		editorHistory.push({ text, selectionStart: start, selectionEnd: end });
		const change = pasteText(text, { start, end }, pasted);
		commitText(change.text, change.selectionStart, change.selectionEnd);
		persistText();
	}

	function applyControlledEdit(
		nextText: string,
		selectionStart: number,
		selectionEnd = selectionStart
	) {
		isApplyingControlledEdit = true;
		commitText(nextText, selectionStart, selectionEnd);
		isApplyingControlledEdit = false;
		persistText();
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
			const change = deleteBackward(text, { start, end });
			applyControlledEdit(change.text, change.selectionStart, change.selectionEnd);
			return;
		}

		if (event.inputType === 'deleteContentForward') {
			event.preventDefault();
			const change = deleteForward(text, { start, end });
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
			persistText();
		});
	}

	function onKeydown(event: KeyboardEvent) {
		const { start, end } = getTextOffset(editor, documentModel);
		const hasSelection = start !== end;

		if (event.key === 'Tab' && !(event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			editorHistory.push({ text, selectionStart: start, selectionEnd: end });

			if (hasSelection) {
				const { blockStart, blockEnd } = getSelectedBlockBounds(text, { start, end });
				const block = text.slice(blockStart, blockEnd);
				const lines = block.split('\n');

				const modified = lines.map((line) => {
					const metadata = getListMetadata(line);
					if (event.shiftKey) {
						if (line.startsWith('    ')) return line.slice(4);
						if (metadata.listLevel === 1) return line.replace(/^- /, '').replace(/^\d+\. /, '');
						return line;
					}

					return `    ${line}`;
				});

				const nextBlock = modified.join('\n');
				commitText(
					text.slice(0, blockStart) + nextBlock + text.slice(blockEnd),
					blockStart,
					blockStart + nextBlock.length
				);
				persistText();
				return;
			}

			const { lineStart, lineEnd } = getCurrentLineBounds(text, start);
			const lineText = text.slice(lineStart, lineEnd);
			const metadata = getListMetadata(lineText);

			if (event.shiftKey) {
				if (lineText.startsWith('    ')) {
					commitText(
						text.slice(0, lineStart) + lineText.slice(4) + text.slice(lineEnd),
						start - 4,
						start - 4
					);
					persistText();
					return;
				}

				if (metadata.listLevel === 1) {
					const updatedLine = lineText.replace(/^- /, '').replace(/^\d+\. /, '');
					commitText(
						text.slice(0, lineStart) + updatedLine + text.slice(lineEnd),
						Math.max(lineStart, start - metadata.prefix.length),
						Math.max(lineStart, start - metadata.prefix.length)
					);
					persistText();
					return;
				}

				return;
			}

			if (metadata.listLevel > 0) {
				commitText(text.slice(0, lineStart) + '    ' + text.slice(lineStart), start + 4, start + 4);
				persistText();
				return;
			}

			commitText(text.slice(0, start) + '    ' + text.slice(end), start + 4, start + 4);
			persistText();
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			const { lineStart, lineEnd } = getCurrentLineBounds(text, start);
			const lineText = text.slice(lineStart, lineEnd);
			const metadata = getListMetadata(lineText);

			if (metadata.listLevel > 0) {
				editorHistory.push({ text, selectionStart: start, selectionEnd: end });
				const indent = '    '.repeat(metadata.listLevel - 1);

				if (metadata.ordered && lineText.trim().match(/^\d+\.$/)) {
					commitText(text.slice(0, lineStart) + text.slice(lineEnd), lineStart, lineStart);
					persistText();
					return;
				}

				if (!metadata.ordered && lineText.trim() === '-') {
					commitText(text.slice(0, lineStart) + text.slice(lineEnd), lineStart, lineStart);
					persistText();
					return;
				}

				const prefix = metadata.ordered ? `${indent}${metadata.listNumber + 1}. ` : `${indent}- `;
				commitText(
					text.slice(0, start) + '\n' + prefix + text.slice(end),
					start + 1 + prefix.length,
					start + 1 + prefix.length
				);
				persistText();
				return;
			}

			editorHistory.push({ text, selectionStart: start, selectionEnd: end });
			commitText(text.slice(0, start) + '\n' + text.slice(end), start + 1, start + 1);
			persistText();
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
			}
		);

		const saved = EditorStorage.load();
		if (saved) {
			editorHistory.push(saved);
			applyState(saved);
			return;
		}

		const emptyState: EditorState = { text: '', selectionStart: 0, selectionEnd: 0 };
		editorHistory.push(emptyState);
		applyState(emptyState);
	});
</script>

<svelte:window on:beforeunload={handleBeforeUnload} on:storage={handleStorage} />

<main class="editor">
	<div
		class="editable"
		class:empty={text.length === 0}
		contenteditable="true"
		spellcheck="true"
		bind:this={editor}
		on:beforeinput={onBeforeInput}
		on:input={onInput}
		on:keydown={onKeydown}
		on:copy={onCopy}
		on:cut={onCut}
		on:paste={onPaste}
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
		padding: 1.5rem;
		outline: none;
		white-space: pre-wrap;
		word-break: break-word;
		caret-color: #555;
	}

	.editable::selection {
		background: rgba(180, 213, 255, 0.6);
	}

	.editable.empty::before {
		content: 'Start typing...';
		color: #999;
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
