// Drover's own environment variables are DROVER_<NAME>. Until the apxw shim is
// removed on 2026-11-15 the old APXW_<NAME> spelling still works, so a box whose
// launchd plist, systemd unit or ~/.env_secrets still sets it keeps behaving.
// Every DROVER_* read goes through here; nothing else knows the old prefix.

/** process.env.DROVER_<name>, else the legacy APXW_<name>, else undefined. */
export function envvar(name, env = process.env) {
  return env[`DROVER_${name}`] ?? env[`APXW_${name}`];
}
