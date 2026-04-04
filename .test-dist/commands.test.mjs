// tests/commands.test.ts
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

// src/lib/editor/lists.ts
function getListMetadata(lineText) {
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
    prefix: ""
  };
}
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

// src/lib/editor/text.ts
function replaceRange(text, selection, insertedText) {
  const nextText = text.slice(0, selection.start) + insertedText + text.slice(selection.end);
  const cursor = selection.start + insertedText.length;
  return {
    text: nextText,
    selectionStart: cursor,
    selectionEnd: cursor
  };
}
function deleteBackward(text, selection) {
  if (selection.start !== selection.end) {
    return replaceRange(text, selection, "");
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
    ""
  );
}
function deleteForward(text, selection) {
  if (selection.start !== selection.end) {
    return replaceRange(text, selection, "");
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
    ""
  );
}
function getCurrentLineBounds(text, position) {
  const before = text.slice(0, position);
  const lineStart = before.lastIndexOf("\n") + 1;
  const nextNewline = text.indexOf("\n", position);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return { lineStart, lineEnd };
}
function getSelectedBlockBounds(text, selection) {
  const blockStart = getCurrentLineBounds(text, selection.start).lineStart;
  const blockEnd = getCurrentLineBounds(text, selection.end).lineEnd;
  return { blockStart, blockEnd };
}

// src/lib/editor/commands.ts
function applyTabKey(text, selection, shiftKey) {
  if (selection.start !== selection.end) {
    return applyTabToSelection(text, selection, shiftKey);
  }
  return applyTabToLine(text, selection.start, shiftKey);
}
function applyEnterKey(text, selection) {
  const { start, end } = selection;
  const { lineStart, lineEnd } = getCurrentLineBounds(text, start);
  const lineText = text.slice(lineStart, lineEnd);
  const metadata = getListMetadata(lineText);
  if (metadata.listLevel === 0) {
    return {
      text: text.slice(0, start) + "\n" + text.slice(end),
      selectionStart: start + 1,
      selectionEnd: start + 1
    };
  }
  if (metadata.ordered && lineText.trim().match(/^\d+\.$/)) {
    return normalizeListEdit(
      text.slice(0, lineStart) + text.slice(lineEnd),
      { start: lineStart, end: lineStart },
      { start: lineStart, end: lineStart }
    );
  }
  if (!metadata.ordered && lineText.trim() === "-") {
    return {
      text: text.slice(0, lineStart) + text.slice(lineEnd),
      selectionStart: lineStart,
      selectionEnd: lineStart
    };
  }
  const indent = "    ".repeat(metadata.listLevel - 1);
  const prefix = metadata.ordered ? `${indent}${metadata.listNumber + 1}. ` : `${indent}- `;
  const nextSelection = start + 1 + prefix.length;
  return normalizeListEdit(
    text.slice(0, start) + "\n" + prefix + text.slice(end),
    { start: lineStart, end: nextSelection },
    { start: nextSelection, end: nextSelection }
  );
}
function applyDeleteBackward(text, selection) {
  const change = deleteBackward(text, selection);
  return normalizeListEdit(change.text, getDeleteAffectedRange(text, selection, "backward"), {
    start: change.selectionStart,
    end: change.selectionEnd
  });
}
function applyDeleteForward(text, selection) {
  const change = deleteForward(text, selection);
  return normalizeListEdit(change.text, getDeleteAffectedRange(text, selection, "forward"), {
    start: change.selectionStart,
    end: change.selectionEnd
  });
}
function applyTabToSelection(text, selection, shiftKey) {
  const { blockStart, blockEnd } = getSelectedBlockBounds(text, selection);
  const block = text.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const modified = lines.map((line) => {
    const metadata = getListMetadata(line);
    if (shiftKey) {
      if (line.startsWith("    ")) return line.slice(4);
      if (metadata.listLevel === 1) return line.replace(/^- /, "").replace(/^\d+\. /, "");
      return line;
    }
    return `    ${line}`;
  });
  const nextBlock = modified.join("\n");
  return normalizeListEdit(
    text.slice(0, blockStart) + nextBlock + text.slice(blockEnd),
    { start: blockStart, end: blockStart + nextBlock.length },
    { start: blockStart, end: blockStart + nextBlock.length }
  );
}
function applyTabToLine(text, position, shiftKey) {
  const { lineStart, lineEnd } = getCurrentLineBounds(text, position);
  const lineText = text.slice(lineStart, lineEnd);
  const metadata = getListMetadata(lineText);
  if (shiftKey) {
    if (lineText.startsWith("    ")) {
      return normalizeListEdit(
        text.slice(0, lineStart) + lineText.slice(4) + text.slice(lineEnd),
        { start: lineStart, end: lineEnd - 4 },
        { start: position - 4, end: position - 4 }
      );
    }
    if (metadata.listLevel === 1) {
      const updatedLine = lineText.replace(/^- /, "").replace(/^\d+\. /, "");
      const nextSelection = Math.max(lineStart, position - metadata.prefix.length);
      return normalizeListEdit(
        text.slice(0, lineStart) + updatedLine + text.slice(lineEnd),
        { start: lineStart, end: lineStart + updatedLine.length },
        { start: nextSelection, end: nextSelection }
      );
    }
    return {
      text,
      selectionStart: position,
      selectionEnd: position
    };
  }
  if (metadata.listLevel > 0) {
    return normalizeListEdit(
      text.slice(0, lineStart) + "    " + text.slice(lineStart),
      { start: lineStart, end: lineEnd + 4 },
      { start: position + 4, end: position + 4 }
    );
  }
  return {
    text: text.slice(0, position) + "    " + text.slice(position),
    selectionStart: position + 4,
    selectionEnd: position + 4
  };
}
function normalizeListEdit(text, affectedRange, selection) {
  return normalizeOrderedListNumbers(text, affectedRange, selection);
}
function getDeleteAffectedRange(text, selection, direction) {
  if (selection.start !== selection.end) {
    return selection;
  }
  if (direction === "backward") {
    const start = Math.max(0, selection.start - 1);
    return { start, end: selection.start };
  }
  const end = Math.min(text.length, selection.end + 1);
  return { start: selection.start, end };
}

