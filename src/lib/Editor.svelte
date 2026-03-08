<script lang="ts">
	import { onMount } from 'svelte';
	import { parseText, parseLine, renderLine } from './editor/parser';
	import { EditorHistory, type EditorState } from './editor/history';
	import { EditorStorage } from './editor/storage';

	let text: string = '';
	let editor: HTMLDivElement;
	let editorHistory: EditorHistory;
	let saveTimeout: number;

	type EditType = 'typing' | 'deleting' | 'command';
	let lastEditType: EditType | null = null;
	let lastEditTime = 0;
	const TYPING_WINDOW = 750;

	// ─── Cursor: count offset ────────────────────────────────

	function countOffset(root: HTMLElement, node: Node, offset: number): number {
		const lines = Array.from(root.querySelectorAll('.line'));
		let total = 0;

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) total += 1;

			if (lines[i].contains(node)) {
				total += textOffsetWithin(lines[i], node, offset);
				return total;
			}

			total += (lines[i].textContent ?? '').length;
		}

		return total;
	}

	function textOffsetWithin(root: Node, target: Node, targetOffset: number): number {
		// If target is a text node inside root, walk text nodes until we find it
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let count = 0;

		while (walker.nextNode()) {
			const tn = walker.currentNode as Text;
			if (tn === target) return count + targetOffset;
			count += tn.length;
		}

		// target is an element node — offset means "before the Nth child"
		// Walk text nodes that appear before that child position
		if (root.contains(target)) {
			const childAnchor = target.childNodes[targetOffset]; // may be undefined (= end)
			const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let c = 0;
			while (w2.nextNode()) {
				const tn = w2.currentNode as Text;
				if (
					childAnchor &&
					tn.compareDocumentPosition(childAnchor) & Node.DOCUMENT_POSITION_FOLLOWING
				) {
					// tn is before childAnchor — but we need the opposite check
				}
				// Simpler: if childAnchor exists and this text node is or is inside childAnchor or after it, stop
				if (childAnchor) {
					const pos = childAnchor.compareDocumentPosition(tn);
					if (
						pos & Node.DOCUMENT_POSITION_CONTAINED_BY ||
						childAnchor === tn ||
						pos & Node.DOCUMENT_POSITION_FOLLOWING
					) {
						break;
					}
				}
				c += tn.length;
			}
			return c;
		}

		return count;
	}

	function getTextOffset(): { start: number; end: number } {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
		const range = sel.getRangeAt(0);
		const start = countOffset(editor, range.startContainer, range.startOffset);
		const end = countOffset(editor, range.endContainer, range.endOffset);
		return { start, end };
	}

	// ─── Cursor: restore offset ──────────────────────────────

	function restoreTextOffset(start: number, end: number) {
		const sel = window.getSelection();
		if (!sel) return;

		const lines = Array.from(editor.querySelectorAll('.line'));
		const startPos = resolvePosition(lines, start);
		const endPos = resolvePosition(lines, end);
		if (!startPos || !endPos) return;

		const range = document.createRange();
		range.setStart(startPos.node, startPos.offset);
		range.setEnd(endPos.node, endPos.offset);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	function resolvePosition(
		lines: Element[],
		offset: number
	): { node: Node; offset: number } | null {
		let remaining = offset;

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) remaining -= 1;
			const lineLen = (lines[i].textContent ?? '').length;

			if (remaining <= lineLen) {
				return findTextPosition(lines[i], remaining);
			}
			remaining -= lineLen;
		}

		if (lines.length > 0) {
			const last = lines[lines.length - 1];
			return findTextPosition(last, (last.textContent ?? '').length);
		}

		return { node: editor, offset: 0 };
	}

	function findTextPosition(root: Node, offset: number): { node: Node; offset: number } {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let remaining = offset;

		while (walker.nextNode()) {
			const tn = walker.currentNode as Text;
			if (remaining <= tn.length) return { node: tn, offset: remaining };
			remaining -= tn.length;
		}

		return { node: root, offset: 0 };
	}

	// ─── Text extraction ─────────────────────────────────────

	function extractText(): string {
		const lines = Array.from(editor.querySelectorAll('.line'));
		return lines.map((el) => el.textContent ?? '').join('\n');
	}

	// ─── Rendering ───────────────────────────────────────────

	function render() {
		renumberAllLists();
		editor.innerHTML = parseText(text).map(renderLine).join('');
	}

	function renderAndRestore(cursorPos?: number) {
		const pos = cursorPos ?? getTextOffset().start;
		render();
		requestAnimationFrame(() => restoreTextOffset(pos, pos));
	}

	function renderAndRestoreSelection(start: number, end: number) {
		render();
		requestAnimationFrame(() => restoreTextOffset(start, end));
	}

	// ─── Line helpers ────────────────────────────────────────

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

	// --- List renumbering ────────────────────────────────────────

	function renumberAllLists() {
		const lines = text.split('\n');
		let changed = false;

		function processFrom(start: number, level: number): number {
			let i = start;
			let num = 0;

			while (i < lines.length) {
				if (lines[i].trim() === '') break;

				const parsed = parseLine(lines[i]);
				if (parsed.listLevel === 0) break;
				if (parsed.listLevel < level) break;

				// Deeper — recurse
				if (parsed.listLevel > level) {
					i = processFrom(i, parsed.listLevel);
					continue;
				}

				// Same level
				if (parsed.ordered) {
					num++;
					const indent = '    '.repeat(level - 1);
					const oldPrefix = lines[i].match(/^((?:    )*)\d+\. /);
					if (oldPrefix) {
						const newLine = indent + num + '. ' + lines[i].slice(oldPrefix[0].length);
						if (newLine !== lines[i]) {
							lines[i] = newLine;
							changed = true;
						}
					}
				} else {
					// Unordered at same level resets the ordered counter
					num = 0;
				}

				i++;
			}

			return i;
		}

		let i = 0;
		while (i < lines.length) {
			const parsed = parseLine(lines[i]);
			if (parsed.listLevel > 0) {
				i = processFrom(i, parsed.listLevel);
			} else {
				i++;
			}
		}

		if (changed) {
			text = lines.join('\n');
		}
	}

	// ─── State helpers ───────────────────────────────────────

	function applyState(state: EditorState) {
		text = state.text;
		render();
		requestAnimationFrame(() => restoreTextOffset(state.selectionStart, state.selectionEnd));
	}

	// ─── Persistence ─────────────────────────────────────────

	function persistText() {
		const { start, end } = getTextOffset();
		clearTimeout(saveTimeout);
		saveTimeout = window.setTimeout(() => {
			EditorStorage.save({ text, selectionStart: start, selectionEnd: end });
		}, 300);
	}

	function handleBeforeUnload() {
		const { start, end } = getTextOffset();
		EditorStorage.save({ text, selectionStart: start, selectionEnd: end });
	}

	function handleStorage(e: StorageEvent) {
		if (e.key === EditorStorage.STORAGE_KEY && e.newValue) {
			const state = EditorStorage.load();
			if (state) applyState(state);
		}
	}

	// ─── Clipboard ───────────────────────────────────────────

	function onCopy(e: ClipboardEvent) {
		e.preventDefault();
		const { start, end } = getTextOffset();
		const slice = text.slice(start, end);
		e.clipboardData?.setData('text/plain', slice);
	}

	function onCut(e: ClipboardEvent) {
		e.preventDefault();
		const { start, end } = getTextOffset();
		const slice = text.slice(start, end);
		e.clipboardData?.setData('text/plain', slice);

		editorHistory.push({ text, selectionStart: start, selectionEnd: end });
		text = text.slice(0, start) + text.slice(end);
		renderAndRestore(start);
		persistText();
	}

	function onPaste(e: ClipboardEvent) {
		e.preventDefault();
		const pasted = e.clipboardData?.getData('text/plain') ?? '';
		if (!pasted) return;

		const { start, end } = getTextOffset();
		editorHistory.push({ text, selectionStart: start, selectionEnd: end });

		text = text.slice(0, start) + pasted + text.slice(end);
		renderAndRestore(start + pasted.length);
		persistText();
	}

	// ─── Input events ────────────────────────────────────────

	function onBeforeInput(e: InputEvent) {
		const now = Date.now();
		const isTyping = e.inputType === 'insertText' && !e.data?.includes('\n');
		const isDeleting =
			e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward';
		const currentEditType: EditType = isTyping ? 'typing' : isDeleting ? 'deleting' : 'command';

		const { start, end } = getTextOffset();
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
	}

	function onInput() {
		requestAnimationFrame(() => {
			let { start, end } = getTextOffset();
			text = extractText();
			render();
			restoreTextOffset(start, end);
			persistText();
		});
	}

	function onKeydown(e: KeyboardEvent) {
		const { start, end } = getTextOffset();
		const hasSelection = start !== end;

		// ═══ TAB / SHIFT+TAB ═══
		if (e.key === 'Tab' && !(e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			editorHistory.push({ text, selectionStart: start, selectionEnd: end });

			if (hasSelection) {
				const { blockStart, blockEnd } = getSelectedBlockBounds(start, end);
				const block = text.slice(blockStart, blockEnd);
				const lines = block.split('\n');

				const modified = lines.map((line) => {
					const parsed = parseLine(line);
					if (e.shiftKey) {
						if (line.startsWith('    ')) return line.slice(4);
						if (parsed.listLevel === 1) return line.replace(/^- /, '');
						return line;
					}
					return '    ' + line;
				});

				const newBlock = modified.join('\n');
				text = text.slice(0, blockStart) + newBlock + text.slice(blockEnd);
				renderAndRestoreSelection(blockStart, blockStart + newBlock.length);
				return;
			}

			const { lineStart, lineEnd } = getCurrentLineBounds(start);
			const lineText = text.slice(lineStart, lineEnd);
			const parsed = parseLine(lineText);

			if (e.shiftKey) {
				if (lineText.startsWith('    ')) {
					text = text.slice(0, lineStart) + lineText.slice(4) + text.slice(lineEnd);
					renderAndRestore(start - 4);
				} else if (parsed.listLevel === 1) {
					text =
						text.slice(0, lineStart) +
						lineText.replace(/^- /, '').replace(/^\d+\. /, '') +
						text.slice(lineEnd);
					renderAndRestore(Math.max(lineStart, start - 2));
				}
				return;
			}

			// TAB inside list → indent the whole line
			if (parsed.listLevel > 0) {
				text = text.slice(0, lineStart) + '    ' + text.slice(lineStart);
				renderAndRestore(start + 4);
				return;
			}

			// NOT a list → normal tab (insert spaces at cursor)
			text = text.slice(0, start) + '    ' + text.slice(end);
			renderAndRestore(start + 4);
			return;
		}

		// ═══ ENTER (LIST CONTINUATION) ═══
		if (e.key === 'Enter') {
			const { lineStart, lineEnd } = getCurrentLineBounds(start);
			const lineText = text.slice(lineStart, lineEnd);
			const parsed = parseLine(lineText);

			if (parsed.listLevel > 0) {
				e.preventDefault();
				editorHistory.push({ text, selectionStart: start, selectionEnd: end });

				const indent = '    '.repeat(parsed.listLevel - 1);

				// Empty list item → exit list
				if (parsed.ordered && lineText.trim().match(/^\d+\.$/)) {
					text = text.slice(0, lineStart) + text.slice(lineEnd);
					renderAndRestore(lineStart);
					return;
				}
				if (!parsed.ordered && lineText.trim() === '-') {
					text = text.slice(0, lineStart) + text.slice(lineEnd);
					renderAndRestore(lineStart);
					return;
				}

				// Build prefix for new line
				let prefix: string;
				if (parsed.ordered) {
					prefix = indent + (parsed.listNumber + 1) + '. ';
				} else {
					prefix = indent + '- ';
				}

				text = text.slice(0, start) + '\n' + prefix + text.slice(end);

				renderAndRestore(start + 1 + prefix.length);
				return;
			} else {
				// Normal enter → insert newline
				e.preventDefault();
				text = text.slice(0, start) + '\n' + text.slice(end);
				renderAndRestore(start + 1);
				return;
			}
		}

		// ═══ UNDO / REDO ═══
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

	// ─── Lifecycle ───────────────────────────────────────────
	onMount(() => {
		editorHistory = new EditorHistory(
			() => {
				const { start, end } = getTextOffset();
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
		} else {
			const empty: EditorState = { text: '', selectionStart: 0, selectionEnd: 0 };
			editorHistory.push(empty);
			applyState(empty);
		}
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

	:global(.editable .fake-placeholder) {
		color: #999;
	}

	:global(.editable .line) {
		display: block;
		min-height: 1.7em;
		margin: 0;
		padding: 0;
	}

	:global(.editable .line.list) {
		padding-left: calc(var(--prefix-width) * 1ch + (var(--list-level)) * 4ch);
		text-indent: calc(-1 * (var(--prefix-width) * 1ch + (var(--list-level)) * 4ch));
	}

	:global(.editable h1),
	:global(.editable h2),
	:global(.editable h3),
	:global(.editable h4),
	:global(.editable h5),
	:global(.editable h6) {
		all: unset;
	}

	:global(.editable ul),
	:global(.editable ol) {
		all: unset;
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
