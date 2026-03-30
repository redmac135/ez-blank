import { renderSelectionHtml, type EditorDocument } from './parser';
import { replaceRange, type SelectionRange, type TextChange } from './edits';

export function writeSelectionToClipboard(
	clipboardData: DataTransfer | null,
	text: string,
	documentModel: EditorDocument,
	selection: SelectionRange
) {
	if (!clipboardData) return;

	const slice = text.slice(selection.start, selection.end);
	clipboardData.setData('text/plain', slice);
	clipboardData.setData(
		'text/html',
		renderSelectionHtml(documentModel, selection.start, selection.end)
	);
}

export function cutSelection(text: string, selection: SelectionRange): TextChange {
	return replaceRange(text, selection, '');
}

export function pasteText(text: string, selection: SelectionRange, pastedText: string): TextChange {
	return replaceRange(text, selection, pastedText);
}
