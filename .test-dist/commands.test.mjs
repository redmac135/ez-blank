// tests/commands.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/editor/basic/parser.ts
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

// src/lib/editor/basic/lists.ts
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

// src/lib/editor/basic/text.ts
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
  const blockEndPosition = selection.start !== selection.end && selection.end > 0 && text[selection.end - 1] === "\n" ? selection.end - 1 : selection.end;
  const blockEnd = getCurrentLineBounds(text, blockEndPosition).lineEnd;
  return { blockStart, blockEnd };
}

// src/lib/editor/basic/commands.ts
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
    return normalizeListEdit(nextText, getSplitListAffectedRange(nextText, lineStart), {
      start: lineStart,
      end: lineStart
    });
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
test("applyTabKey renumbers the parent ordered list after indenting nested rows", () => {
  const source = "1. outer\n    1. a\n    2. b\n    3. c\n    4. d";
  const start = source.indexOf("    2. b");
  const end = source.indexOf("    3. c") + "    3. c".length;
  const change = applyTabKey(source, { start, end }, false);
  assert.equal(change.text, "1. outer\n    1. a\n        1. b\n        2. c\n    2. d");
  assert.equal(change.selectionStart, start);
  assert.equal(change.selectionEnd, end + 8);
});
test("applyTabKey treats selection ends at the next line start as end-exclusive", () => {
  const source = "1. outer\n    1. a\n    2. b\n    3. c";
  const start = source.indexOf("    1. a");
  const end = source.indexOf("    3. c");
  const change = applyTabKey(source, { start, end }, false);
  assert.equal(change.text, "1. outer\n        1. a\n        2. b\n    1. c");
  assert.equal(change.selectionStart, start);
  assert.equal(change.selectionEnd, end + 7);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY29tbWFuZHMudGVzdC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9iYXNpYy9wYXJzZXIudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvYmFzaWMvbGlzdHMudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvYmFzaWMvdGV4dC50cyIsICIuLi9zcmMvbGliL2VkaXRvci9iYXNpYy9jb21tYW5kcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7XG5cdGFwcGx5RGVsZXRlQmFja3dhcmQsXG5cdGFwcGx5RGVsZXRlRm9yd2FyZCxcblx0YXBwbHlFbnRlcktleSxcblx0YXBwbHlUYWJLZXlcbn0gZnJvbSAnLi4vc3JjL2xpYi9lZGl0b3IvYmFzaWMvY29tbWFuZHMudHMnO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgdGhlIHdob2xlIG9yZGVyZWQgc3VibGlzdCB3aGVuIGluZGVudGluZyBhIHN1YnNldCBzZWxlY3Rpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzb3VyY2UubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydCwgZW5kIH0sIGZhbHNlKTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICcxLiBvbmVcXG4gICAgMS4gdHdvXFxuICAgIDIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDcpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnRleHQubGVuZ3RoKTtcbn0pO1xuXG50ZXN0KCdhcHBseVRhYktleSByZW51bWJlcnMgZm9sbG93aW5nIHNpYmxpbmdzIHdoZW4gaW5kZW50aW5nIGEgc2luZ2xlIG9yZGVyZWQgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9LCBmYWxzZSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuICAgIDEuIHR3b1xcbjIuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIGN1cnNvciArIDQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY3Vyc29yICsgNCk7XG59KTtcblxudGVzdCgnYXBwbHlUYWJLZXkgcmVudW1iZXJzIHRoZSBwYXJlbnQgb3JkZXJlZCBsaXN0IGFmdGVyIGluZGVudGluZyBuZXN0ZWQgcm93cycsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG91dGVyXFxuICAgIDEuIGFcXG4gICAgMi4gYlxcbiAgICAzLiBjXFxuICAgIDQuIGQnO1xuXHRjb25zdCBzdGFydCA9IHNvdXJjZS5pbmRleE9mKCcgICAgMi4gYicpO1xuXHRjb25zdCBlbmQgPSBzb3VyY2UuaW5kZXhPZignICAgIDMuIGMnKSArICcgICAgMy4gYycubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5VGFiS2V5KHNvdXJjZSwgeyBzdGFydCwgZW5kIH0sIGZhbHNlKTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICcxLiBvdXRlclxcbiAgICAxLiBhXFxuICAgICAgICAxLiBiXFxuICAgICAgICAyLiBjXFxuICAgIDIuIGQnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgZW5kICsgOCk7XG59KTtcblxudGVzdCgnYXBwbHlUYWJLZXkgdHJlYXRzIHNlbGVjdGlvbiBlbmRzIGF0IHRoZSBuZXh0IGxpbmUgc3RhcnQgYXMgZW5kLWV4Y2x1c2l2ZScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG91dGVyXFxuICAgIDEuIGFcXG4gICAgMi4gYlxcbiAgICAzLiBjJztcblx0Y29uc3Qgc3RhcnQgPSBzb3VyY2UuaW5kZXhPZignICAgIDEuIGEnKTtcblx0Y29uc3QgZW5kID0gc291cmNlLmluZGV4T2YoJyAgICAzLiBjJyk7XG5cblx0Y29uc3QgY2hhbmdlID0gYXBwbHlUYWJLZXkoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSwgZmFsc2UpO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG91dGVyXFxuICAgICAgICAxLiBhXFxuICAgICAgICAyLiBiXFxuICAgIDEuIGMnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgZW5kICsgNyk7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbGlzdCBpdGVtIGFuZCByZW51bWJlcnMgbGF0ZXIgb3JkZXJlZCBzaWJsaW5ncycsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpICsgJzIuIHR3bycubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG9uZVxcbjIuIHR3b1xcbjMuIFxcbjQuIHRocmVlJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBvbmVcXG4yLiB0d29cXG4zLiAnLmxlbmd0aCk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uRW5kLCBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RW50ZXJLZXkgcHJlc2VydmVzIHBsYWluIHBhcmFncmFwaHMgd2l0aG91dCBsaXN0IG5vcm1hbGl6YXRpb24nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICdhbHBoYSBiZXRhJztcblx0Y29uc3QgY3Vyc29yID0gNTtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseUVudGVyS2V5KHNvdXJjZSwgeyBzdGFydDogY3Vyc29yLCBlbmQ6IGN1cnNvciB9KTtcblxuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnRleHQsICdhbHBoYVxcbiBiZXRhJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsIDYpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgNik7XG59KTtcblxudGVzdCgnYXBwbHlFbnRlcktleSBpbnNlcnRzIGEgbmVzdGVkIG9yZGVyZWQgaXRlbSBhbmQgcmVudW1iZXJzIG9ubHkgdGhhdCBuZXN0ZWQgbGlzdCcsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBzaWJsaW5nXFxuMi4gb3V0ZXInO1xuXHRjb25zdCBjdXJzb3IgPSBzb3VyY2UuaW5kZXhPZignMS4gY2hpbGQnKSArICcxLiBjaGlsZCcubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIHBhcmVudFxcbiAgICAxLiBjaGlsZFxcbiAgICAyLiBcXG4gICAgMy4gc2libGluZ1xcbjIuIG91dGVyJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICcxLiBwYXJlbnRcXG4gICAgMS4gY2hpbGRcXG4gICAgMi4gJy5sZW5ndGgpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnNlbGVjdGlvblN0YXJ0KTtcbn0pO1xuXG50ZXN0KCdhcHBseUVudGVyS2V5IG9uIGFuIGVtcHR5IG9yZGVyZWQgaXRlbSBpbiB0aGUgbWlkZGxlIHJlc2V0cyB0aGUgbG93ZXIgbGlzdCB0byAxJywgKCkgPT4ge1xuXHRjb25zdCBzb3VyY2UgPSAnMS4gb25lXFxuMi4gXFxuMy4gdGhyZWVcXG40LiBmb3VyJztcblx0Y29uc3QgY3Vyc29yID0gc291cmNlLmluZGV4T2YoJzIuICcpO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RW50ZXJLZXkoc291cmNlLCB7IHN0YXJ0OiBjdXJzb3IsIGVuZDogY3Vyc29yIH0pO1xuXG5cdGFzc2VydC5lcXVhbChjaGFuZ2UudGV4dCwgJzEuIG9uZVxcblxcbjEuIHRocmVlXFxuMi4gZm91cicpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvblN0YXJ0LCBzb3VyY2UuaW5kZXhPZignMi4gJykpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgY2hhbmdlLnNlbGVjdGlvblN0YXJ0KTtcbn0pO1xuXG50ZXN0KCdhcHBseURlbGV0ZUJhY2t3YXJkIHJlbnVtYmVycyBvcmRlcmVkIGxpc3Qgc2libGluZ3MgYWZ0ZXIgcmVtb3ZpbmcgYSBtaWRkbGUgaXRlbScsICgpID0+IHtcblx0Y29uc3Qgc291cmNlID0gJzEuIG9uZVxcbjIuIHR3b1xcbjMuIHRocmVlJztcblx0Y29uc3Qgc3RhcnQgPSBzb3VyY2UuaW5kZXhPZignMi4gdHdvJyk7XG5cdGNvbnN0IGVuZCA9IHN0YXJ0ICsgJzIuIHR3b1xcbicubGVuZ3RoO1xuXG5cdGNvbnN0IGNoYW5nZSA9IGFwcGx5RGVsZXRlQmFja3dhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG5cbnRlc3QoJ2FwcGx5RGVsZXRlRm9yd2FyZCByZW51bWJlcnMgb3JkZXJlZCBsaXN0IHNpYmxpbmdzIGFmdGVyIHJlbW92aW5nIGEgbWlkZGxlIGl0ZW0nLCAoKSA9PiB7XG5cdGNvbnN0IHNvdXJjZSA9ICcxLiBvbmVcXG4yLiB0d29cXG4zLiB0aHJlZSc7XG5cdGNvbnN0IHN0YXJ0ID0gc291cmNlLmluZGV4T2YoJzIuIHR3bycpO1xuXHRjb25zdCBlbmQgPSBzdGFydCArICcyLiB0d29cXG4nLmxlbmd0aDtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseURlbGV0ZUZvcndhcmQoc291cmNlLCB7IHN0YXJ0LCBlbmQgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnMS4gb25lXFxuMi4gdGhyZWUnKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25TdGFydCwgc3RhcnQpO1xuXHRhc3NlcnQuZXF1YWwoY2hhbmdlLnNlbGVjdGlvbkVuZCwgc3RhcnQpO1xufSk7XG4iLCAiaW1wb3J0IHR5cGUge1xuXHRCbG9ja05vZGUsXG5cdENvZGVCbG9jayxcblx0Rm9ybWF0dGVkTm9kZSxcblx0SGVhZGluZ0Jsb2NrLFxuXHRJbmxpbmVOb2RlLFxuXHRMaXN0QmxvY2ssXG5cdExpc3RJdGVtQmxvY2ssXG5cdFBhcmFncmFwaEJsb2NrLFxuXHRTb3VyY2VSYW5nZSxcblx0VGV4dE5vZGVcbn0gZnJvbSAnLi9hc3QnO1xuXG5leHBvcnQgdHlwZSBMaW5lS2luZCA9XG5cdHwgJ3BhcmFncmFwaCdcblx0fCAnaGVhZGluZydcblx0fCAndW5vcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnb3JkZXJlZF9saXN0X2l0ZW0nXG5cdHwgJ2NvZGVfZmVuY2UnXG5cdHwgJ2NvZGVfY29udGVudCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdG9yTGluZSB7XG5cdGlkOiBzdHJpbmc7XG5cdGluZGV4OiBudW1iZXI7XG5cdHJhdzogc3RyaW5nO1xuXHRyYW5nZTogU291cmNlUmFuZ2U7XG5cdGtpbmQ6IExpbmVLaW5kO1xuXHRsaXN0TGV2ZWw6IG51bWJlcjtcblx0bGlzdE51bWJlcjogbnVtYmVyO1xuXHRoZWFkaW5nTGV2ZWw6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG5cdHByZWZpeFJhbmdlOiBTb3VyY2VSYW5nZSB8IG51bGw7XG5cdGNvbnRlbnRSYW5nZTogU291cmNlUmFuZ2U7XG5cdGlubGluZTogSW5saW5lTm9kZVtdO1xuXHRjb2RlQmxvY2tMYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JEb2N1bWVudCB7XG5cdHRleHQ6IHN0cmluZztcblx0YmxvY2tzOiBCbG9ja05vZGVbXTtcblx0bGluZXM6IEVkaXRvckxpbmVbXTtcbn1cblxuaW50ZXJmYWNlIFJhd0xpbmUge1xuXHRpbmRleDogbnVtYmVyO1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTGluZVByZWZpeEluZm8ge1xuXHRraW5kOiAncGFyYWdyYXBoJyB8ICdoZWFkaW5nJyB8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyB8ICdvcmRlcmVkX2xpc3RfaXRlbScgfCAnY29kZV9mZW5jZSc7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0bGFuZ3VhZ2U6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZERvY3VtZW50KHJhd1RleHQ6IHN0cmluZyk6IEVkaXRvckRvY3VtZW50IHtcblx0Y29uc3QgdGV4dCA9IG5vcm1hbGl6ZVRleHQocmF3VGV4dCk7XG5cdGNvbnN0IHJhd0xpbmVzID0gYnVpbGRSYXdMaW5lcyh0ZXh0KTtcblx0Y29uc3QgYmxvY2tzID0gcGFyc2VCbG9ja3MocmF3TGluZXMpO1xuXHRjb25zdCBsaW5lcyA9IGRlcml2ZUxpbmVzKGJsb2Nrcyk7XG5cdHJldHVybiB7IHRleHQsIGJsb2NrcywgbGluZXMgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQocmF3VGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHJhd1RleHQucmVwbGFjZSgvXFxyXFxuPy9nLCAnXFxuJyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJFZGl0b3JMaW5lKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRjb25zdCBwcmVmaXggPSBsaW5lLnByZWZpeFJhbmdlID8gcmVuZGVyRWRpdG9yVGV4dChsaW5lLnByZWZpeCkgOiAnJztcblx0Y29uc3QgY29udGVudCA9IGxpbmUua2luZC5zdGFydHNXaXRoKCdjb2RlXycpXG5cdFx0PyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucmF3LnNsaWNlKGxpbmUucHJlZml4Lmxlbmd0aCkpXG5cdFx0OiByZW5kZXJFZGl0b3JJbmxpbmUobGluZS5pbmxpbmUpO1xuXHRjb25zdCBib2R5ID0gcHJlZml4ICsgKGNvbnRlbnQgfHwgKGxpbmUucmF3Lmxlbmd0aCA9PT0gMCA/ICc8YnI+JyA6ICcnKSk7XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBsaW5lLmtpbmQgPT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykge1xuXHRcdGNvbnN0IHByZWZpeFdpZHRoID0gbGluZS5wcmVmaXgudHJpbVN0YXJ0KCkubGVuZ3RoO1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgbGlzdFwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIiBzdHlsZT1cIi0tbGlzdC1sZXZlbDogJHtsaW5lLmxpc3RMZXZlbCAtIDF9OyAtLXByZWZpeC13aWR0aDogJHtwcmVmaXhXaWR0aH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmUgaGVhZGluZ1wiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdGlmIChsaW5lLmtpbmQgPT09ICdjb2RlX2ZlbmNlJyB8fCBsaW5lLmtpbmQgPT09ICdjb2RlX2NvbnRlbnQnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBjb2RlICR7bGluZS5raW5kfVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcblx0fVxuXG5cdHJldHVybiBgPGRpdiBjbGFzcz1cImxpbmVcIiBkYXRhLWxpbmUtaWQ9XCIke2xpbmUuaWR9XCI+JHtib2R5fTwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTZWxlY3Rpb25IdG1sKGRvY3VtZW50OiBFZGl0b3JEb2N1bWVudCwgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBzdHJpbmcge1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHMgPSBkb2N1bWVudC5ibG9ja3Ncblx0XHQubWFwKChibG9jaykgPT4gcmVuZGVyQmxvY2tTZWxlY3Rpb24oZG9jdW1lbnQudGV4dCwgYmxvY2ssIHN0YXJ0LCBlbmQpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbik7XG5cblx0cmV0dXJuIGA8ZGl2IHN0eWxlPVwid2hpdGUtc3BhY2U6IHByZS13cmFwO1wiPiR7cGFydHMuam9pbignJyl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRMaW5lSW5kZXgobGluZXM6IEVkaXRvckxpbmVbXSwgb2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAobGluZXMubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgbGluZXMubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBuZXh0U3RhcnQgPSBpbmRleCArIDEgPCBsaW5lcy5sZW5ndGggPyBsaW5lc1tpbmRleCArIDFdLnJhbmdlLnN0YXJ0IDogbGluZS5yYW5nZS5lbmQgKyAxO1xuXHRcdGlmIChvZmZzZXQgPCBuZXh0U3RhcnQpIHJldHVybiBpbmRleDtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5sZW5ndGggLSAxO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGluZVJlbmRlclNpZ25hdHVyZShsaW5lOiBFZGl0b3JMaW5lKTogc3RyaW5nIHtcblx0cmV0dXJuIFtcblx0XHRsaW5lLmtpbmQsXG5cdFx0bGluZS5yYXcsXG5cdFx0bGluZS5wcmVmaXgsXG5cdFx0bGluZS5saXN0TGV2ZWwsXG5cdFx0bGluZS5saXN0TnVtYmVyLFxuXHRcdGxpbmUuaGVhZGluZ0xldmVsLFxuXHRcdGxpbmUuY29kZUJsb2NrTGFuZ3VhZ2UgPz8gJydcblx0XS5qb2luKCdcXHUwMDAxJyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUmF3TGluZXModGV4dDogc3RyaW5nKTogUmF3TGluZVtdIHtcblx0Y29uc3Qgc3BsaXQgPSB0ZXh0LnNwbGl0KCdcXG4nKTtcblx0Y29uc3QgbGluZXM6IFJhd0xpbmVbXSA9IFtdO1xuXHRsZXQgb2Zmc2V0ID0gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3BsaXQubGVuZ3RoOyBpbmRleCsrKSB7XG5cdFx0Y29uc3QgbGluZSA9IHNwbGl0W2luZGV4XTtcblx0XHRsaW5lcy5wdXNoKHtcblx0XHRcdGluZGV4LFxuXHRcdFx0dGV4dDogbGluZSxcblx0XHRcdHN0YXJ0OiBvZmZzZXQsXG5cdFx0XHRlbmQ6IG9mZnNldCArIGxpbmUubGVuZ3RoXG5cdFx0fSk7XG5cdFx0b2Zmc2V0ICs9IGxpbmUubGVuZ3RoICsgMTtcblx0fVxuXG5cdHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gcGFyc2VCbG9ja3MobGluZXM6IFJhd0xpbmVbXSk6IEJsb2NrTm9kZVtdIHtcblx0cmV0dXJuIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgMCwgMCkuYmxvY2tzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsaXN0TGV2ZWw6IG51bWJlcikge1xuXHRjb25zdCBibG9ja3M6IEJsb2NrTm9kZVtdID0gW107XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXg7XG5cblx0d2hpbGUgKGluZGV4IDwgbGluZXMubGVuZ3RoKSB7XG5cdFx0Y29uc3QgbGluZSA9IGxpbmVzW2luZGV4XTtcblx0XHRjb25zdCBwcmVmaXggPSBwYXJzZVByZWZpeChsaW5lLnRleHQpO1xuXG5cdFx0aWYgKGxpc3RMZXZlbCA+IDApIHtcblx0XHRcdGlmIChsaW5lLnRleHQudHJpbSgpID09PSAnJykgYnJlYWs7XG5cdFx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKFxuXHRcdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdFx0cHJlZml4Lmxpc3RMZXZlbCA8IGxpc3RMZXZlbFxuXHRcdFx0KSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUNvZGVCbG9jayhsaW5lcywgaW5kZXgpO1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VkLmJsb2NrKTtcblx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyB8fCBwcmVmaXgua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUxpc3QobGluZXMsIGluZGV4LCBwcmVmaXgubGlzdExldmVsLCBwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJyk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnaGVhZGluZycpIHtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlSGVhZGluZyhsaW5lLCBwcmVmaXgpKTtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRibG9ja3MucHVzaChwYXJzZVBhcmFncmFwaChsaW5lKSk7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7IGJsb2NrcywgbmV4dEluZGV4OiBpbmRleCB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUxpc3QobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBsZXZlbDogbnVtYmVyLCBvcmRlcmVkOiBib29sZWFuKSB7XG5cdGNvbnN0IGl0ZW1zOiBMaXN0SXRlbUJsb2NrW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKFxuXHRcdFx0KHByZWZpeC5raW5kICE9PSAnb3JkZXJlZF9saXN0X2l0ZW0nICYmIHByZWZpeC5raW5kICE9PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHx8XG5cdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGV2ZWwgfHxcblx0XHRcdChwcmVmaXgubGlzdExldmVsID09PSBsZXZlbCAmJiAocHJlZml4LmtpbmQgPT09ICdvcmRlcmVkX2xpc3RfaXRlbScpICE9PSBvcmRlcmVkKVxuXHRcdCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5saXN0TGV2ZWwgPiBsZXZlbCkge1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaXRlbVN0YXJ0ID0gbGluZS5zdGFydDtcblx0XHRjb25zdCBpdGVtUHJlZml4TGVuZ3RoID0gcHJlZml4LnByZWZpeC5sZW5ndGg7XG5cdFx0Y29uc3QgaXRlbTogTGlzdEl0ZW1CbG9jayA9IHtcblx0XHRcdHR5cGU6ICdsaXN0X2l0ZW0nLFxuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0bGluZVJhbmdlOiB7IHN0YXJ0OiBsaW5lLnN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsZXZlbCxcblx0XHRcdG9yZGVyZWQsXG5cdFx0XHRudW1iZXI6IHByZWZpeC5saXN0TnVtYmVyLFxuXHRcdFx0cHJlZml4OiBwcmVmaXgucHJlZml4LFxuXHRcdFx0cmF3OiBsaW5lLnRleHQsXG5cdFx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShpdGVtUHJlZml4TGVuZ3RoKSwgbGluZS5zdGFydCArIGl0ZW1QcmVmaXhMZW5ndGgpLFxuXHRcdFx0Y2hpbGRyZW46IFtdXG5cdFx0fTtcblxuXHRcdGluZGV4ICs9IDE7XG5cdFx0Y29uc3QgY2hpbGRQYXJzZWQgPSBwYXJzZUJsb2NrU2VxdWVuY2UobGluZXMsIGluZGV4LCBsZXZlbCArIDEpO1xuXHRcdGl0ZW0uY2hpbGRyZW4gPSBjaGlsZFBhcnNlZC5ibG9ja3M7XG5cdFx0Y29uc3QgY2hpbGRFbmQgPVxuXHRcdFx0aXRlbS5jaGlsZHJlbi5sZW5ndGggPiAwID8gaXRlbS5jaGlsZHJlbltpdGVtLmNoaWxkcmVuLmxlbmd0aCAtIDFdLnJhbmdlLmVuZCA6IGl0ZW0ucmFuZ2UuZW5kO1xuXHRcdGl0ZW0ucmFuZ2UgPSB7IHN0YXJ0OiBpdGVtU3RhcnQsIGVuZDogY2hpbGRFbmQgfTtcblx0XHRpdGVtcy5wdXNoKGl0ZW0pO1xuXHRcdGluZGV4ID0gY2hpbGRQYXJzZWQubmV4dEluZGV4O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRibG9jazoge1xuXHRcdFx0dHlwZTogJ2xpc3QnLFxuXHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0c3RhcnQ6IGl0ZW1zWzBdPy5yYW5nZS5zdGFydCA/PyBsaW5lc1tzdGFydEluZGV4XS5zdGFydCxcblx0XHRcdFx0ZW5kOiBpdGVtc1tpdGVtcy5sZW5ndGggLSAxXT8ucmFuZ2UuZW5kID8/IGxpbmVzW3N0YXJ0SW5kZXhdLmVuZFxuXHRcdFx0fSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdGl0ZW1zXG5cdFx0fSBzYXRpc2ZpZXMgTGlzdEJsb2NrLFxuXHRcdG5leHRJbmRleDogaW5kZXhcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDb2RlQmxvY2sobGluZXM6IFJhd0xpbmVbXSwgc3RhcnRJbmRleDogbnVtYmVyKSB7XG5cdGNvbnN0IG9wZW5MaW5lID0gbGluZXNbc3RhcnRJbmRleF07XG5cdGNvbnN0IG9wZW5QcmVmaXggPSBwYXJzZVByZWZpeChvcGVuTGluZS50ZXh0KTtcblx0Y29uc3QgY29udGVudExpbmVzOiBDb2RlQmxvY2tbJ2xpbmVzJ10gPSBbXTtcblx0bGV0IGNsb3NlRmVuY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRsZXQgZW5kID0gb3BlbkxpbmUuZW5kO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4ICsgMTtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNsb3NlRmVuY2UgPSBwcmVmaXgucHJlZml4O1xuXHRcdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0XHRpbmRleCArPSAxO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y29udGVudExpbmVzLnB1c2goe1xuXHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdHRleHQ6IGxpbmUudGV4dFxuXHRcdH0pO1xuXHRcdGVuZCA9IGxpbmUuZW5kO1xuXHRcdGluZGV4ICs9IDE7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnY29kZV9ibG9jaycsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogb3BlbkxpbmUuc3RhcnQsIGVuZCB9LFxuXHRcdFx0bGFuZ3VhZ2U6IG9wZW5QcmVmaXgubGFuZ3VhZ2UsXG5cdFx0XHRvcGVuRmVuY2U6IG9wZW5QcmVmaXgucHJlZml4LFxuXHRcdFx0Y2xvc2VGZW5jZSxcblx0XHRcdGxpbmVzOiBjb250ZW50TGluZXNcblx0XHR9IHNhdGlzZmllcyBDb2RlQmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUhlYWRpbmcobGluZTogUmF3TGluZSwgcHJlZml4OiBMaW5lUHJlZml4SW5mbyk6IEhlYWRpbmdCbG9jayB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IGxpbmUuc3RhcnQgKyBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAnaGVhZGluZycsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRsZXZlbDogcHJlZml4LmhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0aW5saW5lOiBwYXJzZUlubGluZShsaW5lLnRleHQuc2xpY2UocHJlZml4LnByZWZpeC5sZW5ndGgpLCBjb250ZW50U3RhcnQpXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFyYWdyYXBoKGxpbmU6IFJhd0xpbmUpOiBQYXJhZ3JhcGhCbG9jayB7XG5cdHJldHVybiB7XG5cdFx0dHlwZTogJ3BhcmFncmFwaCcsXG5cdFx0cmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dCwgbGluZS5zdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gZGVyaXZlTGluZXMoYmxvY2tzOiBCbG9ja05vZGVbXSk6IEVkaXRvckxpbmVbXSB7XG5cdGNvbnN0IGxpbmVzOiBFZGl0b3JMaW5lW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGFwcGVuZEJsb2NrTGluZXMoYmxvY2ssIGxpbmVzKTtcblx0fVxuXG5cdHJldHVybiBsaW5lcy5tYXAoKGxpbmUsIGluZGV4KSA9PiAoe1xuXHRcdC4uLmxpbmUsXG5cdFx0aWQ6IGBsaW5lLSR7aW5kZXh9YCxcblx0XHRpbmRleFxuXHR9KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZEJsb2NrTGluZXMoYmxvY2s6IEJsb2NrTm9kZSwgbGluZXM6IEVkaXRvckxpbmVbXSkge1xuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRsaW5lcy5wdXNoKGNyZWF0ZUJhc2VMaW5lKGJsb2NrLnJhdywgYmxvY2sucmFuZ2UsICdwYXJhZ3JhcGgnLCAnJywgbnVsbCwgYmxvY2suaW5saW5lKSk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdoZWFkaW5nJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sucmF3LFxuXHRcdFx0XHRibG9jay5yYW5nZSxcblx0XHRcdFx0J2hlYWRpbmcnLFxuXHRcdFx0XHRibG9jay5wcmVmaXgsXG5cdFx0XHRcdG51bGwsXG5cdFx0XHRcdGJsb2NrLmlubGluZSxcblx0XHRcdFx0MCxcblx0XHRcdFx0MCxcblx0XHRcdFx0YmxvY2subGV2ZWxcblx0XHRcdClcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnY29kZV9ibG9jaycpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSArIChibG9jay5sYW5ndWFnZSA/IGJsb2NrLmxhbmd1YWdlIDogJycpLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c3RhcnQ6IGJsb2NrLnJhbmdlLnN0YXJ0LFxuXHRcdFx0XHRcdGVuZDogYmxvY2sucmFuZ2Uuc3RhcnQgKyBibG9jay5vcGVuRmVuY2UubGVuZ3RoICsgKGJsb2NrLmxhbmd1YWdlPy5sZW5ndGggPz8gMClcblx0XHRcdFx0fSxcblx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRibG9jay5vcGVuRmVuY2UsXG5cdFx0XHRcdGJsb2NrLmxhbmd1YWdlLFxuXHRcdFx0XHRbXVxuXHRcdFx0KVxuXHRcdCk7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUobGluZS50ZXh0LCBsaW5lLnJhbmdlLCAnY29kZV9jb250ZW50JywgJycsIGJsb2NrLmxhbmd1YWdlLCBbXSkpO1xuXHRcdH1cblxuXHRcdGlmIChibG9jay5jbG9zZUZlbmNlKSB7XG5cdFx0XHRjb25zdCBjbG9zZVN0YXJ0ID0gYmxvY2sucmFuZ2UuZW5kIC0gYmxvY2suY2xvc2VGZW5jZS5sZW5ndGg7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRibG9jay5jbG9zZUZlbmNlLFxuXHRcdFx0XHRcdHsgc3RhcnQ6IGNsb3NlU3RhcnQsIGVuZDogYmxvY2sucmFuZ2UuZW5kIH0sXG5cdFx0XHRcdFx0J2NvZGVfZmVuY2UnLFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFx0W11cblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHR9XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQmFzZUxpbmUoXG5cdFx0XHRcdFx0aXRlbS5yYXcsXG5cdFx0XHRcdFx0aXRlbS5saW5lUmFuZ2UsXG5cdFx0XHRcdFx0aXRlbS5vcmRlcmVkID8gJ29yZGVyZWRfbGlzdF9pdGVtJyA6ICd1bm9yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdFx0XHRpdGVtLnByZWZpeCxcblx0XHRcdFx0XHRudWxsLFxuXHRcdFx0XHRcdGl0ZW0uaW5saW5lLFxuXHRcdFx0XHRcdGl0ZW0ubGV2ZWwsXG5cdFx0XHRcdFx0aXRlbS5udW1iZXJcblx0XHRcdFx0KVxuXHRcdFx0KTtcblx0XHRcdGZvciAoY29uc3QgY2hpbGQgb2YgaXRlbS5jaGlsZHJlbikge1xuXHRcdFx0XHRhcHBlbmRCbG9ja0xpbmVzKGNoaWxkLCBsaW5lcyk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUJhc2VMaW5lKFxuXHRyYXc6IHN0cmluZyxcblx0cmFuZ2U6IFNvdXJjZVJhbmdlLFxuXHRraW5kOiBMaW5lS2luZCxcblx0cHJlZml4OiBzdHJpbmcsXG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0bGlzdExldmVsID0gMCxcblx0bGlzdE51bWJlciA9IDAsXG5cdGhlYWRpbmdMZXZlbCA9IDBcbik6IEVkaXRvckxpbmUge1xuXHRjb25zdCBjb250ZW50U3RhcnQgPSByYW5nZS5zdGFydCArIHByZWZpeC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0aWQ6ICcnLFxuXHRcdGluZGV4OiAwLFxuXHRcdHJhdyxcblx0XHRyYW5nZSxcblx0XHRraW5kLFxuXHRcdGxpc3RMZXZlbCxcblx0XHRsaXN0TnVtYmVyLFxuXHRcdGhlYWRpbmdMZXZlbCxcblx0XHRwcmVmaXgsXG5cdFx0cHJlZml4UmFuZ2U6IHByZWZpeC5sZW5ndGggPiAwID8geyBzdGFydDogcmFuZ2Uuc3RhcnQsIGVuZDogY29udGVudFN0YXJ0IH0gOiBudWxsLFxuXHRcdGNvbnRlbnRSYW5nZTogeyBzdGFydDogY29udGVudFN0YXJ0LCBlbmQ6IHJhbmdlLmVuZCB9LFxuXHRcdGlubGluZSxcblx0XHRjb2RlQmxvY2tMYW5ndWFnZVxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVByZWZpeChyYXc6IHN0cmluZyk6IExpbmVQcmVmaXhJbmZvIHtcblx0Y29uc3QgY29kZUZlbmNlTWF0Y2ggPSByYXcubWF0Y2goL15gYGAoW0EtWmEtejAtOV8tXSspP1xccyokLyk7XG5cdGlmIChjb2RlRmVuY2VNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnY29kZV9mZW5jZScsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiAnYGBgJyxcblx0XHRcdGxhbmd1YWdlOiBjb2RlRmVuY2VNYXRjaFsxXSA/PyBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IHVub3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKiktIC8pO1xuXHRpZiAodW5vcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiB1bm9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdLFxuXHRcdFx0bGFuZ3VhZ2U6IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3Qgb3JkZXJlZE1hdGNoID0gcmF3Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogJ29yZGVyZWRfbGlzdF9pdGVtJyxcblx0XHRcdGxpc3RMZXZlbDogb3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBoZWFkaW5nTWF0Y2ggPSByYXcubWF0Y2goL14oI3sxLDZ9KVxccysvKTtcblx0aWYgKGhlYWRpbmdNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnaGVhZGluZycsXG5cdFx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdFx0aGVhZGluZ0xldmVsOiBoZWFkaW5nTWF0Y2hbMV0ubGVuZ3RoLFxuXHRcdFx0cHJlZml4OiBoZWFkaW5nTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGtpbmQ6ICdwYXJhZ3JhcGgnLFxuXHRcdGxpc3RMZXZlbDogMCxcblx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRwcmVmaXg6ICcnLFxuXHRcdGxhbmd1YWdlOiBudWxsXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSW5saW5lKHJhdzogc3RyaW5nLCBzdGFydE9mZnNldDogbnVtYmVyKTogSW5saW5lTm9kZVtdIHtcblx0Y29uc3QgaW5saW5lOiBJbmxpbmVOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gMDtcblxuXHR3aGlsZSAoaW5kZXggPCByYXcubGVuZ3RoKSB7XG5cdFx0Y29uc3QgZm9ybWF0dGVkTm9kZSA9IHBhcnNlRm9ybWF0dGVkTm9kZShyYXcsIHN0YXJ0T2Zmc2V0LCBpbmRleCk7XG5cdFx0aWYgKGZvcm1hdHRlZE5vZGUpIHtcblx0XHRcdGlubGluZS5wdXNoKGZvcm1hdHRlZE5vZGUubm9kZSk7XG5cdFx0XHRpbmRleCA9IGZvcm1hdHRlZE5vZGUubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0bGV0IG5leHRNYXJrZXIgPSByYXcubGVuZ3RoO1xuXHRcdGNvbnN0IHN0YXJJbmRleCA9IHJhdy5pbmRleE9mKCcqJywgaW5kZXgpO1xuXHRcdGlmIChzdGFySW5kZXggIT09IC0xKSBuZXh0TWFya2VyID0gc3RhckluZGV4O1xuXHRcdGNvbnN0IGJhY2t0aWNrSW5kZXggPSByYXcuaW5kZXhPZignYCcsIGluZGV4KTtcblx0XHRpZiAoYmFja3RpY2tJbmRleCAhPT0gLTEpIG5leHRNYXJrZXIgPSBNYXRoLm1pbihuZXh0TWFya2VyLCBiYWNrdGlja0luZGV4KTtcblxuXHRcdGlmIChuZXh0TWFya2VyID09PSBpbmRleCkge1xuXHRcdFx0aW5saW5lLnB1c2goe1xuXHRcdFx0XHR0eXBlOiAndGV4dCcsXG5cdFx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LCBlbmQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXggKyAxIH0sXG5cdFx0XHRcdHRleHQ6IHJhd1tpbmRleF1cblx0XHRcdH0gc2F0aXNmaWVzIFRleHROb2RlKTtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCB0ZXh0ID0gcmF3LnNsaWNlKGluZGV4LCBuZXh0TWFya2VyKTtcblx0XHRpbmxpbmUucHVzaCh7XG5cdFx0XHR0eXBlOiAndGV4dCcsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogc3RhcnRPZmZzZXQgKyBpbmRleCwgZW5kOiBzdGFydE9mZnNldCArIG5leHRNYXJrZXIgfSxcblx0XHRcdHRleHRcblx0XHR9IHNhdGlzZmllcyBUZXh0Tm9kZSk7XG5cdFx0aW5kZXggPSBuZXh0TWFya2VyO1xuXHR9XG5cblx0cmV0dXJuIGlubGluZTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGb3JtYXR0ZWROb2RlKHJhdzogc3RyaW5nLCBzdGFydE9mZnNldDogbnVtYmVyLCBpbmRleDogbnVtYmVyKSB7XG5cdGZvciAoY29uc3QgbWFya2VyIG9mIFsnYCcsICcqKionLCAnKionLCAnKiddIGFzIGNvbnN0KSB7XG5cdFx0aWYgKCFyYXcuc3RhcnRzV2l0aChtYXJrZXIsIGluZGV4KSkgY29udGludWU7XG5cblx0XHRjb25zdCBjbG9zZSA9IHJhdy5pbmRleE9mKG1hcmtlciwgaW5kZXggKyBtYXJrZXIubGVuZ3RoKTtcblx0XHRpZiAoY2xvc2UgPT09IC0xKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNvbnRlbnRTdGFydCA9IGluZGV4ICsgbWFya2VyLmxlbmd0aDtcblx0XHRjb25zdCBjb250ZW50RW5kID0gY2xvc2U7XG5cdFx0aWYgKGNvbnRlbnRTdGFydCA+PSBjb250ZW50RW5kKSBjb250aW51ZTtcblx0XHRpZiAobWFya2VyICE9PSAnYCcgJiYgKHJhd1tjb250ZW50U3RhcnRdID09PSAnICcgfHwgcmF3W2NvbnRlbnRFbmQgLSAxXSA9PT0gJyAnKSkgY29udGludWU7XG5cblx0XHRjb25zdCB0eXBlID1cblx0XHRcdG1hcmtlciA9PT0gJ2AnXG5cdFx0XHRcdD8gJ2NvZGUnXG5cdFx0XHRcdDogbWFya2VyID09PSAnKioqJ1xuXHRcdFx0XHRcdD8gJ3N0cm9uZ19lbXBoYXNpcydcblx0XHRcdFx0XHQ6IG1hcmtlciA9PT0gJyoqJ1xuXHRcdFx0XHRcdFx0PyAnc3Ryb25nJ1xuXHRcdFx0XHRcdFx0OiAnZW1waGFzaXMnO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdG5vZGU6IHtcblx0XHRcdFx0dHlwZSxcblx0XHRcdFx0cmFuZ2U6IHtcblx0XHRcdFx0XHRzdGFydDogc3RhcnRPZmZzZXQgKyBpbmRleCxcblx0XHRcdFx0XHRlbmQ6IHN0YXJ0T2Zmc2V0ICsgY2xvc2UgKyBtYXJrZXIubGVuZ3RoXG5cdFx0XHRcdH0sXG5cdFx0XHRcdGNvbnRlbnRSYW5nZToge1xuXHRcdFx0XHRcdHN0YXJ0OiBzdGFydE9mZnNldCArIGNvbnRlbnRTdGFydCxcblx0XHRcdFx0XHRlbmQ6IHN0YXJ0T2Zmc2V0ICsgY29udGVudEVuZFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRtYXJrZXIsXG5cdFx0XHRcdHRleHQ6IHJhdy5zbGljZShjb250ZW50U3RhcnQsIGNvbnRlbnRFbmQpXG5cdFx0XHR9IHNhdGlzZmllcyBGb3JtYXR0ZWROb2RlLFxuXHRcdFx0bmV4dEluZGV4OiBjbG9zZSArIG1hcmtlci5sZW5ndGhcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVkaXRvcklubGluZShpbmxpbmU6IElubGluZU5vZGVbXSk6IHN0cmluZyB7XG5cdHJldHVybiBpbmxpbmVcblx0XHQubWFwKChub2RlKSA9PiB7XG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAndGV4dCcpIHtcblx0XHRcdFx0cmV0dXJuIHJlbmRlckVkaXRvclRleHQobm9kZS50ZXh0KTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgY29udGVudCA9IGVzY2FwZUh0bWwobm9kZS50ZXh0KTtcblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2NvZGUnKSB7XG5cdFx0XHRcdGNvbnN0IG1hcmtlciA9IGA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXIgY29kZS1tYXJrZXJcIj4ke2VzY2FwZUh0bWwobm9kZS5tYXJrZXIpfTwvc3Bhbj5gO1xuXHRcdFx0XHRyZXR1cm4gYDxjb2RlIGNsYXNzPVwiaW5saW5lLWNvZGVcIj4ke21hcmtlcn0ke2NvbnRlbnR9JHttYXJrZXJ9PC9jb2RlPmA7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG1hcmtlciA9IGA8c3BhbiBjbGFzcz1cInN5bnRheC1tYXJrZXJcIj4ke2VzY2FwZUh0bWwobm9kZS5tYXJrZXIpfTwvc3Bhbj5gO1xuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnZW1waGFzaXMnKSB7XG5cdFx0XHRcdHJldHVybiBgJHttYXJrZXJ9PGVtPiR7Y29udGVudH08L2VtPiR7bWFya2VyfWA7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChub2RlLnR5cGUgPT09ICdzdHJvbmcnKSB7XG5cdFx0XHRcdHJldHVybiBgJHttYXJrZXJ9PHN0cm9uZz4ke2NvbnRlbnR9PC9zdHJvbmc+JHttYXJrZXJ9YDtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGAke21hcmtlcn08c3Ryb25nPjxlbT4ke2NvbnRlbnR9PC9lbT48L3N0cm9uZz4ke21hcmtlcn1gO1xuXHRcdH0pXG5cdFx0LmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJCbG9ja1NlbGVjdGlvbihcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRibG9jazogQmxvY2tOb2RlLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKGVuZCA8PSBibG9jay5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBibG9jay5yYW5nZS5lbmQpIHJldHVybiAnJztcblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ3BhcmFncmFwaCcpIHtcblx0XHRyZXR1cm4gYDxwPiR7cmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgYmxvY2suaW5saW5lLCBzdGFydCwgZW5kKSB8fCAnPGJyPid9PC9wPmA7XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0Y29uc3QgdGFnID0gYGgke2Jsb2NrLmxldmVsfWA7XG5cdFx0cmV0dXJuIGA8JHt0YWd9PiR7cmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oc291cmNlVGV4dCwgYmxvY2suaW5saW5lLCBzdGFydCwgZW5kKSB8fCAnPGJyPid9PC8ke3RhZ30+YDtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnY29kZV9ibG9jaycpIHtcblx0XHRjb25zdCBjb2RlUGFydHM6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLmxpbmVzKSB7XG5cdFx0XHRpZiAoZW5kIDw9IGxpbmUucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gbGluZS5yYW5nZS5lbmQpIGNvbnRpbnVlO1xuXHRcdFx0Y29kZVBhcnRzLnB1c2goZXNjYXBlSHRtbEZvckNsaXBib2FyZChzbGljZVJhbmdlKHNvdXJjZVRleHQsIGxpbmUucmFuZ2UsIHN0YXJ0LCBlbmQpKSk7XG5cdFx0fVxuXHRcdHJldHVybiBgPHByZT48Y29kZT4ke2NvZGVQYXJ0cy5qb2luKCdcXG4nKX08L2NvZGU+PC9wcmU+YDtcblx0fVxuXG5cdGNvbnN0IHRhZyA9IGJsb2NrLm9yZGVyZWQgPyAnb2wnIDogJ3VsJztcblx0Y29uc3QgaXRlbXMgPSBibG9jay5pdGVtc1xuXHRcdC5tYXAoKGl0ZW0pID0+IHJlbmRlckxpc3RJdGVtU2VsZWN0aW9uKHNvdXJjZVRleHQsIGl0ZW0sIHN0YXJ0LCBlbmQpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbilcblx0XHQuam9pbignJyk7XG5cdHJldHVybiBpdGVtcyA/IGA8JHt0YWd9PiR7aXRlbXN9PC8ke3RhZ30+YCA6ICcnO1xufVxuXG5mdW5jdGlvbiByZW5kZXJMaXN0SXRlbVNlbGVjdGlvbihcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRpdGVtOiBMaXN0SXRlbUJsb2NrLFxuXHRzdGFydDogbnVtYmVyLFxuXHRlbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0aWYgKGVuZCA8PSBpdGVtLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGl0ZW0ucmFuZ2UuZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IGl0ZW1JbmxpbmUgPSByZW5kZXJTZW1hbnRpY0lubGluZVNlbGVjdGlvbihzb3VyY2VUZXh0LCBpdGVtLmlubGluZSwgc3RhcnQsIGVuZCk7XG5cdHBhcnRzLnB1c2goaXRlbUlubGluZSB8fCAnPGJyPicpO1xuXG5cdGZvciAoY29uc3QgY2hpbGQgb2YgaXRlbS5jaGlsZHJlbikge1xuXHRcdGNvbnN0IGNoaWxkSHRtbCA9IHJlbmRlckJsb2NrU2VsZWN0aW9uKHNvdXJjZVRleHQsIGNoaWxkLCBzdGFydCwgZW5kKTtcblx0XHRpZiAoY2hpbGRIdG1sKSBwYXJ0cy5wdXNoKGNoaWxkSHRtbCk7XG5cdH1cblxuXHRyZXR1cm4gYDxsaT4ke3BhcnRzLmpvaW4oJycpfTwvbGk+YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyU2VtYW50aWNJbmxpbmVTZWxlY3Rpb24oXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0aW5saW5lOiBJbmxpbmVOb2RlW10sXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRpZiAoc3RhcnQgPj0gZW5kKSByZXR1cm4gJyc7XG5cblx0Y29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG5cblx0Zm9yIChjb25zdCBub2RlIG9mIGlubGluZSkge1xuXHRcdGlmIChub2RlLnR5cGUgPT09ICd0ZXh0Jykge1xuXHRcdFx0Y29uc3Qgc2xpY2UgPSBzbGljZVJhbmdlKHNvdXJjZVRleHQsIG5vZGUucmFuZ2UsIHN0YXJ0LCBlbmQpO1xuXHRcdFx0aWYgKHNsaWNlKSBwYXJ0cy5wdXNoKGVzY2FwZUh0bWxGb3JDbGlwYm9hcmQoc2xpY2UpKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IGlubmVyU2xpY2UgPSBzbGljZVJhbmdlKHNvdXJjZVRleHQsIG5vZGUuY29udGVudFJhbmdlLCBzdGFydCwgZW5kKTtcblx0XHRpZiAoIWlubmVyU2xpY2UpIGNvbnRpbnVlO1xuXG5cdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2VtcGhhc2lzJykge1xuXHRcdFx0cGFydHMucHVzaChgPGVtPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2VtPmApO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3N0cm9uZycpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxzdHJvbmc+JHtlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKGlubmVyU2xpY2UpfTwvc3Ryb25nPmApO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKG5vZGUudHlwZSA9PT0gJ2NvZGUnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8Y29kZT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9jb2RlPmApO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0cGFydHMucHVzaChgPHN0cm9uZz48ZW0+JHtlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKGlubmVyU2xpY2UpfTwvZW0+PC9zdHJvbmc+YCk7XG5cdH1cblxuXHRyZXR1cm4gcGFydHMuam9pbignJyk7XG59XG5cbmZ1bmN0aW9uIHNsaWNlUmFuZ2UoXG5cdHNvdXJjZVRleHQ6IHN0cmluZyxcblx0cmFuZ2U6IFNvdXJjZVJhbmdlLFxuXHRzZWxlY3Rpb25TdGFydDogbnVtYmVyLFxuXHRzZWxlY3Rpb25FbmQ6IG51bWJlclxuKTogc3RyaW5nIHtcblx0Y29uc3Qgc3RhcnQgPSBNYXRoLm1heChyYW5nZS5zdGFydCwgc2VsZWN0aW9uU3RhcnQpO1xuXHRjb25zdCBlbmQgPSBNYXRoLm1pbihyYW5nZS5lbmQsIHNlbGVjdGlvbkVuZCk7XG5cdGlmIChzdGFydCA+PSBlbmQpIHJldHVybiAnJztcblx0cmV0dXJuIHNvdXJjZVRleHQuc2xpY2Uoc3RhcnQsIGVuZCk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVkaXRvclRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRleHQubGVuZ3RoID09PSAwID8gJycgOiBlc2NhcGVIdG1sKHRleHQpO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0LnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbEZvckNsaXBib2FyZCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gZXNjYXBlSHRtbCh0ZXh0KS5yZXBsYWNlKC8gL2csICcmbmJzcDsnKS5yZXBsYWNlKC9cXHQvZywgJyZuYnNwOyZuYnNwOyZuYnNwOyZuYnNwOycpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgQmxvY2tOb2RlLCBMaXN0QmxvY2sgfSBmcm9tICcuL2FzdCc7XG5pbXBvcnQgeyBidWlsZERvY3VtZW50IH0gZnJvbSAnLi9wYXJzZXInO1xuaW1wb3J0IHR5cGUgeyBTZWxlY3Rpb25SYW5nZSwgVGV4dENoYW5nZSB9IGZyb20gJy4vdGV4dCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGlzdE1ldGFkYXRhIHtcblx0bGlzdExldmVsOiBudW1iZXI7XG5cdG9yZGVyZWQ6IGJvb2xlYW47XG5cdGxpc3ROdW1iZXI6IG51bWJlcjtcblx0cHJlZml4OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBUZXh0UmVwbGFjZW1lbnQge1xuXHRzdGFydDogbnVtYmVyO1xuXHRlbmQ6IG51bWJlcjtcblx0dGV4dDogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGlzdE1ldGFkYXRhKGxpbmVUZXh0OiBzdHJpbmcpOiBMaXN0TWV0YWRhdGEge1xuXHRjb25zdCB1bm9yZGVyZWRNYXRjaCA9IGxpbmVUZXh0Lm1hdGNoKC9eKCg/OiB7NH0pKiktIC8pO1xuXHRpZiAodW5vcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0bGlzdExldmVsOiB1bm9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdG9yZGVyZWQ6IGZhbHNlLFxuXHRcdFx0bGlzdE51bWJlcjogMCxcblx0XHRcdHByZWZpeDogdW5vcmRlcmVkTWF0Y2hbMF1cblx0XHR9O1xuXHR9XG5cblx0Y29uc3Qgb3JkZXJlZE1hdGNoID0gbGluZVRleHQubWF0Y2goL14oKD86IHs0fSkqKShcXGQrKVxcLiAvKTtcblx0aWYgKG9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRsaXN0TGV2ZWw6IG9yZGVyZWRNYXRjaFsxXS5sZW5ndGggLyA0ICsgMSxcblx0XHRcdG9yZGVyZWQ6IHRydWUsXG5cdFx0XHRsaXN0TnVtYmVyOiBOdW1iZXIucGFyc2VJbnQob3JkZXJlZE1hdGNoWzJdLCAxMCksXG5cdFx0XHRwcmVmaXg6IG9yZGVyZWRNYXRjaFswXVxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGxpc3RMZXZlbDogMCxcblx0XHRvcmRlcmVkOiBmYWxzZSxcblx0XHRsaXN0TnVtYmVyOiAwLFxuXHRcdHByZWZpeDogJydcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyhcblx0dGV4dDogc3RyaW5nLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZVxuKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IGRvY3VtZW50ID0gYnVpbGREb2N1bWVudCh0ZXh0KTtcblx0Y29uc3QgcmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXSA9IFtdO1xuXG5cdGNvbGxlY3RPcmRlcmVkTGlzdFJlcGxhY2VtZW50cyhkb2N1bWVudC5ibG9ja3MsIGFmZmVjdGVkUmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cblx0aWYgKHJlcGxhY2VtZW50cy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IHNlbGVjdGlvbi5lbmRcblx0XHR9O1xuXHR9XG5cblx0cmVwbGFjZW1lbnRzLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiByaWdodC5zdGFydCAtIGxlZnQuc3RhcnQpO1xuXG5cdGxldCBuZXh0VGV4dCA9IHRleHQ7XG5cdGxldCBzZWxlY3Rpb25TdGFydCA9IHNlbGVjdGlvbi5zdGFydDtcblx0bGV0IHNlbGVjdGlvbkVuZCA9IHNlbGVjdGlvbi5lbmQ7XG5cblx0Zm9yIChjb25zdCByZXBsYWNlbWVudCBvZiByZXBsYWNlbWVudHMpIHtcblx0XHRjb25zdCByZXBsYWNlZExlbmd0aCA9IHJlcGxhY2VtZW50LmVuZCAtIHJlcGxhY2VtZW50LnN0YXJ0O1xuXHRcdGNvbnN0IGRlbHRhID0gcmVwbGFjZW1lbnQudGV4dC5sZW5ndGggLSByZXBsYWNlZExlbmd0aDtcblx0XHRuZXh0VGV4dCA9XG5cdFx0XHRuZXh0VGV4dC5zbGljZSgwLCByZXBsYWNlbWVudC5zdGFydCkgKyByZXBsYWNlbWVudC50ZXh0ICsgbmV4dFRleHQuc2xpY2UocmVwbGFjZW1lbnQuZW5kKTtcblx0XHRzZWxlY3Rpb25TdGFydCA9IGFkanVzdFNlbGVjdGlvblBvaW50KFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5zdGFydCxcblx0XHRcdHJlcGxhY2VtZW50LmVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnRleHQubGVuZ3RoLFxuXHRcdFx0ZGVsdGFcblx0XHQpO1xuXHRcdHNlbGVjdGlvbkVuZCA9IGFkanVzdFNlbGVjdGlvblBvaW50KFxuXHRcdFx0c2VsZWN0aW9uRW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQuc3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5lbmQsXG5cdFx0XHRyZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCxcblx0XHRcdGRlbHRhXG5cdFx0KTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0dGV4dDogbmV4dFRleHQsXG5cdFx0c2VsZWN0aW9uU3RhcnQsXG5cdFx0c2VsZWN0aW9uRW5kXG5cdH07XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RPcmRlcmVkTGlzdFJlcGxhY2VtZW50cyhcblx0YmxvY2tzOiBCbG9ja05vZGVbXSxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W11cbik6IGJvb2xlYW4ge1xuXHRsZXQgZm91bmRBZmZlY3RlZEJsb2NrID0gZmFsc2U7XG5cblx0Zm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcblx0XHRsZXQgYmxvY2tBZmZlY3RlZCA9IHJhbmdlc0ludGVyc2VjdChibG9jay5yYW5nZSwgYWZmZWN0ZWRSYW5nZSk7XG5cblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gJ2xpc3QnKSB7XG5cdFx0XHRjb2xsZWN0TGlzdFJlcGxhY2VtZW50cyhibG9jaywgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblxuXHRcdFx0Zm9yIChjb25zdCBpdGVtIG9mIGJsb2NrLml0ZW1zKSB7XG5cdFx0XHRcdGNvbnN0IGNoaWxkcmVuQWZmZWN0ZWQgPSBjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoXG5cdFx0XHRcdFx0aXRlbS5jaGlsZHJlbixcblx0XHRcdFx0XHRhZmZlY3RlZFJhbmdlLFxuXHRcdFx0XHRcdHJlcGxhY2VtZW50c1xuXHRcdFx0XHQpO1xuXHRcdFx0XHRpZiAoY2hpbGRyZW5BZmZlY3RlZCkge1xuXHRcdFx0XHRcdG5vcm1hbGl6ZVNpYmxpbmdPcmRlcmVkQ2hpbGRMaXN0cyhpdGVtLmNoaWxkcmVuLCBhZmZlY3RlZFJhbmdlLCByZXBsYWNlbWVudHMpO1xuXHRcdFx0XHRcdGJsb2NrQWZmZWN0ZWQgPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKGJsb2NrQWZmZWN0ZWQpIHtcblx0XHRcdGZvdW5kQWZmZWN0ZWRCbG9jayA9IHRydWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGZvdW5kQWZmZWN0ZWRCbG9jaztcbn1cblxuZnVuY3Rpb24gY29sbGVjdExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrOiBMaXN0QmxvY2ssXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pIHtcblx0aWYgKCFibG9jay5vcmRlcmVkIHx8ICFyYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGJsb2NrLml0ZW1zLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IGl0ZW0gPSBibG9jay5pdGVtc1tpbmRleF0hO1xuXHRcdGNvbnN0IGV4cGVjdGVkTnVtYmVyID0gaW5kZXggKyAxO1xuXHRcdGlmIChpdGVtLm51bWJlciA9PT0gZXhwZWN0ZWROdW1iZXIpIGNvbnRpbnVlO1xuXG5cdFx0cmVwbGFjZW1lbnRzLnB1c2goe1xuXHRcdFx0c3RhcnQ6IGl0ZW0ubGluZVJhbmdlLnN0YXJ0LFxuXHRcdFx0ZW5kOiBpdGVtLmxpbmVSYW5nZS5zdGFydCArIGl0ZW0ucHJlZml4Lmxlbmd0aCxcblx0XHRcdHRleHQ6IGAkeycgICAgJy5yZXBlYXQoaXRlbS5sZXZlbCAtIDEpfSR7ZXhwZWN0ZWROdW1iZXJ9LiBgXG5cdFx0fSk7XG5cdH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2libGluZ09yZGVyZWRDaGlsZExpc3RzKFxuXHRibG9ja3M6IEJsb2NrTm9kZVtdLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0cmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXVxuKSB7XG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0aWYgKGJsb2NrLnR5cGUgIT09ICdsaXN0JyB8fCAhYmxvY2sub3JkZXJlZCB8fCByYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpKSB7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb2xsZWN0TGlzdFJlcGxhY2VtZW50cyhibG9jaywgYmxvY2sucmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cdH1cbn1cblxuZnVuY3Rpb24gcmFuZ2VzSW50ZXJzZWN0KGxlZnQ6IFNlbGVjdGlvblJhbmdlLCByaWdodDogU2VsZWN0aW9uUmFuZ2UpIHtcblx0cmV0dXJuIGxlZnQuc3RhcnQgPD0gcmlnaHQuZW5kICYmIHJpZ2h0LnN0YXJ0IDw9IGxlZnQuZW5kO1xufVxuXG5mdW5jdGlvbiBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0cG9pbnQ6IG51bWJlcixcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXIsXG5cdHJlcGxhY2VtZW50TGVuZ3RoOiBudW1iZXIsXG5cdGRlbHRhOiBudW1iZXJcbikge1xuXHRpZiAocG9pbnQgPiBlbmQpIHtcblx0XHRyZXR1cm4gcG9pbnQgKyBkZWx0YTtcblx0fVxuXG5cdGlmIChwb2ludCA+PSBzdGFydCkge1xuXHRcdHJldHVybiBzdGFydCArIE1hdGgubWluKHBvaW50IC0gc3RhcnQsIHJlcGxhY2VtZW50TGVuZ3RoKTtcblx0fVxuXG5cdHJldHVybiBwb2ludDtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFNlbGVjdGlvblJhbmdlIHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGV4dENoYW5nZSB7XG5cdHRleHQ6IHN0cmluZztcblx0c2VsZWN0aW9uU3RhcnQ6IG51bWJlcjtcblx0c2VsZWN0aW9uRW5kOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXBsYWNlUmFuZ2UoXG5cdHRleHQ6IHN0cmluZyxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSxcblx0aW5zZXJ0ZWRUZXh0OiBzdHJpbmdcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBuZXh0VGV4dCA9IHRleHQuc2xpY2UoMCwgc2VsZWN0aW9uLnN0YXJ0KSArIGluc2VydGVkVGV4dCArIHRleHQuc2xpY2Uoc2VsZWN0aW9uLmVuZCk7XG5cdGNvbnN0IGN1cnNvciA9IHNlbGVjdGlvbi5zdGFydCArIGluc2VydGVkVGV4dC5sZW5ndGg7XG5cdHJldHVybiB7XG5cdFx0dGV4dDogbmV4dFRleHQsXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IGN1cnNvcixcblx0XHRzZWxlY3Rpb25FbmQ6IGN1cnNvclxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlQmFja3dhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gcmVwbGFjZVJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJycpO1xuXHR9XG5cblx0aWYgKHNlbGVjdGlvbi5zdGFydCA9PT0gMCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IDAsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IDBcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHJlcGxhY2VSYW5nZShcblx0XHR0ZXh0LFxuXHRcdHtcblx0XHRcdHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQgLSAxLFxuXHRcdFx0ZW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fSxcblx0XHQnJ1xuXHQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVsZXRlRm9yd2FyZCh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiByZXBsYWNlUmFuZ2UodGV4dCwgc2VsZWN0aW9uLCAnJyk7XG5cdH1cblxuXHRpZiAoc2VsZWN0aW9uLmVuZCA+PSB0ZXh0Lmxlbmd0aCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHNlbGVjdGlvbi5zdGFydCxcblx0XHRcdHNlbGVjdGlvbkVuZDogc2VsZWN0aW9uLmVuZFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4gcmVwbGFjZVJhbmdlKFxuXHRcdHRleHQsXG5cdFx0e1xuXHRcdFx0c3RhcnQ6IHNlbGVjdGlvbi5zdGFydCxcblx0XHRcdGVuZDogc2VsZWN0aW9uLmVuZCArIDFcblx0XHR9LFxuXHRcdCcnXG5cdCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0OiBzdHJpbmcsIHBvc2l0aW9uOiBudW1iZXIpIHtcblx0Y29uc3QgYmVmb3JlID0gdGV4dC5zbGljZSgwLCBwb3NpdGlvbik7XG5cdGNvbnN0IGxpbmVTdGFydCA9IGJlZm9yZS5sYXN0SW5kZXhPZignXFxuJykgKyAxO1xuXHRjb25zdCBuZXh0TmV3bGluZSA9IHRleHQuaW5kZXhPZignXFxuJywgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lRW5kID0gbmV4dE5ld2xpbmUgPT09IC0xID8gdGV4dC5sZW5ndGggOiBuZXh0TmV3bGluZTtcblx0cmV0dXJuIHsgbGluZVN0YXJ0LCBsaW5lRW5kIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTZWxlY3RlZEJsb2NrQm91bmRzKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSkge1xuXHRjb25zdCBibG9ja1N0YXJ0ID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgc2VsZWN0aW9uLnN0YXJ0KS5saW5lU3RhcnQ7XG5cdGNvbnN0IGJsb2NrRW5kUG9zaXRpb24gPVxuXHRcdHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCAmJiBzZWxlY3Rpb24uZW5kID4gMCAmJiB0ZXh0W3NlbGVjdGlvbi5lbmQgLSAxXSA9PT0gJ1xcbidcblx0XHRcdD8gc2VsZWN0aW9uLmVuZCAtIDFcblx0XHRcdDogc2VsZWN0aW9uLmVuZDtcblx0Y29uc3QgYmxvY2tFbmQgPSBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0LCBibG9ja0VuZFBvc2l0aW9uKS5saW5lRW5kO1xuXHRyZXR1cm4geyBibG9ja1N0YXJ0LCBibG9ja0VuZCB9O1xufVxuIiwgImltcG9ydCB7IGdldExpc3RNZXRhZGF0YSwgbm9ybWFsaXplT3JkZXJlZExpc3ROdW1iZXJzIH0gZnJvbSAnLi9saXN0cyc7XG5pbXBvcnQge1xuXHRkZWxldGVCYWNrd2FyZCxcblx0ZGVsZXRlRm9yd2FyZCxcblx0Z2V0Q3VycmVudExpbmVCb3VuZHMsXG5cdGdldFNlbGVjdGVkQmxvY2tCb3VuZHMsXG5cdHR5cGUgU2VsZWN0aW9uUmFuZ2UsXG5cdHR5cGUgVGV4dENoYW5nZVxufSBmcm9tICcuL3RleHQnO1xuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlUYWJLZXkoXG5cdHRleHQ6IHN0cmluZyxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSxcblx0c2hpZnRLZXk6IGJvb2xlYW5cbik6IFRleHRDaGFuZ2Uge1xuXHRpZiAoc2VsZWN0aW9uLnN0YXJ0ICE9PSBzZWxlY3Rpb24uZW5kKSB7XG5cdFx0cmV0dXJuIGFwcGx5VGFiVG9TZWxlY3Rpb24odGV4dCwgc2VsZWN0aW9uLCBzaGlmdEtleSk7XG5cdH1cblxuXHRyZXR1cm4gYXBwbHlUYWJUb0xpbmUodGV4dCwgc2VsZWN0aW9uLnN0YXJ0LCBzaGlmdEtleSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUVudGVyS2V5KHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCB7IHN0YXJ0LCBlbmQgfSA9IHNlbGVjdGlvbjtcblx0Y29uc3QgeyBsaW5lU3RhcnQsIGxpbmVFbmQgfSA9IGdldEN1cnJlbnRMaW5lQm91bmRzKHRleHQsIHN0YXJ0KTtcblx0Y29uc3QgbGluZVRleHQgPSB0ZXh0LnNsaWNlKGxpbmVTdGFydCwgbGluZUVuZCk7XG5cdGNvbnN0IG1ldGFkYXRhID0gZ2V0TGlzdE1ldGFkYXRhKGxpbmVUZXh0KTtcblxuXHRpZiAobWV0YWRhdGEubGlzdExldmVsID09PSAwKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQ6IHRleHQuc2xpY2UoMCwgc3RhcnQpICsgJ1xcbicgKyB0ZXh0LnNsaWNlKGVuZCksXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogc3RhcnQgKyAxLFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBzdGFydCArIDFcblx0XHR9O1xuXHR9XG5cblx0aWYgKG1ldGFkYXRhLm9yZGVyZWQgJiYgbGluZVRleHQudHJpbSgpLm1hdGNoKC9eXFxkK1xcLiQvKSkge1xuXHRcdGNvbnN0IG5leHRUZXh0ID0gdGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgdGV4dC5zbGljZShsaW5lRW5kKTtcblx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQobmV4dFRleHQsIGdldFNwbGl0TGlzdEFmZmVjdGVkUmFuZ2UobmV4dFRleHQsIGxpbmVTdGFydCksIHtcblx0XHRcdHN0YXJ0OiBsaW5lU3RhcnQsXG5cdFx0XHRlbmQ6IGxpbmVTdGFydFxuXHRcdH0pO1xuXHR9XG5cblx0aWYgKCFtZXRhZGF0YS5vcmRlcmVkICYmIGxpbmVUZXh0LnRyaW0oKSA9PT0gJy0nKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQ6IHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIHRleHQuc2xpY2UobGluZUVuZCksXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogbGluZVN0YXJ0LFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBsaW5lU3RhcnRcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgaW5kZW50ID0gJyAgICAnLnJlcGVhdChtZXRhZGF0YS5saXN0TGV2ZWwgLSAxKTtcblx0Y29uc3QgcHJlZml4ID0gbWV0YWRhdGEub3JkZXJlZCA/IGAke2luZGVudH0ke21ldGFkYXRhLmxpc3ROdW1iZXIgKyAxfS4gYCA6IGAke2luZGVudH0tIGA7XG5cdGNvbnN0IG5leHRTZWxlY3Rpb24gPSBzdGFydCArIDEgKyBwcmVmaXgubGVuZ3RoO1xuXG5cdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHR0ZXh0LnNsaWNlKDAsIHN0YXJ0KSArICdcXG4nICsgcHJlZml4ICsgdGV4dC5zbGljZShlbmQpLFxuXHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBuZXh0U2VsZWN0aW9uIH0sXG5cdFx0eyBzdGFydDogbmV4dFNlbGVjdGlvbiwgZW5kOiBuZXh0U2VsZWN0aW9uIH1cblx0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5RGVsZXRlQmFja3dhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IGNoYW5nZSA9IGRlbGV0ZUJhY2t3YXJkKHRleHQsIHNlbGVjdGlvbik7XG5cdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChjaGFuZ2UudGV4dCwgZ2V0RGVsZXRlQWZmZWN0ZWRSYW5nZSh0ZXh0LCBzZWxlY3Rpb24sICdiYWNrd2FyZCcpLCB7XG5cdFx0c3RhcnQ6IGNoYW5nZS5zZWxlY3Rpb25TdGFydCxcblx0XHRlbmQ6IGNoYW5nZS5zZWxlY3Rpb25FbmRcblx0fSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseURlbGV0ZUZvcndhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IGNoYW5nZSA9IGRlbGV0ZUZvcndhcmQodGV4dCwgc2VsZWN0aW9uKTtcblx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KGNoYW5nZS50ZXh0LCBnZXREZWxldGVBZmZlY3RlZFJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJ2ZvcndhcmQnKSwge1xuXHRcdHN0YXJ0OiBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsXG5cdFx0ZW5kOiBjaGFuZ2Uuc2VsZWN0aW9uRW5kXG5cdH0pO1xufVxuXG5mdW5jdGlvbiBhcHBseVRhYlRvU2VsZWN0aW9uKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdHNoaWZ0S2V5OiBib29sZWFuXG4pOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgeyBibG9ja1N0YXJ0LCBibG9ja0VuZCB9ID0gZ2V0U2VsZWN0ZWRCbG9ja0JvdW5kcyh0ZXh0LCBzZWxlY3Rpb24pO1xuXHRjb25zdCBibG9jayA9IHRleHQuc2xpY2UoYmxvY2tTdGFydCwgYmxvY2tFbmQpO1xuXHRjb25zdCBsaW5lcyA9IGJsb2NrLnNwbGl0KCdcXG4nKTtcblxuXHRjb25zdCBtb2RpZmllZCA9IGxpbmVzLm1hcCgobGluZSkgPT4ge1xuXHRcdGNvbnN0IG1ldGFkYXRhID0gZ2V0TGlzdE1ldGFkYXRhKGxpbmUpO1xuXHRcdGlmIChzaGlmdEtleSkge1xuXHRcdFx0aWYgKGxpbmUuc3RhcnRzV2l0aCgnICAgICcpKSByZXR1cm4gbGluZS5zbGljZSg0KTtcblx0XHRcdGlmIChtZXRhZGF0YS5saXN0TGV2ZWwgPT09IDEpIHJldHVybiBsaW5lLnJlcGxhY2UoL14tIC8sICcnKS5yZXBsYWNlKC9eXFxkK1xcLiAvLCAnJyk7XG5cdFx0XHRyZXR1cm4gbGluZTtcblx0XHR9XG5cblx0XHRyZXR1cm4gYCAgICAke2xpbmV9YDtcblx0fSk7XG5cblx0Y29uc3QgbmV4dEJsb2NrID0gbW9kaWZpZWQuam9pbignXFxuJyk7XG5cdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHR0ZXh0LnNsaWNlKDAsIGJsb2NrU3RhcnQpICsgbmV4dEJsb2NrICsgdGV4dC5zbGljZShibG9ja0VuZCksXG5cdFx0eyBzdGFydDogYmxvY2tTdGFydCwgZW5kOiBibG9ja1N0YXJ0ICsgbmV4dEJsb2NrLmxlbmd0aCB9LFxuXHRcdHsgc3RhcnQ6IGJsb2NrU3RhcnQsIGVuZDogYmxvY2tTdGFydCArIG5leHRCbG9jay5sZW5ndGggfVxuXHQpO1xufVxuXG5mdW5jdGlvbiBhcHBseVRhYlRvTGluZSh0ZXh0OiBzdHJpbmcsIHBvc2l0aW9uOiBudW1iZXIsIHNoaWZ0S2V5OiBib29sZWFuKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IHsgbGluZVN0YXJ0LCBsaW5lRW5kIH0gPSBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0LCBwb3NpdGlvbik7XG5cdGNvbnN0IGxpbmVUZXh0ID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuXHRjb25zdCBtZXRhZGF0YSA9IGdldExpc3RNZXRhZGF0YShsaW5lVGV4dCk7XG5cblx0aWYgKHNoaWZ0S2V5KSB7XG5cdFx0aWYgKGxpbmVUZXh0LnN0YXJ0c1dpdGgoJyAgICAnKSkge1xuXHRcdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0XHR0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyBsaW5lVGV4dC5zbGljZSg0KSArIHRleHQuc2xpY2UobGluZUVuZCksXG5cdFx0XHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBsaW5lRW5kIC0gNCB9LFxuXHRcdFx0XHR7IHN0YXJ0OiBwb3NpdGlvbiAtIDQsIGVuZDogcG9zaXRpb24gLSA0IH1cblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA9PT0gMSkge1xuXHRcdFx0Y29uc3QgdXBkYXRlZExpbmUgPSBsaW5lVGV4dC5yZXBsYWNlKC9eLSAvLCAnJykucmVwbGFjZSgvXlxcZCtcXC4gLywgJycpO1xuXHRcdFx0Y29uc3QgbmV4dFNlbGVjdGlvbiA9IE1hdGgubWF4KGxpbmVTdGFydCwgcG9zaXRpb24gLSBtZXRhZGF0YS5wcmVmaXgubGVuZ3RoKTtcblx0XHRcdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHRcdFx0dGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgdXBkYXRlZExpbmUgKyB0ZXh0LnNsaWNlKGxpbmVFbmQpLFxuXHRcdFx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbGluZVN0YXJ0ICsgdXBkYXRlZExpbmUubGVuZ3RoIH0sXG5cdFx0XHRcdHsgc3RhcnQ6IG5leHRTZWxlY3Rpb24sIGVuZDogbmV4dFNlbGVjdGlvbiB9XG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0LFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHBvc2l0aW9uLFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBwb3NpdGlvblxuXHRcdH07XG5cdH1cblxuXHRpZiAobWV0YWRhdGEubGlzdExldmVsID4gMCkge1xuXHRcdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHRcdHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArICcgICAgJyArIHRleHQuc2xpY2UobGluZVN0YXJ0KSxcblx0XHRcdHsgc3RhcnQ6IGxpbmVTdGFydCwgZW5kOiBsaW5lRW5kICsgNCB9LFxuXHRcdFx0eyBzdGFydDogcG9zaXRpb24gKyA0LCBlbmQ6IHBvc2l0aW9uICsgNCB9XG5cdFx0KTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0dGV4dDogdGV4dC5zbGljZSgwLCBwb3NpdGlvbikgKyAnICAgICcgKyB0ZXh0LnNsaWNlKHBvc2l0aW9uKSxcblx0XHRzZWxlY3Rpb25TdGFydDogcG9zaXRpb24gKyA0LFxuXHRcdHNlbGVjdGlvbkVuZDogcG9zaXRpb24gKyA0XG5cdH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUxpc3RFZGl0KHRleHQ6IHN0cmluZywgYWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpIHtcblx0cmV0dXJuIG5vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyh0ZXh0LCBhZmZlY3RlZFJhbmdlLCBzZWxlY3Rpb24pO1xufVxuXG5mdW5jdGlvbiBnZXREZWxldGVBZmZlY3RlZFJhbmdlKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdGRpcmVjdGlvbjogJ2JhY2t3YXJkJyB8ICdmb3J3YXJkJ1xuKTogU2VsZWN0aW9uUmFuZ2Uge1xuXHRpZiAoc2VsZWN0aW9uLnN0YXJ0ICE9PSBzZWxlY3Rpb24uZW5kKSB7XG5cdFx0cmV0dXJuIHNlbGVjdGlvbjtcblx0fVxuXG5cdGlmIChkaXJlY3Rpb24gPT09ICdiYWNrd2FyZCcpIHtcblx0XHRjb25zdCBzdGFydCA9IE1hdGgubWF4KDAsIHNlbGVjdGlvbi5zdGFydCAtIDEpO1xuXHRcdHJldHVybiB7IHN0YXJ0LCBlbmQ6IHNlbGVjdGlvbi5zdGFydCB9O1xuXHR9XG5cblx0Y29uc3QgZW5kID0gTWF0aC5taW4odGV4dC5sZW5ndGgsIHNlbGVjdGlvbi5lbmQgKyAxKTtcblx0cmV0dXJuIHsgc3RhcnQ6IHNlbGVjdGlvbi5zdGFydCwgZW5kIH07XG59XG5cbmZ1bmN0aW9uIGdldFNwbGl0TGlzdEFmZmVjdGVkUmFuZ2UodGV4dDogc3RyaW5nLCBib3VuZGFyeTogbnVtYmVyKTogU2VsZWN0aW9uUmFuZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdHN0YXJ0OiBNYXRoLm1heCgwLCBib3VuZGFyeSAtIDEpLFxuXHRcdGVuZDogTWF0aC5taW4odGV4dC5sZW5ndGgsIGJvdW5kYXJ5ICsgMSlcblx0fTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZOzs7QUMwRFosU0FBUyxjQUFjLFNBQWlDO0FBQzlELFFBQU0sT0FBTyxjQUFjLE9BQU87QUFDbEMsUUFBTSxXQUFXLGNBQWMsSUFBSTtBQUNuQyxRQUFNLFNBQVMsWUFBWSxRQUFRO0FBQ25DLFFBQU0sUUFBUSxZQUFZLE1BQU07QUFDaEMsU0FBTyxFQUFFLE1BQU0sUUFBUSxN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
