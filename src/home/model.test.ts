import { describe, expect, it } from 'vitest';
import type { FileRecord } from '../doc/docs';
import { filterFiles, formatBytes, relativeTime, safeFileName, sortFiles, uniqueNames } from './model';
import { templateById, templates } from './templates';

const f = (name: string, createdAt: number, updatedAt: number): FileRecord => ({ id: name, name, createdAt, updatedAt, pageOrder: ['p'], lastPageId: 'p' });
const files = [f('beta 10', 1, 30), f('Alpha', 3, 10), f('beta 2', 2, 20)];

describe('file browser model', () => {
  it('sorts by last edited, name (natural, case-insensitive) and created', () => {
    expect(sortFiles(files, 'edited').map((x) => x.name)).toEqual(['beta 10', 'beta 2', 'Alpha']);
    expect(sortFiles(files, 'name').map((x) => x.name)).toEqual(['Alpha', 'beta 2', 'beta 10']);
    expect(sortFiles(files, 'created').map((x) => x.name)).toEqual(['Alpha', 'beta 2', 'beta 10']);
    expect(files[0].name).toBe('beta 10'); // the input is not reordered
  });
  it('searches by every word, ignoring case', () => {
    expect(filterFiles(files, 'BETA').map((x) => x.name)).toEqual(['beta 10', 'beta 2']);
    expect(filterFiles(files, 'beta 2').map((x) => x.name)).toEqual(['beta 2']);
    expect(filterFiles(files, '   ')).toHaveLength(3);
    expect(filterFiles(files, 'zzz')).toEqual([]);
  });
  it('writes relative times', () => {
    const now = Date.UTC(2026, 10, 12, 12);
    expect(relativeTime(now - 5_000, now, 'en')).toBe('just now');
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours ago');
    expect(relativeTime(now - 86_400_000, now, 'en')).toBe('yesterday');
    expect(relativeTime(now - 40 * 86_400_000, now, 'en')).toBe('last month');
  });
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(NaN)).toBe('unknown');
  });
  it('makes download names safe and archive names distinct', () => {
    expect(safeFileName('a/b:c*?"<>|d')).toBe('a-b-c-d');
    expect(safeFileName('..hidden')).toBe('hidden');
    expect(safeFileName('   ')).toBe('untitled');
    expect(uniqueNames(['Sketch', 'sketch', 'Other', 'Sketch'], '.athanor')).toEqual(['Sketch.athanor', 'sketch (2).athanor', 'Other.athanor', 'Sketch (3).athanor']);
  });
  it('templates have unique ids and an unknown id falls back to blank', () => {
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
    expect(templateById('nope').id).toBe('blank');
    expect(templateById('mandala').preset?.values?.['affect.mirror']).toEqual({ horizontal: true, vertical: true });
  });
});
