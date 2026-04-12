export interface SelectionRange {
	start: number;
	end: number;
}

export interface TextChange {
	text: string;
	selectionStart: number;
	selectionEnd: number;
}

export function replaceRange(
	text: string,
	selection: SelectionRange,
	insertedText: string
): TextChange {
	const nextText = text.slice(0, selection.start) + insertedText + text.slice(selection.end);
	const cursor = selection.start + insertedText.length;
	return {
		text: nextText,
		selectionStart: cursor,
		selectionEnd: cursor
	};
}

export function deleteBackward(text: string, selection: SelectionRange): TextChange {
	if (selection.start !== selection.end) {
		return replaceRange(text, selection, '');
	}

	if (selection.start === 0) {
		return {
			text,
			selectionStart: 0,
			selectionEnd: 0
		};
	}

	return replaceRange(
		text,
		{
			start: selection.start - 1,
			end: selection.end
		},
		''
	);
}

export function deleteForward(text: string, selection: SelectionRange): TextChange {
	if (selection.start !== selection.end) {
		return replaceRange(text, selection, '');
	}

	if (selection.end >= text.length) {
		return {
			text,
			selectionStart: selection.start,
			selectionEnd: selection.end
		};
	}

	return replaceRange(
		text,
		{
			start: selection.start,
			end: selection.end + 1
		},
		''
	);
}

export function getCurrentLineBounds(text: string, position: number) {
	const before = text.slice(0, position);
	const lineStart = before.lastIndexOf('\n') + 1;
	const nextNewline = text.indexOf('\n', position);
	const lineEnd = nextNewline === -1 ? text.length : nextNewline;
	return { lineStart, lineEnd };
}

export function getSelectedBlockBounds(text: string, selection: SelectionRange) {
	const blockStart = getCurrentLineBounds(text, selection.start).lineStart;
	const blockEndPosition =
		selection.start !== selection.end && selection.end > 0 && text[selection.end - 1] === '\n'
			? selection.end - 1
			: selection.end;
	const blockEnd = getCurrentLineBounds(text, blockEndPosition).lineEnd;
	return { blockStart, blockEnd };
}
