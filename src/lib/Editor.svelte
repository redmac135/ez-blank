<script lang="ts">
	import { onMount } from 'svelte';
	import { parseText, parseLine, renderLine } from './editor/parser';
	import { EditorHistory, type EditorState } from './editor/history';
	import { EditorStorage } from './editor/storage';

	let text: string = '';
	let textarea: HTMLTextAreaElement;
	let renderedHtml: string = '';
	let renderLayer: HTMLDivElement;

	let editorHistory: EditorHistory;

	$: renderedHtml = parseText(text).map(renderLine).join('');

	let saveTimeout: number;

	type EditType = 'typing' | 'deleting' | 'command';

	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;

	function getCurrentLineBounds(pos: number) {
		const before = text.slice(0, pos);
		const lineStart = before.lastIndexOf('\n') + 1;

		const nextNewline = text.indexOf('\n', pos);
		const lineEnd = nextNewline === -1 ? text.length : nextNewline;

		return { lineStart, lineEnd };
	}

	function getSelectedBlockBounds(start: number, end: number) {
		const first = getCurrentLineBounds(start).lineStart;
		const last = getCurrentLineBounds(end).lineEnd;
		return { blockStart: first, blockEnd: last };
	}

	function onBeforeInput(e: Event) {
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
			const state: EditorState = {
				text,
				selectionStart: textarea.selectionStart,
				selectionEnd: textarea.selectionEnd
			};
			editorHistory.push(state);
		}

		lastEditType = currentEditType;
		lastEditTime = now;
	}

	function onKeydown(e: KeyboardEvent) {
		const start = textarea.selectionStart;
		const end = textarea.selectionEnd;
		const hasSelection = start !== end;

		// =========================
		// TAB / SHIFT+TAB
		// =========================
		if (e.key === 'Tab' && !(e.ctrlKey || e.metaKey)) {
			e.preventDefault();

			// MULTI-LINE SELECTION
			if (hasSelection) {
				const { blockStart, blockEnd } = getSelectedBlockBounds(start, end);
				const block = text.slice(blockStart, blockEnd);
				const lines = block.split('\n');

				const modified = lines.map((line) => {
					const parsed = parseLine(line);

					// SHIFT+TAB → UNINDENT
					if (e.shiftKey) {
						if (line.startsWith('\t')) return line.slice(1);
						if (parsed.listLevel === 1) return line.replace(/^- /, '');
						return line;
					}

					// TAB → INDENT
					return '\t' + line;
				});

				const newBlock = modified.join('\n');

				text = text.slice(0, blockStart) + newBlock + text.slice(blockEnd);

				requestAnimationFrame(() => {
					textarea.selectionStart = blockStart;
					textarea.selectionEnd = blockStart + newBlock.length;
				});

				return;
			}

			// SINGLE CURSOR
			const { lineStart, lineEnd } = getCurrentLineBounds(start);
			const lineText = text.slice(lineStart, lineEnd);
			const parsed = parseLine(lineText);

			// SHIFT+TAB (single line)
			if (e.shiftKey) {
				if (lineText.startsWith('\t')) {
					text = text.slice(0, lineStart) + lineText.slice(1) + text.slice(lineEnd);
					requestAnimationFrame(() => {
						textarea.selectionStart = start - 1;
						textarea.selectionEnd = start - 1;
					});
				} else if (parsed.listLevel === 1) {
					text = text.slice(0, lineStart) + lineText.replace(/^- /, '') + text.slice(lineEnd);
				}
				return;
			}

			// TAB inside list → indent
			if (parsed.listLevel > 0) {
				text = text.slice(0, lineStart) + '\t' + text.slice(lineStart);

				requestAnimationFrame(() => {
					textarea.selectionStart = start + 1;
					textarea.selectionEnd = start + 1;
				});
				return;
			}

			// NOT A LIST → normal tab
			const before = text.slice(0, start);
			const after = text.slice(end);

			text = before + '\t' + after;

			requestAnimationFrame(() => {
				const pos = start + 1;
				textarea.selectionStart = pos;
				textarea.selectionEnd = pos;
			});
			return;
		}

		// =========================
		// ENTER (LIST CONTINUATION)
		// =========================
		if (e.key === 'Enter') {
			const { lineStart, lineEnd } = getCurrentLineBounds(start);
			const lineText = text.slice(lineStart, lineEnd);
			const parsed = parseLine(lineText);

			if (parsed.listLevel > 0) {
				e.preventDefault();

				const indent = '\t'.repeat(parsed.listLevel - 1);
				const prefix = indent + '- ';

				// If empty list item → exit list
				if (lineText.trim() === '-') {
					text = text.slice(0, lineStart) + text.slice(lineEnd);

					requestAnimationFrame(() => {
						textarea.selectionStart = lineStart + indent.length;
						textarea.selectionEnd = lineStart + indent.length;
					});
					return;
				}

				text = text.slice(0, start) + '\n' + prefix + text.slice(start);

				requestAnimationFrame(() => {
					const pos = start + 1 + prefix.length;
					textarea.selectionStart = pos;
					textarea.selectionEnd = pos;
				});

				return;
			}
		}

		// =========================
		// UNDO / REDO
		// =========================
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
			e.preventDefault();
			editorHistory.undo();
			return;
		}
		if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key === 'Z') || e.key === 'y')) {
			e.preventDefault();
			editorHistory.redo();
			return;
		}
	}

	function persistText() {
		const state: EditorState = {
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		};

		clearTimeout(saveTimeout);
		saveTimeout = window.setTimeout(() => {
			EditorStorage.save(state);
		}, 300);
	}

	function onInput() {
		autoResize();
		persistText();
	}

	function handleBeforeUnload() {
		const state: EditorState = {
			text,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd
		};
		EditorStorage.save(state);
	}

	function handleStorage(e: StorageEvent) {
		if (e.key === EditorStorage.STORAGE_KEY && e.newValue) {
			const state = EditorStorage.load();

			if (!state) return;

			renderState(state);
		}
	}

	function renderState(state: EditorState) {
		text = state.text;
		requestAnimationFrame(() => {
			textarea.selectionStart = state.selectionStart;
			textarea.selectionEnd = state.selectionEnd;
		});
	}

	function synchronizeScroll() {
		renderLayer.scrollTop = textarea.scrollTop;
	}

	function autoResize() {
		textarea.style.height = 'auto';
		textarea.style.height = textarea.scrollHeight + 'px';
	}

	onMount(() => {
		editorHistory = new EditorHistory(textarea, (v) => (text = v));
		const saved = EditorStorage.load();

		if (saved) {
			editorHistory.push(saved);
			renderState(saved);
		} else {
			editorHistory.push({
				text: '',
				selectionStart: 0,
				selectionEnd: 0
			});
		}

		requestAnimationFrame(() => {
			autoResize();
		});
	});
