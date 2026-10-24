import { Lexer, type Token } from 'marked';

/** A plain-text outline only. Markdown/HTML is never rendered by this helper. */
export type NotebookOutlineCell = { id?: string; cell_type: string; source: string | string[] };
export type NotebookHeading = {
  id: string;
  cellIndex: number;
  cellID?: string;
  /** Ordinal of Markdown headings within this cell, including nested blockquotes/lists. */
  headingIndex: number;
  level: number;
  /** Actual tree depth, so a skipped heading level does not create empty branches. */
  depth: number;
  text: string;
  parentID?: string;
  hasChildren: boolean;
};

const entityNames: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, name: string) => {
    if (name[0] !== '#') return entityNames[name.toLowerCase()] || raw;
    const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return value >= 32 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
  });
}

/** Read inline token labels, never href/src, attributes, or raw HTML. */
function inlineText(tokens: readonly Token[]): string {
  let text = '', unsafeTag = '';
  for (const token of tokens) {
    if (token.type === 'html') {
      const html = token.raw.trim();
      if (/^<(script|style|iframe|object|template)\b/i.test(html)) unsafeTag = /^<(\w+)/.exec(html)?.[1].toLowerCase() || '';
      if (unsafeTag && new RegExp(`</${unsafeTag}\\s*>`, 'i').test(html)) unsafeTag = '';
      continue;
    }
    if (unsafeTag) continue;
    if ('tokens' in token && Array.isArray(token.tokens)) text += inlineText(token.tokens);
    else if ('text' in token && typeof token.text === 'string') text += token.text;
    else if (token.type === 'br') text += ' ';
  }
  return text;
}

/** Use the same Markdown lexer as the reader: fenced/indented code and HTML blocks stay opaque. */
export function buildNotebookOutline(cells: readonly NotebookOutlineCell[]): NotebookHeading[] {
  const result: NotebookHeading[] = [], parents: NotebookHeading[] = [];
  const counts = new Map<string, number>();
  for (const cell of cells) if (cell.id) counts.set(cell.id, (counts.get(cell.id) || 0) + 1);
  cells.forEach((cell, cellIndex) => {
    if (cell.cell_type !== 'markdown') return;
    const source = typeof cell.source === 'string' ? cell.source : cell.source.join('');
    const cellID = cell.id && counts.get(cell.id) === 1 ? cell.id : undefined;
    let headingIndex = 0;
    const walk = (tokens: readonly Token[]) => {
      for (const token of tokens) {
        if (token.type === 'heading') {
          const level = token.depth;
          const text = decodeEntities(inlineText(token.tokens || Lexer.lexInline(token.text))).replace(/\s+/g, ' ').trim();
          const ordinal = headingIndex++;
          // Empty/HTML-only titles have no useful navigation target but retain their ordinal.
          if (!text) continue;
          while (parents.length && parents[parents.length - 1].level >= level) parents.pop();
          const parent = parents[parents.length - 1];
          const heading: NotebookHeading = {
            id: `${cellID ? 'id:' + cellID : 'index:' + cellIndex}:${ordinal}`,
            cellIndex, ...(cellID ? { cellID } : {}), headingIndex: ordinal,
            level, depth: parents.length, text, ...(parent ? { parentID: parent.id } : {}), hasChildren: false,
          };
          if (parent) parent.hasChildren = true;
          result.push(heading); parents.push(heading);
        } else if (token.type === 'blockquote') walk(token.tokens || []);
        else if (token.type === 'list') for (const item of token.items) walk(item.tokens);
      }
    };
    walk(Lexer.lex(source, { gfm: true }));
  });
  return result;
}

/** Linear filtering remains bounded by the document's heading count; no recursive UI tree. */
export function visibleNotebookHeadings(headings: readonly NotebookHeading[], collapsedIDs: readonly string[]): NotebookHeading[] {
  const collapsed = new Set(collapsedIDs), hidden = new Set<string>();
  return headings.filter(heading => {
    if (heading.parentID && (collapsed.has(heading.parentID) || hidden.has(heading.parentID))) {
      hidden.add(heading.id); return false;
    }
    return true;
  });
}

/** A cell without a heading belongs to the last preceding section. */
export function notebookReadingHeading(headings: readonly NotebookHeading[], cellIndex: number, headingIndex = Infinity): NotebookHeading | undefined {
  let current: NotebookHeading | undefined;
  for (const heading of headings) {
    if (heading.cellIndex > cellIndex || heading.cellIndex === cellIndex && heading.headingIndex > headingIndex) break;
    current = heading;
  }
  return current;
}
