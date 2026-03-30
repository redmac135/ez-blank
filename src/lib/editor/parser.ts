export type LineKind = 'paragraph' | 'heading' | 'unordered_list_item' | 'ordered_list_item';

export interface SourceRange {
	start: number;
	end: number;
}

export interface TextNode {
	type: 'text';
	range: SourceRange;
	text: string;
}

export interface FormattedNode {
	type: 'emphasis' | 'strong' | 'strong_emphasis';
	range: SourceRange;
	contentRange: SourceRange;
	marker: string;
	text: string;
}

export type InlineNode = TextNode | FormattedNode;

export interface EditorLine {
	id: string;
	index: number;
	raw: string;
	range: SourceRange;
	kind: LineKind;
	listLevel: number;
	listNumber: number;
	headingLevel: number;
	prefix: string;
	prefixRange: SourceRange | null;
	contentRange: SourceRange;
	inline: InlineNode[];
}

export interface EditorDocument {
	text: string;
	lines: EditorLine[];
}

const LIST_INDENT = '    ';

export function buildDocument(rawText: string): EditorDocument {
	const text = normalizeText(rawText);
	const rawLines = text.split('\n');
	const lines: EditorLine[] = [];
	let offset = 0;

	for (let index = 0; index < rawLines.length; index++) {
		const raw = rawLines[index];
		const start = offset;
		const end = start + raw.length;
		lines.push(parseLine(raw, index, start, end));
		offset = end + 1;
	}

	return { text, lines };
}

export function normalizeText(rawText: string): string {
	const lines = rawText.split('\n');
	let changed = false;

	function processFrom(start: number, level: number): number {
		let index = start;
		let number = 0;

		while (index < lines.length) {
			const line = lines[index];
			if (line.trim() === '') break;

			const parsed = parsePrefix(line);
			if (parsed.kind === 'paragraph' || parsed.kind === 'heading') break;
			if (parsed.listLevel < level) break;

			if (parsed.listLevel > level) {
				index = processFrom(index, parsed.listLevel);
				continue;
			}

			if (parsed.kind === 'ordered_list_item') {
				number += 1;
				const canonicalPrefix = LIST_INDENT.repeat(level - 1) + `${number}. `;
				if (!line.startsWith(canonicalPrefix)) {
					lines[index] = canonicalPrefix + line.slice(parsed.prefix.length);
					changed = true;
				}
			} else {
				number = 0;
			}

			index += 1;
		}

		return index;
	}

	let index = 0;
	while (index < lines.length) {
		const parsed = parsePrefix(lines[index]);
		if (parsed.kind === 'ordered_list_item' || parsed.kind === 'unordered_list_item') {
			index = processFrom(index, parsed.listLevel);
			continue;
		}
		index += 1;
	}

	return changed ? lines.join('\n') : rawText;
}

export function renderEditorLine(line: EditorLine): string {
	const prefix = line.prefixRange ? renderEditorText(line.prefix) : '';
	const content = renderEditorInline(line.inline);
	const body = prefix + (content || (line.raw.length === 0 ? '<br>' : ''));

	if (line.kind === 'ordered_list_item' || line.kind === 'unordered_list_item') {
		const prefixWidth = line.prefix.length;
		return `<div class="line list" data-line-id="${line.id}" style="--list-level: ${line.listLevel - 1}; --prefix-width: ${prefixWidth}">${body}</div>`;
	}

	if (line.kind === 'heading') {
		return `<div class="line heading heading-${line.headingLevel}" data-line-id="${line.id}">${body}</div>`;
	}

	return `<div class="line" data-line-id="${line.id}">${body}</div>`;
}

