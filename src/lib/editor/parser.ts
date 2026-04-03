import type {
	BlockNode,
	CodeBlock,
	FormattedNode,
	HeadingBlock,
	InlineNode,
	ListBlock,
	ListItemBlock,
	ParagraphBlock,
	SourceRange,
	TextNode
} from './ast';

export type LineKind =
	| 'paragraph'
	| 'heading'
	| 'unordered_list_item'
	| 'ordered_list_item'
	| 'code_fence'
	| 'code_content';

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
	codeBlockLanguage: string | null;
}

export interface EditorDocument {
	text: string;
	blocks: BlockNode[];
	lines: EditorLine[];
}

interface RawLine {
	index: number;
	text: string;
	start: number;
	end: number;
}

interface LinePrefixInfo {
	kind: 'paragraph' | 'heading' | 'unordered_list_item' | 'ordered_list_item' | 'code_fence';
	listLevel: number;
	listNumber: number;
	headingLevel: number;
	prefix: string;
	language: string | null;
}

export function buildDocument(rawText: string): EditorDocument {
	const text = normalizeText(rawText);
	const rawLines = buildRawLines(text);
	const blocks = parseBlocks(rawLines);
	const lines = deriveLines(blocks);
	return { text, blocks, lines };
}

export function normalizeText(rawText: string): string {
	return rawText;
}

export function renderEditorLine(line: EditorLine): string {
	const prefix = line.prefixRange ? renderEditorText(line.prefix) : '';
	const content = line.kind.startsWith('code_')
		? renderEditorText(line.raw.slice(line.prefix.length))
		: renderEditorInline(line.inline);
	const body = prefix + (content || (line.raw.length === 0 ? '<br>' : ''));

	if (line.kind === 'ordered_list_item' || line.kind === 'unordered_list_item') {
		const prefixWidth = line.prefix.trimStart().length;
		return `<div class="line list" data-line-id="${line.id}" style="--list-level: ${line.listLevel - 1}; --prefix-width: ${prefixWidth}">${body}</div>`;
	}

	if (line.kind === 'heading') {
		return `<div class="line heading" data-line-id="${line.id}">${body}</div>`;
	}

	if (line.kind === 'code_fence' || line.kind === 'code_content') {
		return `<div class="line code ${line.kind}" data-line-id="${line.id}">${body}</div>`;
	}

	return `<div class="line" data-line-id="${line.id}">${body}</div>`;
}

