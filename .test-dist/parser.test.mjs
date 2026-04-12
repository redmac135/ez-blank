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
  return rawText.replace(/\r\n?/g, "\n");
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
    const backtickIndex = raw.indexOf("`", index);
    if (backtickIndex !== -1) nextMarker = Math.min(nextMarker, backtickIndex);
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
  for (const marker of ["`", "***", "**", "*"]) {
    if (!raw.startsWith(marker, index)) continue;
    const close = raw.indexOf(marker, index + marker.length);
    if (close === -1) continue;
    const contentStart = index + marker.length;
    const contentEnd = close;
    if (contentStart >= contentEnd) continue;
    if (marker !== "`" && (raw[contentStart] === " " || raw[contentEnd - 1] === " ")) continue;
    const type = marker === "`" ? "code" : marker === "***" ? "strong_emphasis" : marker === "**" ? "strong" : "emphasis";
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
    const content = escapeHtml(node.text);
    if (node.type === "code") {
      const marker2 = `<span class="syntax-marker code-marker">${escapeHtml(node.marker)}</span>`;
      return `<code class="inline-code">${marker2}${content}${marker2}</code>`;
    }
    const marker = `<span class="syntax-marker">${escapeHtml(node.marker)}</span>`;
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
    if (node.type === "code") {
      parts.push(`<code>${escapeHtmlForClipboard(innerSlice)}</code>`);
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
  let foundAffectedBlock = false;
  for (const block of blocks) {
    let blockAffected = rangesIntersect(block.range, affectedRange);
    if (block.type === "list") {
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
function normalizeSiblingOrderedChildLists(blocks, affectedRange, replacements) {
  for (const block of blocks) {
    if (block.type !== "list" || !block.ordered || rangesIntersect(block.range, affectedRange)) {
      continue;
    }
    collectListReplacements(block, block.range, replacements);
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
test("buildDocument normalizes CRLF and CR line endings to LF", () => {
  const document = buildDocument("alpha\r\nbeta\rgamma");
  assert.equal(document.text, "alpha\nbeta\ngamma");
  assert.equal(document.lines.length, 3);
  assert.equal(document.lines[0]?.raw, "alpha");
  assert.equal(document.lines[1]?.raw, "beta");
  assert.equal(document.lines[2]?.raw, "gamma");
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
test("inline code renders syntax markers and code styling", () => {
  const { line } = getOnlyLine("use `value` here");
  assert.equal(line.inline[1]?.type, "code");
  assert.equal(
    renderEditorLine(line),
    '<div class="line" data-line-id="line-0">use <code class="inline-code"><span class="syntax-marker code-marker">`</span>value<span class="syntax-marker code-marker">`</span></code> here</div>'
  );
});
test("unclosed inline code marker remains plain text", () => {
  const { line } = getOnlyLine("use `value here");
  assert.equal(
    renderEditorLine(line),
    '<div class="line" data-line-id="line-0">use `value here</div>'
  );
});
test("inline code allows leading and trailing spaces inside backticks", () => {
  const { line } = getOnlyLine("use ` value ` here");
  assert.equal(line.inline[1]?.type, "code");
  assert.equal(line.inline[1]?.text, " value ");
  assert.equal(
    renderEditorLine(line),
    '<div class="line" data-line-id="line-0">use <code class="inline-code"><span class="syntax-marker code-marker">`</span> value <span class="syntax-marker code-marker">`</span></code> here</div>'
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
test("renderSelectionHtml preserves inline code semantics", () => {
  const document = buildDocument("use `value` here");
  const start = document.text.indexOf("value");
  const end = start + "value".length;
  assert.equal(
    renderSelectionHtml(document, start, end),
    '<div style="white-space: pre-wrap;"><p><code>value</code></p></div>'
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvcGFyc2VyLnRlc3QudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGFyc2VyLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2xpc3RzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCwgcmVuZGVyRWRpdG9yTGluZSwgcmVuZGVyU2VsZWN0aW9uSHRtbCB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BhcnNlci50cyc7XG5pbXBvcnQgeyBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9saXN0cy50cyc7XG5cbmZ1bmN0aW9uIGdldE9ubHlMaW5lKHNvdXJjZTogc3RyaW5nKSB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudChzb3VyY2UpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAxKTtcblx0cmV0dXJuIHsgZG9jdW1lbnQsIGxpbmU6IGRvY3VtZW50LmxpbmVzWzBdISB9O1xufVxuXG50ZXN0KCdidWlsZERvY3VtZW50IGtlZXBzIGFuIGVtcHR5IGRvY3VtZW50IHN0YWJsZScsICgpID0+IHtcblx0Y29uc3QgeyBkb2N1bWVudCwgbGluZSB9ID0gZ2V0T25seUxpbmUoJycpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC50ZXh0LCAnJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5ibG9ja3MubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrc1swXT8udHlwZSwgJ3BhcmFncmFwaCcpO1xuXHRhc3NlcnQuZXF1YWwobGluZS5yYXcsICcnKTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGluZSksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPjxicj48L2Rpdj4nKTtcbn0pO1xuXG50ZXN0KCdidWlsZERvY3VtZW50IG5vcm1hbGl6ZXMgQ1JMRiBhbmQgQ1IgbGluZSBlbmRpbmdzIHRvIExGJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2FscGhhXFxyXFxuYmV0YVxccmdhbW1hJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LnRleHQsICdhbHBoYVxcbmJldGFcXG5nYW1tYScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5yYXcsICdhbHBoYScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/LnJhdywgJ2JldGEnKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzJdPy5yYXcsICdnYW1tYScpO1xufSk7XG5cbnRlc3QoJ3BsYWluIHRleHQgZXNjYXBlcyBIVE1MIGluIHJlbmRlcmVkIG91dHB1dCcsICgpID0+IHtcblx0Y29uc3QgeyBsaW5lIH0gPSBnZXRPbmx5TGluZSgnPHRhZz4gJiB0ZXh0Jyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobGluZSksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+Jmx0O3RhZyZndDsgJmFtcDsgdGV4dDwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCd1bm1hdGNoZWQgc3RhciBpcyBwYXJzZWQgYXMgcGxhaW4gdGV4dCcsICgpID0+IHtcblx0Y29uc3QgeyBsaW5lIH0gPSBnZXRPbmx5TGluZSgnKicpO1xuXG5cdGFzc2VydC5lcXVhbChsaW5lLmlubGluZS5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGxpbmUuaW5saW5lWzBdLCB7XG5cdFx0dHlwZTogJ3RleHQnLFxuXHRcdHJhbmdlOiB7IHN0YXJ0OiAwLCBlbmQ6IDEgfSxcblx0XHR0ZXh0OiAnKidcblx0fSk7XG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKGxpbmUpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qPC9kaXY+Jyk7XG59KTtcblxudGVzdCgndW5maW5pc2hlZCBzdHJvbmcgbWFya2VyIHJlbWFpbnMgcGxhaW4gdGV4dCBpbnN0ZWFkIG9mIGhhbmdpbmcnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJyoqJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGxpbmUuaW5saW5lLmxlbmd0aCwgMik7XG5cdGFzc2VydC5kZWVwRXF1YWwobGluZS5pbmxpbmVbMF0sIHtcblx0XHR0eXBlOiAndGV4dCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IDAsIGVuZDogMSB9LFxuXHRcdHRleHQ6ICcqJ1xuXHR9KTtcblx0YXNzZXJ0LmRlZXBFcXVhbChsaW5lLmlubGluZVsxXSwge1xuXHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRyYW5nZTogeyBzdGFydDogMSwgZW5kOiAyIH0sXG5cdFx0dGV4dDogJyonXG5cdH0pO1xuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShsaW5lKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+Kio8L2Rpdj4nKTtcbn0pO1xuXG50ZXN0KCdzdHJvbmcgYW5kIHN0cm9uZyBlbXBoYXNpcyByZXF1aXJlIG5vbi1lbXB0eSBjb250ZW50JywgKCkgPT4ge1xuXHRjb25zdCBkb3VibGVNYXJrZXIgPSBnZXRPbmx5TGluZSgnKioqKicpLmxpbmU7XG5cdGNvbnN0IHRyaXBsZU1hcmtlciA9IGdldE9ubHlMaW5lKCcqKioqKionKS5saW5lO1xuXG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKGRvdWJsZU1hcmtlciksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPioqKio8L2Rpdj4nKTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUodHJpcGxlTWFya2VyKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+KioqKioqPC9kaXY+Jyk7XG59KTtcblxudGVzdCgndmFsaWQgZW1waGFzaXMgc3RpbGwgcmVuZGVycyBzeW50YXggbWFya2VycyBhbmQgc2VtYW50aWMgdGFncycsICgpID0+IHtcblx0Y29uc3QgeyBsaW5lIH0gPSBnZXRPbmx5TGluZSgnYSAqYiogYycpO1xuXG5cdGFzc2VydC5lcXVhbChsaW5lLmlubGluZS5sZW5ndGgsIDMpO1xuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmVbMV0/LnR5cGUsICdlbXBoYXNpcycpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShsaW5lKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj5hIDxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPio8L3NwYW4+PGVtPmI8L2VtPjxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPio8L3NwYW4+IGM8L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgndmFsaWQgc3Ryb25nIGFuZCBzdHJvbmcgZW1waGFzaXMgcmVuZGVyIGNvcnJlY3RseScsICgpID0+IHtcblx0Y29uc3Qgc3Ryb25nID0gZ2V0T25seUxpbmUoJyoqYm9sZCoqJykubGluZTtcblx0Y29uc3Qgc3Ryb25nRW1waGFzaXMgPSBnZXRPbmx5TGluZSgnKioqYm90aCoqKicpLmxpbmU7XG5cblx0YXNzZXJ0LmVxdWFsKHN0cm9uZy5pbmxpbmVbMF0/LnR5cGUsICdzdHJvbmcnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUoc3Ryb25nKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qKjwvc3Bhbj48c3Ryb25nPmJvbGQ8L3N0cm9uZz48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qKjwvc3Bhbj48L2Rpdj4nXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKHN0cm9uZ0VtcGhhc2lzLmlubGluZVswXT8udHlwZSwgJ3N0cm9uZ19lbXBoYXNpcycpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShzdHJvbmdFbXBoYXNpcyksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+PHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+KioqPC9zcGFuPjxzdHJvbmc+PGVtPmJvdGg8L2VtPjwvc3Ryb25nPjxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPioqKjwvc3Bhbj48L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgnaW5saW5lIGNvZGUgcmVuZGVycyBzeW50YXggbWFya2VycyBhbmQgY29kZSBzdHlsaW5nJywgKCkgPT4ge1xuXHRjb25zdCB7IGxpbmUgfSA9IGdldE9ubHlMaW5lKCd1c2UgYHZhbHVlYCBoZXJlJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGxpbmUuaW5saW5lWzFdPy50eXBlLCAnY29kZScpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShsaW5lKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj51c2UgPGNvZGUgY2xhc3M9XCJpbmxpbmUtY29kZVwiPjxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlciBjb2RlLW1hcmtlclwiPmA8L3NwYW4+dmFsdWU8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXIgY29kZS1tYXJrZXJcIj5gPC9zcGFuPjwvY29kZT4gaGVyZTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCd1bmNsb3NlZCBpbmxpbmUgY29kZSBtYXJrZXIgcmVtYWlucyBwbGFpbiB0ZXh0JywgKCkgPT4ge1xuXHRjb25zdCB7IGxpbmUgfSA9IGdldE9ubHlMaW5lKCd1c2UgYHZhbHVlIGhlcmUnKTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShsaW5lKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj51c2UgYHZhbHVlIGhlcmU8L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgnaW5saW5lIGNvZGUgYWxsb3dzIGxlYWRpbmcgYW5kIHRyYWlsaW5nIHNwYWNlcyBpbnNpZGUgYmFja3RpY2tzJywgKCkgPT4ge1xuXHRjb25zdCB7IGxpbmUgfSA9IGdldE9ubHlMaW5lKCd1c2UgYCB2YWx1ZSBgIGhlcmUnKTtcblxuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmVbMV0/LnR5cGUsICdjb2RlJyk7XG5cdGFzc2VydC5lcXVhbChsaW5lLmlubGluZVsxXT8udGV4dCwgJyB2YWx1ZSAnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobGluZSksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+dXNlIDxjb2RlIGNsYXNzPVwiaW5saW5lLWNvZGVcIj48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXIgY29kZS1tYXJrZXJcIj5gPC9zcGFuPiB2YWx1ZSA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXIgY29kZS1tYXJrZXJcIj5gPC9zcGFuPjwvY29kZT4gaGVyZTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdmb3JtYXR0aW5nIG1hcmtlcnMgd2l0aCBsZWFkaW5nIG9yIHRyYWlsaW5nIHNwYWNlcyBhcmUgdHJlYXRlZCBhcyBwbGFpbiB0ZXh0JywgKCkgPT4ge1xuXHRjb25zdCBsZWFkaW5nU3BhY2UgPSBnZXRPbmx5TGluZSgnKiB0ZXh0KicpLmxpbmU7XG5cdGNvbnN0IHRyYWlsaW5nU3BhY2UgPSBnZXRPbmx5TGluZSgnKnRleHQgKicpLmxpbmU7XG5cblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGVhZGluZ1NwYWNlKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+KiB0ZXh0KjwvZGl2PicpO1xuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZSh0cmFpbGluZ1NwYWNlKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+KnRleHQgKjwvZGl2PicpO1xufSk7XG5cbnRlc3QoJ2hlYWRpbmcgYmxvY2tzIHRyYWNrIGxldmVsIGFuZCByZW5kZXIgd2l0aCBoZWFkaW5nIGNsYXNzJywgKCkgPT4ge1xuXHRjb25zdCB7IGRvY3VtZW50LCBsaW5lIH0gPSBnZXRPbmx5TGluZSgnIyMjIFRpdGxlJyk7XG5cdGNvbnN0IGJsb2NrID0gZG9jdW1lbnQuYmxvY2tzWzBdO1xuXG5cdGFzc2VydC5lcXVhbChibG9jaz8udHlwZSwgJ2hlYWRpbmcnKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5sZXZlbCwgMyk7XG5cdGFzc2VydC5lcXVhbChsaW5lLmtpbmQsICdoZWFkaW5nJyk7XG5cdGFzc2VydC5lcXVhbChsaW5lLmhlYWRpbmdMZXZlbCwgMyk7XG5cdGFzc2VydC5lcXVhbChsaW5lLnByZWZpeCwgJyMjIyAnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobGluZSksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGhlYWRpbmdcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4jIyMgVGl0bGU8L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgndW5vcmRlcmVkIGxpc3RzIHByZXNlcnZlIG5lc3RpbmcgaW4gQVNUIGFuZCBsaW5lIG1ldGFkYXRhJywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSAnLSBwYXJlbnRcXG4gICAgLSBjaGlsZFxcbi0gc2libGluZyc7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudChzb3VyY2UpO1xuXHRjb25zdCBibG9jayA9IGRvY3VtZW50LmJsb2Nrc1swXTtcblxuXHRhc3NlcnQuZXF1YWwoYmxvY2s/LnR5cGUsICdsaXN0Jyk7XG5cdGFzc2VydC5lcXVhbChibG9jaz8ub3JkZXJlZCwgZmFsc2UpO1xuXHRhc3NlcnQuZXF1YWwoYmxvY2s/Lml0ZW1zLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChibG9jaz8uaXRlbXNbMF0/LmNoaWxkcmVuLmxlbmd0aCwgMSk7XG5cdGFzc2VydC5lcXVhbChibG9jaz8uaXRlbXNbMF0/LmNoaWxkcmVuWzBdPy50eXBlLCAnbGlzdCcpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lcy5sZW5ndGgsIDMpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/LmtpbmQsICd1bm9yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ubGlzdExldmVsLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzFdPy5raW5kLCAndW5vcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/Lmxpc3RMZXZlbCwgMik7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1syXT8ua2luZCwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzJdPy5saXN0TGV2ZWwsIDEpO1xufSk7XG5cbnRlc3QoJ29yZGVyZWQgbGlzdHMgY2FwdHVyZSBsaXN0IG51bWJlcnMgYW5kIG5lc3RlZCBpbmRlbnQgbWV0YWRhdGEnLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxMi4gdG9wXFxuICAgIDMuIG5lc3RlZCc7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudChzb3VyY2UpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lcy5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/LmtpbmQsICdvcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/Lmxpc3ROdW1iZXIsIDEyKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5saXN0TGV2ZWwsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/LmtpbmQsICdvcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/Lmxpc3ROdW1iZXIsIDMpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/Lmxpc3RMZXZlbCwgMik7XG59KTtcblxudGVzdCgnbGlzdCByZW5kZXJpbmcgY29tcHV0ZXMgcHJlZml4IHdpZHRoIGFuZCBpbmRlbnQgbGV2ZWwgZm9yIHVub3JkZXJlZCBpdGVtcycsICgpID0+IHtcblx0Y29uc3QgdG9wTGV2ZWwgPSBnZXRPbmx5TGluZSgnLSBpdGVtJykubGluZTtcblx0Y29uc3QgbmVzdGVkID0gZ2V0T25seUxpbmUoJyAgICAtIGl0ZW0nKS5saW5lO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKHRvcExldmVsKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAwOyAtLXByZWZpeC13aWR0aDogMlwiPi0gaXRlbTwvZGl2Pidcblx0KTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobmVzdGVkKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAxOyAtLXByZWZpeC13aWR0aDogMlwiPiAgICAtIGl0ZW08L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgnbGlzdCByZW5kZXJpbmcgY29tcHV0ZXMgcHJlZml4IHdpZHRoIGZvciBvcmRlcmVkIGl0ZW1zIHdpdGggbXVsdGktZGlnaXQgcHJlZml4ZXMnLCAoKSA9PiB7XG5cdGNvbnN0IHRvcExldmVsID0gZ2V0T25seUxpbmUoJzEyLiBpdGVtJykubGluZTtcblx0Y29uc3QgbmVzdGVkID0gZ2V0T25seUxpbmUoJyAgICAxMi4gaXRlbScpLmxpbmU7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUodG9wTGV2ZWwpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6IDA7IC0tcHJlZml4LXdpZHRoOiA0XCI+MTIuIGl0ZW08L2Rpdj4nXG5cdCk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKG5lc3RlZCksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGxpc3RcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogMTsgLS1wcmVmaXgtd2lkdGg6IDRcIj4gICAgMTIuIGl0ZW08L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgnY29kZSBmZW5jZXMgcHJvZHVjZSBmZW5jZSBhbmQgY29udGVudCBsaW5lcyB3aXRoIGNvZGUgc3R5bGluZycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCdgYGB0c1xcbmNvbnN0IHggPSAxO1xcbmBgYCcpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5ibG9ja3MubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrc1swXT8udHlwZSwgJ2NvZGVfYmxvY2snKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzLmxlbmd0aCwgMyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ua2luZCwgJ2NvZGVfZmVuY2UnKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5jb2RlQmxvY2tMYW5ndWFnZSwgJ3RzJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ua2luZCwgJ2NvZGVfY29udGVudCcpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMl0/LmtpbmQsICdjb2RlX2ZlbmNlJyk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKGRvY3VtZW50LmxpbmVzWzBdISksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGNvZGUgY29kZV9mZW5jZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPmBgYHRzPC9kaXY+J1xuXHQpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShkb2N1bWVudC5saW5lc1sxXSEpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBjb2RlIGNvZGVfY29udGVudFwiIGRhdGEtbGluZS1pZD1cImxpbmUtMVwiPmNvbnN0IHggPSAxOzwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdyZW5kZXJTZWxlY3Rpb25IdG1sIHByZXNlcnZlcyBzZW1hbnRpYyBtYXJrdXAgZm9yIHBhcnRpYWwgc2VsZWN0aW9ucycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCdhICpiKiBjJyk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQsIDMsIDQpLFxuXHRcdCc8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPjxwPjxlbT5iPC9lbT48L3A+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3JlbmRlclNlbGVjdGlvbkh0bWwgY29waWVzIGhlYWRpbmdzIGFzIHNlbWFudGljIGhlYWRpbmcgdGFncycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCcjIyBUaXRsZScpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50LCAwLCBkb2N1bWVudC50ZXh0Lmxlbmd0aCksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PGgyPlRpdGxlPC9oMj48L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgncmVuZGVyU2VsZWN0aW9uSHRtbCBwcmVzZXJ2ZXMgaGVhZGluZyBsZXZlbCBmb3IgcGFydGlhbCBoZWFkaW5nIHNlbGVjdGlvbnMnLCAoKSA9PiB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudCgnIyMjIyBUaXRsZScpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50LCA1LCA3KSxcblx0XHQnPGRpdiBzdHlsZT1cIndoaXRlLXNwYWNlOiBwcmUtd3JhcDtcIj48aDQ+VGk8L2g0PjwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdyZW5kZXJTZWxlY3Rpb25IdG1sIG9taXRzIHN5bnRheCBtYXJrZXJzIGZvciBsaXN0IGNvbnRlbnQgc2VsZWN0aW9ucycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCctICppdGVtKicpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50LCAzLCA3KSxcblx0XHQnPGRpdiBzdHlsZT1cIndoaXRlLXNwYWNlOiBwcmUtd3JhcDtcIj48dWw+PGxpPjxlbT5pdGVtPC9lbT48L2xpPjwvdWw+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3JlbmRlclNlbGVjdGlvbkh0bWwgcHJlc2VydmVzIGNvZGUgYmxvY2sgdGV4dCBhbmQgc3BhY2luZycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCdgYGBqc1xcbiAgeFxcbmBgYCcpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50LCA2LCAxMCksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PHByZT48Y29kZT4mbmJzcDsmbmJzcDt4PC9jb2RlPjwvcHJlPjwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdyZW5kZXJTZWxlY3Rpb25IdG1sIHByZXNlcnZlcyBpbmxpbmUgY29kZSBzZW1hbnRpY3MnLCAoKSA9PiB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudCgndXNlIGB2YWx1ZWAgaGVyZScpO1xuXHRjb25zdCBzdGFydCA9IGRvY3VtZW50LnRleHQuaW5kZXhPZigndmFsdWUnKTtcblx0Y29uc3QgZW5kID0gc3RhcnQgKyAndmFsdWUnLmxlbmd0aDtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudCwgc3RhcnQsIGVuZCksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PHA+PGNvZGU+dmFsdWU8L2NvZGU+PC9wPjwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMgcmVudW1iZXJzIGFuIG9yZGVyZWQgbGlzdCBhZnRlciBpbmRlbnRpbmcgYSBzdWJzZXQgb2Ygcm93cycsICgpID0+IHtcblx0Y29uc3QgbmV4dFRleHQgPSAnMS4gb25lXFxuICAgIDIuIHR3b1xcbiAgICAzLiB0aHJlZSc7XG5cdGNvbnN0IGNoYW5nZVN0YXJ0ID0gbmV4dFRleHQuaW5kZXhPZignICAgIDIuIHR3bycpO1xuXHRjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzKFxuXHRcdG5leHRUZXh0LFxuXHRcdHsgc3RhcnQ6IGNoYW5nZVN0YXJ0LCBlbmQ6IG5leHRUZXh0Lmxlbmd0aCB9LFxuXHRcdHsgc3RhcnQ6IDAsIGVuZDogbmV4dFRleHQubGVuZ3RoIH1cblx0KTtcblxuXHRhc3NlcnQuZXF1YWwobm9ybWFsaXplZC50ZXh0LCAnMS4gb25lXFxuICAgIDEuIHR3b1xcbiAgICAyLiB0aHJlZScpO1xufSk7XG5cbnRlc3QoJ25vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyByZW51bWJlcnMgbGF0ZXIgc2libGluZ3MgYWZ0ZXIgaW5zZXJ0aW5nIGFuIG9yZGVyZWQgbGlzdCBpdGVtJywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSAnMS4gb25lXFxuMi4gdHdvXFxuMy4gdGhyZWUnO1xuXHRjb25zdCBpbnNlcnRBdCA9IHNvdXJjZS5pbmRleE9mKCcyLiB0d28nKSArICcyLiB0d28nLmxlbmd0aDtcblx0Y29uc3QgbmV4dFRleHQgPSBgJHtzb3VyY2Uuc2xpY2UoMCwgaW5zZXJ0QXQpfVxcbjMuICR7c291cmNlLnNsaWNlKGluc2VydEF0KX1gO1xuXHRjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzKFxuXHRcdG5leHRUZXh0LFxuXHRcdHsgc3RhcnQ6IHNvdXJjZS5pbmRleE9mKCcyLiB0d28nKSwgZW5kOiBpbnNlcnRBdCArICdcXG4zLiAnLmxlbmd0aCB9LFxuXHRcdHsgc3RhcnQ6IGluc2VydEF0ICsgJ1xcbjMuICcubGVuZ3RoLCBlbmQ6IGluc2VydEF0ICsgJ1xcbjMuICcubGVuZ3RoIH1cblx0KTtcblxuXHRhc3NlcnQuZXF1YWwobm9ybWFsaXplZC50ZXh0LCAnMS4gb25lXFxuMi4gdHdvXFxuMy4gXFxuNC4gdGhyZWUnKTtcbn0pO1xuIiwgImltcG9ydCB0eXBlIHtcblx0QmxvY2tOb2RlLFxuXHRDb2RlQmxvY2ssXG5cdEZvcm1hdHRlZE5vZGUsXG5cdEhlYWRpbmdCbG9jayxcblx0SW5saW5lTm9kZSxcblx0TGlzdEJsb2NrLFxuXHRMaXN0SXRlbUJsb2NrLFxuXHRQYXJhZ3JhcGhCbG9jayxcblx0U291cmNlUmFuZ2UsXG5cdFRleHROb2RlXG59IGZyb20gJy4vYXN0JztcblxuZXhwb3J0IHR5cGUgTGluZUtpbmQgPVxuXHR8ICdwYXJhZ3JhcGgnXG5cdHwgJ2hlYWRpbmcnXG5cdHwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nXG5cdHwgJ29yZGVyZWRfbGlzdF9pdGVtJ1xuXHR8ICdjb2RlX2ZlbmNlJ1xuXHR8ICdjb2RlX2NvbnRlbnQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvckxpbmUge1xuXHRpZDogc3RyaW5nO1xuXHRpbmRleDogbnVtYmVyO1xuXHRyYXc6IHN0cmluZztcblx0cmFuZ2U6IFNvdXJjZVJhbmdlO1xuXHRraW5kOiBMaW5lS2luZDtcblx0bGlzdExldmVsOiBudW1iZXI7XG5cdGxpc3ROdW1iZXI6IG51bWJlcjtcblx0aGVhZGluZ0xldmVsOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xuXHRwcmVmaXhSYW5nZTogU291cmNlUmFuZ2UgfCBudWxsO1xuXHRjb250ZW50UmFuZ2U6IFNvdXJjZVJhbmdlO1xuXHRpbmxpbmU6IElubGluZU5vZGVbXTtcblx0Y29kZUJsb2NrTGFuZ3VhZ2U6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yRG9jdW1lbnQge1xuXHR0ZXh0OiBzdHJpbmc7XG5cdGJsb2NrczogQmxvY2tOb2RlW107XG5cdGxpbmVzOiBFZGl0b3JMaW5lW107XG59XG5cbmludGVyZmFjZSBSYXdMaW5lIHtcblx0aW5kZXg6IG51bWJlcjtcblx0dGV4dDogc3RyaW5nO1xuXHRzdGFydDogbnVtYmVyO1xuXHRlbmQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIExpbmVQcmVmaXhJbmZvIHtcblx0a2luZDogJ3BhcmFncmFwaCcgfCAnaGVhZGluZycgfCAndW5vcmRlcmVkX2xpc3RfaXRlbScgfCAnb3JkZXJlZF9saXN0X2l0ZW0nIHwgJ2NvZGVfZmVuY2UnO1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRoZWFkaW5nTGV2ZWw6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG5cdGxhbmd1YWdlOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGREb2N1bWVudChyYXdUZXh0OiBzdHJpbmcpOiBFZGl0b3JEb2N1bWVudCB7XG5cdGNvbnN0IHRleHQgPSBub3JtYWxpemVUZXh0KHJhd1RleHQpO1xuXHRjb25zdCByYXdMaW5lcyA9IGJ1aWxkUmF3TGluZXModGV4dCk7XG5cdGNvbnN0IGJsb2NrcyA9IHBhcnNlQmxvY2tzKHJhd0xpbmVzKTtcblx0Y29uc3QgbGluZXMgPSBkZXJpdmVMaW5lcyhibG9ja3MpO1xuXHRyZXR1cm4geyB0ZXh0LCBibG9ja3MsIGxpbmVzIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVUZXh0KHJhd1RleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiByYXdUZXh0LnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyRWRpdG9yTGluZShsaW5lOiBFZGl0b3JMaW5lKTogc3RyaW5nIHtcblx0Y29uc3QgcHJlZml4ID0gbGluZS5wcmVmaXhSYW5nZSA/IHJlbmRlckVkaXRvclRleHQobGluZS5wcmVmaXgpIDogJyc7XG5cdGNvbnN0IGNvbnRlbnQgPSBsaW5lLmtpbmQuc3RhcnRzV2l0aCgnY29kZV8nKVxuXHRcdD8gcmVuZGVyRWRpdG9yVGV4dChsaW5lLnJhdy5zbGljZShsaW5lLnByZWZpeC5sZW5ndGgpKVxuXHRcdDogcmVuZGVyRWRpdG9ySW5saW5lKGxpbmUuaW5saW5lKTtcblx0Y29uc3QgYm9keSA9IHByZWZpeCArIChjb250ZW50IHx8IChsaW5lLnJhdy5sZW5ndGggPT09IDAgPyAnPGJyPicgOiAnJykpO1xuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScgfHwgbGluZS5raW5kID09PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHtcblx0XHRjb25zdCBwcmVmaXhXaWR0aCA9IGxpbmUucHJlZml4LnRyaW1TdGFydCgpLmxlbmd0aDtcblx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJsaW5lIGxpc3RcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6ICR7bGluZS5saXN0TGV2ZWwgLSAxfTsgLS1wcmVmaXgtd2lkdGg6ICR7cHJlZml4V2lkdGh9XCI+JHtib2R5fTwvZGl2PmA7XG5cdH1cblxuXHRpZiAobGluZS5raW5kID09PSAnaGVhZGluZycpIHtcblx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJsaW5lIGhlYWRpbmdcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG5cdH1cblxuXHRpZiAobGluZS5raW5kID09PSAnY29kZV9mZW5jZScgfHwgbGluZS5raW5kID09PSAnY29kZV9jb250ZW50Jykge1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgY29kZSAke2xpbmUua2luZH1cIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG5cdH1cblxuXHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiPiR7Ym9keX08L2Rpdj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudDogRWRpdG9yRG9jdW1lbnQsIHN0YXJ0OiBudW1iZXIsIGVuZDogbnVtYmVyKTogc3RyaW5nIHtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzID0gZG9jdW1lbnQuYmxvY2tzXG5cdFx0Lm1hcCgoYmxvY2spID0+IHJlbmRlckJsb2NrU2VsZWN0aW9uKGRvY3VtZW50LnRleHQsIGJsb2NrLCBzdGFydCwgZW5kKSlcblx0XHQuZmlsdGVyKEJvb2xlYW4pO1xuXG5cdHJldHVybiBgPGRpdiBzdHlsZT1cIndoaXRlLXNwYWNlOiBwcmUtd3JhcDtcIj4ke3BhcnRzLmpvaW4oJycpfTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTGluZUluZGV4KGxpbmVzOiBFZGl0b3JMaW5lW10sIG9mZnNldDogbnVtYmVyKTogbnVtYmVyIHtcblx0aWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIDA7XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGxpbmVzLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgbmV4dFN0YXJ0ID0gaW5kZXggKyAxIDwgbGluZXMubGVuZ3RoID8gbGluZXNbaW5kZXggKyAxXS5yYW5nZS5zdGFydCA6IGxpbmUucmFuZ2UuZW5kICsgMTtcblx0XHRpZiAob2Zmc2V0IDwgbmV4dFN0YXJ0KSByZXR1cm4gaW5kZXg7XG5cdH1cblxuXHRyZXR1cm4gbGluZXMubGVuZ3RoIC0gMTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpbmVSZW5kZXJTaWduYXR1cmUobGluZTogRWRpdG9yTGluZSk6IHN0cmluZyB7XG5cdHJldHVybiBbXG5cdFx0bGluZS5raW5kLFxuXHRcdGxpbmUucmF3LFxuXHRcdGxpbmUucHJlZml4LFxuXHRcdGxpbmUubGlzdExldmVsLFxuXHRcdGxpbmUubGlzdE51bWJlcixcblx0XHRsaW5lLmhlYWRpbmdMZXZlbCxcblx0XHRsaW5lLmNvZGVCbG9ja0xhbmd1YWdlID8/ICcnXG5cdF0uam9pbignXFx1MDAwMScpO1xufVxuXG5mdW5jdGlvbiBidWlsZFJhd0xpbmVzKHRleHQ6IHN0cmluZyk6IFJhd0xpbmVbXSB7XG5cdGNvbnN0IHNwbGl0ID0gdGV4dC5zcGxpdCgnXFxuJyk7XG5cdGNvbnN0IGxpbmVzOiBSYXdMaW5lW10gPSBbXTtcblx0bGV0IG9mZnNldCA9IDA7XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHNwbGl0Lmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IGxpbmUgPSBzcGxpdFtpbmRleF07XG5cdFx0bGluZXMucHVzaCh7XG5cdFx0XHRpbmRleCxcblx0XHRcdHRleHQ6IGxpbmUsXG5cdFx0XHRzdGFydDogb2Zmc2V0LFxuXHRcdFx0ZW5kOiBvZmZzZXQgKyBsaW5lLmxlbmd0aFxuXHRcdH0pO1xuXHRcdG9mZnNldCArPSBsaW5lLmxlbmd0aCArIDE7XG5cdH1cblxuXHRyZXR1cm4gbGluZXM7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQmxvY2tzKGxpbmVzOiBSYXdMaW5lW10pOiBCbG9ja05vZGVbXSB7XG5cdHJldHVybiBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXMsIDAsIDApLmJsb2Nrcztcbn1cblxuZnVuY3Rpb24gcGFyc2VCbG9ja1NlcXVlbmNlKGxpbmVzOiBSYXdMaW5lW10sIHN0YXJ0SW5kZXg6IG51bWJlciwgbGlzdExldmVsOiBudW1iZXIpIHtcblx0Y29uc3QgYmxvY2tzOiBCbG9ja05vZGVbXSA9IFtdO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4O1xuXG5cdHdoaWxlIChpbmRleCA8IGxpbmVzLmxlbmd0aCkge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgcHJlZml4ID0gcGFyc2VQcmVmaXgobGluZS50ZXh0KTtcblxuXHRcdGlmIChsaXN0TGV2ZWwgPiAwKSB7XG5cdFx0XHRpZiAobGluZS50ZXh0LnRyaW0oKSA9PT0gJycpIGJyZWFrO1xuXHRcdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VDb2RlQmxvY2sobGluZXMsIGluZGV4KTtcblx0XHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGlmIChcblx0XHRcdFx0KHByZWZpeC5raW5kICE9PSAnb3JkZXJlZF9saXN0X2l0ZW0nICYmIHByZWZpeC5raW5kICE9PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHx8XG5cdFx0XHRcdHByZWZpeC5saXN0TGV2ZWwgPCBsaXN0TGV2ZWxcblx0XHRcdCkge1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VDb2RlQmxvY2sobGluZXMsIGluZGV4KTtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlZC5ibG9jayk7XG5cdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScgfHwgcHJlZml4LmtpbmQgPT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykge1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VMaXN0KGxpbmVzLCBpbmRleCwgcHJlZml4Lmxpc3RMZXZlbCwgcHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZUhlYWRpbmcobGluZSwgcHJlZml4KSk7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0YmxvY2tzLnB1c2gocGFyc2VQYXJhZ3JhcGgobGluZSkpO1xuXHRcdGluZGV4ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4geyBibG9ja3MsIG5leHRJbmRleDogaW5kZXggfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VMaXN0KGxpbmVzOiBSYXdMaW5lW10sIHN0YXJ0SW5kZXg6IG51bWJlciwgbGV2ZWw6IG51bWJlciwgb3JkZXJlZDogYm9vbGVhbikge1xuXHRjb25zdCBpdGVtczogTGlzdEl0ZW1CbG9ja1tdID0gW107XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXHRcdGlmIChcblx0XHRcdChwcmVmaXgua2luZCAhPT0gJ29yZGVyZWRfbGlzdF9pdGVtJyAmJiBwcmVmaXgua2luZCAhPT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB8fFxuXHRcdFx0cHJlZml4Lmxpc3RMZXZlbCA8IGxldmVsIHx8XG5cdFx0XHQocHJlZml4Lmxpc3RMZXZlbCA9PT0gbGV2ZWwgJiYgKHByZWZpeC5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nKSAhPT0gb3JkZXJlZClcblx0XHQpIHtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgubGlzdExldmVsID4gbGV2ZWwpIHtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblxuXHRcdGNvbnN0IGl0ZW1TdGFydCA9IGxpbmUuc3RhcnQ7XG5cdFx0Y29uc3QgaXRlbVByZWZpeExlbmd0aCA9IHByZWZpeC5wcmVmaXgubGVuZ3RoO1xuXHRcdGNvbnN0IGl0ZW06IExpc3RJdGVtQmxvY2sgPSB7XG5cdFx0XHR0eXBlOiAnbGlzdF9pdGVtJyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBpdGVtU3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdGxpbmVSYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0bGV2ZWwsXG5cdFx0XHRvcmRlcmVkLFxuXHRcdFx0bnVtYmVyOiBwcmVmaXgubGlzdE51bWJlcixcblx0XHRcdHByZWZpeDogcHJlZml4LnByZWZpeCxcblx0XHRcdHJhdzogbGluZS50ZXh0LFxuXHRcdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQuc2xpY2UoaXRlbVByZWZpeExlbmd0aCksIGxpbmUuc3RhcnQgKyBpdGVtUHJlZml4TGVuZ3RoKSxcblx0XHRcdGNoaWxkcmVuOiBbXVxuXHRcdH07XG5cblx0XHRpbmRleCArPSAxO1xuXHRcdGNvbnN0IGNoaWxkUGFyc2VkID0gcGFyc2VCbG9ja1NlcXVlbmNlKGxpbmVzLCBpbmRleCwgbGV2ZWwgKyAxKTtcblx0XHRpdGVtLmNoaWxkcmVuID0gY2hpbGRQYXJzZWQuYmxvY2tzO1xuXHRcdGNvbnN0IGNoaWxkRW5kID1cblx0XHRcdGl0ZW0uY2hpbGRyZW4ubGVuZ3RoID4gMCA/IGl0ZW0uY2hpbGRyZW5baXRlbS5jaGlsZHJlbi5sZW5ndGggLSAxXS5yYW5nZS5lbmQgOiBpdGVtLnJhbmdlLmVuZDtcblx0XHRpdGVtLnJhbmdlID0geyBzdGFydDogaXRlbVN0YXJ0LCBlbmQ6IGNoaWxkRW5kIH07XG5cdFx0aXRlbXMucHVzaChpdGVtKTtcblx0XHRpbmRleCA9IGNoaWxkUGFyc2VkLm5leHRJbmRleDtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0YmxvY2s6IHtcblx0XHRcdHR5cGU6ICdsaXN0Jyxcblx0XHRcdHJhbmdlOiB7XG5cdFx0XHRcdHN0YXJ0OiBpdGVtc1swXT8ucmFuZ2Uuc3RhcnQgPz8gbGluZXNbc3RhcnRJbmRleF0uc3RhcnQsXG5cdFx0XHRcdGVuZDogaXRlbXNbaXRlbXMubGVuZ3RoIC0gMV0/LnJhbmdlLmVuZCA/PyBsaW5lc1tzdGFydEluZGV4XS5lbmRcblx0XHRcdH0sXG5cdFx0XHRsZXZlbCxcblx0XHRcdG9yZGVyZWQsXG5cdFx0XHRpdGVtc1xuXHRcdH0gc2F0aXNmaWVzIExpc3RCbG9jayxcblx0XHRuZXh0SW5kZXg6IGluZGV4XG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlQ29kZUJsb2NrKGxpbmVzOiBSYXdMaW5lW10sIHN0YXJ0SW5kZXg6IG51bWJlcikge1xuXHRjb25zdCBvcGVuTGluZSA9IGxpbmVzW3N0YXJ0SW5kZXhdO1xuXHRjb25zdCBvcGVuUHJlZml4ID0gcGFyc2VQcmVmaXgob3BlbkxpbmUudGV4dCk7XG5cdGNvbnN0IGNvbnRlbnRMaW5lczogQ29kZUJsb2NrWydsaW5lcyddID0gW107XG5cdGxldCBjbG9zZUZlbmNlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblx0bGV0IGVuZCA9IG9wZW5MaW5lLmVuZDtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleCArIDE7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRjbG9zZUZlbmNlID0gcHJlZml4LnByZWZpeDtcblx0XHRcdGVuZCA9IGxpbmUuZW5kO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblxuXHRcdGNvbnRlbnRMaW5lcy5wdXNoKHtcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHR0ZXh0OiBsaW5lLnRleHRcblx0XHR9KTtcblx0XHRlbmQgPSBsaW5lLmVuZDtcblx0XHRpbmRleCArPSAxO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRibG9jazoge1xuXHRcdFx0dHlwZTogJ2NvZGVfYmxvY2snLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IG9wZW5MaW5lLnN0YXJ0LCBlbmQgfSxcblx0XHRcdGxhbmd1YWdlOiBvcGVuUHJlZml4Lmxhbmd1YWdlLFxuXHRcdFx0b3BlbkZlbmNlOiBvcGVuUHJlZml4LnByZWZpeCxcblx0XHRcdGNsb3NlRmVuY2UsXG5cdFx0XHRsaW5lczogY29udGVudExpbmVzXG5cdFx0fSBzYXRpc2ZpZXMgQ29kZUJsb2NrLFxuXHRcdG5leHRJbmRleDogaW5kZXhcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VIZWFkaW5nKGxpbmU6IFJhd0xpbmUsIHByZWZpeDogTGluZVByZWZpeEluZm8pOiBIZWFkaW5nQmxvY2sge1xuXHRjb25zdCBjb250ZW50U3RhcnQgPSBsaW5lLnN0YXJ0ICsgcHJlZml4LnByZWZpeC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0dHlwZTogJ2hlYWRpbmcnLFxuXHRcdHJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0bGV2ZWw6IHByZWZpeC5oZWFkaW5nTGV2ZWwsXG5cdFx0cHJlZml4OiBwcmVmaXgucHJlZml4LFxuXHRcdGlubGluZTogcGFyc2VJbmxpbmUobGluZS50ZXh0LnNsaWNlKHByZWZpeC5wcmVmaXgubGVuZ3RoKSwgY29udGVudFN0YXJ0KVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVBhcmFncmFwaChsaW5lOiBSYXdMaW5lKTogUGFyYWdyYXBoQmxvY2sge1xuXHRyZXR1cm4ge1xuXHRcdHR5cGU6ICdwYXJhZ3JhcGgnLFxuXHRcdHJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQsIGxpbmUuc3RhcnQpXG5cdH07XG59XG5cbmZ1bmN0aW9uIGRlcml2ZUxpbmVzKGJsb2NrczogQmxvY2tOb2RlW10pOiBFZGl0b3JMaW5lW10ge1xuXHRjb25zdCBsaW5lczogRWRpdG9yTGluZVtdID0gW107XG5cblx0Zm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcblx0XHRhcHBlbmRCbG9ja0xpbmVzKGJsb2NrLCBsaW5lcyk7XG5cdH1cblxuXHRyZXR1cm4gbGluZXMubWFwKChsaW5lLCBpbmRleCkgPT4gKHtcblx0XHQuLi5saW5lLFxuXHRcdGlkOiBgbGluZS0ke2luZGV4fWAsXG5cdFx0aW5kZXhcblx0fSkpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRCbG9ja0xpbmVzKGJsb2NrOiBCbG9ja05vZGUsIGxpbmVzOiBFZGl0b3JMaW5lW10pIHtcblx0aWYgKGJsb2NrLnR5cGUgPT09ICdwYXJhZ3JhcGgnKSB7XG5cdFx0bGluZXMucHVzaChjcmVhdGVCYXNlTGluZShibG9jay5yYXcsIGJsb2NrLnJhbmdlLCAncGFyYWdyYXBoJywgJycsIG51bGwsIGJsb2NrLmlubGluZSkpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnaGVhZGluZycpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdGJsb2NrLnJhdyxcblx0XHRcdFx0YmxvY2sucmFuZ2UsXG5cdFx0XHRcdCdoZWFkaW5nJyxcblx0XHRcdFx0YmxvY2sucHJlZml4LFxuXHRcdFx0XHRudWxsLFxuXHRcdFx0XHRibG9jay5pbmxpbmUsXG5cdFx0XHRcdDAsXG5cdFx0XHRcdDAsXG5cdFx0XHRcdGJsb2NrLmxldmVsXG5cdFx0XHQpXG5cdFx0KTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2NvZGVfYmxvY2snKSB7XG5cdFx0bGluZXMucHVzaChcblx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRibG9jay5vcGVuRmVuY2UgKyAoYmxvY2subGFuZ3VhZ2UgPyBibG9jay5sYW5ndWFnZSA6ICcnKSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHN0YXJ0OiBibG9jay5yYW5nZS5zdGFydCxcblx0XHRcdFx0XHRlbmQ6IGJsb2NrLnJhbmdlLnN0YXJ0ICsgYmxvY2sub3BlbkZlbmNlLmxlbmd0aCArIChibG9jay5sYW5ndWFnZT8ubGVuZ3RoID8/IDApXG5cdFx0XHRcdH0sXG5cdFx0XHRcdCdjb2RlX2ZlbmNlJyxcblx0XHRcdFx0YmxvY2sub3BlbkZlbmNlLFxuXHRcdFx0XHRibG9jay5sYW5ndWFnZSxcblx0XHRcdFx0W11cblx0XHRcdClcblx0XHQpO1xuXG5cdFx0Zm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLmxpbmVzKSB7XG5cdFx0XHRsaW5lcy5wdXNoKGNyZWF0ZUJhc2VMaW5lKGxpbmUudGV4dCwgbGluZS5yYW5nZSwgJ2NvZGVfY29udGVudCcsICcnLCBibG9jay5sYW5ndWFnZSwgW10pKTtcblx0XHR9XG5cblx0XHRpZiAoYmxvY2suY2xvc2VGZW5jZSkge1xuXHRcdFx0Y29uc3QgY2xvc2VTdGFydCA9IGJsb2NrLnJhbmdlLmVuZCAtIGJsb2NrLmNsb3NlRmVuY2UubGVuZ3RoO1xuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdFx0YmxvY2suY2xvc2VGZW5jZSxcblx0XHRcdFx0XHR7IHN0YXJ0OiBjbG9zZVN0YXJ0LCBlbmQ6IGJsb2NrLnJhbmdlLmVuZCB9LFxuXHRcdFx0XHRcdCdjb2RlX2ZlbmNlJyxcblx0XHRcdFx0XHRibG9jay5jbG9zZUZlbmNlLFxuXHRcdFx0XHRcdGJsb2NrLmxhbmd1YWdlLFxuXHRcdFx0XHRcdFtdXG5cdFx0XHRcdClcblx0XHRcdCk7XG5cdFx0fVxuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnbGlzdCcpIHtcblx0XHRmb3IgKGNvbnN0IGl0ZW0gb2YgYmxvY2suaXRlbXMpIHtcblx0XHRcdGxpbmVzLnB1c2goXG5cdFx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRcdGl0ZW0ucmF3LFxuXHRcdFx0XHRcdGl0ZW0ubGluZVJhbmdlLFxuXHRcdFx0XHRcdGl0ZW0ub3JkZXJlZCA/ICdvcmRlcmVkX2xpc3RfaXRlbScgOiAndW5vcmRlcmVkX2xpc3RfaXRlbScsXG5cdFx0XHRcdFx0aXRlbS5wcmVmaXgsXG5cdFx0XHRcdFx0bnVsbCxcblx0XHRcdFx0XHRpdGVtLmlubGluZSxcblx0XHRcdFx0XHRpdGVtLmxldmVsLFxuXHRcdFx0XHRcdGl0ZW0ubnVtYmVyXG5cdFx0XHRcdClcblx0XHRcdCk7XG5cdFx0XHRmb3IgKGNvbnN0IGNoaWxkIG9mIGl0ZW0uY2hpbGRyZW4pIHtcblx0XHRcdFx0YXBwZW5kQmxvY2tMaW5lcyhjaGlsZCwgbGluZXMpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBjcmVhdGVCYXNlTGluZShcblx0cmF3OiBzdHJpbmcsXG5cdHJhbmdlOiBTb3VyY2VSYW5nZSxcblx0a2luZDogTGluZUtpbmQsXG5cdHByZWZpeDogc3RyaW5nLFxuXHRjb2RlQmxvY2tMYW5ndWFnZTogc3RyaW5nIHwgbnVsbCxcblx0aW5saW5lOiBJbmxpbmVOb2RlW10sXG5cdGxpc3RMZXZlbCA9IDAsXG5cdGxpc3ROdW1iZXIgPSAwLFxuXHRoZWFkaW5nTGV2ZWwgPSAwXG4pOiBFZGl0b3JMaW5lIHtcblx0Y29uc3QgY29udGVudFN0YXJ0ID0gcmFuZ2Uuc3RhcnQgKyBwcmVmaXgubGVuZ3RoO1xuXHRyZXR1cm4ge1xuXHRcdGlkOiAnJyxcblx0XHRpbmRleDogMCxcblx0XHRyYXcsXG5cdFx0cmFuZ2UsXG5cdFx0a2luZCxcblx0XHRsaXN0TGV2ZWwsXG5cdFx0bGlzdE51bWJlcixcblx0XHRoZWFkaW5nTGV2ZWwsXG5cdFx0cHJlZml4LFxuXHRcdHByZWZpeFJhbmdlOiBwcmVmaXgubGVuZ3RoID4gMCA/IHsgc3RhcnQ6IHJhbmdlLnN0YXJ0LCBlbmQ6IGNvbnRlbnRTdGFydCB9IDogbnVsbCxcblx0XHRjb250ZW50UmFuZ2U6IHsgc3RhcnQ6IGNvbnRlbnRTdGFydCwgZW5kOiByYW5nZS5lbmQgfSxcblx0XHRpbmxpbmUsXG5cdFx0Y29kZUJsb2NrTGFuZ3VhZ2Vcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQcmVmaXgocmF3OiBzdHJpbmcpOiBMaW5lUHJlZml4SW5mbyB7XG5cdGNvbnN0IGNvZGVGZW5jZU1hdGNoID0gcmF3Lm1hdGNoKC9eYGBgKFtBLVphLXowLTlfLV0rKT9cXHMqJC8pO1xuXHRpZiAoY29kZUZlbmNlTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ2NvZGVfZmVuY2UnLFxuXHRcdFx0bGlzdExldmVsOiAwLFxuXHRcdFx0bGlzdE51bWJlcjogMCxcblx0XHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRcdHByZWZpeDogJ2BgYCcsXG5cdFx0XHRsYW5ndWFnZTogY29kZUZlbmNlTWF0Y2hbMV0gPz8gbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCB1bm9yZGVyZWRNYXRjaCA9IHJhdy5tYXRjaCgvXigoPzogezR9KSopLSAvKTtcblx0aWYgKHVub3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdGxpc3RMZXZlbDogdW5vcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiB1bm9yZGVyZWRNYXRjaFswXSxcblx0XHRcdGxhbmd1YWdlOiBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IG9yZGVyZWRNYXRjaCA9IHJhdy5tYXRjaCgvXigoPzogezR9KSopKFxcZCspXFwuIC8pO1xuXHRpZiAob3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICdvcmRlcmVkX2xpc3RfaXRlbScsXG5cdFx0XHRsaXN0TGV2ZWw6IG9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdGxpc3ROdW1iZXI6IE51bWJlci5wYXJzZUludChvcmRlcmVkTWF0Y2hbMl0sIDEwKSxcblx0XHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRcdHByZWZpeDogb3JkZXJlZE1hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgaGVhZGluZ01hdGNoID0gcmF3Lm1hdGNoKC9eKCN7MSw2fSlcXHMrLyk7XG5cdGlmIChoZWFkaW5nTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ2hlYWRpbmcnLFxuXHRcdFx0bGlzdExldmVsOiAwLFxuXHRcdFx0bGlzdE51bWJlcjogMCxcblx0XHRcdGhlYWRpbmdMZXZlbDogaGVhZGluZ01hdGNoWzFdLmxlbmd0aCxcblx0XHRcdHByZWZpeDogaGVhZGluZ01hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRraW5kOiAncGFyYWdyYXBoJyxcblx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0bGlzdE51bWJlcjogMCxcblx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0cHJlZml4OiAnJyxcblx0XHRsYW5ndWFnZTogbnVsbFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUlubGluZShyYXc6IHN0cmluZywgc3RhcnRPZmZzZXQ6IG51bWJlcik6IElubGluZU5vZGVbXSB7XG5cdGNvbnN0IGlubGluZTogSW5saW5lTm9kZVtdID0gW107XG5cdGxldCBpbmRleCA9IDA7XG5cblx0d2hpbGUgKGluZGV4IDwgcmF3Lmxlbmd0aCkge1xuXHRcdGNvbnN0IGZvcm1hdHRlZE5vZGUgPSBwYXJzZUZvcm1hdHRlZE5vZGUocmF3LCBzdGFydE9mZnNldCwgaW5kZXgpO1xuXHRcdGlmIChmb3JtYXR0ZWROb2RlKSB7XG5cdFx0XHRpbmxpbmUucHVzaChmb3JtYXR0ZWROb2RlLm5vZGUpO1xuXHRcdFx0aW5kZXggPSBmb3JtYXR0ZWROb2RlLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGxldCBuZXh0TWFya2VyID0gcmF3Lmxlbmd0aDtcblx0XHRjb25zdCBzdGFySW5kZXggPSByYXcuaW5kZXhPZignKicsIGluZGV4KTtcblx0XHRpZiAoc3RhckluZGV4ICE9PSAtMSkgbmV4dE1hcmtlciA9IHN0YXJJbmRleDtcblx0XHRjb25zdCBiYWNrdGlja0luZGV4ID0gcmF3LmluZGV4T2YoJ2AnLCBpbmRleCk7XG5cdFx0aWYgKGJhY2t0aWNrSW5kZXggIT09IC0xKSBuZXh0TWFya2VyID0gTWF0aC5taW4obmV4dE1hcmtlciwgYmFja3RpY2tJbmRleCk7XG5cblx0XHRpZiAobmV4dE1hcmtlciA9PT0gaW5kZXgpIHtcblx0XHRcdGlubGluZS5wdXNoKHtcblx0XHRcdFx0dHlwZTogJ3RleHQnLFxuXHRcdFx0XHRyYW5nZTogeyBzdGFydDogc3RhcnRPZmZzZXQgKyBpbmRleCwgZW5kOiBzdGFydE9mZnNldCArIGluZGV4ICsgMSB9LFxuXHRcdFx0XHR0ZXh0OiByYXdbaW5kZXhdXG5cdFx0XHR9IHNhdGlzZmllcyBUZXh0Tm9kZSk7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgdGV4dCA9IHJhdy5zbGljZShpbmRleCwgbmV4dE1hcmtlcik7XG5cdFx0aW5saW5lLnB1c2goe1xuXHRcdFx0dHlwZTogJ3RleHQnLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBuZXh0TWFya2VyIH0sXG5cdFx0XHR0ZXh0XG5cdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdGluZGV4ID0gbmV4dE1hcmtlcjtcblx0fVxuXG5cdHJldHVybiBpbmxpbmU7XG59XG5cbmZ1bmN0aW9uIHBhcnNlRm9ybWF0dGVkTm9kZShyYXc6IHN0cmluZywgc3RhcnRPZmZzZXQ6IG51bWJlciwgaW5kZXg6IG51bWJlcikge1xuXHRmb3IgKGNvbnN0IG1hcmtlciBvZiBbJ2AnLCAnKioqJywgJyoqJywgJyonXSBhcyBjb25zdCkge1xuXHRcdGlmICghcmF3LnN0YXJ0c1dpdGgobWFya2VyLCBpbmRleCkpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgY2xvc2UgPSByYXcuaW5kZXhPZihtYXJrZXIsIGluZGV4ICsgbWFya2VyLmxlbmd0aCk7XG5cdFx0aWYgKGNsb3NlID09PSAtMSkgY29udGludWU7XG5cblx0XHRjb25zdCBjb250ZW50U3RhcnQgPSBpbmRleCArIG1hcmtlci5sZW5ndGg7XG5cdFx0Y29uc3QgY29udGVudEVuZCA9IGNsb3NlO1xuXHRcdGlmIChjb250ZW50U3RhcnQgPj0gY29udGVudEVuZCkgY29udGludWU7XG5cdFx0aWYgKG1hcmtlciAhPT0gJ2AnICYmIChyYXdbY29udGVudFN0YXJ0XSA9PT0gJyAnIHx8IHJhd1tjb250ZW50RW5kIC0gMV0gPT09ICcgJykpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgdHlwZSA9XG5cdFx0XHRtYXJrZXIgPT09ICdgJ1xuXHRcdFx0XHQ/ICdjb2RlJ1xuXHRcdFx0XHQ6IG1hcmtlciA9PT0gJyoqKidcblx0XHRcdFx0XHQ/ICdzdHJvbmdfZW1waGFzaXMnXG5cdFx0XHRcdFx0OiBtYXJrZXIgPT09ICcqKidcblx0XHRcdFx0XHRcdD8gJ3N0cm9uZydcblx0XHRcdFx0XHRcdDogJ2VtcGhhc2lzJztcblxuXHRcdHJldHVybiB7XG5cdFx0XHRub2RlOiB7XG5cdFx0XHRcdHR5cGUsXG5cdFx0XHRcdHJhbmdlOiB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNsb3NlICsgbWFya2VyLmxlbmd0aFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRjb250ZW50UmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBjb250ZW50U3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNvbnRlbnRFbmRcblx0XHRcdFx0fSxcblx0XHRcdFx0bWFya2VyLFxuXHRcdFx0XHR0ZXh0OiByYXcuc2xpY2UoY29udGVudFN0YXJ0LCBjb250ZW50RW5kKVxuXHRcdFx0fSBzYXRpc2ZpZXMgRm9ybWF0dGVkTm9kZSxcblx0XHRcdG5leHRJbmRleDogY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JJbmxpbmUoaW5saW5lOiBJbmxpbmVOb2RlW10pOiBzdHJpbmcge1xuXHRyZXR1cm4gaW5saW5lXG5cdFx0Lm1hcCgobm9kZSkgPT4ge1xuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRcdHJldHVybiByZW5kZXJFZGl0b3JUZXh0KG5vZGUudGV4dCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBlc2NhcGVIdG1sKG5vZGUudGV4dCk7XG5cblx0XHRcdGlmIChub2RlLnR5cGUgPT09ICdjb2RlJykge1xuXHRcdFx0XHRjb25zdCBtYXJrZXIgPSBgPHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyIGNvZGUtbWFya2VyXCI+JHtlc2NhcGVIdG1sKG5vZGUubWFya2VyKX08L3NwYW4+YDtcblx0XHRcdFx0cmV0dXJuIGA8Y29kZSBjbGFzcz1cImlubGluZS1jb2RlXCI+JHttYXJrZXJ9JHtjb250ZW50fSR7bWFya2VyfTwvY29kZT5gO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBtYXJrZXIgPSBgPHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+JHtlc2NhcGVIdG1sKG5vZGUubWFya2VyKX08L3NwYW4+YDtcblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2VtcGhhc2lzJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxlbT4ke2NvbnRlbnR9PC9lbT4ke21hcmtlcn1gO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxzdHJvbmc+JHtjb250ZW50fTwvc3Ryb25nPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz48ZW0+JHtjb250ZW50fTwvZW0+PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHR9KVxuXHRcdC5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQmxvY2tTZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0YmxvY2s6IEJsb2NrTm9kZSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gYmxvY2sucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gYmxvY2sucmFuZ2UuZW5kKSByZXR1cm4gJyc7XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdwYXJhZ3JhcGgnKSB7XG5cdFx0cmV0dXJuIGA8cD4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvcD5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGNvbnN0IHRhZyA9IGBoJHtibG9jay5sZXZlbH1gO1xuXHRcdHJldHVybiBgPCR7dGFnfT4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvJHt0YWd9PmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2NvZGVfYmxvY2snKSB7XG5cdFx0Y29uc3QgY29kZVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0aWYgKGVuZCA8PSBsaW5lLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGxpbmUucmFuZ2UuZW5kKSBjb250aW51ZTtcblx0XHRcdGNvZGVQYXJ0cy5wdXNoKGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQoc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBsaW5lLnJhbmdlLCBzdGFydCwgZW5kKSkpO1xuXHRcdH1cblx0XHRyZXR1cm4gYDxwcmU+PGNvZGU+JHtjb2RlUGFydHMuam9pbignXFxuJyl9PC9jb2RlPjwvcHJlPmA7XG5cdH1cblxuXHRjb25zdCB0YWcgPSBibG9jay5vcmRlcmVkID8gJ29sJyA6ICd1bCc7XG5cdGNvbnN0IGl0ZW1zID0gYmxvY2suaXRlbXNcblx0XHQubWFwKChpdGVtKSA9PiByZW5kZXJMaXN0SXRlbVNlbGVjdGlvbihzb3VyY2VUZXh0LCBpdGVtLCBzdGFydCwgZW5kKSlcblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oJycpO1xuXHRyZXR1cm4gaXRlbXMgPyBgPCR7dGFnfT4ke2l0ZW1zfTwvJHt0YWd9PmAgOiAnJztcbn1cblxuZnVuY3Rpb24gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0aXRlbTogTGlzdEl0ZW1CbG9jayxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gaXRlbS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBpdGVtLnJhbmdlLmVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBpdGVtSW5saW5lID0gcmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbS5pbmxpbmUsIHN0YXJ0LCBlbmQpO1xuXHRwYXJ0cy5wdXNoKGl0ZW1JbmxpbmUgfHwgJzxicj4nKTtcblxuXHRmb3IgKGNvbnN0IGNoaWxkIG9mIGl0ZW0uY2hpbGRyZW4pIHtcblx0XHRjb25zdCBjaGlsZEh0bWwgPSByZW5kZXJCbG9ja1NlbGVjdGlvbihzb3VyY2VUZXh0LCBjaGlsZCwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKGNoaWxkSHRtbCkgcGFydHMucHVzaChjaGlsZEh0bWwpO1xuXHR9XG5cblx0cmV0dXJuIGA8bGk+JHtwYXJ0cy5qb2luKCcnKX08L2xpPmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3Qgbm9kZSBvZiBpbmxpbmUpIHtcblx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdGNvbnN0IHNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLnJhbmdlLCBzdGFydCwgZW5kKTtcblx0XHRcdGlmIChzbGljZSkgcGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlKSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBpbm5lclNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLmNvbnRlbnRSYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKCFpbm5lclNsaWNlKSBjb250aW51ZTtcblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdlbXBoYXNpcycpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L3N0cm9uZz5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdjb2RlJykge1xuXHRcdFx0cGFydHMucHVzaChgPGNvZGU+JHtlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKGlubmVyU2xpY2UpfTwvY29kZT5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHBhcnRzLnB1c2goYDxzdHJvbmc+PGVtPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2VtPjwvc3Ryb25nPmApO1xuXHR9XG5cblx0cmV0dXJuIHBhcnRzLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBzbGljZVJhbmdlKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdHJhbmdlOiBTb3VyY2VSYW5nZSxcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcixcblx0c2VsZWN0aW9uRW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgocmFuZ2Uuc3RhcnQsIHNlbGVjdGlvblN0YXJ0KTtcblx0Y29uc3QgZW5kID0gTWF0aC5taW4ocmFuZ2UuZW5kLCBzZWxlY3Rpb25FbmQpO1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cdHJldHVybiBzb3VyY2VUZXh0LnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0Lmxlbmd0aCA9PT0gMCA/ICcnIDogZXNjYXBlSHRtbCh0ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7Jyk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGVzY2FwZUh0bWwodGV4dCkucmVwbGFjZSgvIC9nLCAnJm5ic3A7JykucmVwbGFjZSgvXFx0L2csICcmbmJzcDsmbmJzcDsmbmJzcDsmbmJzcDsnKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IEJsb2NrTm9kZSwgTGlzdEJsb2NrIH0gZnJvbSAnLi9hc3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCB9IGZyb20gJy4vcGFyc2VyJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0aW9uUmFuZ2UsIFRleHRDaGFuZ2UgfSBmcm9tICcuL3RleHQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIExpc3RNZXRhZGF0YSB7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRvcmRlcmVkOiBib29sZWFuO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVGV4dFJlcGxhY2VtZW50IHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpc3RNZXRhZGF0YShsaW5lVGV4dDogc3RyaW5nKTogTGlzdE1ldGFkYXRhIHtcblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXigoPzogezR9KSopLSAvKTtcblx0aWYgKHVub3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGxpc3RMZXZlbDogdW5vcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiBmYWxzZSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IG9yZGVyZWRNYXRjaCA9IGxpbmVUZXh0Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiB0cnVlLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF1cblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0b3JkZXJlZDogZmFsc2UsXG5cdFx0bGlzdE51bWJlcjogMCxcblx0XHRwcmVmaXg6ICcnXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdHRleHQ6IHN0cmluZyxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2Vcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQodGV4dCk7XG5cdGNvbnN0IHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W10gPSBbXTtcblxuXHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoZG9jdW1lbnQuYmxvY2tzLCBhZmZlY3RlZFJhbmdlLCByZXBsYWNlbWVudHMpO1xuXG5cdGlmIChyZXBsYWNlbWVudHMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogc2VsZWN0aW9uLnN0YXJ0LFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fTtcblx0fVxuXG5cdHJlcGxhY2VtZW50cy5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuc3RhcnQgLSBsZWZ0LnN0YXJ0KTtcblxuXHRsZXQgbmV4dFRleHQgPSB0ZXh0O1xuXHRsZXQgc2VsZWN0aW9uU3RhcnQgPSBzZWxlY3Rpb24uc3RhcnQ7XG5cdGxldCBzZWxlY3Rpb25FbmQgPSBzZWxlY3Rpb24uZW5kO1xuXG5cdGZvciAoY29uc3QgcmVwbGFjZW1lbnQgb2YgcmVwbGFjZW1lbnRzKSB7XG5cdFx0Y29uc3QgcmVwbGFjZWRMZW5ndGggPSByZXBsYWNlbWVudC5lbmQgLSByZXBsYWNlbWVudC5zdGFydDtcblx0XHRjb25zdCBkZWx0YSA9IHJlcGxhY2VtZW50LnRleHQubGVuZ3RoIC0gcmVwbGFjZWRMZW5ndGg7XG5cdFx0bmV4dFRleHQgPVxuXHRcdFx0bmV4dFRleHQuc2xpY2UoMCwgcmVwbGFjZW1lbnQuc3RhcnQpICsgcmVwbGFjZW1lbnQudGV4dCArIG5leHRUZXh0LnNsaWNlKHJlcGxhY2VtZW50LmVuZCk7XG5cdFx0c2VsZWN0aW9uU3RhcnQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuc3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5lbmQsXG5cdFx0XHRyZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCxcblx0XHRcdGRlbHRhXG5cdFx0KTtcblx0XHRzZWxlY3Rpb25FbmQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvbkVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuZW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQudGV4dC5sZW5ndGgsXG5cdFx0XHRkZWx0YVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrczogQmxvY2tOb2RlW10sXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pOiBib29sZWFuIHtcblx0bGV0IGZvdW5kQWZmZWN0ZWRCbG9jayA9IGZhbHNlO1xuXG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0bGV0IGJsb2NrQWZmZWN0ZWQgPSByYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpO1xuXG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdFx0Y29sbGVjdExpc3RSZXBsYWNlbWVudHMoYmxvY2ssIGFmZmVjdGVkUmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cblx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0XHRjb25zdCBjaGlsZHJlbkFmZmVjdGVkID0gY29sbGVjdE9yZGVyZWRMaXN0UmVwbGFjZW1lbnRzKFxuXHRcdFx0XHRcdGl0ZW0uY2hpbGRyZW4sXG5cdFx0XHRcdFx0YWZmZWN0ZWRSYW5nZSxcblx0XHRcdFx0XHRyZXBsYWNlbWVudHNcblx0XHRcdFx0KTtcblx0XHRcdFx0aWYgKGNoaWxkcmVuQWZmZWN0ZWQpIHtcblx0XHRcdFx0XHRub3JtYWxpemVTaWJsaW5nT3JkZXJlZENoaWxkTGlzdHMoaXRlbS5jaGlsZHJlbiwgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdFx0XHRibG9ja0FmZmVjdGVkID0gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChibG9ja0FmZmVjdGVkKSB7XG5cdFx0XHRmb3VuZEFmZmVjdGVkQmxvY2sgPSB0cnVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBmb3VuZEFmZmVjdGVkQmxvY2s7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RMaXN0UmVwbGFjZW1lbnRzKFxuXHRibG9jazogTGlzdEJsb2NrLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0cmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXVxuKSB7XG5cdGlmICghYmxvY2sub3JkZXJlZCB8fCAhcmFuZ2VzSW50ZXJzZWN0KGJsb2NrLnJhbmdlLCBhZmZlY3RlZFJhbmdlKSkge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBibG9jay5pdGVtcy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBpdGVtID0gYmxvY2suaXRlbXNbaW5kZXhdITtcblx0XHRjb25zdCBleHBlY3RlZE51bWJlciA9IGluZGV4ICsgMTtcblx0XHRpZiAoaXRlbS5udW1iZXIgPT09IGV4cGVjdGVkTnVtYmVyKSBjb250aW51ZTtcblxuXHRcdHJlcGxhY2VtZW50cy5wdXNoKHtcblx0XHRcdHN0YXJ0OiBpdGVtLmxpbmVSYW5nZS5zdGFydCxcblx0XHRcdGVuZDogaXRlbS5saW5lUmFuZ2Uuc3RhcnQgKyBpdGVtLnByZWZpeC5sZW5ndGgsXG5cdFx0XHR0ZXh0OiBgJHsnICAgICcucmVwZWF0KGl0ZW0ubGV2ZWwgLSAxKX0ke2V4cGVjdGVkTnVtYmVyfS4gYFxuXHRcdH0pO1xuXHR9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNpYmxpbmdPcmRlcmVkQ2hpbGRMaXN0cyhcblx0YmxvY2tzOiBCbG9ja05vZGVbXSxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W11cbikge1xuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGlmIChibG9jay50eXBlICE9PSAnbGlzdCcgfHwgIWJsb2NrLm9yZGVyZWQgfHwgcmFuZ2VzSW50ZXJzZWN0KGJsb2NrLnJhbmdlLCBhZmZlY3RlZFJhbmdlKSkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29sbGVjdExpc3RSZXBsYWNlbWVudHMoYmxvY2ssIGJsb2NrLnJhbmdlLCByZXBsYWNlbWVudHMpO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHJhbmdlc0ludGVyc2VjdChsZWZ0OiBTZWxlY3Rpb25SYW5nZSwgcmlnaHQ6IFNlbGVjdGlvblJhbmdlKSB7XG5cdHJldHVybiBsZWZ0LnN0YXJ0IDw9IHJpZ2h0LmVuZCAmJiByaWdodC5zdGFydCA8PSBsZWZ0LmVuZDtcbn1cblxuZnVuY3Rpb24gYWRqdXN0U2VsZWN0aW9uUG9pbnQoXG5cdHBvaW50OiBudW1iZXIsXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyLFxuXHRyZXBsYWNlbWVudExlbmd0aDogbnVtYmVyLFxuXHRkZWx0YTogbnVtYmVyXG4pIHtcblx0aWYgKHBvaW50ID4gZW5kKSB7XG5cdFx0cmV0dXJuIHBvaW50ICsgZGVsdGE7XG5cdH1cblxuXHRpZiAocG9pbnQgPj0gc3RhcnQpIHtcblx0XHRyZXR1cm4gc3RhcnQgKyBNYXRoLm1pbihwb2ludCAtIHN0YXJ0LCByZXBsYWNlbWVudExlbmd0aCk7XG5cdH1cblxuXHRyZXR1cm4gcG9pbnQ7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDMERaLFNBQVMsY0FBYyxTQUFpQztBQUM5RCxRQUFNLE9BQU8sY0FBYyxPQUFPO0FBQ2xDLFFBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsUUFBTSxTQUFTLFlBQVksUUFBUTtBQUNuQyxRQUFNLFFBQVEsWUFBWSxNQUFNO0FBQ2hDLFNBQU8sRUFBRSxNQUFNLFFBQVEsTUFBTTtBQUM5QjtBQUVPLFNBQVMsY0FBYyxTQUF5QjtBQUN0RCxTQUFPLFFBQVEsUUFBUSxVQUFVLElBQUk7QUFDdEM7QUFFTyxTQUFTLGlCQUFpQixNQUEwQjtBQUMxRCxRQUFNLFNBQVMsS0FBSyxjQUFjLGlCQUFpQixLQUFLLE1BQU0sSUFBSTtBQUNsRSxRQUFNLFVBQVUsS0FBSyxLQUFLLFdBQVcsT0FBTyxJQUN6QyxpQkFBaUIsS0FBSyxJQUFJLE1BQU0sS0FBSyxPQUFPLE1BQU0sQ0FBQyxJQUNuRCxtQkFBbUIsS0FBSyxNQUFNO0FBQ2pDLFFBQU0sT0FBTyxVQUFVLFlBQVksS0FBSyxJQUFJLFdBQVcsSUFBSSxTQUFTO0FBRXBFLE1BQUksS0FBSyxTQUFTLHVCQUF1QixLQUFLLFNBQVMsdUJBQXVCO0FBQzdFLFVBQU0sY0FBYyxLQUFLLE9BQU8sVUFBVSxFQUFFO0FBQzVDLFdBQU8sd0NBQXdDLEtBQUssRUFBRSwwQkFBMEIsS0FBSyxZQUFZLENBQUMscUJBQXFCLFdBQVcsS0FBSyxJQUFJO0FBQUEsRUFDNUk7QUFFQSxNQUFJLEtBQUssU0FBUyxXQUFXO0FBQzVCLFdBQU8sMkNBQTJDLEtBQUssRUFBRSxLQUFLLElBQUk7QUFBQSxFQUNuRTtBQUVBLE1BQUksS0FBSyxTQUFTLGdCQUFnQixLQUFLLFNBQVMsZ0JBQWdCO0FBQy9ELFdBQU8seUJBQXlCLEtBQUssSUFBSSxtQkFBbUIsS0FBSyxFQUFFLEtBQUssSUFBSTtBQUFBLEVBQzdFO0FBRUEsU0FBTyxtQ0FBbUMsS0FBSyxFQUFFLEtBQUssSUFBSTtBQUMzRDtBQUVPLFNBQVMsb0JBQW9CLFVBQTBCLE9BQWUsS0FBcUI7QUFDakcsTUFBSSxTQUFTLElBQUssUUFBTztBQUV6QixRQUFNLFFBQVEsU0FBUyxPQUNyQixJQUFJLENBQUMsVUFBVSxxQkFBcUIsU0FBUyxNQUFNLE9BQU8sT0FBTyxHQUFHLENBQUMsRUFDckUsT0FBTyxPQUFPO0FBRWhCLFNBQU8sdUNBQXVDLE1BQU0sS0FBSyxFQUFFLENBQUM7QUFDN0Q7QUEwQkEsU0FBUyxjQUFjLE1BQXlCO0FBQy9DLFFBQU0sUUFBUSxLQUFLLE1BQU0sSUFBSTtBQUM3QixRQUFNLFFBQW1CLENBQUM7QUFDMUIsTUFBSSxTQUFTO0FBRWIsV0FBUyxRQUFRLEdBQUcsUUFBUSxNQUFNLFFBQVEsU0FBUztBQUNsRCxVQUFNLE9BQU8sTUFBTSxLQUFLO0FBQ3hCLFVBQU0sS0FBSztBQUFBLE1BQ1Y7QUFBQSxNQUNBLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxNQUNQLEtBQUssU0FBUyxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUNELGNBQVUsS0FBSyxTQUFTO0FBQUEsRUFDekI7QUFFQSxTQUFPO0FBQ1I7QUFFQSxTQUFTLFlBQVksT0FBK0I7QUFDbkQsU0FBTyxtQkFBbUIsT0FBTyxHQUFHLENBQUMsRUFBRTtBQUN4QztBQUVBLFNBQVMsbUJBQW1CLE9BQWtCLFlBQW9CLFdBQW1CO0FBQ3BGLFFBQU0sU0FBc0IsQ0FBQztBQUM3QixNQUFJLFFBQVE7QUFFWixTQUFPLFFBQVEsTUFBTSxRQUFRO0FBQzVCLFVBQU0sT0FBTyxNQUFNLEtBQUs7QUFDeEIsVUFBTSxTQUFTLFlBQVksS0FBSyxJQUFJO0FBRXBDLFFBQUksWUFBWSxHQUFHO0FBQ2xCLFVBQUksS0FBSyxLQUFLLEtBQUssTUFBTSxHQUFJO0FBQzdCLFVBQUksT0FBTyxTQUFTLGNBQWM7QUFDakMsY0FBTSxTQUFTLGVBQWUsT0FBTyxLQUFLO0FBQzFDLGVBQU8sS0FBSyxPQUFPLEtBQUs7QUFDeEIsZ0JBQVEsT0FBTztBQUNmO0FBQUEsTUFDRDtBQUNBLFVBQ0UsT0FBTyxTQUFTLHVCQUF1QixPQUFPLFNBQVMseUJBQ3hELE9BQU8sWUFBWSxXQUNsQjtBQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFFQSxRQUFJLE9BQU8sU0FBUyxjQUFjO0FBQ2pDLFlBQU0sU0FBUyxlQUFlLE9BQU8sS0FBSztBQUMxQyxhQUFPLEtBQUssT0FBTyxLQUFLO0FBQ3hCLGNBQVEsT0FBTztBQUNmO0FBQUEsSUFDRDtBQUVBLFFBQUksT0FBTyxTQUFTLHVCQUF1QixPQUFPLFNBQVMsdUJBQXVCO0FBQ2pGLFlBQU0sU0FBUyxVQUFVLE9BQU8sT0FBTyxPQUFPLFdBQVcsT0FBTyxTQUFTLG1CQUFtQjtBQUM1RixhQUFPLEtBQUssT0FBTyxLQUFLO0FBQ3hCLGNBQVEsT0FBTztBQUNmO0FBQUEsSUFDRDtBQUVBLFFBQUksT0FBTyxTQUFTLFdBQVc7QUFDOUIsYUFBTyxLQUFLLGFBQWEsTUFBTSxNQUFNLENBQUM7QUFDdEMsZUFBUztBQUNUO0FBQUEsSUFDRDtBQUVBLFdBQU8sS0FBSyxlQUFlLElBQUksQ0FBQztBQUNoQyxhQUFTO0FBQUEsRUFDVjtBQUVBLFNBQU8sRUFBRSxRQUFRLFdBQVcsTUFBTTtBQUNuQztBQUVBLFNBQVMsVUFBVSxPQUFrQixZQUFvQixPQUFlLFNBQWtCO0FBQ3pGLFFBQU0sUUFBeUIsQ0FBQztBQUNoQyxNQUFJLFFBQVE7QUFFWixTQUFPLFFBQVEsTUFBTSxRQUFRO0FBQzVCLFVBQU0sT0FBTyxNQUFNLEtBQUs7QUFDeEIsVUFBTSxTQUFTLFlBQVksS0FBSyxJQUFJO0FBQ3BDLFFBQ0UsT0FBTyxTQUFTLHVCQUF1QixPQUFPLFNBQVMseUJBQ3hELE9BQU8sWUFBWSxTQUNsQixPQUFPLGNBQWMsU0FBVSxPQUFPLFNBQVMsd0JBQXlCLFNBQ3hFO0FBQ0Q7QUFBQSxJQUNEO0FBRUEsUUFBSSxPQUFPLFlBQVksT0FBTztBQUM3QjtBQUFBLElBQ0Q7QUFFQSxVQUFNLFlBQVksS0FBSztBQUN2QixVQUFNLG1CQUFtQixPQUFPLE9BQU87QUFDdkMsVUFBTSxPQUFzQjtBQUFBLE1BQzNCLE1BQU07QUFBQSxNQUNOLE9BQU8sRUFBRSxPQUFPLFdBQVcsS0FBSyxLQUFLLElBQUk7QUFBQSxNQUN6QyxXQUFXLEVBQUUsT0FBTyxLQUFLLE9BQU8sS0FBSyxLQUFLLElBQUk7QUFBQSxNQUM5QztBQUFBLE1BQ0E7QUFBQSxNQUNBLFFBQVEsT0FBTztBQUFBLE1BQ2YsUUFBUSxPQUFPO0FBQUEsTUFDZixLQUFLLEtBQUs7QUFBQSxNQUNWLFFBQVEsWUFBWSxLQUFLLEtBQUssTUFBTSxnQkFBZ0IsR0FBRyxLQUFLLFFBQVEsZ0JBQWdCO0FBQUEsTUFDcEYsVUFBVSxDQUFDO0FBQUEsSUFDWjtBQUVBLGFBQVM7QUFDVCxVQUFNLGNBQWMsbUJBQW1CLE9BQU8sT0FBTyxRQUFRLENBQUM7QUFDOUQsU0FBSyxXQUFXLFlBQVk7QUFDNUIsVUFBTSxXQUNMLEtBQUssU0FBUyxTQUFTLElBQUksS0FBSyxTQUFTLEtBQUssU0FBUyxTQUFTLENBQUMsRUFBRSxNQUFNLE1BQU0sS0FBSyxNQUFNO0FBQzNGLFNBQUssUUFBUSxFQUFFLE9BQU8sV0FBVyxLQUFLLFNBQVM7QUFDL0MsVUFBTSxLQUFLLElBQUk7QUFDZixZQUFRLFlBQVk7QUFBQSxFQUNyQjtBQUVBLFNBQU87QUFBQSxJQUNOLE9BQU87QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxRQUNOLE9BQU8sTUFBTSxDQUFDLEdBQUcsTUFBTSxTQUFTLE1BQU0sVUFBVSxFQUFFO0FBQUEsUUFDbEQsS0FBSyxNQUFNLE1BQU0sU0FBUyxDQUFDLEdBQUcsTUFBTSxPQUFPLE1BQU0sVUFBVSxFQUFFO0FBQUEsTUFDOUQ7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsSUFDQSxXQUFXO0FBQUEsRUFDWjtBQUNEO0FBRUEsU0FBUyxlQUFlLE9BQWtCLFlBQW9CO0FBQzdELFFBQU0sV0FBVyxNQUFNLFVBQVU7QUFDakMsUUFBTSxhQUFhLFlBQVksU0FBUyxJQUFJO0FBQzVDLFFBQU0sZUFBbUMsQ0FBQztBQUMxQyxNQUFJLGFBQTRCO0FBQ2hDLE1BQUksTUFBTSxTQUFTO0FBQ25CLE1BQUksUUFBUSxhQUFhO0FBRXpCLFNBQU8sUUFBUSxNQUFNLFFBQVE7QUFDNUIsVUFBTSxPQUFPLE1BQU0sS0FBSztBQUN4QixVQUFNLFNBQVMsWUFBWSxLQUFLLElBQUk7QUFDcEMsUUFBSSxPQUFPLFNBQVMsY0FBYztBQUNqQyxtQkFBYSxPQUFPO0FBQ3BCLFlBQU0sS0FBSztBQUNYLGVBQVM7QUFDVDtBQUFBLElBQ0Q7QUFFQSxpQkFBYSxLQUFLO0FBQUEsTUFDakIsT0FBTyxFQUFFLE9BQU8sS0FBSyxPQUFPLEtBQUssS0FBSyxJQUFJO0FBQUEsTUFDMUMsTUFBTSxLQUFLO0FBQUEsSUFDWixDQUFDO0FBQ0QsVUFBTSxLQUFLO0FBQ1gsYUFBUztBQUFBLEVBQ1Y7QUFFQSxTQUFPO0FBQUEsSUFDTixPQUFPO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixPQUFPLEVBQUUsT0FBTyxTQUFTLE9BQU8sSUFBSTtBQUFBLE1BQ3BDLFVBQVUsV0FBVztBQUFBLE1BQ3JCLFdBQVcsV0FBVztBQUFBLE1BQ3RCO0FBQUEsTUFDQSxPQUFPO0FBQUEsSUFDUjtBQUFBLElBQ0EsV0FBVztBQUFBLEVBQ1o7QUFDRDtBQUVBLFNBQVMsYUFBYSxNQUFlLFFBQXNDO0FBQzFFLFFBQU0sZUFBZSxLQUFLLFFBQVEsT0FBTyxPQUFPO0FBQ2hELFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU8sRUFBRSxPQUFPLEtBQUssT0FBTyxLQUFLLEtBQUssSUFBSTtBQUFBLElBQzFDLEtBQUssS0FBSztBQUFBLElBQ1YsT0FBTyxPQUFPO0FBQUEsSUFDZCxRQUFRLE9BQU87QUFBQSxJQUNmLFFBQVEsWUFBWSxLQUFLLEtBQUssTUFBTSxPQUFPLE9BQU8sTUFBTSxHQUFHLFlBQVk7QUFBQSxFQUN4RTtBQUNEO0FBRUEsU0FBUyxlQUFlLE1BQStCO0FBQ3RELFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU8sRUFBRSxPQUFPLEtBQUssT0FBTyxLQUFLLEtBQUssSUFBSTtBQUFBLElBQzFDLEtBQUssS0FBSztBQUFBLElBQ1YsUUFBUSxZQUFZLEtBQUssTUFBTSxLQUFLLEtBQUs7QUFBQSxFQUMxQztBQUNEO0FBRUEsU0FBUyxZQUFZLFFBQW1DO0FBQ3ZELFFBQU0sUUFBc0IsQ0FBQztBQUU3QixhQUFXLFNBQVMsUUFBUTtBQUMzQixxQkFBaUIsT0FBTyxLQUFLO0FBQUEsRUFDOUI7QUFFQSxTQUFPLE1BQU0sSUFBSSxDQUFDLE1BQU0sV0FBVztBQUFBLElBQ2xDLEdBQUc7QUFBQSxJQUNILElBQUksUUFBUSxLQUFLO0FBQUEsSUFDakI7QUFBQSxFQUNELEVBQUU7QUFDSDtBQUVBLFNBQVMsaUJBQWlCLE9BQWtCLE9BQXFCO0FBQ2hFLE1BQUksTUFBTSxTQUFTLGFBQWE7QUFDL0IsVUFBTSxLQUFLLGVBQWUsTUFBTSxLQUFLLE1BQU0sT0FBTyxhQUFhLElBQUksTUFBTSxNQUFNLE1BQU0sQ0FBQztBQUN0RjtBQUFBLEVBQ0Q7QUFFQSxNQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLFVBQU07QUFBQSxNQUNMO0FBQUEsUUFDQyxNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTjtBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ047QUFBQSxRQUNBLE1BQU07QUFBQSxRQUNOO0FBQUEsUUFDQTtBQUFBLFFBQ0EsTUFBTTtBQUFBLE1BQ1A7QUFBQSxJQUNEO0FBQ0E7QUFBQSxFQUNEO0FBRUEsTUFBSSxNQUFNLFNBQVMsY0FBYztBQUNoQyxVQUFNO0FBQUEsTUFDTDtBQUFBLFFBQ0MsTUFBTSxhQUFhLE1BQU0sV0FBVyxNQUFNLFdBQVc7QUFBQSxRQUNyRDtBQUFBLFVBQ0MsT0FBTyxNQUFNLE1BQU07QUFBQSxVQUNuQixLQUFLLE1BQU0sTUFBTSxRQUFRLE1BQU0sVUFBVSxVQUFVLE1BQU0sVUFBVSxVQUFVO0FBQUEsUUFDOUU7QUFBQSxRQUNBO0FBQUEsUUFDQSxNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixDQUFDO0FBQUEsTUFDRjtBQUFBLElBQ0Q7QUFFQSxlQUFXLFFBQVEsTUFBTSxPQUFPO0FBQy9CLFlBQU0sS0FBSyxlQUFlLEtBQUssTUFBTSxLQUFLLE9BQU8sZ0JBQWdCLElBQUksTUFBTSxVQUFVLENBQUMsQ0FBQyxDQUFDO0FBQUEsSUFDekY7QUFFQSxRQUFJLE1BQU0sWUFBWTtBQUNyQixZQUFNLGFBQWEsTUFBTSxNQUFNLE1BQU0sTUFBTSxXQUFXO0FBQ3RELFlBQU07QUFBQSxRQUNMO0FBQUEsVUFDQyxNQUFNO0FBQUEsVUFDTixFQUFFLE9BQU8sWUFBWSxLQUFLLE1BQU0sTUFBTSxJQUFJO0FBQUEsVUFDMUM7QUFBQSxVQUNBLE1BQU07QUFBQSxVQUNOLE1BQU07QUFBQSxVQUNOLENBQUM7QUFBQSxRQUNGO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFDQTtBQUFBLEVBQ0Q7QUFFQSxNQUFJLE1BQU0sU0FBUyxRQUFRO0FBQzFCLGVBQVcsUUFBUSxNQUFNLE9BQU87QUFDL0IsWUFBTTtBQUFBLFFBQ0w7QUFBQSxVQUNDLEtBQUs7QUFBQSxVQUNMLEtBQUs7QUFBQSxVQUNMLEtBQUssVUFBVSxzQkFBc0I7QUFBQSxVQUNyQyxLQUFLO0FBQUEsVUFDTDtBQUFBLFVBQ0EsS0FBSztBQUFBLFVBQ0wsS0FBSztBQUFBLFVBQ0wsS0FBSztBQUFBLFFBQ047QUFBQSxNQUNEO0FBQ0EsaUJBQVcsU0FBUyxLQUFLLFVBQVU7QUFDbEMseUJBQWlCLE9BQU8sS0FBSztBQUFBLE1BQzlCO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUVBLFNBQVMsZUFDUixLQUNBLE9BQ0EsTUFDQSxRQUNBLG1CQUNBLFFBQ0EsWUFBWSxHQUNaLGFBQWEsR0FDYixlQUFlLEdBQ0Y7QUFDYixRQUFNLGVBQWUsTUFBTSxRQUFRLE9BQU87QUFDMUMsU0FBTztBQUFBLElBQ04sSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLElBQ1A7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLGFBQWEsT0FBTyxTQUFTLElBQUksRUFBRSxPQUFPLE1BQU0sT0FBTyxLQUFLLGFBQWEsSUFBSTtBQUFBLElBQzdFLGNBQWMsRUFBRSxPQUFPLGNBQWMsS0FBSyxNQUFNLElBQUk7QUFBQSxJQUNwRDtBQUFBLElBQ0E7QUFBQSxFQUNEO0FBQ0Q7QUFFQSxTQUFTLFlBQVksS0FBNkI7QUFDakQsUUFBTSxpQkFBaUIsSUFBSSxNQUFNLDJCQUEyQjtBQUM1RCxNQUFJLGdCQUFnQjtBQUNuQixXQUFPO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsTUFDWixjQUFjO0FBQUEsTUFDZCxRQUFRO0FBQUEsTUFDUixVQUFVLGVBQWUsQ0FBQyxLQUFLO0FBQUEsSUFDaEM7QUFBQSxFQUNEO0FBRUEsUUFBTSxpQkFBaUIsSUFBSSxNQUFNLGdCQUFnQjtBQUNqRCxNQUFJLGdCQUFnQjtBQUNuQixXQUFPO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixXQUFXLGVBQWUsQ0FBQyxFQUFFLFNBQVMsSUFBSTtBQUFBLE1BQzFDLFlBQVk7QUFBQSxNQUNaLGNBQWM7QUFBQSxNQUNkLFFBQVEsZUFBZSxDQUFDO0FBQUEsTUFDeEIsVUFBVTtBQUFBLElBQ1g7QUFBQSxFQUNEO0FBRUEsUUFBTSxlQUFlLElBQUksTUFBTSxzQkFBc0I7QUFDckQsTUFBSSxjQUFjO0FBQ2pCLFdBQU87QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLFdBQVcsYUFBYSxDQUFDLEVBQUUsU0FBUyxJQUFJO0FBQUEsTUFDeEMsWUFBWSxPQUFPLFNBQVMsYUFBYSxDQUFDLEdBQUcsRUFBRTtBQUFBLE1BQy9DLGNBQWM7QUFBQSxNQUNkLFFBQVEsYUFBYSxDQUFDO0FBQUEsTUFDdEIsVUFBVTtBQUFBLElBQ1g7QUFBQSxFQUNEO0FBRUEsUUFBTSxlQUFlLElBQUksTUFBTSxjQUFjO0FBQzdDLE1BQUksY0FBYztBQUNqQixXQUFPO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsTUFDWixjQUFjLGFBQWEsQ0FBQyxFQUFFO0FBQUEsTUFDOUIsUUFBUSxhQUFhLENBQUM7QUFBQSxNQUN0QixVQUFVO0FBQUEsSUFDWDtBQUFBLEVBQ0Q7QUFFQSxTQUFPO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixXQUFXO0FBQUEsSUFDWCxZQUFZO0FBQUEsSUFDWixjQUFjO0FBQUEsSUFDZCxRQUFRO0FBQUEsSUFDUixVQUFVO0FBQUEsRUFDWDtBQUNEO0FBRUEsU0FBUyxZQUFZLEtBQWEsYUFBbUM7QUFDcEUsUUFBTSxTQUF1QixDQUFDO0FBQzlCLE1BQUksUUFBUTtBQUVaLFNBQU8sUUFBUSxJQUFJLFFBQVE7QUFDMUIsVUFBTSxnQkFBZ0IsbUJBQW1CLEtBQUssYUFBYSxLQUFLO0FBQ2hFLFFBQUksZUFBZTtBQUNsQixhQUFPLEtBQUssY0FBYyxJQUFJO0FBQzlCLGNBQVEsY0FBYztBQUN0QjtBQUFBLElBQ0Q7QUFFQSxRQUFJLGFBQWEsSUFBSTtBQUNyQixVQUFNLFlBQVksSUFBSSxRQUFRLEtBQUssS0FBSztBQUN4QyxRQUFJLGNBQWMsR0FBSSxjQUFhO0FBQ25DLFVBQU0sZ0JBQWdCLElBQUksUUFBUSxLQUFLLEtBQUs7QUFDNUMsUUFBSSxrQkFBa0IsR0FBSSxjQUFhLEtBQUssSUFBSSxZQUFZLGFBQWE7QUFFekUsUUFBSSxlQUFlLE9BQU87QUFDekIsYUFBTyxLQUFLO0FBQUEsUUFDWCxNQUFNO0FBQUEsUUFDTixPQUFPLEVBQUUsT0FBTyxjQUFjLE9BQU8sS0FBSyxjQUFjLFFBQVEsRUFBRTtBQUFBLFFBQ2xFLE1BQU0sSUFBSSxLQUFLO0FBQUEsTUFDaEIsQ0FBb0I7QUFDcEIsZUFBUztBQUNUO0FBQUEsSUFDRDtBQUVBLFVBQU0sT0FBTyxJQUFJLE1BQU0sT0FBTyxVQUFVO0FBQ3hDLFdBQU8sS0FBSztBQUFBLE1BQ1gsTUFBTTtBQUFBLE1BQ04sT0FBTyxFQUFFLE9BQU8sY0FBYyxPQUFPLEtBQUssY0FBYyxXQUFXO0FBQUEsTUFDbkU7QUFBQSxJQUNELENBQW9CO0FBQ3BCLFlBQVE7QUFBQSxFQUNUO0FBRUEsU0FBTztBQUNSO0FBRUEsU0FBUyxtQkFBbUIsS0FBYSxhQUFxQixPQUFlO0FBQzVFLGFBQVcsVUFBVSxDQUFDLEtBQUssT0FBTyxNQUFNLEdBQUcsR0FBWTtBQUN0RCxRQUFJLENBQUMsSUFBSSxXQUFXLFFBQVEsS0FBSyxFQUFHO0FBRXBDLFVBQU0sUUFBUSxJQUFJLFFBQVEsUUFBUSxRQUFRLE9BQU8sTUFBTTtBQUN2RCxRQUFJLFVBQVUsR0FBSTtBQUVsQixVQUFNLGVBQWUsUUFBUSxPQUFPO0FBQ3BDLFVBQU0sYUFBYTtBQUNuQixRQUFJLGdCQUFnQixXQUFZO0FBQ2hDLFFBQUksV0FBVyxRQUFRLElBQUksWUFBWSxNQUFNLE9BQU8sSUFBSSxhQUFhLENBQUMsTUFBTSxLQUFNO0FBRWxGLFVBQU0sT0FDTCxXQUFXLE1BQ1IsU0FDQSxXQUFXLFFBQ1Ysb0JBQ0EsV0FBVyxPQUNWLFdBQ0E7QUFFTixXQUFPO0FBQUEsTUFDTixNQUFNO0FBQUEsUUFDTDtBQUFBLFFBQ0EsT0FBTztBQUFBLFVBQ04sT0FBTyxjQUFjO0FBQUEsVUFDckIsS0FBSyxjQUFjLFFBQVEsT0FBTztBQUFBLFFBQ25DO0FBQUEsUUFDQSxjQUFjO0FBQUEsVUFDYixPQUFPLGNBQWM7QUFBQSxVQUNyQixLQUFLLGNBQWM7QUFBQSxRQUNwQjtBQUFBLFFBQ0E7QUFBQSxRQUNBLE1BQU0sSUFBSSxNQUFNLGNBQWMsVUFBVTtBQUFBLE1BQ3pDO0FBQUEsTUFDQSxXQUFXLFFBQVEsT0FBTztBQUFBLElBQzNCO0FBQUEsRUFDRDtBQUVBLFNBQU87QUFDUjtBQUVBLFNBQVMsbUJBQW1CLFFBQThCO0FBQ3pELFNBQU8sT0FDTCxJQUFJLENBQUMsU0FBUztBQUNkLFFBQUksS0FBSyxTQUFTLFFBQVE7QUFDekIsYUFBTyxpQkFBaUIsS0FBSyxJQUFJO0FBQUEsSUFDbEM7QUFFQSxVQUFNLFVBQVUsV0FBVyxLQUFLLElBQUk7QUFFcEMsUUFBSSxLQUFLLFNBQVMsUUFBUTtBQUN6QixZQUFNQSxVQUFTLDJDQUEyQyxXQUFXLEtBQUssTUFBTSxDQUFDO0FBQ2pGLGFBQU8sNkJBQTZCQSxPQUFNLEdBQUcsT0FBTyxHQUFHQSxPQUFNO0FBQUEsSUFDOUQ7QUFFQSxVQUFNLFNBQVMsK0JBQStCLFdBQVcsS0FBSyxNQUFNLENBQUM7QUFFckUsUUFBSSxLQUFLLFNBQVMsWUFBWTtBQUM3QixhQUFPLEdBQUcsTUFBTSxPQUFPLE9BQU8sUUFBUSxNQUFNO0FBQUEsSUFDN0M7QUFFQSxRQUFJLEtBQUssU0FBUyxVQUFVO0FBQzNCLGFBQU8sR0FBRyxNQUFNLFdBQVcsT0FBTyxZQUFZLE1BQU07QUFBQSxJQUNyRDtBQUVBLFdBQU8sR0FBRyxNQUFNLGVBQWUsT0FBTyxpQkFBaUIsTUFBTTtBQUFBLEVBQzlELENBQUMsRUFDQSxLQUFLLEVBQUU7QUFDVjtBQUVBLFNBQVMscUJBQ1IsWUFDQSxPQUNBLE9BQ0EsS0FDUztBQUNULE1BQUksT0FBTyxNQUFNLE1BQU0sU0FBUyxTQUFTLE1BQU0sTUFBTSxJQUFLLFFBQU87QUFFakUsTUFBSSxNQUFNLFNBQVMsYUFBYTtBQUMvQixXQUFPLE1BQU0sOEJBQThCLFlBQVksTUFBTSxRQUFRLE9BQU8sR0FBRyxLQUFLLE1BQU07QUFBQSxFQUMzRjtBQUVBLE1BQUksTUFBTSxTQUFTLFdBQVc7QUFDN0IsVUFBTUMsT0FBTSxJQUFJLE1BQU0sS0FBSztBQUMzQixXQUFPLElBQUlBLElBQUcsSUFBSSw4QkFBOEIsWUFBWSxNQUFNLFFBQVEsT0FBTyxHQUFHLEtBQUssTUFBTSxLQUFLQSxJQUFHO0FBQUEsRUFDeEc7QUFFQSxNQUFJLE1BQU0sU0FBUyxjQUFjO0FBQ2hDLFVBQU0sWUFBc0IsQ0FBQztBQUM3QixlQUFXLFFBQVEsTUFBTSxPQUFPO0FBQy9CLFVBQUksT0FBTyxLQUFLLE1BQU0sU0FBUyxTQUFTLEtBQUssTUFBTSxJQUFLO0FBQ3hELGdCQUFVLEtBQUssdUJBQXVCLFdBQVcsWUFBWSxLQUFLLE9BQU8sT0FBTyxHQUFHLENBQUMsQ0FBQztBQUFBLElBQ3RGO0FBQ0EsV0FBTyxjQUFjLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxFQUMxQztBQUVBLFFBQU0sTUFBTSxNQUFNLFVBQVUsT0FBTztBQUNuQyxRQUFNLFFBQVEsTUFBTSxNQUNsQixJQUFJLENBQUMsU0FBUyx3QkFBd0IsWUFBWSxNQUFNLE9BQU8sR0FBRyxDQUFDLEVBQ25FLE9BQU8sT0FBTyxFQUNkLEtBQUssRUFBRTtBQUNULFNBQU8sUUFBUSxJQUFJLEdBQUcsSUFBSSxLQUFLLEtBQUssR0FBRyxNQUFNO0FBQzlDO0FBRUEsU0FBUyx3QkFDUixZQUNBLE1BQ0EsT0FDQSxLQUNTO0FBQ1QsTUFBSSxPQUFPLEtBQUssTUFBTSxTQUFTLFNBQVMsS0FBSyxNQUFNLElBQUssUUFBTztBQUUvRCxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxhQUFhLDhCQUE4QixZQUFZLEtBQUssUUFBUSxPQUFPLEdBQUc7QUFDcEYsUUFBTSxLQUFLLGNBQWMsTUFBTTtBQUUvQixhQUFXLFNBQVMsS0FBSyxVQUFVO0FBQ2xDLFVBQU0sWUFBWSxxQkFBcUIsWUFBWSxPQUFPLE9BQU8sR0FBRztBQUNwRSxRQUFJLFVBQVcsT0FBTSxLQUFLLFNBQVM7QUFBQSxFQUNwQztBQUVBLFNBQU8sT0FBTyxNQUFNLEtBQUssRUFBRSxDQUFDO0FBQzdCO0FBRUEsU0FBUyw4QkFDUixZQUNBLFFBQ0EsT0FDQSxLQUNTO0FBQ1QsTUFBSSxTQUFTLElBQUssUUFBTztBQUV6QixRQUFNLFFBQWtCLENBQUM7QUFFekIsYUFBVyxRQUFRLFFBQVE7QUFDMUIsUUFBSSxLQUFLLFNBQVMsUUFBUTtBQUN6QixZQUFNLFFBQVEsV0FBVyxZQUFZLEtBQUssT0FBTyxPQUFPLEdBQUc7QUFDM0QsVUFBSSxNQUFPLE9BQU0sS0FBSyx1QkFBdUIsS0FBSyxDQUFDO0FBQ25EO0FBQUEsSUFDRDtBQUVBLFVBQU0sYUFBYSxXQUFXLFlBQVksS0FBSyxjQUFjLE9BQU8sR0FBRztBQUN2RSxRQUFJLENBQUMsV0FBWTtBQUVqQixRQUFJLEtBQUssU0FBUyxZQUFZO0FBQzdCLFlBQU0sS0FBSyxPQUFPLHVCQUF1QixVQUFVLENBQUMsT0FBTztBQUMzRDtBQUFBLElBQ0Q7QUFFQSxRQUFJLEtBQUssU0FBUyxVQUFVO0FBQzNCLFlBQU0sS0FBSyxXQUFXLHVCQUF1QixVQUFVLENBQUMsV0FBVztBQUNuRTtBQUFBLElBQ0Q7QUFFQSxRQUFJLEtBQUssU0FBUyxRQUFRO0FBQ3pCLFlBQU0sS0FBSyxTQUFTLHVCQUF1QixVQUFVLENBQUMsU0FBUztBQUMvRDtBQUFBLElBQ0Q7QUFFQSxVQUFNLEtBQUssZUFBZSx1QkFBdUIsVUFBVSxDQUFDLGdCQUFnQjtBQUFBLEVBQzdFO0FBRUEsU0FBTyxNQUFNLEtBQUssRUFBRTtBQUNyQjtBQUVBLFNBQVMsV0FDUixZQUNBLE9BQ0EsZ0JBQ0EsY0FDUztBQUNULFFBQU0sUUFBUSxLQUFLLElBQUksTUFBTSxPQUFPLGNBQWM7QUFDbEQsUUFBTSxNQUFNLEtBQUssSUFBSSxNQUFNLEtBQUssWUFBWTtBQUM1QyxNQUFJLFNBQVMsSUFBSyxRQUFPO0FBQ3pCLFNBQU8sV0FBVyxNQUFNLE9BQU8sR0FBRztBQUNuQztBQUVBLFNBQVMsaUJBQWlCLE1BQXNCO0FBQy9DLFNBQU8sS0FBSyxXQUFXLElBQUksS0FBSyxXQUFXLElBQUk7QUFDaEQ7QUFFQSxTQUFTLFdBQVcsTUFBc0I7QUFDekMsU0FBTyxLQUFLLFFBQVEsTUFBTSxPQUFPLEVBQUUsUUFBUSxNQUFNLE1BQU0sRUFBRSxRQUFRLE1BQU0sTUFBTTtBQUM5RTtBQUVBLFNBQVMsdUJBQXVCLE1BQXNCO0FBQ3JELFNBQU8sV0FBVyxJQUFJLEVBQUUsUUFBUSxNQUFNLFFBQVEsRUFBRSxRQUFRLE9BQU8sMEJBQTBCO0FBQzFGOzs7QUM1cUJPLFNBQVMsNEJBQ2YsTUFDQSxlQUNBLFdBQ2E7QUFDYixRQUFNLFdBQVcsY0FBYyxJQUFJO0FBQ25DLFFBQU0sZUFBa0MsQ0FBQztBQUV6QyxpQ0FBK0IsU0FBUyxRQUFRLGVBQWUsWUFBWTtBQUUzRSxNQUFJLGFBQWEsV0FBVyxHQUFHO0FBQzlCLFdBQU87QUFBQSxNQUNOO0FBQUEsTUFDQSxnQkFBZ0IsVUFBVTtBQUFBLE1BQzFCLGNBQWMsVUFBVTtBQUFBLElBQ3pCO0FBQUEsRUFDRDtBQUVBLGVBQWEsS0FBSyxDQUFDLE1BQU0sVUFBVSxNQUFNLFFBQVEsS0FBSyxLQUFLO0FBRTNELE1BQUksV0FBVztBQUNmLE1BQUksaUJBQWlCLFVBQVU7QUFDL0IsTUFBSSxlQUFlLFVBQVU7QUFFN0IsYUFBVyxlQUFlLGNBQWM7QUFDdkMsVUFBTSxpQkFBaUIsWUFBWSxNQUFNLFlBQVk7QUFDckQsVUFBTSxRQUFRLFlBQVksS0FBSyxTQUFTO0FBQ3hDLGVBQ0MsU0FBUyxNQUFNLEdBQUcsWUFBWSxLQUFLLElBQUksWUFBWSxPQUFPLFNBQVMsTUFBTSxZQUFZLEdBQUc7QUFDekYscUJBQWlCO0FBQUEsTUFDaEI7QUFBQSxNQUNBLFlBQVk7QUFBQSxNQUNaLFlBQVk7QUFBQSxNQUNaLFlBQVksS0FBSztBQUFBLE1BQ2pCO0FBQUEsSUFDRDtBQUNBLG1CQUFlO0FBQUEsTUFDZDtBQUFBLE1BQ0EsWUFBWTtBQUFBLE1BQ1osWUFBWTtBQUFBLE1BQ1osWUFBWSxLQUFLO0FBQUEsTUFDakI7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUVBLFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQTtBQUFBLEVBQ0Q7QUFDRDtBQUVBLFNBQVMsK0JBQ1IsUUFDQSxlQUNBLGNBQ1U7QUFDVixNQUFJLHFCQUFxQjtBQUV6QixhQUFXLFNBQVMsUUFBUTtBQUMzQixRQUFJLGdCQUFnQixnQkFBZ0IsTUFBTSxPQUFPLGFBQWE7QUFFOUQsUUFBSSxNQUFNLFNBQVMsUUFBUTtBQUMxQiw4QkFBd0IsT0FBTyxlQUFlLFlBQVk7QUFFMUQsaUJBQVcsUUFBUSxNQUFNLE9BQU87QUFDL0IsY0FBTSxtQkFBbUI7QUFBQSxVQUN4QixLQUFLO0FBQUEsVUFDTDtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQ0EsWUFBSSxrQkFBa0I7QUFDckIsNENBQWtDLEtBQUssVUFBVSxlQUFlLFlBQVk7QUFDNUUsMEJBQWdCO0FBQUEsUUFDakI7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUVBLFFBQUksZUFBZTtBQUNsQiwyQkFBcUI7QUFBQSxJQUN0QjtBQUFBLEVBQ0Q7QUFFQSxTQUFPO0FBQ1I7QUFFQSxTQUFTLHdCQUNSLE9BQ0EsZUFDQSxjQUNDO0FBQ0QsTUFBSSxDQUFDLE1BQU0sV0FBVyxDQUFDLGdCQUFnQixNQUFNLE9BQU8sYUFBYSxHQUFHO0FBQ25FO0FBQUEsRUFDRDtBQUVBLFdBQVMsUUFBUSxHQUFHLFFBQVEsTUFBTSxNQUFNLFFBQVEsU0FBUztBQUN4RCxVQUFNLE9BQU8sTUFBTSxNQUFNLEtBQUs7QUFDOUIsVUFBTSxpQkFBaUIsUUFBUTtBQUMvQixRQUFJLEtBQUssV0FBVyxlQUFnQjtBQUVwQyxpQkFBYSxLQUFLO0FBQUEsTUFDakIsT0FBTyxLQUFLLFVBQVU7QUFBQSxNQUN0QixLQUFLLEtBQUssVUFBVSxRQUFRLEtBQUssT0FBTztBQUFBLE1BQ3hDLE1BQU0sR0FBRyxPQUFPLE9BQU8sS0FBSyxRQUFRLENBQUMsQ0FBQyxHQUFHLGNBQWM7QUFBQSxJQUN4RCxDQUFDO0FBQUEsRUFDRjtBQUNEO0FBRUEsU0FBUyxrQ0FDUixRQUNBLGVBQ0EsY0FDQztBQUNELGFBQVcsU0FBUyxRQUFRO0FBQzNCLFFBQUksTUFBTSxTQUFTLFVBQVUsQ0FBQyxNQUFNLFdBQVcsZ0JBQWdCLE1BQU0sT0FBTyxhQUFhLEdBQUc7QUFDM0Y7QUFBQSxJQUNEO0FBRUEsNEJBQXdCLE9BQU8sTUFBTSxPQUFPLFlBQVk7QUFBQSxFQUN6RDtBQUNEO0FBRUEsU0FBUyxnQkFBZ0IsTUFBc0IsT0FBdUI7QUFDckUsU0FBTyxLQUFLLFNBQVMsTUFBTSxPQUFPLE1BQU0sU0FBUyxLQUFLO0FBQ3ZEO0FBRUEsU0FBUyxxQkFDUixPQUNBLE9BQ0EsS0FDQSxtQkFDQSxPQUNDO0FBQ0QsTUFBSSxRQUFRLEtBQUs7QUFDaEIsV0FBTyxRQUFRO0FBQUEsRUFDaEI7QUFFQSxNQUFJLFNBQVMsT0FBTztBQUNuQixXQUFPLFFBQVEsS0FBSyxJQUFJLFFBQVEsT0FBTyxpQkFBaUI7QUFBQSxFQUN6RDtBQUVBLFNBQU87QUFDUjs7O0FGdkxBLFNBQVMsWUFBWSxRQUFnQjtBQUNwQyxRQUFNLFdBQVcsY0FBYyxNQUFNO0FBQ3JDLFNBQU8sTUFBTSxTQUFTLE1BQU0sUUFBUSxDQUFDO0FBQ3JDLFNBQU8sRUFBRSxVQUFVLE1BQU0sU0FBUyxNQUFNLENBQUMsRUFBRztBQUM3QztBQUVBLEtBQUssZ0RBQWdELE1BQU07QUFDMUQsUUFBTSxFQUFFLFVBQVUsS0FBSyxJQUFJLFlBQVksRUFBRTtBQUV6QyxTQUFPLE1BQU0sU0FBUyxNQUFNLEVBQUU7QUFDOUIsU0FBTyxNQUFNLFNBQVMsT0FBTyxRQUFRLENBQUM7QUFDdEMsU0FBTyxNQUFNLFNBQVMsT0FBTyxDQUFDLEdBQUcsTUFBTSxXQUFXO0FBQ2xELFNBQU8sTUFBTSxLQUFLLEtBQUssRUFBRTtBQUN6QixTQUFPLE1BQU0saUJBQWlCLElBQUksR0FBRyxvREFBb0Q7QUFDMUYsQ0FBQztBQUVELEtBQUssMkRBQTJELE1BQU07QUFDckUsUUFBTSxXQUFXLGNBQWMsc0JBQXNCO0FBRXJELFNBQU8sTUFBTSxTQUFTLE1BQU0sb0JBQW9CO0FBQ2hELFNBQU8sTUFBTSxTQUFTLE1BQU0sUUFBUSxDQUFDO0FBQ3JDLFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLEtBQUssT0FBTztBQUM1QyxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxLQUFLLE1BQU07QUFDM0MsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsS0FBSyxPQUFPO0FBQzdDLENBQUM7QUFFRCxLQUFLLDhDQUE4QyxNQUFNO0FBQ3hELFFBQU0sRUFBRSxLQUFLLElBQUksWUFBWSxjQUFjO0FBRTNDLFNBQU87QUFBQSxJQUNOLGlCQUFpQixJQUFJO0FBQUEsSUFDckI7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssMENBQTBDLE1BQU07QUFDcEQsUUFBTSxFQUFFLEtBQUssSUFBSSxZQUFZLEdBQUc7QUFFaEMsU0FBTyxNQUFNLEtBQUssT0FBTyxRQUFRLENBQUM7QUFDbEMsU0FBTyxVQUFVLEtBQUssT0FBTyxDQUFDLEdBQUc7QUFBQSxJQUNoQyxNQUFNO0FBQUEsSUFDTixPQUFPLEVBQUUsT0FBTyxHQUFHLEtBQUssRUFBRTtBQUFBLElBQzFCLE1BQU07QUFBQSxFQUNQLENBQUM7QUFDRCxTQUFPLE1BQU0saUJBQWlCLElBQUksR0FBRyxpREFBaUQ7QUFDdkYsQ0FBQztBQUVELEtBQUssa0VBQWtFLE1BQU07QUFDNUUsUUFBTSxFQUFFLEtBQUssSUFBSSxZQUFZLElBQUk7QUFFakMsU0FBTyxNQUFNLEtBQUssT0FBTyxRQUFRLENBQUM7QUFDbEMsU0FBTyxVQUFVLEtBQUssT0FBTyxDQUFDLEdBQUc7QUFBQSxJQUNoQyxNQUFNO0FBQUEsSUFDTixPQUFPLEVBQUUsT0FBTyxHQUFHLEtBQUssRUFBRTtBQUFBLElBQzFCLE1BQU07QUFBQSxFQUNQLENBQUM7QUFDRCxTQUFPLFVBQVUsS0FBSyxPQUFPLENBQUMsR0FBRztBQUFBLElBQ2hDLE1BQU07QUFBQSxJQUNOLE9BQU8sRUFBRSxPQUFPLEdBQUcsS0FBSyxFQUFFO0FBQUEsSUFDMUIsTUFBTTtBQUFBLEVBQ1AsQ0FBQztBQUNELFNBQU8sTUFBTSxpQkFBaUIsSUFBSSxHQUFHLGtEQUFrRDtBQUN4RixDQUFDO0FBRUQsS0FBSyx3REFBd0QsTUFBTTtBQUNsRSxRQUFNLGVBQWUsWUFBWSxNQUFNLEVBQUU7QUFDekMsUUFBTSxlQUFlLFlBQVksUUFBUSxFQUFFO0FBRTNDLFNBQU8sTUFBTSxpQkFBaUIsWUFBWSxHQUFHLG9EQUFvRDtBQUNqRyxTQUFPLE1BQU0saUJBQWlCLFlBQVksR0FBRyxzREFBc0Q7QUFDcEcsQ0FBQztBQUVELEtBQUssaUVBQWlFLE1BQU07QUFDM0UsUUFBTSxFQUFFLEtBQUssSUFBSSxZQUFZLFNBQVM7QUFFdEMsU0FBTyxNQUFNLEtBQUssT0FBTyxRQUFRLENBQUM7QUFDbEMsU0FBTyxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsTUFBTSxVQUFVO0FBQzdDLFNBQU87QUFBQSxJQUNOLGlCQUFpQixJQUFJO0FBQUEsSUFDckI7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUsscURBQXFELE1BQU07QUFDL0QsUUFBTSxTQUFTLFlBQVksVUFBVSxFQUFFO0FBQ3ZDLFFBQU0saUJBQWlCLFlBQVksWUFBWSxFQUFFO0FBRWpELFNBQU8sTUFBTSxPQUFPLE9BQU8sQ0FBQyxHQUFHLE1BQU0sUUFBUTtBQUM3QyxTQUFPO0FBQUEsSUFDTixpQkFBaUIsTUFBTTtBQUFBLElBQ3ZCO0FBQUEsRUFDRDtBQUVBLFNBQU8sTUFBTSxlQUFlLE9BQU8sQ0FBQyxHQUFHLE1BQU0saUJBQWlCO0FBQzlELFNBQU87QUFBQSxJQUNOLGlCQUFpQixjQUFjO0FBQUEsSUFDL0I7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssdURBQXVELE1BQU07QUFDakUsUUFBTSxFQUFFLEtBQUssSUFBSSxZQUFZLGtCQUFrQjtBQUUvQyxTQUFPLE1BQU0sS0FBSyxPQUFPLENBQUMsR0FBRyxNQUFNLE1BQU07QUFDekMsU0FBTztBQUFBLElBQ04saUJBQWlCLElBQUk7QUFBQSxJQUNyQjtBQUFBLEVBQ0Q7QUFDRCxDQUFDO0FBRUQsS0FBSyxrREFBa0QsTUFBTTtBQUM1RCxRQUFNLEVBQUUsS0FBSyxJQUFJLFlBQVksaUJBQWlCO0FBRTlDLFNBQU87QUFBQSxJQUNOLGlCQUFpQixJQUFJO0FBQUEsSUFDckI7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssbUVBQW1FLE1BQU07QUFDN0UsUUFBTSxFQUFFLEtBQUssSUFBSSxZQUFZLG9CQUFvQjtBQUVqRCxTQUFPLE1BQU0sS0FBSyxPQUFPLENBQUMsR0FBRyxNQUFNLE1BQU07QUFDekMsU0FBTyxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsTUFBTSxTQUFTO0FBQzVDLFNBQU87QUFBQSxJQUNOLGlCQUFpQixJQUFJO0FBQUEsSUFDckI7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssZ0ZBQWdGLE1BQU07QUFDMUYsUUFBTSxlQUFlLFlBQVksU0FBUyxFQUFFO0FBQzVDLFFBQU0sZ0JBQWdCLFlBQVksU0FBUyxFQUFFO0FBRTdDLFNBQU8sTUFBTSxpQkFBaUIsWUFBWSxHQUFHLHVEQUF1RDtBQUNwRyxTQUFPLE1BQU0saUJBQWlCLGFBQWEsR0FBRyx1REFBdUQ7QUFDdEcsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDdEUsUUFBTSxFQUFFLFVBQVUsS0FBSyxJQUFJLFlBQVksV0FBVztBQUNsRCxRQUFNLFFBQVEsU0FBUyxPQUFPLENBQUM7QUFFL0IsU0FBTyxNQUFNLE9BQU8sTUFBTSxTQUFTO0FBQ25DLFNBQU8sTUFBTSxPQUFPLE9BQU8sQ0FBQztBQUM1QixTQUFPLE1BQU0sS0FBSyxNQUFNLFNBQVM7QUFDakMsU0FBTyxNQUFNLEtBQUssY0FBYyxDQUFDO0FBQ2pDLFNBQU8sTUFBTSxLQUFLLFFBQVEsTUFBTTtBQUNoQyxTQUFPO0FBQUEsSUFDTixpQkFBaUIsSUFBSTtBQUFBLElBQ3JCO0FBQUEsRUFDRDtBQUNELENBQUM7QUFFRCxLQUFLLDZEQUE2RCxNQUFNO0FBQ3ZFLFFBQU0sU0FBUztBQUNmLFFBQU0sV0FBVyxjQUFjLE1BQU07QUFDckMsUUFBTSxRQUFRLFNBQVMsT0FBTyxDQUFDO0FBRS9CLFNBQU8sTUFBTSxPQUFPLE1BQU0sTUFBTTtBQUNoQyxTQUFPLE1BQU0sT0FBTyxTQUFTLEtBQUs7QUFDbEMsU0FBTyxNQUFNLE9BQU8sTUFBTSxRQUFRLENBQUM7QUFDbkMsU0FBTyxNQUFNLE9BQU8sTUFBTSxDQUFDLEdBQUcsU0FBUyxRQUFRLENBQUM7QUFDaEQsU0FBTyxNQUFNLE9BQU8sTUFBTSxDQUFDLEdBQUcsU0FBUyxDQUFDLEdBQUcsTUFBTSxNQUFNO0FBRXZELFNBQU8sTUFBTSxTQUFTLE1BQU0sUUFBUSxDQUFDO0FBQ3JDLFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLE1BQU0scUJBQXFCO0FBQzNELFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLFdBQVcsQ0FBQztBQUM1QyxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxNQUFNLHFCQUFxQjtBQUMzRCxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxXQUFXLENBQUM7QUFDNUMsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsTUFBTSxxQkFBcUI7QUFDM0QsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsV0FBVyxDQUFDO0FBQzdDLENBQUM7QUFFRCxLQUFLLGlFQUFpRSxNQUFNO0FBQzNFLFFBQU0sU0FBUztBQUNmLFFBQU0sV0FBVyxjQUFjLE1BQU07QUFFckMsU0FBTyxNQUFNLFNBQVMsTUFBTSxRQUFRLENBQUM7QUFDckMsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsTUFBTSxtQkFBbUI7QUFDekQsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsWUFBWSxFQUFFO0FBQzlDLFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLFdBQVcsQ0FBQztBQUM1QyxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxNQUFNLG1CQUFtQjtBQUN6RCxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxZQUFZLENBQUM7QUFDN0MsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsV0FBVyxDQUFDO0FBQzdDLENBQUM7QUFFRCxLQUFLLDZFQUE2RSxNQUFNO0FBQ3ZGLFFBQU0sV0FBVyxZQUFZLFFBQVEsRUFBRTtBQUN2QyxRQUFNLFNBQVMsWUFBWSxZQUFZLEVBQUU7QUFFekMsU0FBTztBQUFBLElBQ04saUJBQWlCLFFBQVE7QUFBQSxJQUN6QjtBQUFBLEVBQ0Q7QUFDQSxTQUFPO0FBQUEsSUFDTixpQkFBaUIsTUFBTTtBQUFBLElBQ3ZCO0FBQUEsRUFDRDtBQUNELENBQUM7QUFFRCxLQUFLLG9GQUFvRixNQUFNO0FBQzlGLFFBQU0sV0FBVyxZQUFZLFVBQVUsRUFBRTtBQUN6QyxRQUFNLFNBQVMsWUFBWSxjQUFjLEVBQUU7QUFFM0MsU0FBTztBQUFBLElBQ04saUJBQWlCLFFBQVE7QUFBQSxJQUN6QjtBQUFBLEVBQ0Q7QUFDQSxTQUFPO0FBQUEsSUFDTixpQkFBaUIsTUFBTTtBQUFBLElBQ3ZCO0FBQUEsRUFDRDtBQUNELENBQUM7QUFFRCxLQUFLLGlFQUFpRSxNQUFNO0FBQzNFLFFBQU0sV0FBVyxjQUFjLDBCQUEwQjtBQUV6RCxTQUFPLE1BQU0sU0FBUyxPQUFPLFFBQVEsQ0FBQztBQUN0QyxTQUFPLE1BQU0sU0FBUyxPQUFPLENBQUMsR0FBRyxNQUFNLFlBQVk7QUFDbkQsU0FBTyxNQUFNLFNBQVMsTUFBTSxRQUFRLENBQUM7QUFDckMsU0FBTyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsTUFBTSxZQUFZO0FBQ2xELFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLG1CQUFtQixJQUFJO0FBQ3ZELFNBQU8sTUFBTSxTQUFTLE1BQU0sQ0FBQyxHQUFHLE1BQU0sY0FBYztBQUNwRCxTQUFPLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxNQUFNLFlBQVk7QUFDbEQsU0FBTztBQUFBLElBQ04saUJBQWlCLFNBQVMsTUFBTSxDQUFDLENBQUU7QUFBQSxJQUNuQztBQUFBLEVBQ0Q7QUFDQSxTQUFPO0FBQUEsSUFDTixpQkFBaUIsU0FBUyxNQUFNLENBQUMsQ0FBRTtBQUFBLElBQ25DO0FBQUEsRUFDRDtBQUNELENBQUM7QUFFRCxLQUFLLHdFQUF3RSxNQUFNO0FBQ2xGLFFBQU0sV0FBVyxjQUFjLFNBQVM7QUFFeEMsU0FBTztBQUFBLElBQ04sb0JBQW9CLFVBQVUsR0FBRyxDQUFDO0FBQUEsSUFDbEM7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssZ0VBQWdFLE1BQU07QUFDMUUsUUFBTSxXQUFXLGNBQWMsVUFBVTtBQUV6QyxTQUFPO0FBQUEsSUFDTixvQkFBb0IsVUFBVSxHQUFHLFNBQVMsS0FBSyxNQUFNO0FBQUEsSUFDckQ7QUFBQSxFQUNEO0FBQ0QsQ0FBQztBQUVELEtBQUssOEVBQThFLE1BQU07QUFDeEYsUUFBTSxXQUFXLGNBQWMsWUFBWTtBQUUzQyxTQUFPO0FBQUEsSUFDTixvQkFBb0IsVUFBVSxHQUFHLENBQUM7QUFBQSxJQUNsQztBQUFBLEVBQ0Q7QUFDRCxDQUFDO0FBRUQsS0FBSyx3RUFBd0UsTUFBTTtBQUNsRixRQUFNLFdBQVcsY0FBYyxVQUFVO0FBRXpDLFNBQU87QUFBQSxJQUNOLG9CQUFvQixVQUFVLEdBQUcsQ0FBQztBQUFBLElBQ2xDO0FBQUEsRUFDRDtBQUNELENBQUM7QUFFRCxLQUFLLDZEQUE2RCxNQUFNO0FBQ3ZFLFFBQU0sV0FBVyxjQUFjLGlCQUFpQjtBQUVoRCxTQUFPO0FBQUEsSUFDTixvQkFBb0IsVUFBVSxHQUFHLEVBQUU7QUFBQSxJQUNuQztBQUFBLEVBQ0Q7QUFDRCxDQUFDO0FBRUQsS0FBSyx1REFBdUQsTUFBTTtBQUNqRSxRQUFNLFdBQVcsY0FBYyxrQkFBa0I7QUFDakQsUUFBTSxRQUFRLFNBQVMsS0FBSyxRQUFRLE9BQU87QUFDM0MsUUFBTSxNQUFNLFFBQVEsUUFBUTtBQUU1QixTQUFPO0FBQUEsSUFDTixvQkFBb0IsVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUN4QztBQUFBLEVBQ0Q7QUFDRCxDQUFDO0FBRUQsS0FBSywwRkFBMEYsTUFBTTtBQUNwRyxRQUFNLFdBQVc7QUFDakIsUUFBTSxjQUFjLFNBQVMsUUFBUSxZQUFZO0FBQ2pELFFBQU0sYUFBYTtBQUFBLElBQ2xCO0FBQUEsSUFDQSxFQUFFLE9BQU8sYUFBYSxLQUFLLFNBQVMsT0FBTztBQUFBLElBQzNDLEVBQUUsT0FBTyxHQUFHLEtBQUssU0FBUyxPQUFPO0FBQUEsRUFDbEM7QUFFQSxTQUFPLE1BQU0sV0FBVyxNQUFNLGtDQUFrQztBQUNqRSxDQUFDO0FBRUQsS0FBSyw2RkFBNkYsTUFBTTtBQUN2RyxRQUFNLFNBQVM7QUFDZixRQUFNLFdBQVcsT0FBTyxRQUFRLFFBQVEsSUFBSSxTQUFTO0FBQ3JELFFBQU0sV0FBVyxHQUFHLE9BQU8sTUFBTSxHQUFHLFFBQVEsQ0FBQztBQUFBLEtBQVEsT0FBTyxNQUFNLFFBQVEsQ0FBQztBQUMzRSxRQUFNLGFBQWE7QUFBQSxJQUNsQjtBQUFBLElBQ0EsRUFBRSxPQUFPLE9BQU8sUUFBUSxRQUFRLEdBQUcsS0FBSyxXQUFXLFFBQVEsT0FBTztBQUFBLElBQ2xFLEVBQUUsT0FBTyxXQUFXLFFBQVEsUUFBUSxLQUFLLFdBQVcsUUFBUSxPQUFPO0FBQUEsRUFDcEU7QUFFQSxTQUFPLE1BQU0sV0FBVyxNQUFNLCtCQUErQjtBQUM5RCxDQUFDOyIsCiAgIm5hbWVzIjogWyJtYXJrZXIiLCAidGFnIl0KfQo=
