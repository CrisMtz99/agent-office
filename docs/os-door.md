# The OS door

Back to the [README](../README.md).

A command center running on the same computer as the office (a local "OS" with a supervisor agent that keeps an eye on everything) can list, hire, message and send home the office's workers on **every floor**, without being a worker itself or a signed-in browser. It knocks on `/api/os/*` with the office's OS door token.

`/office/workers` (on the hook port) answers only the office's own workers, with their own hook token, about their own floor; the rest of `/api/*` needs a browser's sign-in. The OS door is the third way in, for one trusted program on this machine.

## The token

The first time the office starts, it makes `.agent-office/os-door-token` in its home: 32 random bytes in hex, readable only by you (mode `600`; on Windows, the permissions the folder hands down are taken off and your user is granted it, which leaves no other ordinary user in). It stays the same across restarts. Delete the file to change it: the office makes a new one the next time it's needed.

Print it with:

```bash
agent-office os-door token                      # an office started here, or in $AGENT_OFFICE_HOME / ~/agent-office
agent-office os-door token --home ~/my-office   # an office started with --home ~/my-office
```

The command center can also read the file itself: `<home>/.agent-office/os-door-token` (for `agent-office --home C:\Users\me\.agent-office-data`, that's `C:\Users\me\.agent-office-data\.agent-office\os-door-token`).

## Who gets in

Every request needs both:

- **From this computer.** The peer has to be `127.0.0.1`, `::1` or `::ffff:127.0.0.1`, and the request can't carry `X-Forwarded-For`, `X-Real-IP` or `Forwarded` (a reverse proxy on this machine passing someone else's request on). Anything else gets `403`, token or not.
- **The token,** as `Authorization: Bearer <token>`. Missing or wrong gets `401`. It's compared in constant time and never logged.

## Routes

All answers are JSON except `204`s, which have no body. Errors are `{ "error": "…" }`.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /api/os/workers` | | `200 { floors: { id, name, repo, workers: WorkerRow[] }[] }` |
| `POST /api/os/workers` | `{ floor, provider?, task }` | `201 { id }` |
| `POST /api/os/workers/:id/message` | `{ text }` | `204` |
| `DELETE /api/os/workers/:id` | | `204` |

- **`GET`** lists every floor, in the elevator's order, with each worker as `office-workers list --json` shows it (`WorkerRow` in `src/server/office-workers.ts`: `id`, `name`, `kind`, `provider`, `status`, `task`, `activity`, `worktree`, `pr`, `merged`, …). `repo` is `""` for a floor that isn't a GitHub repository.
- **`POST /api/os/workers`** hires an agent on `floor` (its id, or its name) with `task` as its first prompt, the way `office-workers hire` does: the next free desk, its own worktree when the floor is a git checkout, and `provider` (one of the floor's agents, else the office's default). The floor hears *Jarvis hired …*. `404` for no such floor, `400` for no task or an unknown provider, `409` when every desk is taken.
- **`POST /api/os/workers/:id/message`** types `text` to that agent as its next prompt; a stopped or asleep one wakes up with it. `404` for no such worker, `400` for an empty text, a shell, or one waiting on an answer in its terminal.
- **`DELETE /api/os/workers/:id`** sends that worker home, its worktree and branch with it. If its worktree holds work that isn't on GitHub (uncommitted changes, or commits that its merged pull requests didn't deliver), it answers `409` and the worker stays: push the work, or send it home from the office, which keeps the worktree. `404` for no such worker.

```bash
TOKEN=$(agent-office os-door token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4600/api/os/workers
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"floor":"app","task":"Fix the flaky login test"}' http://127.0.0.1:4600/api/os/workers
```

The code is in `src/server/os-door/` (`index.ts` answers, `token.ts` keeps the token), and its one route is `osDoorRoutes.door` in `src/server/http/routes/`.