export function renderSelectionHtml(document: EditorDocument, start: number, end: number): string {
	if (start >= end) return '';

	const parts: string[] = [];
	const listStack: Array<{ tag: 'ul' | 'ol'; liOpen: boolean }> = [];

	function closeOneList() {
		const frame = listStack.pop();
		if (!frame) return;
		if (frame.liOpen) {
			parts.push('</li>');
		}
		parts.push(`</${frame.tag}>`);
	}

	function closeLists(targetLevel = 0) {
		while (listStack.length > targetLevel) {
			closeOneList();
		}
	}

	function ensureListLevel(targetLevel: number, kind: 'ordered_list_item' | 'unordered_list_item') {
		const targetTag = kind === 'ordered_list_item' ? 'ol' : 'ul';

		closeLists(targetLevel);

		if (
			targetLevel > 0 &&
			listStack.length === targetLevel &&
			listStack[targetLevel - 1]?.tag !== targetTag
		) {
			closeOneList();
		}

		while (listStack.length < targetLevel) {
			listStack.push({ tag: targetTag, liOpen: false });
			parts.push(`<${targetTag}>`);
		}
	}

	for (const line of document.lines) {
		if (end <= line.range.start || start > line.range.end) continue;

		const lineStart = Math.max(start, line.range.start);
		const lineEnd = Math.min(end, line.range.end);
		const inlineHtml = renderSemanticInlineSelection(document.text, line, lineStart, lineEnd);

		if (line.kind === 'ordered_list_item' || line.kind === 'unordered_list_item') {
			ensureListLevel(line.listLevel, line.kind);
			const frame = listStack[line.listLevel - 1];
			if (frame.liOpen) {
				parts.push('</li>');
			}
			parts.push(`<li>${inlineHtml || '<br>'}`);
			frame.liOpen = true;
			continue;
		}

		closeLists();

		if (line.kind === 'heading') {
			parts.push(`<h${line.headingLevel}>${inlineHtml || '<br>'}</h${line.headingLevel}>`);
			continue;
		}

		parts.push(`<p>${inlineHtml || '<br>'}</p>`);
	}

	closeLists();
	return `<div style="white-space: pre-wrap;">${parts.join('')}</div>`;
}

export function findLineIndex(lines: EditorLine[], offset: number): number {
	if (lines.length === 0) return 0;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const nextStart = index + 1 < lines.length ? lines[index + 1].range.start : line.range.end + 1;
		if (offset < nextStart) return index;
	}

	return lines.length - 1;
}

function parseLine(raw: string, index: number, start: number, end: number): EditorLine {
	const prefixInfo = parsePrefix(raw);
	const prefixLength = prefixInfo.prefix.length;
	const contentStart = start + prefixLength;
	const contentEnd = end;

	return {
		id: `line-${index}`,
		index,
		raw,
		range: { start, end },
		kind: prefixInfo.kind,
		listLevel: prefixInfo.listLevel,
		listNumber: prefixInfo.listNumber,
		headingLevel: prefixInfo.headingLevel,
		prefix: prefixInfo.prefix,
		prefixRange:
			prefixLength > 0
				? {
						start,
						end: contentStart
					}
				: null,
		contentRange: {
			start: contentStart,
			end: contentEnd
		},
		inline: parseInline(raw.slice(prefixLength), contentStart)
	};
}

