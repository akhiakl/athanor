import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../doc/storage';
import { classify, takeShared, unsupportedNote } from './share';

describe('shared files', () => {
  it('reads every pending file in order, decodes names, and removes them', async () => {
    const mem = new MemoryStorage();
    await mem.putBlob('share:00000000000002:0:b%20x.athanor', new Uint8Array([2]));
    await mem.putBlob('share:00000000000001:0:a.athanor', new Uint8Array([1]));
    await mem.putBlob('share:00000000000001:1:c%3Ad.svg', new Uint8Array([3]));
    await mem.putBlob('p:somepage:log:00000000', new Uint8Array([9])); // not a share: untouched
    const got = await takeShared(mem);
    expect(got.map((g) => g.name)).toEqual(['a.athanor', 'c:d.svg', 'b x.athanor']);
    expect(Array.from(got[0].bytes)).toEqual([1]);
    expect(await mem.blobKeys('share:')).toEqual([]);
    expect(await mem.blobKeys('p:')).toHaveLength(1);
    expect(await takeShared(mem)).toEqual([]);
  });
  it('classifies by extension', () => {
    expect([classify('a.athanor'), classify('A.ATHANOR'), classify('x.svg'), classify('p.JPG'), classify('p.webp'), classify('notes.txt'), classify('athanor')]).toEqual(['athanor', 'athanor', 'svg', 'image', 'image', 'other', 'other']);
  });
  it('says what it could not use', () => {
    const f = (name: string) => ({ name, bytes: new Uint8Array(0) });
    expect(unsupportedNote([f('a.athanor')])).toBe('');
    expect(unsupportedNote([f('a.athanor'), f('b.png')])).toMatch(/^1 shared file was not an Athanor file/);
    expect(unsupportedNote([f('b.png'), f('c.svg')])).toMatch(/^2 shared files were not/);
  });
});
