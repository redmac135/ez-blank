import { getListMetadata, normalizeOrderedListNumbers } from './lists';
import {
	deleteBackward,
	deleteForward,
	getCurrentLineBounds,
	getSelectedBlockBounds,
	type SelectionRange,
	type TextChange
} from './text';

export function applyTabKey(
	text: string,
	selection: SelectionRange,
	shiftKey: boolean
): TextChange {
	if (selection.start !== selection.end) {
		return applyTabToSelection(text, selection, shiftKey);
	}

	return applyTabToLine(text, selection.start, shiftKey);
}

export function applyEnterKey(text: string, selection: SelectionRange): TextChange {
	const { start, end } = selection;
	const { lineStart, lineEnd } = getCurrentLineBounds(text, start);
	const lineText = text.slice(lineStart, lineEnd);
	const metadata = getListMetadata(lineText);

	if (metadata.listLevel === 0) {
		return {
			text: text.slice(0, start) + '\n' + text.slice(end),
			selectionStart: start + 1,
			selectionEnd: start + 1
		};
	}

	if (metadata.ordered && lineText.trim().match(/^\d+\.$/)) {
		const nextText = text.slice(0, lineStart) + text.slice(lineEnd);
		return normalizeListEdit(nextText, getSplitListAffectedRange(nextText, lineStart), {
			start: lineStart,
			end: lineStart
		});
	}

	if (!metadata.ordered && lineText.trim() === '-') {
		return {
			text: text.slice(0, lineStart) + text.slice(lineEnd),
			selectionStart: lineStart,
			selectionEnd: lineStart
		};
	}

	const indent = '    '.repeat(metadata.listLevel - 1);
	const prefix = metadata.ordered ? `${indent}${metadata.listNumber + 1}. ` : `${indent}- `;
	const nextSelection = start + 1 + prefix.length;

	return normalizeListEdit(
		text.slice(0, start) + '\n' + prefix + text.slice(end),
		{ start: lineStart, end: nextSelection },
		{ start: nextSelection, end: nextSelection }
	);
}

export function applyDeleteBackward(text: string, selection: SelectionRange): TextChange {
	const change = deleteBackward(text, selection);
	return normalizeListEdit(change.text, getDeleteAffectedRange(text, selection, 'backward'), {
		start: change.selectionStart,
		end: change.selectionEnd
	});
}

export function applyDeleteForward(text: string, selection: SelectionRange): TextChange {
	const change = deleteForward(text, selection);
	return normalizeListEdit(change.text, getDeleteAffectedRange(text, selection, 'forward'), {
		start: change.selectionStart,
		end: change.selectionEnd
	});
}

function applyTabToSelection(
	text: string,
	selection: SelectionRange,
	shiftKey: boolean
): TextChange {
	const { blockStart, blockEnd } = getSelectedBlockBounds(text, selection);
	const block = text.slice(blockStart, blockEnd);
	const lines = block.split('\n');

	const modified = lines.map((line) => {
		const metadata = getListMetadata(line);
		if (shiftKey) {
			if (line.startsWith('    ')) return line.slice(4);
			if (metadata.listLevel === 1) return line.replace(/^- /, '').replace(/^\d+\. /, '');
			return line;
		}

		return `    ${line}`;
	});

	const nextBlock = modified.join('\n');
	return normalizeListEdit(
		text.slice(0, blockStart) + nextBlock + text.slice(blockEnd),
		{ start: blockStart, end: blockStart + nextBlock.length },
		{ start: blockStart, end: blockStart + nextBlock.length }
	);
}

function applyTabToLine(text: string, position: number, shiftKey: boolean): TextChange {
	const { lineStart, lineEnd } = getCurrentLineBounds(text, position);
	const lineText = text.slice(lineStart, lineEnd);
	const metadata = getListMetadata(lineText);

	if (shiftKey) {
		if (lineText.startsWith('    ')) {
			return normalizeListEdit(
				text.slice(0, lineStart) + lineText.slice(4) + text.slice(lineEnd),
				{ start: lineStart, end: lineEnd - 4 },
				{ start: position - 4, end: position - 4 }
			);
		}

		if (metadata.listLevel === 1) {
			const updatedLine = lineText.replace(/^- /, '').replace(/^\d+\. /, '');
			const nextSelection = Math.max(lineStart, position - metadata.prefix.length);
			return normalizeListEdit(
				text.slice(0, lineStart) + updatedLine + text.slice(lineEnd),
				{ start: lineStart, end: lineStart + updatedLine.length },
				{ start: nextSelection, end: nextSelection }
			);
		}

		return {
			text,
			selectionStart: position,
			selectionEnd: position
		};
	}

	if (metadata.listLevel > 0) {
		return normalizeListEdit(
			text.slice(0, lineStart) + '    ' + text.slice(lineStart),
			{ start: lineStart, end: lineEnd + 4 },
			{ start: position + 4, end: position + 4 }
		);
	}

	return {
		text: text.slice(0, position) + '    ' + text.slice(position),
		selectionStart: position + 4,
		selectionEnd: position + 4
	};
}

function normalizeListEdit(text: string, affectedRange: SelectionRange, selection: SelectionRange) {
	return normalizeOrderedListNumbers(text, affectedRange, selection);
}

function getDeleteAffectedRange(
	text: string,
	selection: SelectionRange,
	direction: 'backward' | 'forward'
): SelectionRange {
	if (selection.start !== selection.end) {
		return selection;
	}

	if (direction === 'backward') {
		const start = Math.max(0, selection.start - 1);
		return { start, end: selection.start };
	}

	const end = Math.min(text.length, selection.end + 1);
	return { start: selection.start, end };
}

function getSplitListAffectedRange(text: string, boundary: number): SelectionRange {
	return {
		start: Math.max(0, boundary - 1),
		end: Math.min(text.length, boundary + 1)
	};
}
