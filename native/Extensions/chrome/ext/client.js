// Chrome glue: an API client built from stored settings. Used by the service
// worker and every page. Throws ApiError (lib/api.js) with a kind the UI explains.
import { createClient, originPattern, ApiError, ErrorKind } from '../lib/api.js';
import { loadSettings, isConfigured } from '../lib/settings.js';

/** @returns {Promise<{ client: ReturnType<typeof createClient>, settings: object }>} client plus normalized settings */
export async function getClient() {
  const settings = await loadSettings(chrome.storage.local);
  if (!isConfigured(settings)) throw new ApiError(ErrorKind.NOT_CONFIGURED, 'Set the server URL and token in options.');
  const pattern = originPattern(settings.baseUrl);
  const granted = chrome.permissions?.contains ? await chrome.permissions.contains({ origins: [pattern] }) : true;
  if (!granted) throw new ApiError(ErrorKind.NO_PERMISSION, 'Grant access to the server in options.');
  return { client: createClient({ baseUrl: settings.baseUrl, token: settings.token }), settings };
}

/** Error kinds where the fix is in the options page. */
export function needsOptions(err) {
  return [ErrorKind.NOT_CONFIGURED, ErrorKind.NO_PERMISSION, ErrorKind.UNAUTHORIZED, ErrorKind.FORBIDDEN].includes(err?.kind);
}

/** A plain object safe to store or post: never the token, never a stack. */
export function errorInfo(err) {
  return { kind: err?.kind ?? ErrorKind.SERVER, message: String(err?.message ?? 'Something went wrong.').slice(0, 300) };
}
