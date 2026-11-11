import { describe, expect, it } from 'vitest';
import { createPwa, needsIosHint, type SwContainerLike, type SwRegistrationLike } from './pwa';

class FakeWorker extends EventTarget {
  state = 'installing';
  sent: unknown[] = [];
  postMessage(m: unknown): void { this.sent.push(m); }
  become(s: string): void { this.state = s; this.dispatchEvent(new Event('statechange')); }
}
class FakeReg extends EventTarget implements SwRegistrationLike {
  installing: ServiceWorker | null = null;
  waiting: ServiceWorker | null = null;
  active: ServiceWorker | null = null;
  updates = 0;
  async update(): Promise<void> { this.updates++; }
}
class FakeContainer extends EventTarget implements SwContainerLike {
  controller: ServiceWorker | null = null;
  reg = new FakeReg();
  fail = false;
  registered: string[] = [];
  async register(url: string): Promise<SwRegistrationLike> {
    if (this.fail) throw new Error('blocked');
    this.registered.push(url);
    return this.reg;
  }
}
class FakeWin extends EventTarget { reloads = 0; location = { reload: () => { this.reloads++; } }; }
const as = (w: FakeWorker): ServiceWorker => w as unknown as ServiceWorker;

function setup() {
  const sw = new FakeContainer(), win = new FakeWin();
  let t = 1_000_000;
  const pwa = createPwa({ serviceWorker: sw }, win as never, () => t);
  return { sw, win, pwa, tick: (ms: number) => { t += ms; } };
}

describe('registration and states', () => {
  it('registers /sw.js, and the first install means "ready offline", not an update', async () => {
    const { sw, pwa } = setup();
    expect(await pwa.register()).toBe(true);
    expect(sw.registered).toEqual(['/sw.js']);
    const w = new FakeWorker();
    sw.reg.installing = as(w);
    sw.reg.dispatchEvent(new Event('updatefound'));
    w.become('installed');
    expect(pwa.offlineReady.value).toBe(true);
    expect(pwa.updateReady.value).toBe(false);
  });
  it('an install while an older version controls the page is an update, and it waits', async () => {
    const { sw, pwa } = setup();
    sw.controller = as(new FakeWorker());
    await pwa.register();
    const w = new FakeWorker();
    sw.reg.installing = as(w);
    sw.reg.dispatchEvent(new Event('updatefound'));
    w.become('installing'); // not done yet
    expect(pwa.updateReady.value).toBe(false);
    w.become('installed');
    expect(pwa.updateReady.value).toBe(true);
    expect(pwa.offlineReady.value).toBe(false);
  });
  it('notices a version that was already waiting when the page opened', async () => {
    const { sw, pwa } = setup();
    sw.controller = as(new FakeWorker());
    sw.reg.waiting = as(new FakeWorker());
    await pwa.register();
    expect(pwa.updateReady.value).toBe(true);
  });
  it('survives unsupported browsers and failed registration', async () => {
    expect(await createPwa({}, new FakeWin() as never).register()).toBe(false);
    const { sw, pwa } = setup();
    sw.fail = true;
    expect(await pwa.register()).toBe(false);
  });
});

describe('applying an update', () => {
  async function waitingSetup() {
    const s = setup();
    s.sw.controller = as(new FakeWorker());
    const waiting = new FakeWorker();
    s.sw.reg.waiting = as(waiting);
    await s.pwa.register();
    return { ...s, waiting };
  }
  it('asks the waiting worker to take over, and reloads once when it does', async () => {
    const { pwa, waiting, sw, win } = await waitingSetup();
    expect(await pwa.applyUpdate()).toBe(true);
    expect(waiting.sent).toEqual([{ type: 'SKIP_WAITING' }]);
    sw.dispatchEvent(new Event('controllerchange'));
    sw.dispatchEvent(new Event('controllerchange'));
    expect(win.reloads).toBe(1);
  });
  it('does nothing while it is not safe (a stroke is active or a write is pending)', async () => {
    const { pwa, waiting, win } = await waitingSetup();
    expect(await pwa.applyUpdate(() => false)).toBe(false);
    expect(await pwa.applyUpdate(async () => false)).toBe(false);
    expect(waiting.sent).toEqual([]);
    expect(win.reloads).toBe(0);
  });
  it('does nothing when no update is waiting', async () => {
    const { pwa } = setup();
    await pwa.register();
    expect(await pwa.applyUpdate()).toBe(false);
  });
  it('a reload caused by the very first activation is not triggered unless a worker takes over', async () => {
    const { win, pwa } = setup();
    await pwa.register();
    expect(win.reloads).toBe(0);
  });
});

describe('update checks', () => {
  it('asks the browser at most once an hour', async () => {
    const { sw, pwa, tick } = setup();
    await pwa.register();
    await pwa.checkForUpdate();
    await pwa.checkForUpdate();
    expect(sw.reg.updates).toBe(1);
    tick(3_600_001);
    await pwa.checkForUpdate();
    expect(sw.reg.updates).toBe(2);
  });
  it('does nothing before registration', async () => {
    await expect(setup().pwa.checkForUpdate()).resolves.toBeUndefined();
  });
});

describe('install prompt', () => {
  const prompt = (outcome: 'accepted' | 'dismissed') => Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome }) });
  it('keeps the browser prompt for our own button and uses it once', async () => {
    const { win, pwa } = setup();
    const e = prompt('accepted');
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(pwa.canInstall.value).toBe(true);
    expect(await pwa.promptInstall()).toBe(true);
    expect(pwa.canInstall.value).toBe(false);
    expect(await pwa.promptInstall()).toBe(false); // a prompt can only be used once
  });
  it('reports a dismissal, and an installed app hides the button', async () => {
    const { win, pwa } = setup();
    win.dispatchEvent(prompt('dismissed'));
    expect(await pwa.promptInstall()).toBe(false);
    win.dispatchEvent(prompt('accepted'));
    win.dispatchEvent(new Event('appinstalled'));
    expect([pwa.installed.value, pwa.canInstall.value]).toEqual([true, false]);
  });
});

describe('iOS hint', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  it('shows for iOS Safari that is not installed, and not for other browsers or installed apps', () => {
    expect(needsIosHint(safari, false)).toBe(true);
    expect(needsIosHint(safari, true)).toBe(false);
    expect(needsIosHint(safari.replace('Safari/604.1', 'CriOS/120 Safari/604.1'), false)).toBe(false);
    expect(needsIosHint('Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36', false)).toBe(false);
  });
});
