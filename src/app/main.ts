// Entry: picks what to load from the route. Home, settings and "new" load the shell only; the editor chunk (engine, render worker,
// HUD) is imported on demand, so opening the file browser never starts a worker (spec 8.3).
import { followAppearance } from './appearance';
import { route } from './current';

const stage = document.getElementById('stage') as HTMLElement;
followAppearance(); // theme and motion prefs apply on every route

async function main(): Promise<void> {
  if (route.name === 'editor') {
    document.documentElement.classList.add('editor'); // the fixed, scroll-locked page of spec 6.3 applies to the editor only
    stage.hidden = false;
    await import('./editor');
    return;
  }
  const { mountShell } = await import('../home/shell');
  await mountShell(document.getElementById('app') as HTMLElement, route);
}

main().catch((err: unknown) => {
  console.error(err);
  const app = document.getElementById('app');
  if (app) app.textContent = `Athanor could not start: ${err instanceof Error ? err.message : 'unknown error'}. Reload to try again.`;
});
