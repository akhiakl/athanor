// Page side of the PWA (spec 8.7): registers the service worker, tracks "ready offline" and "update ready", and holds the install prompt.
// An update never activates by itself: it waits for `applyUpdate`, which the caller guards so it cannot interrupt a stroke or a save.
import { signal } from '@preact/signals';

export interface SwRegistrationLike extends EventTarget {
  installing: ServiceWorker | null;
  waiting: ServiceWorker | null;
  active: ServiceWorker | null;
  update(): Promise<void>;
}
export interface SwContainerLike extends EventTarget {
  controller: ServiceWorker | null;
  register(url: string, opts?: RegistrationOptions): Promise<SwRegistrationLike>;
}
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const HOUR = 3_600_000;

export function createPwa(
  nav: { serviceWorker?: SwContainerLike },
  win: Pick<Window, 'addEventListener'> & { location: { reload(): void } },
  now: () => number = Date.now,
) {
  /** A new version is installed and waiting. */
  const updateReady = signal(false);
  /** The app was just cached for offline use (first install only). */
  const offlineReady = signal(false);
  const canInstall = signal(false);
  const installed = signal(false);
  let registration: SwRegistrationLike | null = null;
  let deferred: InstallPrompt | null = null;
  let lastCheck = -Infinity;
  let reloading = false;

  const track = (sw: ServiceWorker | null): void => {
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (sw.state !== 'installed') return;
      // a controller means an older version is running: this one is an update. No controller: the very first install.
      if (nav.serviceWorker?.controller) updateReady.value = true;
      else offlineReady.value = true;
    });
  };

  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our own button, shown after the first saved file
    deferred = e as InstallPrompt;
    canInstall.value = true;
  });
  win.addEventListener('appinstalled', () => {
    installed.value = true;
    canInstall.value = false;
    deferred = null;
  });

  return {
    updateReady, offlineReady, canInstall, installed,

    /** Registers /sw.js. Resolves false where service workers are unsupported or registration failed (the app still works online). */
    async register(): Promise<boolean> {
      const sw = nav.serviceWorker;
      if (!sw) return false;
      try {
        registration = await sw.register('/sw.js', { scope: '/' });
      } catch {
        return false;
      }
      registration.addEventListener('updatefound', () => track(registration!.installing));
      track(registration.installing);
      if (registration.waiting && sw.controller) updateReady.value = true;
      sw.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true; // a new version took over: reload once so the page and its caches agree
        win.location.reload();
      });
      return true;
    },

    /** Asks the browser whether a newer worker exists, at most once an hour (called when the page becomes visible again). */
    async checkForUpdate(): Promise<void> {
      if (!registration || now() - lastCheck < HOUR) return;
      lastCheck = now();
      try {
        await registration.update();
      } catch { /* offline: try again later */ }
    },

    /**
     * Activates the waiting version, which reloads the page. `safe` is asked first: the editor passes a check that no stroke is active
     * and every write is on disk. Resolves true when the update was started.
     */
    async applyUpdate(safe: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
      const waiting = registration?.waiting;
      if (!waiting) return false;
      if (!(await safe())) return false;
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return true;
    },

    /** Shows the browser's install dialog. Resolves true when accepted. */
    async promptInstall(): Promise<boolean> {
      const p = deferred;
      if (!p) return false;
      deferred = null;
      canInstall.value = false;
      await p.prompt();
      return (await p.userChoice).outcome === 'accepted';
    },
  };
}
export type Pwa = ReturnType<typeof createPwa>;

/** iOS Safari has no install prompt: it needs a one-time hint to "Add to Home Screen". */
export function needsIosHint(ua: string, standalone: boolean): boolean {
  return /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua) && !standalone;
}
