// Pages panel, spec 8.3.2: the open file's pages as a list. Click opens, double-click or F2 renames, row buttons duplicate, delete, reorder.
// shortcut: no thumbnails yet (they come with the file browser), and no document-level undo for page operations (8.5.4).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Pages } from '../app/pages';
import type { Hud } from './hud';
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from './icons';

export function PagesPanel({ pages, hud }: { pages: Pages; hud: Hud }) {
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = pages.pages.value;
  const current = pages.current.value;
  const side = hud.pos.value.edge === 'left' ? 'right' : 'left'; // never under the toolbar

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!hud.pagesOpen.value) return null;
  const finish = (id: string, name: string, commit: boolean): void => {
    setEditing(null);
    if (commit) void pages.rename(id, name);
  };

  return (
    <aside class="pages-panel" data-side={side} aria-label="Pages">
      <header>
        <h2>Pages</h2>
        <span class="count">{pages.index() + 1} / {list.length}</span>
        <button type="button" aria-label="Add page" title="Add page (Alt+N)" onClick={() => void pages.add()}><IconPlus /></button>
      </header>
      <ol>
        {list.map((p, i) => (
          <li key={p.id} aria-current={p.id === current ? 'page' : undefined}>
            {editing === p.id ? (
              <input
                ref={input} type="text" class="rename" aria-label={`Rename page ${i + 1}`} defaultValue={p.name} maxLength={60}
                onBlur={(e) => finish(p.id, e.currentTarget.value, true)}
                onKeyDown={(e) => { if (e.key === 'Enter') finish(p.id, e.currentTarget.value, true); else if (e.key === 'Escape') { e.stopPropagation(); finish(p.id, p.name, false); } }}
              />
            ) : (
              <button
                type="button" class="page" onClick={() => void pages.show(p.id)} onDblClick={() => setEditing(p.id)}
                onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); setEditing(p.id); } }}
                aria-label={`${p.name}, page ${i + 1} of ${list.length}${p.id === current ? ', current' : ''}`}
              >
                <span class="n">{i + 1}</span><span class="label">{p.name}</span>
              </button>
            )}
            <span class="row-actions">
              <button type="button" aria-label={`Move ${p.name} up`} aria-disabled={i === 0} onClick={() => i > 0 && void pages.move(p.id, -1)}><IconArrowUp /></button>
              <button type="button" aria-label={`Move ${p.name} down`} aria-disabled={i === list.length - 1} onClick={() => i < list.length - 1 && void pages.move(p.id, 1)}><IconArrowDown /></button>
              <button type="button" aria-label={`Duplicate ${p.name}`} onClick={() => void pages.duplicate(p.id)}><IconCopy /></button>
              <button type="button" aria-label={`Delete ${p.name}`} aria-disabled={list.length <= 1} onClick={() => void pages.remove(p.id)}><IconTrash /></button>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