// tests/commands.test.ts
test("applyTabKey renumbers the whole ordered sublist when indenting a subset selection", () => {
  const source = "1. one\n2. two\n3. three";
  const start = source.indexOf("2. two");
  const end = source.length;
  const change = applyTabKey(source, { start, end }, false);
  assert.equal(change.text, "1. one\n    1. two\n    2. three");
  assert.equal(change.selectionStart, 7);
  assert.equal(change.selectionEnd, change.text.length);
});
test("applyTabKey renumbers following siblings when indenting a single ordered item", () => {
  const source = "1. one\n2. two\n3. three";
  const cursor = source.indexOf("2. two");
  const change = applyTabKey(source, { start: cursor, end: cursor }, false);
  assert.equal(change.text, "1. one\n    1. two\n2. three");
  assert.equal(change.selectionStart, cursor + 4);
  assert.equal(change.selectionEnd, cursor + 4);
});
test("applyEnterKey inserts a list item and renumbers later ordered siblings", () => {
  const source = "1. one\n2. two\n3. three";
  const cursor = source.indexOf("2. two") + "2. two".length;
  const change = applyEnterKey(source, { start: cursor, end: cursor });
  assert.equal(change.text, "1. one\n2. two\n3. \n4. three");
  assert.equal(change.selectionStart, "1. one\n2. two\n3. ".length);
  assert.equal(change.selectionEnd, change.selectionStart);
});
test("applyEnterKey preserves plain paragraphs without list normalization", () => {
  const source = "alpha beta";
  const cursor = 5;
  const change = applyEnterKey(source, { start: cursor, end: cursor });
  assert.equal(change.text, "alpha\n beta");
  assert.equal(change.selectionStart, 6);
  assert.equal(change.selectionEnd, 6);
});
test("applyEnterKey inserts a nested ordered item and renumbers only that nested list", () => {
  const source = "1. parent\n    1. child\n    2. sibling\n2. outer";
  const cursor = source.indexOf("1. child") + "1. child".length;
  const change = applyEnterKey(source, { start: cursor, end: cursor });
  assert.equal(change.text, "1. parent\n    1. child\n    2. \n    3. sibling\n2. outer");
  assert.equal(change.selectionStart, "1. parent\n    1. child\n    2. ".length);
  assert.equal(change.selectionEnd, change.selectionStart);
});
test("applyDeleteBackward renumbers ordered list siblings after removing a middle item", () => {
  const source = "1. one\n2. two\n3. three";
  const start = source.indexOf("2. two");
  const end = start + "2. two\n".length;
  const change = applyDeleteBackward(source, { start, end });
  assert.equal(change.text, "1. one\n2. three");
  assert.equal(change.selectionStart, start);
  assert.equal(change.selectionEnd, start);
});
test("applyDeleteForward renumbers ordered list siblings after removing a middle item", () => {
  const source = "1. one\n2. two\n3. three";
  const start = source.indexOf("2. two");
  const end = start + "2. two\n".length;
  const change = applyDeleteForward(source, { start, end });
  assert.equal(change.text, "1. one\n2. three");
  assert.equal(change.selectionStart, start);
  assert.equal(change.selectionEnd, start);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY29tbWFuZHMudGVzdC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9wYXJzZXIudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvbGlzdHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvdGV4dC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb21tYW5kcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7XG5cdGFwcGx5RGVsZXRlQmFja3dhcmQsXG5cdGFwcGx5RGVsZXRlRm9yd2FyZCxcblx0YXBwbHlFbnRlcktleSxcblx0YXBwbHlUYWJLZXlcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29tbWFuZHMudHMnO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgdGhlIHdob2xlIG9yZGVyZWQgc3VibGlzdCB3aGVuIGluZGVudGluZyBhIHN1YnNldCBzZWxlY3Rpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzb3VyY2UubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydCwgZW5kIH0sIGZhbHNlKTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICcxLiBvbmVcXG4gICAgMS4gdHdvXFxuICAgIDIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDcpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnRleHQubGVuZ3RoKTtcbn0pO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgZm9sbG93aW5nIHNpYmxpbmdzIHdoZW4gaW5kZW50aW5nIGEgc2luZ2xlIG9yZGVyZWQgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9LCBmYWxzZSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuICAgIDEuIHR3b1xcbjIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIGN1cnNvciArIDQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY3Vyc29yICsgNCk7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbGlzdCBpdGVtIGFuZCByZW51bWJlcnMgbGF0ZXIgb3JkZXJlZCBzaWJsaW5ncycsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpICsgJzIuIHR3bycubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG9uZVxcbjIuIHR3b1xcbjMuIFxcbjQuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBvbmVcXG4yLiB0d29cXG4zLiAnLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uRW5kLCBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RW50ZXJLZXkgcHJlc2VydmVzIHBsYWluIHBhcmFncmFwaHMgd2l0aG91dCBsaXN0IG5vcm1hbGl6YXRpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICdhbHBoYSBiZXRhJztcblx0Y29uc3QgY3Vyc29yID0gNTtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseUVudGVyS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9KTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICdhbHBoYVxcbiBiZXRhJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDYpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgNik7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbmVzdGVkIG9yZGVyZWQgaXRlbSBhbmQgcmVudW1iZXJzIG9ubHkgdGhhdCBuZXN0ZWQgbGlzdCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBzaWJsaW5nXFxuMi4gb3V0ZXInO1xuXHRjb25zdCBjdXJzb3IgPSBzb3VyY2UuaW5kZXhPZignMS4gY2hpbGQnKSArICcxLiBjaGlsZCcubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBcXG4gICAgMy4gc2libGluZ1xcbjIuIG91dGVyJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBwYXJlbnRcXG4gICAgMS4gY2hpbGRcXG4gICAgMi4gJy5sZW5ndGgpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnNlbGVjdGlvblN0YXJ0KTtcbn0pO1xuXG50ZXN0KCdhcHBseURlbGV0ZUJhY2t3YXJkIHJlbnVtYmVycyBvcmRlcmVkIGxpc3Qgc2libGluZ3MgYWZ0ZXIgcmVtb3ZpbmcgYSBtaWRkbGUgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3Qgc3RhcnQgPSBzb3VyY2UuaW5kZXhPZignMi4gdHdvJyk7XG5cdGNvbnN0IGVuZCA9IHN0YXJ0ICsgJzIuIHR3b1xcbicubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RGVsZXRlQmFja3dhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RGVsZXRlRm9yd2FyZCByZW51bWJlcnMgb3JkZXJlZCBsaXN0IHNpYmxpbmdzIGFmdGVyIHJlbW92aW5nIGEgbWlkZGxlIGl0ZW0nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzdGFydCArICcyLiB0d29cXG4nLmxlbmd0aDtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseURlbGV0ZUZvcndhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG4iLCAiaW1wb3J0IHR5cGUge1xuXHRCbG9ja05vZGUsXG5cdENvZGVCbG9jayxcblx0Rm9ybWF0dGVkTm9kZSxcblx0SGVhZGluZ0Jsb2NrLFxuXHRJbmxpbmVOb2RlLFxuXHRMaXN0QmxvY2ssXG5cdExpc3RJdGVtQmxvY2ssXG5cdFBhcmFncmFwaEJsb2NrLFxuXHRTb3VyY2VSYW5nZSxcblx0VGV4dE5vZGVcbn0gZnJvbSAnLi9hc3QnO1xuXG5leHBvcnQgdHlwZSBMaW5lS2luZCA9XG5cdHwgJ3BhcmFncmFwaCdcblx0fCAnaGVhZGluZydcblx0fCAndW5vcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnb3JkZXJlZF9saXN0X2l0ZW0nXG5cdHwgJ2NvZGVfZmVuY2UnXG5cdHwgJ2NvZGVfY29udGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yTGluZSB7XG5cdGlkOiBzdHJpbmc7XG5cdGluZGV4OiBudW1iZXI7XG5cdHJhdzogc3RyaW5nO1xuXHRyYW5nZTogU291cmNlUmFuZ2U7XG5cdGtpbmQ6IExpbmVLaW5kO1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRoZWFkaW5nTGV2ZWw6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG5cdHByZWZpeFJhbmdlOiBTb3VyY2VSYW5nZSB8IG51bGw7XG5cdGNvbnRlbnRSYW5nZTogU291cmNlUmFuZ2U7XG5cdGlubGluZTogSW5saW5lTm9kZVtdO1xuXHRjb2RlQmxvY2tMYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JEb2N1bWVudCB7XG5cdHRleHQ6IHN0cmluZztcblx0YmxvY2tzOiBCbG9ja05vZGVbXTtcblx0bGluZXM6IEVkaXRvckxpbmVbXTtcbn1cblxuaW50ZXJmYWNlIFJhd0xpbmUge1xuXHRpbmRleDogbnVtYmVyO1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTGluZVByZWZpeEluZm8ge1xuXHRraW5kOiAncGFyYWdyYXBoJyB8ICdoZWFkaW5nJyB8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyB8ICdvcmRlcmVkX2xpc3RfaXRlbScgfCAnY29kZV9mZW5jZSc7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0bGFuZ3VhZ2U6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERvY3VtZW50KHJhd1RleHQ6IHN0cmluZyk6IEVkaXRvckRvY3VtZW50IHtcblx0Y29uc3QgdGV4dCA9IG5vcm1hbGl6ZVRleHQocmF3VGV4dCk7XG5cdGNvbnN0IHJhd0xpbmVzID0gYnVpbGRSYXdMaW5lcyh0ZXh0KTtcblx0Y29uc3QgYmxvY2tzID0gcGFyc2VCbG9ja3MocmF3TGluZXMpO1xuXHRjb25zdCBsaW5lcyA9IGRlcml2ZUxpbmVzKGJsb2Nrcyk7XG5cdHJldHVybiB7IHRleHQsIGJsb2NrcywgbGluZXMgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQocmF3VGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHJhd1RleHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJFZGl0b3JMaW5lKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRjb25zdCBwcmVmaXggPSBsaW5lLnByZWZpeFJhbmdlID8gcmVuZGVyRWRpdG9yVGV4dChsaW5lLnByZWZpeCkgOiAnJztcblx0Y29uc3QgY29udGVudCA9IGxpbmUua2luZC5zdGFydHNXaXRoKCdjb2RlXycpXG5cdFx0PyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucmF3LnNsaWNlKGxpbmUucHJlZml4Lmxlbmd0aCkpXG5cdFx0OiByZW5kZXJFZGl0b3JJbmxpbmUobGluZS5pbmxpbmUpO1xuXHRjb25zdCBib2R5ID0gcHJlZml4ICsgKGNvbnRlbnQgfHwgKGxpbmUucmF3Lmxlbmd0aCA9PT0gMCA/ICc8YnI+JyA6ICcnKSk7XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBsaW5lLmtpbmQgPT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykge1xuXHRcdGNvbnN0IHByZWZpeFdpZHRoID0gbGluZS5wcmVmaXgudHJpbVN0YXJ0KCkubGVuZ3RoO1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogJHtsaW5lLmxpc3RMZXZlbCAtIDF9OyAtLXByZWZpeC13aWR0aDogJHtwcmVmaXhXaWR0aH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdjb2RlX2ZlbmNlJyB8fCBsaW5lLmtpbmQgPT09ICdjb2RlX2NvbnRlbnQnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBjb2RlICR7bGluZS5raW5kfVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50OiBFZGl0b3JEb2N1bWVudCwgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBzdHJpbmcge1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHMgPSBkb2N1bWVudC5ibG9ja3Ncblx0XHQubWFwKChibG9jaykgPT4gcmVuZGVyQmxvY2tTZWxlY3Rpb24oZG9jdW1lbnQudGV4dCwgYmxvY2ssIHN0YXJ0LCBlbmQpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbik7XG5cblx0cmV0dXJuIGA8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPiR7cGFydHMuam9pbignJyl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMaW5lSW5kZXgobGluZXM6IEVkaXRvckxpbmVbXSwgb2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgbGluZXMubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBuZXh0U3RhcnQgPSBpbmRleCArIDEgPCBsaW5lcy5sZW5ndGggPyBsaW5lc1tpbmRleCArIDFdLnJhbmdlLnN0YXJ0IDogbGluZS5yYW5nZS5lbmQgKyAxO1xuXHRcdGlmIChvZmZzZXQgPCBuZXh0U3RhcnQpIHJldHVybiBpbmRleDtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5sZW5ndGggLSAxO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGluZVJlbmRlclNpZ25hdHVyZShsaW5lOiBFZGl0b3JMaW5lKTogc3RyaW5nIHtcblx0cmV0dXJuIFtcblx0XHRsaW5lLmtpbmQsXG5cdFx0bGluZS5yYXcsXG5cdFx0bGluZS5wcmVmaXgsXG5cdFx0bGluZS5saXN0TGV2ZWwsXG5cdFx0bGluZS5saXN0TnVtYmVyLFxuXHRcdGxpbmUuaGVhZGluZ0xldmVsLFxuXHRcdGxpbmUuY29kZUJsb2NrTGFuZ3VhZ2UgPz8gJydcblx0XS5qb2luKCdcXHUwMDAxJyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUmF3TGluZXModGV4dDogc3RyaW5nKTogUmF3TGluZVtdIHtcblx0Y29uc3Qgc3BsaXQgPSB0ZXh0LnNwbGl0KCdcXG4nKTtcblx0Y29uc3QgbGluZXM6IFJhd0xpbmVbXSA9IFtdO1xuXHRsZXQgb2Zmc2V0ID0gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3BsaXQubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IHNwbGl0W2luZGV4XTtcblx0XHRsaW5lcy5wdXNoKHtcblx0XHRcdGluZGV4LFxuXHRcdFx0dGV4dDogbGluZSxcblx0XHRcdHN0YXJ0OiBvZmZzZXQsXG5cdFx0XHRlbmQ6IG9mZnNldCArIGxpbmUubGVuZ3RoXG5cdFx0fSk7XG5cdFx0b2Zmc2V0ICs9IGxpbmUubGVuZ3RoICsgMTtcblx0fVxuXG5cdHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gcGFyc2VCbG9ja3MobGluZXM6IFJhd0xpbmVbXSk6IEJsb2NrTm9kZVtdIHtcblx0cmV0dXJuIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgMCwgMCkuYmxvY2tzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsaXN0TGV2ZWw6IG51bWJlcikge1xuXHRjb25zdCBibG9ja3M6IEJsb2NrTm9kZVtdID0gW107XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXG5cdFx0aWYgKGxpc3RMZXZlbCA+IDApIHtcblx0XHRcdGlmIChsaW5lLnRleHQudHJpbSgpID09PSAnJykgYnJlYWs7XG5cdFx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKFxuXHRcdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdFx0cHJlZml4Lmxpc3RMZXZlbCA8IGxpc3RMZXZlbFxuXHRcdFx0KSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBwcmVmaXgua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUxpc3QobGluZXMsIGluZGV4LCBwcmVmaXgubGlzdExldmVsLCBwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnaGVhZGluZycpIHtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlSGVhZGluZyhsaW5lLCBwcmVmaXgpKTtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRibG9ja3MucHVzaChwYXJzZVBhcmFncmFwaChsaW5lKSk7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7IGJsb2NrcywgbmV4dEluZGV4OiBpbmRleCB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUxpc3QobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCBvcmRlcmVkOiBib29sZWFuKSB7XG5cdGNvbnN0IGl0ZW1zOiBMaXN0SXRlbUJsb2NrW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKFxuXHRcdFx0KHByZWZpeC5raW5kICE9PSAnb3JkZXJlZF9saXN0X2l0ZW0nICYmIHByZWZpeC5raW5kICE9PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHx8XG5cdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGV2ZWwgfHxcblx0XHRcdChwcmVmaXgubGlzdExldmVsID09PSBsZXZlbCAmJiAocHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScpICE9PSBvcmRlcmVkKVxuXHRcdCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5saXN0TGV2ZWwgPiBsZXZlbCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaXRlbVN0YXJ0ID0gbGluZS5zdGFydDtcblx0XHRjb25zdCBpdGVtUHJlZml4TGVuZ3RoID0gcHJlZml4LnByZWZpeC5sZW5ndGg7XG5cdFx0Y29uc3QgaXRlbTogTGlzdEl0ZW1CbG9jayA9IHtcblx0XHRcdHR5cGU6ICdsaXN0X2l0ZW0nLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0bGluZVJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsZXZlbCxcblx0XHRcdG9yZGVyZWQsXG5cdFx0XHRudW1iZXI6IHByZWZpeC5saXN0TnVtYmVyLFxuXHRcdFx0cHJlZml4OiBwcmVmaXgucHJlZml4LFxuXHRcdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShpdGVtUHJlZml4TGVuZ3RoKSwgbGluZS5zdGFydCArIGl0ZW1QcmVmaXhMZW5ndGgpLFxuXHRcdFx0Y2hpbGRyZW46IFtdXG5cdFx0fTtcblxuXHRcdGluZGV4ICs9IDE7XG5cdFx0Y29uc3QgY2hpbGRQYXJzZWQgPSBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXMsIGluZGV4LCBsZXZlbCArIDEpO1xuXHRcdGl0ZW0uY2hpbGRyZW4gPSBjaGlsZFBhcnNlZC5ibG9ja3M7XG5cdFx0Y29uc3QgY2hpbGRFbmQgPVxuXHRcdFx0aXRlbS5jaGlsZHJlbi5sZW5ndGggPiAwID8gaXRlbS5jaGlsZHJlbltpdGVtLmNoaWxkcmVuLmxlbmd0aCAtIDFdLnJhbmdlLmVuZCA6IGl0ZW0ucmFuZ2UuZW5kO1xuXHRcdGl0ZW0ucmFuZ2UgPSB7IHN0YXJ0OiBpdGVtU3RhcnQsIGVuZDogY2hpbGRFbmQgfTtcblx0XHRpdGVtcy5wdXNoKGl0ZW0pO1xuXHRcdGluZGV4ID0gY2hpbGRQYXJzZWQubmV4dEluZGV4O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRibG9jazoge1xuXHRcdFx0dHlwZTogJ2xpc3QnLFxuXHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0c3RhcnQ6IGl0ZW1zWzBdPy5yYW5nZS5zdGFydCA/PyBsaW5lc1tzdGFydEluZGV4XS5zdGFydCxcblx0XHRcdFx0ZW5kOiBpdGVtc1tpdGVtcy5sZW5ndGggLSAxXT8ucmFuZ2UuZW5kID8/IGxpbmVzW3N0YXJ0SW5kZXhdLmVuZFxuXHRcdFx0fSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdGl0ZW1zXG5cdFx0fSBzYXRpc2ZpZXMgTGlzdEJsb2NrLFxuXHRcdG5leHRJbmRleDogaW5kZXhcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb2RlQmxvY2sobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyKSB7XG5cdGNvbnN0IG9wZW5MaW5lID0gbGluZXNbc3RhcnRJbmRleF07XG5cdGNvbnN0IG9wZW5QcmVmaXggPSBwYXJzZVByZWZpeChvcGVuTGluZS50ZXh0KTtcblx0Y29uc3QgY29udGVudExpbmVzOiBDb2RlQmxvY2tbJ2xpbmVzJ10gPSBbXTtcblx0bGV0IGNsb3NlRmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRsZXQgZW5kID0gb3BlbkxpbmUuZW5kO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4ICsgMTtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNsb3NlRmVuY2UgPSBwcmVmaXgucHJlZml4O1xuXHRcdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29udGVudExpbmVzLnB1c2goe1xuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdHRleHQ6IGxpbmUudGV4dFxuXHRcdH0pO1xuXHRcdGVuZCA9IGxpbmUuZW5kO1xuXHRcdGluZGV4ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnY29kZV9ibG9jaycsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogb3BlbkxpbmUuc3RhcnQsIGVuZCB9LFxuXHRcdFx0bGFuZ3VhZ2U6IG9wZW5QcmVmaXgubGFuZ3VhZ2UsXG5cdFx0XHRvcGVuRmVuY2U6IG9wZW5QcmVmaXgucHJlZml4LFxuXHRcdFx0Y2xvc2VGZW5jZSxcblx0XHRcdGxpbmVzOiBjb250ZW50TGluZXNcblx0XHR9IHNhdGlzZmllcyBDb2RlQmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUhlYWRpbmcobGluZTogUmF3TGluZSwgcHJlZml4OiBMaW5lUHJlZml4SW5mbyk6IEhlYWRpbmdCbG9jayB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IGxpbmUuc3RhcnQgKyBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAnaGVhZGluZycsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRsZXZlbDogcHJlZml4LmhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQuc2xpY2UocHJlZml4LnByZWZpeC5sZW5ndGgpLCBjb250ZW50U3RhcnQpXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFyYWdyYXBoKGxpbmU6IFJhd0xpbmUpOiBQYXJhZ3JhcGhCbG9jayB7XG5cdHJldHVybiB7XG5cdFx0dHlwZTogJ3BhcmFncmFwaCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dCwgbGluZS5zdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gZGVyaXZlTGluZXMoYmxvY2tzOiBCbG9ja05vZGVbXSk6IEVkaXRvckxpbmVbXSB7XG5cdGNvbnN0IGxpbmVzOiBFZGl0b3JMaW5lW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGFwcGVuZEJsb2NrTGluZXMoYmxvY2ssIGxpbmVzKTtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5tYXAoKGxpbmUsIGluZGV4KSA9PiAoe1xuXHRcdC4uLmxpbmUsXG5cdFx0aWQ6IGBsaW5lLSR7aW5kZXh9YCxcblx0XHRpbmRleFxuXHR9KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZEJsb2NrTGluZXMoYmxvY2s6IEJsb2NrTm9kZSwgbGluZXM6IEVkaXRvckxpbmVbXSkge1xuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRsaW5lcy5wdXNoKGNyZWF0ZUJhc2VMaW5lKGJsb2NrLnJhdywgYmxvY2sucmFuZ2UsICdwYXJhZ3JhcGgnLCAnJywgbnVsbCwgYmxvY2suaW5saW5lKSk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sucmF3LFxuXHRcdFx0XHRibG9jay5yYW5nZSxcblx0XHRcdFx0J2hlYWRpbmcnLFxuXHRcdFx0XHRibG9jay5wcmVmaXgsXG5cdFx0XHRcdG51bGwsXG5cdFx0XHRcdGJsb2NrLmlubGluZSxcblx0XHRcdFx0MCxcblx0XHRcdFx0MCxcblx0XHRcdFx0YmxvY2subGV2ZWxcblx0XHRcdClcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnY29kZV9ibG9jaycpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSArIChibG9jay5sYW5ndWFnZSA/IGJsb2NrLmxhbmd1YWdlIDogJycpLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c3RhcnQ6IGJsb2NrLnJhbmdlLnN0YXJ0LFxuXHRcdFx0XHRcdGVuZDogYmxvY2sucmFuZ2Uuc3RhcnQgKyBibG9jay5vcGVuRmVuY2UubGVuZ3RoICsgKGJsb2NrLmxhbmd1YWdlPy5sZW5ndGggPz8gMClcblx0XHRcdFx0fSxcblx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRibG9jay5vcGVuRmVuY2UsXG5cdFx0XHRcdGJsb2NrLmxhbmd1YWdlLFxuXHRcdFx0XHRbXVxuXHRcdFx0KVxuXHRcdCk7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUobGluZS50ZXh0LCBsaW5lLnJhbmdlLCAnY29kZV9jb250ZW50JywgJycsIGJsb2NrLmxhbmd1YWdlLCBbXSkpO1xuXHRcdH1cblxuXHRcdGlmIChibG9jay5jbG9zZUZlbmNlKSB7XG5cdFx0XHRjb25zdCBjbG9zZVN0YXJ0ID0gYmxvY2sucmFuZ2UuZW5kIC0gYmxvY2suY2xvc2VGZW5jZS5sZW5ndGg7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRibG9jay5jbG9zZUZlbmNlLFxuXHRcdFx0XHRcdHsgc3RhcnQ6IGNsb3NlU3RhcnQsIGVuZDogYmxvY2sucmFuZ2UuZW5kIH0sXG5cdFx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFx0W11cblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHR9XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdFx0aXRlbS5yYXcsXG5cdFx0XHRcdFx0aXRlbS5saW5lUmFuZ2UsXG5cdFx0XHRcdFx0aXRlbS5vcmRlcmVkID8gJ29yZGVyZWRfbGlzdF9pdGVtJyA6ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdFx0XHRpdGVtLnByZWZpeCxcblx0XHRcdFx0XHRudWxsLFxuXHRcdFx0XHRcdGl0ZW0uaW5saW5lLFxuXHRcdFx0XHRcdGl0ZW0ubGV2ZWwsXG5cdFx0XHRcdFx0aXRlbS5udW1iZXJcblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHRcdGZvciAoY29uc3QgY2hpbGQgb2YgaXRlbS5jaGlsZHJlbikge1xuXHRcdFx0XHRhcHBlbmRCbG9ja0xpbmVzKGNoaWxkLCBsaW5lcyk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhc2VMaW5lKFxuXHRyYXc6IHN0cmluZyxcblx0cmFuZ2U6IFNvdXJjZVJhbmdlLFxuXHRraW5kOiBMaW5lS2luZCxcblx0cHJlZml4OiBzdHJpbmcsXG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0bGlzdExldmVsID0gMCxcblx0bGlzdE51bWJlciA9IDAsXG5cdGhlYWRpbmdMZXZlbCA9IDBcbik6IEVkaXRvckxpbmUge1xuXHRjb25zdCBjb250ZW50U3RhcnQgPSByYW5nZS5zdGFydCArIHByZWZpeC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0aWQ6ICcnLFxuXHRcdGluZGV4OiAwLFxuXHRcdHJhdyxcblx0XHRyYW5nZSxcblx0XHRraW5kLFxuXHRcdGxpc3RMZXZlbCxcblx0XHRsaXN0TnVtYmVyLFxuXHRcdGhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXgsXG5cdFx0cHJlZml4UmFuZ2U6IHByZWZpeC5sZW5ndGggPiAwID8geyBzdGFydDogcmFuZ2Uuc3RhcnQsIGVuZDogY29udGVudFN0YXJ0IH0gOiBudWxsLFxuXHRcdGNvbnRlbnRSYW5nZTogeyBzdGFydDogY29udGVudFN0YXJ0LCBlbmQ6IHJhbmdlLmVuZCB9LFxuXHRcdGlubGluZSxcblx0XHRjb2RlQmxvY2tMYW5ndWFnZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVByZWZpeChyYXc6IHN0cmluZyk6IExpbmVQcmVmaXhJbmZvIHtcblx0Y29uc3QgY29kZUZlbmNlTWF0Y2ggPSByYXcubWF0Y2goL15gYGAoW0EtWmEtejAtOV8tXSspP1xccyokLyk7XG5cdGlmIChjb2RlRmVuY2VNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnY29kZV9mZW5jZScsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiAnYGBgJyxcblx0XHRcdGxhbmd1YWdlOiBjb2RlRmVuY2VNYXRjaFsxXSA/PyBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IHVub3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKiktIC8pO1xuXHRpZiAodW5vcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiB1bm9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3Qgb3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ29yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdGxpc3RMZXZlbDogb3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBoZWFkaW5nTWF0Y2ggPSByYXcubWF0Y2goL14oI3sxLDZ9KVxccysvKTtcblx0aWYgKGhlYWRpbmdNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnaGVhZGluZycsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiBoZWFkaW5nTWF0Y2hbMV0ubGVuZ3RoLFxuXHRcdFx0cHJlZml4OiBoZWFkaW5nTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGtpbmQ6ICdwYXJhZ3JhcGgnLFxuXHRcdGxpc3RMZXZlbDogMCxcblx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRwcmVmaXg6ICcnLFxuXHRcdGxhbmd1YWdlOiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSW5saW5lKHJhdzogc3RyaW5nLCBzdGFydE9mZnNldDogbnVtYmVyKTogSW5saW5lTm9kZVtdIHtcblx0Y29uc3QgaW5saW5lOiBJbmxpbmVOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gMDtcblxuXHR3aGlsZSAoaW5kZXggPCByYXcubGVuZ3RoKSB7XG5cdFx0Y29uc3QgZm9ybWF0dGVkTm9kZSA9IHBhcnNlRm9ybWF0dGVkTm9kZShyYXcsIHN0YXJ0T2Zmc2V0LCBpbmRleCk7XG5cdFx0aWYgKGZvcm1hdHRlZE5vZGUpIHtcblx0XHRcdGlubGluZS5wdXNoKGZvcm1hdHRlZE5vZGUubm9kZSk7XG5cdFx0XHRpbmRleCA9IGZvcm1hdHRlZE5vZGUubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0bGV0IG5leHRNYXJrZXIgPSByYXcubGVuZ3RoO1xuXHRcdGNvbnN0IHN0YXJJbmRleCA9IHJhdy5pbmRleE9mKCcqJywgaW5kZXgpO1xuXHRcdGlmIChzdGFySW5kZXggIT09IC0xKSBuZXh0TWFya2VyID0gc3RhckluZGV4O1xuXG5cdFx0aWYgKG5leHRNYXJrZXIgPT09IGluZGV4KSB7XG5cdFx0XHRpbmxpbmUucHVzaCh7XG5cdFx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBpbmRleCArIDEgfSxcblx0XHRcdFx0dGV4dDogcmF3W2luZGV4XVxuXHRcdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHQgPSByYXcuc2xpY2UoaW5kZXgsIG5leHRNYXJrZXIpO1xuXHRcdGlubGluZS5wdXNoKHtcblx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LCBlbmQ6IHN0YXJ0T2Zmc2V0ICsgbmV4dE1hcmtlciB9LFxuXHRcdFx0dGV4dFxuXHRcdH0gc2F0aXNmaWVzIFRleHROb2RlKTtcblx0XHRpbmRleCA9IG5leHRNYXJrZXI7XG5cdH1cblxuXHRyZXR1cm4gaW5saW5lO1xufVxuXG5mdW5jdGlvbiBwYXJzZUZvcm1hdHRlZE5vZGUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIsIGluZGV4OiBudW1iZXIpIHtcblx0Zm9yIChjb25zdCBtYXJrZXIgb2YgWycqKionLCAnKionLCAnKiddIGFzIGNvbnN0KSB7XG5cdFx0aWYgKCFyYXcuc3RhcnRzV2l0aChtYXJrZXIsIGluZGV4KSkgY29udGludWU7XG5cblx0XHRjb25zdCBjbG9zZSA9IHJhdy5pbmRleE9mKG1hcmtlciwgaW5kZXggKyBtYXJrZXIubGVuZ3RoKTtcblx0XHRpZiAoY2xvc2UgPT09IC0xKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNvbnRlbnRTdGFydCA9IGluZGV4ICsgbWFya2VyLmxlbmd0aDtcblx0XHRjb25zdCBjb250ZW50RW5kID0gY2xvc2U7XG5cdFx0aWYgKGNvbnRlbnRTdGFydCA+PSBjb250ZW50RW5kKSBjb250aW51ZTtcblx0XHRpZiAocmF3W2NvbnRlbnRTdGFydF0gPT09ICcgJyB8fCByYXdbY29udGVudEVuZCAtIDFdID09PSAnICcpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgdHlwZSA9IG1hcmtlciA9PT0gJyoqKicgPyAnc3Ryb25nX2VtcGhhc2lzJyA6IG1hcmtlciA9PT0gJyoqJyA/ICdzdHJvbmcnIDogJ2VtcGhhc2lzJztcblxuXHRcdHJldHVybiB7XG5cdFx0XHRub2RlOiB7XG5cdFx0XHRcdHR5cGUsXG5cdFx0XHRcdHJhbmdlOiB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNsb3NlICsgbWFya2VyLmxlbmd0aFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRjb250ZW50UmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBjb250ZW50U3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNvbnRlbnRFbmRcblx0XHRcdFx0fSxcblx0XHRcdFx0bWFya2VyLFxuXHRcdFx0XHR0ZXh0OiByYXcuc2xpY2UoY29udGVudFN0YXJ0LCBjb250ZW50RW5kKVxuXHRcdFx0fSBzYXRpc2ZpZXMgRm9ybWF0dGVkTm9kZSxcblx0XHRcdG5leHRJbmRleDogY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JJbmxpbmUoaW5saW5lOiBJbmxpbmVOb2RlW10pOiBzdHJpbmcge1xuXHRyZXR1cm4gaW5saW5lXG5cdFx0Lm1hcCgobm9kZSkgPT4ge1xuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRcdHJldHVybiByZW5kZXJFZGl0b3JUZXh0KG5vZGUudGV4dCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG1hcmtlciA9IGA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4ke2VzY2FwZUh0bWwobm9kZS5tYXJrZXIpfTwvc3Bhbj5gO1xuXHRcdFx0Y29uc3QgY29udGVudCA9IGVzY2FwZUh0bWwobm9kZS50ZXh0KTtcblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2VtcGhhc2lzJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxlbT4ke2NvbnRlbnR9PC9lbT4ke21hcmtlcn1gO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxzdHJvbmc+JHtjb250ZW50fTwvc3Ryb25nPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz48ZW0+JHtjb250ZW50fTwvZW0+PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHR9KVxuXHRcdC5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQmxvY2tTZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0YmxvY2s6IEJsb2NrTm9kZSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gYmxvY2sucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gYmxvY2sucmFuZ2UuZW5kKSByZXR1cm4gJyc7XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdwYXJhZ3JhcGgnKSB7XG5cdFx0cmV0dXJuIGA8cD4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvcD5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdHJldHVybiBgPHA+PHN0cm9uZz4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvc3Ryb25nPjwvcD5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdjb2RlX2Jsb2NrJykge1xuXHRcdGNvbnN0IGNvZGVQYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGlmIChlbmQgPD0gbGluZS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBsaW5lLnJhbmdlLmVuZCkgY29udGludWU7XG5cdFx0XHRjb2RlUGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbGluZS5yYW5nZSwgc3RhcnQsIGVuZCkpKTtcblx0XHR9XG5cdFx0cmV0dXJuIGA8cHJlPjxjb2RlPiR7Y29kZVBhcnRzLmpvaW4oJ1xcbicpfTwvY29kZT48L3ByZT5gO1xuXHR9XG5cblx0Y29uc3QgdGFnID0gYmxvY2sub3JkZXJlZCA/ICdvbCcgOiAndWwnO1xuXHRjb25zdCBpdGVtcyA9IGJsb2NrLml0ZW1zXG5cdFx0Lm1hcCgoaXRlbSkgPT4gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbSwgc3RhcnQsIGVuZCkpXG5cdFx0LmZpbHRlcihCb29sZWFuKVxuXHRcdC5qb2luKCcnKTtcblx0cmV0dXJuIGl0ZW1zID8gYDwke3RhZ30+JHtpdGVtc308LyR7dGFnfT5gIDogJyc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckxpc3RJdGVtU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGl0ZW06IExpc3RJdGVtQmxvY2ssXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRpZiAoZW5kIDw9IGl0ZW0ucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gaXRlbS5yYW5nZS5lbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgaXRlbUlubGluZSA9IHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGl0ZW0uaW5saW5lLCBzdGFydCwgZW5kKTtcblx0cGFydHMucHVzaChpdGVtSW5saW5lIHx8ICc8YnI+Jyk7XG5cblx0Zm9yIChjb25zdCBjaGlsZCBvZiBpdGVtLmNoaWxkcmVuKSB7XG5cdFx0Y29uc3QgY2hpbGRIdG1sID0gcmVuZGVyQmxvY2tTZWxlY3Rpb24oc291cmNlVGV4dCwgY2hpbGQsIHN0YXJ0LCBlbmQpO1xuXHRcdGlmIChjaGlsZEh0bWwpIHBhcnRzLnB1c2goY2hpbGRIdG1sKTtcblx0fVxuXG5cdHJldHVybiBgPGxpPiR7cGFydHMuam9pbignJyl9PC9saT5gO1xufVxuXG5mdW5jdGlvbiByZW5kZXJTZW1hbnRpY0lubGluZVNlbGVjdGlvbihcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChzdGFydCA+PSBlbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IG5vZGUgb2YgaW5saW5lKSB7XG5cdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRjb25zdCBzbGljZSA9IHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbm9kZS5yYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0XHRpZiAoc2xpY2UpIHBhcnRzLnB1c2goZXNjYXBlSHRtbEZvckNsaXBib2FyZChzbGljZSkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaW5uZXJTbGljZSA9IHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbm9kZS5jb250ZW50UmFuZ2UsIHN0YXJ0LCBlbmQpO1xuXHRcdGlmICghaW5uZXJTbGljZSkgY29udGludWU7XG5cblx0XHRpZiAobm9kZS50eXBlID09PSAnZW1waGFzaXMnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8ZW0+JHtlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKGlubmVyU2xpY2UpfTwvZW0+YCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0cGFydHMucHVzaChgPHN0cm9uZz4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9zdHJvbmc+YCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPjxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT48L3N0cm9uZz5gKTtcblx0fVxuXG5cdHJldHVybiBwYXJ0cy5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gc2xpY2VSYW5nZShcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRyYW5nZTogU291cmNlUmFuZ2UsXG5cdHNlbGVjdGlvblN0YXJ0OiBudW1iZXIsXG5cdHNlbGVjdGlvbkVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRjb25zdCBzdGFydCA9IE1hdGgubWF4KHJhbmdlLnN0YXJ0LCBzZWxlY3Rpb25TdGFydCk7XG5cdGNvbnN0IGVuZCA9IE1hdGgubWluKHJhbmdlLmVuZCwgc2VsZWN0aW9uRW5kKTtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXHRyZXR1cm4gc291cmNlVGV4dC5zbGljZShzdGFydCwgZW5kKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRWRpdG9yVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5sZW5ndGggPT09IDAgPyAnJyA6IGVzY2FwZUh0bWwodGV4dCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRleHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBlc2NhcGVIdG1sKHRleHQpLnJlcGxhY2UoLyAvZywgJyZuYnNwOycpLnJlcGxhY2UoL1xcdC9nLCAnJm5ic3A7Jm5ic3A7Jm5ic3A7Jm5ic3A7Jyk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBCbG9ja05vZGUsIExpc3RCbG9jayB9IGZyb20gJy4vYXN0JztcbmltcG9ydCB7IGJ1aWxkRG9jdW1lbnQgfSBmcm9tICcuL3BhcnNlcic7XG5pbXBvcnQgdHlwZSB7IFNlbGVjdGlvblJhbmdlLCBUZXh0Q2hhbmdlIH0gZnJvbSAnLi90ZXh0JztcblxuZXhwb3J0IGludGVyZmFjZSBMaXN0TWV0YWRhdGEge1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0b3JkZXJlZDogYm9vbGVhbjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFRleHRSZXBsYWNlbWVudCB7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xuXHR0ZXh0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRMaXN0TWV0YWRhdGEobGluZVRleHQ6IHN0cmluZyk6IExpc3RNZXRhZGF0YSB7XG5cdGNvbnN0IHVub3JkZXJlZE1hdGNoID0gbGluZVRleHQubWF0Y2goL14oKD86IHs0fSkqKS0gLyk7XG5cdGlmICh1bm9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRsaXN0TGV2ZWw6IHVub3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0b3JkZXJlZDogZmFsc2UsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0cHJlZml4OiB1bm9yZGVyZWRNYXRjaFswXVxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBvcmRlcmVkTWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXigoPzogezR9KSopKFxcZCspXFwuIC8pO1xuXHRpZiAob3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGxpc3RMZXZlbDogb3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0b3JkZXJlZDogdHJ1ZSxcblx0XHRcdGxpc3ROdW1iZXI6IE51bWJlci5wYXJzZUludChvcmRlcmVkTWF0Y2hbMl0sIDEwKSxcblx0XHRcdHByZWZpeDogb3JkZXJlZE1hdGNoWzBdXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0bGlzdExldmVsOiAwLFxuXHRcdG9yZGVyZWQ6IGZhbHNlLFxuXHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0cHJlZml4OiAnJ1xuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlXG4pOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KHRleHQpO1xuXHRjb25zdCByZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdID0gW107XG5cblx0Y29sbGVjdE9yZGVyZWRMaXN0UmVwbGFjZW1lbnRzKGRvY3VtZW50LmJsb2NrcywgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblxuXHRpZiAocmVwbGFjZW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHNlbGVjdGlvbi5zdGFydCxcblx0XHRcdHNlbGVjdGlvbkVuZDogc2VsZWN0aW9uLmVuZFxuXHRcdH07XG5cdH1cblxuXHRyZXBsYWNlbWVudHMuc29ydCgobGVmdCwgcmlnaHQpID0+IHJpZ2h0LnN0YXJ0IC0gbGVmdC5zdGFydCk7XG5cblx0bGV0IG5leHRUZXh0ID0gdGV4dDtcblx0bGV0IHNlbGVjdGlvblN0YXJ0ID0gc2VsZWN0aW9uLnN0YXJ0O1xuXHRsZXQgc2VsZWN0aW9uRW5kID0gc2VsZWN0aW9uLmVuZDtcblxuXHRmb3IgKGNvbnN0IHJlcGxhY2VtZW50IG9mIHJlcGxhY2VtZW50cykge1xuXHRcdGNvbnN0IHJlcGxhY2VkTGVuZ3RoID0gcmVwbGFjZW1lbnQuZW5kIC0gcmVwbGFjZW1lbnQuc3RhcnQ7XG5cdFx0Y29uc3QgZGVsdGEgPSByZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCAtIHJlcGxhY2VkTGVuZ3RoO1xuXHRcdG5leHRUZXh0ID1cblx0XHRcdG5leHRUZXh0LnNsaWNlKDAsIHJlcGxhY2VtZW50LnN0YXJ0KSArIHJlcGxhY2VtZW50LnRleHQgKyBuZXh0VGV4dC5zbGljZShyZXBsYWNlbWVudC5lbmQpO1xuXHRcdHNlbGVjdGlvblN0YXJ0ID0gYWRqdXN0U2VsZWN0aW9uUG9pbnQoXG5cdFx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRcdHJlcGxhY2VtZW50LnN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuZW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQudGV4dC5sZW5ndGgsXG5cdFx0XHRkZWx0YVxuXHRcdCk7XG5cdFx0c2VsZWN0aW9uRW5kID0gYWRqdXN0U2VsZWN0aW9uUG9pbnQoXG5cdFx0XHRzZWxlY3Rpb25FbmQsXG5cdFx0XHRyZXBsYWNlbWVudC5zdGFydCxcblx0XHRcdHJlcGxhY2VtZW50LmVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnRleHQubGVuZ3RoLFxuXHRcdFx0ZGVsdGFcblx0XHQpO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHR0ZXh0OiBuZXh0VGV4dCxcblx0XHRzZWxlY3Rpb25TdGFydCxcblx0XHRzZWxlY3Rpb25FbmRcblx0fTtcbn1cblxuZnVuY3Rpb24gY29sbGVjdE9yZGVyZWRMaXN0UmVwbGFjZW1lbnRzKFxuXHRibG9ja3M6IEJsb2NrTm9kZVtdLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0cmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXVxuKSB7XG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdFx0Y29sbGVjdExpc3RSZXBsYWNlbWVudHMoYmxvY2ssIGFmZmVjdGVkUmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cdFx0XHRmb3IgKGNvbnN0IGl0ZW0gb2YgYmxvY2suaXRlbXMpIHtcblx0XHRcdFx0Y29sbGVjdE9yZGVyZWRMaXN0UmVwbGFjZW1lbnRzKGl0ZW0uY2hpbGRyZW4sIGFmZmVjdGVkUmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RMaXN0UmVwbGFjZW1lbnRzKFxuXHRibG9jazogTGlzdEJsb2NrLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0cmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXVxuKSB7XG5cdGlmICghYmxvY2sub3JkZXJlZCB8fCAhcmFuZ2VzSW50ZXJzZWN0KGJsb2NrLnJhbmdlLCBhZmZlY3RlZFJhbmdlKSkge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBibG9jay5pdGVtcy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBpdGVtID0gYmxvY2suaXRlbXNbaW5kZXhdITtcblx0XHRjb25zdCBleHBlY3RlZE51bWJlciA9IGluZGV4ICsgMTtcblx0XHRpZiAoaXRlbS5udW1iZXIgPT09IGV4cGVjdGVkTnVtYmVyKSBjb250aW51ZTtcblxuXHRcdHJlcGxhY2VtZW50cy5wdXNoKHtcblx0XHRcdHN0YXJ0OiBpdGVtLmxpbmVSYW5nZS5zdGFydCxcblx0XHRcdGVuZDogaXRlbS5saW5lUmFuZ2Uuc3RhcnQgKyBpdGVtLnByZWZpeC5sZW5ndGgsXG5cdFx0XHR0ZXh0OiBgJHsnICAgICcucmVwZWF0KGl0ZW0ubGV2ZWwgLSAxKX0ke2V4cGVjdGVkTnVtYmVyfS4gYFxuXHRcdH0pO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHJhbmdlc0ludGVyc2VjdChsZWZ0OiBTZWxlY3Rpb25SYW5nZSwgcmlnaHQ6IFNlbGVjdGlvblJhbmdlKSB7XG5cdHJldHVybiBsZWZ0LnN0YXJ0IDw9IHJpZ2h0LmVuZCAmJiByaWdodC5zdGFydCA8PSBsZWZ0LmVuZDtcbn1cblxuZnVuY3Rpb24gYWRqdXN0U2VsZWN0aW9uUG9pbnQoXG5cdHBvaW50OiBudW1iZXIsXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyLFxuXHRyZXBsYWNlbWVudExlbmd0aDogbnVtYmVyLFxuXHRkZWx0YTogbnVtYmVyXG4pIHtcblx0aWYgKHBvaW50ID4gZW5kKSB7XG5cdFx0cmV0dXJuIHBvaW50ICsgZGVsdGE7XG5cdH1cblxuXHRpZiAocG9pbnQgPj0gc3RhcnQpIHtcblx0XHRyZXR1cm4gc3RhcnQgKyBNYXRoLm1pbihwb2ludCAtIHN0YXJ0LCByZXBsYWNlbWVudExlbmd0aCk7XG5cdH1cblxuXHRyZXR1cm4gcG9pbnQ7XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBTZWxlY3Rpb25SYW5nZSB7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRleHRDaGFuZ2Uge1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHNlbGVjdGlvblN0YXJ0OiBudW1iZXI7XG5cdHNlbGVjdGlvbkVuZDogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVwbGFjZVJhbmdlKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdGluc2VydGVkVGV4dDogc3RyaW5nXG4pOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgbmV4dFRleHQgPSB0ZXh0LnNsaWNlKDAsIHNlbGVjdGlvbi5zdGFydCkgKyBpbnNlcnRlZFRleHQgKyB0ZXh0LnNsaWNlKHNlbGVjdGlvbi5lbmQpO1xuXHRjb25zdCBjdXJzb3IgPSBzZWxlY3Rpb24uc3RhcnQgKyBpbnNlcnRlZFRleHQubGVuZ3RoO1xuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBjdXJzb3IsXG5cdFx0c2VsZWN0aW9uRW5kOiBjdXJzb3Jcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZUJhY2t3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRpZiAoc2VsZWN0aW9uLnN0YXJ0ICE9PSBzZWxlY3Rpb24uZW5kKSB7XG5cdFx0cmV0dXJuIHJlcGxhY2VSYW5nZSh0ZXh0LCBzZWxlY3Rpb24sICcnKTtcblx0fVxuXG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgPT09IDApIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0c2VsZWN0aW9uRW5kOiAwXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiByZXBsYWNlUmFuZ2UoXG5cdFx0dGV4dCxcblx0XHR7XG5cdFx0XHRzdGFydDogc2VsZWN0aW9uLnN0YXJ0IC0gMSxcblx0XHRcdGVuZDogc2VsZWN0aW9uLmVuZFxuXHRcdH0sXG5cdFx0Jydcblx0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZUZvcndhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gcmVwbGFjZVJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJycpO1xuXHR9XG5cblx0aWYgKHNlbGVjdGlvbi5lbmQgPj0gdGV4dC5sZW5ndGgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IHNlbGVjdGlvbi5lbmRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHJlcGxhY2VSYW5nZShcblx0XHR0ZXh0LFxuXHRcdHtcblx0XHRcdHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsXG5cdFx0XHRlbmQ6IHNlbGVjdGlvbi5lbmQgKyAxXG5cdFx0fSxcblx0XHQnJ1xuXHQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dDogc3RyaW5nLCBwb3NpdGlvbjogbnVtYmVyKSB7XG5cdGNvbnN0IGJlZm9yZSA9IHRleHQuc2xpY2UoMCwgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lU3RhcnQgPSBiZWZvcmUubGFzdEluZGV4T2YoJ1xcbicpICsgMTtcblx0Y29uc3QgbmV4dE5ld2xpbmUgPSB0ZXh0LmluZGV4T2YoJ1xcbicsIHBvc2l0aW9uKTtcblx0Y29uc3QgbGluZUVuZCA9IG5leHROZXdsaW5lID09PSAtMSA/IHRleHQubGVuZ3RoIDogbmV4dE5ld2xpbmU7XG5cdHJldHVybiB7IGxpbmVTdGFydCwgbGluZUVuZCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VsZWN0ZWRCbG9ja0JvdW5kcyh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpIHtcblx0Y29uc3QgYmxvY2tTdGFydCA9IGdldEN1cnJlbnRMaW5lQm91bmRzKHRleHQsIHNlbGVjdGlvbi5zdGFydCkubGluZVN0YXJ0O1xuXHRjb25zdCBibG9ja0VuZCA9IGdldEN1cnJlbnRMaW5lQm91bmRzKHRleHQsIHNlbGVjdGlvbi5lbmQpLmxpbmVFbmQ7XG5cdHJldHVybiB7IGJsb2NrU3RhcnQsIGJsb2NrRW5kIH07XG59XG4iLCAiaW1wb3J0IHsgZ2V0TGlzdE1ldGFkYXRhLCBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMgfSBmcm9tICcuL2xpc3RzJztcbmltcG9ydCB7XG5cdGRlbGV0ZUJhY2t3YXJkLFxuXHRkZWxldGVGb3J3YXJkLFxuXHRnZXRDdXJyZW50TGluZUJvdW5kcyxcblx0Z2V0U2VsZWN0ZWRCbG9ja0JvdW5kcyxcblx0dHlwZSBTZWxlY3Rpb25SYW5nZSxcblx0dHlwZSBUZXh0Q2hhbmdlXG59IGZyb20gJy4vdGV4dCc7XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVRhYktleShcblx0dGV4dDogc3RyaW5nLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlLFxuXHRzaGlmdEtleTogYm9vbGVhblxuKTogVGV4dENoYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gYXBwbHlUYWJUb1NlbGVjdGlvbih0ZXh0LCBzZWxlY3Rpb24sIHNoaWZ0S2V5KTtcblx0fVxuXG5cdHJldHVybiBhcHBseVRhYlRvTGluZSh0ZXh0LCBzZWxlY3Rpb24uc3RhcnQsIHNoaWZ0S2V5KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5RW50ZXJLZXkodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IHsgc3RhcnQsIGVuZCB9ID0gc2VsZWN0aW9uO1xuXHRjb25zdCB7IGxpbmVTdGFydCwgbGluZUVuZCB9ID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgc3RhcnQpO1xuXHRjb25zdCBsaW5lVGV4dCA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcblx0Y29uc3QgbWV0YWRhdGEgPSBnZXRMaXN0TWV0YWRhdGEobGluZVRleHQpO1xuXG5cdGlmIChtZXRhZGF0YS5saXN0TGV2ZWwgPT09IDApIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dDogdGV4dC5zbGljZSgwLCBzdGFydCkgKyAnXFxuJyArIHRleHQuc2xpY2UoZW5kKSxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBzdGFydCArIDEsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IHN0YXJ0ICsgMVxuXHRcdH07XG5cdH1cblxuXHRpZiAobWV0YWRhdGEub3JkZXJlZCAmJiBsaW5lVGV4dC50cmltKCkubWF0Y2goL15cXGQrXFwuJC8pKSB7XG5cdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0dGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgdGV4dC5zbGljZShsaW5lRW5kKSxcblx0XHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBsaW5lU3RhcnQgfSxcblx0XHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBsaW5lU3RhcnQgfVxuXHRcdCk7XG5cdH1cblxuXHRpZiAoIW1ldGFkYXRhLm9yZGVyZWQgJiYgbGluZVRleHQudHJpbSgpID09PSAnLScpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dDogdGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgdGV4dC5zbGljZShsaW5lRW5kKSxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBsaW5lU3RhcnQsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IGxpbmVTdGFydFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBpbmRlbnQgPSAnICAgICcucmVwZWF0KG1ldGFkYXRhLmxpc3RMZXZlbCAtIDEpO1xuXHRjb25zdCBwcmVmaXggPSBtZXRhZGF0YS5vcmRlcmVkID8gYCR7aW5kZW50fSR7bWV0YWRhdGEubGlzdE51bWJlciArIDF9LiBgIDogYCR7aW5kZW50fS0gYDtcblx0Y29uc3QgbmV4dFNlbGVjdGlvbiA9IHN0YXJ0ICsgMSArIHByZWZpeC5sZW5ndGg7XG5cblx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdHRleHQuc2xpY2UoMCwgc3RhcnQpICsgJ1xcbicgKyBwcmVmaXggKyB0ZXh0LnNsaWNlKGVuZCksXG5cdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IG5leHRTZWxlY3Rpb24gfSxcblx0XHR7IHN0YXJ0OiBuZXh0U2VsZWN0aW9uLCBlbmQ6IG5leHRTZWxlY3Rpb24gfVxuXHQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlEZWxldGVCYWNrd2FyZCh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgY2hhbmdlID0gZGVsZXRlQmFja3dhcmQodGV4dCwgc2VsZWN0aW9uKTtcblx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KGNoYW5nZS50ZXh0LCBnZXREZWxldGVBZmZlY3RlZFJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJ2JhY2t3YXJkJyksIHtcblx0XHRzdGFydDogY2hhbmdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdGVuZDogY2hhbmdlLnNlbGVjdGlvbkVuZFxuXHR9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5RGVsZXRlRm9yd2FyZCh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgY2hhbmdlID0gZGVsZXRlRm9yd2FyZCh0ZXh0LCBzZWxlY3Rpb24pO1xuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoY2hhbmdlLnRleHQsIGdldERlbGV0ZUFmZmVjdGVkUmFuZ2UodGV4dCwgc2VsZWN0aW9uLCAnZm9yd2FyZCcpLCB7XG5cdFx0c3RhcnQ6IGNoYW5nZS5zZWxlY3Rpb25TdGFydCxcblx0XHRlbmQ6IGNoYW5nZS5zZWxlY3Rpb25FbmRcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGFwcGx5VGFiVG9TZWxlY3Rpb24oXG5cdHRleHQ6IHN0cmluZyxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSxcblx0c2hpZnRLZXk6IGJvb2xlYW5cbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCB7IGJsb2NrU3RhcnQsIGJsb2NrRW5kIH0gPSBnZXRTZWxlY3RlZEJsb2NrQm91bmRzKHRleHQsIHNlbGVjdGlvbik7XG5cdGNvbnN0IGJsb2NrID0gdGV4dC5zbGljZShibG9ja1N0YXJ0LCBibG9ja0VuZCk7XG5cdGNvbnN0IGxpbmVzID0gYmxvY2suc3BsaXQoJ1xcbicpO1xuXG5cdGNvbnN0IG1vZGlmaWVkID0gbGluZXMubWFwKChsaW5lKSA9PiB7XG5cdFx0Y29uc3QgbWV0YWRhdGEgPSBnZXRMaXN0TWV0YWRhdGEobGluZSk7XG5cdFx0aWYgKHNoaWZ0S2V5KSB7XG5cdFx0XHRpZiAobGluZS5zdGFydHNXaXRoKCcgICAgJykpIHJldHVybiBsaW5lLnNsaWNlKDQpO1xuXHRcdFx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA9PT0gMSkgcmV0dXJuIGxpbmUucmVwbGFjZSgvXi0gLywgJycpLnJlcGxhY2UoL15cXGQrXFwuIC8sICcnKTtcblx0XHRcdHJldHVybiBsaW5lO1xuXHRcdH1cblxuXHRcdHJldHVybiBgICAgICR7bGluZX1gO1xuXHR9KTtcblxuXHRjb25zdCBuZXh0QmxvY2sgPSBtb2RpZmllZC5qb2luKCdcXG4nKTtcblx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdHRleHQuc2xpY2UoMCwgYmxvY2tTdGFydCkgKyBuZXh0QmxvY2sgKyB0ZXh0LnNsaWNlKGJsb2NrRW5kKSxcblx0XHR7IHN0YXJ0OiBibG9ja1N0YXJ0LCBlbmQ6IGJsb2NrU3RhcnQgKyBuZXh0QmxvY2subGVuZ3RoIH0sXG5cdFx0eyBzdGFydDogYmxvY2tTdGFydCwgZW5kOiBibG9ja1N0YXJ0ICsgbmV4dEJsb2NrLmxlbmd0aCB9XG5cdCk7XG59XG5cbmZ1bmN0aW9uIGFwcGx5VGFiVG9MaW5lKHRleHQ6IHN0cmluZywgcG9zaXRpb246IG51bWJlciwgc2hpZnRLZXk6IGJvb2xlYW4pOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgeyBsaW5lU3RhcnQsIGxpbmVFbmQgfSA9IGdldEN1cnJlbnRMaW5lQm91bmRzKHRleHQsIHBvc2l0aW9uKTtcblx0Y29uc3QgbGluZVRleHQgPSB0ZXh0LnNsaWNlKGxpbmVTdGFydCwgbGluZUVuZCk7XG5cdGNvbnN0IG1ldGFkYXRhID0gZ2V0TGlzdE1ldGFkYXRhKGxpbmVUZXh0KTtcblxuXHRpZiAoc2hpZnRLZXkpIHtcblx0XHRpZiAobGluZVRleHQuc3RhcnRzV2l0aCgnICAgICcpKSB7XG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0XHRcdHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIGxpbmVUZXh0LnNsaWNlKDQpICsgdGV4dC5zbGljZShsaW5lRW5kKSxcblx0XHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVFbmQgLSA0IH0sXG5cdFx0XHRcdHsgc3RhcnQ6IHBvc2l0aW9uIC0gNCwgZW5kOiBwb3NpdGlvbiAtIDQgfVxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHRpZiAobWV0YWRhdGEubGlzdExldmVsID09PSAxKSB7XG5cdFx0XHRjb25zdCB1cGRhdGVkTGluZSA9IGxpbmVUZXh0LnJlcGxhY2UoL14tIC8sICcnKS5yZXBsYWNlKC9eXFxkK1xcLiAvLCAnJyk7XG5cdFx0XHRjb25zdCBuZXh0U2VsZWN0aW9uID0gTWF0aC5tYXgobGluZVN0YXJ0LCBwb3NpdGlvbiAtIG1ldGFkYXRhLnByZWZpeC5sZW5ndGgpO1xuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0XHR0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyB1cGRhdGVkTGluZSArIHRleHQuc2xpY2UobGluZUVuZCksXG5cdFx0XHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBsaW5lU3RhcnQgKyB1cGRhdGVkTGluZS5sZW5ndGggfSxcblx0XHRcdFx0eyBzdGFydDogbmV4dFNlbGVjdGlvbiwgZW5kOiBuZXh0U2VsZWN0aW9uIH1cblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogcG9zaXRpb24sXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IHBvc2l0aW9uXG5cdFx0fTtcblx0fVxuXG5cdGlmIChtZXRhZGF0YS5saXN0TGV2ZWwgPiAwKSB7XG5cdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0dGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgJyAgICAnICsgdGV4dC5zbGljZShsaW5lU3RhcnQpLFxuXHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVFbmQgKyA0IH0sXG5cdFx0XHR7IHN0YXJ0OiBwb3NpdGlvbiArIDQsIGVuZDogcG9zaXRpb24gKyA0IH1cblx0XHQpO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHR0ZXh0OiB0ZXh0LnNsaWNlKDAsIHBvc2l0aW9uKSArICcgICAgJyArIHRleHQuc2xpY2UocG9zaXRpb24pLFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBwb3NpdGlvbiArIDQsXG5cdFx0c2VsZWN0aW9uRW5kOiBwb3NpdGlvbiArIDRcblx0fTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTGlzdEVkaXQoXG5cdHRleHQ6IHN0cmluZyxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2Vcbikge1xuXHRyZXR1cm4gbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzKHRleHQsIGFmZmVjdGVkUmFuZ2UsIHNlbGVjdGlvbik7XG59XG5cbmZ1bmN0aW9uIGdldERlbGV0ZUFmZmVjdGVkUmFuZ2UoXG5cdHRleHQ6IHN0cmluZyxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSxcblx0ZGlyZWN0aW9uOiAnYmFja3dhcmQnIHwgJ2ZvcndhcmQnXG4pOiBTZWxlY3Rpb25SYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gc2VsZWN0aW9uO1xuXHR9XG5cblx0aWYgKGRpcmVjdGlvbiA9PT0gJ2JhY2t3YXJkJykge1xuXHRcdGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgoMCwgc2VsZWN0aW9uLnN0YXJ0IC0gMSk7XG5cdFx0cmV0dXJuIHsgc3RhcnQsIGVuZDogc2VsZWN0aW9uLnN0YXJ0IH07XG5cdH1cblxuXHRjb25zdCBlbmQgPSBNYXRoLm1pbih0ZXh0Lmxlbmd0aCwgc2VsZWN0aW9uLmVuZCArIDEpO1xuXHRyZXR1cm4geyBzdGFydDogc2VsZWN0aW9uLnN0YXJ0LCBlbmQgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVB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
