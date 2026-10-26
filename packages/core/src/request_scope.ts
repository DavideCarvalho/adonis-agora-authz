import { HttpContext } from '@adonisjs/core/http';
import { readContextAccessor } from './agora/context.js';

/**
 * The object that identifies the current request, for keying per-request memos:
 * the active Agora context store when `@adonis-agora/context` is installed, else
 * the AdonisJS `HttpContext` when the app enables `useAsyncLocalStorage`.
 * `undefined` outside a request (or when neither source is available).
 */
export function currentRequestScope(): object | undefined {
  const accessor = readContextAccessor();
  if (typeof accessor?.get === 'function') {
    try {
      const store = accessor.get();
      if (store != null && typeof store === 'object') return store;
    } catch {
      // A broken accessor degrades to the next source.
    }
  }
  try {
    return HttpContext.get() ?? undefined;
  } catch {
    return undefined;
  }
}
