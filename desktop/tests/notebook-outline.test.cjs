const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotebookOutline, visibleNotebookHeadings, notebookReadingHeading } = require('../src/renderer/notebook-outline.ts');

const markdown = (source, id) => ({ cell_type: 'markdown', source, ...(id ? { id } : {}) });
const labels = headings => headings.map(heading => [heading.level, heading.text]);

test('ATX headings preserve hierarchy, optional closing markers, and Chinese text', () => {
  const result = buildNotebookOutline([markdown('# 课程 #\n\n### 第三层 ###\n\n## 二级\n\n###### 最深\n\n####### not a heading\n#without-space')]);
  assert.deepEqual(labels(result), [[1, '课程'], [3, '第三层'], [2, '二级'], [6, '最深']]);
  assert.deepEqual(result.map(heading => heading.depth), [0, 1, 1, 2]);
  assert.equal(result[1].parentID, result[0].id);
  assert.equal(result[3].parentID, result[2].id);
  assert.deepEqual(result.map(heading => heading.hasChildren), [true, false, true, false]);
});

test('setext and multiline setext titles match the Markdown reader', () => {
  const result = buildNotebookOutline([markdown('Main title\n==========\n\nPart one\n--------\n\nMultiple\nlines\n======\n\n---')]);
  assert.deepEqual(labels(result), [[1, 'Main title'], [2, 'Part one'], [1, 'Multiple lines']]);
});

test('fenced and indented code do not create ghost outline entries', () => {
  const source = '# Real\n\n```markdown\n# not\nFake\n===\n```\n\n~~~~\n## also not\n~~~~\n\n    # indented\n\n## Visible';
  assert.deepEqual(labels(buildNotebookOutline([markdown(source)])), [[1, 'Real'], [2, 'Visible']]);
});

test('an unclosed fence hides following source until the next cell, not the entire notebook', () => {
  const result = buildNotebookOutline([markdown('# First\n\n```\n## Hidden'), markdown('## Next cell')]);
  assert.deepEqual(labels(result), [[1, 'First'], [2, 'Next cell']]);
  assert.equal(result[1].cellIndex, 1);
});

test('HTML blocks and dangerous HTML bodies stay opaque; labels contain no executable markup', () => {
  const source = '<script>\n# hidden script\n</script>\n\n<div>\n## HTML block\n</div>\n\n# <script>alert(1)</script> Safe <em>label</em>\n\n<h2>HTML heading</h2>\n\n## <img src=x onerror=alert(1)>Image';
  assert.deepEqual(labels(buildNotebookOutline([markdown(source)])), [[1, 'Safe label'], [2, 'Image']]);
});

test('inline emphasis, code, links, image alt, escapes and entities produce plain labels', () => {
  const source = '# **Bold** _italic_ `code` [Link](https://invalid.example/) ![Alt](x) \\*literal\\* &amp; &#x4e2d;&#25991;';
  const result = buildNotebookOutline([markdown(source)]);
  assert.equal(result[0].text, 'Bold italic code Link Alt *literal* & 中文');
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert.equal(JSON.stringify(result).includes('invalid.example'), false);
});

test('code/raw cells and outputs cannot add headings, and sources are never mutated', () => {
  const cells = [{ cell_type: 'code', source: '# Python comment', outputs: [{ text: '# output' }] }, { cell_type: 'raw', source: '# raw' }, markdown(['# Part', '\n\n## Item'], 'stable')];
  const before = JSON.stringify(cells), result = buildNotebookOutline(cells);
  assert.deepEqual(labels(result), [[1, 'Part'], [2, 'Item']]);
  assert.equal(result[0].cellIndex, 2);
  assert.equal(result[0].cellID, 'stable');
  assert.equal(JSON.stringify(cells), before);
});

test('nested quote/list headings follow the same rendered order as Markdown blocks', () => {
  const result = buildNotebookOutline([markdown('# Main\n\n> ## Quoted\n>\n> ### Detail\n\n- ## List title\n\n  ### Nested list title\n\n## End')]);
  assert.deepEqual(labels(result), [[1, 'Main'], [2, 'Quoted'], [3, 'Detail'], [2, 'List title'], [3, 'Nested list title'], [2, 'End']]);
  assert.deepEqual(result.map(heading => heading.headingIndex), [0, 1, 2, 3, 4, 5]);
});

test('IDs survive moving cells with unique IDs; duplicates and repeated title labels remain unambiguous', () => {
  const a = markdown('# Repeat\n\n## Repeat', 'a'), b = markdown('# Repeat', 'b');
  const before = buildNotebookOutline([a, b]), moved = buildNotebookOutline([b, a]);
  assert.equal(before[0].id, moved[1].id);
  assert.equal(before[1].id, moved[2].id);
  assert.notEqual(before[0].id, before[1].id);
  const duplicate = buildNotebookOutline([markdown('# Same', 'bad'), markdown('# Same', 'bad')]);
  assert.notEqual(duplicate[0].id, duplicate[1].id);
  assert.equal(duplicate[0].cellID, undefined);
});

test('empty titles retain Markdown heading ordinals without producing blank navigation rows', () => {
  const result = buildNotebookOutline([markdown('#\n\n## <span></span>\n\n### Useful')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].headingIndex, 2);
});

test('collapsed parents hide all descendants across cells and reopening preserves independent child folds', () => {
  const result = buildNotebookOutline([markdown('# A\n\n## B'), markdown('### C\n\n## D\n\n# E')]);
  assert.deepEqual(visibleNotebookHeadings(result, [result[0].id]).map(heading => heading.text), ['A', 'E']);
  assert.deepEqual(visibleNotebookHeadings(result, [result[1].id]).map(heading => heading.text), ['A', 'B', 'D', 'E']);
  assert.equal(visibleNotebookHeadings(result, ['stale-deleted-id']).length, result.length);
});

test('all 600 cells are indexed and the final cell is an actual navigation target', () => {
  const cells = Array.from({ length: 600 }, (_, index) => markdown(`${index ? '##' : '#'} Section ${index + 1}`, `c${index}`));
  const result = buildNotebookOutline(cells);
  assert.equal(result.length, 600);
  assert.equal(result[599].cellIndex, 599);
  assert.equal(result[599].cellID, 'c599');
  assert.equal(result[599].headingIndex, 0);
  assert.equal(result[599].parentID, result[0].id);
  assert.equal(new Set(result.map(heading => heading.id)).size, 600);
});

test('reading location follows preceding headings, including heading-free cells and intra-cell titles', () => {
  const result = buildNotebookOutline([markdown('# A\n\n## B'), { cell_type: 'code', source: 'print(1)' }, markdown('# C')]);
  assert.equal(notebookReadingHeading(result, -1), undefined);
  assert.equal(notebookReadingHeading(result, 0, 0).text, 'A');
  assert.equal(notebookReadingHeading(result, 0, 1).text, 'B');
  assert.equal(notebookReadingHeading(result, 1).text, 'B');
  assert.equal(notebookReadingHeading(result, 2).text, 'C');
});