export function renderSelectionHtml(document: EditorDocument, start: number, end: number): string {
	if (start >= end) return '';

	const parts = document.blocks
		.map((block) => renderBlockSelection(document.text, block, start, end))
		.filter(Boolean);

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

export function getLineRenderSignature(line: EditorLine): string {
	return [
		line.kind,
		line.raw,
		line.prefix,
		line.listLevel,
		line.listNumber,
		line.headingLevel,
		line.codeBlockLanguage ?? ''
	].join('\u0001');
}

function buildRawLines(text: string): RawLine[] {
	const split = text.split('\n');
	const lines: RawLine[] = [];
	let offset = 0;

	for (let index = 0; index < split.length; index++) {
		const line = split[index];
		lines.push({
			index,
			text: line,
			start: offset,
			end: offset + line.length
		});
		offset += line.length + 1;
	}

	return lines;
}

function parseBlocks(lines: RawLine[]): BlockNode[] {
	return parseBlockSequence(lines, 0, 0).blocks;
}

function parseBlockSequence(lines: RawLine[], startIndex: number, listLevel: number) {
	const blocks: BlockNode[] = [];
	let index = startIndex;

	while (index < lines.length) {
		const line = lines[index];
		const prefix = parsePrefix(line.text);

		if (listLevel > 0) {
			if (line.text.trim() === '') break;
			if (prefix.kind === 'code_fence') {
				const parsed = parseCodeBlock(lines, index);
				blocks.push(parsed.block);
				index = parsed.nextIndex;
				continue;
			}
			if (
				(prefix.kind !== 'ordered_list_item' && prefix.kind !== 'unordered_list_item') ||
				prefix.listLevel < listLevel
			) {
				break;
			}
		}

		if (prefix.kind === 'code_fence') {
			const parsed = parseCodeBlock(lines, index);
			blocks.push(parsed.block);
			index = parsed.nextIndex;
			continue;
		}

		if (prefix.kind === 'ordered_list_item' || prefix.kind === 'unordered_list_item') {
			const parsed = parseList(lines, index, prefix.listLevel, prefix.kind === 'ordered_list_item');
			blocks.push(parsed.block);
			index = parsed.nextIndex;
			continue;
		}

		if (prefix.kind === 'heading') {
			blocks.push(parseHeading(line, prefix));
			index += 1;
			continue;
		}

		blocks.push(parseParagraph(line));
		index += 1;
	}

	return { blocks, nextIndex: index };
}

function parseList(lines: RawLine[], startIndex: number, level: number, ordered: boolean) {
	const items: ListItemBlock[] = [];
	let index = startIndex;

	while (index < lines.length) {
		const line = lines[index];
		const prefix = parsePrefix(line.text);
		if (
			(prefix.kind !== 'ordered_list_item' && prefix.kind !== 'unordered_list_item') ||
			prefix.listLevel < level ||
			(prefix.listLevel === level && (prefix.kind === 'ordered_list_item') !== ordered)
		) {
			break;
		}

		if (prefix.listLevel > level) {
			break;
		}

		const itemStart = line.start;
		const itemPrefixLength = prefix.prefix.length;
		const item: ListItemBlock = {
			type: 'list_item',
			range: { start: itemStart, end: line.end },
			lineRange: { start: line.start, end: line.end },
			level,
			ordered,
			number: prefix.listNumber,
			prefix: prefix.prefix,
			raw: line.text,
			inline: parseInline(line.text.slice(itemPrefixLength), line.start + itemPrefixLength),
			children: []
		};

		index += 1;
		const childParsed = parseBlockSequence(lines, index, level + 1);
		item.children = childParsed.blocks;
		const childEnd =
			item.children.length > 0 ? item.children[item.children.length - 1].range.end : item.range.end;
		item.range = { start: itemStart, end: childEnd };
		items.push(item);
		index = childParsed.nextIndex;
	}

	return {
		block: {
			type: 'list',
			range: {
				start: items[0]?.range.start ?? lines[startIndex].start,
				end: items[items.length - 1]?.range.end ?? lines[startIndex].end
			},
			level,
			ordered,
			items
		} satisfies ListBlock,
		nextIndex: index
	};
}

function parseCodeBlock(lines: RawLine[], startIndex: number) {
	const openLine = lines[startIndex];
	const openPrefix = parsePrefix(openLine.text);
	const contentLines: CodeBlock['lines'] = [];
	let closeFence: string | null = null;
	let end = openLine.end;
	let index = startIndex + 1;

	while (index < lines.length) {
		const line = lines[index];
		const prefix = parsePrefix(line.text);
		if (prefix.kind === 'code_fence') {
			closeFence = prefix.prefix;
			end = line.end;
			index += 1;
			break;
		}

		contentLines.push({
			range: { start: line.start, end: line.end },
			text: line.text
		});
		end = line.end;
		index += 1;
	}

	return {
		block: {
			type: 'code_block',
			range: { start: openLine.start, end },
			language: openPrefix.language,
			openFence: openPrefix.prefix,
			closeFence,
			lines: contentLines
		} satisfies CodeBlock,
		nextIndex: index
	};
}

function parseHeading(line: RawLine, prefix: LinePrefixInfo): HeadingBlock {
	const contentStart = line.start + prefix.prefix.length;
	return {
		type: 'heading',
		range: { start: line.start, end: line.end },
		raw: line.text,
		level: prefix.headingLevel,
		prefix: prefix.prefix,
		inline: parseInline(line.text.slice(prefix.prefix.length), contentStart)
	};
}

function parseParagraph(line: RawLine): ParagraphBlock {
	return {
		type: 'paragraph',
		range: { start: line.start, end: line.end },
		raw: line.text,
		inline: parseInline(line.text, line.start)
	};
}

function deriveLines(blocks: BlockNode[]): EditorLine[] {
	const lines: EditorLine[] = [];

	for (const block of blocks) {
		appendBlockLines(block, lines);
	}

	return lines.map((line, index) => ({
		...line,
		id: `line-${index}`,
		index
	}));
}

function appendBlockLines(block: BlockNode, lines: EditorLine[]) {
	if (block.type === 'paragraph') {
		lines.push(createBaseLine(block.raw, block.range, 'paragraph', '', null, block.inline));
		return;
	}

	if (block.type === 'heading') {
		lines.push(
			createBaseLine(
				block.raw,
				block.range,
				'heading',
				block.prefix,
				null,
				block.inline,
				0,
				0,
				block.level
			)
		);
		return;
	}

	if (block.type === 'code_block') {
		lines.push(
			createBaseLine(
				block.openFence + (block.language ? block.language : ''),
				{
					start: block.range.start,
					end: block.range.start + block.openFence.length + (block.language?.length ?? 0)
				},
				'code_fence',
				block.openFence,
				block.language,
				[]
			)
		);

		for (const line of block.lines) {
			lines.push(createBaseLine(line.text, line.range, 'code_content', '', block.language, []));
		}

		if (block.closeFence) {
			const closeStart = block.range.end - block.closeFence.length;
			lines.push(
				createBaseLine(
					block.closeFence,
					{ start: closeStart, end: block.range.end },
					'code_fence',
					block.closeFence,
					block.language,
					[]
				)
			);
		}
		return;
	}

	if (block.type === 'list') {
		for (const item of block.items) {
			lines.push(
				createBaseLine(
					item.raw,
					item.lineRange,
					item.ordered ? 'ordered_list_item' : 'unordered_list_item',
					item.prefix,
					null,
					item.inline,
					item.level,
					item.number
				)
			);
			for (const child of item.children) {
				appendBlockLines(child, lines);
			}
		}
	}
}

function createBaseLine(
	raw: string,
	range: SourceRange,
	kind: LineKind,
	prefix: string,
	codeBlockLanguage: string | null,
	inline: InlineNode[],
	listLevel = 0,
	listNumber = 0,
	headingLevel = 0
): EditorLine {
	const contentStart = range.start + prefix.length;
	return {
		id: '',
		index: 0,
		raw,
		range,
		kind,
		listLevel,
		listNumber,
		headingLevel,
		prefix,
		prefixRange: prefix.length > 0 ? { start: range.start, end: contentStart } : null,
		contentRange: { start: contentStart, end: range.end },
		inline,
		codeBlockLanguage
	};
}

function parsePrefix(raw: string): LinePrefixInfo {
	const codeFenceMatch = raw.match(/^```([A-Za-z0-9_-]+)?\s*$/);
	if (codeFenceMatch) {
		return {
			kind: 'code_fence',
			listLevel: 0,
			listNumber: 0,
			headingLevel: 0,
			prefix: '```',
			language: codeFenceMatch[1] ?? null
		};
	}

	const unorderedMatch = raw.match(/^((?: {4})*)- /);
	if (unorderedMatch) {
		return {
			kind: 'unordered_list_item',
			listLevel: unorderedMatch[1].length / 4 + 1,
			listNumber: 0,
			headingLevel: 0,
			prefix: unorderedMatch[0],
			language: null
		};
	}

	const orderedMatch = raw.match(/^((?: {4})*)(\d+)\. /);
	if (orderedMatch) {
		return {
			kind: 'ordered_list_item',
			listLevel: orderedMatch[1].length / 4 + 1,
			listNumber: Number.parseInt(orderedMatch[2], 10),
			headingLevel: 0,
			prefix: orderedMatch[0],
			language: null
		};
	}

	const headingMatch = raw.match(/^(#{1,6})\s+/);
	if (headingMatch) {
		return {
			kind: 'heading',
			listLevel: 0,
			listNumber: 0,
			headingLevel: headingMatch[1].length,
			prefix: headingMatch[0],
			language: null
		};
	}

	return {
		kind: 'paragraph',
		listLevel: 0,
		listNumber: 0,
		headingLevel: 0,
		prefix: '',
		language: null
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
		} satisfies TextNode);
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

function renderBlockSelection(
	sourceText: string,
	block: BlockNode,
	start: number,
	end: number
): string {
	if (end <= block.range.start || start >= block.range.end) return '';

	if (block.type === 'paragraph') {
		return `<p>${renderSemanticInlineSelection(sourceText, block.inline, start, end) || '<br>'}</p>`;
	}

	if (block.type === 'heading') {
		return `<p><strong>${renderSemanticInlineSelection(sourceText, block.inline, start, end) || '<br>'}</strong></p>`;
	}

	if (block.type === 'code_block') {
		const codeParts: string[] = [];
		for (const line of block.lines) {
			if (end <= line.range.start || start >= line.range.end) continue;
			codeParts.push(escapeHtmlForClipboard(sliceRange(sourceText, line.range, start, end)));
		}
		return `<pre><code>${codeParts.join('\n')}</code></pre>`;
	}

	const tag = block.ordered ? 'ol' : 'ul';
	const items = block.items
		.map((item) => renderListItemSelection(sourceText, item, start, end))
		.filter(Boolean)
		.join('');
	return items ? `<${tag}>${items}</${tag}>` : '';
}

function renderListItemSelection(
	sourceText: string,
	item: ListItemBlock,
	start: number,
	end: number
): string {
	if (end <= item.range.start || start >= item.range.end) return '';

	const parts: string[] = [];
	const itemInline = renderSemanticInlineSelection(sourceText, item.inline, start, end);
	parts.push(itemInline || '<br>');

	for (const child of item.children) {
		const childHtml = renderBlockSelection(sourceText, child, start, end);
		if (childHtml) parts.push(childHtml);
	}

	return `<li>${parts.join('')}</li>`;
}

function renderSemanticInlineSelection(
	sourceText: string,
	inline: InlineNode[],
	start: number,
	end: number
): string {
	if (start >= end) return '';

	const parts: string[] = [];

	for (const node of inline) {
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
