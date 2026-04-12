import type { BlockNode, ListBlock } from './ast';
import { buildDocument } from './parser';
import type { SelectionRange, TextChange } from './text';

export interface ListMetadata {
	listLevel: number;
	ordered: boolean;
	listNumber: number;
	prefix: string;
}

interface TextReplacement {
	start: number;
	end: number;
	text: string;
}

export function getListMetadata(lineText: string): ListMetadata {
	const unorderedMatch = lineText.match(/^((?: {4})*)- /);
	if (unorderedMatch) {
		return {
			listLevel: unorderedMatch[1].length / 4 + 1,
			ordered: false,
			listNumber: 0,
			prefix: unorderedMatch[0]
		};
	}

	const orderedMatch = lineText.match(/^((?: {4})*)(\d+)\. /);
	if (orderedMatch) {
		return {
			listLevel: orderedMatch[1].length / 4 + 1,
			ordered: true,
			listNumber: Number.parseInt(orderedMatch[2], 10),
			prefix: orderedMatch[0]
		};
	}

	return {
		listLevel: 0,
		ordered: false,
		listNumber: 0,
		prefix: ''
	};
}

export function normalizeOrderedListNumbers(
	text: string,
	affectedRange: SelectionRange,
	selection: SelectionRange
): TextChange {
	const document = buildDocument(text);
	const replacements: TextReplacement[] = [];

	collectOrderedListReplacements(document.blocks, affectedRange, replacements);

	if (replacements.length === 0) {
		return {
			text,
			selectionStart: selection.start,
			selectionEnd: selection.end
		};
	}

	replacements.sort((left, right) => right.start - left.start);

	let nextText = text;
	let selectionStart = selection.start;
	let selectionEnd = selection.end;

	for (const replacement of replacements) {
		const replacedLength = replacement.end - replacement.start;
		const delta = replacement.text.length - replacedLength;
		nextText =
			nextText.slice(0, replacement.start) + replacement.text + nextText.slice(replacement.end);
		selectionStart = adjustSelectionPoint(
			selectionStart,
			replacement.start,
			replacement.end,
			replacement.text.length,
			delta
		);
		selectionEnd = adjustSelectionPoint(
			selectionEnd,
			replacement.start,
			replacement.end,
			replacement.text.length,
			delta
		);
	}

	return {
		text: nextText,
		selectionStart,
		selectionEnd
	};
}

function collectOrderedListReplacements(
	blocks: BlockNode[],
	affectedRange: SelectionRange,
	replacements: TextReplacement[]
): boolean {
	let foundAffectedBlock = false;

	for (const block of blocks) {
		let blockAffected = rangesIntersect(block.range, affectedRange);

		if (block.type === 'list') {
			collectListReplacements(block, affectedRange, replacements);

			for (const item of block.items) {
				const childrenAffected = collectOrderedListReplacements(
					item.children,
					affectedRange,
					replacements
				);
				if (childrenAffected) {
					normalizeSiblingOrderedChildLists(item.children, affectedRange, replacements);
					blockAffected = true;
				}
			}
		}

		if (blockAffected) {
			foundAffectedBlock = true;
		}
	}

	return foundAffectedBlock;
}

function collectListReplacements(
	block: ListBlock,
	affectedRange: SelectionRange,
	replacements: TextReplacement[]
) {
	if (!block.ordered || !rangesIntersect(block.range, affectedRange)) {
		return;
	}

	for (let index = 0; index < block.items.length; index++) {
		const item = block.items[index]!;
		const expectedNumber = index + 1;
		if (item.number === expectedNumber) continue;

		replacements.push({
			start: item.lineRange.start,
			end: item.lineRange.start + item.prefix.length,
			text: `${'    '.repeat(item.level - 1)}${expectedNumber}. `
		});
	}
}

function normalizeSiblingOrderedChildLists(
	blocks: BlockNode[],
	affectedRange: SelectionRange,
	replacements: TextReplacement[]
) {
	for (const block of blocks) {
		if (block.type !== 'list' || !block.ordered || rangesIntersect(block.range, affectedRange)) {
			continue;
		}

		collectListReplacements(block, block.range, replacements);
	}
}

function rangesIntersect(left: SelectionRange, right: SelectionRange) {
	return left.start <= right.end && right.start <= left.end;
}

function adjustSelectionPoint(
	point: number,
	start: number,
	end: number,
	replacementLength: number,
	delta: number
) {
	if (point > end) {
		return point + delta;
	}

	if (point >= start) {
		return start + Math.min(point - start, replacementLength);
	}

	return point;
}
