import { renderEditorLine, type EditorDocument } from './parser';

export function syncEditorDom(
	editor: HTMLDivElement,
	previousDocument: EditorDocument | null,
	nextDocument: EditorDocument
) {
	if (!previousDocument) {
		renderDocument(editor, nextDocument);
		return;
	}

	let start = 0;
	while (
		start < previousDocument.lines.length &&
		start < nextDocument.lines.length &&
		previousDocument.lines[start].raw === nextDocument.lines[start].raw
	) {
		start += 1;
	}

	if (start === previousDocument.lines.length && start === nextDocument.lines.length) {
		reindexLineElements(editor);
		return;
	}

	let previousEnd = previousDocument.lines.length - 1;
	let nextEnd = nextDocument.lines.length - 1;
	while (
		previousEnd >= start &&
		nextEnd >= start &&
		previousDocument.lines[previousEnd].raw === nextDocument.lines[nextEnd].raw
	) {
		previousEnd -= 1;
		nextEnd -= 1;
	}

	const currentLineElements = Array.from(editor.querySelectorAll<HTMLElement>('.line'));
	const referenceNode = currentLineElements[previousEnd + 1] ?? null;

	for (let index = start; index <= previousEnd; index++) {
		currentLineElements[index]?.remove();
	}

	const fragment = document.createDocumentFragment();
	for (let index = start; index <= nextEnd; index++) {
		fragment.append(createLineElement(renderEditorLine(nextDocument.lines[index]), index));
	}

	if (referenceNode) {
		editor.insertBefore(fragment, referenceNode);
	} else {
		editor.append(fragment);
	}

	reindexLineElements(editor);
}

function renderDocument(editor: HTMLDivElement, nextDocument: EditorDocument) {
	editor.innerHTML = '';
	const fragment = document.createDocumentFragment();
	nextDocument.lines.forEach((line, index) => {
		fragment.append(createLineElement(renderEditorLine(line), index));
	});
	editor.append(fragment);
}

function reindexLineElements(editor: HTMLDivElement) {
	const lines = Array.from(editor.querySelectorAll<HTMLElement>('.line'));
	lines.forEach((line, index) => {
		line.dataset.lineIndex = String(index);
	});
}

function createLineElement(lineHtml: string, lineIndex: number): HTMLElement {
	const template = document.createElement('template');
	template.innerHTML = lineHtml.trim();
	const element = template.content.firstElementChild as HTMLElement;
	element.dataset.lineIndex = String(lineIndex);
	return element;
}
