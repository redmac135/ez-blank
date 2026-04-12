// tests/selection.test.ts
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

// src/lib/editor/selection.ts
function getEditorContainerOffset(documentModel, childOffset) {
  if (childOffset <= 0 || documentModel.lines.length === 0) {
    return 0;
  }
  if (childOffset >= documentModel.lines.length) {
    return documentModel.text.length;
  }
  return documentModel.lines[childOffset]?.range.start ?? documentModel.text.length;
}

// src/lib/editor/lists.ts
function normalizeOrderedListNumbers(text, affectedRange, selection) {
  const document2 = buildDocument(text);
  const replacements = [];
  collectOrderedListReplacements(document2.blocks, affectedRange, replacements);
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

// src/lib/editor/commands.ts
function applyDeleteBackward(text, selection) {
  const change = deleteBackward(text, selection);
  return normalizeListEdit(change.text, getDeleteAffectedRange(text, selection, "backward"), {
    start: change.selectionStart,
    end: change.selectionEnd
  });
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

// tests/selection.test.ts
test("getEditorContainerOffset maps editor child boundaries to text offsets", () => {
  const document2 = buildDocument("```js\nconst x = 1;\n```");
  assert.equal(getEditorContainerOffset(document2, 0), 0);
  assert.equal(getEditorContainerOffset(document2, 1), document2.lines[1]?.range.start);
  assert.equal(getEditorContainerOffset(document2, 2), document2.lines[2]?.range.start);
  assert.equal(getEditorContainerOffset(document2, 3), document2.text.length);
});
test("getEditorContainerOffset preserves boundaries around empty lines", () => {
  const document2 = buildDocument("```\n\n```");
  assert.equal(getEditorContainerOffset(document2, 1), document2.lines[1]?.range.start);
  assert.equal(getEditorContainerOffset(document2, 2), document2.lines[2]?.range.start);
});
test("deleting backward from the start of a pasted line removes the line break in one step", () => {
  const document2 = buildDocument("alpha\r\nbeta");
  const cursor = document2.lines[1]?.range.start ?? 0;
  const change = applyDeleteBackward(document2.text, { start: cursor, end: cursor });
  assert.equal(change.text, "alphabeta");
  assert.equal(change.selectionStart, "alpha".length);
  assert.equal(change.selectionEnd, change.selectionStart);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvc2VsZWN0aW9uLnRlc3QudHMiLCAiLi4vc3JjL2xpYi9lZGl0b3IvcGFyc2VyLnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL3NlbGVjdGlvbi50cyIsICIuLi9zcmMvbGliL2VkaXRvci9saXN0cy50cyIsICIuLi9zcmMvbGliL2VkaXRvci90ZXh0LnRzIiwgIi4uL3NyYy9saWIvZWRpdG9yL2NvbW1hbmRzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL3BhcnNlci50cyc7XG5pbXBvcnQgeyBnZXRFZGl0b3JDb250YWluZXJPZmZzZXQgfSBmcm9tICcuLi9zcmMvbGliL2VkaXRvci9zZWxlY3Rpb24udHMnO1xuaW1wb3J0IHsgYXBwbHlEZWxldGVCYWNrd2FyZCB9IGZyb20gJy4uL3NyYy9saWIvZWRpdG9yL2NvbW1hbmRzLnRzJztcblxudGVzdCgnZ2V0RWRpdG9yQ29udGFpbmVyT2Zmc2V0IG1hcHMgZWRpdG9yIGNoaWxkIGJvdW5kYXJpZXMgdG8gdGV4dCBvZmZzZXRzJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2BgYGpzXFxuY29uc3QgeCA9IDE7XFxuYGBgJyk7XG5cblx0YXNzZXJ0LmVxdWFsKGdldEVkaXRvckNvbnRhaW5lck9mZnNldChkb2N1bWVudCwgMCksIDApO1xuXHRhc3NlcnQuZXF1YWwoZ2V0RWRpdG9yQ29udGFpbmVyT2Zmc2V0KGRvY3VtZW50LCAxKSwgZG9jdW1lbnQubGluZXNbMV0/LnJhbmdlLnN0YXJ0KTtcblx0YXNzZXJ0LmVxdWFsKGdldEVkaXRvckNvbnRhaW5lck9mZnNldChkb2N1bWVudCwgMiksIGRvY3VtZW50LmxpbmVzWzJdPy5yYW5nZS5zdGFydCk7XG5cdGFzc2VydC5lcXVhbChnZXRFZGl0b3JDb250YWluZXJPZmZzZXQoZG9jdW1lbnQsIDMpLCBkb2N1bWVudC50ZXh0Lmxlbmd0aCk7XG59KTtcblxudGVzdCgnZ2V0RWRpdG9yQ29udGFpbmVyT2Zmc2V0IHByZXNlcnZlcyBib3VuZGFyaWVzIGFyb3VuZCBlbXB0eSBsaW5lcycsICgpID0+IHtcblx0Y29uc3QgZG9jdW1lbnQgPSBidWlsZERvY3VtZW50KCdgYGBcXG5cXG5gYGAnKTtcblxuXHRhc3NlcnQuZXF1YWwoZ2V0RWRpdG9yQ29udGFpbmVyT2Zmc2V0KGRvY3VtZW50LCAxKSwgZG9jdW1lbnQubGluZXNbMV0/LnJhbmdlLnN0YXJ0KTtcblx0YXNzZXJ0LmVxdWFsKGdldEVkaXRvckNvbnRhaW5lck9mZnNldChkb2N1bWVudCwgMiksIGRvY3VtZW50LmxpbmVzWzJdPy5yYW5nZS5zdGFydCk7XG59KTtcblxudGVzdCgnZGVsZXRpbmcgYmFja3dhcmQgZnJvbSB0aGUgc3RhcnQgb2YgYSBwYXN0ZWQgbGluZSByZW1vdmVzIHRoZSBsaW5lIGJyZWFrIGluIG9uZSBzdGVwJywgKCkgPT4ge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQoJ2FscGhhXFxyXFxuYmV0YScpO1xuXHRjb25zdCBjdXJzb3IgPSBkb2N1bWVudC5saW5lc1sxXT8ucmFuZ2Uuc3RhcnQgPz8gMDtcblxuXHRjb25zdCBjaGFuZ2UgPSBhcHBseURlbGV0ZUJhY2t3YXJkKGRvY3VtZW50LnRleHQsIHsgc3RhcnQ6IGN1cnNvciwgZW5kOiBjdXJzb3IgfSk7XG5cblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS50ZXh0LCAnYWxwaGFiZXRhJyk7XG5cdGFzc2VydC5lcXVhbChjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsICdhbHBoYScubGVuZ3RoKTtcblx0YXNzZXJ0LmVxdWFsKGNoYW5nZS5zZWxlY3Rpb25FbmQsIGNoYW5nZS5zZWxlY3Rpb25TdGFydCk7XG59KTtcbiIsICJpbXBvcnQgdHlwZSB7XG5cdEJsb2NrTm9kZSxcblx0Q29kZUJsb2NrLFxuXHRGb3JtYXR0ZWROb2RlLFxuXHRIZWFkaW5nQmxvY2ssXG5cdElubGluZU5vZGUsXG5cdExpc3RCbG9jayxcblx0TGlzdEl0ZW1CbG9jayxcblx0UGFyYWdyYXBoQmxvY2ssXG5cdFNvdXJjZVJhbmdlLFxuXHRUZXh0Tm9kZVxufSBmcm9tICcuL2FzdCc7XG5cbmV4cG9ydCB0eXBlIExpbmVLaW5kID1cblx0fCAncGFyYWdyYXBoJ1xuXHR8ICdoZWFkaW5nJ1xuXHR8ICd1bm9yZGVyZWRfbGlzdF9pdGVtJ1xuXHR8ICdvcmRlcmVkX2xpc3RfaXRlbSdcblx0fCAnY29kZV9mZW5jZSdcblx0fCAnY29kZV9jb250ZW50JztcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0b3JMaW5lIHtcblx0aWQ6IHN0cmluZztcblx0aW5kZXg6IG51bWJlcjtcblx0cmF3OiBzdHJpbmc7XG5cdHJhbmdlOiBTb3VyY2VSYW5nZTtcblx0a2luZDogTGluZUtpbmQ7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdGhlYWRpbmdMZXZlbDogbnVtYmVyO1xuXHRwcmVmaXg6IHN0cmluZztcblx0cHJlZml4UmFuZ2U6IFNvdXJjZVJhbmdlIHwgbnVsbDtcblx0Y29udGVudFJhbmdlOiBTb3VyY2VSYW5nZTtcblx0aW5saW5lOiBJbmxpbmVOb2RlW107XG5cdGNvZGVCbG9ja0xhbmd1YWdlOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVkaXRvckRvY3VtZW50IHtcblx0dGV4dDogc3RyaW5nO1xuXHRibG9ja3M6IEJsb2NrTm9kZVtdO1xuXHRsaW5lczogRWRpdG9yTGluZVtdO1xufVxuXG5pbnRlcmZhY2UgUmF3TGluZSB7XG5cdGluZGV4OiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBMaW5lUHJlZml4SW5mbyB7XG5cdGtpbmQ6ICdwYXJhZ3JhcGgnIHwgJ2hlYWRpbmcnIHwgJ3Vub3JkZXJlZF9saXN0X2l0ZW0nIHwgJ29yZGVyZWRfbGlzdF9pdGVtJyB8ICdjb2RlX2ZlbmNlJztcblx0bGlzdExldmVsOiBudW1iZXI7XG5cdGxpc3ROdW1iZXI6IG51bWJlcjtcblx0aGVhZGluZ0xldmVsOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xuXHRsYW5ndWFnZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRG9jdW1lbnQocmF3VGV4dDogc3RyaW5nKTogRWRpdG9yRG9jdW1lbnQge1xuXHRjb25zdCB0ZXh0ID0gbm9ybWFsaXplVGV4dChyYXdUZXh0KTtcblx0Y29uc3QgcmF3TGluZXMgPSBidWlsZFJhd0xpbmVzKHRleHQpO1xuXHRjb25zdCBibG9ja3MgPSBwYXJzZUJsb2NrcyhyYXdMaW5lcyk7XG5cdGNvbnN0IGxpbmVzID0gZGVyaXZlTGluZXMoYmxvY2tzKTtcblx0cmV0dXJuIHsgdGV4dCwgYmxvY2tzLCBsaW5lcyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplVGV4dChyYXdUZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gcmF3VGV4dC5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckVkaXRvckxpbmUobGluZTogRWRpdG9yTGluZSk6IHN0cmluZyB7XG5cdGNvbnN0IHByZWZpeCA9IGxpbmUucHJlZml4UmFuZ2UgPyByZW5kZXJFZGl0b3JUZXh0KGxpbmUucHJlZml4KSA6ICcnO1xuXHRjb25zdCBjb250ZW50ID0gbGluZS5raW5kLnN0YXJ0c1dpdGgoJ2NvZGVfJylcblx0XHQ/IHJlbmRlckVkaXRvclRleHQobGluZS5yYXcuc2xpY2UobGluZS5wcmVmaXgubGVuZ3RoKSlcblx0XHQ6IHJlbmRlckVkaXRvcklubGluZShsaW5lLmlubGluZSk7XG5cdGNvbnN0IGJvZHkgPSBwcmVmaXggKyAoY29udGVudCB8fCAobGluZS5yYXcubGVuZ3RoID09PSAwID8gJzxicj4nIDogJycpKTtcblxuXHRpZiAobGluZS5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nIHx8IGxpbmUua2luZCA9PT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB7XG5cdFx0Y29uc3QgcHJlZml4V2lkdGggPSBsaW5lLnByZWZpeC50cmltU3RhcnQoKS5sZW5ndGg7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBsaXN0XCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiIHN0eWxlPVwiLS1saXN0LWxldmVsOiAke2xpbmUubGlzdExldmVsIC0gMX07IC0tcHJlZml4LXdpZHRoOiAke3ByZWZpeFdpZHRofVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZSBoZWFkaW5nXCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0aWYgKGxpbmUua2luZCA9PT0gJ2NvZGVfZmVuY2UnIHx8IGxpbmUua2luZCA9PT0gJ2NvZGVfY29udGVudCcpIHtcblx0XHRyZXR1cm4gYDxkaXYgY2xhc3M9XCJsaW5lIGNvZGUgJHtsaW5lLmtpbmR9XCIgZGF0YS1saW5lLWlkPVwiJHtsaW5lLmlkfVwiPiR7Ym9keX08L2Rpdj5gO1xuXHR9XG5cblx0cmV0dXJuIGA8ZGl2IGNsYXNzPVwibGluZVwiIGRhdGEtbGluZS1pZD1cIiR7bGluZS5pZH1cIj4ke2JvZHl9PC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclNlbGVjdGlvbkh0bWwoZG9jdW1lbnQ6IEVkaXRvckRvY3VtZW50LCBzdGFydDogbnVtYmVyLCBlbmQ6IG51bWJlcik6IHN0cmluZyB7XG5cdGlmIChzdGFydCA+PSBlbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0cyA9IGRvY3VtZW50LmJsb2Nrc1xuXHRcdC5tYXAoKGJsb2NrKSA9PiByZW5kZXJCbG9ja1NlbGVjdGlvbihkb2N1bWVudC50ZXh0LCBibG9jaywgc3RhcnQsIGVuZCkpXG5cdFx0LmZpbHRlcihCb29sZWFuKTtcblxuXHRyZXR1cm4gYDxkaXYgc3R5bGU9XCJ3aGl0ZS1zcGFjZTogcHJlLXdyYXA7XCI+JHtwYXJ0cy5qb2luKCcnKX08L2Rpdj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmluZExpbmVJbmRleChsaW5lczogRWRpdG9yTGluZVtdLCBvZmZzZXQ6IG51bWJlcik6IG51bWJlciB7XG5cdGlmIChsaW5lcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBsaW5lcy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IG5leHRTdGFydCA9IGluZGV4ICsgMSA8IGxpbmVzLmxlbmd0aCA/IGxpbmVzW2luZGV4ICsgMV0ucmFuZ2Uuc3RhcnQgOiBsaW5lLnJhbmdlLmVuZCArIDE7XG5cdFx0aWYgKG9mZnNldCA8IG5leHRTdGFydCkgcmV0dXJuIGluZGV4O1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLmxlbmd0aCAtIDE7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRMaW5lUmVuZGVyU2lnbmF0dXJlKGxpbmU6IEVkaXRvckxpbmUpOiBzdHJpbmcge1xuXHRyZXR1cm4gW1xuXHRcdGxpbmUua2luZCxcblx0XHRsaW5lLnJhdyxcblx0XHRsaW5lLnByZWZpeCxcblx0XHRsaW5lLmxpc3RMZXZlbCxcblx0XHRsaW5lLmxpc3ROdW1iZXIsXG5cdFx0bGluZS5oZWFkaW5nTGV2ZWwsXG5cdFx0bGluZS5jb2RlQmxvY2tMYW5ndWFnZSA/PyAnJ1xuXHRdLmpvaW4oJ1xcdTAwMDEnKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRSYXdMaW5lcyh0ZXh0OiBzdHJpbmcpOiBSYXdMaW5lW10ge1xuXHRjb25zdCBzcGxpdCA9IHRleHQuc3BsaXQoJ1xcbicpO1xuXHRjb25zdCBsaW5lczogUmF3TGluZVtdID0gW107XG5cdGxldCBvZmZzZXQgPSAwO1xuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBzcGxpdC5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBsaW5lID0gc3BsaXRbaW5kZXhdO1xuXHRcdGxpbmVzLnB1c2goe1xuXHRcdFx0aW5kZXgsXG5cdFx0XHR0ZXh0OiBsaW5lLFxuXHRcdFx0c3RhcnQ6IG9mZnNldCxcblx0XHRcdGVuZDogb2Zmc2V0ICsgbGluZS5sZW5ndGhcblx0XHR9KTtcblx0XHRvZmZzZXQgKz0gbGluZS5sZW5ndGggKyAxO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUJsb2NrcyhsaW5lczogUmF3TGluZVtdKTogQmxvY2tOb2RlW10ge1xuXHRyZXR1cm4gcGFyc2VCbG9ja1NlcXVlbmNlKGxpbmVzLCAwLCAwKS5ibG9ja3M7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIsIGxpc3RMZXZlbDogbnVtYmVyKSB7XG5cdGNvbnN0IGJsb2NrczogQmxvY2tOb2RlW10gPSBbXTtcblx0bGV0IGluZGV4ID0gc3RhcnRJbmRleDtcblxuXHR3aGlsZSAoaW5kZXggPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaW5kZXhdO1xuXHRcdGNvbnN0IHByZWZpeCA9IHBhcnNlUHJlZml4KGxpbmUudGV4dCk7XG5cblx0XHRpZiAobGlzdExldmVsID4gMCkge1xuXHRcdFx0aWYgKGxpbmUudGV4dC50cmltKCkgPT09ICcnKSBicmVhaztcblx0XHRcdGlmIChwcmVmaXgua2luZCA9PT0gJ2NvZGVfZmVuY2UnKSB7XG5cdFx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlQ29kZUJsb2NrKGxpbmVzLCBpbmRleCk7XG5cdFx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlZC5ibG9jayk7XG5cdFx0XHRcdGluZGV4ID0gcGFyc2VkLm5leHRJbmRleDtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRpZiAoXG5cdFx0XHRcdChwcmVmaXgua2luZCAhPT0gJ29yZGVyZWRfbGlzdF9pdGVtJyAmJiBwcmVmaXgua2luZCAhPT0gJ3Vub3JkZXJlZF9saXN0X2l0ZW0nKSB8fFxuXHRcdFx0XHRwcmVmaXgubGlzdExldmVsIDwgbGlzdExldmVsXG5cdFx0XHQpIHtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnY29kZV9mZW5jZScpIHtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlQ29kZUJsb2NrKGxpbmVzLCBpbmRleCk7XG5cdFx0XHRibG9ja3MucHVzaChwYXJzZWQuYmxvY2spO1xuXHRcdFx0aW5kZXggPSBwYXJzZWQubmV4dEluZGV4O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0aWYgKHByZWZpeC5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nIHx8IHByZWZpeC5raW5kID09PSAndW5vcmRlcmVkX2xpc3RfaXRlbScpIHtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlTGlzdChsaW5lcywgaW5kZXgsIHByZWZpeC5saXN0TGV2ZWwsIHByZWZpeC5raW5kID09PSAnb3JkZXJlZF9saXN0X2l0ZW0nKTtcblx0XHRcdGJsb2Nrcy5wdXNoKHBhcnNlZC5ibG9jayk7XG5cdFx0XHRpbmRleCA9IHBhcnNlZC5uZXh0SW5kZXg7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdoZWFkaW5nJykge1xuXHRcdFx0YmxvY2tzLnB1c2gocGFyc2VIZWFkaW5nKGxpbmUsIHByZWZpeCkpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGJsb2Nrcy5wdXNoKHBhcnNlUGFyYWdyYXBoKGxpbmUpKTtcblx0XHRpbmRleCArPSAxO1xuXHR9XG5cblx0cmV0dXJuIHsgYmxvY2tzLCBuZXh0SW5kZXg6IGluZGV4IH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlTGlzdChsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIsIGxldmVsOiBudW1iZXIsIG9yZGVyZWQ6IGJvb2xlYW4pIHtcblx0Y29uc3QgaXRlbXM6IExpc3RJdGVtQmxvY2tbXSA9IFtdO1xuXHRsZXQgaW5kZXggPSBzdGFydEluZGV4O1xuXG5cdHdoaWxlIChpbmRleCA8IGxpbmVzLmxlbmd0aCkge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgcHJlZml4ID0gcGFyc2VQcmVmaXgobGluZS50ZXh0KTtcblx0XHRpZiAoXG5cdFx0XHQocHJlZml4LmtpbmQgIT09ICdvcmRlcmVkX2xpc3RfaXRlbScgJiYgcHJlZml4LmtpbmQgIT09ICd1bm9yZGVyZWRfbGlzdF9pdGVtJykgfHxcblx0XHRcdHByZWZpeC5saXN0TGV2ZWwgPCBsZXZlbCB8fFxuXHRcdFx0KHByZWZpeC5saXN0TGV2ZWwgPT09IGxldmVsICYmIChwcmVmaXgua2luZCA9PT0gJ29yZGVyZWRfbGlzdF9pdGVtJykgIT09IG9yZGVyZWQpXG5cdFx0KSB7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRpZiAocHJlZml4Lmxpc3RMZXZlbCA+IGxldmVsKSB7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRjb25zdCBpdGVtU3RhcnQgPSBsaW5lLnN0YXJ0O1xuXHRcdGNvbnN0IGl0ZW1QcmVmaXhMZW5ndGggPSBwcmVmaXgucHJlZml4Lmxlbmd0aDtcblx0XHRjb25zdCBpdGVtOiBMaXN0SXRlbUJsb2NrID0ge1xuXHRcdFx0dHlwZTogJ2xpc3RfaXRlbScsXG5cdFx0XHRyYW5nZTogeyBzdGFydDogaXRlbVN0YXJ0LCBlbmQ6IGxpbmUuZW5kIH0sXG5cdFx0XHRsaW5lUmFuZ2U6IHsgc3RhcnQ6IGxpbmUuc3RhcnQsIGVuZDogbGluZS5lbmQgfSxcblx0XHRcdGxldmVsLFxuXHRcdFx0b3JkZXJlZCxcblx0XHRcdG51bWJlcjogcHJlZml4Lmxpc3ROdW1iZXIsXG5cdFx0XHRwcmVmaXg6IHByZWZpeC5wcmVmaXgsXG5cdFx0XHRyYXc6IGxpbmUudGV4dCxcblx0XHRcdGlubGluZTogcGFyc2VJbmxpbmUobGluZS50ZXh0LnNsaWNlKGl0ZW1QcmVmaXhMZW5ndGgpLCBsaW5lLnN0YXJ0ICsgaXRlbVByZWZpeExlbmd0aCksXG5cdFx0XHRjaGlsZHJlbjogW11cblx0XHR9O1xuXG5cdFx0aW5kZXggKz0gMTtcblx0XHRjb25zdCBjaGlsZFBhcnNlZCA9IHBhcnNlQmxvY2tTZXF1ZW5jZShsaW5lcywgaW5kZXgsIGxldmVsICsgMSk7XG5cdFx0aXRlbS5jaGlsZHJlbiA9IGNoaWxkUGFyc2VkLmJsb2Nrcztcblx0XHRjb25zdCBjaGlsZEVuZCA9XG5cdFx0XHRpdGVtLmNoaWxkcmVuLmxlbmd0aCA+IDAgPyBpdGVtLmNoaWxkcmVuW2l0ZW0uY2hpbGRyZW4ubGVuZ3RoIC0gMV0ucmFuZ2UuZW5kIDogaXRlbS5yYW5nZS5lbmQ7XG5cdFx0aXRlbS5yYW5nZSA9IHsgc3RhcnQ6IGl0ZW1TdGFydCwgZW5kOiBjaGlsZEVuZCB9O1xuXHRcdGl0ZW1zLnB1c2goaXRlbSk7XG5cdFx0aW5kZXggPSBjaGlsZFBhcnNlZC5uZXh0SW5kZXg7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGJsb2NrOiB7XG5cdFx0XHR0eXBlOiAnbGlzdCcsXG5cdFx0XHRyYW5nZToge1xuXHRcdFx0XHRzdGFydDogaXRlbXNbMF0/LnJhbmdlLnN0YXJ0ID8/IGxpbmVzW3N0YXJ0SW5kZXhdLnN0YXJ0LFxuXHRcdFx0XHRlbmQ6IGl0ZW1zW2l0ZW1zLmxlbmd0aCAtIDFdPy5yYW5nZS5lbmQgPz8gbGluZXNbc3RhcnRJbmRleF0uZW5kXG5cdFx0XHR9LFxuXHRcdFx0bGV2ZWwsXG5cdFx0XHRvcmRlcmVkLFxuXHRcdFx0aXRlbXNcblx0XHR9IHNhdGlzZmllcyBMaXN0QmxvY2ssXG5cdFx0bmV4dEluZGV4OiBpbmRleFxuXHR9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUNvZGVCbG9jayhsaW5lczogUmF3TGluZVtdLCBzdGFydEluZGV4OiBudW1iZXIpIHtcblx0Y29uc3Qgb3BlbkxpbmUgPSBsaW5lc1tzdGFydEluZGV4XTtcblx0Y29uc3Qgb3BlblByZWZpeCA9IHBhcnNlUHJlZml4KG9wZW5MaW5lLnRleHQpO1xuXHRjb25zdCBjb250ZW50TGluZXM6IENvZGVCbG9ja1snbGluZXMnXSA9IFtdO1xuXHRsZXQgY2xvc2VGZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdGxldCBlbmQgPSBvcGVuTGluZS5lbmQ7XG5cdGxldCBpbmRleCA9IHN0YXJ0SW5kZXggKyAxO1xuXG5cdHdoaWxlIChpbmRleCA8IGxpbmVzLmxlbmd0aCkge1xuXHRcdGNvbnN0IGxpbmUgPSBsaW5lc1tpbmRleF07XG5cdFx0Y29uc3QgcHJlZml4ID0gcGFyc2VQcmVmaXgobGluZS50ZXh0KTtcblx0XHRpZiAocHJlZml4LmtpbmQgPT09ICdjb2RlX2ZlbmNlJykge1xuXHRcdFx0Y2xvc2VGZW5jZSA9IHByZWZpeC5wcmVmaXg7XG5cdFx0XHRlbmQgPSBsaW5lLmVuZDtcblx0XHRcdGluZGV4ICs9IDE7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRjb250ZW50TGluZXMucHVzaCh7XG5cdFx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdFx0dGV4dDogbGluZS50ZXh0XG5cdFx0fSk7XG5cdFx0ZW5kID0gbGluZS5lbmQ7XG5cdFx0aW5kZXggKz0gMTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0YmxvY2s6IHtcblx0XHRcdHR5cGU6ICdjb2RlX2Jsb2NrJyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBvcGVuTGluZS5zdGFydCwgZW5kIH0sXG5cdFx0XHRsYW5ndWFnZTogb3BlblByZWZpeC5sYW5ndWFnZSxcblx0XHRcdG9wZW5GZW5jZTogb3BlblByZWZpeC5wcmVmaXgsXG5cdFx0XHRjbG9zZUZlbmNlLFxuXHRcdFx0bGluZXM6IGNvbnRlbnRMaW5lc1xuXHRcdH0gc2F0aXNmaWVzIENvZGVCbG9jayxcblx0XHRuZXh0SW5kZXg6IGluZGV4XG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlSGVhZGluZyhsaW5lOiBSYXdMaW5lLCBwcmVmaXg6IExpbmVQcmVmaXhJbmZvKTogSGVhZGluZ0Jsb2NrIHtcblx0Y29uc3QgY29udGVudFN0YXJ0ID0gbGluZS5zdGFydCArIHByZWZpeC5wcmVmaXgubGVuZ3RoO1xuXHRyZXR1cm4ge1xuXHRcdHR5cGU6ICdoZWFkaW5nJyxcblx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdHJhdzogbGluZS50ZXh0LFxuXHRcdGxldmVsOiBwcmVmaXguaGVhZGluZ0xldmVsLFxuXHRcdHByZWZpeDogcHJlZml4LnByZWZpeCxcblx0XHRpbmxpbmU6IHBhcnNlSW5saW5lKGxpbmUudGV4dC5zbGljZShwcmVmaXgucHJlZml4Lmxlbmd0aCksIGNvbnRlbnRTdGFydClcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQYXJhZ3JhcGgobGluZTogUmF3TGluZSk6IFBhcmFncmFwaEJsb2NrIHtcblx0cmV0dXJuIHtcblx0XHR0eXBlOiAncGFyYWdyYXBoJyxcblx0XHRyYW5nZTogeyBzdGFydDogbGluZS5zdGFydCwgZW5kOiBsaW5lLmVuZCB9LFxuXHRcdHJhdzogbGluZS50ZXh0LFxuXHRcdGlubGluZTogcGFyc2VJbmxpbmUobGluZS50ZXh0LCBsaW5lLnN0YXJ0KVxuXHR9O1xufVxuXG5mdW5jdGlvbiBkZXJpdmVMaW5lcyhibG9ja3M6IEJsb2NrTm9kZVtdKTogRWRpdG9yTGluZVtdIHtcblx0Y29uc3QgbGluZXM6IEVkaXRvckxpbmVbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0YXBwZW5kQmxvY2tMaW5lcyhibG9jaywgbGluZXMpO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLm1hcCgobGluZSwgaW5kZXgpID0+ICh7XG5cdFx0Li4ubGluZSxcblx0XHRpZDogYGxpbmUtJHtpbmRleH1gLFxuXHRcdGluZGV4XG5cdH0pKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kQmxvY2tMaW5lcyhibG9jazogQmxvY2tOb2RlLCBsaW5lczogRWRpdG9yTGluZVtdKSB7XG5cdGlmIChibG9jay50eXBlID09PSAncGFyYWdyYXBoJykge1xuXHRcdGxpbmVzLnB1c2goY3JlYXRlQmFzZUxpbmUoYmxvY2sucmF3LCBibG9jay5yYW5nZSwgJ3BhcmFncmFwaCcsICcnLCBudWxsLCBibG9jay5pbmxpbmUpKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2hlYWRpbmcnKSB7XG5cdFx0bGluZXMucHVzaChcblx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRibG9jay5yYXcsXG5cdFx0XHRcdGJsb2NrLnJhbmdlLFxuXHRcdFx0XHQnaGVhZGluZycsXG5cdFx0XHRcdGJsb2NrLnByZWZpeCxcblx0XHRcdFx0bnVsbCxcblx0XHRcdFx0YmxvY2suaW5saW5lLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHRibG9jay5sZXZlbFxuXHRcdFx0KVxuXHRcdCk7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdjb2RlX2Jsb2NrJykge1xuXHRcdGxpbmVzLnB1c2goXG5cdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0YmxvY2sub3BlbkZlbmNlICsgKGJsb2NrLmxhbmd1YWdlID8gYmxvY2subGFuZ3VhZ2UgOiAnJyksXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRzdGFydDogYmxvY2sucmFuZ2Uuc3RhcnQsXG5cdFx0XHRcdFx0ZW5kOiBibG9jay5yYW5nZS5zdGFydCArIGJsb2NrLm9wZW5GZW5jZS5sZW5ndGggKyAoYmxvY2subGFuZ3VhZ2U/Lmxlbmd0aCA/PyAwKVxuXHRcdFx0XHR9LFxuXHRcdFx0XHQnY29kZV9mZW5jZScsXG5cdFx0XHRcdGJsb2NrLm9wZW5GZW5jZSxcblx0XHRcdFx0YmxvY2subGFuZ3VhZ2UsXG5cdFx0XHRcdFtdXG5cdFx0XHQpXG5cdFx0KTtcblxuXHRcdGZvciAoY29uc3QgbGluZSBvZiBibG9jay5saW5lcykge1xuXHRcdFx0bGluZXMucHVzaChjcmVhdGVCYXNlTGluZShsaW5lLnRleHQsIGxpbmUucmFuZ2UsICdjb2RlX2NvbnRlbnQnLCAnJywgYmxvY2subGFuZ3VhZ2UsIFtdKSk7XG5cdFx0fVxuXG5cdFx0aWYgKGJsb2NrLmNsb3NlRmVuY2UpIHtcblx0XHRcdGNvbnN0IGNsb3NlU3RhcnQgPSBibG9jay5yYW5nZS5lbmQgLSBibG9jay5jbG9zZUZlbmNlLmxlbmd0aDtcblx0XHRcdGxpbmVzLnB1c2goXG5cdFx0XHRcdGNyZWF0ZUJhc2VMaW5lKFxuXHRcdFx0XHRcdGJsb2NrLmNsb3NlRmVuY2UsXG5cdFx0XHRcdFx0eyBzdGFydDogY2xvc2VTdGFydCwgZW5kOiBibG9jay5yYW5nZS5lbmQgfSxcblx0XHRcdFx0XHQnY29kZV9mZW5jZScsXG5cdFx0XHRcdFx0YmxvY2suY2xvc2VGZW5jZSxcblx0XHRcdFx0XHRibG9jay5sYW5ndWFnZSxcblx0XHRcdFx0XHRbXVxuXHRcdFx0XHQpXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoYmxvY2sudHlwZSA9PT0gJ2xpc3QnKSB7XG5cdFx0Zm9yIChjb25zdCBpdGVtIG9mIGJsb2NrLml0ZW1zKSB7XG5cdFx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XHRjcmVhdGVCYXNlTGluZShcblx0XHRcdFx0XHRpdGVtLnJhdyxcblx0XHRcdFx0XHRpdGVtLmxpbmVSYW5nZSxcblx0XHRcdFx0XHRpdGVtLm9yZGVyZWQgPyAnb3JkZXJlZF9saXN0X2l0ZW0nIDogJ3Vub3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0XHRcdGl0ZW0ucHJlZml4LFxuXHRcdFx0XHRcdG51bGwsXG5cdFx0XHRcdFx0aXRlbS5pbmxpbmUsXG5cdFx0XHRcdFx0aXRlbS5sZXZlbCxcblx0XHRcdFx0XHRpdGVtLm51bWJlclxuXHRcdFx0XHQpXG5cdFx0XHQpO1xuXHRcdFx0Zm9yIChjb25zdCBjaGlsZCBvZiBpdGVtLmNoaWxkcmVuKSB7XG5cdFx0XHRcdGFwcGVuZEJsb2NrTGluZXMoY2hpbGQsIGxpbmVzKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlQmFzZUxpbmUoXG5cdHJhdzogc3RyaW5nLFxuXHRyYW5nZTogU291cmNlUmFuZ2UsXG5cdGtpbmQ6IExpbmVLaW5kLFxuXHRwcmVmaXg6IHN0cmluZyxcblx0Y29kZUJsb2NrTGFuZ3VhZ2U6IHN0cmluZyB8IG51bGwsXG5cdGlubGluZTogSW5saW5lTm9kZVtdLFxuXHRsaXN0TGV2ZWwgPSAwLFxuXHRsaXN0TnVtYmVyID0gMCxcblx0aGVhZGluZ0xldmVsID0gMFxuKTogRWRpdG9yTGluZSB7XG5cdGNvbnN0IGNvbnRlbnRTdGFydCA9IHJhbmdlLnN0YXJ0ICsgcHJlZml4Lmxlbmd0aDtcblx0cmV0dXJuIHtcblx0XHRpZDogJycsXG5cdFx0aW5kZXg6IDAsXG5cdFx0cmF3LFxuXHRcdHJhbmdlLFxuXHRcdGtpbmQsXG5cdFx0bGlzdExldmVsLFxuXHRcdGxpc3ROdW1iZXIsXG5cdFx0aGVhZGluZ0xldmVsLFxuXHRcdHByZWZpeCxcblx0XHRwcmVmaXhSYW5nZTogcHJlZml4Lmxlbmd0aCA+IDAgPyB7IHN0YXJ0OiByYW5nZS5zdGFydCwgZW5kOiBjb250ZW50U3RhcnQgfSA6IG51bGwsXG5cdFx0Y29udGVudFJhbmdlOiB7IHN0YXJ0OiBjb250ZW50U3RhcnQsIGVuZDogcmFuZ2UuZW5kIH0sXG5cdFx0aW5saW5lLFxuXHRcdGNvZGVCbG9ja0xhbmd1YWdlXG5cdH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJlZml4KHJhdzogc3RyaW5nKTogTGluZVByZWZpeEluZm8ge1xuXHRjb25zdCBjb2RlRmVuY2VNYXRjaCA9IHJhdy5tYXRjaCgvXmBgYChbQS1aYS16MC05Xy1dKyk/XFxzKiQvKTtcblx0aWYgKGNvZGVGZW5jZU1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICdjb2RlX2ZlbmNlJyxcblx0XHRcdGxpc3RMZXZlbDogMCxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6ICdgYGAnLFxuXHRcdFx0bGFuZ3VhZ2U6IGNvZGVGZW5jZU1hdGNoWzFdID8/IG51bGxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSByYXcubWF0Y2goL14oKD86IHs0fSkqKS0gLyk7XG5cdGlmICh1bm9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAndW5vcmRlcmVkX2xpc3RfaXRlbScsXG5cdFx0XHRsaXN0TGV2ZWw6IHVub3JkZXJlZE1hdGNoWzFdLmxlbmd0aCAvIDQgKyAxLFxuXHRcdFx0bGlzdE51bWJlcjogMCxcblx0XHRcdGhlYWRpbmdMZXZlbDogMCxcblx0XHRcdHByZWZpeDogdW5vcmRlcmVkTWF0Y2hbMF0sXG5cdFx0XHRsYW5ndWFnZTogbnVsbFxuXHRcdH07XG5cdH1cblxuXHRjb25zdCBvcmRlcmVkTWF0Y2ggPSByYXcubWF0Y2goL14oKD86IHs0fSkqKShcXGQrKVxcLiAvKTtcblx0aWYgKG9yZGVyZWRNYXRjaCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRraW5kOiAnb3JkZXJlZF9saXN0X2l0ZW0nLFxuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRsaXN0TnVtYmVyOiBOdW1iZXIucGFyc2VJbnQob3JkZXJlZE1hdGNoWzJdLCAxMCksXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IDAsXG5cdFx0XHRwcmVmaXg6IG9yZGVyZWRNYXRjaFswXSxcblx0XHRcdGxhbmd1YWdlOiBudWxsXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGhlYWRpbmdNYXRjaCA9IHJhdy5tYXRjaCgvXigjezEsNn0pXFxzKy8pO1xuXHRpZiAoaGVhZGluZ01hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6ICdoZWFkaW5nJyxcblx0XHRcdGxpc3RMZXZlbDogMCxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGhlYWRpbmdNYXRjaFsxXS5sZW5ndGgsXG5cdFx0XHRwcmVmaXg6IGhlYWRpbmdNYXRjaFswXSxcblx0XHRcdGxhbmd1YWdlOiBudWxsXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0a2luZDogJ3BhcmFncmFwaCcsXG5cdFx0bGlzdExldmVsOiAwLFxuXHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0aGVhZGluZ0xldmVsOiAwLFxuXHRcdHByZWZpeDogJycsXG5cdFx0bGFuZ3VhZ2U6IG51bGxcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VJbmxpbmUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIpOiBJbmxpbmVOb2RlW10ge1xuXHRjb25zdCBpbmxpbmU6IElubGluZU5vZGVbXSA9IFtdO1xuXHRsZXQgaW5kZXggPSAwO1xuXG5cdHdoaWxlIChpbmRleCA8IHJhdy5sZW5ndGgpIHtcblx0XHRjb25zdCBmb3JtYXR0ZWROb2RlID0gcGFyc2VGb3JtYXR0ZWROb2RlKHJhdywgc3RhcnRPZmZzZXQsIGluZGV4KTtcblx0XHRpZiAoZm9ybWF0dGVkTm9kZSkge1xuXHRcdFx0aW5saW5lLnB1c2goZm9ybWF0dGVkTm9kZS5ub2RlKTtcblx0XHRcdGluZGV4ID0gZm9ybWF0dGVkTm9kZS5uZXh0SW5kZXg7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRsZXQgbmV4dE1hcmtlciA9IHJhdy5sZW5ndGg7XG5cdFx0Y29uc3Qgc3RhckluZGV4ID0gcmF3LmluZGV4T2YoJyonLCBpbmRleCk7XG5cdFx0aWYgKHN0YXJJbmRleCAhPT0gLTEpIG5leHRNYXJrZXIgPSBzdGFySW5kZXg7XG5cdFx0Y29uc3QgYmFja3RpY2tJbmRleCA9IHJhdy5pbmRleE9mKCdgJywgaW5kZXgpO1xuXHRcdGlmIChiYWNrdGlja0luZGV4ICE9PSAtMSkgbmV4dE1hcmtlciA9IE1hdGgubWluKG5leHRNYXJrZXIsIGJhY2t0aWNrSW5kZXgpO1xuXG5cdFx0aWYgKG5leHRNYXJrZXIgPT09IGluZGV4KSB7XG5cdFx0XHRpbmxpbmUucHVzaCh7XG5cdFx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgaW5kZXgsIGVuZDogc3RhcnRPZmZzZXQgKyBpbmRleCArIDEgfSxcblx0XHRcdFx0dGV4dDogcmF3W2luZGV4XVxuXHRcdFx0fSBzYXRpc2ZpZXMgVGV4dE5vZGUpO1xuXHRcdFx0aW5kZXggKz0gMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IHRleHQgPSByYXcuc2xpY2UoaW5kZXgsIG5leHRNYXJrZXIpO1xuXHRcdGlubGluZS5wdXNoKHtcblx0XHRcdHR5cGU6ICd0ZXh0Jyxcblx0XHRcdHJhbmdlOiB7IHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LCBlbmQ6IHN0YXJ0T2Zmc2V0ICsgbmV4dE1hcmtlciB9LFxuXHRcdFx0dGV4dFxuXHRcdH0gc2F0aXNmaWVzIFRleHROb2RlKTtcblx0XHRpbmRleCA9IG5leHRNYXJrZXI7XG5cdH1cblxuXHRyZXR1cm4gaW5saW5lO1xufVxuXG5mdW5jdGlvbiBwYXJzZUZvcm1hdHRlZE5vZGUocmF3OiBzdHJpbmcsIHN0YXJ0T2Zmc2V0OiBudW1iZXIsIGluZGV4OiBudW1iZXIpIHtcblx0Zm9yIChjb25zdCBtYXJrZXIgb2YgWydgJywgJyoqKicsICcqKicsICcqJ10gYXMgY29uc3QpIHtcblx0XHRpZiAoIXJhdy5zdGFydHNXaXRoKG1hcmtlciwgaW5kZXgpKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IGNsb3NlID0gcmF3LmluZGV4T2YobWFya2VyLCBpbmRleCArIG1hcmtlci5sZW5ndGgpO1xuXHRcdGlmIChjbG9zZSA9PT0gLTEpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgY29udGVudFN0YXJ0ID0gaW5kZXggKyBtYXJrZXIubGVuZ3RoO1xuXHRcdGNvbnN0IGNvbnRlbnRFbmQgPSBjbG9zZTtcblx0XHRpZiAoY29udGVudFN0YXJ0ID49IGNvbnRlbnRFbmQpIGNvbnRpbnVlO1xuXHRcdGlmIChtYXJrZXIgIT09ICdgJyAmJiAocmF3W2NvbnRlbnRTdGFydF0gPT09ICcgJyB8fCByYXdbY29udGVudEVuZCAtIDFdID09PSAnICcpKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IHR5cGUgPVxuXHRcdFx0bWFya2VyID09PSAnYCdcblx0XHRcdFx0PyAnY29kZSdcblx0XHRcdFx0OiBtYXJrZXIgPT09ICcqKionXG5cdFx0XHRcdFx0PyAnc3Ryb25nX2VtcGhhc2lzJ1xuXHRcdFx0XHRcdDogbWFya2VyID09PSAnKionXG5cdFx0XHRcdFx0XHQ/ICdzdHJvbmcnXG5cdFx0XHRcdFx0XHQ6ICdlbXBoYXNpcyc7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0bm9kZToge1xuXHRcdFx0XHR0eXBlLFxuXHRcdFx0XHRyYW5nZToge1xuXHRcdFx0XHRcdHN0YXJ0OiBzdGFydE9mZnNldCArIGluZGV4LFxuXHRcdFx0XHRcdGVuZDogc3RhcnRPZmZzZXQgKyBjbG9zZSArIG1hcmtlci5sZW5ndGhcblx0XHRcdFx0fSxcblx0XHRcdFx0Y29udGVudFJhbmdlOiB7XG5cdFx0XHRcdFx0c3RhcnQ6IHN0YXJ0T2Zmc2V0ICsgY29udGVudFN0YXJ0LFxuXHRcdFx0XHRcdGVuZDogc3RhcnRPZmZzZXQgKyBjb250ZW50RW5kXG5cdFx0XHRcdH0sXG5cdFx0XHRcdG1hcmtlcixcblx0XHRcdFx0dGV4dDogcmF3LnNsaWNlKGNvbnRlbnRTdGFydCwgY29udGVudEVuZClcblx0XHRcdH0gc2F0aXNmaWVzIEZvcm1hdHRlZE5vZGUsXG5cdFx0XHRuZXh0SW5kZXg6IGNsb3NlICsgbWFya2VyLmxlbmd0aFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRWRpdG9ySW5saW5lKGlubGluZTogSW5saW5lTm9kZVtdKTogc3RyaW5nIHtcblx0cmV0dXJuIGlubGluZVxuXHRcdC5tYXAoKG5vZGUpID0+IHtcblx0XHRcdGlmIChub2RlLnR5cGUgPT09ICd0ZXh0Jykge1xuXHRcdFx0XHRyZXR1cm4gcmVuZGVyRWRpdG9yVGV4dChub2RlLnRleHQpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBjb250ZW50ID0gZXNjYXBlSHRtbChub2RlLnRleHQpO1xuXG5cdFx0XHRpZiAobm9kZS50eXBlID09PSAnY29kZScpIHtcblx0XHRcdFx0Y29uc3QgbWFya2VyID0gYDxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlciBjb2RlLW1hcmtlclwiPiR7ZXNjYXBlSHRtbChub2RlLm1hcmtlcil9PC9zcGFuPmA7XG5cdFx0XHRcdHJldHVybiBgPGNvZGUgY2xhc3M9XCJpbmxpbmUtY29kZVwiPiR7bWFya2VyfSR7Y29udGVudH0ke21hcmtlcn08L2NvZGU+YDtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgbWFya2VyID0gYDxzcGFuIGNsYXNzPVwic3ludGF4LW1hcmtlclwiPiR7ZXNjYXBlSHRtbChub2RlLm1hcmtlcil9PC9zcGFuPmA7XG5cblx0XHRcdGlmIChub2RlLnR5cGUgPT09ICdlbXBoYXNpcycpIHtcblx0XHRcdFx0cmV0dXJuIGAke21hcmtlcn08ZW0+JHtjb250ZW50fTwvZW0+JHttYXJrZXJ9YDtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3N0cm9uZycpIHtcblx0XHRcdFx0cmV0dXJuIGAke21hcmtlcn08c3Ryb25nPiR7Y29udGVudH08L3N0cm9uZz4ke21hcmtlcn1gO1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gYCR7bWFya2VyfTxzdHJvbmc+PGVtPiR7Y29udGVudH08L2VtPjwvc3Ryb25nPiR7bWFya2VyfWA7XG5cdFx0fSlcblx0XHQuam9pbignJyk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckJsb2NrU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGJsb2NrOiBCbG9ja05vZGUsXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRpZiAoZW5kIDw9IGJsb2NrLnJhbmdlLnN0YXJ0IHx8IHN0YXJ0ID49IGJsb2NrLnJhbmdlLmVuZCkgcmV0dXJuICcnO1xuXG5cdGlmIChibG9jay50eXBlID09PSAncGFyYWdyYXBoJykge1xuXHRcdHJldHVybiBgPHA+JHtyZW5kZXJTZW1hbnRpY0lubGluZVNlbGVjdGlvbihzb3VyY2VUZXh0LCBibG9jay5pbmxpbmUsIHN0YXJ0LCBlbmQpIHx8ICc8YnI+J308L3A+YDtcblx0fVxuXG5cdGlmIChibG9jay50eXBlID09PSAnaGVhZGluZycpIHtcblx0XHRjb25zdCB0YWcgPSBgaCR7YmxvY2subGV2ZWx9YDtcblx0XHRyZXR1cm4gYDwke3RhZ30+JHtyZW5kZXJTZW1hbnRpY0lubGluZVNlbGVjdGlvbihzb3VyY2VUZXh0LCBibG9jay5pbmxpbmUsIHN0YXJ0LCBlbmQpIHx8ICc8YnI+J308LyR7dGFnfT5gO1xuXHR9XG5cblx0aWYgKGJsb2NrLnR5cGUgPT09ICdjb2RlX2Jsb2NrJykge1xuXHRcdGNvbnN0IGNvZGVQYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2subGluZXMpIHtcblx0XHRcdGlmIChlbmQgPD0gbGluZS5yYW5nZS5zdGFydCB8fCBzdGFydCA+PSBsaW5lLnJhbmdlLmVuZCkgY29udGludWU7XG5cdFx0XHRjb2RlUGFydHMucHVzaChlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbGluZS5yYW5nZSwgc3RhcnQsIGVuZCkpKTtcblx0XHR9XG5cdFx0cmV0dXJuIGA8cHJlPjxjb2RlPiR7Y29kZVBhcnRzLmpvaW4oJ1xcbicpfTwvY29kZT48L3ByZT5gO1xuXHR9XG5cblx0Y29uc3QgdGFnID0gYmxvY2sub3JkZXJlZCA/ICdvbCcgOiAndWwnO1xuXHRjb25zdCBpdGVtcyA9IGJsb2NrLml0ZW1zXG5cdFx0Lm1hcCgoaXRlbSkgPT4gcmVuZGVyTGlzdEl0ZW1TZWxlY3Rpb24oc291cmNlVGV4dCwgaXRlbSwgc3RhcnQsIGVuZCkpXG5cdFx0LmZpbHRlcihCb29sZWFuKVxuXHRcdC5qb2luKCcnKTtcblx0cmV0dXJuIGl0ZW1zID8gYDwke3RhZ30+JHtpdGVtc308LyR7dGFnfT5gIDogJyc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckxpc3RJdGVtU2VsZWN0aW9uKFxuXHRzb3VyY2VUZXh0OiBzdHJpbmcsXG5cdGl0ZW06IExpc3RJdGVtQmxvY2ssXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRpZiAoZW5kIDw9IGl0ZW0ucmFuZ2Uuc3RhcnQgfHwgc3RhcnQgPj0gaXRlbS5yYW5nZS5lbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgaXRlbUlubGluZSA9IHJlbmRlclNlbWFudGljSW5saW5lU2VsZWN0aW9uKHNvdXJjZVRleHQsIGl0ZW0uaW5saW5lLCBzdGFydCwgZW5kKTtcblx0cGFydHMucHVzaChpdGVtSW5saW5lIHx8ICc8YnI+Jyk7XG5cblx0Zm9yIChjb25zdCBjaGlsZCBvZiBpdGVtLmNoaWxkcmVuKSB7XG5cdFx0Y29uc3QgY2hpbGRIdG1sID0gcmVuZGVyQmxvY2tTZWxlY3Rpb24oc291cmNlVGV4dCwgY2hpbGQsIHN0YXJ0LCBlbmQpO1xuXHRcdGlmIChjaGlsZEh0bWwpIHBhcnRzLnB1c2goY2hpbGRIdG1sKTtcblx0fVxuXG5cdHJldHVybiBgPGxpPiR7cGFydHMuam9pbignJyl9PC9saT5gO1xufVxuXG5mdW5jdGlvbiByZW5kZXJTZW1hbnRpY0lubGluZVNlbGVjdGlvbihcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRpbmxpbmU6IElubGluZU5vZGVbXSxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbik6IHN0cmluZyB7XG5cdGlmIChzdGFydCA+PSBlbmQpIHJldHVybiAnJztcblxuXHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IG5vZGUgb2YgaW5saW5lKSB7XG5cdFx0aWYgKG5vZGUudHlwZSA9PT0gJ3RleHQnKSB7XG5cdFx0XHRjb25zdCBzbGljZSA9IHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbm9kZS5yYW5nZSwgc3RhcnQsIGVuZCk7XG5cdFx0XHRpZiAoc2xpY2UpIHBhcnRzLnB1c2goZXNjYXBlSHRtbEZvckNsaXBib2FyZChzbGljZSkpO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaW5uZXJTbGljZSA9IHNsaWNlUmFuZ2Uoc291cmNlVGV4dCwgbm9kZS5jb250ZW50UmFuZ2UsIHN0YXJ0LCBlbmQpO1xuXHRcdGlmICghaW5uZXJTbGljZSkgY29udGludWU7XG5cblx0XHRpZiAobm9kZS50eXBlID09PSAnZW1waGFzaXMnKSB7XG5cdFx0XHRwYXJ0cy5wdXNoKGA8ZW0+JHtlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKGlubmVyU2xpY2UpfTwvZW0+YCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobm9kZS50eXBlID09PSAnc3Ryb25nJykge1xuXHRcdFx0cGFydHMucHVzaChgPHN0cm9uZz4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9zdHJvbmc+YCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobm9kZS50eXBlID09PSAnY29kZScpIHtcblx0XHRcdHBhcnRzLnB1c2goYDxjb2RlPiR7ZXNjYXBlSHRtbEZvckNsaXBib2FyZChpbm5lclNsaWNlKX08L2NvZGU+YCk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRwYXJ0cy5wdXNoKGA8c3Ryb25nPjxlbT4ke2VzY2FwZUh0bWxGb3JDbGlwYm9hcmQoaW5uZXJTbGljZSl9PC9lbT48L3N0cm9uZz5gKTtcblx0fVxuXG5cdHJldHVybiBwYXJ0cy5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gc2xpY2VSYW5nZShcblx0c291cmNlVGV4dDogc3RyaW5nLFxuXHRyYW5nZTogU291cmNlUmFuZ2UsXG5cdHNlbGVjdGlvblN0YXJ0OiBudW1iZXIsXG5cdHNlbGVjdGlvbkVuZDogbnVtYmVyXG4pOiBzdHJpbmcge1xuXHRjb25zdCBzdGFydCA9IE1hdGgubWF4KHJhbmdlLnN0YXJ0LCBzZWxlY3Rpb25TdGFydCk7XG5cdGNvbnN0IGVuZCA9IE1hdGgubWluKHJhbmdlLmVuZCwgc2VsZWN0aW9uRW5kKTtcblx0aWYgKHN0YXJ0ID49IGVuZCkgcmV0dXJuICcnO1xuXHRyZXR1cm4gc291cmNlVGV4dC5zbGljZShzdGFydCwgZW5kKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRWRpdG9yVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5sZW5ndGggPT09IDAgPyAnJyA6IGVzY2FwZUh0bWwodGV4dCk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRleHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sRm9yQ2xpcGJvYXJkKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBlc2NhcGVIdG1sKHRleHQpLnJlcGxhY2UoLyAvZywgJyZuYnNwOycpLnJlcGxhY2UoL1xcdC9nLCAnJm5ic3A7Jm5ic3A7Jm5ic3A7Jm5ic3A7Jyk7XG59XG4iLCAiaW1wb3J0IHsgZmluZExpbmVJbmRleCwgdHlwZSBFZGl0b3JEb2N1bWVudCB9IGZyb20gJy4vcGFyc2VyJztcblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRleHRPZmZzZXQoXG5cdGVkaXRvcjogSFRNTERpdkVsZW1lbnQsXG5cdGRvY3VtZW50TW9kZWw6IEVkaXRvckRvY3VtZW50XG4pOiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0ge1xuXHRjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG5cdGlmICghc2VsZWN0aW9uIHx8IHNlbGVjdGlvbi5yYW5nZUNvdW50ID09PSAwKSB7XG5cdFx0cmV0dXJuIHsgc3RhcnQ6IDAsIGVuZDogMCB9O1xuXHR9XG5cblx0Y29uc3QgcmFuZ2UgPSBzZWxlY3Rpb24uZ2V0UmFuZ2VBdCgwKTtcblx0cmV0dXJuIHtcblx0XHRzdGFydDogY291bnRPZmZzZXQoZWRpdG9yLCBkb2N1bWVudE1vZGVsLCByYW5nZS5zdGFydENvbnRhaW5lciwgcmFuZ2Uuc3RhcnRPZmZzZXQpLFxuXHRcdGVuZDogY291bnRPZmZzZXQoZWRpdG9yLCBkb2N1bWVudE1vZGVsLCByYW5nZS5lbmRDb250YWluZXIsIHJhbmdlLmVuZE9mZnNldClcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc3RvcmVUZXh0T2Zmc2V0KFxuXHRlZGl0b3I6IEhUTUxEaXZFbGVtZW50LFxuXHRkb2N1bWVudE1vZGVsOiBFZGl0b3JEb2N1bWVudCxcblx0c3RhcnQ6IG51bWJlcixcblx0ZW5kOiBudW1iZXJcbikge1xuXHRjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG5cdGlmICghc2VsZWN0aW9uKSByZXR1cm47XG5cblx0Y29uc3Qgc3RhcnRQb3NpdGlvbiA9IHJlc29sdmVQb3NpdGlvbihlZGl0b3IsIGRvY3VtZW50TW9kZWwsIHN0YXJ0KTtcblx0Y29uc3QgZW5kUG9zaXRpb24gPSByZXNvbHZlUG9zaXRpb24oZWRpdG9yLCBkb2N1bWVudE1vZGVsLCBlbmQpO1xuXHRpZiAoIXN0YXJ0UG9zaXRpb24gfHwgIWVuZFBvc2l0aW9uKSByZXR1cm47XG5cblx0Y29uc3QgcmFuZ2UgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpO1xuXHRyYW5nZS5zZXRTdGFydChzdGFydFBvc2l0aW9uLm5vZGUsIHN0YXJ0UG9zaXRpb24ub2Zmc2V0KTtcblx0cmFuZ2Uuc2V0RW5kKGVuZFBvc2l0aW9uLm5vZGUsIGVuZFBvc2l0aW9uLm9mZnNldCk7XG5cdHNlbGVjdGlvbi5yZW1vdmVBbGxSYW5nZXMoKTtcblx0c2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RUZXh0KGVkaXRvcjogSFRNTERpdkVsZW1lbnQpOiBzdHJpbmcge1xuXHRjb25zdCBsaW5lcyA9IEFycmF5LmZyb20oZWRpdG9yLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCcubGluZScpKTtcblx0cmV0dXJuIGxpbmVzLm1hcCgobGluZSkgPT4gbGluZS50ZXh0Q29udGVudCA/PyAnJykuam9pbignXFxuJyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRFZGl0b3JDb250YWluZXJPZmZzZXQoZG9jdW1lbnRNb2RlbDogRWRpdG9yRG9jdW1lbnQsIGNoaWxkT2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoY2hpbGRPZmZzZXQgPD0gMCB8fCBkb2N1bWVudE1vZGVsLmxpbmVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiAwO1xuXHR9XG5cblx0aWYgKGNoaWxkT2Zmc2V0ID49IGRvY3VtZW50TW9kZWwubGluZXMubGVuZ3RoKSB7XG5cdFx0cmV0dXJuIGRvY3VtZW50TW9kZWwudGV4dC5sZW5ndGg7XG5cdH1cblxuXHRyZXR1cm4gZG9jdW1lbnRNb2RlbC5saW5lc1tjaGlsZE9mZnNldF0/LnJhbmdlLnN0YXJ0ID8/IGRvY3VtZW50TW9kZWwudGV4dC5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGNvdW50T2Zmc2V0KFxuXHRlZGl0b3I6IEhUTUxEaXZFbGVtZW50LFxuXHRkb2N1bWVudE1vZGVsOiBFZGl0b3JEb2N1bWVudCxcblx0bm9kZTogTm9kZSxcblx0b2Zmc2V0OiBudW1iZXJcbik6IG51bWJlciB7XG5cdGlmIChub2RlID09PSBlZGl0b3IpIHtcblx0XHRyZXR1cm4gZ2V0RWRpdG9yQ29udGFpbmVyT2Zmc2V0KGRvY3VtZW50TW9kZWwsIG9mZnNldCk7XG5cdH1cblxuXHRjb25zdCBsaW5lRWxlbWVudCA9IGdldExpbmVFbGVtZW50KG5vZGUpO1xuXHRpZiAoIWxpbmVFbGVtZW50KSByZXR1cm4gZG9jdW1lbnRNb2RlbC50ZXh0Lmxlbmd0aDtcblxuXHRjb25zdCBsaW5lSW5kZXggPSBOdW1iZXIucGFyc2VJbnQobGluZUVsZW1lbnQuZGF0YXNldC5saW5lSW5kZXggPz8gJzAnLCAxMCk7XG5cdGNvbnN0IGxpbmUgPSBkb2N1bWVudE1vZGVsLmxpbmVzW2xpbmVJbmRleF07XG5cdGlmICghbGluZSkgcmV0dXJuIGRvY3VtZW50TW9kZWwudGV4dC5sZW5ndGg7XG5cblx0cmV0dXJuIGxpbmUucmFuZ2Uuc3RhcnQgKyB0ZXh0T2Zmc2V0V2l0aGluKGxpbmVFbGVtZW50LCBub2RlLCBvZmZzZXQpO1xufVxuXG5mdW5jdGlvbiB0ZXh0T2Zmc2V0V2l0aGluKHJvb3Q6IE5vZGUsIHRhcmdldDogTm9kZSwgdGFyZ2V0T2Zmc2V0OiBudW1iZXIpOiBudW1iZXIge1xuXHR0cnkge1xuXHRcdGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcblx0XHRyYW5nZS5zZWxlY3ROb2RlQ29udGVudHMocm9vdCk7XG5cdFx0cmFuZ2Uuc2V0RW5kKHRhcmdldCwgdGFyZ2V0T2Zmc2V0KTtcblx0XHRyZXR1cm4gcmFuZ2UudG9TdHJpbmcoKS5sZW5ndGg7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiAwO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVQb3NpdGlvbihcblx0ZWRpdG9yOiBIVE1MRGl2RWxlbWVudCxcblx0ZG9jdW1lbnRNb2RlbDogRWRpdG9yRG9jdW1lbnQsXG5cdG9mZnNldDogbnVtYmVyXG4pOiB7IG5vZGU6IE5vZGU7IG9mZnNldDogbnVtYmVyIH0gfCBudWxsIHtcblx0aWYgKGRvY3VtZW50TW9kZWwubGluZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHsgbm9kZTogZWRpdG9yLCBvZmZzZXQ6IDAgfTtcblx0fVxuXG5cdGNvbnN0IGNsYW1wZWRPZmZzZXQgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihvZmZzZXQsIGRvY3VtZW50TW9kZWwudGV4dC5sZW5ndGgpKTtcblx0Y29uc3QgbGluZUluZGV4ID0gZmluZExpbmVJbmRleChkb2N1bWVudE1vZGVsLmxpbmVzLCBjbGFtcGVkT2Zmc2V0KTtcblx0Y29uc3QgbGluZSA9IGRvY3VtZW50TW9kZWwubGluZXNbbGluZUluZGV4XTtcblx0Y29uc3QgbGluZUVsZW1lbnQgPSBlZGl0b3IucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYC5saW5lW2RhdGEtbGluZS1pbmRleD1cIiR7bGluZUluZGV4fVwiXWApO1xuXHRpZiAoIWxpbmUgfHwgIWxpbmVFbGVtZW50KSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBsb2NhbE9mZnNldCA9IE1hdGgubWF4KDAsIE1hdGgubWluKGNsYW1wZWRPZmZzZXQgLSBsaW5lLnJhbmdlLnN0YXJ0LCBsaW5lLnJhdy5sZW5ndGgpKTtcblx0cmV0dXJuIGZpbmRUZXh0UG9zaXRpb24obGluZUVsZW1lbnQsIGxvY2FsT2Zmc2V0KTtcbn1cblxuZnVuY3Rpb24gZmluZFRleHRQb3NpdGlvbihyb290OiBOb2RlLCBvZmZzZXQ6IG51bWJlcik6IHsgbm9kZTogTm9kZTsgb2Zmc2V0OiBudW1iZXIgfSB7XG5cdGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIocm9vdCwgTm9kZUZpbHRlci5TSE9XX1RFWFQpO1xuXHRsZXQgcmVtYWluaW5nID0gb2Zmc2V0O1xuXG5cdHdoaWxlICh3YWxrZXIubmV4dE5vZGUoKSkge1xuXHRcdGNvbnN0IHRleHROb2RlID0gd2Fsa2VyLmN1cnJlbnROb2RlIGFzIFRleHQ7XG5cdFx0aWYgKHJlbWFpbmluZyA8PSB0ZXh0Tm9kZS5sZW5ndGgpIHtcblx0XHRcdHJldHVybiB7IG5vZGU6IHRleHROb2RlLCBvZmZzZXQ6IHJlbWFpbmluZyB9O1xuXHRcdH1cblx0XHRyZW1haW5pbmcgLT0gdGV4dE5vZGUubGVuZ3RoO1xuXHR9XG5cblx0cmV0dXJuIHsgbm9kZTogcm9vdCwgb2Zmc2V0OiBNYXRoLm1pbihvZmZzZXQsIHJvb3QuY2hpbGROb2Rlcy5sZW5ndGgpIH07XG59XG5cbmZ1bmN0aW9uIGdldExpbmVFbGVtZW50KG5vZGU6IE5vZGUpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuXHRpZiAobm9kZS5ub2RlVHlwZSA9PT0gTm9kZS5FTEVNRU5UX05PREUpIHtcblx0XHRyZXR1cm4gKG5vZGUgYXMgRWxlbWVudCkuY2xvc2VzdCgnLmxpbmUnKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG5cdH1cblxuXHRyZXR1cm4gbm9kZS5wYXJlbnRFbGVtZW50Py5jbG9zZXN0KCcubGluZScpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IEJsb2NrTm9kZSwgTGlzdEJsb2NrIH0gZnJvbSAnLi9hc3QnO1xuaW1wb3J0IHsgYnVpbGREb2N1bWVudCB9IGZyb20gJy4vcGFyc2VyJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0aW9uUmFuZ2UsIFRleHRDaGFuZ2UgfSBmcm9tICcuL3RleHQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIExpc3RNZXRhZGF0YSB7XG5cdGxpc3RMZXZlbDogbnVtYmVyO1xuXHRvcmRlcmVkOiBib29sZWFuO1xuXHRsaXN0TnVtYmVyOiBudW1iZXI7XG5cdHByZWZpeDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVGV4dFJlcGxhY2VtZW50IHtcblx0c3RhcnQ6IG51bWJlcjtcblx0ZW5kOiBudW1iZXI7XG5cdHRleHQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpc3RNZXRhZGF0YShsaW5lVGV4dDogc3RyaW5nKTogTGlzdE1ldGFkYXRhIHtcblx0Y29uc3QgdW5vcmRlcmVkTWF0Y2ggPSBsaW5lVGV4dC5tYXRjaCgvXigoPzogezR9KSopLSAvKTtcblx0aWYgKHVub3JkZXJlZE1hdGNoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGxpc3RMZXZlbDogdW5vcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiBmYWxzZSxcblx0XHRcdGxpc3ROdW1iZXI6IDAsXG5cdFx0XHRwcmVmaXg6IHVub3JkZXJlZE1hdGNoWzBdXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IG9yZGVyZWRNYXRjaCA9IGxpbmVUZXh0Lm1hdGNoKC9eKCg/OiB7NH0pKikoXFxkKylcXC4gLyk7XG5cdGlmIChvcmRlcmVkTWF0Y2gpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0bGlzdExldmVsOiBvcmRlcmVkTWF0Y2hbMV0ubGVuZ3RoIC8gNCArIDEsXG5cdFx0XHRvcmRlcmVkOiB0cnVlLFxuXHRcdFx0bGlzdE51bWJlcjogTnVtYmVyLnBhcnNlSW50KG9yZGVyZWRNYXRjaFsyXSwgMTApLFxuXHRcdFx0cHJlZml4OiBvcmRlcmVkTWF0Y2hbMF1cblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRsaXN0TGV2ZWw6IDAsXG5cdFx0b3JkZXJlZDogZmFsc2UsXG5cdFx0bGlzdE51bWJlcjogMCxcblx0XHRwcmVmaXg6ICcnXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnMoXG5cdHRleHQ6IHN0cmluZyxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2Vcbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBkb2N1bWVudCA9IGJ1aWxkRG9jdW1lbnQodGV4dCk7XG5cdGNvbnN0IHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W10gPSBbXTtcblxuXHRjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoZG9jdW1lbnQuYmxvY2tzLCBhZmZlY3RlZFJhbmdlLCByZXBsYWNlbWVudHMpO1xuXG5cdGlmIChyZXBsYWNlbWVudHMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRleHQsXG5cdFx0XHRzZWxlY3Rpb25TdGFydDogc2VsZWN0aW9uLnN0YXJ0LFxuXHRcdFx0c2VsZWN0aW9uRW5kOiBzZWxlY3Rpb24uZW5kXG5cdFx0fTtcblx0fVxuXG5cdHJlcGxhY2VtZW50cy5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuc3RhcnQgLSBsZWZ0LnN0YXJ0KTtcblxuXHRsZXQgbmV4dFRleHQgPSB0ZXh0O1xuXHRsZXQgc2VsZWN0aW9uU3RhcnQgPSBzZWxlY3Rpb24uc3RhcnQ7XG5cdGxldCBzZWxlY3Rpb25FbmQgPSBzZWxlY3Rpb24uZW5kO1xuXG5cdGZvciAoY29uc3QgcmVwbGFjZW1lbnQgb2YgcmVwbGFjZW1lbnRzKSB7XG5cdFx0Y29uc3QgcmVwbGFjZWRMZW5ndGggPSByZXBsYWNlbWVudC5lbmQgLSByZXBsYWNlbWVudC5zdGFydDtcblx0XHRjb25zdCBkZWx0YSA9IHJlcGxhY2VtZW50LnRleHQubGVuZ3RoIC0gcmVwbGFjZWRMZW5ndGg7XG5cdFx0bmV4dFRleHQgPVxuXHRcdFx0bmV4dFRleHQuc2xpY2UoMCwgcmVwbGFjZW1lbnQuc3RhcnQpICsgcmVwbGFjZW1lbnQudGV4dCArIG5leHRUZXh0LnNsaWNlKHJlcGxhY2VtZW50LmVuZCk7XG5cdFx0c2VsZWN0aW9uU3RhcnQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuc3RhcnQsXG5cdFx0XHRyZXBsYWNlbWVudC5lbmQsXG5cdFx0XHRyZXBsYWNlbWVudC50ZXh0Lmxlbmd0aCxcblx0XHRcdGRlbHRhXG5cdFx0KTtcblx0XHRzZWxlY3Rpb25FbmQgPSBhZGp1c3RTZWxlY3Rpb25Qb2ludChcblx0XHRcdHNlbGVjdGlvbkVuZCxcblx0XHRcdHJlcGxhY2VtZW50LnN0YXJ0LFxuXHRcdFx0cmVwbGFjZW1lbnQuZW5kLFxuXHRcdFx0cmVwbGFjZW1lbnQudGV4dC5sZW5ndGgsXG5cdFx0XHRkZWx0YVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0LFxuXHRcdHNlbGVjdGlvbkVuZFxuXHR9O1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0T3JkZXJlZExpc3RSZXBsYWNlbWVudHMoXG5cdGJsb2NrczogQmxvY2tOb2RlW10sXG5cdGFmZmVjdGVkUmFuZ2U6IFNlbGVjdGlvblJhbmdlLFxuXHRyZXBsYWNlbWVudHM6IFRleHRSZXBsYWNlbWVudFtdXG4pOiBib29sZWFuIHtcblx0bGV0IGZvdW5kQWZmZWN0ZWRCbG9jayA9IGZhbHNlO1xuXG5cdGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG5cdFx0bGV0IGJsb2NrQWZmZWN0ZWQgPSByYW5nZXNJbnRlcnNlY3QoYmxvY2sucmFuZ2UsIGFmZmVjdGVkUmFuZ2UpO1xuXG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09ICdsaXN0Jykge1xuXHRcdFx0Y29sbGVjdExpc3RSZXBsYWNlbWVudHMoYmxvY2ssIGFmZmVjdGVkUmFuZ2UsIHJlcGxhY2VtZW50cyk7XG5cblx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5pdGVtcykge1xuXHRcdFx0XHRjb25zdCBjaGlsZHJlbkFmZmVjdGVkID0gY29sbGVjdE9yZGVyZWRMaXN0UmVwbGFjZW1lbnRzKFxuXHRcdFx0XHRcdGl0ZW0uY2hpbGRyZW4sXG5cdFx0XHRcdFx0YWZmZWN0ZWRSYW5nZSxcblx0XHRcdFx0XHRyZXBsYWNlbWVudHNcblx0XHRcdFx0KTtcblx0XHRcdFx0aWYgKGNoaWxkcmVuQWZmZWN0ZWQpIHtcblx0XHRcdFx0XHRub3JtYWxpemVTaWJsaW5nT3JkZXJlZENoaWxkTGlzdHMoaXRlbS5jaGlsZHJlbiwgYWZmZWN0ZWRSYW5nZSwgcmVwbGFjZW1lbnRzKTtcblx0XHRcdFx0XHRibG9ja0FmZmVjdGVkID0gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChibG9ja0FmZmVjdGVkKSB7XG5cdFx0XHRmb3VuZEFmZmVjdGVkQmxvY2sgPSB0cnVlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBmb3VuZEFmZmVjdGVkQmxvY2s7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RMaXN0UmVwbGFjZW1lbnRzKFxuXHRibG9jazogTGlzdEJsb2NrLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0cmVwbGFjZW1lbnRzOiBUZXh0UmVwbGFjZW1lbnRbXVxuKSB7XG5cdGlmICghYmxvY2sub3JkZXJlZCB8fCAhcmFuZ2VzSW50ZXJzZWN0KGJsb2NrLnJhbmdlLCBhZmZlY3RlZFJhbmdlKSkge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBibG9jay5pdGVtcy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCBpdGVtID0gYmxvY2suaXRlbXNbaW5kZXhdITtcblx0XHRjb25zdCBleHBlY3RlZE51bWJlciA9IGluZGV4ICsgMTtcblx0XHRpZiAoaXRlbS5udW1iZXIgPT09IGV4cGVjdGVkTnVtYmVyKSBjb250aW51ZTtcblxuXHRcdHJlcGxhY2VtZW50cy5wdXNoKHtcblx0XHRcdHN0YXJ0OiBpdGVtLmxpbmVSYW5nZS5zdGFydCxcblx0XHRcdGVuZDogaXRlbS5saW5lUmFuZ2Uuc3RhcnQgKyBpdGVtLnByZWZpeC5sZW5ndGgsXG5cdFx0XHR0ZXh0OiBgJHsnICAgICcucmVwZWF0KGl0ZW0ubGV2ZWwgLSAxKX0ke2V4cGVjdGVkTnVtYmVyfS4gYFxuXHRcdH0pO1xuXHR9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNpYmxpbmdPcmRlcmVkQ2hpbGRMaXN0cyhcblx0YmxvY2tzOiBCbG9ja05vZGVbXSxcblx0YWZmZWN0ZWRSYW5nZTogU2VsZWN0aW9uUmFuZ2UsXG5cdHJlcGxhY2VtZW50czogVGV4dFJlcGxhY2VtZW50W11cbikge1xuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJsb2Nrcykge1xuXHRcdGlmIChibG9jay50eXBlICE9PSAnbGlzdCcgfHwgIWJsb2NrLm9yZGVyZWQgfHwgcmFuZ2VzSW50ZXJzZWN0KGJsb2NrLnJhbmdlLCBhZmZlY3RlZFJhbmdlKSkge1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29sbGVjdExpc3RSZXBsYWNlbWVudHMoYmxvY2ssIGJsb2NrLnJhbmdlLCByZXBsYWNlbWVudHMpO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHJhbmdlc0ludGVyc2VjdChsZWZ0OiBTZWxlY3Rpb25SYW5nZSwgcmlnaHQ6IFNlbGVjdGlvblJhbmdlKSB7XG5cdHJldHVybiBsZWZ0LnN0YXJ0IDw9IHJpZ2h0LmVuZCAmJiByaWdodC5zdGFydCA8PSBsZWZ0LmVuZDtcbn1cblxuZnVuY3Rpb24gYWRqdXN0U2VsZWN0aW9uUG9pbnQoXG5cdHBvaW50OiBudW1iZXIsXG5cdHN0YXJ0OiBudW1iZXIsXG5cdGVuZDogbnVtYmVyLFxuXHRyZXBsYWNlbWVudExlbmd0aDogbnVtYmVyLFxuXHRkZWx0YTogbnVtYmVyXG4pIHtcblx0aWYgKHBvaW50ID4gZW5kKSB7XG5cdFx0cmV0dXJuIHBvaW50ICsgZGVsdGE7XG5cdH1cblxuXHRpZiAocG9pbnQgPj0gc3RhcnQpIHtcblx0XHRyZXR1cm4gc3RhcnQgKyBNYXRoLm1pbihwb2ludCAtIHN0YXJ0LCByZXBsYWNlbWVudExlbmd0aCk7XG5cdH1cblxuXHRyZXR1cm4gcG9pbnQ7XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBTZWxlY3Rpb25SYW5nZSB7XG5cdHN0YXJ0OiBudW1iZXI7XG5cdGVuZDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRleHRDaGFuZ2Uge1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHNlbGVjdGlvblN0YXJ0OiBudW1iZXI7XG5cdHNlbGVjdGlvbkVuZDogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVwbGFjZVJhbmdlKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdGluc2VydGVkVGV4dDogc3RyaW5nXG4pOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgbmV4dFRleHQgPSB0ZXh0LnNsaWNlKDAsIHNlbGVjdGlvbi5zdGFydCkgKyBpbnNlcnRlZFRleHQgKyB0ZXh0LnNsaWNlKHNlbGVjdGlvbi5lbmQpO1xuXHRjb25zdCBjdXJzb3IgPSBzZWxlY3Rpb24uc3RhcnQgKyBpbnNlcnRlZFRleHQubGVuZ3RoO1xuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IG5leHRUZXh0LFxuXHRcdHNlbGVjdGlvblN0YXJ0OiBjdXJzb3IsXG5cdFx0c2VsZWN0aW9uRW5kOiBjdXJzb3Jcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZUJhY2t3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRpZiAoc2VsZWN0aW9uLnN0YXJ0ICE9PSBzZWxlY3Rpb24uZW5kKSB7XG5cdFx0cmV0dXJuIHJlcGxhY2VSYW5nZSh0ZXh0LCBzZWxlY3Rpb24sICcnKTtcblx0fVxuXG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgPT09IDApIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiAwLFxuXHRcdFx0c2VsZWN0aW9uRW5kOiAwXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiByZXBsYWNlUmFuZ2UoXG5cdFx0dGV4dCxcblx0XHR7XG5cdFx0XHRzdGFydDogc2VsZWN0aW9uLnN0YXJ0IC0gMSxcblx0XHRcdGVuZDogc2VsZWN0aW9uLmVuZFxuXHRcdH0sXG5cdFx0Jydcblx0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlbGV0ZUZvcndhcmQodGV4dDogc3RyaW5nLCBzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlKTogVGV4dENoYW5nZSB7XG5cdGlmIChzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQpIHtcblx0XHRyZXR1cm4gcmVwbGFjZVJhbmdlKHRleHQsIHNlbGVjdGlvbiwgJycpO1xuXHR9XG5cblx0aWYgKHNlbGVjdGlvbi5lbmQgPj0gdGV4dC5sZW5ndGgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsXG5cdFx0XHRzZWxlY3Rpb25FbmQ6IHNlbGVjdGlvbi5lbmRcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHJlcGxhY2VSYW5nZShcblx0XHR0ZXh0LFxuXHRcdHtcblx0XHRcdHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsXG5cdFx0XHRlbmQ6IHNlbGVjdGlvbi5lbmQgKyAxXG5cdFx0fSxcblx0XHQnJ1xuXHQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dDogc3RyaW5nLCBwb3NpdGlvbjogbnVtYmVyKSB7XG5cdGNvbnN0IGJlZm9yZSA9IHRleHQuc2xpY2UoMCwgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lU3RhcnQgPSBiZWZvcmUubGFzdEluZGV4T2YoJ1xcbicpICsgMTtcblx0Y29uc3QgbmV4dE5ld2xpbmUgPSB0ZXh0LmluZGV4T2YoJ1xcbicsIHBvc2l0aW9uKTtcblx0Y29uc3QgbGluZUVuZCA9IG5leHROZXdsaW5lID09PSAtMSA/IHRleHQubGVuZ3RoIDogbmV4dE5ld2xpbmU7XG5cdHJldHVybiB7IGxpbmVTdGFydCwgbGluZUVuZCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VsZWN0ZWRCbG9ja0JvdW5kcyh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpIHtcblx0Y29uc3QgYmxvY2tTdGFydCA9IGdldEN1cnJlbnRMaW5lQm91bmRzKHRleHQsIHNlbGVjdGlvbi5zdGFydCkubGluZVN0YXJ0O1xuXHRjb25zdCBibG9ja0VuZFBvc2l0aW9uID1cblx0XHRzZWxlY3Rpb24uc3RhcnQgIT09IHNlbGVjdGlvbi5lbmQgJiYgc2VsZWN0aW9uLmVuZCA+IDAgJiYgdGV4dFtzZWxlY3Rpb24uZW5kIC0gMV0gPT09ICdcXG4nXG5cdFx0XHQ/IHNlbGVjdGlvbi5lbmQgLSAxXG5cdFx0XHQ6IHNlbGVjdGlvbi5lbmQ7XG5cdGNvbnN0IGJsb2NrRW5kID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgYmxvY2tFbmRQb3NpdGlvbikubGluZUVuZDtcblx0cmV0dXJuIHsgYmxvY2tTdGFydCwgYmxvY2tFbmQgfTtcbn1cbiIsICJpbXBvcnQgeyBnZXRMaXN0TWV0YWRhdGEsIG5vcm1hbGl6ZU9yZGVyZWRMaXN0TnVtYmVycyB9IGZyb20gJy4vbGlzdHMnO1xuaW1wb3J0IHtcblx0ZGVsZXRlQmFja3dhcmQsXG5cdGRlbGV0ZUZvcndhcmQsXG5cdGdldEN1cnJlbnRMaW5lQm91bmRzLFxuXHRnZXRTZWxlY3RlZEJsb2NrQm91bmRzLFxuXHR0eXBlIFNlbGVjdGlvblJhbmdlLFxuXHR0eXBlIFRleHRDaGFuZ2Vcbn0gZnJvbSAnLi90ZXh0JztcblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5VGFiS2V5KFxuXHR0ZXh0OiBzdHJpbmcsXG5cdHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UsXG5cdHNoaWZ0S2V5OiBib29sZWFuXG4pOiBUZXh0Q2hhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiBhcHBseVRhYlRvU2VsZWN0aW9uKHRleHQsIHNlbGVjdGlvbiwgc2hpZnRLZXkpO1xuXHR9XG5cblx0cmV0dXJuIGFwcGx5VGFiVG9MaW5lKHRleHQsIHNlbGVjdGlvbi5zdGFydCwgc2hpZnRLZXkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlFbnRlcktleSh0ZXh0OiBzdHJpbmcsIHNlbGVjdGlvbjogU2VsZWN0aW9uUmFuZ2UpOiBUZXh0Q2hhbmdlIHtcblx0Y29uc3QgeyBzdGFydCwgZW5kIH0gPSBzZWxlY3Rpb247XG5cdGNvbnN0IHsgbGluZVN0YXJ0LCBsaW5lRW5kIH0gPSBnZXRDdXJyZW50TGluZUJvdW5kcyh0ZXh0LCBzdGFydCk7XG5cdGNvbnN0IGxpbmVUZXh0ID0gdGV4dC5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpO1xuXHRjb25zdCBtZXRhZGF0YSA9IGdldExpc3RNZXRhZGF0YShsaW5lVGV4dCk7XG5cblx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA9PT0gMCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0OiB0ZXh0LnNsaWNlKDAsIHN0YXJ0KSArICdcXG4nICsgdGV4dC5zbGljZShlbmQpLFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IHN0YXJ0ICsgMSxcblx0XHRcdHNlbGVjdGlvbkVuZDogc3RhcnQgKyAxXG5cdFx0fTtcblx0fVxuXG5cdGlmIChtZXRhZGF0YS5vcmRlcmVkICYmIGxpbmVUZXh0LnRyaW0oKS5tYXRjaCgvXlxcZCtcXC4kLykpIHtcblx0XHRjb25zdCBuZXh0VGV4dCA9IHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIHRleHQuc2xpY2UobGluZUVuZCk7XG5cdFx0cmV0dXJuIG5vcm1hbGl6ZUxpc3RFZGl0KFxuXHRcdFx0bmV4dFRleHQsXG5cdFx0XHRnZXRTcGxpdExpc3RBZmZlY3RlZFJhbmdlKG5leHRUZXh0LCBsaW5lU3RhcnQpLFxuXHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVTdGFydCB9XG5cdFx0KTtcblx0fVxuXG5cdGlmICghbWV0YWRhdGEub3JkZXJlZCAmJiBsaW5lVGV4dC50cmltKCkgPT09ICctJykge1xuXHRcdHJldHVybiB7XG5cdFx0XHR0ZXh0OiB0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyB0ZXh0LnNsaWNlKGxpbmVFbmQpLFxuXHRcdFx0c2VsZWN0aW9uU3RhcnQ6IGxpbmVTdGFydCxcblx0XHRcdHNlbGVjdGlvbkVuZDogbGluZVN0YXJ0XG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGluZGVudCA9ICcgICAgJy5yZXBlYXQobWV0YWRhdGEubGlzdExldmVsIC0gMSk7XG5cdGNvbnN0IHByZWZpeCA9IG1ldGFkYXRhLm9yZGVyZWQgPyBgJHtpbmRlbnR9JHttZXRhZGF0YS5saXN0TnVtYmVyICsgMX0uIGAgOiBgJHtpbmRlbnR9LSBgO1xuXHRjb25zdCBuZXh0U2VsZWN0aW9uID0gc3RhcnQgKyAxICsgcHJlZml4Lmxlbmd0aDtcblxuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0dGV4dC5zbGljZSgwLCBzdGFydCkgKyAnXFxuJyArIHByZWZpeCArIHRleHQuc2xpY2UoZW5kKSxcblx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbmV4dFNlbGVjdGlvbiB9LFxuXHRcdHsgc3RhcnQ6IG5leHRTZWxlY3Rpb24sIGVuZDogbmV4dFNlbGVjdGlvbiB9XG5cdCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseURlbGV0ZUJhY2t3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBjaGFuZ2UgPSBkZWxldGVCYWNrd2FyZCh0ZXh0LCBzZWxlY3Rpb24pO1xuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoY2hhbmdlLnRleHQsIGdldERlbGV0ZUFmZmVjdGVkUmFuZ2UodGV4dCwgc2VsZWN0aW9uLCAnYmFja3dhcmQnKSwge1xuXHRcdHN0YXJ0OiBjaGFuZ2Uuc2VsZWN0aW9uU3RhcnQsXG5cdFx0ZW5kOiBjaGFuZ2Uuc2VsZWN0aW9uRW5kXG5cdH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlEZWxldGVGb3J3YXJkKHRleHQ6IHN0cmluZywgc2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZSk6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCBjaGFuZ2UgPSBkZWxldGVGb3J3YXJkKHRleHQsIHNlbGVjdGlvbik7XG5cdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChjaGFuZ2UudGV4dCwgZ2V0RGVsZXRlQWZmZWN0ZWRSYW5nZSh0ZXh0LCBzZWxlY3Rpb24sICdmb3J3YXJkJyksIHtcblx0XHRzdGFydDogY2hhbmdlLnNlbGVjdGlvblN0YXJ0LFxuXHRcdGVuZDogY2hhbmdlLnNlbGVjdGlvbkVuZFxuXHR9KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlUYWJUb1NlbGVjdGlvbihcblx0dGV4dDogc3RyaW5nLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlLFxuXHRzaGlmdEtleTogYm9vbGVhblxuKTogVGV4dENoYW5nZSB7XG5cdGNvbnN0IHsgYmxvY2tTdGFydCwgYmxvY2tFbmQgfSA9IGdldFNlbGVjdGVkQmxvY2tCb3VuZHModGV4dCwgc2VsZWN0aW9uKTtcblx0Y29uc3QgYmxvY2sgPSB0ZXh0LnNsaWNlKGJsb2NrU3RhcnQsIGJsb2NrRW5kKTtcblx0Y29uc3QgbGluZXMgPSBibG9jay5zcGxpdCgnXFxuJyk7XG5cblx0Y29uc3QgbW9kaWZpZWQgPSBsaW5lcy5tYXAoKGxpbmUpID0+IHtcblx0XHRjb25zdCBtZXRhZGF0YSA9IGdldExpc3RNZXRhZGF0YShsaW5lKTtcblx0XHRpZiAoc2hpZnRLZXkpIHtcblx0XHRcdGlmIChsaW5lLnN0YXJ0c1dpdGgoJyAgICAnKSkgcmV0dXJuIGxpbmUuc2xpY2UoNCk7XG5cdFx0XHRpZiAobWV0YWRhdGEubGlzdExldmVsID09PSAxKSByZXR1cm4gbGluZS5yZXBsYWNlKC9eLSAvLCAnJykucmVwbGFjZSgvXlxcZCtcXC4gLywgJycpO1xuXHRcdFx0cmV0dXJuIGxpbmU7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGAgICAgJHtsaW5lfWA7XG5cdH0pO1xuXG5cdGNvbnN0IG5leHRCbG9jayA9IG1vZGlmaWVkLmpvaW4oJ1xcbicpO1xuXHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0dGV4dC5zbGljZSgwLCBibG9ja1N0YXJ0KSArIG5leHRCbG9jayArIHRleHQuc2xpY2UoYmxvY2tFbmQpLFxuXHRcdHsgc3RhcnQ6IGJsb2NrU3RhcnQsIGVuZDogYmxvY2tTdGFydCArIG5leHRCbG9jay5sZW5ndGggfSxcblx0XHR7IHN0YXJ0OiBibG9ja1N0YXJ0LCBlbmQ6IGJsb2NrU3RhcnQgKyBuZXh0QmxvY2subGVuZ3RoIH1cblx0KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlUYWJUb0xpbmUodGV4dDogc3RyaW5nLCBwb3NpdGlvbjogbnVtYmVyLCBzaGlmdEtleTogYm9vbGVhbik6IFRleHRDaGFuZ2Uge1xuXHRjb25zdCB7IGxpbmVTdGFydCwgbGluZUVuZCB9ID0gZ2V0Q3VycmVudExpbmVCb3VuZHModGV4dCwgcG9zaXRpb24pO1xuXHRjb25zdCBsaW5lVGV4dCA9IHRleHQuc2xpY2UobGluZVN0YXJ0LCBsaW5lRW5kKTtcblx0Y29uc3QgbWV0YWRhdGEgPSBnZXRMaXN0TWV0YWRhdGEobGluZVRleHQpO1xuXG5cdGlmIChzaGlmdEtleSkge1xuXHRcdGlmIChsaW5lVGV4dC5zdGFydHNXaXRoKCcgICAgJykpIHtcblx0XHRcdHJldHVybiBub3JtYWxpemVMaXN0RWRpdChcblx0XHRcdFx0dGV4dC5zbGljZSgwLCBsaW5lU3RhcnQpICsgbGluZVRleHQuc2xpY2UoNCkgKyB0ZXh0LnNsaWNlKGxpbmVFbmQpLFxuXHRcdFx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbGluZUVuZCAtIDQgfSxcblx0XHRcdFx0eyBzdGFydDogcG9zaXRpb24gLSA0LCBlbmQ6IHBvc2l0aW9uIC0gNCB9XG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdGlmIChtZXRhZGF0YS5saXN0TGV2ZWwgPT09IDEpIHtcblx0XHRcdGNvbnN0IHVwZGF0ZWRMaW5lID0gbGluZVRleHQucmVwbGFjZSgvXi0gLywgJycpLnJlcGxhY2UoL15cXGQrXFwuIC8sICcnKTtcblx0XHRcdGNvbnN0IG5leHRTZWxlY3Rpb24gPSBNYXRoLm1heChsaW5lU3RhcnQsIHBvc2l0aW9uIC0gbWV0YWRhdGEucHJlZml4Lmxlbmd0aCk7XG5cdFx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0XHRcdHRleHQuc2xpY2UoMCwgbGluZVN0YXJ0KSArIHVwZGF0ZWRMaW5lICsgdGV4dC5zbGljZShsaW5lRW5kKSxcblx0XHRcdFx0eyBzdGFydDogbGluZVN0YXJ0LCBlbmQ6IGxpbmVTdGFydCArIHVwZGF0ZWRMaW5lLmxlbmd0aCB9LFxuXHRcdFx0XHR7IHN0YXJ0OiBuZXh0U2VsZWN0aW9uLCBlbmQ6IG5leHRTZWxlY3Rpb24gfVxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0dGV4dCxcblx0XHRcdHNlbGVjdGlvblN0YXJ0OiBwb3NpdGlvbixcblx0XHRcdHNlbGVjdGlvbkVuZDogcG9zaXRpb25cblx0XHR9O1xuXHR9XG5cblx0aWYgKG1ldGFkYXRhLmxpc3RMZXZlbCA+IDApIHtcblx0XHRyZXR1cm4gbm9ybWFsaXplTGlzdEVkaXQoXG5cdFx0XHR0ZXh0LnNsaWNlKDAsIGxpbmVTdGFydCkgKyAnICAgICcgKyB0ZXh0LnNsaWNlKGxpbmVTdGFydCksXG5cdFx0XHR7IHN0YXJ0OiBsaW5lU3RhcnQsIGVuZDogbGluZUVuZCArIDQgfSxcblx0XHRcdHsgc3RhcnQ6IHBvc2l0aW9uICsgNCwgZW5kOiBwb3NpdGlvbiArIDQgfVxuXHRcdCk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRleHQ6IHRleHQuc2xpY2UoMCwgcG9zaXRpb24pICsgJyAgICAnICsgdGV4dC5zbGljZShwb3NpdGlvbiksXG5cdFx0c2VsZWN0aW9uU3RhcnQ6IHBvc2l0aW9uICsgNCxcblx0XHRzZWxlY3Rpb25FbmQ6IHBvc2l0aW9uICsgNFxuXHR9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVMaXN0RWRpdChcblx0dGV4dDogc3RyaW5nLFxuXHRhZmZlY3RlZFJhbmdlOiBTZWxlY3Rpb25SYW5nZSxcblx0c2VsZWN0aW9uOiBTZWxlY3Rpb25SYW5nZVxuKSB7XG5cdHJldHVybiBub3JtYWxpemVPcmRlcmVkTGlzdE51bWJlcnModGV4dCwgYWZmZWN0ZWRSYW5nZSwgc2VsZWN0aW9uKTtcbn1cblxuZnVuY3Rpb24gZ2V0RGVsZXRlQWZmZWN0ZWRSYW5nZShcblx0dGV4dDogc3RyaW5nLFxuXHRzZWxlY3Rpb246IFNlbGVjdGlvblJhbmdlLFxuXHRkaXJlY3Rpb246ICdiYWNrd2FyZCcgfCAnZm9yd2FyZCdcbik6IFNlbGVjdGlvblJhbmdlIHtcblx0aWYgKHNlbGVjdGlvbi5zdGFydCAhPT0gc2VsZWN0aW9uLmVuZCkge1xuXHRcdHJldHVybiBzZWxlY3Rpb247XG5cdH1cblxuXHRpZiAoZGlyZWN0aW9uID09PSAnYmFja3dhcmQnKSB7XG5cdFx0Y29uc3Qgc3RhcnQgPSBNYXRoLm1heCgwLCBzZWxlY3Rpb24uc3RhcnQgLSAxKTtcblx0XHRyZXR1cm4geyBzdGFydCwgZW5kOiBzZWxlY3Rpb24uc3RhcnQgfTtcblx0fVxuXG5cdGNvbnN0IGVuZCA9IE1hdGgubWluKHRleHQubGVuZ3RoLCBzZWxlY3Rpb24uZW5kICsgMSk7XG5cdHJldHVybiB7IHN0YXJ0OiBzZWxlY3Rpb24uc3RhcnQsIGVuZCB9O1xufVxuXG5mdW5jdGlvbiBnZXRTcGxpdExpc3RBZmZlY3RlZFJhbmdlKHRleHQ6IHN0cmluZywgYm91bmRhcnk6IG51bWJlcik6IFNlbGVjdGlvblJhbmdlIHtcblx0cmV0dXJuIHtcblx0XHRzdGFydDogTWF0aC5tYXgoMCwgYm91bmRhcnkgLSAxKSxcblx0XHRlbmQ6IE1hdGgubWluKHRleHQubGVuZ3RoLCBib3VuZGFyeSArIDEpXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDMERaLFNBQVMsY0FBYyxTQUFpQztBQUM5RCxRQUFNLE9BQU8sY0FBYyxPQUFPO0FBQ2xDLFFBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsUUFBTSxTQUFTLFlBQVksUUFBUTtBQUNuQyxRQUFNLFFBQVEsWUFBWSxNQUFNO0FBQ2hDLFNBQU8sRUFBRSxNQUFNLFFBQVEsTUFBTTtBQUM5QjtBQUVPLFNBQVMsY0FBYyxTQUF5QjtBQUN0RCxTQUFPLFFBQVEsUUFBUSxVQUFVLElBQUk7QUFDdEM7QUEyREEs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
