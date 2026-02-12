<script lang="ts">
	import { onMount } from 'svelte';

	let text: string = '';
	let textarea: HTMLTextAreaElement;
	let renderedHtml: string = '';

	$: renderedHtml = parseText(text).map(renderLine).join('\n');

	interface EditorState {
		text: string;
		selectionStart: number;
		selectionEnd: number;
	}

	interface Token {
		text: string;
		bold: boolean;
		italic: boolean;
	}

	interface Line {
		tokens: Token[];
		listLevel: number; // 0 for not a list, 1 for first level, 2 for nested list, etc.
		headingLevel: number; // 0 for not a heading, 1 for h1, 2 for h2, etc.
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

	function parseLine(raw: string): Line {
		let headingLevel = 0;
		let listLevel = 0;
		let toBeParsed = raw;
		const tokens = [];

		// check for lists
		const listMatch = raw.match(/^(\t*)- /);
		if (listMatch) {
			const tabs = listMatch[1].length;
			listLevel = tabs + 1;
			tokens.push({
				text: listMatch[0], // include the space after the dash
				bold: false,
				italic: false
			});

			toBeParsed = raw.slice(listMatch[0].length);
		}

		// check of headings
		const headingMatch = raw.match(/^(#{1,6})\s+/);
		if (headingMatch) {
			headingLevel = headingMatch[1].length;
			tokens.push({
				text: headingMatch[0], // include the space after the hashes
				bold: true,
				italic: false
			});

			toBeParsed = raw.slice(headingMatch[0].length);
		}

		tokens.push(...parseInline(toBeParsed, headingLevel > 0)); // force bold for headings

		return { tokens, listLevel, headingLevel };
	}

	function parseInline(raw: string, forceBold = false): Token[] {
		const tokens: Token[] = [];
		let i = 0;

		while (i < raw.length) {
			// Try *** (bold + italic)
			if (raw.startsWith('***', i)) {
				const close = raw.indexOf('***', i + 3);

				if (close !== -1 && raw[i + 3] !== ' ' && raw[close - 1] !== ' ') {
					const full = raw.slice(i, close + 3);
					tokens.push({ text: full, bold: true, italic: true });
					i = close + 3;
					continue;
				}
			}

			// Try ** (bold)
			if (raw.startsWith('**', i)) {
				const close = raw.indexOf('**', i + 2);

				if (close !== -1 && raw[i + 2] !== ' ' && raw[close - 1] !== ' ') {
					const full = raw.slice(i, close + 2);
					tokens.push({ text: full, bold: true, italic: false });
					i = close + 2;
					continue;
				}
			}

			// Try * (italic)
			if (raw[i] === '*') {
				const close = raw.indexOf('*', i + 1);

				if (close !== -1 && raw[i + 1] !== ' ' && raw[close - 1] !== ' ') {
					const full = raw.slice(i, close + 1);
					tokens.push({ text: full, bold: false, italic: true });
					i = close + 1;
					continue;
				}

				// If invalid italic → treat single * as normal char
				tokens.push({
					text: '*',
					bold: forceBold,
					italic: false
				});
				i += 1;
				continue;
			}

			// Normal text chunk
			let nextStar = raw.indexOf('*', i);
			if (nextStar === -1) nextStar = raw.length;

			const normal = raw.slice(i, nextStar);

			tokens.push({
				text: normal,
				bold: forceBold,
				italic: false
			});

			i = nextStar;
		}

		return tokens;
	}

	function renderLine(line: Line): string {
		let html = line.tokens
			.map((token) => {
				let t = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
				if (token.bold) t = `<strong>${t}</strong>`;
				if (token.italic) t = `<em>${t}</em>`;
				return t;
			})
			.join('');

		return html;
	}

	function parseText(raw: string): Line[] {
		return raw.split('\n').map(parseLine);
	}

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

<main class="editor">
	<textarea
		class="input-layer"
		bind:this={textarea}
		bind:value={text}
		on:keydown={onKeydown}
		on:beforeinput={onBeforeInput}
		on:input={onInput}
	></textarea>

	<div class="render-layer">
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
		min-height: 100vh;
		font-family: 'Roboto Mono', monospace;
		font-size: 18px;
		line-height: 1.7;
	}

	.render-layer,
	.input-layer {
		position: absolute;
		inset: 0;
		tab-size: 4;
		overflow: hidden;
		padding: 1.5rem;
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
