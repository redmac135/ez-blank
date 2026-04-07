// tests/parser.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/editor/parser.ts
function buildDocument(rawText) {
  const text = normalizeText(rawText);
  const rawLines = buildRawLines(text);
  const blocks = parseBlocks(rawLines);
  const lines = deriveLines(blocks);
  return { text, blocks, lines };
}
function normalizeText(rawText) {
  return rawText;
}
function renderEditorLine(line) {
  const prefix = line.prefixRange ? renderEditorText(line.prefix) : "";
  const content = line.kind.startsWith("code_") ? renderEditorText(line.raw.slice(line.prefix.length)) : renderEditorInline(line.inline);
  const body = prefix + (content || (line.raw.length === 0 ? "<br>" : ""));
  if (line.kind === "ordered_list_item" || line.kind === "unordered_list_item") {
    const prefixWidth = line.prefix.trimStart().length;
    return `<div class="line list" data-line-id="${line.id}" style="--list-level: ${line.listLevel - 1}; --prefix-width: ${prefixWidth}">${body}</div>`;
  }
  if (line.kind === "heading") {
    return `<div class="line heading" data-line-id="${line.id}">${body}</div>`;
  }
  if (line.kind === "code_fence" || line.kind === "code_content") {
    return `<div class="line code ${line.kind}" data-line-id="${line.id}">${body}</div>`;
  }
  return `<div class="line" data-line-id="${line.id}">${body}</div>`;
}
function renderSelectionHtml(document, start, end) {
  if (start >= end) return "";
  const parts = document.blocks.map((block) => renderBlockSelection(document.text, block, start, end)).filter(Boolean);
  return `<div style="white-space: pre-wrap;">${parts.join("")}</div>`;
}
function buildRawLines(text) {
  const split = text.split("\n");
  const lines = [];
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
function parseBlocks(lines) {
  return parseBlockSequence(lines, 0, 0).blocks;
}
function parseBlockSequence(lines, startIndex, listLevel) {
  const blocks = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    const prefix = parsePrefix(line.text);
    if (listLevel > 0) {
      if (line.text.trim() === "") break;
      if (prefix.kind === "code_fence") {
        const parsed = parseCodeBlock(lines, index);
        blocks.push(parsed.block);
        index = parsed.nextIndex;
        continue;
      }
      if (prefix.kind !== "ordered_list_item" && prefix.kind !== "unordered_list_item" || prefix.listLevel < listLevel) {
        break;
      }
    }
    if (prefix.kind === "code_fence") {
      const parsed = parseCodeBlock(lines, index);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }
    if (prefix.kind === "ordered_list_item" || prefix.kind === "unordered_list_item") {
      const parsed = parseList(lines, index, prefix.listLevel, prefix.kind === "ordered_list_item");
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }
    if (prefix.kind === "heading") {
      blocks.push(parseHeading(line, prefix));
      index += 1;
      continue;
    }
    blocks.push(parseParagraph(line));
    index += 1;
  }
  return { blocks, nextIndex: index };
}
function parseList(lines, startIndex, level, ordered) {
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    const prefix = parsePrefix(line.text);
    if (prefix.kind !== "ordered_list_item" && prefix.kind !== "unordered_list_item" || prefix.listLevel < level || prefix.listLevel === level && prefix.kind === "ordered_list_item" !== ordered) {
      break;
    }
    if (prefix.listLevel > level) {
      break;
    }
    const itemStart = line.start;
    const itemPrefixLength = prefix.prefix.length;
    const item = {
      type: "list_item",
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
    const childEnd = item.children.length > 0 ? item.children[item.children.length - 1].range.end : item.range.end;
    item.range = { start: itemStart, end: childEnd };
    items.push(item);
    index = childParsed.nextIndex;
  }
  return {
    block: {
      type: "list",
      range: {
        start: items[0]?.range.start ?? lines[startIndex].start,
        end: items[items.length - 1]?.range.end ?? lines[startIndex].end
      },
      level,
      ordered,
      items
    },
    nextIndex: index
  };
}
function parseCodeBlock(lines, startIndex) {
  const openLine = lines[startIndex];
  const openPrefix = parsePrefix(openLine.text);
  const contentLines = [];
  let closeFence = null;
  let end = openLine.end;
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index];
    const prefix = parsePrefix(line.text);
    if (prefix.kind === "code_fence") {
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
      type: "code_block",
      range: { start: openLine.start, end },
      language: openPrefix.language,
      openFence: openPrefix.prefix,
      closeFence,
      lines: contentLines
    },
    nextIndex: index
  };
}
function parseHeading(line, prefix) {
  const contentStart = line.start + prefix.prefix.length;
  return {
    type: "heading",
    range: { start: line.start, end: line.end },
    raw: line.text,
    level: prefix.headingLevel,
    prefix: prefix.prefix,
    inline: parseInline(line.text.slice(prefix.prefix.length), contentStart)
  };
}
function parseParagraph(line) {
  return {
    type: "paragraph",
    range: { start: line.start, end: line.end },
    raw: line.text,
    inline: parseInline(line.text, line.start)
  };
}
function deriveLines(blocks) {
  const lines = [];
  for (const block of blocks) {
    appendBlockLines(block, lines);
  }
  return lines.map((line, index) => ({
    ...line,
    id: `line-${index}`,
    index
  }));
}
function appendBlockLines(block, lines) {
  if (block.type === "paragraph") {
    lines.push(createBaseLine(block.raw, block.range, "paragraph", "", null, block.inline));
    return;
  }
  if (block.type === "heading") {
    lines.push(
      createBaseLine(
        block.raw,
        block.range,
        "heading",
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
  if (block.type === "code_block") {
    lines.push(
      createBaseLine(
        block.openFence + (block.language ? block.language : ""),
        {
          start: block.range.start,
          end: block.range.start + block.openFence.length + (block.language?.length ?? 0)
        },
        "code_fence",
        block.openFence,
        block.language,
        []
      )
    );
    for (const line of block.lines) {
      lines.push(createBaseLine(line.text, line.range, "code_content", "", block.language, []));
    }
    if (block.closeFence) {
      const closeStart = block.range.end - block.closeFence.length;
      lines.push(
        createBaseLine(
          block.closeFence,
          { start: closeStart, end: block.range.end },
          "code_fence",
          block.closeFence,
          block.language,
          []
        )
      );
    }
    return;
  }
  if (block.type === "list") {
    for (const item of block.items) {
      lines.push(
        createBaseLine(
          item.raw,
          item.lineRange,
          item.ordered ? "ordered_list_item" : "unordered_list_item",
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
function createBaseLine(raw, range, kind, prefix, codeBlockLanguage, inline, listLevel = 0, listNumber = 0, headingLevel = 0) {
  const contentStart = range.start + prefix.length;
  return {
    id: "",
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
function parsePrefix(raw) {
  const codeFenceMatch = raw.match(/^```([A-Za-z0-9_-]+)?\s*$/);
  if (codeFenceMatch) {
    return {
      kind: "code_fence",
      listLevel: 0,
      listNumber: 0,
      headingLevel: 0,
      prefix: "```",
      language: codeFenceMatch[1] ?? null
    };
  }
  const unorderedMatch = raw.match(/^((?: {4})*)- /);
  if (unorderedMatch) {
    return {
      kind: "unordered_list_item",
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
      kind: "ordered_list_item",
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
      kind: "heading",
      listLevel: 0,
      listNumber: 0,
      headingLevel: headingMatch[1].length,
      prefix: headingMatch[0],
      language: null
    };
  }
  return {
    kind: "paragraph",
    listLevel: 0,
    listNumber: 0,
    headingLevel: 0,
    prefix: "",
    language: null
  };
}
function parseInline(raw, startOffset) {
  const inline = [];
  let index = 0;
  while (index < raw.length) {
    const formattedNode = parseFormattedNode(raw, startOffset, index);
    if (formattedNode) {
      inline.push(formattedNode.node);
      index = formattedNode.nextIndex;
      continue;
    }
    let nextMarker = raw.length;
    const starIndex = raw.indexOf("*", index);
    if (starIndex !== -1) nextMarker = starIndex;
    if (nextMarker === index) {
      inline.push({
        type: "text",
        range: { start: startOffset + index, end: startOffset + index + 1 },
        text: raw[index]
      });
      index += 1;
      continue;
    }
    const text = raw.slice(index, nextMarker);
    inline.push({
      type: "text",
      range: { start: startOffset + index, end: startOffset + nextMarker },
      text
    });
    index = nextMarker;
  }
  return inline;
}
function parseFormattedNode(raw, startOffset, index) {
  for (const marker of ["***", "**", "*"]) {
    if (!raw.startsWith(marker, index)) continue;
    const close = raw.indexOf(marker, index + marker.length);
    if (close === -1) continue;
    const contentStart = index + marker.length;
    const contentEnd = close;
    if (contentStart >= contentEnd) continue;
    if (raw[contentStart] === " " || raw[contentEnd - 1] === " ") continue;
    const type = marker === "***" ? "strong_emphasis" : marker === "**" ? "strong" : "emphasis";
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
      },
      nextIndex: close + marker.length
    };
  }
  return null;
}
function renderEditorInline(inline) {
  return inline.map((node) => {
    if (node.type === "text") {
      return renderEditorText(node.text);
    }
    const marker = `<span class="syntax-marker">${escapeHtml(node.marker)}</span>`;
    const content = escapeHtml(node.text);
    if (node.type === "emphasis") {
      return `${marker}<em>${content}</em>${marker}`;
    }
    if (node.type === "strong") {
      return `${marker}<strong>${content}</strong>${marker}`;
    }
    return `${marker}<strong><em>${content}</em></strong>${marker}`;
  }).join("");
}
function renderBlockSelection(sourceText, block, start, end) {
  if (end <= block.range.start || start >= block.range.end) return "";
  if (block.type === "paragraph") {
    return `<p>${renderSemanticInlineSelection(sourceText, block.inline, start, end) || "<br>"}</p>`;
  }
  if (block.type === "heading") {
    const tag2 = `h${block.level}`;
    return `<${tag2}>${renderSemanticInlineSelection(sourceText, block.inline, start, end) || "<br>"}</${tag2}>`;
  }
  if (block.type === "code_block") {
    const codeParts = [];
    for (const line of block.lines) {
      if (end <= line.range.start || start >= line.range.end) continue;
      codeParts.push(escapeHtmlForClipboard(sliceRange(sourceText, line.range, start, end)));
    }
    return `<pre><code>${codeParts.join("\n")}</code></pre>`;
  }
  const tag = block.ordered ? "ol" : "ul";
  const items = block.items.map((item) => renderListItemSelection(sourceText, item, start, end)).filter(Boolean).join("");
  return items ? `<${tag}>${items}</${tag}>` : "";
}
function renderListItemSelection(sourceText, item, start, end) {
  if (end <= item.range.start || start >= item.range.end) return "";
  const parts = [];
  const itemInline = renderSemanticInlineSelection(sourceText, item.inline, start, end);
  parts.push(itemInline || "<br>");
  for (const child of item.children) {
    const childHtml = renderBlockSelection(sourceText, child, start, end);
    if (childHtml) parts.push(childHtml);
  }
  return `<li>${parts.join("")}</li>`;
}
function renderSemanticInlineSelection(sourceText, inline, start, end) {
  if (start >= end) return "";
  const parts = [];
  for (const node of inline) {
    if (node.type === "text") {
      const slice = sliceRange(sourceText, node.range, start, end);
      if (slice) parts.push(escapeHtmlForClipboard(slice));
      continue;
    }
    const innerSlice = sliceRange(sourceText, node.contentRange, start, end);
    if (!innerSlice) continue;
    if (node.type === "emphasis") {
      parts.push(`<em>${escapeHtmlForClipboard(innerSlice)}</em>`);
      continue;
    }
    if (node.type === "strong") {
      parts.push(`<strong>${escapeHtmlForClipboard(innerSlice)}</strong>`);
      continue;
    }
    parts.push(`<strong><em>${escapeHtmlForClipboard(innerSlice)}</em></strong>`);
  }
  return parts.join("");
}
function sliceRange(sourceText, range, selectionStart, selectionEnd) {
  const start = Math.max(range.start, selectionStart);
  const end = Math.min(range.end, selectionEnd);
  if (start >= end) return "";
  return sourceText.slice(start, end);
}
function renderEditorText(text) {
  return text.length === 0 ? "" : escapeHtml(text);
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlForClipboard(text) {
  return escapeHtml(text).replace(/ /g, "&nbsp;").replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;");
}

// src/lib/editor/lists.ts
function normalizeOrderedListNumbers(text, affectedRange, selection) {
  const document = buildDocument(text);
  const replacements = [];
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
    nextText = nextText.slice(0, replacement.start) + replacement.text + nextText.slice(replacement.end);
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
function collectOrderedListReplacements(blocks, affectedRange, replacements) {
  for (const block of blocks) {
    if (block.type === "list") {
      collectListReplacements(block, affectedRange, replacements);
      for (const item of block.items) {
        collectOrderedListReplacements(item.children, affectedRange, replacements);
      }
    }
  }
}
function collectListReplacements(block, affectedRange, replacements) {
  if (!block.ordered || !rangesIntersect(block.range, affectedRange)) {
    return;
  }
  for (let index = 0; index < block.items.length; index++) {
    const item = block.items[index];
    const expectedNumber = index + 1;
    if (item.number === expectedNumber) continue;
    replacements.push({
      start: item.lineRange.start,
      end: item.lineRange.start + item.prefix.length,
      text: `${"    ".repeat(item.level - 1)}${expectedNumber}. `
    });
  }
}
function rangesIntersect(left, right) {
  return left.start <= right.end && right.start <= left.end;
}
function adjustSelectionPoint(point, start, end, replacementLength, delta) {
  if (point > end) {
    return point + delta;
  }
  if (point >= start) {
    return start + Math.min(point - start, replacementLength);
  }
  return point;
}

// tests/parser.test.ts
function getOnlyLine(source) {
  const document = buildDocument(source);
  assert.equal(document.lines.length, 1);
  return { document, line: document.lines[0] };
}
test("buildDocument keeps an empty document stable", () => {
  const { document, line } = getOnlyLine("");
  assert.equal(document.text, "");
  assert.equal(document.blocks.length, 1);
  assert.equal(document.blocks[0]?.type, "paragraph");
  assert.equal(line.raw, "");
  assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0"><br></div>');
});
test("plain text escapes HTML in rendered output", () => {
  const { line } = getOnlyLine("<tag> & text");
  assert.equal(
    renderEditorLine(line),
    '<div class="line" data-line-id="line-0">&lt;tag&gt; &amp; text</div>'
  );
});
test("unmatched star is parsed as plain text", () => {
  const { line } = getOnlyLine("*");
  assert.equal(line.inline.length, 1);
  assert.deepEqual(line.inline[0], {
    type: "text",
    range: { start: 0, end: 1 },
    text: "*"
  });
  assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0">*</div>');
});
test("unfinished strong marker remains plain text instead of hanging", () => {
  const { line } = getOnlyLine("**");
  assert.equal(line.inline.length, 2);
  assert.deepEqual(line.inline[0], {
    type: "text",
    range: { start: 0, end: 1 },
    text: "*"
  });
  assert.deepEqual(line.inline[1], {
    type: "text",
    range: { start: 1, end: 2 },
    text: "*"
  });
  assert.equal(renderEditorLine(line), '<div class="line" data-line-id="line-0">**</div>');
});
test("strong and strong emphasis require non-empty content", () => {
  const doubleMarker = getOnlyLine("****").line;
  const tripleMarker = getOnlyLine("******").line;
  assert.equal(renderEditorLine(doubleMarker), '<div class="line" data-line-id="line-0">****</div>');
  assert.equal(renderEditorLine(tripleMarker), '<div class="line" data-line-id="line-0">******</div>');
});
test("valid emphasis still renders syntax markers and semantic tags", () => {
  const { line } = getOnlyLine("a *b* c");
  assert.equal(line.inline.length, 3);
  assert.equal(line.inline[1]?.type, "emphasis");
  assert.equal(
    renderEditorLine(line),
    '<div class="line" data-line-id="line-0">a <span class="syntax-marker">*</span><em>b</em><span class="syntax-marker">*</span> c</div>'
  );
});
test("valid strong and strong emphasis render correctly", () => {
  const strong = getOnlyLine("**bold**").line;
  const strongEmphasis = getOnlyLine("***both***").line;
  assert.equal(strong.inline[0]?.type, "strong");
  assert.equal(
    renderEditorLine(strong),
    '<div class="line" data-line-id="line-0"><span class="syntax-marker">**</span><strong>bold</strong><span class="syntax-marker">**</span></div>'
  );
  assert.equal(strongEmphasis.inline[0]?.type, "strong_emphasis");
  assert.equal(
    renderEditorLine(strongEmphasis),
    '<div class="line" data-line-id="line-0"><span class="syntax-marker">***</span><strong><em>both</em></strong><span class="syntax-marker">***</span></div>'
  );
});
test("formatting markers with leading or trailing spaces are treated as plain text", () => {
  const leadingSpace = getOnlyLine("* text*").line;
  const trailingSpace = getOnlyLine("*text *").line;
  assert.equal(renderEditorLine(leadingSpace), '<div class="line" data-line-id="line-0">* text*</div>');
  assert.equal(renderEditorLine(trailingSpace), '<div class="line" data-line-id="line-0">*text *</div>');
});
test("heading blocks track level and render with heading class", () => {
  const { document, line } = getOnlyLine("### Title");
  const block = document.blocks[0];
  assert.equal(block?.type, "heading");
  assert.equal(block?.level, 3);
  assert.equal(line.kind, "heading");
  assert.equal(line.headingLevel, 3);
  assert.equal(line.prefix, "### ");
  assert.equal(
    renderEditorLine(line),
    '<div class="line heading" data-line-id="line-0">### Title</div>'
  );
});
test("unordered lists preserve nesting in AST and line metadata", () => {
  const source = "- parent\n    - child\n- sibling";
  const document = buildDocument(source);
  const block = document.blocks[0];
  assert.equal(block?.type, "list");
  assert.equal(block?.ordered, false);
  assert.equal(block?.items.length, 2);
  assert.equal(block?.items[0]?.children.length, 1);
  assert.equal(block?.items[0]?.children[0]?.type, "list");
  assert.equal(document.lines.length, 3);
  assert.equal(document.lines[0]?.kind, "unordered_list_item");
  assert.equal(document.lines[0]?.listLevel, 1);
  assert.equal(document.lines[1]?.kind, "unordered_list_item");
  assert.equal(document.lines[1]?.listLevel, 2);
  assert.equal(document.lines[2]?.kind, "unordered_list_item");
  assert.equal(document.lines[2]?.listLevel, 1);
});
test("ordered lists capture list numbers and nested indent metadata", () => {
  const source = "12. top\n    3. nested";
  const document = buildDocument(source);
  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0]?.kind, "ordered_list_item");
  assert.equal(document.lines[0]?.listNumber, 12);
  assert.equal(document.lines[0]?.listLevel, 1);
  assert.equal(document.lines[1]?.kind, "ordered_list_item");
  assert.equal(document.lines[1]?.listNumber, 3);
  assert.equal(document.lines[1]?.listLevel, 2);
});
test("list rendering computes prefix width and indent level for unordered items", () => {
  const topLevel = getOnlyLine("- item").line;
  const nested = getOnlyLine("    - item").line;
  assert.equal(
    renderEditorLine(topLevel),
    '<div class="line list" data-line-id="line-0" style="--list-level: 0; --prefix-width: 2">- item</div>'
  );
  assert.equal(
    renderEditorLine(nested),
    '<div class="line list" data-line-id="line-0" style="--list-level: 1; --prefix-width: 2">    - item</div>'
  );
});
test("list rendering computes prefix width for ordered items with multi-digit prefixes", () => {
  const topLevel = getOnlyLine("12. item").line;
  const nested = getOnlyLine("    12. item").line;
  assert.equal(
    renderEditorLine(topLevel),
    '<div class="line list" data-line-id="line-0" style="--list-level: 0; --prefix-width: 4">12. item</div>'
  );
  assert.equal(
    renderEditorLine(nested),
    '<div class="line list" data-line-id="line-0" style="--list-level: 1; --prefix-width: 4">    12. item</div>'
  );
});
test("code fences produce fence and content lines with code styling", () => {
  const document = buildDocument("```ts\nconst x = 1;\n```");
  assert.equal(document.blocks.length, 1);
  assert.equal(document.blocks[0]?.type, "code_block");
  assert.equal(document.lines.length, 3);
  assert.equal(document.lines[0]?.kind, "code_fence");
  assert.equal(document.lines[0]?.codeBlockLanguage, "ts");
  assert.equal(document.lines[1]?.kind, "code_content");
  assert.equal(document.lines[2]?.kind, "code_fence");
  assert.equal(
    renderEditorLine(document.lines[0]),
    '<div class="line code code_fence" data-line-id="line-0">```ts</div>'
  );
  assert.equal(
    renderEditorLine(document.lines[1]),
    '<div class="line code code_content" data-line-id="line-1">const x = 1;</div>'
  );
});
test("renderSelectionHtml preserves semantic markup for partial selections", () => {
  const document = buildDocument("a *b* c");
  assert.equal(
    renderSelectionHtml(document, 3, 4),
    '<div style="white-space: pre-wrap;"><p><em>b</em></p></div>'
  );
});
test("renderSelectionHtml copies headings as semantic heading tags", () => {
  const document = buildDocument("## Title");
  assert.equal(
    renderSelectionHtml(document, 0, document.text.length),
    '<div style="white-space: pre-wrap;"><h2>Title</h2></div>'
  );
});
test("renderSelectionHtml preserves heading level for partial heading selections", () => {
  const document = buildDocument("#### Title");
  assert.equal(
    renderSelectionHtml(document, 5, 7),
    '<div style="white-space: pre-wrap;"><h4>Ti</h4></div>'
  );
});
test("renderSelectionHtml omits syntax markers for list content selections", () => {
  const document = buildDocument("- *item*");
  assert.equal(
    renderSelectionHtml(document, 3, 7),
    '<div style="white-space: pre-wrap;"><ul><li><em>item</em></li></ul></div>'
  );
});
test("renderSelectionHtml preserves code block text and spacing", () => {
  const document = buildDocument("```js\n  x\n```");
  assert.equal(
    renderSelectionHtml(document, 6, 10),
    '<div style="white-space: pre-wrap;"><pre><code>&nbsp;&nbsp;x</code></pre></div>'
  );
});
test("normalizeOrderedListNumbers renumbers an ordered list after indenting a subset of rows", () => {
  const nextText = "1. one\n    2. two\n    3. three";
  const changeStart = nextText.indexOf("    2. two");
  const normalized = normalizeOrderedListNumbers(
    nextText,
    { start: changeStart, end: nextText.length },
    { start: 0, end: nextText.length }
  );
  assert.equal(normalized.text, "1. one\n    1. two\n    2. three");
});
test("normalizeOrderedListNumbers renumbers later siblings after inserting an ordered list item", () => {
  const source = "1. one\n2. two\n3. three";
  const insertAt = source.indexOf("2. two") + "2. two".length;
  const nextText = `${source.slice(0, insertAt)}
3. ${source.slice(insertAt)}`;
  const normalized = normalizeOrderedListNumbers(
    nextText,
    { start: source.indexOf("2. two"), end: insertAt + "\n3. ".length },
    { start: insertAt + "\n3. ".length, end: insertAt + "\n3. ".length }
  );
  assert.equal(normalized.text, "1. one\n2. two\n3. \n4. three");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvcGFyc2VyLnRlc3QudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGFyc2VyLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2xpc3RzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCwgcmVuZGVyRWRpdG9yTGluZSwgcmVuZGVyU2VsZWN0aW9uSHRtbCB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BhcnNlci50cyc7XG5pbXBvcnQgeyBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9saXN0cy50cyc7XG5cbmZ1bmN0aW9uIGdldE9ubHlMaW5lKHNvdXJjZTogc3RyaW5nKSB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudChzb3VyY2UpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAxKTtcblx0cmV0dXJuIHsgZG9jdW1lbnQsIGxpbmU6IGRvY3VtZW50LmxpbmVzWzBdISB9O1xufVxuXG50ZXN0KCdidWlsZERvY3VtZW50IGtlZXBzIGFuIGVtcHR5IGRvY3VtZW50IHN0YWJsZScsICgpID0+IHtcblx0Y29uc3QgeyBkb2N1bWVudCwgbGluZSB9ID0gZ2V0T25seUxpbmUoJycpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC50ZXh0LCAnJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5ibG9ja3MubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrc1swXT8udHlwZSwgJ3BhcmFncmFwaCcpO1xuXHRhc3NlcnQuZXF1YWwobGluZS5yYXcsICcnKTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGluZSksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPjxicj48L2Rpdj4nKTtcbn0pO1xuXG50ZXN0KCdwbGFpbiB0ZXh0IGVzY2FwZXMgSFRNTCBpbiByZW5kZXJlZCBvdXRwdXQnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJzx0YWc+ICYgdGV4dCcpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKGxpbmUpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPiZsdDt0YWcmZ3Q7ICZhbXA7IHRleHQ8L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgndW5tYXRjaGVkIHN0YXIgaXMgcGFyc2VkIGFzIHBsYWluIHRleHQnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJyonKTtcblxuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmUubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChsaW5lLmlubGluZVswXSwge1xuXHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRyYW5nZTogeyBzdGFydDogMCwgZW5kOiAxIH0sXG5cdFx0dGV4dDogJyonXG5cdH0pO1xuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShsaW5lKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+KjwvZGl2PicpO1xufSk7XG5cbnRlc3QoJ3VuZmluaXNoZWQgc3Ryb25nIG1hcmtlciByZW1haW5zIHBsYWluIHRleHQgaW5zdGVhZCBvZiBoYW5naW5nJywgKCkgPT4ge1xuXHRjb25zdCB7IGxpbmUgfSA9IGdldE9ubHlMaW5lKCcqKicpO1xuXG5cdGFzc2VydC5lcXVhbChsaW5lLmlubGluZS5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGxpbmUuaW5saW5lWzBdLCB7XG5cdFx0dHlwZTogJ3RleHQnLFxuXHRcdHJhbmdlOiB7IHN0YXJ0OiAwLCBlbmQ6IDEgfSxcblx0XHR0ZXh0OiAnKidcblx0fSk7XG5cdGFzc2VydC5kZWVwRXF1YWwobGluZS5pbmxpbmVbMV0sIHtcblx0XHR0eXBlOiAndGV4dCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IDEsIGVuZDogMiB9LFxuXHRcdHRleHQ6ICcqJ1xuXHR9KTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGluZSksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPioqPC9kaXY+Jyk7XG59KTtcblxudGVzdCgnc3Ryb25nIGFuZCBzdHJvbmcgZW1waGFzaXMgcmVxdWlyZSBub24tZW1wdHkgY29udGVudCcsICgpID0+IHtcblx0Y29uc3QgZG91YmxlTWFya2VyID0gZ2V0T25seUxpbmUoJyoqKionKS5saW5lO1xuXHRjb25zdCB0cmlwbGVNYXJrZXIgPSBnZXRPbmx5TGluZSgnKioqKioqJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShkb3VibGVNYXJrZXIpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qKioqPC9kaXY+Jyk7XG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKHRyaXBsZU1hcmtlciksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPioqKioqKjwvZGl2PicpO1xufSk7XG5cbnRlc3QoJ3ZhbGlkIGVtcGhhc2lzIHN0aWxsIHJlbmRlcnMgc3ludGF4IG1hcmtlcnMgYW5kIHNlbWFudGljIHRhZ3MnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJ2EgKmIqIGMnKTtcblxuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmUubGVuZ3RoLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUuaW5saW5lWzFdPy50eXBlLCAnZW1waGFzaXMnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobGluZSksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+YSA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qPC9zcGFuPjxlbT5iPC9lbT48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qPC9zcGFuPiBjPC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3ZhbGlkIHN0cm9uZyBhbmQgc3Ryb25nIGVtcGhhc2lzIHJlbmRlciBjb3JyZWN0bHknLCAoKSA9PiB7XG5cdGNvbnN0IHN0cm9uZyA9IGdldE9ubHlMaW5lKCcqKmJvbGQqKicpLmxpbmU7XG5cdGNvbnN0IHN0cm9uZ0VtcGhhc2lzID0gZ2V0T25seUxpbmUoJyoqKmJvdGgqKionKS5saW5lO1xuXG5cdGFzc2VydC5lcXVhbChzdHJvbmcuaW5saW5lWzBdPy50eXBlLCAnc3Ryb25nJyk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKHN0cm9uZyksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+PHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+Kio8L3NwYW4+PHN0cm9uZz5ib2xkPC9zdHJvbmc+PHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+Kio8L3NwYW4+PC9kaXY+J1xuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChzdHJvbmdFbXBoYXNpcy5pbmxpbmVbMF0/LnR5cGUsICdzdHJvbmdfZW1waGFzaXMnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUoc3Ryb25nRW1waGFzaXMpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPjxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPioqKjwvc3Bhbj48c3Ryb25nPjxlbT5ib3RoPC9lbT48L3N0cm9uZz48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qKio8L3NwYW4+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ2Zvcm1hdHRpbmcgbWFya2VycyB3aXRoIGxlYWRpbmcgb3IgdHJhaWxpbmcgc3BhY2VzIGFyZSB0cmVhdGVkIGFzIHBsYWluIHRleHQnLCAoKSA9PiB7XG5cdGNvbnN0IGxlYWRpbmdTcGFjZSA9IGdldE9ubHlMaW5lKCcqIHRleHQqJykubGluZTtcblx0Y29uc3QgdHJhaWxpbmdTcGFjZSA9IGdldE9ubHlMaW5lKCcqdGV4dCAqJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShsZWFkaW5nU3BhY2UpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qIHRleHQqPC9kaXY+Jyk7XG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKHRyYWlsaW5nU3BhY2UpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qdGV4dCAqPC9kaXY+Jyk7XG59KTtcblxudGVzdCgnaGVhZGluZyBibG9ja3MgdHJhY2sgbGV2ZWwgYW5kIHJlbmRlciB3aXRoIGhlYWRpbmcgY2xhc3MnLCAoKSA9PiB7XG5cdGNvbnN0IHsgZG9jdW1lbnQsIGxpbmUgfSA9IGdldE9ubHlMaW5lKCcjIyMgVGl0bGUnKTtcblx0Y29uc3QgYmxvY2sgPSBkb2N1bWVudC5ibG9ja3NbMF07XG5cblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy50eXBlLCAnaGVhZGluZycpO1xuXHRhc3NlcnQuZXF1YWwoYmxvY2s/LmxldmVsLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUua2luZCwgJ2hlYWRpbmcnKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUuaGVhZGluZ0xldmVsLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUucHJlZml4LCAnIyMjICcpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShsaW5lKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPiMjIyBUaXRsZTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCd1bm9yZGVyZWQgbGlzdHMgcHJlc2VydmUgbmVzdGluZyBpbiBBU1QgYW5kIGxpbmUgbWV0YWRhdGEnLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICctIHBhcmVudFxcbiAgICAtIGNoaWxkXFxuLSBzaWJsaW5nJztcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KHNvdXJjZSk7XG5cdGNvbnN0IGJsb2NrID0gZG9jdW1lbnQuYmxvY2tzWzBdO1xuXG5cdGFzc2VydC5lcXVhbChibG9jaz8udHlwZSwgJ2xpc3QnKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5vcmRlcmVkLCBmYWxzZSk7XG5cdGFzc2VydC5lcXVhbChibG9jaz8uaXRlbXMubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5pdGVtc1swXT8uY2hpbGRyZW4ubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5pdGVtc1swXT8uY2hpbGRyZW5bMF0/LnR5cGUsICdsaXN0Jyk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzLmxlbmd0aCwgMyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ua2luZCwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5saXN0TGV2ZWwsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/LmtpbmQsICd1bm9yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdExldmVsLCAyKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzJdPy5raW5kLCAndW5vcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMl0/Lmxpc3RMZXZlbCwgMSk7XG59KTtcblxudGVzdCgnb3JkZXJlZCBsaXN0cyBjYXB0dXJlIGxpc3QgbnVtYmVycyBhbmQgbmVzdGVkIGluZGVudCBtZXRhZGF0YScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEyLiB0b3BcXG4gICAgMy4gbmVzdGVkJztcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KHNvdXJjZSk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ua2luZCwgJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ubGlzdE51bWJlciwgMTIpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/Lmxpc3RMZXZlbCwgMSk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ua2luZCwgJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdE51bWJlciwgMyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdExldmVsLCAyKTtcbn0pO1xuXG50ZXN0KCdsaXN0IHJlbmRlcmluZyBjb21wdXRlcyBwcmVmaXggd2lkdGggYW5kIGluZGVudCBsZXZlbCBmb3IgdW5vcmRlcmVkIGl0ZW1zJywgKCkgPT4ge1xuXHRjb25zdCB0b3BMZXZlbCA9IGdldE9ubHlMaW5lKCctIGl0ZW0nKS5saW5lO1xuXHRjb25zdCBuZXN0ZWQgPSBnZXRPbmx5TGluZSgnICAgIC0gaXRlbScpLmxpbmU7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUodG9wTGV2ZWwpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6IDA7IC0tcHJlZml4LXdpZHRoOiAyXCI+LSBpdGVtPC9kaXY+J1xuXHQpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShuZXN0ZWQpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6IDE7IC0tcHJlZml4LXdpZHRoOiAyXCI+ICAgIC0gaXRlbTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdsaXN0IHJlbmRlcmluZyBjb21wdXRlcyBwcmVmaXggd2lkdGggZm9yIG9yZGVyZWQgaXRlbXMgd2l0aCBtdWx0aS1kaWdpdCBwcmVmaXhlcycsICgpID0+IHtcblx0Y29uc3QgdG9wTGV2ZWwgPSBnZXRPbmx5TGluZSgnMTIuIGl0ZW0nKS5saW5lO1xuXHRjb25zdCBuZXN0ZWQgPSBnZXRPbmx5TGluZSgnICAgIDEyLiBpdGVtJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZSh0b3BMZXZlbCksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGxpc3RcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogMDsgLS1wcmVmaXgtd2lkdGg6IDRcIj4xMi4gaXRlbTwvZGl2Pidcblx0KTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobmVzdGVkKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAxOyAtLXByZWZpeC13aWR0aDogNFwiPiAgICAxMi4gaXRlbTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdjb2RlIGZlbmNlcyBwcm9kdWNlIGZlbmNlIGFuZCBjb250ZW50IGxpbmVzIHdpdGggY29kZSBzdHlsaW5nJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2BgYHRzXFxuY29uc3QgeCA9IDE7XFxuYGBgJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQuYmxvY2tzWzBdPy50eXBlLCAnY29kZV9ibG9jaycpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5raW5kLCAnY29kZV9mZW5jZScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/LmNvZGVCbG9ja0xhbmd1YWdlLCAndHMnKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzFdPy5raW5kLCAnY29kZV9jb250ZW50Jyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1syXT8ua2luZCwgJ2NvZGVfZmVuY2UnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUoZG9jdW1lbnQubGluZXNbMF0hKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgY29kZSBjb2RlX2ZlbmNlXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+YGBgdHM8L2Rpdj4nXG5cdCk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKGRvY3VtZW50LmxpbmVzWzFdISksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGNvZGUgY29kZV9jb250ZW50XCIgZGF0YS1saW5lLWlkPVwibGluZS0xXCI+Y29uc3QgeCA9IDE7PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3JlbmRlclNlbGVjdGlvbkh0bWwgcHJlc2VydmVzIHNlbWFudGljIG1hcmt1cCBmb3IgcGFydGlhbCBzZWxlY3Rpb25zJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2EgKmIqIGMnKTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudCwgMywgNCksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PHA+PGVtPmI8L2VtPjwvcD48L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgncmVuZGVyU2VsZWN0aW9uSHRtbCBjb3BpZXMgaGVhZGluZ3MgYXMgc2VtYW50aWMgaGVhZGluZyB0YWdzJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJyMjIFRpdGxlJyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQsIDAsIGRvY3VtZW50LnRleHQubGVuZ3RoKSxcblx0XHQnPGRpdiBzdHlsZT1cIndoaXRlLXNwYWNlOiBwcmUtd3JhcDtcIj48aDI+VGl0bGU8L2gyPjwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdyZW5kZXJTZWxlY3Rpb25IdG1sIHByZXNlcnZlcyBoZWFkaW5nIGxldmVsIGZvciBwYXJ0aWFsIGhlYWRpbmcgc2VsZWN0aW9ucycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCcjIyMjIFRpdGxlJyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQsIDUsIDcpLFxuXHRcdCc8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPjxoND5UaTwvaDQ+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3JlbmRlclNlbGVjdGlvbkh0bWwgb21pdHMgc3ludGF4IG1hcmtlcnMgZm9yIGxpc3QgY29udGVudCBzZWxlY3Rpb25zJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJy0gKml0ZW0qJyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQsIDMsIDcpLFxuXHRcdCc8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPjx1bD48bGk+PGVtPml0ZW08L2VtPjwvbGk+PC91bD48L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgncmVuZGVyU2VsZWN0aW9uSHRtbCBwcmVzZXJ2ZXMgY29kZSBibG9jayB0ZXh0IGFuZCBzcGFjaW5nJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2BgYGpzXFxuICB4XFxuYGBgJyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQsIDYsIDEwKSxcblx0XHQnPGRpdiBzdHlsZT1cIndoaXRlLXNwYWNlOiBwcmUtd3JhcDtcIj48cHJlPjxjb2RlPiZuYnNwOyZuYnNwO3g8L2NvZGU+PC9wcmU+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ25vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyByZW51bWJlcnMgYW4gb3JkZXJlZCBsaXN0IGFmdGVyIGluZGVudGluZyBhIHN1YnNldCBvZiByb3dzJywgKCkgPT4ge1xuXHRjb25zdCBuZXh0VGV4dCA9ICcxLiBvbmVcXG4gICAgMi4gdHdvXFxuICAgIDMuIHRocmVlJztcblx0Y29uc3QgY2hhbmdlU3RhcnQgPSBuZXh0VGV4dC5pbmRleE9mKCcgICAgMi4gdHdvJyk7XG5cdGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdFx0bmV4dFRleHQsXG5cdFx0eyBzdGFydDogY2hhbmdlU3RhcnQsIGVuZDogbmV4dFRleHQubGVuZ3RoIH0sXG5cdFx0eyBzdGFydDogMCwgZW5kOiBuZXh0VGV4dC5sZW5ndGggfVxuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChub3JtYWxpemVkLnRleHQsICcxLiBvbmVcXG4gICAgMS4gdHdvXFxuICAgIDIuIHRocmVlJyk7XG59KTtcblxudGVzdCgnbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzIHJlbnVtYmVycyBsYXRlciBzaWJsaW5ncyBhZnRlciBpbnNlcnRpbmcgYW4gb3JkZXJlZCBsaXN0IGl0ZW0nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IGluc2VydEF0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpICsgJzIuIHR3bycubGVuZ3RoO1xuXHRjb25zdCBuZXh0VGV4dCA9IGAke3NvdXJjZS5zbGljZSgwLCBpbnNlcnRBdCl9XFxuMy4gJHtzb3VyY2Uuc2xpY2UoaW5zZXJ0QXQpfWA7XG5cdGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdFx0bmV4dFRleHQsXG5cdFx0eyBzdGFydDogc291cmNlLmluZGV4T2YoJzIuIHR3bycpLCBlbmQ6IGluc2VydEF0ICsgJ1xcbjMuICcubGVuZ3RoIH0sXG5cdFx0eyBzdGFydDogaW5zZXJ0QXQgKyAnXFxuMy4gJy5sZW5ndGgsIGVuZDogaW5zZXJ0QXQgKyAnXFxuMy4gJy5sZW5ndGggfVxuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChub3JtYWxpemVkLnRleHQsICcxLiBvbmVcXG4yLiB0d29cXG4zLiBcXG40LiB0aHJlZScpO1xufSk7XG4iLCAiaW1wb3J0IHR5cGUge1xuXHRCbG9ja05vZGUsXG5cdENvZGVCbG9jayxcblx0Rm9ybWF0dGVkTm9kZSxcblx0SGVhZGluZ0Jsb2NrLFxuXHRJbmxpbmVOb2RlLFxuXHRMaXN0QmxvY2ssXG5cdExpc3RJdGVtQmxvY2ssXG5cdFBhcmFncmFwaEJsb2NrLFxuXHRTb3VyY2VSYW5nZSxcblx0VGV4dE5vZGVcbn0gZnJvbSAnLi9hc3QnO1xuXG5leHBvcnQgdHlwZSBMaW5lS2luZCA9XG5cdHwgJ3BhcmFncmFwaCdcblx0fCAnaGVhZGluZydcblx0fCAndW5vcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnb3JkZXJlZF9saXN0X2l0ZW0nXG5cdHwgJ2NvZGVfZmVuY2UnXG5cdHwgJ2NvZGVfY29udGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yTGluZSB7XG5cdGlkOiBzdHJpbmc7XG5cdGluZGV4OiBudW1iZXI7XG5cdHJhdzogc3RyaW5nO1xuXHRyYW5nZTogU291cmNlUmFuZ2U7XG5cdGtpbmQ6IExpbmVLaW5kO1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRoZWFkaW5nTGV2ZWw6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG5cdHByZWZpeFJhbmdlOiBTb3VyY2VSYW5nZSB8IG51bGw7XG5cdGNvbnRlbnRSYW5nZTogU291cmNlUmFuZ2U7XG5cdGlubGluZTogSW5saW5lTm9kZVtdO1xuXHRjb2RlQmxvY2tMYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JEb2N1bWVudCB7XG5cdHRleHQ6IHN0cmluZztcblx0YmxvY2tzOiBCbG9ja05vZGVbXTtcblx0bGluZXM6IEVkaXRvckxpbmVbXTtcbn1cblxuaW50ZXJmYWNlIFJhd0xpbmUge1xuXHRpbmRleDogbnVtYmVyO1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTGluZVByZWZpeEluZm8ge1xuXHRraW5kOiAncGFyYWdyYXBoJyB8ICdoZWFkaW5nJyB8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyB8ICdvcmRlcmVkX2xpc3RfaXRlbScgfCAnY29kZV9mZW5jZSc7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0bGFuZ3VhZ2U6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERvY3VtZW50KHJhd1RleHQ6IHN0cmluZyk6IEVkaXRvckRvY3VtZW50IHtcblx0Y29uc3QgdGV4dCA9IG5vcm1hbGl6ZVRleHQocmF3VGV4dCk7XG5cdGNvbnN0IHJhd0xpbmVzID0gYnVpbGRSYXdMaW5lcyh0ZXh0KTtcblx0Y29uc3QgYmxvY2tzID0gcGFyc2VCbG9ja3MocmF3TGluZXMpO1xuXHRjb25zdCBsaW5lcyA9IGRlcml2ZUxpbmVzKGJsb2Nrcyk7XG5cdHJldHVybiB7IHRleHQsIGJsb2NrcywgbGluZXMgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQocmF3VGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHJhd1RleHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJFZGl0b3JMaW5lKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRjb25zdCBwcmVmaXggPSBsaW5lLnByZWZpeFJhbmdlID8gcmVuZGVyRWRpdG9yVGV4dChsaW5lLnByZWZpeCkgOiAnJztcblx0Y29uc3QgY29udGVudCA9IGxpbmUua2luZC5zdGFydHNXaXRoKCdjb2RlXycpXG5cdFx0PyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucmF3LnNsaWNlKGxpbmUucHJlZml4Lmxlbmd0aCkpXG5cdFx0OiByZW5kZXJFZGl0b3JJbmxpbmUobGluZS5pbmxpbmUpO1xuXHRjb25zdCBib2R5ID0gcHJlZml4ICsgKGNvbnRlbnQgfHwgKGxpbmUucmF3Lmxlbmd0aCA9PT0gMCA/ICc8YnI+JyA6ICcnKSk7XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBsaW5lLmtpbmQgPT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykge1xuXHRcdGNvbnN0IHByZWZpeFdpZHRoID0gbGluZS5wcmVmaXgudHJpbVN0YXJ0KCkubGVuZ3RoO1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogJHtsaW5lLmxpc3RMZXZlbCAtIDF9OyAtLXByZWZpeC13aWR0aDogJHtwcmVmaXhXaWR0aH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdjb2RlX2ZlbmNlJyB8fCBsaW5lLmtpbmQgPT09ICdjb2RlX2NvbnRlbnQnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBjb2RlICR7bGluZS5raW5kfVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50OiBFZGl0b3JEb2N1bWVudCwgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBzdHJpbmcge1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHMgPSBkb2N1bWVudC5ibG9ja3Ncblx0XHQubWFwKChibG9jaykgPT4gcmVuZGVyQmxvY2tTZWxlY3Rpb24oZG9jdW1lbnQudGV4dCwgYmxvY2ssIHN0YXJ0LCBlbmQpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbik7XG5cblx0cmV0dXJuIGA8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPiR7cGFydHMuam9pbignJyl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMaW5lSW5kZXgobGluZXM6IEVkaXRvckxpbmVbXSwgb2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgbGluZXMubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBuZXh0U3RhcnQgPSBpbmRleCArIDEgPCBsaW5lcy5sZW5ndGggPyBsaW5lc1tpbmRleCArIDFdLnJhbmdlLnN0YXJ0IDogbGluZS5yYW5nZS5lbmQgKyAxO1xuXHRcdGlmIChvZmZzZXQgPCBuZXh0U3RhcnQpIHJldHVybiBpbmRleDtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5sZW5ndGggLSAxO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGluZVJlbmRlclNpZ25hdHVyZShsaW5lOiBFZGl0b3JMaW5lKTogc3RyaW5nIHtcblx0cmV0dXJuIFtcblx0XHRsaW5lLmtpbmQsXG5cdFx0bGluZS5yYXcsXG5cdFx0bGluZS5wcmVmaXgsXG5cdFx0bGluZS5saXN0TGV2ZWwsXG5cdFx0bGluZS5saXN0TnVtYmVyLFxuXHRcdGxpbmUuaGVhZGluZ0xldmVsLFxuXHRcdGxpbmUuY29kZUJsb2NrTGFuZ3VhZ2UgPz8gJydcblx0XS5qb2luKCdcXHUwMDAxJyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUmF3TGluZXModGV4dDogc3RyaW5nKTogUmF3TGluZVtdIHtcblx0Y29uc3Qgc3BsaXQgPSB0ZXh0LnNwbGl0KCdcXG4nKTtcblx0Y29uc3QgbGluZXM6IFJhd0xpbmVbXSA9IFtdO1xuXHRsZXQgb2Zmc2V0ID0gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3BsaXQubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IHNwbGl0W2luZGV4XTtcblx0XHRsaW5lcy5wdXNoKHtcblx0XHRcdGluZGV4LFxuXHRcdFx0dGV4dDogbGluZSxcblx0XHRcdHN0YXJ0OiBvZmZzZXQsXG5cdFx0XHRlbmQ6IG9mZnNldCArIGxpbmUubGVuZ3RoXG5cdFx0fSk7XG5cdFx0b2Zmc2V0ICs9IGxpbmUubGVuZ3RoICsgMTtcblx0fVxuXG5cdHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gcGFyc2VCbG9ja3MobGluZXM6IFJhd0xpbmVbXSk6IEJsb2NrTm9kZVtdIHtcblx0cmV0dXJuIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgMCwgMCkuYmxvY2tzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsaXN0TGV2ZWw6IG51bWJlcikge1xuXHRjb25zdCBibG9ja3M6IEJsb2NrTm9kZVtdID0gW107XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXG5cdFx0aWYgKGxpc3RMZXZlbCA+IDApIHtcblx0XHRcdGlmIChsaW5lLnRleHQudHJpbSgpID09PSAnJykgYnJlYWs7XG5cdFx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKFxuXHRcdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdFx0cHJlZml4Lmxpc3RMZXZlbCA8IGxpc3RMZXZlbFxuXHRcdFx0KSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBwcmVmaXgua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUxpc3QobGluZXMsIGluZGV4LCBwcmVmaXgubGlzdExldmVsLCBwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnaGVhZGluZycpIHtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlSGVhZGluZyhsaW5lLCBwcmVmaXgpKTtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRibG9ja3MucHVzaChwYXJzZVBhcmFncmFwaChsaW5lKSk7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7IGJsb2NrcywgbmV4dEluZGV4OiBpbmRleCB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUxpc3QobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCBvcmRlcmVkOiBib29sZWFuKSB7XG5cdGNvbnN0IGl0ZW1zOiBMaXN0SXRlbUJsb2NrW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKFxuXHRcdFx0KHByZWZpeC5raW5kICE9PSAnb3JkZXJlZF9saXN0X2l0ZW0nICYmIHByZWZpeC5raW5kICE9PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHx8XG5cdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGV2ZWwgfHxcblx0XHRcdChwcmVmaXgubGlzdExldmVsID09PSBsZXZlbCAmJiAocHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScpICE9PSBvcmRlcmVkKVxuXHRcdCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5saXN0TGV2ZWwgPiBsZXZlbCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaXRlbVN0YXJ0ID0gbGluZS5zdGFydDtcblx0XHRjb25zdCBpdGVtUHJlZml4TGVuZ3RoID0gcHJlZml4LnByZWZpeC5sZW5ndGg7XG5cdFx0Y29uc3QgaXRlbTogTGlzdEl0ZW1CbG9jayA9IHtcblx0XHRcdHR5cGU6ICdsaXN0X2l0ZW0nLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0bGluZVJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsZXZlbCxcblx0XHRcdG9yZGVyZWQsXG5cdFx0XHRudW1iZXI6IHByZWZpeC5saXN0TnVtYmVyLFxuXHRcdFx0cHJlZml4OiBwcmVmaXgucHJlZml4LFxuXHRcdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShpdGVtUHJlZml4TGVuZ3RoKSwgbGluZS5zdGFydCArIGl0ZW1QcmVmaXhMZW5ndGgpLFxuXHRcdFx0Y2hpbGRyZW46IFtdXG5cdFx0fTtcblxuXHRcdGluZGV4ICs9IDE7XG5cdFx0Y29uc3QgY2hpbGRQYXJzZWQgPSBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXMsIGluZGV4LCBsZXZlbCArIDEpO1xuXHRcdGl0ZW0uY2hpbGRyZW4gPSBjaGlsZFBhcnNlZC5ibG9ja3M7XG5cdFx0Y29uc3QgY2hpbGRFbmQgPVxuXHRcdFx0aXRlbS5jaGlsZHJlbi5sZW5ndGggPiAwID8gaXRlbS5jaGlsZHJlbltpdGVtLmNoaWxkcmVuLmxlbmd0aCAtIDFdLnJhbmdlLmVuZCA6IGl0ZW0ucmFuZ2UuZW5kO1xuXHRcdGl0ZW0ucmFuZ2UgPSB7IHN0YXJ0OiBpdGVtU3RhcnQsIGVuZDogY2hpbGRFbmQgfTtcblx0XHRpdGVtcy5wdXNoKGl0ZW0pO1xuXHRcdGluZGV4ID0gY2hpbGRQYXJzZWQubmV4dEluZGV4O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRibG9jazoge1xuXHRcdFx0dHlwZTogJ2xpc3QnLFxuXHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0c3RhcnQ6IGl0ZW1zWzBdPy5yYW5nZS5zdGFydCA/PyBsaW5lc1tzdGFydEluZGV4XS5zdGFydCxcblx0XHRcdFx0ZW5kOiBpdGVtc1tpdGVtcy5sZW5ndGggLSAxXT8ucmFuZ2UuZW5kID8/IGxpbmVzW3N0YXJ0SW5kZXhdLmVuZFxuXHRcdFx0fSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdGl0ZW1zXG5cdFx0fSBzYXRpc2ZpZXMgTGlzdEJsb2NrLFxuXHRcdG5leHRJbmRleDogaW5kZXhcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb2RlQmxvY2sobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyKSB7XG5cdGNvbnN0IG9wZW5MaW5lID0gbGluZXNbc3RhcnRJbmRleF07XG5cdGNvbnN0IG9wZW5QcmVmaXggPSBwYXJzZVByZWZpeChvcGVuTGluZS50ZXh0KTtcblx0Y29uc3QgY29udGVudExpbmVzOiBDb2RlQmxvY2tbJ2xpbmVzJ10gPSBbXTtcblx0bGV0IGNsb3NlRmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRsZXQgZW5kID0gb3BlbkxpbmUuZW5kO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4ICsgMTtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNsb3NlRmVuY2UgPSBwcmVmaXgucHJlZml4O1xuXHRcdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29udGVudExpbmVzLnB1c2goe1xuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdHRleHQ6IGxpbmUudGV4dFxuXHRcdH0pO1xuXHRcdGVuZCA9IGxpbmUuZW5kO1xuXHRcdGluZGV4ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnY29kZV9ibG9jaycsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogb3BlbkxpbmUuc3RhcnQsIGVuZCB9LFxuXHRcdFx0bGFuZ3VhZ2U6IG9wZW5QcmVmaXgubGFuZ3VhZ2UsXG5cdFx0XHRvcGVuRmVuY2U6IG9wZW5QcmVmaXgucHJlZml4LFxuXHRcdFx0Y2xvc2VGZW5jZSxcblx0XHRcdGxpbmVzOiBjb250ZW50TGluZXNcblx0XHR9IHNhdGlzZmllcyBDb2RlQmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUhlYWRpbmcobGluZTogUmF3TGluZSwgcHJlZml4OiBMaW5lUHJlZml4SW5mbyk6IEhlYWRpbmdCbG9jayB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IGxpbmUuc3RhcnQgKyBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAnaGVhZGluZycsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRsZXZlbDogcHJlZml4LmhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQuc2xpY2UocHJlZml4LnByZWZpeC5sZW5ndGgpLCBjb250ZW50U3RhcnQpXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFyYWdyYXBoKGxpbmU6IFJhd0xpbmUpOiBQYXJhZ3JhcGhCbG9jayB7XG5cdHJldHVybiB7XG5cdFx0dHlwZTogJ3BhcmFncmFwaCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dCwgbGluZS5zdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gZGVyaXZlTGluZXMoYmxvY2tzOiBCbG9ja05vZGVbXSk6IEVkaXRvckxpbmVbXSB7XG5cdGNvbnN0IGxpbmVzOiBFZGl0b3JMaW5lW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGFwcGVuZEJsb2NrTGluZXMoYmxvY2ssIGxpbmVzKTtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5tYXAoKGxpbmUsIGluZGV4KSA9PiAoe1xuXHRcdC4uLmxpbmUsXG5cdFx0aWQ6IGBsaW5lLSR7aW5kZXh9YCxcblx0XHRpbmRleFxuXHR9KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZEJsb2NrTGluZXMoYmxvY2s6IEJsb2NrTm9kZSwgbGluZXM6IEVkaXRvckxpbmVbXSkge1xuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRsaW5lcy5wdXNoKGNyZWF0ZUJhc2VMaW5lKGJsb2NrLnJhdywgYmxvY2sucmFuZ2UsICdwYXJhZ3JhcGgnLCAnJywgbnVsbCwgYmxvY2suaW5saW5lKSk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sucmF3LFxuXHRcdFx0XHRibG9jay5yYW5nZSxcblx0XHRcdFx0J2hlYWRpbmcnLFxuXHRcdFx0XHRibG9jay5wcmVmaXgsXG5cdFx0XHRcdG51bGwsXG5cdFx0XHRcdGJsb2NrLmlubGluZSxcblx0XHRcdFx0MCxcblx0XHRcdFx0MCxcblx0XHRcdFx0YmxvY2subGV2ZWxcblx0XHRcdClcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnY29kZV9ibG9jaycpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSArIChibG9jay5sYW5ndWFnZSA/IGJsb2NrLmxhbmd1YWdlIDogJycpLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c3RhcnQ6IGJsb2NrLnJhbmdlLnN0YXJ0LFxuXHRcdFx0XHRcdGVuZDogYmxvY2sucmFuZ2Uuc3RhcnQgKyBibG9jay5vcGVuRmVuY2UubGVuZ3RoICsgKGJsb2NrLmxhbmd1YWdlPy5sZW5ndGggPz8gMClcblx0XHRcdFx0fSxcblx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRibG9jay5vcGVuRmVuY2UsXG5cdFx0XHRcdGJsb2NrLmxhbmd1YWdlLFxuXHRcdFx0XHRbXVxuXHRcdFx0KVxuXHRcdCk7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUobGluZS50ZXh0LCBsaW5lLnJhbmdlLCAnY29kZV9jb250ZW50JywgJycsIGJsb2NrLmxhbmd1YWdlLCBbXSkpO1xuXHRcdH1cblxuXHRcdGlmIChibG9jay5jbG9zZUZlbmNlKSB7XG5cdFx0XHRjb25zdCBjbG9zZVN0YXJ0ID0gYmxvY2sucmFuZ2UuZW5kIC0gYmxvY2suY2xvc2VGZW5jZS5sZW5ndGg7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRibG9jay5jbG9zZUZlbmNlLFxuXHRcdFx0XHRcdHsgc3RhcnQ6IGNsb3NlU3RhcnQsIGVuZDogYmxvY2sucmFuZ2UuZW5kIH0sXG5cdFx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFx0W11cblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHR9XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdFx0aXRlbS5yYXcsXG5cdFx0XHRcdFx0aXRlbS5saW5lUmFuZ2UsXG5cdFx0XHRcdFx0aXRlbS5vcmRlcmVkID8gJ29yZGVyZWRfbGlzdF9pdGVtJyA6ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdFx0XHRpdGVtLnByZWZpeCxcblx0XHRcdFx0XHRudWxsLFxuXHRcdFx0XHRcdGl0ZW0uaW5saW5lLFxuXHRcdFx0XHRcdGl0ZW0ubGV2ZWwsXG5cdFx0XHRcdFx0aXRlbS5udW1iZXJcblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHRcdGZvciAoY29uc3QgY2hpbGQgb2YgaXRlbS5jaGlsZHJlbikge1xuXHRcdFx0XHRhcHBlbmRCbG9ja0xpbmVzKGNoaWxkLCBsaW5lcyk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhc2VMaW5lKFxuXHRyYXc6IHN0cmluZyxcblx0cmFuZ2U6IFNvdXJjZVJhbmdlLFxuXHRraW5kOiBMaW5lS2luZCxcblx0cHJlZml4OiBzdHJpbmcsXG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0bGlzdExldmVsID0gMCxcblx0bGlzdE51bWJlciA9IDAsXG5cdGhlYWRpbmdMZXZlbCA9IDBcbik6IEVkaXRvckxpbmUge1xuXHRjb25zdCBjb250ZW50U3RhcnQgPSByYW5nZS5zdGFydCArIHByZWZpeC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0aWQ6ICcnLFxuXHRcdGluZGV4OiAwLFxuXHRcdHJhdyxcblx0XHRyYW5nZSxcblx0XHRraW5kLFxuXHRcdGxpc3RMZXZlbCxcblx0XHRsaXN0TnVtYmVyLFxuXHRcdGhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXgsXG5cdFx0cHJlZml4UmFuZ2U6IHByZWZpeC5sZW5ndGggPiAwID8geyBzdGFydDogcmFuZ2Uuc3RhcnQsIGVuZDogY29udGVudFN0YXJ0IH0gOiBudWxsLFxuXHRcdGNvbnRlbnRSYW5nZTogeyBzdGFydDogY29udGVudFN0YXJ0LCBlbmQ6IHJhbmdlLmVuZCB9LFxuXHRcdGlubGluZSxcblx0XHRjb2RlQmxvY2tMYW5ndWFnZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVByZWZpeChyYXc6IHN0cmluZyk6IExpbmVQcmVmaXhJbmZvIHtcblx0Y29uc3QgY29kZUZlbmNlTWF0Y2ggPSByYXcubWF0Y2goL15gYGAoW0EtWmEtejAtOV8tXSspP1xccyokLyk7XG5cdGlmIChjb2RlRmVuY2VNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnY29kZV9mZW5jZScsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiAnYGBgJyxcblx0XHRcdGxhbmd1YWdlOiBjb2RlRmVuY2VNYXRjaFsxXSA/PyBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IHVub3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKiktIC8pO1xuXHRpZiAodW5vcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiB1bm9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3Qgb3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ29yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdGxpc3RMZXZlbDogb3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBoZWFkaW5nTWF0Y2ggPSByYXcubWF0Y2goL14oI3sxLDZ9KVxccysvKTtcblx0aWYgKGhlYWRpbmdNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnaGVhZGluZycsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiBoZWFkaW5nTWF0Y2hbMV0ubGVuZ3RoLFxuXHRcdFx0cHJlZml4OiBoZWFkaW5nTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGtpbmQ6ICdwYXJhZ3JhcGgnLFxuXHRcdGxpc3RMZXZlbDogMCxcblx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRwcmVmaXg6ICcnLFxuXHRcdGxhbmd1YWdlOiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSW5saW5lKHJhdzogc3RyaW5nLCBzdGFydE9mZnNldDogbnVtYmVyKTogSW5saW5lTm9kZVtdIHtcblx0Y29uc3QgaW5saW5lOiBJbmxpbmVOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gMDtcblxuXHR3aGlsZSAoaW5kZXggPCByYXcubGVuZ3RoKSB7XG5cdFx0Y29uc3QgZm9ybWF0dGVkTm9kZSA9IHBhcnNlRm9ybWF0dGVkTm9kZShyYXcsIHN0YXJ0T2Zmc2V0LCBpbmRleCk7XG5cdFx0aWYgKGZvcm1hdHRlZE5vZGUpIHtcblx0XHRcdGlubGluZS5wdXNoKGZvcm1hdHRlZE5vZGUubm9kZSk7XG5cdFx0XHRpbmRleCA9IGZvcm1hdHRlZE5vZGUubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0bGV0IG5leHRNYXJrZXIgPSByYXcubGVuZ3RoO1xuXHRcdGNvbnN0IHN0YXJJbmRleCA9IHJhdy5pbmRleE9mKCcqJywgaW5kZXgpO1xuXHRcdGlmIChzdGFySW5kZXggIT09IC0xKSBuZXh0TWFya2VyID0gc3RhckluZGV4O1xuXG5cdFx0aWYgKG5leHRNYXJrZXIgPT09IGluZGV4KSB7XG5cdFx0XHRpbmxpbmUucHVzaCh7XG5cdFx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBpbmRleCArIDEgfSxcblx0XHRcdFx0dGV4dDogcmF3W2luZGV4XVxuXHRcdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHQgPSByYXcuc2xpY2UoaW5kZXgsIG5leHRNYXJrZXIpO1xuXHRcdGlubGluZS5wdXNoKHtcblx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LCBlbmQ6IHN0YXJ0T2Zmc2V0ICsgbmV4dE1hcmtlciB9LFxuXHRcdFx0dGV4dFxuXHRcdH0gc2F0aXNmaWVzIFRleHROb2RlKTtcblx0XHRpbmRleCA9IG5leHRNYXJrZXI7XG5cdH1cblxuXHRyZXR1cm4gaW5saW5lO1xufVxuXG5mdW5jdGlvbiBwYXJzZUZvcm1hdHRlZE5vZGUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIsIGluZGV4OiBudW1iZXIpIHtcblx0Zm9yIChjb25zdCBtYXJrZXIgb2YgWycqKionLCAnKionLCAnKiddIGFzIGNvbnN0KSB7XG5cdFx0aWYgKCFyYXcuc3RhcnRzV2l0aChtYXJrZXIsIGluZGV4KSkgY29udGludWU7XG5cblx0XHRjb25zdCBjbG9zZSA9IHJhdy5pbmRleE9mKG1hcmtlciwgaW5kZXggKyBtYXJrZXIubGVuZ3RoKTtcblx0XHRpZiAoY2xvc2UgPT09IC0xKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNvbnRlbnRTdGFydCA9IGluZGV4ICsgbWFya2VyLmxlbmd0aDtcblx0XHRjb25zdCBjb250ZW50RW5kID0gY2xvc2U7XG5cdFx0aWYgKGNvbnRlbnRTdGFydCA+PSBjb250ZW50RW5kKSBjb250aW51ZTtcblx0XHRpZiAocmF3W2NvbnRlbnRTdGFydF0gPT09ICcgJyB8fCByYXdbY29udGVudEVuZCAtIDFdID09PSAnICcpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgdHlwZSA9IG1hcmtlciA9PT0gJyoqKicgPyAnc3Ryb25nX2VtcGhhc2lzJyA6IG1hcmtlciA9PT0gJyoqJyA/ICdzdHJvbmcnIDogJ2VtcGhhc2lzJztcblxuXHRcdHJldHVybiB7XG5cdFx0XHRub2RlOiB7XG5cdFx0XHRcdHR5cGUsXG5cdFx0XHRcdHJhbmdlOiB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNsb3NlICsgbWFya2VyLmxlbmd0aFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRjb250ZW50UmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBjb250ZW50U3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNvbnRlbnRFbmRcblx0XHRcdFx0fSxcblx0XHRcdFx0bWFya2VyLFxuXHRcdFx0XHR0ZXh0OiByYXcuc2xpY2UoY29udGVudFN0YXJ0LCBjb250ZW50RW5kKVxuXHRcdFx0fSBzYXRpc2ZpZXMgRm9ybWF0dGVkTm9kZSxcblx0XHRcdG5leHRJbmRleDogY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JJbmxpbmUoaW5saW5lOiBJbmxpbmVOb2RlW10pOiBzdHJpbmcge1xuXHRyZXR1cm4gaW5saW5lXG5cdFx0Lm1hcCgobm9kZSkgPT4ge1xuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRcdHJldHVybiByZW5kZXJFZGl0b3JUZXh0KG5vZGUudGV4dCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG1hcmtlciA9IGA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4ke2VzY2FwZUh0bWwobm9kZS5tYXJrZXIpfTwvc3Bhbj5gO1xuXHRcdFx0Y29uc3QgY29udGVudCA9IGVzY2FwZUh0bWwobm9kZS50ZXh0KTtcblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2VtcGhhc2lzJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxlbT4ke2NvbnRlbnR9PC9lbT4ke21hcmtlcn1gO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxzdHJvbmc+JHtjb250ZW50fTwvc3Ryb25nPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz48ZW0+JHtjb250ZW50fTwvZW0+PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHR9KVxuXHRcdC5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQmxvY2tTZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0YmxvY2s6IEJsb2NrTm9kZSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gYmxvY2sucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gYmxvY2sucmFuZ2UuZW5kKSByZXR1cm4gJyc7XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdwYXJhZ3JhcGgnKSB7XG5cdFx0cmV0dXJuIGA8cD4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvcD5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGNvbnN0IHRhZyA9IGBoJHtibG9jay5sZXZlbH1gO1xuXHRcdHJldHVybiBgPCR7dGFnfT4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvJHt0YWd9PmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2NvZGVfYmxvY2snKSB7XG5cdFx0Y29uc3QgY29kZVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0aWYgKGVuZCA8PSBsaW5lLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGxpbmUucmFuZ2UuZW5kKSBjb250aW51ZTtcblx0XHRcdGNvZGVQYXJ0cy5wdXNoKGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQoc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBsaW5lLnJhbmdlLCBzdGFydCwgZW5kKSkpO1xuXHRcdH1cblx0XHRyZXR1cm4gYDxwcmU+PGNvZGU+JHtjb2RlUGFydHMuam9pbignXFxuJyl9PC9jb2RlPjwvcHJlPmA7XG5cdH1cblxuXHRjb25zdCB0YWcgPSBibG9jay5vcmRlcmVkID8gJ29sJyA6ICd1bCc7XG5cdGNvbnN0IGl0ZW1zID0gYmxvY2suaXRlbXNcblx0XHQubWFwKChpdGVtKSA9PiByZW5kZXJMaXN0SXRlbVNlbGVjdGlvbihzb3VyY2VUZXh0LCBpdGVtLCBzdGFydCwgZW5kKSlcblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oJycpO1xuXHRyZXR1cm4gaXRlbXMgPyBgPCR7dGFnfT4ke2l0ZW1zfTwvJHt0YWd9PmAgOiAnJztcbn1cblxuZnVuY3Rpb24gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0aXRlbTogTGlzdEl0ZW1CbG9jayxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gaXRlbS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBpdGVtLnJhbmdlLmVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBpdGVtSW5saW5lID0gcmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbS5pbmxpbmUsIHN0YXJ0LCBlbmQpO1xuXHRwYXJ0cy5wdXNoKGl0ZW1JbmxpbmUgfHwgJzxicj4nKTtcblxuXHRmb3IgKGNvbnN0IGNoaWxkIG9mIGl0ZW0uY2hpbGRyZW4pIHtcblx0XHRjb25zdCBjaGlsZEh0bWwgPSByZW5kZXJCbG9ja1NlbGVjdGlvbihzb3VyY2VUZXh0LCBjaGlsZCwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKGNoaWxkSHRtbCkgcGFydHMucHVzaChjaGlsZEh0bWwpO1xuXHR9XG5cblx0cmV0dXJuIGA8bGk+JHtwYXJ0cy5qb2luKCcnKX08L2xpPmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3Qgbm9kZSBvZiBpbmxpbmUpIHtcblx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdGNvbnN0IHNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLnJhbmdlLCBzdGFydCwgZW5kKTtcblx0XHRcdGlmIChzbGljZSkgcGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlKSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBpbm5lclNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLmNvbnRlbnRSYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKCFpbm5lclNsaWNlKSBjb250aW51ZTtcblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdlbXBoYXNpcycpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L3N0cm9uZz5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHBhcnRzLnB1c2goYDxzdHJvbmc+PGVtPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2VtPjwvc3Ryb25nPmApO1xuXHR9XG5cblx0cmV0dXJuIHBhcnRzLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBzbGljZVJhbmdlKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdHJhbmdlOiBTb3VyY2VSYW5nZSxcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcixcblx0c2VsZWN0aW9uRW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgocmFuZ2Uuc3RhcnQsIHNlbGVjdGlvblN0YXJ0KTtcblx0Y29uc3QgZW5kID0gTWF0aC5taW4ocmFuZ2UuZW5kLCBzZWxlY3Rpb25FbmQpO1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cdHJldHVybiBzb3VyY2VUZXh0LnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0Lmxlbmd0aCA9PT0gMCA/ICcnIDogZXNjYXBlSHRtbCh0ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7Jyk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGVzY2FwZUh0bWwodGV4dCkucmVwbGFjZSgvIC9nLCAnJm5ic3A7JykucmVwbGFjZSgvXFx0L2csICcmbmJzcDsmbmJzcDsmbmJzcDsmbmJzcDsnKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IEJsb2NrTm9kZSwgTGlzdEJsb2NrIH0gZnJvbSAnLi9hc3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCB9IGZyb20gJy4vcGFyc2VyJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0aW9uUmFuZ2UsIFRleHRDaGFuZ2UgfSBmcm9tICcuL3RleHQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIExpc3RNZXRhZGF0YSB7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRvcmRlcmVkOiBib29sZWFuO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVGV4dFJlcGxhY2VtZW50IHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpc3RNZXRhZGF0YShsaW5lVGV4dDogc3RyaW5nKTogTGlzdE1ldGFkYXRhIHtcblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXigoPzogezR9KSopLSAvKTtcblx0aWYgKHVub3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGxpc3RMZXZlbDogdW5vcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiBmYWxzZSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IG9yZGVyZWRNYXRjaCA9IGxpbmVUZXh0Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiB0cnVlLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF1cblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0b3JkZXJlZDogZmFsc2UsXG5cdFx0bGlzdE51bWJlcjogMCxcblx0XHRwcmVmaXg6ICcnXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdHRleHQ6IHN0cmluZyxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2Vcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQodGV4dCk7XG5cdGNvbnN0IHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W10gPSBbXTtcblxuXHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoZG9jdW1lbnQuYmxvY2tzLCBhZmZlY3RlZFJhbmdlLCByZXBsYWNlbWVudHMpO1xuXG5cdGlmIChyZXBsYWNlbWVudHMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogc2VsZWN0aW9uLnN0YXJ0LFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fTtcblx0fVxuXG5cdHJlcGxhY2VtZW50cy5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuc3RhcnQgLSBsZWZ0LnN0YXJ0KTtcblxuXHRsZXQgbmV4dFRleHQgPSB0ZXh0O1xuXHRsZXQgc2VsZWN0aW9uU3RhcnQgPSBzZWxlY3Rpb24uc3RhcnQ7XG5cdGxldCBzZWxlY3Rpb25FbmQgPSBzZWxlY3Rpb24uZW5kO1xuXG5cdGZvciAoY29uc3QgcmVwbGFjZW1lbnQgb2YgcmVwbGFjZW1lbnRzKSB7XG5cdFx0Y29uc3QgcmVwbGFjZWRMZW5ndGggPSByZXBsYWNlbWVudC5lbmQgLSByZXBsYWNlbWVudC5zdGFydDtcblx0XHRjb25zdCBkZWx0YSA9IHJlcGxhY2VtZW50LnRleHQubGVuZ3RoIC0gcmVwbGFjZWRMZW5ndGg7XG5cdFx0bmV4dFRleHQgPVxuXHRcdFx0bmV4dFRleHQuc2xpY2UoMCwgcmVwbGFjZW1lbnQuc3RhcnQpICsgcmVwbGFjZW1lbnQudGV4dCArIG5leHRUZXh0LnNsaWNlKHJlcGxhY2VtZW50LmVuZCk7XG5cdFx0c2VsZWN0aW9uU3RhcnQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuc3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5lbmQsXG5cdFx0XHRyZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCxcblx0XHRcdGRlbHRhXG5cdFx0KTtcblx0XHRzZWxlY3Rpb25FbmQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvbkVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuZW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQudGV4dC5sZW5ndGgsXG5cdFx0XHRkZWx0YVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrczogQmxvY2tOb2RlW10sXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pIHtcblx0Zm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gJ2xpc3QnKSB7XG5cdFx0XHRjb2xsZWN0TGlzdFJlcGxhY2VtZW50cyhibG9jaywgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0XHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoaXRlbS5jaGlsZHJlbiwgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrOiBMaXN0QmxvY2ssXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pIHtcblx0aWYgKCFibG9jay5vcmRlcmVkIHx8ICFyYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGJsb2NrLml0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IGl0ZW0gPSBibG9jay5pdGVtc1tpbmRleF0hO1xuXHRcdGNvbnN0IGV4cGVjdGVkTnVtYmVyID0gaW5kZXggKyAxO1xuXHRcdGlmIChpdGVtLm51bWJlciA9PT0gZXhwZWN0ZWROdW1iZXIpIGNvbnRpbnVlO1xuXG5cdFx0cmVwbGFjZW1lbnRzLnB1c2goe1xuXHRcdFx0c3RhcnQ6IGl0ZW0ubGluZVJhbmdlLnN0YXJ0LFxuXHRcdFx0ZW5kOiBpdGVtLmxpbmVSYW5nZS5zdGFydCArIGl0ZW0ucHJlZml4Lmxlbmd0aCxcblx0XHRcdHRleHQ6IGAkeycgICAgJy5yZXBlYXQoaXRlbS5sZXZlbCAtIDEpfSR7ZXhwZWN0ZWROdW1iZXJ9LiBgXG5cdFx0fSk7XG5cdH1cbn1cblxuZnVuY3Rpb24gcmFuZ2VzSW50ZXJzZWN0KGxlZnQ6IFNlbGVjdGlvblJhbmdlLCByaWdodDogU2VsZWN0aW9uUmFuZ2UpIHtcblx0cmV0dXJuIGxlZnQuc3RhcnQgPD0gcmlnaHQuZW5kICYmIHJpZ2h0LnN0YXJ0IDw9IGxlZnQuZW5kO1xufVxuXG5mdW5jdGlvbiBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0cG9pbnQ6IG51bWJlcixcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXIsXG5cdHJlcGxhY2VtZW50TGVuZ3RoOiBudW1iZXIsXG5cdGRlbHRhOiBudW1iZXJcbikge1xuXHRpZiAocG9pbnQgPiBlbmQpIHtcblx0XHRyZXR1cm4gcG9pbnQgKyBkZWx0YTtcblx0fVxuXG5cdGlmIChwb2ludCA+PSBzdGFydCkge1xuXHRcdHJldHVybiBzdGFydCArIE1hdGgubWluKHBvaW50IC0gc3RhcnQsIHJlcGxhY2VtZW50TGVuZ3RoKTtcblx0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
