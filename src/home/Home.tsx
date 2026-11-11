// Home, spec 8.3.1: the file browser. Cards with a thumbnail, rename, duplicate, export and trash; templates; search and sort; a trash
// view; and a storage strip with persistence status and "Back up all".
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { download } from '../app/download';
import { exportAthanor, importAthanor } from '../doc/athanorFile';
import type { Docs, FileRecord } from '../doc/docs';
import { backupAll } from '../doc/backup';
import { href } from '../app/router';
import { filterFiles, formatBytes, relativeTime, safeFileName, sortFiles, type Sort } from './model';
import { templates } from './templates';

const LAST_BACKUP = 'athanor.lastBackup';
const WEEK = 7 * 86_400_000;

const readBackup = (): number => {
  try {
    return Number(localStorage.getItem(LAST_BACKUP)) || 0;
  } catch {
    return 0;
  }
};

function Thumb({ file }: { file: FileRecord }) {
  const url = useMemo(() => (file.thumb ? URL.createObjectURL(file.thumb) : null), [file.thumb]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span class="thumb-empty" aria-hidden="true" />;
}

interface Storage { used: number; quota: number; persisted: boolean | null }

export function Home({ docs }: { docs: Docs }) {
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [trash, setTrash] = useState<FileRecord[]>([]);
  const [view, setView] = useState<'files' | 'trash'>('files');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('edited');
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [backup, setBackup] = useState(readBackup);
  const pick = useRef<HTMLInputElement>(null);
  const now = Date.now();

  const reload = async (): Promise<void> => {
    setFiles(await docs.listFiles());
    setTrash(await docs.listTrash());
  };
  const loadStorage = async (): Promise<void> => {
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    const persisted = (await navigator.storage?.persisted?.().catch(() => undefined)) ?? null;
    setStorage({ used: est?.usage ?? 0, quota: est?.quota ?? 0, persisted });
  };
  useEffect(() => {
    void reload().catch((e: unknown) => setNote(`Could not read your files: ${e instanceof Error ? e.message : 'storage error'}`));
    void loadStorage();
  }, []);
  useEffect(() => {
    const close = (e: PointerEvent): void => { if (!(e.target as Element).closest('.card-menu')) setMenu(null); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setMenu(null); setEditing(null); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, []);

  /** A plain message: any earlier "Undo" no longer applies. */
  const say = (msg: string): void => { setUndo(null); setNote(msg); };

  const guard = async (what: () => Promise<void>): Promise<void> => {
    try {
      await what();
    } catch (err) {
      say(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const importBytes = (bytes: Uint8Array): Promise<void> => guard(async () => {
    const { file } = await importAthanor(docs, bytes);
    location.assign(href.editor(file.id));
  });
  const importFile = async (f: File): Promise<void> => importBytes(new Uint8Array(await f.arrayBuffer()));

  const shown = useMemo(() => sortFiles(filterFiles(files ?? [], query), sort), [files, query, sort]);
  const unbacked = (files ?? []).some((f) => f.updatedAt > backup);
  const reminder = (files?.length ?? 0) > 0 && unbacked && now - backup > WEEK;

  const backUpAll = (): Promise<void> => guard(async () => {
    const { bytes, count } = await backupAll(docs);
    download(new Blob([bytes as BlobPart], { type: 'application/zip' }), `athanor-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    try { localStorage.setItem(LAST_BACKUP, String(Date.now())); } catch { /* the reminder just comes back */ }
    setBackup(Date.now());
    say(`Backed up ${count} file${count === 1 ? '' : 's'}.`);
  });

  const rename = (f: FileRecord, name: string): Promise<void> => guard(async () => {
    setEditing(null);
    if (name.trim() && name !== f.name) await docs.renameFile(f.id, name);
    await reload();
  });

  const toTrash = (f: FileRecord): Promise<void> => guard(async () => {
    await docs.trashFile(f.id);
    setUndo(f.id);
    setNote(`Moved "${f.name}" to the trash.`);
    await reload();
  });

  const empty = files !== null && files.length === 0;

  return (
    <main class={drag ? 'home dragging' : 'home'}
      onDragOver={(e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer?.files[0]; if (f) void importFile(f); }}>
      <header>
        <h1>Athanor</h1>
        <div class="actions">
          <button type="button" class="primary" onClick={() => location.assign(href.newFile('blank'))}>New file</button>
          <button type="button" onClick={() => pick.current?.click()}>Import</button>
          <a class="button" href={href.settings()}>Settings</a>
          <input ref={pick} type="file" hidden accept=".athanor,.zip" aria-label="Import an .athanor file"
            onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void importFile(f); }} />
        </div>
      </header>

      <p class="note" role="status">{note}{undo && <button type="button" class="link" onClick={() => void guard(async () => { await docs.restoreFile(undo); setUndo(null); setNote(''); await reload(); })}>Undo</button>}</p>

      <section aria-labelledby="tpl">
        <h2 id="tpl">Start with</h2>
        <ul class="templates">
          {templates.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => location.assign(href.newFile(t.id))}><strong>{t.name}</strong><span>{t.description}</span></button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="files">
        <div class="bar">
          <div class="tabs" role="tablist" aria-label="Files">
            <button type="button" role="tab" id="files" aria-selected={view === 'files'} onClick={() => setView('files')}>Files{files ? ` (${files.length})` : ''}</button>
            <button type="button" role="tab" aria-selected={view === 'trash'} onClick={() => setView('trash')}>Trash{trash.length ? ` (${trash.length})` : ''}</button>
          </div>
          {view === 'files' && (
            <>
              <input type="search" placeholder="Search files" aria-label="Search files" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
              <label class="sort">Sort <select value={sort} onChange={(e) => setSort(e.currentTarget.value as Sort)}>
                <option value="edited">Last edited</option><option value="name">Name</option><option value="created">Created</option>
              </select></label>
            </>
          )}
        </div>

        {view === 'files' && files === null && <p class="empty">Loading…</p>}
        {view === 'files' && empty && (
          <div class="drop"><strong>Nothing here yet</strong><span>Start a new file above, or drop an .athanor file anywhere on this page.</span></div>
        )}
        {view === 'files' && files && files.length > 0 && shown.length === 0 && <p class="empty">No file matches "{query}".</p>}
        {view === 'files' && shown.length > 0 && (
          <ul class="grid">
            {shown.map((f) => (
              <li key={f.id} class="card">
                <a class="open" href={href.editor(f.id)} aria-label={`Open ${f.name}`}><Thumb file={f} /></a>
                <div class="meta">
                  {editing === f.id ? (
                    <input class="rename" aria-label="File name" defaultValue={f.name} maxLength={120} ref={(el) => el?.select()}
                      onBlur={(e) => void rename(f, e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void rename(f, e.currentTarget.value); else if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
                  ) : (
                    <a class="name" href={href.editor(f.id)} onDblClick={(e) => { e.preventDefault(); setEditing(f.id); }}>{f.name}</a>
                  )}
                  <span class="sub">{f.pageOrder.length} page{f.pageOrder.length === 1 ? '' : 's'} · {relativeTime(f.updatedAt, now)}</span>
                </div>
                <div class="card-menu">
                  <button type="button" aria-haspopup="menu" aria-expanded={menu === f.id} aria-label={`Actions for ${f.name}`} onClick={() => setMenu(menu === f.id ? null : f.id)}>⋯</button>
                  {menu === f.id && (
                    <div class="menu" role="menu">
                      <a role="menuitem" href={href.editor(f.id)}>Open</a>
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); setEditing(f.id); }}>Rename</button>
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); void guard(async () => { await docs.duplicateFile(f.id); await reload(); }); }}>Duplicate</button>
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); void guard(async () => download(new Blob([await exportAthanor(docs, f.id) as BlobPart], { type: 'application/zip' }), `${safeFileName(f.name)}.athanor`)); }}>Export .athanor</button>
                      <button type="button" role="menuitem" class="danger" onClick={() => { setMenu(null); void toTrash(f); }}>Move to trash</button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {view === 'trash' && (
          <>
            {trash.length === 0 && <p class="empty">The trash is empty. Files stay here for 30 days.</p>}
            <ul class="trash">
              {trash.map((f) => (
                <li key={f.id}>
                  <span class="name">{f.name}</span>
                  <span class="sub">deleted {relativeTime(f.deletedAt ?? now, now)}</span>
                  <button type="button" onClick={() => void guard(async () => { await docs.restoreFile(f.id); await reload(); })}>Restore</button>
                  <button type="button" class="danger" onClick={() => { if (confirm(`Delete "${f.name}" for good? This cannot be undone.`)) void guard(async () => { await docs.purgeFile(f.id); await reload(); void loadStorage(); }); }}>Delete forever</button>
                </li>
              ))}
            </ul>
            {trash.length > 1 && <button type="button" class="danger" onClick={() => { if (confirm(`Delete all ${trash.length} files in the trash for good?`)) void guard(async () => { for (const f of trash) await docs.purgeFile(f.id); await reload(); void loadStorage(); }); }}>Empty trash</button>}
          </>
        )}
      </section>

      <footer class="storage" aria-label="Storage">
        {storage && storage.quota > 0 && (
          <span>{formatBytes(storage.used)} of {formatBytes(storage.quota)} used
            <progress max={storage.quota} value={storage.used} aria-label="Storage used" /></span>
        )}
        {storage?.persisted === true && <span>Protected from automatic cleanup</span>}
        {storage?.persisted === false && (
          <button type="button" class="link" onClick={() => void navigator.storage.persist().then(loadStorage)}>Protect from automatic cleanup</button>
        )}
        <span>{backup ? `Last backup ${relativeTime(backup, now)}` : 'Never backed up'}</span>
        <button type="button" disabled={!files?.length} onClick={() => void backUpAll()}>Back up all</button>
        {reminder && <strong class="reminder">You have changes that are not backed up. Your drawings live only in this browser.</strong>}
      </footer>
    </main>
  );
}
