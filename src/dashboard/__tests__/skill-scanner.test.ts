import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillScanner } from '../services/skill-scanner.js';

describe('SkillScanner', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scanner-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup(structure: {
    global?: string[];
    groups?: Record<string, string[]>;
  }): SkillScanner {
    const globalDir = path.join(tmp, 'container', 'skills');
    const groupsDir = path.join(tmp, 'groups');
    if (structure.global) {
      fs.mkdirSync(globalDir, { recursive: true });
      for (const name of structure.global) {
        fs.mkdirSync(path.join(globalDir, name), { recursive: true });
      }
    }
    if (structure.groups) {
      for (const [folder, skills] of Object.entries(structure.groups)) {
        const dir = path.join(groupsDir, folder, 'skills');
        fs.mkdirSync(dir, { recursive: true });
        for (const name of skills) {
          fs.mkdirSync(path.join(dir, name), { recursive: true });
        }
      }
    }
    return new SkillScanner({ globalSkillsDir: globalDir, groupsDir });
  }

  it('returns global skills for any group when per-group skills dir absent', () => {
    const s = setup({ global: ['status', 'browser'] });
    const out = s.listSkillsForGroup('slack_main');
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.origin === 'global')).toBe(true);
    expect(out.map((e) => e.name).sort()).toEqual(['browser', 'status']);
  });

  it('returns per-group skills when present', () => {
    const s = setup({ groups: { alpha: ['custom'] } });
    const out = s.listSkillsForGroup('alpha');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ name: 'custom', origin: 'group' });
  });

  it('combines global + per-group skills', () => {
    const s = setup({
      global: ['status'],
      groups: { alpha: ['custom'] },
    });
    const out = s.listSkillsForGroup('alpha');
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.name === 'status')?.origin).toBe('global');
    expect(out.find((e) => e.name === 'custom')?.origin).toBe('group');
  });

  it('returns empty when neither dir exists', () => {
    const s = setup({});
    expect(s.listSkillsForGroup('alpha')).toEqual([]);
  });

  it('ignores hidden entries and files', () => {
    const globalDir = path.join(tmp, 'container', 'skills');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'real'));
    fs.mkdirSync(path.join(globalDir, '.hidden'));
    fs.writeFileSync(path.join(globalDir, 'README.md'), '');
    const s = new SkillScanner({
      globalSkillsDir: globalDir,
      groupsDir: path.join(tmp, 'groups'),
    });
    const out = s.listSkillsForGroup('any');
    expect(out).toEqual([{ name: 'real', origin: 'global' }]);
  });
});
