// The OS door: a way into every floor's workers for a command center running on this computer (the
// "Agentic OS" and its supervisor), which isn't a worker with a hook token nor a signed-in browser.
// It sends the office's OS door token (token.ts) as its bearer token, from loopback only:
//
//   GET    /api/os/workers               { floors: { id, name, repo, workers: WorkerRow[] }[] }
//   POST   /api/os/workers               { floor, provider?, task }  ->  201 { id }
//   POST   /api/os/workers/:id/message   { text }                    ->  204
//   DELETE /api/os/workers/:id                                       ->  204, or 409 holding work
//
// Hiring and telling go the way /office/workers does (hooks/office-workers.ts); see docs/os-door.md.

import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { readHireRequest, workerRow } from '../office-workers.js';
import { hireWorker, pullsView, tellWorker } from '../hooks/office-workers.js';
import type { Ctx } from '../office/context.js';
import type { Floor } from '../floor.js';
import { readBody, send } from '../http/util.js';
import type { RouteRequest } from '../http/router.js';
import { ensureOsDoorToken } from './token.js';

/** Who the floors hear did it, and whom a worker hired from the door says hired it. */
export const OS_DOOR_WHO = 'Jarvis';

export const OS_DOOR_PREFIX = '/api/os/';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether a peer's address is this computer's own. */
export const isLoopback = (address: string | undefined) => !!address && LOOPBACK.has(address);

/** Headers a proxy adds when it passes on someone else's request: then loopback isn't who's asking. */
const PROXIED = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

/** Whether an Authorization header carries `token` as its bearer token, compared in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'utf8');
  const want = Buffer.from(token, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The OS door: every request under /api/os/, checked here (the route table has it as public). */
export async function osDoor(ctx: Ctx, { req, res, path: p }: RouteRequest): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress) || PROXIED.some((h) => req.headers[h] !== undefined)) return send(res, 403, { error: 'The OS door only opens to this computer' });
  // Never logged or echoed: only whether it matched.
  if (!bearerMatches(req.headers.authorization, ensureOsDoorToken(ctx.cfg.dataDir))) return send(res, 401, { error: 'Send the OS door token (agent-office os-door token) as the bearer token' });

  const rest = p.slice(OS_DOOR_PREFIX.length).split('/');
  if (rest[0] !== 'workers' || rest.length > 3 || (rest.length === 3 && rest[2] !== 'message') || (rest.length > 1 && !rest[1])) return send(res, 404, { error: 'No such OS door route' });
  const id = rest[1];
  const method = req.method ?? 'GET';

  if (!id) {
    if (method === 'GET') return list(ctx, res);
    if (method === 'POST') return hire(ctx, req, res);
    return send(res, 405, { error: 'GET or POST /api/os/workers' }, { allow: 'GET, POST' });
  }
  if (rest.length === 3) {
    if (method !== 'POST') return send(res, 405, { error: 'POST /api/os/workers/:id/message' }, { allow: 'POST' });
    return message(ctx, req, res, id);
  }
  if (method !== 'DELETE') return send(res, 405, { error: 'DELETE /api/os/workers/:id' }, { allow: 'DELETE' });
  return sendHome(ctx, res, id);
}

function list(ctx: Ctx, res: http.ServerResponse) {
  const floors = [...ctx.floors.values()].map((floor) => {
    const view = pullsView(ctx, floor);
    return { id: floor.id, name: floor.def.name, repo: floor.def.repo ?? '', workers: floor.workers.list().map((w) => workerRow(w, view)) };
  });
  send(res, 200, { floors });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The floor `key` names: its id, or its name in any case. */
function floorOf(ctx: Ctx, key: unknown): Floor | undefined {
  if (typeof key !== 'string' || !key.trim()) return undefined;
  const k = key.trim();
  return ctx.floors.get(k) ?? [...ctx.floors.values()].find((f) => f.def.name.toLowerCase() === k.toLowerCase());
}

async function hire(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'Send a JSON object: { floor, provider?, task }' });
  const floor = floorOf(ctx, body.floor);
  if (!floor) return send(res, 404, { error: `No floor ${typeof body.floor === 'string' ? body.floor : '(say which: floor)'} (there's ${[...ctx.floors.keys()].join(', ') || 'none'})` });
  const ask = readHireRequest({ prompt: body.task, ...(body.provider !== undefined ? { provider: body.provider } : {}) }, floor.project.agentProviders);
  if (typeof ask === 'string') return send(res, 400, { error: ask.replace('prompt', 'task') });
  // Runs as the office itself: the door has no account of its own to run as.
  const hired = await hireWorker(ctx, floor, ask, OS_DOOR_WHO);
  if ('error' in hired) return send(res, hired.status, { error: hired.error });
  send(res, 201, { id: hired.worker.id });
}

async function message(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const floor = ctx.workerFloor(id);
  const w = floor?.workers.get(id);
  if (!floor || !w) return send(res, 404, { error: `No worker ${id}` });
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'Send a JSON object: { text }' });
  const err = tellWorker(floor, w, typeof body.text === 'string' ? body.text.slice(0, 20000) : '', OS_DOOR_WHO);
  if (err) return send(res, 400, { error: err.replace('prompt', 'text') });
  res.writeHead(204, { 'cache-control': 'no-store' }).end();
}

/**
 * Sends a worker home, unless its worktree holds work that isn't on GitHub (uncommitted changes, or
 * commits its merged pull requests didn't deliver): then 409 and it stays, where the office's own
 * send-home would let it go and keep the worktree.
 */
async function sendHome(ctx: Ctx, res: http.ServerResponse, id: string) {
  const floor = ctx.workerFloor(id);
  const w = floor?.workers.get(id);
  if (!floor || !w) return send(res, 404, { error: `No worker ${id}` });
  const landed = floor.landed(w);
  const held = await floor.workers.holdsWork(id, landed?.head, landed?.heads).catch(() => true);
  if (held) return send(res, 409, { error: `${w.name} holds work that isn't pushed (uncommitted changes or unpushed commits): push it, or send it home from the office` });
  if (floor.workers.get(id) !== w) return send(res, 404, { error: `${w.name} already went home` });
  ctx.toastFloor(floor, `${OS_DOOR_WHO} sent ${w.name} home`);
  const { note, error } = await floor.sendHome(id);
  if (note) ctx.toastFloor(floor, note);
  if (error) ctx.toastFloor(floor, error, 'warn');
  res.writeHead(204, { 'cache-control': 'no-store' }).end();
}
