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
    return `<p><strong>${renderSemanticInlineSelection(sourceText, block.inline, start, end) || "<br>"}</strong></p>`;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvcGFyc2VyLnRlc3QudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGFyc2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCwgcmVuZGVyRWRpdG9yTGluZSwgcmVuZGVyU2VsZWN0aW9uSHRtbCB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BhcnNlci50cyc7XG5cbmZ1bmN0aW9uIGdldE9ubHlMaW5lKHNvdXJjZTogc3RyaW5nKSB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudChzb3VyY2UpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAxKTtcblx0cmV0dXJuIHsgZG9jdW1lbnQsIGxpbmU6IGRvY3VtZW50LmxpbmVzWzBdISB9O1xufVxuXG50ZXN0KCdidWlsZERvY3VtZW50IGtlZXBzIGFuIGVtcHR5IGRvY3VtZW50IHN0YWJsZScsICgpID0+IHtcblx0Y29uc3QgeyBkb2N1bWVudCwgbGluZSB9ID0gZ2V0T25seUxpbmUoJycpO1xuXG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC50ZXh0LCAnJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5ibG9ja3MubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrc1swXT8udHlwZSwgJ3BhcmFncmFwaCcpO1xuXHRhc3NlcnQuZXF1YWwobGluZS5yYXcsICcnKTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGluZSksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPjxicj48L2Rpdj4nKTtcbn0pO1xuXG50ZXN0KCdwbGFpbiB0ZXh0IGVzY2FwZXMgSFRNTCBpbiByZW5kZXJlZCBvdXRwdXQnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJzx0YWc+ICYgdGV4dCcpO1xuXG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKGxpbmUpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPiZsdDt0YWcmZ3Q7ICZhbXA7IHRleHQ8L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgndW5tYXRjaGVkIHN0YXIgaXMgcGFyc2VkIGFzIHBsYWluIHRleHQnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJyonKTtcblxuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmUubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChsaW5lLmlubGluZVswXSwge1xuXHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRyYW5nZTogeyBzdGFydDogMCwgZW5kOiAxIH0sXG5cdFx0dGV4dDogJyonXG5cdH0pO1xuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShsaW5lKSwgJzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+KjwvZGl2PicpO1xufSk7XG5cbnRlc3QoJ3VuZmluaXNoZWQgc3Ryb25nIG1hcmtlciByZW1haW5zIHBsYWluIHRleHQgaW5zdGVhZCBvZiBoYW5naW5nJywgKCkgPT4ge1xuXHRjb25zdCB7IGxpbmUgfSA9IGdldE9ubHlMaW5lKCcqKicpO1xuXG5cdGFzc2VydC5lcXVhbChsaW5lLmlubGluZS5sZW5ndGgsIDIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGxpbmUuaW5saW5lWzBdLCB7XG5cdFx0dHlwZTogJ3RleHQnLFxuXHRcdHJhbmdlOiB7IHN0YXJ0OiAwLCBlbmQ6IDEgfSxcblx0XHR0ZXh0OiAnKidcblx0fSk7XG5cdGFzc2VydC5kZWVwRXF1YWwobGluZS5pbmxpbmVbMV0sIHtcblx0XHR0eXBlOiAndGV4dCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IDEsIGVuZDogMiB9LFxuXHRcdHRleHQ6ICcqJ1xuXHR9KTtcblx0YXNzZXJ0LmVxdWFsKHJlbmRlckVkaXRvckxpbmUobGluZSksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPioqPC9kaXY+Jyk7XG59KTtcblxudGVzdCgnc3Ryb25nIGFuZCBzdHJvbmcgZW1waGFzaXMgcmVxdWlyZSBub24tZW1wdHkgY29udGVudCcsICgpID0+IHtcblx0Y29uc3QgZG91YmxlTWFya2VyID0gZ2V0T25seUxpbmUoJyoqKionKS5saW5lO1xuXHRjb25zdCB0cmlwbGVNYXJrZXIgPSBnZXRPbmx5TGluZSgnKioqKioqJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShkb3VibGVNYXJrZXIpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qKioqPC9kaXY+Jyk7XG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKHRyaXBsZU1hcmtlciksICc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPioqKioqKjwvZGl2PicpO1xufSk7XG5cbnRlc3QoJ3ZhbGlkIGVtcGhhc2lzIHN0aWxsIHJlbmRlcnMgc3ludGF4IG1hcmtlcnMgYW5kIHNlbWFudGljIHRhZ3MnLCAoKSA9PiB7XG5cdGNvbnN0IHsgbGluZSB9ID0gZ2V0T25seUxpbmUoJ2EgKmIqIGMnKTtcblxuXHRhc3NlcnQuZXF1YWwobGluZS5pbmxpbmUubGVuZ3RoLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUuaW5saW5lWzFdPy50eXBlLCAnZW1waGFzaXMnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobGluZSksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+YSA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qPC9zcGFuPjxlbT5iPC9lbT48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qPC9zcGFuPiBjPC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3ZhbGlkIHN0cm9uZyBhbmQgc3Ryb25nIGVtcGhhc2lzIHJlbmRlciBjb3JyZWN0bHknLCAoKSA9PiB7XG5cdGNvbnN0IHN0cm9uZyA9IGdldE9ubHlMaW5lKCcqKmJvbGQqKicpLmxpbmU7XG5cdGNvbnN0IHN0cm9uZ0VtcGhhc2lzID0gZ2V0T25seUxpbmUoJyoqKmJvdGgqKionKS5saW5lO1xuXG5cdGFzc2VydC5lcXVhbChzdHJvbmcuaW5saW5lWzBdPy50eXBlLCAnc3Ryb25nJyk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKHN0cm9uZyksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+PHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+Kio8L3NwYW4+PHN0cm9uZz5ib2xkPC9zdHJvbmc+PHNwYW4gY2xhc3M9XCJzeW50YXgtbWFya2VyXCI+Kio8L3NwYW4+PC9kaXY+J1xuXHQpO1xuXG5cdGFzc2VydC5lcXVhbChzdHJvbmdFbXBoYXNpcy5pbmxpbmVbMF0/LnR5cGUsICdzdHJvbmdfZW1waGFzaXMnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUoc3Ryb25nRW1waGFzaXMpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPjxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPioqKjwvc3Bhbj48c3Ryb25nPjxlbT5ib3RoPC9lbT48L3N0cm9uZz48c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4qKio8L3NwYW4+PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ2Zvcm1hdHRpbmcgbWFya2VycyB3aXRoIGxlYWRpbmcgb3IgdHJhaWxpbmcgc3BhY2VzIGFyZSB0cmVhdGVkIGFzIHBsYWluIHRleHQnLCAoKSA9PiB7XG5cdGNvbnN0IGxlYWRpbmdTcGFjZSA9IGdldE9ubHlMaW5lKCcqIHRleHQqJykubGluZTtcblx0Y29uc3QgdHJhaWxpbmdTcGFjZSA9IGdldE9ubHlMaW5lKCcqdGV4dCAqJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwocmVuZGVyRWRpdG9yTGluZShsZWFkaW5nU3BhY2UpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qIHRleHQqPC9kaXY+Jyk7XG5cdGFzc2VydC5lcXVhbChyZW5kZXJFZGl0b3JMaW5lKHRyYWlsaW5nU3BhY2UpLCAnPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIj4qdGV4dCAqPC9kaXY+Jyk7XG59KTtcblxudGVzdCgnaGVhZGluZyBibG9ja3MgdHJhY2sgbGV2ZWwgYW5kIHJlbmRlciB3aXRoIGhlYWRpbmcgY2xhc3MnLCAoKSA9PiB7XG5cdGNvbnN0IHsgZG9jdW1lbnQsIGxpbmUgfSA9IGdldE9ubHlMaW5lKCcjIyMgVGl0bGUnKTtcblx0Y29uc3QgYmxvY2sgPSBkb2N1bWVudC5ibG9ja3NbMF07XG5cblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy50eXBlLCAnaGVhZGluZycpO1xuXHRhc3NlcnQuZXF1YWwoYmxvY2s/LmxldmVsLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUua2luZCwgJ2hlYWRpbmcnKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUuaGVhZGluZ0xldmVsLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGxpbmUucHJlZml4LCAnIyMjICcpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShsaW5lKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiPiMjIyBUaXRsZTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCd1bm9yZGVyZWQgbGlzdHMgcHJlc2VydmUgbmVzdGluZyBpbiBBU1QgYW5kIGxpbmUgbWV0YWRhdGEnLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICctIHBhcmVudFxcbiAgICAtIGNoaWxkXFxuLSBzaWJsaW5nJztcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KHNvdXJjZSk7XG5cdGNvbnN0IGJsb2NrID0gZG9jdW1lbnQuYmxvY2tzWzBdO1xuXG5cdGFzc2VydC5lcXVhbChibG9jaz8udHlwZSwgJ2xpc3QnKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5vcmRlcmVkLCBmYWxzZSk7XG5cdGFzc2VydC5lcXVhbChibG9jaz8uaXRlbXMubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5pdGVtc1swXT8uY2hpbGRyZW4ubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGJsb2NrPy5pdGVtc1swXT8uY2hpbGRyZW5bMF0/LnR5cGUsICdsaXN0Jyk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzLmxlbmd0aCwgMyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ua2luZCwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5saXN0TGV2ZWwsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMV0/LmtpbmQsICd1bm9yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdExldmVsLCAyKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzJdPy5raW5kLCAndW5vcmRlcmVkX2xpc3RfaXRlbScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMl0/Lmxpc3RMZXZlbCwgMSk7XG59KTtcblxudGVzdCgnb3JkZXJlZCBsaXN0cyBjYXB0dXJlIGxpc3QgbnVtYmVycyBhbmQgbmVzdGVkIGluZGVudCBtZXRhZGF0YScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEyLiB0b3BcXG4gICAgMy4gbmVzdGVkJztcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KHNvdXJjZSk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ua2luZCwgJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1swXT8ubGlzdE51bWJlciwgMTIpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/Lmxpc3RMZXZlbCwgMSk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ua2luZCwgJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdE51bWJlciwgMyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1sxXT8ubGlzdExldmVsLCAyKTtcbn0pO1xuXG50ZXN0KCdsaXN0IHJlbmRlcmluZyBjb21wdXRlcyBwcmVmaXggd2lkdGggYW5kIGluZGVudCBsZXZlbCBmb3IgdW5vcmRlcmVkIGl0ZW1zJywgKCkgPT4ge1xuXHRjb25zdCB0b3BMZXZlbCA9IGdldE9ubHlMaW5lKCctIGl0ZW0nKS5saW5lO1xuXHRjb25zdCBuZXN0ZWQgPSBnZXRPbmx5TGluZSgnICAgIC0gaXRlbScpLmxpbmU7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUodG9wTGV2ZWwpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6IDA7IC0tcHJlZml4LXdpZHRoOiAyXCI+LSBpdGVtPC9kaXY+J1xuXHQpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZShuZXN0ZWQpLFxuXHRcdCc8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCIgc3R5bGU9XCItLWxpc3QtbGV2ZWw6IDE7IC0tcHJlZml4LXdpZHRoOiAyXCI+ICAgIC0gaXRlbTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdsaXN0IHJlbmRlcmluZyBjb21wdXRlcyBwcmVmaXggd2lkdGggZm9yIG9yZGVyZWQgaXRlbXMgd2l0aCBtdWx0aS1kaWdpdCBwcmVmaXhlcycsICgpID0+IHtcblx0Y29uc3QgdG9wTGV2ZWwgPSBnZXRPbmx5TGluZSgnMTIuIGl0ZW0nKS5saW5lO1xuXHRjb25zdCBuZXN0ZWQgPSBnZXRPbmx5TGluZSgnICAgIDEyLiBpdGVtJykubGluZTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyRWRpdG9yTGluZSh0b3BMZXZlbCksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGxpc3RcIiBkYXRhLWxpbmUtaWQ9XCJsaW5lLTBcIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogMDsgLS1wcmVmaXgtd2lkdGg6IDRcIj4xMi4gaXRlbTwvZGl2Pidcblx0KTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUobmVzdGVkKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cImxpbmUtMFwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAxOyAtLXByZWZpeC13aWR0aDogNFwiPiAgICAxMi4gaXRlbTwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdjb2RlIGZlbmNlcyBwcm9kdWNlIGZlbmNlIGFuZCBjb250ZW50IGxpbmVzIHdpdGggY29kZSBzdHlsaW5nJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2BgYHRzXFxuY29uc3QgeCA9IDE7XFxuYGBgJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmJsb2Nrcy5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQuYmxvY2tzWzBdPy50eXBlLCAnY29kZV9ibG9jaycpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXMubGVuZ3RoLCAzKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzBdPy5raW5kLCAnY29kZV9mZW5jZScpO1xuXHRhc3NlcnQuZXF1YWwoZG9jdW1lbnQubGluZXNbMF0/LmNvZGVCbG9ja0xhbmd1YWdlLCAndHMnKTtcblx0YXNzZXJ0LmVxdWFsKGRvY3VtZW50LmxpbmVzWzFdPy5raW5kLCAnY29kZV9jb250ZW50Jyk7XG5cdGFzc2VydC5lcXVhbChkb2N1bWVudC5saW5lc1syXT8ua2luZCwgJ2NvZGVfZmVuY2UnKTtcblx0YXNzZXJ0LmVxdWFsKFxuXHRcdHJlbmRlckVkaXRvckxpbmUoZG9jdW1lbnQubGluZXNbMF0hKSxcblx0XHQnPGRpdiBjbGFzcz1cImxpbmUgY29kZSBjb2RlX2ZlbmNlXCIgZGF0YS1saW5lLWlkPVwibGluZS0wXCI+YGBgdHM8L2Rpdj4nXG5cdCk7XG5cdGFzc2VydC5lcXVhbChcblx0XHRyZW5kZXJFZGl0b3JMaW5lKGRvY3VtZW50LmxpbmVzWzFdISksXG5cdFx0JzxkaXYgY2xhc3M9XCJsaW5lIGNvZGUgY29kZV9jb250ZW50XCIgZGF0YS1saW5lLWlkPVwibGluZS0xXCI+Y29uc3QgeCA9IDE7PC9kaXY+J1xuXHQpO1xufSk7XG5cbnRlc3QoJ3JlbmRlclNlbGVjdGlvbkh0bWwgcHJlc2VydmVzIHNlbWFudGljIG1hcmt1cCBmb3IgcGFydGlhbCBzZWxlY3Rpb25zJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2EgKmIqIGMnKTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudCwgMywgNCksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PHA+PGVtPmI8L2VtPjwvcD48L2Rpdj4nXG5cdCk7XG59KTtcblxudGVzdCgncmVuZGVyU2VsZWN0aW9uSHRtbCBvbWl0cyBzeW50YXggbWFya2VycyBmb3IgbGlzdCBjb250ZW50IHNlbGVjdGlvbnMnLCAoKSA9PiB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudCgnLSAqaXRlbSonKTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudCwgMywgNyksXG5cdFx0JzxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+PHVsPjxsaT48ZW0+aXRlbTwvZW0+PC9saT48L3VsPjwvZGl2Pidcblx0KTtcbn0pO1xuXG50ZXN0KCdyZW5kZXJTZWxlY3Rpb25IdG1sIHByZXNlcnZlcyBjb2RlIGJsb2NrIHRleHQgYW5kIHNwYWNpbmcnLCAoKSA9PiB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudCgnYGBganNcXG4gIHhcXG5gYGAnKTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0cmVuZGVyU2VsZWN0aW9uSHRtbChkb2N1bWVudCwgNiwgMTApLFxuXHRcdCc8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPjxwcmU+PGNvZGU+Jm5ic3A7Jm5ic3A7eDwvY29kZT48L3ByZT48L2Rpdj4nXG5cdCk7XG59KTtcbiIsICJpbXBvcnQgdHlwZSB7XG5cdEJsb2NrTm9kZSxcblx0Q29kZUJsb2NrLFxuXHRGb3JtYXR0ZWROb2RlLFxuXHRIZWFkaW5nQmxvY2ssXG5cdElubGluZU5vZGUsXG5cdExpc3RCbG9jayxcblx0TGlzdEl0ZW1CbG9jayxcblx0UGFyYWdyYXBoQmxvY2ssXG5cdFNvdXJjZVJhbmdlLFxuXHRUZXh0Tm9kZVxufSBmcm9tICcuL2FzdCc7XG5cbmV4cG9ydCB0eXBlIExpbmVLaW5kID1cblx0fCAncGFyYWdyYXBoJ1xuXHR8ICdoZWFkaW5nJ1xuXHR8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJ1xuXHR8ICdvcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnY29kZV9mZW5jZSdcblx0fCAnY29kZV9jb250ZW50JztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JMaW5lIHtcblx0aWQ6IHN0cmluZztcblx0aW5kZXg6IG51bWJlcjtcblx0cmF3OiBzdHJpbmc7XG5cdHJhbmdlOiBTb3VyY2VSYW5nZTtcblx0a2luZDogTGluZUtpbmQ7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0cHJlZml4UmFuZ2U6IFNvdXJjZVJhbmdlIHwgbnVsbDtcblx0Y29udGVudFJhbmdlOiBTb3VyY2VSYW5nZTtcblx0aW5saW5lOiBJbmxpbmVOb2RlW107XG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvckRvY3VtZW50IHtcblx0dGV4dDogc3RyaW5nO1xuXHRibG9ja3M6IEJsb2NrTm9kZVtdO1xuXHRsaW5lczogRWRpdG9yTGluZVtdO1xufVxuXG5pbnRlcmZhY2UgUmF3TGluZSB7XG5cdGluZGV4OiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBMaW5lUHJlZml4SW5mbyB7XG5cdGtpbmQ6ICdwYXJhZ3JhcGgnIHwgJ2hlYWRpbmcnIHwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nIHwgJ29yZGVyZWRfbGlzdF9pdGVtJyB8ICdjb2RlX2ZlbmNlJztcblx0bGlzdExldmVsOiBudW1iZXI7XG5cdGxpc3ROdW1iZXI6IG51bWJlcjtcblx0aGVhZGluZ0xldmVsOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xuXHRsYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRG9jdW1lbnQocmF3VGV4dDogc3RyaW5nKTogRWRpdG9yRG9jdW1lbnQge1xuXHRjb25zdCB0ZXh0ID0gbm9ybWFsaXplVGV4dChyYXdUZXh0KTtcblx0Y29uc3QgcmF3TGluZXMgPSBidWlsZFJhd0xpbmVzKHRleHQpO1xuXHRjb25zdCBibG9ja3MgPSBwYXJzZUJsb2NrcyhyYXdMaW5lcyk7XG5cdGNvbnN0IGxpbmVzID0gZGVyaXZlTGluZXMoYmxvY2tzKTtcblx0cmV0dXJuIHsgdGV4dCwgYmxvY2tzLCBsaW5lcyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplVGV4dChyYXdUZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gcmF3VGV4dDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckVkaXRvckxpbmUobGluZTogRWRpdG9yTGluZSk6IHN0cmluZyB7XG5cdGNvbnN0IHByZWZpeCA9IGxpbmUucHJlZml4UmFuZ2UgPyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucHJlZml4KSA6ICcnO1xuXHRjb25zdCBjb250ZW50ID0gbGluZS5raW5kLnN0YXJ0c1dpdGgoJ2NvZGVfJylcblx0XHQ/IHJlbmRlckVkaXRvclRleHQobGluZS5yYXcuc2xpY2UobGluZS5wcmVmaXgubGVuZ3RoKSlcblx0XHQ6IHJlbmRlckVkaXRvcklubGluZShsaW5lLmlubGluZSk7XG5cdGNvbnN0IGJvZHkgPSBwcmVmaXggKyAoY29udGVudCB8fCAobGluZS5yYXcubGVuZ3RoID09PSAwID8gJzxicj4nIDogJycpKTtcblxuXHRpZiAobGluZS5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nIHx8IGxpbmUua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0Y29uc3QgcHJlZml4V2lkdGggPSBsaW5lLnByZWZpeC50cmltU3RhcnQoKS5sZW5ndGg7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAke2xpbmUubGlzdExldmVsIC0gMX07IC0tcHJlZml4LXdpZHRoOiAke3ByZWZpeFdpZHRofVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBoZWFkaW5nXCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ2NvZGVfZmVuY2UnIHx8IGxpbmUua2luZCA9PT0gJ2NvZGVfY29udGVudCcpIHtcblx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJsaW5lIGNvZGUgJHtsaW5lLmtpbmR9XCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQ6IEVkaXRvckRvY3VtZW50LCBzdGFydDogbnVtYmVyLCBlbmQ6IG51bWJlcik6IHN0cmluZyB7XG5cdGlmIChzdGFydCA+PSBlbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0cyA9IGRvY3VtZW50LmJsb2Nrc1xuXHRcdC5tYXAoKGJsb2NrKSA9PiByZW5kZXJCbG9ja1NlbGVjdGlvbihkb2N1bWVudC50ZXh0LCBibG9jaywgc3RhcnQsIGVuZCkpXG5cdFx0LmZpbHRlcihCb29sZWFuKTtcblxuXHRyZXR1cm4gYDxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+JHtwYXJ0cy5qb2luKCcnKX08L2Rpdj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmluZExpbmVJbmRleChsaW5lczogRWRpdG9yTGluZVtdLCBvZmZzZXQ6IG51bWJlcik6IG51bWJlciB7XG5cdGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBsaW5lcy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IG5leHRTdGFydCA9IGluZGV4ICsgMSA8IGxpbmVzLmxlbmd0aCA/IGxpbmVzW2luZGV4ICsgMV0ucmFuZ2Uuc3RhcnQgOiBsaW5lLnJhbmdlLmVuZCArIDE7XG5cdFx0aWYgKG9mZnNldCA8IG5leHRTdGFydCkgcmV0dXJuIGluZGV4O1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLmxlbmd0aCAtIDE7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRMaW5lUmVuZGVyU2lnbmF0dXJlKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRyZXR1cm4gW1xuXHRcdGxpbmUua2luZCxcblx0XHRsaW5lLnJhdyxcblx0XHRsaW5lLnByZWZpeCxcblx0XHRsaW5lLmxpc3RMZXZlbCxcblx0XHRsaW5lLmxpc3ROdW1iZXIsXG5cdFx0bGluZS5oZWFkaW5nTGV2ZWwsXG5cdFx0bGluZS5jb2RlQmxvY2tMYW5ndWFnZSA/PyAnJ1xuXHRdLmpvaW4oJ1xcdTAwMDEnKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRSYXdMaW5lcyh0ZXh0OiBzdHJpbmcpOiBSYXdMaW5lW10ge1xuXHRjb25zdCBzcGxpdCA9IHRleHQuc3BsaXQoJ1xcbicpO1xuXHRjb25zdCBsaW5lczogUmF3TGluZVtdID0gW107XG5cdGxldCBvZmZzZXQgPSAwO1xuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBzcGxpdC5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBsaW5lID0gc3BsaXRbaW5kZXhdO1xuXHRcdGxpbmVzLnB1c2goe1xuXHRcdFx0aW5kZXgsXG5cdFx0XHR0ZXh0OiBsaW5lLFxuXHRcdFx0c3RhcnQ6IG9mZnNldCxcblx0XHRcdGVuZDogb2Zmc2V0ICsgbGluZS5sZW5ndGhcblx0XHR9KTtcblx0XHRvZmZzZXQgKz0gbGluZS5sZW5ndGggKyAxO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrcyhsaW5lczogUmF3TGluZVtdKTogQmxvY2tOb2RlW10ge1xuXHRyZXR1cm4gcGFyc2VCbG9ja1NlcXVlbmNlKGxpbmVzLCAwLCAwKS5ibG9ja3M7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIsIGxpc3RMZXZlbDogbnVtYmVyKSB7XG5cdGNvbnN0IGJsb2NrczogQmxvY2tOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cblx0XHRpZiAobGlzdExldmVsID4gMCkge1xuXHRcdFx0aWYgKGxpbmUudGV4dC50cmltKCkgPT09ICcnKSBicmVhaztcblx0XHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlQ29kZUJsb2NrKGxpbmVzLCBpbmRleCk7XG5cdFx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlZC5ibG9jayk7XG5cdFx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRpZiAoXG5cdFx0XHRcdChwcmVmaXgua2luZCAhPT0gJ29yZGVyZWRfbGlzdF9pdGVtJyAmJiBwcmVmaXgua2luZCAhPT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB8fFxuXHRcdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGlzdExldmVsXG5cdFx0XHQpIHtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlQ29kZUJsb2NrKGxpbmVzLCBpbmRleCk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nIHx8IHByZWZpeC5raW5kID09PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlTGlzdChsaW5lcywgaW5kZXgsIHByZWZpeC5saXN0TGV2ZWwsIHByZWZpeC5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nKTtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlZC5ibG9jayk7XG5cdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VIZWFkaW5nKGxpbmUsIHByZWZpeCkpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGJsb2Nrcy5wdXNoKHBhcnNlUGFyYWdyYXBoKGxpbmUpKTtcblx0XHRpbmRleCArPSAxO1xuXHR9XG5cblx0cmV0dXJuIHsgYmxvY2tzLCBuZXh0SW5kZXg6IGluZGV4IH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlTGlzdChsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIsIGxldmVsOiBudW1iZXIsIG9yZGVyZWQ6IGJvb2xlYW4pIHtcblx0Y29uc3QgaXRlbXM6IExpc3RJdGVtQmxvY2tbXSA9IFtdO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4O1xuXG5cdHdoaWxlIChpbmRleCA8IGxpbmVzLmxlbmd0aCkge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgcHJlZml4ID0gcGFyc2VQcmVmaXgobGluZS50ZXh0KTtcblx0XHRpZiAoXG5cdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdHByZWZpeC5saXN0TGV2ZWwgPCBsZXZlbCB8fFxuXHRcdFx0KHByZWZpeC5saXN0TGV2ZWwgPT09IGxldmVsICYmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJykgIT09IG9yZGVyZWQpXG5cdFx0KSB7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRpZiAocHJlZml4Lmxpc3RMZXZlbCA+IGxldmVsKSB7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRjb25zdCBpdGVtU3RhcnQgPSBsaW5lLnN0YXJ0O1xuXHRcdGNvbnN0IGl0ZW1QcmVmaXhMZW5ndGggPSBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0XHRjb25zdCBpdGVtOiBMaXN0SXRlbUJsb2NrID0ge1xuXHRcdFx0dHlwZTogJ2xpc3RfaXRlbScsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogaXRlbVN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsaW5lUmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdG51bWJlcjogcHJlZml4Lmxpc3ROdW1iZXIsXG5cdFx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRcdGlubGluZTogcGFyc2VJbmxpbmUobGluZS50ZXh0LnNsaWNlKGl0ZW1QcmVmaXhMZW5ndGgpLCBsaW5lLnN0YXJ0ICsgaXRlbVByZWZpeExlbmd0aCksXG5cdFx0XHRjaGlsZHJlbjogW11cblx0XHR9O1xuXG5cdFx0aW5kZXggKz0gMTtcblx0XHRjb25zdCBjaGlsZFBhcnNlZCA9IHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgaW5kZXgsIGxldmVsICsgMSk7XG5cdFx0aXRlbS5jaGlsZHJlbiA9IGNoaWxkUGFyc2VkLmJsb2Nrcztcblx0XHRjb25zdCBjaGlsZEVuZCA9XG5cdFx0XHRpdGVtLmNoaWxkcmVuLmxlbmd0aCA+IDAgPyBpdGVtLmNoaWxkcmVuW2l0ZW0uY2hpbGRyZW4ubGVuZ3RoIC0gMV0ucmFuZ2UuZW5kIDogaXRlbS5yYW5nZS5lbmQ7XG5cdFx0aXRlbS5yYW5nZSA9IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBjaGlsZEVuZCB9O1xuXHRcdGl0ZW1zLnB1c2goaXRlbSk7XG5cdFx0aW5kZXggPSBjaGlsZFBhcnNlZC5uZXh0SW5kZXg7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnbGlzdCcsXG5cdFx0XHRyYW5nZToge1xuXHRcdFx0XHRzdGFydDogaXRlbXNbMF0/LnJhbmdlLnN0YXJ0ID8/IGxpbmVzW3N0YXJ0SW5kZXhdLnN0YXJ0LFxuXHRcdFx0XHRlbmQ6IGl0ZW1zW2l0ZW1zLmxlbmd0aCAtIDFdPy5yYW5nZS5lbmQgPz8gbGluZXNbc3RhcnRJbmRleF0uZW5kXG5cdFx0XHR9LFxuXHRcdFx0bGV2ZWwsXG5cdFx0XHRvcmRlcmVkLFxuXHRcdFx0aXRlbXNcblx0XHR9IHNhdGlzZmllcyBMaXN0QmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUNvZGVCbG9jayhsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIpIHtcblx0Y29uc3Qgb3BlbkxpbmUgPSBsaW5lc1tzdGFydEluZGV4XTtcblx0Y29uc3Qgb3BlblByZWZpeCA9IHBhcnNlUHJlZml4KG9wZW5MaW5lLnRleHQpO1xuXHRjb25zdCBjb250ZW50TGluZXM6IENvZGVCbG9ja1snbGluZXMnXSA9IFtdO1xuXHRsZXQgY2xvc2VGZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdGxldCBlbmQgPSBvcGVuTGluZS5lbmQ7XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXggKyAxO1xuXG5cdHdoaWxlIChpbmRleCA8IGxpbmVzLmxlbmd0aCkge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgcHJlZml4ID0gcGFyc2VQcmVmaXgobGluZS50ZXh0KTtcblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0Y2xvc2VGZW5jZSA9IHByZWZpeC5wcmVmaXg7XG5cdFx0XHRlbmQgPSBsaW5lLmVuZDtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRjb250ZW50TGluZXMucHVzaCh7XG5cdFx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0dGV4dDogbGluZS50ZXh0XG5cdFx0fSk7XG5cdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0YmxvY2s6IHtcblx0XHRcdHR5cGU6ICdjb2RlX2Jsb2NrJyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBvcGVuTGluZS5zdGFydCwgZW5kIH0sXG5cdFx0XHRsYW5ndWFnZTogb3BlblByZWZpeC5sYW5ndWFnZSxcblx0XHRcdG9wZW5GZW5jZTogb3BlblByZWZpeC5wcmVmaXgsXG5cdFx0XHRjbG9zZUZlbmNlLFxuXHRcdFx0bGluZXM6IGNvbnRlbnRMaW5lc1xuXHRcdH0gc2F0aXNmaWVzIENvZGVCbG9jayxcblx0XHRuZXh0SW5kZXg6IGluZGV4XG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSGVhZGluZyhsaW5lOiBSYXdMaW5lLCBwcmVmaXg6IExpbmVQcmVmaXhJbmZvKTogSGVhZGluZ0Jsb2NrIHtcblx0Y29uc3QgY29udGVudFN0YXJ0ID0gbGluZS5zdGFydCArIHByZWZpeC5wcmVmaXgubGVuZ3RoO1xuXHRyZXR1cm4ge1xuXHRcdHR5cGU6ICdoZWFkaW5nJyxcblx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdHJhdzogbGluZS50ZXh0LFxuXHRcdGxldmVsOiBwcmVmaXguaGVhZGluZ0xldmVsLFxuXHRcdHByZWZpeDogcHJlZml4LnByZWZpeCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShwcmVmaXgucHJlZml4Lmxlbmd0aCksIGNvbnRlbnRTdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQYXJhZ3JhcGgobGluZTogUmF3TGluZSk6IFBhcmFncmFwaEJsb2NrIHtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAncGFyYWdyYXBoJyxcblx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdHJhdzogbGluZS50ZXh0LFxuXHRcdGlubGluZTogcGFyc2VJbmxpbmUobGluZS50ZXh0LCBsaW5lLnN0YXJ0KVxuXHR9O1xufVxuXG5mdW5jdGlvbiBkZXJpdmVMaW5lcyhibG9ja3M6IEJsb2NrTm9kZVtdKTogRWRpdG9yTGluZVtdIHtcblx0Y29uc3QgbGluZXM6IEVkaXRvckxpbmVbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0YXBwZW5kQmxvY2tMaW5lcyhibG9jaywgbGluZXMpO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLm1hcCgobGluZSwgaW5kZXgpID0+ICh7XG5cdFx0Li4ubGluZSxcblx0XHRpZDogYGxpbmUtJHtpbmRleH1gLFxuXHRcdGluZGV4XG5cdH0pKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kQmxvY2tMaW5lcyhibG9jazogQmxvY2tOb2RlLCBsaW5lczogRWRpdG9yTGluZVtdKSB7XG5cdGlmIChibG9jay50eXBlID09PSAncGFyYWdyYXBoJykge1xuXHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUoYmxvY2sucmF3LCBibG9jay5yYW5nZSwgJ3BhcmFncmFwaCcsICcnLCBudWxsLCBibG9jay5pbmxpbmUpKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0bGluZXMucHVzaChcblx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRibG9jay5yYXcsXG5cdFx0XHRcdGJsb2NrLnJhbmdlLFxuXHRcdFx0XHQnaGVhZGluZycsXG5cdFx0XHRcdGJsb2NrLnByZWZpeCxcblx0XHRcdFx0bnVsbCxcblx0XHRcdFx0YmxvY2suaW5saW5lLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHRibG9jay5sZXZlbFxuXHRcdFx0KVxuXHRcdCk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdjb2RlX2Jsb2NrJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sub3BlbkZlbmNlICsgKGJsb2NrLmxhbmd1YWdlID8gYmxvY2subGFuZ3VhZ2UgOiAnJyksXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRzdGFydDogYmxvY2sucmFuZ2Uuc3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBibG9jay5yYW5nZS5zdGFydCArIGJsb2NrLm9wZW5GZW5jZS5sZW5ndGggKyAoYmxvY2subGFuZ3VhZ2U/Lmxlbmd0aCA/PyAwKVxuXHRcdFx0XHR9LFxuXHRcdFx0XHQnY29kZV9mZW5jZScsXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSxcblx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFtdXG5cdFx0XHQpXG5cdFx0KTtcblxuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0bGluZXMucHVzaChjcmVhdGVCYXNlTGluZShsaW5lLnRleHQsIGxpbmUucmFuZ2UsICdjb2RlX2NvbnRlbnQnLCAnJywgYmxvY2subGFuZ3VhZ2UsIFtdKSk7XG5cdFx0fVxuXG5cdFx0aWYgKGJsb2NrLmNsb3NlRmVuY2UpIHtcblx0XHRcdGNvbnN0IGNsb3NlU3RhcnQgPSBibG9jay5yYW5nZS5lbmQgLSBibG9jay5jbG9zZUZlbmNlLmxlbmd0aDtcblx0XHRcdGxpbmVzLnB1c2goXG5cdFx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0eyBzdGFydDogY2xvc2VTdGFydCwgZW5kOiBibG9jay5yYW5nZS5lbmQgfSxcblx0XHRcdFx0XHQnY29kZV9mZW5jZScsXG5cdFx0XHRcdFx0YmxvY2suY2xvc2VGZW5jZSxcblx0XHRcdFx0XHRibG9jay5sYW5ndWFnZSxcblx0XHRcdFx0XHRbXVxuXHRcdFx0XHQpXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2xpc3QnKSB7XG5cdFx0Zm9yIChjb25zdCBpdGVtIG9mIGJsb2NrLml0ZW1zKSB7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRpdGVtLnJhdyxcblx0XHRcdFx0XHRpdGVtLmxpbmVSYW5nZSxcblx0XHRcdFx0XHRpdGVtLm9yZGVyZWQgPyAnb3JkZXJlZF9saXN0X2l0ZW0nIDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0XHRcdGl0ZW0ucHJlZml4LFxuXHRcdFx0XHRcdG51bGwsXG5cdFx0XHRcdFx0aXRlbS5pbmxpbmUsXG5cdFx0XHRcdFx0aXRlbS5sZXZlbCxcblx0XHRcdFx0XHRpdGVtLm51bWJlclxuXHRcdFx0XHQpXG5cdFx0XHQpO1xuXHRcdFx0Zm9yIChjb25zdCBjaGlsZCBvZiBpdGVtLmNoaWxkcmVuKSB7XG5cdFx0XHRcdGFwcGVuZEJsb2NrTGluZXMoY2hpbGQsIGxpbmVzKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlQmFzZUxpbmUoXG5cdHJhdzogc3RyaW5nLFxuXHRyYW5nZTogU291cmNlUmFuZ2UsXG5cdGtpbmQ6IExpbmVLaW5kLFxuXHRwcmVmaXg6IHN0cmluZyxcblx0Y29kZUJsb2NrTGFuZ3VhZ2U6IHN0cmluZyB8IG51bGwsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRsaXN0TGV2ZWwgPSAwLFxuXHRsaXN0TnVtYmVyID0gMCxcblx0aGVhZGluZ0xldmVsID0gMFxuKTogRWRpdG9yTGluZSB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IHJhbmdlLnN0YXJ0ICsgcHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHRpZDogJycsXG5cdFx0aW5kZXg6IDAsXG5cdFx0cmF3LFxuXHRcdHJhbmdlLFxuXHRcdGtpbmQsXG5cdFx0bGlzdExldmVsLFxuXHRcdGxpc3ROdW1iZXIsXG5cdFx0aGVhZGluZ0xldmVsLFxuXHRcdHByZWZpeCxcblx0XHRwcmVmaXhSYW5nZTogcHJlZml4Lmxlbmd0aCA+IDAgPyB7IHN0YXJ0OiByYW5nZS5zdGFydCwgZW5kOiBjb250ZW50U3RhcnQgfSA6IG51bGwsXG5cdFx0Y29udGVudFJhbmdlOiB7IHN0YXJ0OiBjb250ZW50U3RhcnQsIGVuZDogcmFuZ2UuZW5kIH0sXG5cdFx0aW5saW5lLFxuXHRcdGNvZGVCbG9ja0xhbmd1YWdlXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJlZml4KHJhdzogc3RyaW5nKTogTGluZVByZWZpeEluZm8ge1xuXHRjb25zdCBjb2RlRmVuY2VNYXRjaCA9IHJhdy5tYXRjaCgvXmBgYChbQS1aYS16MC05Xy1dKyk/XFxzKiQvKTtcblx0aWYgKGNvZGVGZW5jZU1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICdjb2RlX2ZlbmNlJyxcblx0XHRcdGxpc3RMZXZlbDogMCxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6ICdgYGAnLFxuXHRcdFx0bGFuZ3VhZ2U6IGNvZGVGZW5jZU1hdGNoWzFdID8/IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSByYXcubWF0Y2goL14oKD86IHs0fSkqKS0gLyk7XG5cdGlmICh1bm9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAndW5vcmRlcmVkX2xpc3RfaXRlbScsXG5cdFx0XHRsaXN0TGV2ZWw6IHVub3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogMCxcblx0XHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRcdHByZWZpeDogdW5vcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBvcmRlcmVkTWF0Y2ggPSByYXcubWF0Y2goL14oKD86IHs0fSkqKShcXGQrKVxcLiAvKTtcblx0aWYgKG9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnb3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRsaXN0TnVtYmVyOiBOdW1iZXIucGFyc2VJbnQob3JkZXJlZE1hdGNoWzJdLCAxMCksXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IG9yZGVyZWRNYXRjaFswXSxcblx0XHRcdGxhbmd1YWdlOiBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGhlYWRpbmdNYXRjaCA9IHJhdy5tYXRjaCgvXigjezEsNn0pXFxzKy8pO1xuXHRpZiAoaGVhZGluZ01hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICdoZWFkaW5nJyxcblx0XHRcdGxpc3RMZXZlbDogMCxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGhlYWRpbmdNYXRjaFsxXS5sZW5ndGgsXG5cdFx0XHRwcmVmaXg6IGhlYWRpbmdNYXRjaFswXSxcblx0XHRcdGxhbmd1YWdlOiBudWxsXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0a2luZDogJ3BhcmFncmFwaCcsXG5cdFx0bGlzdExldmVsOiAwLFxuXHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdHByZWZpeDogJycsXG5cdFx0bGFuZ3VhZ2U6IG51bGxcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VJbmxpbmUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIpOiBJbmxpbmVOb2RlW10ge1xuXHRjb25zdCBpbmxpbmU6IElubGluZU5vZGVbXSA9IFtdO1xuXHRsZXQgaW5kZXggPSAwO1xuXG5cdHdoaWxlIChpbmRleCA8IHJhdy5sZW5ndGgpIHtcblx0XHRjb25zdCBmb3JtYXR0ZWROb2RlID0gcGFyc2VGb3JtYXR0ZWROb2RlKHJhdywgc3RhcnRPZmZzZXQsIGluZGV4KTtcblx0XHRpZiAoZm9ybWF0dGVkTm9kZSkge1xuXHRcdFx0aW5saW5lLnB1c2goZm9ybWF0dGVkTm9kZS5ub2RlKTtcblx0XHRcdGluZGV4ID0gZm9ybWF0dGVkTm9kZS5uZXh0SW5kZXg7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRsZXQgbmV4dE1hcmtlciA9IHJhdy5sZW5ndGg7XG5cdFx0Y29uc3Qgc3RhckluZGV4ID0gcmF3LmluZGV4T2YoJyonLCBpbmRleCk7XG5cdFx0aWYgKHN0YXJJbmRleCAhPT0gLTEpIG5leHRNYXJrZXIgPSBzdGFySW5kZXg7XG5cblx0XHRpZiAobmV4dE1hcmtlciA9PT0gaW5kZXgpIHtcblx0XHRcdGlubGluZS5wdXNoKHtcblx0XHRcdFx0dHlwZTogJ3RleHQnLFxuXHRcdFx0XHRyYW5nZTogeyBzdGFydDogc3RhcnRPZmZzZXQgKyBpbmRleCwgZW5kOiBzdGFydE9mZnNldCArIGluZGV4ICsgMSB9LFxuXHRcdFx0XHR0ZXh0OiByYXdbaW5kZXhdXG5cdFx0XHR9IHNhdGlzZmllcyBUZXh0Tm9kZSk7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgdGV4dCA9IHJhdy5zbGljZShpbmRleCwgbmV4dE1hcmtlcik7XG5cdFx0aW5saW5lLnB1c2goe1xuXHRcdFx0dHlwZTogJ3RleHQnLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBuZXh0TWFya2VyIH0sXG5cdFx0XHR0ZXh0XG5cdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdGluZGV4ID0gbmV4dE1hcmtlcjtcblx0fVxuXG5cdHJldHVybiBpbmxpbmU7XG59XG5cbmZ1bmN0aW9uIHBhcnNlRm9ybWF0dGVkTm9kZShyYXc6IHN0cmluZywgc3RhcnRPZmZzZXQ6IG51bWJlciwgaW5kZXg6IG51bWJlcikge1xuXHRmb3IgKGNvbnN0IG1hcmtlciBvZiBbJyoqKicsICcqKicsICcqJ10gYXMgY29uc3QpIHtcblx0XHRpZiAoIXJhdy5zdGFydHNXaXRoKG1hcmtlciwgaW5kZXgpKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNsb3NlID0gcmF3LmluZGV4T2YobWFya2VyLCBpbmRleCArIG1hcmtlci5sZW5ndGgpO1xuXHRcdGlmIChjbG9zZSA9PT0gLTEpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgY29udGVudFN0YXJ0ID0gaW5kZXggKyBtYXJrZXIubGVuZ3RoO1xuXHRcdGNvbnN0IGNvbnRlbnRFbmQgPSBjbG9zZTtcblx0XHRpZiAoY29udGVudFN0YXJ0ID49IGNvbnRlbnRFbmQpIGNvbnRpbnVlO1xuXHRcdGlmIChyYXdbY29udGVudFN0YXJ0XSA9PT0gJyAnIHx8IHJhd1tjb250ZW50RW5kIC0gMV0gPT09ICcgJykgY29udGludWU7XG5cblx0XHRjb25zdCB0eXBlID0gbWFya2VyID09PSAnKioqJyA/ICdzdHJvbmdfZW1waGFzaXMnIDogbWFya2VyID09PSAnKionID8gJ3N0cm9uZycgOiAnZW1waGFzaXMnO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdG5vZGU6IHtcblx0XHRcdFx0dHlwZSxcblx0XHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBpbmRleCxcblx0XHRcdFx0XHRlbmQ6IHN0YXJ0T2Zmc2V0ICsgY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0XHRcdH0sXG5cdFx0XHRcdGNvbnRlbnRSYW5nZToge1xuXHRcdFx0XHRcdHN0YXJ0OiBzdGFydE9mZnNldCArIGNvbnRlbnRTdGFydCxcblx0XHRcdFx0XHRlbmQ6IHN0YXJ0T2Zmc2V0ICsgY29udGVudEVuZFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRtYXJrZXIsXG5cdFx0XHRcdHRleHQ6IHJhdy5zbGljZShjb250ZW50U3RhcnQsIGNvbnRlbnRFbmQpXG5cdFx0XHR9IHNhdGlzZmllcyBGb3JtYXR0ZWROb2RlLFxuXHRcdFx0bmV4dEluZGV4OiBjbG9zZSArIG1hcmtlci5sZW5ndGhcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVkaXRvcklubGluZShpbmxpbmU6IElubGluZU5vZGVbXSk6IHN0cmluZyB7XG5cdHJldHVybiBpbmxpbmVcblx0XHQubWFwKChub2RlKSA9PiB7XG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdFx0cmV0dXJuIHJlbmRlckVkaXRvclRleHQobm9kZS50ZXh0KTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgbWFya2VyID0gYDxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPiR7ZXNjYXBlSHRtbChub2RlLm1hcmtlcil9PC9zcGFuPmA7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gZXNjYXBlSHRtbChub2RlLnRleHQpO1xuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnZW1waGFzaXMnKSB7XG5cdFx0XHRcdHJldHVybiBgJHttYXJrZXJ9PGVtPiR7Y29udGVudH08L2VtPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz4ke2NvbnRlbnR9PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGAke21hcmtlcn08c3Ryb25nPjxlbT4ke2NvbnRlbnR9PC9lbT48L3N0cm9uZz4ke21hcmtlcn1gO1xuXHRcdH0pXG5cdFx0LmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJCbG9ja1NlbGVjdGlvbihcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRibG9jazogQmxvY2tOb2RlLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKGVuZCA8PSBibG9jay5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBibG9jay5yYW5nZS5lbmQpIHJldHVybiAnJztcblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRyZXR1cm4gYDxwPiR7cmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgYmxvY2suaW5saW5lLCBzdGFydCwgZW5kKSB8fCAnPGJyPid9PC9wPmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0cmV0dXJuIGA8cD48c3Ryb25nPiR7cmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgYmxvY2suaW5saW5lLCBzdGFydCwgZW5kKSB8fCAnPGJyPid9PC9zdHJvbmc+PC9wPmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2NvZGVfYmxvY2snKSB7XG5cdFx0Y29uc3QgY29kZVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0aWYgKGVuZCA8PSBsaW5lLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGxpbmUucmFuZ2UuZW5kKSBjb250aW51ZTtcblx0XHRcdGNvZGVQYXJ0cy5wdXNoKGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQoc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBsaW5lLnJhbmdlLCBzdGFydCwgZW5kKSkpO1xuXHRcdH1cblx0XHRyZXR1cm4gYDxwcmU+PGNvZGU+JHtjb2RlUGFydHMuam9pbignXFxuJyl9PC9jb2RlPjwvcHJlPmA7XG5cdH1cblxuXHRjb25zdCB0YWcgPSBibG9jay5vcmRlcmVkID8gJ29sJyA6ICd1bCc7XG5cdGNvbnN0IGl0ZW1zID0gYmxvY2suaXRlbXNcblx0XHQubWFwKChpdGVtKSA9PiByZW5kZXJMaXN0SXRlbVNlbGVjdGlvbihzb3VyY2VUZXh0LCBpdGVtLCBzdGFydCwgZW5kKSlcblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oJycpO1xuXHRyZXR1cm4gaXRlbXMgPyBgPCR7dGFnfT4ke2l0ZW1zfTwvJHt0YWd9PmAgOiAnJztcbn1cblxuZnVuY3Rpb24gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0aXRlbTogTGlzdEl0ZW1CbG9jayxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gaXRlbS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBpdGVtLnJhbmdlLmVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBpdGVtSW5saW5lID0gcmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbS5pbmxpbmUsIHN0YXJ0LCBlbmQpO1xuXHRwYXJ0cy5wdXNoKGl0ZW1JbmxpbmUgfHwgJzxicj4nKTtcblxuXHRmb3IgKGNvbnN0IGNoaWxkIG9mIGl0ZW0uY2hpbGRyZW4pIHtcblx0XHRjb25zdCBjaGlsZEh0bWwgPSByZW5kZXJCbG9ja1NlbGVjdGlvbihzb3VyY2VUZXh0LCBjaGlsZCwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKGNoaWxkSHRtbCkgcGFydHMucHVzaChjaGlsZEh0bWwpO1xuXHR9XG5cblx0cmV0dXJuIGA8bGk+JHtwYXJ0cy5qb2luKCcnKX08L2xpPmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3Qgbm9kZSBvZiBpbmxpbmUpIHtcblx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdGNvbnN0IHNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLnJhbmdlLCBzdGFydCwgZW5kKTtcblx0XHRcdGlmIChzbGljZSkgcGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlKSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBpbm5lclNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLmNvbnRlbnRSYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKCFpbm5lclNsaWNlKSBjb250aW51ZTtcblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdlbXBoYXNpcycpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L3N0cm9uZz5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHBhcnRzLnB1c2goYDxzdHJvbmc+PGVtPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2VtPjwvc3Ryb25nPmApO1xuXHR9XG5cblx0cmV0dXJuIHBhcnRzLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBzbGljZVJhbmdlKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdHJhbmdlOiBTb3VyY2VSYW5nZSxcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcixcblx0c2VsZWN0aW9uRW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgocmFuZ2Uuc3RhcnQsIHNlbGVjdGlvblN0YXJ0KTtcblx0Y29uc3QgZW5kID0gTWF0aC5taW4ocmFuZ2UuZW5kLCBzZWxlY3Rpb25FbmQpO1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cdHJldHVybiBzb3VyY2VUZXh0LnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0Lmxlbmd0aCA9PT0gMCA/ICcnIDogZXNjYXBlSHRtbCh0ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7Jyk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGVzY2FwZUh0bWwodGV4dCkucmVwbGFjZSgvIC9nLCAnJm5ic3A7JykucmVwbGFjZSgvXFx0L2csICcmbmJzcDsmbmJzcDsmbmJzcDsmbmJzcDsnKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUMwRFosU0FBUyxjQUFjLFNBQWlDO0FBQzlELFFBQU0sT0FBTyxjQUFjLE9BQU87QUFDbEMsUUFBTSxXQUFXLGNBQWMsSUFBSTtBQUNuQyxRQUFNLFNBQVMsWUFBWSxRQUFRO0FBQ25DLFFBQU0sUUFBUSxZQUFZLE1BQU07QUFDaEMsU0FBTyxFQUFFLE1BQU0sUUFBUSxNQUFNO0FBQzlCO0FBRU8sU0FBUyxjQUFjLFNBQXlC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
