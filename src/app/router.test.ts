import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router';

describe('routes (8.3)', () => {
  it('parses every route', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('/f/01ABC')).toEqual({ name: 'editor', fileId: '01ABC' });
    expect(parseRoute('/f/01ABC/p/02DEF')).toEqual({ name: 'editor', fileId: '01ABC', pageId: '02DEF' });
    expect(parseRoute('/new', '?template=mandala')).toEqual({ name: 'new', template: 'mandala' });
    expect(parseRoute('/new')).toEqual({ name: 'new', template: 'blank' });
  });
  it('tolerates trailing slashes and falls back to home for anything unknown', () => {
    expect(parseRoute('/f/01ABC/')).toEqual({ name: 'editor', fileId: '01ABC' });
    expect(parseRoute('/nope')).toEqual({ name: 'home' });
    expect(parseRoute('/f')).toEqual({ name: 'home' });
    expect(parseRoute('/f/01ABC/x/1')).toEqual({ name: 'home' });
    expect(parseRoute('/settings/extra')).toEqual({ name: 'home' });
  });
  it('rejects ids and templates with odd characters', () => {
    expect(parseRoute('/f/..%2f..')).toEqual({ name: 'home' });
    expect(parseRoute('/f/a b')).toEqual({ name: 'home' });
    expect(parseRoute('/new', '?template=../x')).toEqual({ name: 'new', template: 'blank' });
    expect(parseRoute('/new', '?template=' + 'a'.repeat(50))).toEqual({ name: 'new', template: 'blank' });
  });
  it('builds hrefs that parse back', () => {
    expect(parseRoute(href.editor('F1', 'P1'))).toEqual({ name: 'editor', fileId: 'F1', pageId: 'P1' });
    expect(parseRoute(href.home())).toEqual({ name: 'home' });
    const [path, search] = href.newFile('mandala').split('?');
    expect(parseRoute(path, '?' + search)).toEqual({ name: 'new', template: 'mandala' });
  });
});
