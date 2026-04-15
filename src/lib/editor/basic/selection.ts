import { findLineIndex, type EditorDocument } from './parser';

export function getTextOffset(
	editor: HTMLDivElement,
	documentModel: EditorDocument
): { start: number; end: number } {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) {
		return { start: 0, end: 0 };
	}

	const range = selection.getRangeAt(0);
	return {
		start: countOffset(editor, documentModel, range.startContainer, range.startOffset),
		end: countOffset(editor, documentModel, range.endContainer, range.endOffset)
	};
}

export function restoreTextOffset(
	editor: HTMLDivElement,
	documentModel: EditorDocument,
	start: number,
	end: number
) {
	const selection = window.getSelection();
	if (!selection) return;

	const startPosition = resolvePosition(editor, documentModel, start);
	const endPosition = resolvePosition(editor, documentModel, end);
	if (!startPosition || !endPosition) return;

	const range = document.createRange();
	range.setStart(startPosition.node, startPosition.offset);
	range.setEnd(endPosition.node, endPosition.offset);
	selection.removeAllRanges();
	selection.addRange(range);
}

export function extractText(editor: HTMLDivElement): string {
	const lines = Array.from(editor.querySelectorAll<HTMLElement>('.line'));
	return lines.map((line) => line.textContent ?? '').join('\n');
}

export function getEditorContainerOffset(
	documentModel: EditorDocument,
	childOffset: number
): number {
	if (childOffset <= 0 || documentModel.lines.length === 0) {
		return 0;
	}

	if (childOffset >= documentModel.lines.length) {
		return documentModel.text.length;
	}

	return documentModel.lines[childOffset]?.range.start ?? documentModel.text.length;
}

function countOffset(
	editor: HTMLDivElement,
	documentModel: EditorDocument,
	node: Node,
	offset: number
): number {
	if (node === editor) {
		return getEditorContainerOffset(documentModel, offset);
	}

	const lineElement = getLineElement(node);
	if (!lineElement) return documentModel.text.length;

	const lineIndex = Number.parseInt(lineElement.dataset.lineIndex ?? '0', 10);
	const line = documentModel.lines[lineIndex];
	if (!line) return documentModel.text.length;

	return line.range.start + textOffsetWithin(lineElement, node, offset);
}

function textOffsetWithin(root: Node, target: Node, targetOffset: number): number {
	try {
		const range = document.createRange();
		range.selectNodeContents(root);
		range.setEnd(target, targetOffset);
		return range.toString().length;
	} catch {
		return 0;
	}
}

function resolvePosition(
	editor: HTMLDivElement,
	documentModel: EditorDocument,
	offset: number
): { node: Node; offset: number } | null {
	if (documentModel.lines.length === 0) {
		return { node: editor, offset: 0 };
	}

	const clampedOffset = Math.max(0, Math.min(offset, documentModel.text.length));
	const lineIndex = findLineIndex(documentModel.lines, clampedOffset);
	const line = documentModel.lines[lineIndex];
	const lineElement = editor.querySelector<HTMLElement>(`.line[data-line-index="${lineIndex}"]`);
	if (!line || !lineElement) return null;

	const localOffset = Math.max(0, Math.min(clampedOffset - line.range.start, line.raw.length));
	return findTextPosition(lineElement, localOffset);
}

function findTextPosition(root: Node, offset: number): { node: Node; offset: number } {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let remaining = offset;

	while (walker.nextNode()) {
		const textNode = walker.currentNode as Text;
		if (remaining <= textNode.length) {
			return { node: textNode, offset: remaining };
		}
		remaining -= textNode.length;
	}

	return { node: root, offset: Math.min(offset, root.childNodes.length) };
}

function getLineElement(node: Node): HTMLElement | null {
	if (node.nodeType === Node.ELEMENT_NODE) {
		return (node as Element).closest('.line') as HTMLElement | null;
	}

	return node.parentElement?.closest('.line') as HTMLElement | null;
}
