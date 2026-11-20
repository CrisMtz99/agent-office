// The OS door (os-door/): a local command center's way into every floor's workers.
import { OS_DOOR_PREFIX, osDoor } from '../../os-door/index.js';
import type { Route } from '../router.js';

export const osDoorRoutes = {
  // Public in the table only because it isn't a browser's: osDoor itself turns away anyone not on
  // this computer (403) or without the OS door token as its bearer token (401), before anything else.
  door: { prefix: OS_DOOR_PREFIX, auth: 'public', handle: (ctx, r) => osDoor(ctx, r) },
} satisfies Record<string, Route>;
