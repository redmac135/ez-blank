import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocument, renderEditorLine, renderSelectionHtml } from '../src/lib/editor/parser.ts';

function getOnlyLine(source: string) {
	const document = buildDocument(source);
	assert.equal(document.lines.length, 1);
	return { document, line: document.lines[0]! };
}

test('buildDocument keeps an empty document stable', () => {
	const { document, line } = getOnlyLine('');

	assert.equal(document.text, '');
	assert.equal(document.blocks.length, 1);
	assert.equal(document.blocks[0]?.type, 'paragraph');
	assert.equal(line.raw, '');
	assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0"><br></div>');
});

test('plain text escapes HTML in rendered output', () => {
	const { line } = getOnlyLine('<tag> & text');

	assert.equal(
		renderEditorLine(line),
		'<div class="line" data-line-id="line-0">&lt;tag&gt; &amp; text</div>'
	);
});

test('unmatched star is parsed as plain text', () => {
	const { line } = getOnlyLine('*');

	assert.equal(line.inline.length, 1);
	assert.deepEqual(line.inline[0], {
		type: 'text',
		range: { start: 0, end: 1 },
		text: '*'
	});
	assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0">*</div>');
});

test('unfinished strong marker remains plain text instead of hanging', () => {
	const { line } = getOnlyLine('**');

	assert.equal(line.inline.length, 2);
	assert.deepEqual(line.inline[0], {
		type: 'text',
		range: { start: 0, end: 1 },
		text: '*'
	});
	assert.deepEqual(line.inline[1], {
		type: 'text',
		range: { start: 1, end: 2 },
		text: '*'
	});
	assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0">**</div>');
});

test('strong and strong emphasis require non-empty content', () => {
	const doubleMarker = getOnlyLine('****').line;
	const tripleMarker = getOnlyLine('******').line;

	assert.equal(renderEditorLine(doubleMarker), '<div class="line" data-line-id="line-0">****</div>');
	assert.equal(renderEditorLine(tripleMarker), '<div class="line" data-line-id="line-0">******</div>');
});

test('valid emphasis still renders syntax markers and semantic tags', () => {
	const { line } = getOnlyLine('a *b* c');

	assert.equal(line.inline.length, 3);
	assert.equal(line.inline[1]?.type, 'emphasis');
	assert.equal(
		renderEditorLine(line),
		'<div class="line" data-line-id="line-0">a <span class="syntax-marker">*</span><em>b</em><span class="syntax-marker">*</span> c</div>'
	);
});

test('valid strong and strong emphasis render correctly', () => {
	const strong = getOnlyLine('**bold**').line;
	const strongEmphasis = getOnlyLine('***both***').line;

	assert.equal(strong.inline[0]?.type, 'strong');
	assert.equal(
		renderEditorLine(strong),
		'<div class="line" data-line-id="line-0"><span class="syntax-marker">**</span><strong>bold</strong><span class="syntax-marker">**</span></div>'
	);

	assert.equal(strongEmphasis.inline[0]?.type, 'strong_emphasis');
	assert.equal(
		renderEditorLine(strongEmphasis),
		'<div class="line" data-line-id="line-0"><span class="syntax-marker">***</span><strong><em>both</em></strong><span class="syntax-marker">***</span></div>'
	);
});

test('formatting markers with leading or trailing spaces are treated as plain text', () => {
	const leadingSpace = getOnlyLine('* text*').line;
	const trailingSpace = getOnlyLine('*text *').line;

	assert.equal(renderEditorLine(leadingSpace), '<div class="line" data-line-id="line-0">* text*</div>');
	assert.equal(renderEditorLine(trailingSpace), '<div class="line" data-line-id="line-0">*text *</div>');
});

test('heading blocks track level and render with heading class', () => {
	const { document, line } = getOnlyLine('### Title');
	const block = document.blocks[0];

	assert.equal(block?.type, 'heading');
	assert.equal(block?.level, 3);
	assert.equal(line.kind, 'heading');
	assert.equal(line.headingLevel, 3);
	assert.equal(line.prefix, '### ');
	assert.equal(
		renderEditorLine(line),
		'<div class="line heading" data-line-id="line-0">### Title</div>'
	);
});

