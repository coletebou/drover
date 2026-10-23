// Local embeddings: EmbeddingGemma 2 (text model, Q8_0 GGUF) served by llama.cpp's
// llama-server, a child of the daemon. Started on first need, bound to 127.0.0.1
// on a free port with a random API key (LLAMA_API_KEY in its environment, which only
// its owner can read; never argv), stopped after it has been idle a while. Nothing leaves the machine.
// Measured 2026-10-14: 16.4k tokens/s on an M5 Pro with Metal, 950 tokens/s on
// a 16-thread Xeon 8259CL, ~10-50 ms per search query.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { cpus, platform } from 'node:os';
import path from 'node:path';
import { truncateNormalize, DIMS } from './vec.js';
import { envvar } from '../envvars.js';
import { stateDir, shareDir } from '../paths.js';

export const EMBED_HOME = envvar('EMBED_HOME') ?? path.join(shareDir(), 'embed');
export const MODEL_FILE = 'embeddinggemma-2-Q8_0.gguf';
export const MODEL_SHA256 = '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135';
/** Index identity: a different model file or dimension count means stored vectors must be rebuilt. */
export const MODEL_ID = `embeddinggemma-2-q8_0@${MODEL_SHA256.slice(0, 12)}/${DIMS}`;
// The model card's task prefixes (text inputs only).
export const queryText = (q) => `task: search result | query: ${q}`;
export const docText = (title, text) => `title: ${String(title || 'none').replace(/\s+/g, ' ').slice(0, 200)} | text: ${text}`;

export function paths(env = process.env) {
  return {
    server: envvar('LLAMA_SERVER', env) ?? path.join(EMBED_HOME, 'bin', 'llama-server'),
    model: envvar('EMBED_MODEL', env) ?? path.join(EMBED_HOME, 'models', MODEL_FILE),
  };
}
export function installed(env = process.env) { const p = paths(env); return existsSync(p.server) && existsSync(p.model); }

/**
 * Identity of the model that will make the vectors. The pinned GGUF has MODEL_ID; a different file
 * (DROVER_EMBED_MODEL) is identified by name, size and mtime, so switching models drops the old vectors
 * instead of comparing embeddings from two different spaces.
 */
export function modelIdFor(env = process.env) {
  const p = paths(env).model;
  if (path.basename(p) === MODEL_FILE && !envvar('EMBED_MODEL', env)) return MODEL_ID;
  try { const s = statSync(p); return `${path.basename(p)}@${s.size}-${Math.round(s.mtimeMs)}/${DIMS}`; } catch { return `${path.basename(p)}@missing/${DIMS}`; }
}

const pidFile = (env) => path.join(stateDir({ HOME: '', ...env }), 'embed-server.pid');

/** Is pid a running llama-server? (Checked by command, so a recycled pid is never killed.) */
export function isLlamaServer(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const cmd = existsSync(`/proc/${pid}/cmdline`) ? readFileSync(`/proc/${pid}/cmdline`, 'utf8') : execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return /llama-server/.test(cmd);
  } catch { return false; }
}

