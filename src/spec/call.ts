import { buildRequest } from './resolve.js';
import { loadToolSpecs } from './loader.js';
import type { ToolSpec } from './types.js';
import { httpService, type HttpResult } from '../services/http.service.js';
import { sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';

let cache: Map<string, ToolSpec> | null = null;

/** Look up a tool definition by name (internal ones included). */
export function getSpec(name: string): ToolSpec {
  if (!cache) cache = new Map(loadToolSpecs().specs.map((s) => [s.name, s]));
  const spec = cache.get(name);
  if (!spec) throw new Error(`Tool definition "${name}" not found in tools/`);
  return spec;
}

/** Raised when the session is missing or could not be renewed. */
export class SessionError extends Error {}

/**
 * Run one tool definition and hand back the raw HTTP result, for the
 * hand-written tools that need to look at the response before answering.
 * Non-2xx answers are returned, not thrown: the cart endpoints answer 400 for
 * business errors the caller has to interpret.
 */
export async function callSpec(name: string, args: Record<string, unknown> = {}): Promise<HttpResult> {
  const spec = getSpec(name);
  if (spec.requires_auth && !sessionService.hasSession() && !sessionService.hasSso()) {
    throw new SessionError(NO_SESSION_MESSAGE);
  }
  const result = await httpService.send(buildRequest(spec, args), { withAuth: spec.requires_auth !== false });
  if (result.status === 401 || result.status === 403) {
    throw new SessionError(
      `Carrefour returned ${result.status} for ${name}. The session is expired and could not be renewed ` +
        `automatically.\n\n${NO_SESSION_MESSAGE}`
    );
  }
  return result;
}
