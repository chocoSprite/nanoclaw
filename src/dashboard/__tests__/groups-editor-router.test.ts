/**
 * Lightweight integration-ish tests for the Groups editor router handlers.
 * We mount `createRouter` behind a real http.Server and use global `fetch`
 * so we exercise express body-parsing and status-code mapping without
 * adding supertest.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRouter, type RouterDeps } from '../router.js';
import type {
  GroupEditorView,
  GroupsEditorService,
  PatchResult,
} from '../services/groups-editor-service.js';
import type { RegisteredGroup } from '../../types.js';
import type { ResetResult } from '../../session-reset.js';

function makeView(jid: string, model: string | null = null): GroupEditorView {
  return {
    jid,
    name: jid,
    folder: jid.replace(':', '_'),
    sdk: 'claude',
    model,
    isMain: false,
    botRole: 'solo',
    trigger: '@bot',
    claudeMdPath: `/g/${jid}/CLAUDE.md`,
    skills: [],
    session: { sessionId: null },
  };
}

function makeGroup(): RegisteredGroup {
  return {
    name: 'alpha',
    folder: 'alpha',
    trigger: '@bot',
    added_at: '2026-04-19',
    sdk: 'claude',
  };
}

interface Fixture {
  server: http.Server;
  base: string;
  patchModel: ReturnType<typeof vi.fn>;
  lookupGroup: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
}

async function start(
  patchImpl: (jid: string, model: string | null) => PatchResult,
  lookupImpl: (jid: string) => RegisteredGroup | undefined,
  resetImpl: (jid: string, g: RegisteredGroup) => Promise<ResetResult>,
): Promise<Fixture> {
  const patchModel = vi.fn(patchImpl);
  const lookupGroup = vi.fn(lookupImpl);
  const resetSession = vi.fn(resetImpl);
  const groupsEditor = {
    listForEditor: () => [],
    getOne: () => undefined,
    lookupGroup,
    patchModel,
  } as unknown as GroupsEditorService;
  const deps: RouterDeps = {
    groups: {
      listLive: () => [],
      listRoster: () => [],
    } as unknown as RouterDeps['groups'],
    groupsEditor,
    automation: {
      listTasks: () => [],
    } as unknown as RouterDeps['automation'],
    logs: {} as RouterDeps['logs'],
    signals: {} as RouterDeps['signals'],
    resetSession,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}/api`,
    patchModel,
    lookupGroup,
    resetSession,
  };
}

async function stop(f: Fixture): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    f.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('PATCH /api/groups/:jid', () => {
  let fx: Fixture;

  afterEach(async () => {
    if (fx) await stop(fx);
  });

  it('400 no_field when model key missing from body', async () => {
    fx = await start(
      () => ({ ok: true, view: makeView('slack:A') }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('no_field');
  });

  it('200 ok with updated view on success', async () => {
    fx = await start(
      () => ({ ok: true, view: makeView('slack:A', 'claude-opus-4-6') }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.group.model).toBe('claude-opus-4-6');
    expect(fx.patchModel).toHaveBeenCalledWith('slack:A', 'claude-opus-4-6');
  });

  it('accepts explicit null to clear the model override', async () => {
    fx = await start(
      (_jid, model) => ({ ok: true, view: makeView('slack:A', model) }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    expect(res.status).toBe(200);
    expect(fx.patchModel).toHaveBeenCalledWith('slack:A', null);
  });

  it('maps not_claude → 400', async () => {
    fx = await start(
      () => ({ ok: false, error: 'not_claude' }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_claude');
  });

  it('maps invalid_model → 400', async () => {
    fx = await start(
      () => ({ ok: false, error: 'invalid_model' }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_model');
  });

  it('maps not_found → 404', async () => {
    fx = await start(
      () => ({ ok: false, error: 'not_found' }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:MISSING`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/groups/:jid/reset-session', () => {
  let fx: Fixture;

  afterEach(async () => {
    if (fx) await stop(fx);
  });

  it('404 when jid is not registered', async () => {
    fx = await start(
      () => ({ ok: false, error: 'not_found' }),
      () => undefined,
      async () => ({
        groupName: '',
        folder: '',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:MISSING/reset-session`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(fx.resetSession).not.toHaveBeenCalled();
  });

  it('invokes resetSession and returns result on success', async () => {
    fx = await start(
      () => ({ ok: false, error: 'not_found' }),
      () => makeGroup(),
      async () => ({
        groupName: 'alpha',
        folder: 'alpha',
        sdkType: 'claude',
        errors: [],
      }),
    );
    const res = await fetch(`${fx.base}/groups/slack:A/reset-session`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({
      groupName: 'alpha',
      folder: 'alpha',
      sdkType: 'claude',
      errors: [],
    });
    expect(fx.resetSession).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from resetSession to the error handler (500)', async () => {
    fx = await start(
      () => ({ ok: false, error: 'not_found' }),
      () => makeGroup(),
      async () => {
        throw new Error('terminate failed');
      },
    );
    const res = await fetch(`${fx.base}/groups/slack:A/reset-session`, {
      method: 'POST',
    });
    expect(res.status).toBe(500);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
