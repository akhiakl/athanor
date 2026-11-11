// Shell for every route except the editor: home, settings, and "new". Loads no engine code and starts no worker (spec 8.3).
import { render, h } from 'preact';
import { Docs } from '../doc/docs';
import { lazyIdbStorage } from '../doc/idb';
import { href, type Route } from '../app/router';
import { templateById } from './templates';
import { Home } from './Home';
import './home.css';

export async function mountShell(el: HTMLElement, route: Route): Promise<void> {
  const docs = new Docs(lazyIdbStorage());
  if (route.name === 'new') {
    // /new?template=: create the file, then go straight to it (replace, so Back does not return here)
    const t = templateById(route.template);
    const { file } = await docs.createFile(t.id === 'blank' ? 'Untitled' : t.name, window.innerWidth, window.innerHeight, t.preset);
    location.replace(href.editor(file.id));
    return;
  }
  await docs.purgeExpired().catch(() => 0); // trash older than 30 days goes on every visit
  document.title = 'Athanor';
  render(h(Home, { docs }), el);
}