</script>

<svelte:window on:beforeunload={handleBeforeUnload} on:storage={handleStorage} />

<main class="editor">
	<textarea
		class="input-layer"
		bind:this={textarea}
		bind:value={text}
		on:keydown={onKeydown}
		on:beforeinput={onBeforeInput}
		on:input={onInput}
		on:scroll={synchronizeScroll}
	></textarea>

	<div class="render-layer" bind:this={renderLayer}>
		{#if text.length === 0}
			<div class="fake-placeholder">Start typing...</div>
		{:else}
			{@html renderedHtml}
		{/if}
	</div>
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

	.render-layer,
	.input-layer {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		tab-size: 4;
		padding: 1.5rem;

		overflow: hidden;
	}

	.render-layer {
		pointer-events: none;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.input-layer {
		background: transparent;
		color: transparent; /* hide text */
		caret-color: #555; /* show caret */

		-webkit-text-fill-color: transparent;

		border: none;
		outline: none;
		resize: none;

		font: inherit;
		line-height: inherit;
		white-space: pre-wrap;
	}

	.input-layer::selection {
		background: rgba(180, 213, 255, 0.6);
	}

	.fake-placeholder {
		color: #999;
		pointer-events: none;
		white-space: pre-wrap;
	}

	:global(.render-layer h1),
	:global(.render-layer h2),
	:global(.render-layer h3),
	:global(.render-layer h4),
	:global(.render-layer h5),
	:global(.render-layer h6) {
		all: unset;
	}

	:global(.render-layer ul),
	:global(.render-layer ol) {
		all: unset;
	}

	:global(.render-layer .line) {
		display: block;
		min-height: 1.7em;
		margin: 0;
		padding: 0;
	}

	@media (min-width: 768px) {
		.editor {
			max-width: 680px;
			margin: 0 auto;
			display: block;
		}

		.render-layer,
		.input-layer {
			padding: 8rem 1.5rem;
		}
	}
</style>
