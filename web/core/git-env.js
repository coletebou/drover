// The environment for a git child process: no tracing (curl traces print headers), no prompts, nothing inherited that
// points git elsewhere, and no config given through the environment (git -c of a parent, GIT_CONFIG_COUNT/KEY_n/VALUE_n
// could add a credential helper after a -c reset). extra is applied last; a key set to null there is removed.
export function gitEnv(extra = {}, base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^GIT_(TRACE|CURL_VERBOSE|REDACT_COOKIES)/.test(k)) delete env[k];
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[k];
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  const out = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C', GIT_PAGER: 'cat', ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === null) delete out[k];
  return out;
}
