// Settings, spec 8.3.3: Drawing, Interface, Shortcuts, Session, Modules, Storage, About. Every control writes through the validated
// prefs store, so a bad value can never reach the editor; changes apply live where they can and on the next open where they cannot.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { download } from '../app/download';
import { moduleUi } from '../app/controls';
import { ACTIONS, bindingFromEvent, buildKeymap, formatBinding, keyOf, rebind, resetBinding } from '../app/keymap';
import { INPUT_RATES, type HudMode, type Motion, type Theme } from '../app/prefs';
import { prefsStore } from '../app/prefsStore';
import { INTERVALS, cleanPrefix, loadSessionPrefs, saveSessionPrefs, PREFIX_MAX } from '../app/sessionPrefs';
import { isMac } from '../app/shortcuts';
import { backupAll, restoreBackup, type RestoreReport } from '../doc/backup';
import type { Docs } from '../doc/docs';
import { href } from '../app/router';
import { formatBytes } from './model';

const { prefs, update, reset } = prefsStore;

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="row">
      <div><div class="label">{label}</div>{hint && <div class="hint">{hint}</div>}</div>
      <button type="button" role="switch" class="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button>
    </div>
  );
}

function Choice<T extends string | number>({ label, hint, value, options, onChange }: { label: string; hint?: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="row">
      <div><div class="label">{label}</div>{hint && <div class="hint">{hint}</div>}</div>
      <div class="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
      </div>
    </div>
  );
}

