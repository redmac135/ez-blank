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
    const nextText = text.slice(0, lineStart) + text.slice(lineEnd);
    return normalizeListEdit(
      nextText,
      getSplitListAffectedRange(nextText, lineStart),
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
function getSplitListAffectedRange(text, boundary) {
  return {
    start: Math.max(0, boundary - 1),
    end: Math.min(text.length, boundary + 1)
  };
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
test("applyEnterKey on an empty ordered item in the middle resets the lower list to 1", () => {
  const source = "1. one\n2. \n3. three\n4. four";
  const cursor = source.indexOf("2. ");
  const change = applyEnterKey(source, { start: cursor, end: cursor });
  assert.equal(change.text, "1. one\n\n1. three\n2. four");
  assert.equal(change.selectionStart, source.indexOf("2. "));
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY29tbWFuZHMudGVzdC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9wYXJzZXIudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvbGlzdHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvdGV4dC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9jb21tYW5kcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7XG5cdGFwcGx5RGVsZXRlQmFja3dhcmQsXG5cdGFwcGx5RGVsZXRlRm9yd2FyZCxcblx0YXBwbHlFbnRlcktleSxcblx0YXBwbHlUYWJLZXlcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvY29tbWFuZHMudHMnO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgdGhlIHdob2xlIG9yZGVyZWQgc3VibGlzdCB3aGVuIGluZGVudGluZyBhIHN1YnNldCBzZWxlY3Rpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzb3VyY2UubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydCwgZW5kIH0sIGZhbHNlKTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICcxLiBvbmVcXG4gICAgMS4gdHdvXFxuICAgIDIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDcpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnRleHQubGVuZ3RoKTtcbn0pO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgZm9sbG93aW5nIHNpYmxpbmdzIHdoZW4gaW5kZW50aW5nIGEgc2luZ2xlIG9yZGVyZWQgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9LCBmYWxzZSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuICAgIDEuIHR3b1xcbjIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIGN1cnNvciArIDQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY3Vyc29yICsgNCk7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbGlzdCBpdGVtIGFuZCByZW51bWJlcnMgbGF0ZXIgb3JkZXJlZCBzaWJsaW5ncycsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpICsgJzIuIHR3bycubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG9uZVxcbjIuIHR3b1xcbjMuIFxcbjQuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBvbmVcXG4yLiB0d29cXG4zLiAnLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uRW5kLCBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RW50ZXJLZXkgcHJlc2VydmVzIHBsYWluIHBhcmFncmFwaHMgd2l0aG91dCBsaXN0IG5vcm1hbGl6YXRpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICdhbHBoYSBiZXRhJztcblx0Y29uc3QgY3Vyc29yID0gNTtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseUVudGVyS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9KTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICdhbHBoYVxcbiBiZXRhJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDYpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgNik7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbmVzdGVkIG9yZGVyZWQgaXRlbSBhbmQgcmVudW1iZXJzIG9ubHkgdGhhdCBuZXN0ZWQgbGlzdCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBzaWJsaW5nXFxuMi4gb3V0ZXInO1xuXHRjb25zdCBjdXJzb3IgPSBzb3VyY2UuaW5kZXhPZignMS4gY2hpbGQnKSArICcxLiBjaGlsZCcubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBcXG4gICAgMy4gc2libGluZ1xcbjIuIG91dGVyJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBwYXJlbnRcXG4gICAgMS4gY2hpbGRcXG4gICAgMi4gJy5sZW5ndGgpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnNlbGVjdGlvblN0YXJ0KTtcbn0pO1xuXG50ZXN0KCdhcHBseUVudGVyS2V5IG9uIGFuIGVtcHR5IG9yZGVyZWQgaXRlbSBpbiB0aGUgbWlkZGxlIHJlc2V0cyB0aGUgbG93ZXIgbGlzdCB0byAxJywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSAnMS4gb25lXFxuMi4gXFxuMy4gdGhyZWVcXG40LiBmb3VyJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuICcpO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG9uZVxcblxcbjEuIHRocmVlXFxuMi4gZm91cicpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvblN0YXJ0LCBzb3VyY2UuaW5kZXhPZignMi4gJykpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnNlbGVjdGlvblN0YXJ0KTtcbn0pO1xuXG50ZXN0KCdhcHBseURlbGV0ZUJhY2t3YXJkIHJlbnVtYmVycyBvcmRlcmVkIGxpc3Qgc2libGluZ3MgYWZ0ZXIgcmVtb3ZpbmcgYSBtaWRkbGUgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3Qgc3RhcnQgPSBzb3VyY2UuaW5kZXhPZignMi4gdHdvJyk7XG5cdGNvbnN0IGVuZCA9IHN0YXJ0ICsgJzIuIHR3b1xcbicubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RGVsZXRlQmFja3dhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RGVsZXRlRm9yd2FyZCByZW51bWJlcnMgb3JkZXJlZCBsaXN0IHNpYmxpbmdzIGFmdGVyIHJlbW92aW5nIGEgbWlkZGxlIGl0ZW0nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzdGFydCArICcyLiB0d29cXG4nLmxlbmd0aDtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseURlbGV0ZUZvcndhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG4iLCAiaW1wb3J0IHR5cGUge1xuXHRCbG9ja05vZGUsXG5cdENvZGVCbG9jayxcblx0Rm9ybWF0dGVkTm9kZSxcblx0SGVhZGluZ0Jsb2NrLFxuXHRJbmxpbmVOb2RlLFxuXHRMaXN0QmxvY2ssXG5cdExpc3RJdGVtQmxvY2ssXG5cdFBhcmFncmFwaEJsb2NrLFxuXHRTb3VyY2VSYW5nZSxcblx0VGV4dE5vZGVcbn0gZnJvbSAnLi9hc3QnO1xuXG5leHBvcnQgdHlwZSBMaW5lS2luZCA9XG5cdHwgJ3BhcmFncmFwaCdcblx0fCAnaGVhZGluZydcblx0fCAndW5vcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnb3JkZXJlZF9saXN0X2l0ZW0nXG5cdHwgJ2NvZGVfZmVuY2UnXG5cdHwgJ2NvZGVfY29udGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yTGluZSB7XG5cdGlkOiBzdHJpbmc7XG5cdGluZGV4OiBudW1iZXI7XG5cdHJhdzogc3RyaW5nO1xuXHRyYW5nZTogU291cmNlUmFuZ2U7XG5cdGtpbmQ6IExpbmVLaW5kO1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRoZWFkaW5nTGV2ZWw6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG5cdHByZWZpeFJhbmdlOiBTb3VyY2VSYW5nZSB8IG51bGw7XG5cdGNvbnRlbnRSYW5nZTogU291cmNlUmFuZ2U7XG5cdGlubGluZTogSW5saW5lTm9kZVtdO1xuXHRjb2RlQmxvY2tMYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JEb2N1bWVudCB7XG5cdHRleHQ6IHN0cmluZztcblx0YmxvY2tzOiBCbG9ja05vZGVbXTtcblx0bGluZXM6IEVkaXRvckxpbmVbXTtcbn1cblxuaW50ZXJmYWNlIFJhd0xpbmUge1xuXHRpbmRleDogbnVtYmVyO1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTGluZVByZWZpeEluZm8ge1xuXHRraW5kOiAncGFyYWdyYXBoJyB8ICdoZWFkaW5nJyB8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyB8ICdvcmRlcmVkX2xpc3RfaXRlbScgfCAnY29kZV9mZW5jZSc7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0bGFuZ3VhZ2U6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERvY3VtZW50KHJhd1RleHQ6IHN0cmluZyk6IEVkaXRvckRvY3VtZW50IHtcblx0Y29uc3QgdGV4dCA9IG5vcm1hbGl6ZVRleHQocmF3VGV4dCk7XG5cdGNvbnN0IHJhd0xpbmVzID0gYnVpbGRSYXdMaW5lcyh0ZXh0KTtcblx0Y29uc3QgYmxvY2tzID0gcGFyc2VCbG9ja3MocmF3TGluZXMpO1xuXHRjb25zdCBsaW5lcyA9IGRlcml2ZUxpbmVzKGJsb2Nrcyk7XG5cdHJldHVybiB7IHRleHQsIGJsb2NrcywgbGluZXMgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQocmF3VGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHJhd1RleHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJFZGl0b3JMaW5lKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRjb25zdCBwcmVmaXggPSBsaW5lLnByZWZpeFJhbmdlID8gcmVuZGVyRWRpdG9yVGV4dChsaW5lLnByZWZpeCkgOiAnJztcblx0Y29uc3QgY29udGVudCA9IGxpbmUua2luZC5zdGFydHNXaXRoKCdjb2RlXycpXG5cdFx0PyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucmF3LnNsaWNlKGxpbmUucHJlZml4Lmxlbmd0aCkpXG5cdFx0OiByZW5kZXJFZGl0b3JJbmxpbmUobGluZS5pbmxpbmUpO1xuXHRjb25zdCBib2R5ID0gcHJlZml4ICsgKGNvbnRlbnQgfHwgKGxpbmUucmF3Lmxlbmd0aCA9PT0gMCA/ICc8YnI+JyA6ICcnKSk7XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBsaW5lLmtpbmQgPT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykge1xuXHRcdGNvbnN0IHByZWZpeFdpZHRoID0gbGluZS5wcmVmaXgudHJpbVN0YXJ0KCkubGVuZ3RoO1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogJHtsaW5lLmxpc3RMZXZlbCAtIDF9OyAtLXByZWZpeC13aWR0aDogJHtwcmVmaXhXaWR0aH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdjb2RlX2ZlbmNlJyB8fCBsaW5lLmtpbmQgPT09ICdjb2RlX2NvbnRlbnQnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBjb2RlICR7bGluZS5raW5kfVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50OiBFZGl0b3JEb2N1bWVudCwgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBzdHJpbmcge1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHMgPSBkb2N1bWVudC5ibG9ja3Ncblx0XHQubWFwKChibG9jaykgPT4gcmVuZGVyQmxvY2tTZWxlY3Rpb24oZG9jdW1lbnQudGV4dCwgYmxvY2ssIHN0YXJ0LCBlbmQpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbik7XG5cblx0cmV0dXJuIGA8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPiR7cGFydHMuam9pbignJyl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMaW5lSW5kZXgobGluZXM6IEVkaXRvckxpbmVbXSwgb2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgbGluZXMubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBuZXh0U3RhcnQgPSBpbmRleCArIDEgPCBsaW5lcy5sZW5ndGggPyBsaW5lc1tpbmRleCArIDFdLnJhbmdlLnN0YXJ0IDogbGluZS5yYW5nZS5lbmQgKyAxO1xuXHRcdGlmIChvZmZzZXQgPCBuZXh0U3RhcnQpIHJldHVybiBpbmRleDtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5sZW5ndGggLSAxO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGluZVJlbmRlclNpZ25hdHVyZShsaW5lOiBFZGl0b3JMaW5lKTogc3RyaW5nIHtcblx0cmV0dXJuIFtcblx0XHRsaW5lLmtpbmQsXG5cdFx0bGluZS5yYXcsXG5cdFx0bGluZS5wcmVmaXgsXG5cdFx0bGluZS5saXN0TGV2ZWwsXG5cdFx0bGluZS5saXN0TnVtYmVyLFxuXHRcdGxpbmUuaGVhZGluZ0xldmVsLFxuXHRcdGxpbmUuY29kZUJsb2NrTGFuZ3VhZ2UgPz8gJydcblx0XS5qb2luKCdcXHUwMDAxJyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUmF3TGluZXModGV4dDogc3RyaW5nKTogUmF3TGluZVtdIHtcblx0Y29uc3Qgc3BsaXQgPSB0ZXh0LnNwbGl0KCdcXG4nKTtcblx0Y29uc3QgbGluZXM6IFJhd0xpbmVbXSA9IFtdO1xuXHRsZXQgb2Zmc2V0ID0gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3BsaXQubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IHNwbGl0W2luZGV4XTtcblx0XHRsaW5lcy5wdXNoKHtcblx0XHRcdGluZGV4LFxuXHRcdFx0dGV4dDogbGluZSxcblx0XHRcdHN0YXJ0OiBvZmZzZXQsXG5cdFx0XHRlbmQ6IG9mZnNldCArIGxpbmUubGVuZ3RoXG5cdFx0fSk7XG5cdFx0b2Zmc2V0ICs9IGxpbmUubGVuZ3RoICsgMTtcblx0fVxuXG5cdHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gcGFyc2VCbG9ja3MobGluZXM6IFJhd0xpbmVbXSk6IEJsb2NrTm9kZVtdIHtcblx0cmV0dXJuIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgMCwgMCkuYmxvY2tzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsaXN0TGV2ZWw6IG51bWJlcikge1xuXHRjb25zdCBibG9ja3M6IEJsb2NrTm9kZVtdID0gW107XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXG5cdFx0aWYgKGxpc3RMZXZlbCA+IDApIHtcblx0XHRcdGlmIChsaW5lLnRleHQudHJpbSgpID09PSAnJykgYnJlYWs7XG5cdFx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKFxuXHRcdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdFx0cHJlZml4Lmxpc3RMZXZlbCA8IGxpc3RMZXZlbFxuXHRcdFx0KSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBwcmVmaXgua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUxpc3QobGluZXMsIGluZGV4LCBwcmVmaXgubGlzdExldmVsLCBwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnaGVhZGluZycpIHtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlSGVhZGluZyhsaW5lLCBwcmVmaXgpKTtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRibG9ja3MucHVzaChwYXJzZVBhcmFncmFwaChsaW5lKSk7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7IGJsb2NrcywgbmV4dEluZGV4OiBpbmRleCB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUxpc3QobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCBvcmRlcmVkOiBib29sZWFuKSB7XG5cdGNvbnN0IGl0ZW1zOiBMaXN0SXRlbUJsb2NrW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKFxuXHRcdFx0KHByZWZpeC5raW5kICE9PSAnb3JkZXJlZF9saXN0X2l0ZW0nICYmIHByZWZpeC5raW5kICE9PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHx8XG5cdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGV2ZWwgfHxcblx0XHRcdChwcmVmaXgubGlzdExldmVsID09PSBsZXZlbCAmJiAocHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScpICE9PSBvcmRlcmVkKVxuXHRcdCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5saXN0TGV2ZWwgPiBsZXZlbCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaXRlbVN0YXJ0ID0gbGluZS5zdGFydDtcblx0XHRjb25zdCBpdGVtUHJlZml4TGVuZ3RoID0gcHJlZml4LnByZWZpeC5sZW5ndGg7XG5cdFx0Y29uc3QgaXRlbTogTGlzdEl0ZW1CbG9jayA9IHtcblx0XHRcdHR5cGU6ICdsaXN0X2l0ZW0nLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0bGluZVJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsZXZlbCxcblx0XHRcdG9yZGVyZWQsXG5cdFx0XHRudW1iZXI6IHByZWZpeC5saXN0TnVtYmVyLFxuXHRcdFx0cHJlZml4OiBwcmVmaXgucHJlZml4LFxuXHRcdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShpdGVtUHJlZml4TGVuZ3RoKSwgbGluZS5zdGFydCArIGl0ZW1QcmVmaXhMZW5ndGgpLFxuXHRcdFx0Y2hpbGRyZW46IFtdXG5cdFx0fTtcblxuXHRcdGluZGV4ICs9IDE7XG5cdFx0Y29uc3QgY2hpbGRQYXJzZWQgPSBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXMsIGluZGV4LCBsZXZlbCArIDEpO1xuXHRcdGl0ZW0uY2hpbGRyZW4gPSBjaGlsZFBhcnNlZC5ibG9ja3M7XG5cdFx0Y29uc3QgY2hpbGRFbmQgPVxuXHRcdFx0aXRlbS5jaGlsZHJlbi5sZW5ndGggPiAwID8gaXRlbS5jaGlsZHJlbltpdGVtLmNoaWxkcmVuLmxlbmd0aCAtIDFdLnJhbmdlLmVuZCA6IGl0ZW0ucmFuZ2UuZW5kO1xuXHRcdGl0ZW0ucmFuZ2UgPSB7IHN0YXJ0OiBpdGVtU3RhcnQsIGVuZDogY2hpbGRFbmQgfTtcblx0XHRpdGVtcy5wdXNoKGl0ZW0pO1xuXHRcdGluZGV4ID0gY2hpbGRQYXJzZWQubmV4dEluZGV4O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRibG9jazoge1xuXHRcdFx0dHlwZTogJ2xpc3QnLFxuXHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0c3RhcnQ6IGl0ZW1zWzBdPy5yYW5nZS5zdGFydCA/PyBsaW5lc1tzdGFydEluZGV4XS5zdGFydCxcblx0XHRcdFx0ZW5kOiBpdGVtc1tpdGVtcy5sZW5ndGggLSAxXT8ucmFuZ2UuZW5kID8/IGxpbmVzW3N0YXJ0SW5kZXhdLmVuZFxuXHRcdFx0fSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdGl0ZW1zXG5cdFx0fSBzYXRpc2ZpZXMgTGlzdEJsb2NrLFxuXHRcdG5leHRJbmRleDogaW5kZXhcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb2RlQmxvY2sobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyKSB7XG5cdGNvbnN0IG9wZW5MaW5lID0gbGluZXNbc3RhcnRJbmRleF07XG5cdGNvbnN0IG9wZW5QcmVmaXggPSBwYXJzZVByZWZpeChvcGVuTGluZS50ZXh0KTtcblx0Y29uc3QgY29udGVudExpbmVzOiBDb2RlQmxvY2tbJ2xpbmVzJ10gPSBbXTtcblx0bGV0IGNsb3NlRmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRsZXQgZW5kID0gb3BlbkxpbmUuZW5kO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4ICsgMTtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNsb3NlRmVuY2UgPSBwcmVmaXgucHJlZml4O1xuXHRcdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29udGVudExpbmVzLnB1c2goe1xuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdHRleHQ6IGxpbmUudGV4dFxuXHRcdH0pO1xuXHRcdGVuZCA9IGxpbmUuZW5kO1xuXHRcdGluZGV4ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnY29kZV9ibG9jaycsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogb3BlbkxpbmUuc3RhcnQsIGVuZCB9LFxuXHRcdFx0bGFuZ3VhZ2U6IG9wZW5QcmVmaXgubGFuZ3VhZ2UsXG5cdFx0XHRvcGVuRmVuY2U6IG9wZW5QcmVmaXgucHJlZml4LFxuXHRcdFx0Y2xvc2VGZW5jZSxcblx0XHRcdGxpbmVzOiBjb250ZW50TGluZXNcblx0XHR9IHNhdGlzZmllcyBDb2RlQmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUhlYWRpbmcobGluZTogUmF3TGluZSwgcHJlZml4OiBMaW5lUHJlZml4SW5mbyk6IEhlYWRpbmdCbG9jayB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IGxpbmUuc3RhcnQgKyBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAnaGVhZGluZycsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRsZXZlbDogcHJlZml4LmhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQuc2xpY2UocHJlZml4LnByZWZpeC5sZW5ndGgpLCBjb250ZW50U3RhcnQpXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFyYWdyYXBoKGxpbmU6IFJhd0xpbmUpOiBQYXJhZ3JhcGhCbG9jayB7XG5cdHJldHVybiB7XG5cdFx0dHlwZTogJ3BhcmFncmFwaCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dCwgbGluZS5zdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gZGVyaXZlTGluZXMoYmxvY2tzOiBCbG9ja05vZGVbXSk6IEVkaXRvckxpbmVbXSB7XG5cdGNvbnN0IGxpbmVzOiBFZGl0b3JMaW5lW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGFwcGVuZEJsb2NrTGluZXMoYmxvY2ssIGxpbmVzKTtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5tYXAoKGxpbmUsIGluZGV4KSA9PiAoe1xuXHRcdC4uLmxpbmUsXG5cdFx0aWQ6IGBsaW5lLSR7aW5kZXh9YCxcblx0XHRpbmRleFxuXHR9KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZEJsb2NrTGluZXMoYmxvY2s6IEJsb2NrTm9kZSwgbGluZXM6IEVkaXRvckxpbmVbXSkge1xuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRsaW5lcy5wdXNoKGNyZWF0ZUJhc2VMaW5lKGJsb2NrLnJhdywgYmxvY2sucmFuZ2UsICdwYXJhZ3JhcGgnLCAnJywgbnVsbCwgYmxvY2suaW5saW5lKSk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sucmF3LFxuXHRcdFx0XHRibG9jay5yYW5nZSxcblx0XHRcdFx0J2hlYWRpbmcnLFxuXHRcdFx0XHRibG9jay5wcmVmaXgsXG5cdFx0XHRcdG51bGwsXG5cdFx0XHRcdGJsb2NrLmlubGluZSxcblx0XHRcdFx0MCxcblx0XHRcdFx0MCxcblx0XHRcdFx0YmxvY2subGV2ZWxcblx0XHRcdClcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnY29kZV9ibG9jaycpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSArIChibG9jay5sYW5ndWFnZSA/IGJsb2NrLmxhbmd1YWdlIDogJycpLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c3RhcnQ6IGJsb2NrLnJhbmdlLnN0YXJ0LFxuXHRcdFx0XHRcdGVuZDogYmxvY2sucmFuZ2Uuc3RhcnQgKyBibG9jay5vcGVuRmVuY2UubGVuZ3RoICsgKGJsb2NrLmxhbmd1YWdlPy5sZW5ndGggPz8gMClcblx0XHRcdFx0fSxcblx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRibG9jay5vcGVuRmVuY2UsXG5cdFx0XHRcdGJsb2NrLmxhbmd1YWdlLFxuXHRcdFx0XHRbXVxuXHRcdFx0KVxuXHRcdCk7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUobGluZS50ZXh0LCBsaW5lLnJhbmdlLCAnY29kZV9jb250ZW50JywgJycsIGJsb2NrLmxhbmd1YWdlLCBbXSkpO1xuXHRcdH1cblxuXHRcdGlmIChibG9jay5jbG9zZUZlbmNlKSB7XG5cdFx0XHRjb25zdCBjbG9zZVN0YXJ0ID0gYmxvY2sucmFuZ2UuZW5kIC0gYmxvY2suY2xvc2VGZW5jZS5sZW5ndGg7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRibG9jay5jbG9zZUZlbmNlLFxuXHRcdFx0XHRcdHsgc3RhcnQ6IGNsb3NlU3RhcnQsIGVuZDogYmxvY2sucmFuZ2UuZW5kIH0sXG5cdFx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFx0W11cblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHR9XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdFx0aXRlbS5yYXcsXG5cdFx0XHRcdFx0aXRlbS5saW5lUmFuZ2UsXG5cdFx0XHRcdFx0aXRlbS5vcmRlcmVkID8gJ29yZGVyZWRfbGlzdF9pdGVtJyA6ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdFx0XHRpdGVtLnByZWZpeCxcblx0XHRcdFx0XHRudWxsLFxuXHRcdFx0XHRcdGl0ZW0uaW5saW5lLFxuXHRcdFx0XHRcdGl0ZW0ubGV2ZWwsXG5cdFx0XHRcdFx0aXRlbS5udW1iZXJcblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHRcdGZvciAoY29uc3QgY2hpbGQgb2YgaXRlbS5jaGlsZHJlbikge1xuXHRcdFx0XHRhcHBlbmRCbG9ja0xpbmVzKGNoaWxkLCBsaW5lcyk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhc2VMaW5lKFxuXHRyYXc6IHN0cmluZyxcblx0cmFuZ2U6IFNvdXJjZVJhbmdlLFxuXHRraW5kOiBMaW5lS2luZCxcblx0cHJlZml4OiBzdHJpbmcsXG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0bGlzdExldmVsID0gMCxcblx0bGlzdE51bWJlciA9IDAsXG5cdGhlYWRpbmdMZXZlbCA9IDBcbik6IEVkaXRvckxpbmUge1xuXHRjb25zdCBjb250ZW50U3RhcnQgPSByYW5nZS5zdGFydCArIHByZWZpeC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0aWQ6ICcnLFxuXHRcdGluZGV4OiAwLFxuXHRcdHJhdyxcblx0XHRyYW5nZSxcblx0XHRraW5kLFxuXHRcdGxpc3RMZXZlbCxcblx0XHRsaXN0TnVtYmVyLFxuXHRcdGhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXgsXG5cdFx0cHJlZml4UmFuZ2U6IHByZWZpeC5sZW5ndGggPiAwID8geyBzdGFydDogcmFuZ2Uuc3RhcnQsIGVuZDogY29udGVudFN0YXJ0IH0gOiBudWxsLFxuXHRcdGNvbnRlbnRSYW5nZTogeyBzdGFydDogY29udGVudFN0YXJ0LCBlbmQ6IHJhbmdlLmVuZCB9LFxuXHRcdGlubGluZSxcblx0XHRjb2RlQmxvY2tMYW5ndWFnZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVByZWZpeChyYXc6IHN0cmluZyk6IExpbmVQcmVmaXhJbmZvIHtcblx0Y29uc3QgY29kZUZlbmNlTWF0Y2ggPSByYXcubWF0Y2goL15gYGAoW0EtWmEtejAtOV8tXSspP1xccyokLyk7XG5cdGlmIChjb2RlRmVuY2VNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnY29kZV9mZW5jZScsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiAnYGBgJyxcblx0XHRcdGxhbmd1YWdlOiBjb2RlRmVuY2VNYXRjaFsxXSA/PyBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IHVub3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKiktIC8pO1xuXHRpZiAodW5vcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiB1bm9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3Qgb3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ29yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdGxpc3RMZXZlbDogb3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBoZWFkaW5nTWF0Y2ggPSByYXcubWF0Y2goL14oI3sxLDZ9KVxccysvKTtcblx0aWYgKGhlYWRpbmdNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnaGVhZGluZycsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiBoZWFkaW5nTWF0Y2hbMV0ubGVuZ3RoLFxuXHRcdFx0cHJlZml4OiBoZWFkaW5nTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGtpbmQ6ICdwYXJhZ3JhcGgnLFxuXHRcdGxpc3RMZXZlbDogMCxcblx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRwcmVmaXg6ICcnLFxuXHRcdGxhbmd1YWdlOiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSW5saW5lKHJhdzogc3RyaW5nLCBzdGFydE9mZnNldDogbnVtYmVyKTogSW5saW5lTm9kZVtdIHtcblx0Y29uc3QgaW5saW5lOiBJbmxpbmVOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gMDtcblxuXHR3aGlsZSAoaW5kZXggPCByYXcubGVuZ3RoKSB7XG5cdFx0Y29uc3QgZm9ybWF0dGVkTm9kZSA9IHBhcnNlRm9ybWF0dGVkTm9kZShyYXcsIHN0YXJ0T2Zmc2V0LCBpbmRleCk7XG5cdFx0aWYgKGZvcm1hdHRlZE5vZGUpIHtcblx0XHRcdGlubGluZS5wdXNoKGZvcm1hdHRlZE5vZGUubm9kZSk7XG5cdFx0XHRpbmRleCA9IGZvcm1hdHRlZE5vZGUubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0bGV0IG5leHRNYXJrZXIgPSByYXcubGVuZ3RoO1xuXHRcdGNvbnN0IHN0YXJJbmRleCA9IHJhdy5pbmRleE9mKCcqJywgaW5kZXgpO1xuXHRcdGlmIChzdGFySW5kZXggIT09IC0xKSBuZXh0TWFya2VyID0gc3RhckluZGV4O1xuXG5cdFx0aWYgKG5leHRNYXJrZXIgPT09IGluZGV4KSB7XG5cdFx0XHRpbmxpbmUucHVzaCh7XG5cdFx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBpbmRleCArIDEgfSxcblx0XHRcdFx0dGV4dDogcmF3W2luZGV4XVxuXHRcdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHQgPSByYXcuc2xpY2UoaW5kZXgsIG5leHRNYXJrZXIpO1xuXHRcdGlubGluZS5wdXNoKHtcblx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LCBlbmQ6IHN0YXJ0T2Zmc2V0ICsgbmV4dE1hcmtlciB9LFxuXHRcdFx0dGV4dFxuXHRcdH0gc2F0aXNmaWVzIFRleHROb2RlKTtcblx0XHRpbmRleCA9IG5leHRNYXJrZXI7XG5cdH1cblxuXHRyZXR1cm4gaW5saW5lO1xufVxuXG5mdW5jdGlvbiBwYXJzZUZvcm1hdHRlZE5vZGUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIsIGluZGV4OiBudW1iZXIpIHtcblx0Zm9yIChjb25zdCBtYXJrZXIgb2YgWycqKionLCAnKionLCAnKiddIGFzIGNvbnN0KSB7XG5cdFx0aWYgKCFyYXcuc3RhcnRzV2l0aChtYXJrZXIsIGluZGV4KSkgY29udGludWU7XG5cblx0XHRjb25zdCBjbG9zZSA9IHJhdy5pbmRleE9mKG1hcmtlciwgaW5kZXggKyBtYXJrZXIubGVuZ3RoKTtcblx0XHRpZiAoY2xvc2UgPT09IC0xKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNvbnRlbnRTdGFydCA9IGluZGV4ICsgbWFya2VyLmxlbmd0aDtcblx0XHRjb25zdCBjb250ZW50RW5kID0gY2xvc2U7XG5cdFx0aWYgKGNvbnRlbnRTdGFydCA+PSBjb250ZW50RW5kKSBjb250aW51ZTtcblx0XHRpZiAocmF3W2NvbnRlbnRTdGFydF0gPT09ICcgJyB8fCByYXdbY29udGVudEVuZCAtIDFdID09PSAnICcpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgdHlwZSA9IG1hcmtlciA9PT0gJyoqKicgPyAnc3Ryb25nX2VtcGhhc2lzJyA6IG1hcmtlciA9PT0gJyoqJyA/ICdzdHJvbmcnIDogJ2VtcGhhc2lzJztcblxuXHRcdHJldHVybiB7XG5cdFx0XHRub2RlOiB7XG5cdFx0XHRcdHR5cGUsXG5cdFx0XHRcdHJhbmdlOiB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNsb3NlICsgbWFya2VyLmxlbmd0aFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRjb250ZW50UmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBjb250ZW50U3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBzdGFydE9mZnNldCArIGNvbnRlbnRFbmRcblx0XHRcdFx0fSxcblx0XHRcdFx0bWFya2VyLFxuXHRcdFx0XHR0ZXh0OiByYXcuc2xpY2UoY29udGVudFN0YXJ0LCBjb250ZW50RW5kKVxuXHRcdFx0fSBzYXRpc2ZpZXMgRm9ybWF0dGVkTm9kZSxcblx0XHRcdG5leHRJbmRleDogY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JJbmxpbmUoaW5saW5lOiBJbmxpbmVOb2RlW10pOiBzdHJpbmcge1xuXHRyZXR1cm4gaW5saW5lXG5cdFx0Lm1hcCgobm9kZSkgPT4ge1xuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRcdHJldHVybiByZW5kZXJFZGl0b3JUZXh0KG5vZGUudGV4dCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG1hcmtlciA9IGA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4ke2VzY2FwZUh0bWwobm9kZS5tYXJrZXIpfTwvc3Bhbj5gO1xuXHRcdFx0Y29uc3QgY29udGVudCA9IGVzY2FwZUh0bWwobm9kZS50ZXh0KTtcblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2VtcGhhc2lzJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxlbT4ke2NvbnRlbnR9PC9lbT4ke21hcmtlcn1gO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxzdHJvbmc+JHtjb250ZW50fTwvc3Ryb25nPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz48ZW0+JHtjb250ZW50fTwvZW0+PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHR9KVxuXHRcdC5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQmxvY2tTZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0YmxvY2s6IEJsb2NrTm9kZSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gYmxvY2sucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gYmxvY2sucmFuZ2UuZW5kKSByZXR1cm4gJyc7XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdwYXJhZ3JhcGgnKSB7XG5cdFx0cmV0dXJuIGA8cD4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvcD5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGNvbnN0IHRhZyA9IGBoJHtibG9jay5sZXZlbH1gO1xuXHRcdHJldHVybiBgPCR7dGFnfT4ke3JlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGJsb2NrLmlubGluZSwgc3RhcnQsIGVuZCkgfHwgJzxicj4nfTwvJHt0YWd9PmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2NvZGVfYmxvY2snKSB7XG5cdFx0Y29uc3QgY29kZVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0aWYgKGVuZCA8PSBsaW5lLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGxpbmUucmFuZ2UuZW5kKSBjb250aW51ZTtcblx0XHRcdGNvZGVQYXJ0cy5wdXNoKGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQoc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBsaW5lLnJhbmdlLCBzdGFydCwgZW5kKSkpO1xuXHRcdH1cblx0XHRyZXR1cm4gYDxwcmU+PGNvZGU+JHtjb2RlUGFydHMuam9pbignXFxuJyl9PC9jb2RlPjwvcHJlPmA7XG5cdH1cblxuXHRjb25zdCB0YWcgPSBibG9jay5vcmRlcmVkID8gJ29sJyA6ICd1bCc7XG5cdGNvbnN0IGl0ZW1zID0gYmxvY2suaXRlbXNcblx0XHQubWFwKChpdGVtKSA9PiByZW5kZXJMaXN0SXRlbVNlbGVjdGlvbihzb3VyY2VUZXh0LCBpdGVtLCBzdGFydCwgZW5kKSlcblx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0LmpvaW4oJycpO1xuXHRyZXR1cm4gaXRlbXMgPyBgPCR7dGFnfT4ke2l0ZW1zfTwvJHt0YWd9PmAgOiAnJztcbn1cblxuZnVuY3Rpb24gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0aXRlbTogTGlzdEl0ZW1CbG9jayxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChlbmQgPD0gaXRlbS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBpdGVtLnJhbmdlLmVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBpdGVtSW5saW5lID0gcmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbS5pbmxpbmUsIHN0YXJ0LCBlbmQpO1xuXHRwYXJ0cy5wdXNoKGl0ZW1JbmxpbmUgfHwgJzxicj4nKTtcblxuXHRmb3IgKGNvbnN0IGNoaWxkIG9mIGl0ZW0uY2hpbGRyZW4pIHtcblx0XHRjb25zdCBjaGlsZEh0bWwgPSByZW5kZXJCbG9ja1NlbGVjdGlvbihzb3VyY2VUZXh0LCBjaGlsZCwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKGNoaWxkSHRtbCkgcGFydHMucHVzaChjaGlsZEh0bWwpO1xuXHR9XG5cblx0cmV0dXJuIGA8bGk+JHtwYXJ0cy5qb2luKCcnKX08L2xpPmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3Qgbm9kZSBvZiBpbmxpbmUpIHtcblx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdGNvbnN0IHNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLnJhbmdlLCBzdGFydCwgZW5kKTtcblx0XHRcdGlmIChzbGljZSkgcGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlKSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBpbm5lclNsaWNlID0gc2xpY2VSYW5nZShzb3VyY2VUZXh0LCBub2RlLmNvbnRlbnRSYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0aWYgKCFpbm5lclNsaWNlKSBjb250aW51ZTtcblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdlbXBoYXNpcycpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L3N0cm9uZz5gKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHBhcnRzLnB1c2goYDxzdHJvbmc+PGVtPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2VtPjwvc3Ryb25nPmApO1xuXHR9XG5cblx0cmV0dXJuIHBhcnRzLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBzbGljZVJhbmdlKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdHJhbmdlOiBTb3VyY2VSYW5nZSxcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcixcblx0c2VsZWN0aW9uRW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgocmFuZ2Uuc3RhcnQsIHNlbGVjdGlvblN0YXJ0KTtcblx0Y29uc3QgZW5kID0gTWF0aC5taW4ocmFuZ2UuZW5kLCBzZWxlY3Rpb25FbmQpO1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cdHJldHVybiBzb3VyY2VUZXh0LnNsaWNlKHN0YXJ0LCBlbmQpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFZGl0b3JUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0Lmxlbmd0aCA9PT0gMCA/ICcnIDogZXNjYXBlSHRtbCh0ZXh0KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7Jyk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGVzY2FwZUh0bWwodGV4dCkucmVwbGFjZSgvIC9nLCAnJm5ic3A7JykucmVwbGFjZSgvXFx0L2csICcmbmJzcDsmbmJzcDsmbmJzcDsmbmJzcDsnKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IEJsb2NrTm9kZSwgTGlzdEJsb2NrIH0gZnJvbSAnLi9hc3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCB9IGZyb20gJy4vcGFyc2VyJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0aW9uUmFuZ2UsIFRleHRDaGFuZ2UgfSBmcm9tICcuL3RleHQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIExpc3RNZXRhZGF0YSB7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRvcmRlcmVkOiBib29sZWFuO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVGV4dFJlcGxhY2VtZW50IHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpc3RNZXRhZGF0YShsaW5lVGV4dDogc3RyaW5nKTogTGlzdE1ldGFkYXRhIHtcblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXigoPzogezR9KSopLSAvKTtcblx0aWYgKHVub3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGxpc3RMZXZlbDogdW5vcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiBmYWxzZSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IG9yZGVyZWRNYXRjaCA9IGxpbmVUZXh0Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiB0cnVlLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF1cblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0b3JkZXJlZDogZmFsc2UsXG5cdFx0bGlzdE51bWJlcjogMCxcblx0XHRwcmVmaXg6ICcnXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdHRleHQ6IHN0cmluZyxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2Vcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQodGV4dCk7XG5cdGNvbnN0IHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W10gPSBbXTtcblxuXHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoZG9jdW1lbnQuYmxvY2tzLCBhZmZlY3RlZFJhbmdlLCByZXBsYWNlbWVudHMpO1xuXG5cdGlmIChyZXBsYWNlbWVudHMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogc2VsZWN0aW9uLnN0YXJ0LFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fTtcblx0fVxuXG5cdHJlcGxhY2VtZW50cy5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuc3RhcnQgLSBsZWZ0LnN0YXJ0KTtcblxuXHRsZXQgbmV4dFRleHQgPSB0ZXh0O1xuXHRsZXQgc2VsZWN0aW9uU3RhcnQgPSBzZWxlY3Rpb24uc3RhcnQ7XG5cdGxldCBzZWxlY3Rpb25FbmQgPSBzZWxlY3Rpb24uZW5kO1xuXG5cdGZvciAoY29uc3QgcmVwbGFjZW1lbnQgb2YgcmVwbGFjZW1lbnRzKSB7XG5cdFx0Y29uc3QgcmVwbGFjZWRMZW5ndGggPSByZXBsYWNlbWVudC5lbmQgLSByZXBsYWNlbWVudC5zdGFydDtcblx0XHRjb25zdCBkZWx0YSA9IHJlcGxhY2VtZW50LnRleHQubGVuZ3RoIC0gcmVwbGFjZWRMZW5ndGg7XG5cdFx0bmV4dFRleHQgPVxuXHRcdFx0bmV4dFRleHQuc2xpY2UoMCwgcmVwbGFjZW1lbnQuc3RhcnQpICsgcmVwbGFjZW1lbnQudGV4dCArIG5leHRUZXh0LnNsaWNlKHJlcGxhY2VtZW50LmVuZCk7XG5cdFx0c2VsZWN0aW9uU3RhcnQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuc3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5lbmQsXG5cdFx0XHRyZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCxcblx0XHRcdGRlbHRhXG5cdFx0KTtcblx0XHRzZWxlY3Rpb25FbmQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvbkVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuZW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQudGV4dC5sZW5ndGgsXG5cdFx0XHRkZWx0YVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrczogQmxvY2tOb2RlW10sXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pIHtcblx0Zm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gJ2xpc3QnKSB7XG5cdFx0XHRjb2xsZWN0TGlzdFJlcGxhY2VtZW50cyhibG9jaywgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0XHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoaXRlbS5jaGlsZHJlbiwgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrOiBMaXN0QmxvY2ssXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pIHtcblx0aWYgKCFibG9jay5vcmRlcmVkIHx8ICFyYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGJsb2NrLml0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IGl0ZW0gPSBibG9jay5pdGVtc1tpbmRleF0hO1xuXHRcdGNvbnN0IGV4cGVjdGVkTnVtYmVyID0gaW5kZXggKyAxO1xuXHRcdGlmIChpdGVtLm51bWJlciA9PT0gZXhwZWN0ZWROdW1iZXIpIGNvbnRpbnVlO1xuXG5cdFx0cmVwbGFjZW1lbnRzLnB1c2goe1xuXHRcdFx0c3RhcnQ6IGl0ZW0ubGluZVJhbmdlLnN0YXJ0LFxuXHRcdFx0ZW5kOiBpdGVtLmxpbmVSYW5nZS5zdGFydCArIGl0ZW0ucHJlZml4Lmxlbmd0aCxcblx0XHRcdHRleHQ6IGAkeycgICAgJy5yZXBlYXQoaXRlbS5sZXZlbCAtIDEpfSR7ZXhwZWN0ZWROdW1iZXJ9LiBgXG5cdFx0fSk7XG5cdH1cbn1cblxuZnVuY3Rpb24gcmFuZ2VzSW50ZXJzZWN0KGxlZnQ6IFNlbGVjdGlvblJhbmdlLCByaWdodDogU2VsZWN0aW9uUmFuZ2UpIHtcblx0cmV0dXJuIGxlZnQuc3RhcnQgPD0gcmlnaHQuZW5kICYmIHJpZ2h0LnN0YXJ0IDw9IGxlZnQuZW5kO1xufVxuXG5mdW5jdGlvbiBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0cG9pbnQ6IG51bWJlcixcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXIsXG5cdHJlcGxhY2VtZW50TGVuZ3RoOiBudW1iZXIsXG5cdGRlbHRhOiBudW1iZXJcbikge1xuXHRpZiAocG9pbnQgPiBlbmQpIHtcblx0XHRyZXR1cm4gcG9pbnQgKyBkZWx0YTtcblx0fVxuXG5cdGlmIChwb2ludCA+PSBzdGFydCkge1xuXHRcdHJldHVybiBzdGFydCArIE1hdGgubWluKHBvaW50IC0gc3RhcnQsIHJlcGxhY2VtZW50TGVuZ3RoKTtcblx0fVxuXG5cdHJldHVybiBwb2ludDtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFNlbGVjdGlvblJhbmdlIHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGV4dENoYW5nZSB7XG5cdHRleHQ6IHN0cmluZztcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcjtcblx0c2VsZWN0aW9uRW5kOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXBsYWNlUmFuZ2UoXG5cdHRleHQ6IHN0cmluZyxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSxcblx0aW5zZXJ0ZWRUZXh0OiBzdHJpbmdcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBuZXh0VGV4dCA9IHRleHQuc2xpY2UoMCwgc2VsZWN0aW9uLnN0YXJ0KSArIGluc2VydGVkVGV4dCArIHRleHQuc2xpY2Uoc2VsZWN0aW9uLmVuZCk7XG5cdGNvbnN0IGN1cnNvciA9IHNlbGVjdGlvbi5zdGFydCArIGluc2VydGVkVGV4dC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0dGV4dDogbmV4dFRleHQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IGN1cnNvcixcblx0XHRzZWxlY3Rpb25FbmQ6IGN1cnNvclxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlQmFja3dhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gcmVwbGFjZVJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJycpO1xuXHR9XG5cblx0aWYgKHNlbGVjdGlvbi5zdGFydCA9PT0gMCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHJlcGxhY2VSYW5nZShcblx0XHR0ZXh0LFxuXHRcdHtcblx0XHRcdHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQgLSAxLFxuXHRcdFx0ZW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fSxcblx0XHQnJ1xuXHQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlRm9yd2FyZCh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiByZXBsYWNlUmFuZ2UodGV4dCwgc2VsZWN0aW9uLCAnJyk7XG5cdH1cblxuXHRpZiAoc2VsZWN0aW9uLmVuZCA+PSB0ZXh0Lmxlbmd0aCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHNlbGVjdGlvbi5zdGFydCxcblx0XHRcdHNlbGVjdGlvbkVuZDogc2VsZWN0aW9uLmVuZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4gcmVwbGFjZVJhbmdlKFxuXHRcdHRleHQsXG5cdFx0e1xuXHRcdFx0c3RhcnQ6IHNlbGVjdGlvbi5zdGFydCxcblx0XHRcdGVuZDogc2VsZWN0aW9uLmVuZCArIDFcblx0XHR9LFxuXHRcdCcnXG5cdCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0OiBzdHJpbmcsIHBvc2l0aW9uOiBudW1iZXIpIHtcblx0Y29uc3QgYmVmb3JlID0gdGV4dC5zbGljZSgwLCBwb3NpdGlvbik7XG5cdGNvbnN0IGxpbmVTdGFydCA9IGJlZm9yZS5sYXN0SW5kZXhPZignXFxuJykgKyAxO1xuXHRjb25zdCBuZXh0TmV3bGluZSA9IHRleHQuaW5kZXhPZignXFxuJywgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lRW5kID0gbmV4dE5ld2xpbmUgPT09IC0xID8gdGV4dC5sZW5ndGggOiBuZXh0TmV3bGluZTtcblx0cmV0dXJuIHsgbGluZVN0YXJ0LCBsaW5lRW5kIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTZWxlY3RlZEJsb2NrQm91bmRzKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSkge1xuXHRjb25zdCBibG9ja1N0YXJ0ID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgc2VsZWN0aW9uLnN0YXJ0KS5saW5lU3RhcnQ7XG5cdGNvbnN0IGJsb2NrRW5kID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgc2VsZWN0aW9uLmVuZCkubGluZUVuZDtcblx0cmV0dXJuIHsgYmxvY2tTdGFydCwgYmxvY2tFbmQgfTtcbn1cbiIsICJpbXBvcnQgeyBnZXRMaXN0TWV0YWRhdGEsIG5vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyB9IGZyb20gJy4vbGlzdHMnO1xuaW1wb3J0IHtcblx0ZGVsZXRlQmFja3dhcmQsXG5cdGRlbGV0ZUZvcndhcmQsXG5cdGdldEN1cnJlbnRMaW5lQm91bmRzLFxuXHRnZXRTZWxlY3RlZEJsb2NrQm91bmRzLFxuXHR0eXBlIFNlbGVjdGlvblJhbmdlLFxuXHR0eXBlIFRleHRDaGFuZ2Vcbn0gZnJvbSAnLi90ZXh0JztcblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5VGFiS2V5KFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdHNoaWZ0S2V5OiBib29sZWFuXG4pOiBUZXh0Q2hhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiBhcHBseVRhYlRvU2VsZWN0aW9uKHRleHQsIHNlbGVjdGlvbiwgc2hpZnRLZXkpO1xuXHR9XG5cblx0cmV0dXJuIGFwcGx5VGFiVG9MaW5lKHRleHQsIHNlbGVjdGlvbi5zdGFydCwgc2hpZnRLZXkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlFbnRlcktleSh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgeyBzdGFydCwgZW5kIH0gPSBzZWxlY3Rpb247XG5cdGNvbnN0IHsgbGluZVN0YXJ0LCBsaW5lRW5kIH0gPSBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0LCBzdGFydCk7XG5cdGNvbnN0IGxpbmVUZXh0ID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuXHRjb25zdCBtZXRhZGF0YSA9IGdldExpc3RNZXRhZGF0YShsaW5lVGV4dCk7XG5cblx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA9PT0gMCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0OiB0ZXh0LnNsaWNlKDAsIHN0YXJ0KSArICdcXG4nICsgdGV4dC5zbGljZShlbmQpLFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHN0YXJ0ICsgMSxcblx0XHRcdHNlbGVjdGlvbkVuZDogc3RhcnQgKyAxXG5cdFx0fTtcblx0fVxuXG5cdGlmIChtZXRhZGF0YS5vcmRlcmVkICYmIGxpbmVUZXh0LnRyaW0oKS5tYXRjaCgvXlxcZCtcXC4kLykpIHtcblx0XHRjb25zdCBuZXh0VGV4dCA9IHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIHRleHQuc2xpY2UobGluZUVuZCk7XG5cdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0bmV4dFRleHQsXG5cdFx0XHRnZXRTcGxpdExpc3RBZmZlY3RlZFJhbmdlKG5leHRUZXh0LCBsaW5lU3RhcnQpLFxuXHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVTdGFydCB9XG5cdFx0KTtcblx0fVxuXG5cdGlmICghbWV0YWRhdGEub3JkZXJlZCAmJiBsaW5lVGV4dC50cmltKCkgPT09ICctJykge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0OiB0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyB0ZXh0LnNsaWNlKGxpbmVFbmQpLFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IGxpbmVTdGFydCxcblx0XHRcdHNlbGVjdGlvbkVuZDogbGluZVN0YXJ0XG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGluZGVudCA9ICcgICAgJy5yZXBlYXQobWV0YWRhdGEubGlzdExldmVsIC0gMSk7XG5cdGNvbnN0IHByZWZpeCA9IG1ldGFkYXRhLm9yZGVyZWQgPyBgJHtpbmRlbnR9JHttZXRhZGF0YS5saXN0TnVtYmVyICsgMX0uIGAgOiBgJHtpbmRlbnR9LSBgO1xuXHRjb25zdCBuZXh0U2VsZWN0aW9uID0gc3RhcnQgKyAxICsgcHJlZml4Lmxlbmd0aDtcblxuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0dGV4dC5zbGljZSgwLCBzdGFydCkgKyAnXFxuJyArIHByZWZpeCArIHRleHQuc2xpY2UoZW5kKSxcblx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbmV4dFNlbGVjdGlvbiB9LFxuXHRcdHsgc3RhcnQ6IG5leHRTZWxlY3Rpb24sIGVuZDogbmV4dFNlbGVjdGlvbiB9XG5cdCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseURlbGV0ZUJhY2t3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBjaGFuZ2UgPSBkZWxldGVCYWNrd2FyZCh0ZXh0LCBzZWxlY3Rpb24pO1xuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoY2hhbmdlLnRleHQsIGdldERlbGV0ZUFmZmVjdGVkUmFuZ2UodGV4dCwgc2VsZWN0aW9uLCAnYmFja3dhcmQnKSwge1xuXHRcdHN0YXJ0OiBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsXG5cdFx0ZW5kOiBjaGFuZ2Uuc2VsZWN0aW9uRW5kXG5cdH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlEZWxldGVGb3J3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBjaGFuZ2UgPSBkZWxldGVGb3J3YXJkKHRleHQsIHNlbGVjdGlvbik7XG5cdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChjaGFuZ2UudGV4dCwgZ2V0RGVsZXRlQWZmZWN0ZWRSYW5nZSh0ZXh0LCBzZWxlY3Rpb24sICdmb3J3YXJkJyksIHtcblx0XHRzdGFydDogY2hhbmdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdGVuZDogY2hhbmdlLnNlbGVjdGlvbkVuZFxuXHR9KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlUYWJUb1NlbGVjdGlvbihcblx0dGV4dDogc3RyaW5nLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlLFxuXHRzaGlmdEtleTogYm9vbGVhblxuKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IHsgYmxvY2tTdGFydCwgYmxvY2tFbmQgfSA9IGdldFNlbGVjdGVkQmxvY2tCb3VuZHModGV4dCwgc2VsZWN0aW9uKTtcblx0Y29uc3QgYmxvY2sgPSB0ZXh0LnNsaWNlKGJsb2NrU3RhcnQsIGJsb2NrRW5kKTtcblx0Y29uc3QgbGluZXMgPSBibG9jay5zcGxpdCgnXFxuJyk7XG5cblx0Y29uc3QgbW9kaWZpZWQgPSBsaW5lcy5tYXAoKGxpbmUpID0+IHtcblx0XHRjb25zdCBtZXRhZGF0YSA9IGdldExpc3RNZXRhZGF0YShsaW5lKTtcblx0XHRpZiAoc2hpZnRLZXkpIHtcblx0XHRcdGlmIChsaW5lLnN0YXJ0c1dpdGgoJyAgICAnKSkgcmV0dXJuIGxpbmUuc2xpY2UoNCk7XG5cdFx0XHRpZiAobWV0YWRhdGEubGlzdExldmVsID09PSAxKSByZXR1cm4gbGluZS5yZXBsYWNlKC9eLSAvLCAnJykucmVwbGFjZSgvXlxcZCtcXC4gLywgJycpO1xuXHRcdFx0cmV0dXJuIGxpbmU7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGAgICAgJHtsaW5lfWA7XG5cdH0pO1xuXG5cdGNvbnN0IG5leHRCbG9jayA9IG1vZGlmaWVkLmpvaW4oJ1xcbicpO1xuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0dGV4dC5zbGljZSgwLCBibG9ja1N0YXJ0KSArIG5leHRCbG9jayArIHRleHQuc2xpY2UoYmxvY2tFbmQpLFxuXHRcdHsgc3RhcnQ6IGJsb2NrU3RhcnQsIGVuZDogYmxvY2tTdGFydCArIG5leHRCbG9jay5sZW5ndGggfSxcblx0XHR7IHN0YXJ0OiBibG9ja1N0YXJ0LCBlbmQ6IGJsb2NrU3RhcnQgKyBuZXh0QmxvY2subGVuZ3RoIH1cblx0KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlUYWJUb0xpbmUodGV4dDogc3RyaW5nLCBwb3NpdGlvbjogbnVtYmVyLCBzaGlmdEtleTogYm9vbGVhbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCB7IGxpbmVTdGFydCwgbGluZUVuZCB9ID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lVGV4dCA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcblx0Y29uc3QgbWV0YWRhdGEgPSBnZXRMaXN0TWV0YWRhdGEobGluZVRleHQpO1xuXG5cdGlmIChzaGlmdEtleSkge1xuXHRcdGlmIChsaW5lVGV4dC5zdGFydHNXaXRoKCcgICAgJykpIHtcblx0XHRcdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHRcdFx0dGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgbGluZVRleHQuc2xpY2UoNCkgKyB0ZXh0LnNsaWNlKGxpbmVFbmQpLFxuXHRcdFx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbGluZUVuZCAtIDQgfSxcblx0XHRcdFx0eyBzdGFydDogcG9zaXRpb24gLSA0LCBlbmQ6IHBvc2l0aW9uIC0gNCB9XG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdGlmIChtZXRhZGF0YS5saXN0TGV2ZWwgPT09IDEpIHtcblx0XHRcdGNvbnN0IHVwZGF0ZWRMaW5lID0gbGluZVRleHQucmVwbGFjZSgvXi0gLywgJycpLnJlcGxhY2UoL15cXGQrXFwuIC8sICcnKTtcblx0XHRcdGNvbnN0IG5leHRTZWxlY3Rpb24gPSBNYXRoLm1heChsaW5lU3RhcnQsIHBvc2l0aW9uIC0gbWV0YWRhdGEucHJlZml4Lmxlbmd0aCk7XG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0XHRcdHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIHVwZGF0ZWRMaW5lICsgdGV4dC5zbGljZShsaW5lRW5kKSxcblx0XHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVTdGFydCArIHVwZGF0ZWRMaW5lLmxlbmd0aCB9LFxuXHRcdFx0XHR7IHN0YXJ0OiBuZXh0U2VsZWN0aW9uLCBlbmQ6IG5leHRTZWxlY3Rpb24gfVxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBwb3NpdGlvbixcblx0XHRcdHNlbGVjdGlvbkVuZDogcG9zaXRpb25cblx0XHR9O1xuXHR9XG5cblx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA+IDApIHtcblx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0XHR0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyAnICAgICcgKyB0ZXh0LnNsaWNlKGxpbmVTdGFydCksXG5cdFx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbGluZUVuZCArIDQgfSxcblx0XHRcdHsgc3RhcnQ6IHBvc2l0aW9uICsgNCwgZW5kOiBwb3NpdGlvbiArIDQgfVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IHRleHQuc2xpY2UoMCwgcG9zaXRpb24pICsgJyAgICAnICsgdGV4dC5zbGljZShwb3NpdGlvbiksXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IHBvc2l0aW9uICsgNCxcblx0XHRzZWxlY3Rpb25FbmQ6IHBvc2l0aW9uICsgNFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMaXN0RWRpdChcblx0dGV4dDogc3RyaW5nLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZVxuKSB7XG5cdHJldHVybiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnModGV4dCwgYWZmZWN0ZWRSYW5nZSwgc2VsZWN0aW9uKTtcbn1cblxuZnVuY3Rpb24gZ2V0RGVsZXRlQWZmZWN0ZWRSYW5nZShcblx0dGV4dDogc3RyaW5nLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlLFxuXHRkaXJlY3Rpb246ICdiYWNrd2FyZCcgfCAnZm9yd2FyZCdcbik6IFNlbGVjdGlvblJhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiBzZWxlY3Rpb247XG5cdH1cblxuXHRpZiAoZGlyZWN0aW9uID09PSAnYmFja3dhcmQnKSB7XG5cdFx0Y29uc3Qgc3RhcnQgPSBNYXRoLm1heCgwLCBzZWxlY3Rpb24uc3RhcnQgLSAxKTtcblx0XHRyZXR1cm4geyBzdGFydCwgZW5kOiBzZWxlY3Rpb24uc3RhcnQgfTtcblx0fVxuXG5cdGNvbnN0IGVuZCA9IE1hdGgubWluKHRleHQubGVuZ3RoLCBzZWxlY3Rpb24uZW5kICsgMSk7XG5cdHJldHVybiB7IHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsIGVuZCB9O1xufVxuXG5mdW5jdGlvbiBnZXRTcGxpdExpc3RBZmZlY3RlZFJhbmdlKHRleHQ6IHN0cmluZywgYm91bmRhcnk6IG51bWJlcik6IFNlbGVjdGlvblJhbmdlIHtcblx0cmV0dXJuIHtcblx0XHRzdGFydDogTWF0aC5tYXgoMCwgYm91bmRhcnkgLSAxKSxcblx0XHRlbmQ6IE1hdGgubWluKHRleHQubGVuZ3RoLCBib3VuZGFyeSArIDEpXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDMERaLFNBQVMsY0FBYyxTQUFpQztBQUM5RCxRQUFNLE9BQU8sY0FBYyxPQUFPO0FBQ2xDLFFBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsUUFBTSxTQUFTLFlBQVksUUFBUTtBQUNuQyxRQUFNLFFBQVEsWUFBWSxNQUFNO0FBQ2hDLFNBQU8sRUFBRSxNQUFNLFFB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
