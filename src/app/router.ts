// Routes, spec 8.3: history routing without a hash. Pure parsing and href building; the shell decides what to load.
// shortcut: moving between Home and the editor is a full page load (no in-page teardown of the render worker), which keeps the home route
// free of engine code (8.3: "shell + home") and makes leaving the editor a clean flush-and-go.
export type Route =
  | { name: 'home' }
  | { name: 'editor'; fileId: string; pageId?: string }
  | { name: 'settings' }
  | { name: 'new'; template: string };

const ID = /^[0-9A-Za-z_-]{1,64}$/;

export function parseRoute(pathname: string, search = ''): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'settings' && parts.length === 1) return { name: 'settings' };
  if (parts[0] === 'new' && parts.length === 1) {
    const t = new URLSearchParams(search).get('template') ?? 'blank';
    return { name: 'new', template: /^[a-z0-9-]{1,40}$/.test(t) ? t : 'blank' };
  }
  if (parts[0] === 'f' && parts.length >= 2 && ID.test(parts[1])) {
    if (parts.length === 2) return { name: 'editor', fileId: parts[1] };
    if (parts.length === 4 && parts[2] === 'p' && ID.test(parts[3])) return { name: 'editor', fileId: parts[1], pageId: parts[3] };
  }
  return { name: 'home' }; // anything unknown is the home page, never a dead end
}

export const href = {
  home: (): string => '/',
  editor: (fileId: string, pageId?: string): string => (pageId ? `/f/${fileId}/p/${pageId}` : `/f/${fileId}`),
  settings: (): string => '/settings',
  newFile: (template = 'blank'): string => `/new?template=${template}`,
};