/** A server left behind by a daemon that died hard (SIGKILL, crash): stop it before starting another. */
function reapOrphan(env) {
  try {
    const pid = Number(readFileSync(pidFile(env), 'utf8').trim());
    if (isLlamaServer(pid)) process.kill(pid, 'SIGTERM');
  } catch { /* no pid file */ }
  try { rmSync(pidFile(env), { force: true }); } catch { /* fine */ }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** CPU threads for a CPU-only box: a quarter of the cores, 2 to 8, unless DROVER_EMBED_THREADS says otherwise. */
export function defaultThreads(env = process.env, n = cpus().length) {
  const t = Number(envvar('EMBED_THREADS', env));
  if (Number.isInteger(t) && t > 0) return t;
  return Math.max(2, Math.min(8, Math.floor(n / 4)));
}

/**
 * Inputs per backfill request. A query waits behind the request in flight, so a
 * CPU box (≈950 tokens/s) sends 4 (≈2 s) and a Metal Mac (≈16k tokens/s) 16.
 */
export function defaultBatch(env = process.env, os = platform()) {
  const b = Number(envvar('EMBED_BATCH', env));
  return Number.isInteger(b) && b > 0 ? Math.min(b, 64) : os === 'darwin' ? 16 : 4;
}

export class Embedder {
  constructor({ env = process.env, idleMs = 10 * 60_000, spawnFn = spawn, fetchFn = fetch, log = () => {} } = {}) {
    this.env = env; this.idleMs = idleMs; this.spawnFn = spawnFn; this.fetchFn = fetchFn; this.log = log;
    this.batch = defaultBatch(env);
    this.child = null; this.port = null; this.key = null; this.ready = false; this.starting = null; this.idleTimer = null;
    this.stats = { started: 0, requests: 0, inputs: 0, tokens: 0, ms: 0, lastError: null, exits: 0, retries: 0 };
    this.onExit = () => this.stop();
  }
  /** Up and answering: set only after /health succeeds, so a caller during model load waits on `starting`. */
  get running() { return Boolean(this.child && this.port && this.ready); }
  installed() { return installed(this.env); }
  modelId() { return modelIdFor(this.env); }

  async #start() {
    const { server, model } = paths(this.env);
    if (!existsSync(server) || !existsSync(model)) throw new Error(`embedding runtime not installed (run drover embed setup): ${!existsSync(server) ? server : model}`);
    const port = await freePort();
    const key = randomBytes(18).toString('base64url');
    const mac = platform() === 'darwin';
    // Two slots: a search query gets its own while a backfill request is in flight. Each input must fit
    // one ubatch (non-causal model), and chunks are ~400-600 tokens, so 4096 leaves room.
    const args = ['-m', model, '--embedding', '--host', '127.0.0.1', '--port', String(port),
      '-c', '16384', '-b', '4096', '-ub', '4096', '--parallel', '2', '-t', String(defaultThreads(this.env)),
      '-ngl', mac ? '99' : '0', '--no-webui'];
    // Linux boxes are shared CPU hosts: run the backfill at low priority.
    const [file, argv] = !mac && existsSync('/usr/bin/nice') ? ['/usr/bin/nice', ['-n', '15', server, ...args]] : [server, args];
    reapOrphan(this.env);
    const child = this.spawnFn(file, argv, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...this.env, LLAMA_API_KEY: key } });
    if (child.pid) { try { writeFileSync(pidFile(this.env), `${child.pid}\n`, { mode: 0o600 }); } catch { /* state dir missing: no orphan reaping */ } }
    process.removeListener('exit', this.onExit); process.once('exit', this.onExit);
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('exit', (code, sig) => {
      this.stats.exits++;
      const wanted = child.droverStopped === true;
      if (this.child === child) { this.child = null; this.port = null; this.key = null; this.ready = false; }
      // A crash is a non-zero code or any signal we did not send (SIGABRT from a failed assert, SIGSEGV, OOM SIGKILL).
      if (!wanted && (code !== 0 || sig)) {
        const tail = stderr.trim().split('\n').filter((l) => /error|assert|abort|fail|exceed|terminate/i.test(l)).slice(-2).join(' | ') || stderr.trim().split('\n').at(-1) || '';
        this.stats.lastError = `llama-server exited ${code ?? sig}: ${tail}`.slice(0, 400);
        this.log(this.stats.lastError);
      }
    });
    child.on('error', (e) => { this.stats.lastError = `spawn: ${e.message}`; });
    this.child = child; this.port = port; this.key = key;
    const t0 = Date.now();
    for (;;) {
      if (this.child !== child) throw new Error(this.stats.lastError ?? 'llama-server exited during start');
      try {
        const r = await this.fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch { /* not listening yet */ }
      if (Date.now() - t0 > 120_000) { this.stop(); throw new Error('llama-server did not become healthy in 120 s'); }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.ready = true;
    this.stats.started++;
    this.log(`embedder up on 127.0.0.1:${port} in ${Date.now() - t0} ms`);
  }

  async ensure() {
    if (this.running) return;
    this.starting ??= this.#start().finally(() => { this.starting = null; });
    await this.starting;
  }

  #touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * Embed texts (already prefixed with queryText / docText) and return
   * 256-dim normalized Float32Arrays in input order.
   */
  async embed(texts) {
    if (!texts.length) return [];
    const t0 = Date.now();
    const res = await this.#post(texts);
    if (!res.ok) { const msg = `embed HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`; this.stats.lastError = msg; throw new Error(msg); }
    const body = await res.json();
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) throw new Error(`embed returned ${data.length} vectors for ${texts.length} inputs`);
    this.stats.requests++; this.stats.inputs += texts.length; this.stats.tokens += body.usage?.prompt_tokens ?? 0; this.stats.ms += Date.now() - t0;
    this.#touch();
    return data.map((d) => truncateNormalize(d.embedding, DIMS));
  }

  /**
   * POST /v1/embeddings. llama-server's HTTP layer closes keep-alive connections after a
   * few requests or a short idle, and fetch may reuse one just as it closes (ECONNRESET,
   * seen on 2026-10-15 every ~100 inputs). Embedding is idempotent, so a network-level
   * failure is retried on a fresh connection, restarting the server if it died; a
   * timeout or an HTTP error is not retried.
   */
  async #post(texts) {
    for (let attempt = 0; ; attempt++) {
      await this.ensure();
      this.#touch();
      try {
        return await this.fetchFn(`http://127.0.0.1:${this.port}/v1/embeddings`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ input: texts }), signal: AbortSignal.timeout(300_000),
        });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        if (timeout || attempt >= 2) { this.stats.lastError = `embed request: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`; throw e; }
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }

  stop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const c = this.child; this.child = null; this.port = null; this.key = null; this.ready = false;
    process.removeListener('exit', this.onExit);
    if (c) {
      c.droverStopped = true;
      try { c.kill('SIGTERM'); } catch { /* gone */ }
      try { rmSync(pidFile(this.env), { force: true }); } catch { /* fine */ }
    }
  }

  status() {
    const p = paths(this.env);
    const { ms, tokens } = this.stats;
    return { installed: this.installed(), running: this.running, server: p.server, model: p.model, modelId: this.modelId(), threads: defaultThreads(this.env), batch: this.batch, ...this.stats, tokensPerSec: ms ? Math.round(tokens / (ms / 1000)) : null };
  }
}
