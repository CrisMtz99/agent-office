// The OS door (src/server/os-door/): the local command center's bearer-token way into every floor's
// workers. The handler is called with a fake office: two floors, no git, no terminals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { osDoorRoutes } from '../src/server/http/routes/os-door.js';
import { bearerMatches, isLoopback } from '../src/server/os-door/index.js';
import { ensureOsDoorToken, osDoorTokenPath } from '../src/server/os-door/token.js';
import type { Ctx } from '../src/server/office/context.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function worker(id: string, more: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id, kind: 'agent', deskId: 'desk-1', name: id[0].toUpperCase() + id.slice(1), color: '#fff', status: 'done', acked: false, createdBy: 'Ada', createdAt: 0, cols: 80, rows: 24, viewers: [],
    worktree: { path: `.agent-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' },
    ...more,
  };
}

interface FakeFloor {
  id: string;
  sentHome: string[];
  told: { id: string; text: string; by: string }[];
  hired: { desk: string; by: string; prompt?: string; provider?: string }[];
  held: Set<string>;
  map: Map<string, WorkerInfo>;
}

function fakeOffice() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'os-door-'));
  const floors = new Map<string, unknown>();
  const fakes: Record<string, FakeFloor> = {};
  const toasts: string[] = [];
  const floor = (id: string, repo: string, list: WorkerInfo[]) => {
    const f: FakeFloor = { id, sentHome: [], told: [], hired: [], held: new Set(), map: new Map(list.map((w) => [w.id, w])) };
    fakes[id] = f;
    floors.set(id, {
      id,
      def: { name: id, repo },
      project: { agentProviders: ['claude', 'codex'], branch: '' },
      plan: { wing: 0 },
      github: { pulls: { items: [] }, claim: async () => undefined },
      queue: { state: () => ({ tasks: [] }), dropIssue: () => {} },
      landed: () => undefined,
      sendHome: async (wid: string) => {
        f.sentHome.push(wid);
        f.map.delete(wid);
        return {};
      },
      workers: {
        list: () => [...f.map.values()],
        get: (wid: string) => f.map.get(wid),
        holdsWork: async (wid: string) => f.held.has(wid),
        deskOccupied: (desk: string) => [...f.map.values()].some((w) => w.deskId === desk),
        officeDefault: { provider: 'claude' },
        fetchBase: async () => {},
        ownerOf: () => undefined,
        spawn: (desk: string, by: string, prompt?: string, _wt?: boolean, _kind?: string, provider?: string) => {
          f.hired.push({ desk, by, prompt, provider });
          const w = worker(`new${f.hired.length}`, { deskId: desk, createdBy: by });
          f.map.set(w.id, w);
          return w;
        },
        prompt: (wid: string, text: string, by: string) => {
          f.told.push({ id: wid, text, by });
          return undefined;
        },
        resume: () => undefined,
      },
    });
  };
  floor('app', 'acme/app', [worker('mochi'), worker('pixel', { deskId: 'desk-2' })]);
  floor('api', 'acme/api', [worker('byte')]);
  const ctx = {
    cfg: { dataDir },
    floors,
    workerFloor: (wid: string) => [...floors.values()].find((fl) => (fl as { workers: { get(id: string): unknown } }).workers.get(wid)),
    toastFloor: (_f: unknown, text: string) => toasts.push(text),
  } as unknown as Ctx;
  return { ctx, dataDir, fakes, toasts, token: ensureOsDoorToken(dataDir), done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

interface Answer {
  status: number;
  body: unknown;
}

/** Asks the OS door as the router would: `remote` is the peer's address. */
async function ask(ctx: Ctx, method: string, url: string, opts: { auth?: string; body?: unknown; remote?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method,
    url,
    headers: { ...(opts.auth ? { authorization: opts.auth } : {}), ...opts.headers },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  }) as unknown as http.IncomingMessage;
  let status = 0;
  let out = '';
  const res = {
    headersSent: false,
    writeHead(s: number) {
      status = s;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      out += chunk ?? '';
      return this;
    },
  } as unknown as http.ServerResponse;
  const u = new URL(url, 'http://x');
  await osDoorRoutes.door.handle(ctx, { req, res, url: u, path: decodeURIComponent(u.pathname) });
  return { status, body: out ? JSON.parse(out) : undefined };
}

test('the door is a public route under /api/os/ that checks for itself', () => {
  assert.equal(osDoorRoutes.door.auth, 'public');
  assert.equal(osDoorRoutes.door.prefix, '/api/os/');
});

test('no bearer token: 401', async () => {
  const o = fakeOffice();
  try {
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers')).status, 401);
  } finally {
    o.done();
  }
});

test('a wrong bearer token: 401, whatever its length', async () => {
  const o = fakeOffice();
  try {
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers', { auth: `Bearer ${'0'.repeat(64)}` })).status, 401);
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers', { auth: 'Bearer short' })).status, 401);
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers', { auth: o.token })).status, 401);
  } finally {
    o.done();
  }
});

test('from anywhere but this computer: 403, even with the token', async () => {
  const o = fakeOffice();
  try {
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers', { auth: `Bearer ${o.token}`, remote: '10.0.0.5' })).status, 403);
    // A reverse proxy on this computer passing someone else's request on.
    assert.equal((await ask(o.ctx, 'GET', '/api/os/workers', { auth: `Bearer ${o.token}`, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403);
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
    for (const a of ['10.0.0.5', '::ffff:10.0.0.5', '', undefined]) assert.equal(isLoopback(a), false, String(a));
  } finally {
    o.done();
  }
});

test('with the token, GET lists the workers on every floor', async () => {
  const o = fakeOffice();
  try {
    const r = await ask(o.ctx, 'GET', '/api/os/workers', { auth: `Bearer ${o.token}` });
    assert.equal(r.status, 200);
    const { floors } = r.body as { floors: { id: string; name: string; repo: string; workers: { id: string; name: string; merged: boolean }[] }[] };
    assert.deepEqual(floors.map((f) => [f.id, f.repo, f.workers.map((w) => w.id)]), [['app', 'acme/app', ['mochi', 'pixel']], ['api', 'acme/api', ['byte']]]);
    assert.equal(floors[0].workers[0].name, 'Mochi');
    assert.equal(floors[0].workers[0].merged, false);
  } finally {
    o.done();
  }
});

test('DELETE a worker holding unpushed work: 409, and it stays', async () => {
  const o = fakeOffice();
  try {
    o.fakes.app.held.add('mochi');
    const r = await ask(o.ctx, 'DELETE', '/api/os/workers/mochi', { auth: `Bearer ${o.token}` });
    assert.equal(r.status, 409);
    assert.match((r.body as { error: string }).error, /unpushed|uncommitted|work/i);
    assert.deepEqual(o.fakes.app.sentHome, []);
    assert.ok(o.fakes.app.map.has('mochi'));
  } finally {
    o.done();
  }
});

test('DELETE a worker with nothing left to push: 204, sent home on its own floor', async () => {
  const o = fakeOffice();
  try {
    const r = await ask(o.ctx, 'DELETE', '/api/os/workers/byte', { auth: `Bearer ${o.token}` });
    assert.equal(r.status, 204);
    assert.deepEqual(o.fakes.api.sentHome, ['byte']);
    assert.equal((await ask(o.ctx, 'DELETE', '/api/os/workers/nobody', { auth: `Bearer ${o.token}` })).status, 404);
  } finally {
    o.done();
  }
});

test('POST hires on the floor asked, with the task as its prompt', async () => {
  const o = fakeOffice();
  try {
    const r = await ask(o.ctx, 'POST', '/api/os/workers', { auth: `Bearer ${o.token}`, body: { floor: 'api', provider: 'codex', task: 'Fix the login bug' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: 'new1' });
    assert.equal(o.fakes.api.hired.length, 1);
    assert.equal(o.fakes.api.hired[0].prompt, 'Fix the login bug');
    assert.equal(o.fakes.api.hired[0].provider, 'codex');
    assert.equal(o.fakes.api.hired[0].by, 'Jarvis');
    assert.equal((await ask(o.ctx, 'POST', '/api/os/workers', { auth: `Bearer ${o.token}`, body: { floor: 'nope', task: 'x' } })).status, 404);
    assert.equal((await ask(o.ctx, 'POST', '/api/os/workers', { auth: `Bearer ${o.token}`, body: { floor: 'api' } })).status, 400);
  } finally {
    o.done();
  }
});

test('POST /:id/message types the text to that worker: 204', async () => {
  const o = fakeOffice();
  try {
    const r = await ask(o.ctx, 'POST', '/api/os/workers/pixel/message', { auth: `Bearer ${o.token}`, body: { text: 'Rebase on main' } });
    assert.equal(r.status, 204);
    assert.deepEqual(o.fakes.app.told, [{ id: 'pixel', text: 'Rebase on main', by: 'Jarvis' }]);
    assert.equal((await ask(o.ctx, 'POST', '/api/os/workers/pixel/message', { auth: `Bearer ${o.token}`, body: { text: '  ' } })).status, 400);
  } finally {
    o.done();
  }
});

test('anything else under /api/os/: 404 or 405', async () => {
  const o = fakeOffice();
  try {
    assert.equal((await ask(o.ctx, 'GET', '/api/os/nothing', { auth: `Bearer ${o.token}` })).status, 404);
    assert.equal((await ask(o.ctx, 'PUT', '/api/os/workers', { auth: `Bearer ${o.token}` })).status, 405);
  } finally {
    o.done();
  }
});

test('the token: 32 random bytes in hex, made once and kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-door-token-'));
  try {
    const t = ensureOsDoorToken(dir);
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(ensureOsDoorToken(dir), t);
    assert.equal(readFileSync(osDoorTokenPath(dir), 'utf8').trim(), t);
    if (process.platform !== 'win32') assert.equal(statSync(osDoorTokenPath(dir)).mode & 0o777, 0o600);
    assert.equal(bearerMatches(`Bearer ${t}`, t), true);
    assert.equal(bearerMatches(`bearer ${t}`, t), true);
    assert.equal(bearerMatches(`Bearer ${t.slice(1)}x`, t), false);
    assert.equal(bearerMatches(undefined, t), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