function parsePrefix(raw: string) {
	const unorderedMatch = raw.match(/^((?: {4})*)- /);
	if (unorderedMatch) {
		return {
			kind: 'unordered_list_item' as const,
			listLevel: unorderedMatch[1].length / 4 + 1,
			listNumber: 0,
			headingLevel: 0,
			prefix: unorderedMatch[0]
		};
	}

	const orderedMatch = raw.match(/^((?: {4})*)(\d+)\. /);
	if (orderedMatch) {
		return {
			kind: 'ordered_list_item' as const,
			listLevel: orderedMatch[1].length / 4 + 1,
			listNumber: Number.parseInt(orderedMatch[2], 10),
			headingLevel: 0,
			prefix: orderedMatch[0]
		};
	}

	const headingMatch = raw.match(/^(#{1,6})\s+/);
	if (headingMatch) {
		return {
			kind: 'heading' as const,
			listLevel: 0,
			listNumber: 0,
			headingLevel: headingMatch[1].length,
			prefix: headingMatch[0]
		};
	}

	return {
		kind: 'paragraph' as const,
		listLevel: 0,
		listNumber: 0,
		headingLevel: 0,
		prefix: ''
	};
}

function parseInline(raw: string, startOffset: number): InlineNode[] {
	const inline: InlineNode[] = [];
	let index = 0;

	while (index < raw.length) {
		const formattedNode = parseFormattedNode(raw, startOffset, index);
		if (formattedNode) {
			inline.push(formattedNode.node);
			index = formattedNode.nextIndex;
			continue;
		}

		let nextMarker = raw.length;
		const starIndex = raw.indexOf('*', index);
		if (starIndex !== -1) nextMarker = starIndex;

		const text = raw.slice(index, nextMarker);
		inline.push({
			type: 'text',
			range: { start: startOffset + index, end: startOffset + nextMarker },
			text
		});
		index = nextMarker;
	}

	return inline;
}

function parseFormattedNode(raw: string, startOffset: number, index: number) {
	for (const marker of ['***', '**', '*'] as const) {
		if (!raw.startsWith(marker, index)) continue;

		const close = raw.indexOf(marker, index + marker.length);
		if (close === -1) continue;

		const contentStart = index + marker.length;
		const contentEnd = close;
		if (raw[contentStart] === ' ' || raw[contentEnd - 1] === ' ') continue;

		const type = marker === '***' ? 'strong_emphasis' : marker === '**' ? 'strong' : 'emphasis';

		return {
			node: {
				type,
				range: {
					start: startOffset + index,
					end: startOffset + close + marker.length
				},
				contentRange: {
					start: startOffset + contentStart,
					end: startOffset + contentEnd
				},
				marker,
				text: raw.slice(contentStart, contentEnd)
			} satisfies FormattedNode,
			nextIndex: close + marker.length
		};
	}

	return null;
}

function renderEditorInline(inline: InlineNode[]): string {
	return inline
		.map((node) => {
			if (node.type === 'text') {
				return renderEditorText(node.text);
			}

			const marker = `<span class="syntax-marker">${escapeHtml(node.marker)}</span>`;
			const content = escapeHtml(node.text);

			if (node.type === 'emphasis') {
				return `${marker}<em>${content}</em>${marker}`;
			}

			if (node.type === 'strong') {
				return `${marker}<strong>${content}</strong>${marker}`;
			}

			return `${marker}<strong><em>${content}</em></strong>${marker}`;
		})
		.join('');
}

function renderSemanticInlineSelection(
	sourceText: string,
	line: EditorLine,
	start: number,
	end: number
): string {
	if (start >= end) return '';

	const parts: string[] = [];

	for (const node of line.inline) {
		if (node.type === 'text') {
			const slice = sliceRange(sourceText, node.range, start, end);
			if (slice) parts.push(escapeHtmlForClipboard(slice));
			continue;
		}

		const innerSlice = sliceRange(sourceText, node.contentRange, start, end);
		if (!innerSlice) continue;

		if (node.type === 'emphasis') {
			parts.push(`<em>${escapeHtmlForClipboard(innerSlice)}</em>`);
			continue;
		}

		if (node.type === 'strong') {
			parts.push(`<strong>${escapeHtmlForClipboard(innerSlice)}</strong>`);
			continue;
		}

		parts.push(`<strong><em>${escapeHtmlForClipboard(innerSlice)}</em></strong>`);
	}

	return parts.join('');
}

function sliceRange(
	sourceText: string,
	range: SourceRange,
	selectionStart: number,
	selectionEnd: number
): string {
	const start = Math.max(range.start, selectionStart);
	const end = Math.min(range.end, selectionEnd);
	if (start >= end) return '';
	return sourceText.slice(start, end);
}

function renderEditorText(text: string): string {
	return text.length === 0 ? '' : escapeHtml(text);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlForClipboard(text: string): string {
	return escapeHtml(text).replace(/ /g, '&nbsp;').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
}
