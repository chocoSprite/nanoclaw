import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedCodexAuthAndConfig } from './container-mounts.js';

describe('seedCodexAuthAndConfig', () => {
  let tmpRoot: string;
  let hostCodex: string;
  let groupCodex: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mounts-'));
    hostCodex = path.join(tmpRoot, 'host', '.codex');
    groupCodex = path.join(tmpRoot, 'group', '.codex');
    fs.mkdirSync(hostCodex, { recursive: true });
    fs.mkdirSync(groupCodex, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies host auth.json/config.toml to group dir when group is empty', () => {
    fs.writeFileSync(path.join(hostCodex, 'auth.json'), 'host-auth');
    fs.writeFileSync(path.join(hostCodex, 'config.toml'), 'host-config');

    seedCodexAuthAndConfig(hostCodex, groupCodex);

    expect(fs.readFileSync(path.join(groupCodex, 'auth.json'), 'utf8')).toBe(
      'host-auth',
    );
    expect(fs.readFileSync(path.join(groupCodex, 'config.toml'), 'utf8')).toBe(
      'host-config',
    );
  });

  it('overwrites group copy even when group file is newer (host-wins)', () => {
    fs.writeFileSync(path.join(hostCodex, 'auth.json'), 'host-auth');
    const groupFile = path.join(groupCodex, 'auth.json');
    fs.writeFileSync(groupFile, 'GROUP-NEWER-COPY');
    // Make group file's mtime strictly newer than host file's. Without this,
    // file-system mtime granularity can leave the two equal and accidentally
    // satisfy a (now-removed) host>group check.
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(groupFile, newer, newer);

    seedCodexAuthAndConfig(hostCodex, groupCodex);

    expect(fs.readFileSync(groupFile, 'utf8')).toBe('host-auth');
  });

  it('skips files that do not exist on host', () => {
    fs.writeFileSync(path.join(hostCodex, 'auth.json'), 'host-auth');
    // No host config.toml.

    seedCodexAuthAndConfig(hostCodex, groupCodex);

    expect(fs.readFileSync(path.join(groupCodex, 'auth.json'), 'utf8')).toBe(
      'host-auth',
    );
    expect(fs.existsSync(path.join(groupCodex, 'config.toml'))).toBe(false);
  });
});
