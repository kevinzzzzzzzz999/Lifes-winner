import { useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, ListTree, X } from 'lucide-react';
import type { Language } from './i18n';
import { visibleNotebookHeadings, type NotebookHeading } from './notebook-outline';
import './notebook-outline.css';

export type NotebookOutlineProps = {
  headings: readonly NotebookHeading[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsedIDs: readonly string[];
  onCollapsedIDsChange: (ids: string[]) => void;
  activeHeadingID?: string;
  language: Language;
  onNavigate: (heading: NotebookHeading) => void;
};

/** Keep this a direct workspace child; the cells remain direct children for scroll restoration. */
export default function NotebookOutline({ headings, open, onOpenChange, collapsedIDs, onCollapsedIDsChange, activeHeadingID, language, onNavigate }: NotebookOutlineProps) {
  const zh = language === 'zh', list = useRef<HTMLOListElement>(null);
  const visible = useMemo(() => visibleNotebookHeadings(headings, collapsedIDs), [headings, collapsedIDs]);
  const collapsed = useMemo(() => new Set(collapsedIDs), [collapsedIDs]);
  const activeVisible = useMemo(() => {
    const byID = new Map(headings.map(heading => [heading.id, heading]));
    const visibleIDs = new Set(visible.map(heading => heading.id));
    let heading = activeHeadingID ? byID.get(activeHeadingID) : undefined;
    while (heading && !visibleIDs.has(heading.id)) heading = heading.parentID ? byID.get(heading.parentID) : undefined;
    return heading?.id;
  }, [headings, visible, activeHeadingID]);
  useEffect(() => {
    const host = list.current, item = host?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!open || !host || !item) return;
    // Scroll only the outline, never scrollIntoView() through the notebook's ancestors.
    const bounds = host.getBoundingClientRect(), target = item.getBoundingClientRect();
    if (target.top < bounds.top) host.scrollTop -= bounds.top - target.top + 6;
    else if (target.bottom > bounds.bottom) host.scrollTop += target.bottom - bounds.bottom + 6;
  }, [open, activeVisible]);
  const toggle = (heading: NotebookHeading) => onCollapsedIDsChange(collapsed.has(heading.id)
    ? collapsedIDs.filter(id => id !== heading.id)
    : [...collapsedIDs, heading.id]);
  return <aside className={'notebook-outline' + (open ? ' is-open' : '')} aria-label={zh ? 'Notebook 目录' : 'Notebook outline'} data-testid="notebook-outline">
    {open ? <div className="notebook-outline-panel">
      <div className="notebook-outline-header"><ListTree aria-hidden="true"/><strong>{zh ? '目录' : 'Outline'}</strong><span>{headings.length}</span><button type="button" onClick={() => onOpenChange(false)} title={zh ? '收起目录' : 'Hide outline'} aria-label={zh ? '收起 Notebook 目录' : 'Hide Notebook outline'}><X aria-hidden="true"/></button></div>
      <div className="notebook-outline-actions"><button type="button" disabled={!collapsedIDs.length} onClick={() => onCollapsedIDsChange([])}>{zh ? '全部展开' : 'Expand all'}</button><button type="button" disabled={!headings.some(heading => heading.hasChildren && !collapsed.has(heading.id))} onClick={() => onCollapsedIDsChange(headings.filter(heading => heading.hasChildren).map(heading => heading.id))}>{zh ? '全部折叠' : 'Collapse all'}</button></div>
      {headings.length ? <ol className="notebook-outline-list" ref={list}>
        {visible.map(heading => <li key={heading.id} className="notebook-outline-item" style={{ paddingInlineStart: 7 + heading.depth * 13 }}>
          {heading.hasChildren ? <button type="button" className="notebook-outline-fold" aria-expanded={!collapsed.has(heading.id)} aria-label={(collapsed.has(heading.id) ? zh ? '展开章节：' : 'Expand section: ' : zh ? '折叠章节：' : 'Collapse section: ') + heading.text} onClick={() => toggle(heading)}>{collapsed.has(heading.id) ? <ChevronRight aria-hidden="true"/> : <ChevronDown aria-hidden="true"/>}</button> : <span className="notebook-outline-fold-space"/>}
          <button type="button" className="notebook-outline-link" aria-current={heading.id === activeVisible ? 'location' : undefined} title={heading.text + ' · ' + (zh ? '单元格 ' : 'Cell ') + (heading.cellIndex + 1)} onClick={() => onNavigate(heading)}><span>{heading.text}</span><small>{heading.cellIndex + 1}</small></button>
        </li>)}
      </ol> : <p className="notebook-outline-empty">{zh ? 'Markdown 单元格中的标题会显示在这里。使用 #、## 等创建主副标题。' : 'Headings from Markdown cells appear here. Use #, ##, and further levels to structure the notebook.'}</p>}
    </div> : <button type="button" className="notebook-outline-show" onClick={() => onOpenChange(true)} title={zh ? '显示 Notebook 目录' : 'Show Notebook outline'} aria-label={zh ? '显示 Notebook 目录' : 'Show Notebook outline'}><ListTree aria-hidden="true"/></button>}
  </aside>;
}
