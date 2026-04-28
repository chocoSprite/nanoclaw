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

  it('preserves group copy when group file is strictly newer (codex refresh-token rotation safe)', () => {
    fs.writeFileSync(path.join(hostCodex, 'auth.json'), 'STALE-host-auth');
    const groupFile = path.join(groupCodex, 'auth.json');
    fs.writeFileSync(groupFile, 'group-rotated-by-container');
    // Group mtime strictly newer simulates the post-spawn state: the
    // in-container codex CLI just performed an OAuth refresh and the
    // rotated refresh_token lives only in the group copy. Re-injecting
    // the host's now-stale (already-used) token would cause the next
    // spawn to fail with "refresh token already used".
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(groupFile, newer, newer);

    seedCodexAuthAndConfig(hostCodex, groupCodex);

    expect(fs.readFileSync(groupFile, 'utf8')).toBe(
      'group-rotated-by-container',
    );
  });

  it('overwrites group copy when host file is strictly newer (user re-login)', () => {
    const groupFile = path.join(groupCodex, 'auth.json');
    fs.writeFileSync(groupFile, 'old-group-auth');
    const olderTs = new Date(Date.now() - 60_000);
    fs.utimesSync(groupFile, olderTs, olderTs);

    fs.writeFileSync(path.join(hostCodex, 'auth.json'), 'fresh-host-auth');
    // Host mtime is "now" via writeFileSync, strictly newer than group's
    // backdated mtime above.

    seedCodexAuthAndConfig(hostCodex, groupCodex);

    expect(fs.readFileSync(groupFile, 'utf8')).toBe('fresh-host-auth');
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