test('unordered lists preserve nesting in AST and line metadata', () => {
	const source = '- parent\n    - child\n- sibling';
	const document = buildDocument(source);
	const block = document.blocks[0];

	assert.equal(block?.type, 'list');
	assert.equal(block?.ordered, false);
	assert.equal(block?.items.length, 2);
	assert.equal(block?.items[0]?.children.length, 1);
	assert.equal(block?.items[0]?.children[0]?.type, 'list');

	assert.equal(document.lines.length, 3);
	assert.equal(document.lines[0]?.kind, 'unordered_list_item');
	assert.equal(document.lines[0]?.listLevel, 1);
	assert.equal(document.lines[1]?.kind, 'unordered_list_item');
	assert.equal(document.lines[1]?.listLevel, 2);
	assert.equal(document.lines[2]?.kind, 'unordered_list_item');
	assert.equal(document.lines[2]?.listLevel, 1);
});

test('ordered lists capture list numbers and nested indent metadata', () => {
	const source = '12. top\n    3. nested';
	const document = buildDocument(source);

	assert.equal(document.lines.length, 2);
	assert.equal(document.lines[0]?.kind, 'ordered_list_item');
	assert.equal(document.lines[0]?.listNumber, 12);
	assert.equal(document.lines[0]?.listLevel, 1);
	assert.equal(document.lines[1]?.kind, 'ordered_list_item');
	assert.equal(document.lines[1]?.listNumber, 3);
	assert.equal(document.lines[1]?.listLevel, 2);
});

test('list rendering computes prefix width and indent level for unordered items', () => {
	const topLevel = getOnlyLine('- item').line;
	const nested = getOnlyLine('    - item').line;

	assert.equal(
		renderEditorLine(topLevel),
		'<div class="line list" data-line-id="line-0" style="--list-level: 0; --prefix-width: 2">- item</div>'
	);
	assert.equal(
		renderEditorLine(nested),
		'<div class="line list" data-line-id="line-0" style="--list-level: 1; --prefix-width: 2">    - item</div>'
	);
});

test('list rendering computes prefix width for ordered items with multi-digit prefixes', () => {
	const topLevel = getOnlyLine('12. item').line;
	const nested = getOnlyLine('    12. item').line;

	assert.equal(
		renderEditorLine(topLevel),
		'<div class="line list" data-line-id="line-0" style="--list-level: 0; --prefix-width: 4">12. item</div>'
	);
	assert.equal(
		renderEditorLine(nested),
		'<div class="line list" data-line-id="line-0" style="--list-level: 1; --prefix-width: 4">    12. item</div>'
	);
});

test('code fences produce fence and content lines with code styling', () => {
	const document = buildDocument('```ts\nconst x = 1;\n```');

	assert.equal(document.blocks.length, 1);
	assert.equal(document.blocks[0]?.type, 'code_block');
	assert.equal(document.lines.length, 3);
	assert.equal(document.lines[0]?.kind, 'code_fence');
	assert.equal(document.lines[0]?.codeBlockLanguage, 'ts');
	assert.equal(document.lines[1]?.kind, 'code_content');
	assert.equal(document.lines[2]?.kind, 'code_fence');
	assert.equal(
		renderEditorLine(document.lines[0]!),
		'<div class="line code code_fence" data-line-id="line-0">```ts</div>'
	);
	assert.equal(
		renderEditorLine(document.lines[1]!),
		'<div class="line code code_content" data-line-id="line-1">const x = 1;</div>'
	);
});

test('renderSelectionHtml preserves semantic markup for partial selections', () => {
	const document = buildDocument('a *b* c');

	assert.equal(
		renderSelectionHtml(document, 3, 4),
		'<div style="white-space: pre-wrap;"><p><em>b</em></p></div>'
	);
});

test('renderSelectionHtml omits syntax markers for list content selections', () => {
	const document = buildDocument('- *item*');

	assert.equal(
		renderSelectionHtml(document, 3, 7),
		'<div style="white-space: pre-wrap;"><ul><li><em>item</em></li></ul></div>'
	);
});

test('renderSelectionHtml preserves code block text and spacing', () => {
	const document = buildDocument('```js\n  x\n```');

	assert.equal(
		renderSelectionHtml(document, 6, 10),
		'<div style="white-space: pre-wrap;"><pre><code>&nbsp;&nbsp;x</code></pre></div>'
	);
});