function Shortcuts() {
  const keys = prefs.value.keys;
  const mac = isMac();
  const keymap = useMemo(() => buildKeymap(keys), [keys]);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); setError(null); return; }
      const b = bindingFromEvent(e, mac);
      if (!b) return; // a modifier on its own: wait for the key that goes with it
      const r = rebind(keys, capturing, b);
      if (r.ok) { update({ keys: r.overrides }); setCapturing(null); setError(null); } else setError({ id: capturing, msg: r.reason });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, keys, mac]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 1500); // the invalid state shows for 1.5 s, as in the spec
    return () => clearTimeout(t);
  }, [error]);

  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <>
      {groups.map((g) => (
        <div key={g} class="group">
          <h3>{g}</h3>
          {ACTIONS.filter((a) => a.group === g).map((a) => {
            const bs = keymap.bindingsOf(a.id);
            const changed = keys[a.id] !== undefined;
            const bad = error?.id === a.id;
            return (
              <div key={a.id} class={bad ? 'row invalid' : 'row'}>
                <div><div class="label">{a.label}</div>{bad && <div class="hint err" role="alert">{error!.msg}</div>}</div>
                <div class="keys">
                  <button type="button" class={capturing === a.id ? 'key capturing' : 'key'} aria-label={`${a.label}: ${bs.map((b) => formatBinding(b, mac)).join(' or ')}. Change`} onClick={() => { setError(null); setCapturing(capturing === a.id ? null : a.id); }}>
                    {capturing === a.id ? 'Press the new keys…' : bs.map((b) => <kbd key={keyOf(b)}>{formatBinding(b, mac)}</kbd>)}
                  </button>
                  {changed && <button type="button" class="link" onClick={() => update({ keys: resetBinding(keys, a.id) })}>Reset</button>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <p class="hint">The number keys (1–0 create modules, Alt+1–0 more, {mac ? '⌘' : 'Ctrl+'}1–0 affects) and the numpad swatch keys are fixed.</p>
      {Object.keys(keys).length > 0 && <button type="button" onClick={() => update({ keys: {} })}>Reset all shortcuts</button>}
    </>
  );
}

const titleOf = (id: string): string => moduleUi[id]?.title ?? id;

export function Settings({ docs }: { docs: Docs }) {
  const p = prefs.value;
  const [session, setSession] = useState(loadSessionPrefs);
  const [storage, setStorage] = useState<{ used: number; quota: number; persisted: boolean | null } | null>(null);
  const [trash, setTrash] = useState(0);
  const [note, setNote] = useState('');
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStorage = async (): Promise<void> => {
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    setStorage({ used: est?.usage ?? 0, quota: est?.quota ?? 0, persisted: (await navigator.storage?.persisted?.().catch(() => undefined)) ?? null });
    setTrash((await docs.listTrash()).length);
  };
  useEffect(() => { void loadStorage(); }, []);

  const saveSession = (next: typeof session): void => {
    setSession(next);
    saveSessionPrefs(next);
  };
  const run = async (what: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await what();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
      void loadStorage();
    }
  };

  const createIds = Object.keys(moduleUi).filter((id) => id.startsWith('create.'));
  const affectIds = Object.keys(moduleUi).filter((id) => id.startsWith('affect.'));
  const disabled = new Set(p.disabledModules);
  const toggleModule = (id: string, on: boolean): void => {
    const next = new Set(disabled);
    if (on) next.delete(id);
    else next.add(id);
    if (createIds.every((c) => next.has(c))) { setNote('At least one drawing module must stay on.'); return; }
    setNote('');
    update({ disabledModules: [...next] });
  };

  return (
    <main class="home settings">
      <header>
        <h1>Settings</h1>
        <a class="back" href={href.home()}>← Files</a>
      </header>
      <nav aria-label="Settings sections">
        {['drawing', 'interface', 'shortcuts', 'session', 'modules', 'storage', 'about'].map((id) => <a key={id} href={`#${id}`}>{id[0].toUpperCase() + id.slice(1)}</a>)}
      </nav>
      <p class="note" role="status">{note}</p>

      <section id="drawing" aria-labelledby="h-drawing">
        <h2 id="h-drawing">Drawing</h2>
        <Switch label="Line smoothing" hint="Rounds corners as you draw." checked={p.lineSmoothing} onChange={(v) => update({ lineSmoothing: v })} />
        <Switch label="Synthetic pressure" hint="Pressure from speed when the device reports none." checked={p.syntheticPressure} onChange={(v) => update({ syntheticPressure: v })} />
        <Choice label="Input rate" hint="Samples per second for speed-based modules. Applies the next time a file opens." value={p.inputRateHz} options={INPUT_RATES.map((r) => ({ value: r, label: `${r} Hz` }))} onChange={(v) => update({ inputRateHz: v })} />
      </section>

      <section id="interface" aria-labelledby="h-interface">
        <h2 id="h-interface">Interface</h2>
        <Choice<HudMode> label="Toolbar" hint="A floating pill, or the bar that appears at the top edge." value={p.hudMode} options={[{ value: 'floating', label: 'Floating' }, { value: 'proximity', label: 'Top edge' }]} onChange={(v) => update({ hudMode: v })} />
        <Choice<Theme> label="Theme" value={p.theme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} onChange={(v) => update({ theme: v })} />
        <Choice<Motion> label="Motion" hint="Turns off animations and transitions." value={p.motion} options={[{ value: 'system', label: 'System' }, { value: 'reduce', label: 'Reduce' }]} onChange={(v) => update({ motion: v })} />
      </section>

      <section id="shortcuts" aria-labelledby="h-shortcuts">
        <h2 id="h-shortcuts">Shortcuts</h2>
        <p class="hint">Choose an action, then press the keys you want. Escape cancels.</p>
        <Shortcuts />
      </section>

      <section id="session" aria-labelledby="h-session">
        <h2 id="h-session">Session recording</h2>
        <Choice label="Snapshot every" value={session.intervalSec} options={INTERVALS.map((s) => ({ value: s as number, label: s < 60 ? `${s} s` : `${s / 60} min` }))} onChange={(v) => saveSession({ ...session, intervalSec: v })} />
        <Switch label="Clear the page after each snapshot" checked={session.autoClear} onChange={(v) => saveSession({ ...session, autoClear: v })} />
        <div class="row">
          <label class="label" for="prefix">Snapshot page name starts with</label>
          <input id="prefix" type="text" value={session.prefix} maxLength={PREFIX_MAX} spellcheck={false} onChange={(e) => saveSession({ ...session, prefix: cleanPrefix(e.currentTarget.value) })} />
        </div>
      </section>

      <section id="modules" aria-labelledby="h-modules">
        <h2 id="h-modules">Modules</h2>
        <p class="hint">Hide modules you do not use. Hidden modules leave the menus and the number shortcuts. Applies the next time a file opens.</p>
        <div class="mods">
          <fieldset><legend>Drawing</legend>{createIds.map((id) => <label key={id}><input type="checkbox" checked={!disabled.has(id)} onChange={(e) => toggleModule(id, e.currentTarget.checked)} />{titleOf(id)}</label>)}</fieldset>
          <fieldset><legend>Affects</legend>{affectIds.map((id) => <label key={id}><input type="checkbox" checked={!disabled.has(id)} onChange={(e) => toggleModule(id, e.currentTarget.checked)} />{titleOf(id)}</label>)}</fieldset>
        </div>
      </section>

      <section id="storage" aria-labelledby="h-storage">
        <h2 id="h-storage">Storage</h2>
        {storage && storage.quota > 0 && <p>{formatBytes(storage.used)} of {formatBytes(storage.quota)} used <progress max={storage.quota} value={storage.used} aria-label="Storage used" /></p>}
        <div class="row">
          <div><div class="label">Protection from automatic cleanup</div><div class="hint">{storage?.persisted ? 'On: the browser keeps your drawings unless you clear them.' : 'Off: the browser may remove your drawings when disk space is low.'}</div></div>
          {storage?.persisted === false && <button type="button" onClick={() => void navigator.storage.persist().then(loadStorage)}>Turn on</button>}
        </div>
        <div class="row">
          <div><div class="label">Back up everything</div><div class="hint">One ZIP with every file. Keep it somewhere safe.</div></div>
          <button type="button" disabled={busy} onClick={() => void run(async () => { const { bytes, count } = await backupAll(docs); download(new Blob([bytes as BlobPart], { type: 'application/zip' }), `athanor-backup-${new Date().toISOString().slice(0, 10)}.zip`); try { localStorage.setItem('athanor.lastBackup', String(Date.now())); } catch { /* the reminder comes back */ } setNote(`Backed up ${count} file${count === 1 ? '' : 's'}.`); })}>Back up</button>
        </div>
        <div class="row">
          <div><div class="label">Restore from a backup</div><div class="hint">Files you already have are left alone.</div></div>
          <label class="button">Choose a file…<input type="file" hidden accept=".zip,.athanor" onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void run(async () => { setReport(await restoreBackup(docs, new Uint8Array(await f.arrayBuffer()))); setNote(''); }); }} /></label>
        </div>
        {report && (
          <p class="report" role="status">
            Restored {report.restored.length}, skipped {report.skipped.length} already here{report.failed.length ? `, ${report.failed.length} could not be restored` : ''}.
            {report.failed.map((f) => <span key={f.name} class="err"> {f.name}: {f.reason}</span>)}
          </p>
        )}
        <div class="row">
          <div><div class="label">Trash</div><div class="hint">{trash} file{trash === 1 ? '' : 's'}. Files stay for 30 days.</div></div>
          <button type="button" disabled={busy || trash === 0} class="danger" onClick={() => { if (confirm(`Delete ${trash} file${trash === 1 ? '' : 's'} in the trash for good?`)) void run(async () => { for (const f of await docs.listTrash()) await docs.purgeFile(f.id); }); }}>Empty trash</button>
        </div>
        <div class="row">
          <div><div class="label">Reset the app</div><div class="hint">Deletes every file, page and setting stored in this browser. Back up first.</div></div>
          <button type="button" class="danger" disabled={busy} onClick={() => { if (confirm('Delete everything Athanor has stored in this browser? This cannot be undone.')) void run(async () => { await resetApp(); location.assign(href.home()); }); }}>Reset…</button>
        </div>
      </section>

      <section id="about" aria-labelledby="h-about">
        <h2 id="h-about">About</h2>
        <p>Athanor is a local-first drawing tool. Everything you make stays in this browser; nothing is sent anywhere.</p>
        <button type="button" onClick={() => { if (confirm('Reset all settings to their defaults? Your files are not touched.')) { reset(); saveSession({ intervalSec: 60, autoClear: false, prefix: 'session-' }); setNote('Settings reset.'); } }}>Reset settings</button>
      </section>
    </main>
  );
}

/** Deletes the database and every `athanor.` key. Open connections close themselves when asked (see openDb). */
async function resetApp(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('athanor');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Another Athanor tab is open. Close it and try again.'));
  });
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('athanor.')) localStorage.removeItem(k);
  } catch { /* nothing to clear */ }
}
