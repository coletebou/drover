// Load settings and secrets into process.env: every ~/.config/drover/*.env file (DROVER_CONFIG_DIR; non-secret
// settings such as DROVER_OWNER, DROVER_PLUGINS, DROVER_DEFAULT_REPO), in name order, then ~/.env_secrets (tokens a
// plugin or the credential pool needs). A variable already set in the environment wins. Values never leave
// process.env: nothing here logs, returns or stores them.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envvar } from './envvars.js';

/** The secrets file: DROVER_SECRETS_FILE, read when called (a settings file may set it), else ~/.env_secrets. */
export const secretsFile = () => envvar('SECRETS_FILE') ?? path.join(process.env.HOME, '.env_secrets');
/** The secrets file as this process started (before any settings file); plugins should call secretsFile(). */
export const SECRETS_FILE = secretsFile();
export const CONFIG_DIR = envvar('CONFIG_DIR') ?? path.join(process.env.HOME, '.config', 'drover');

/** The settings files: CONFIG_DIR/*.env in name order (none when the directory is missing). */
export async function configFiles(dir = CONFIG_DIR) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((n) => n.endsWith('.env')).sort().map((n) => path.join(dir, n));
}

/** The settings files only (every command reads them). Returns only the NAMES that were set. */
export async function loadSettings({ configDir = CONFIG_DIR, override = false } = {}) {
  const loaded = [];
  for (const f of await configFiles(configDir)) loaded.push(...(await loadEnvFile({ file: f, override })).loaded);
  return { loaded };
}

/** The settings files, then the secrets file. Returns only the NAMES that were set. */
export async function loadSecrets({ file, configDir = CONFIG_DIR, override = false } = {}) {
  const { loaded } = await loadSettings({ configDir, override });
  const r = await loadEnvFile({ file: file ?? secretsFile(), override });
  return { ...r, loaded: [...loaded, ...r.loaded] };
}

/** Parse KEY=VALUE / export KEY=VALUE / KEY="quoted" lines. Returns only the NAMES that were set. */
export async function loadEnvFile({ file, override = false } = {}) {
  if (!existsSync(file)) return { file, loaded: [], missing: true };
  const text = await readFile(file, 'utf8');
  const loaded = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, name, value] = m;
    value = value.replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!override && process.env[name] !== undefined) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return { file, loaded, missing: false };
}

export function haveSecret(name) { return typeof process.env[name] === 'string' && process.env[name].length > 0; }
