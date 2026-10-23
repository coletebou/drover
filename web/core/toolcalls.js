// Tool calls as a person reads them: one plain line per call (the command, the file, the pattern) and the
// output of each call, keyed by its id, so a chat can show "Bash: npm test" with the result under it instead
// of a bare "Bash" chip. Pure; claude.js and codex.js shape their transcript turns with it.
import { redactSecrets } from './native.js';

const SUMMARY_MAX = 200;
export const RESULT_MAX = 2000;
const HOME = /\/(?:Users|home)\/[^\/\s]+/g;
// This process's own home too, wherever it is (a service user's or a CI runner's, outside /Users and /home), as a
// whole path part: /root/x and /root folded, /rooty left alone.
const ownHome = String(process.env.HOME ?? '').replace(/\/+$/, '');
const OWN_HOME = ownHome.length > 1 ? new RegExp(ownHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|[^\\w.-]|$)', 'g') : null;

/** One line: first line of the text, home dirs as ~, secrets redacted (over a bounded window), at most max chars. */
export function oneLine(text, max = SUMMARY_MAX) {
  if (text == null) return '';
  const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const head = first.slice(0, max * 2);
  const s = redactSecrets((OWN_HOME ? head.replace(OWN_HOME, '~') : head).replace(HOME, '~')).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const firstString = (input) => {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v;
  return '';
};
const patchFiles = (patch) => [...String(patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
const shellCommand = (input) => {
  const c = input?.command ?? input?.cmd;
  if (Array.isArray(c)) {
    // ["bash", "-lc", "npm test"]: the script is the command a person typed.
    const i = c.findIndex((x) => x === '-lc' || x === '-c');
    return i >= 0 && typeof c[i + 1] === 'string' ? c[i + 1] : c.join(' ');
  }
  return typeof c === 'string' ? c : '';
};

/** The line a chat shows for a call: `npm test` for Bash, the path for Read and Edit, `"x" in dir` for Grep. */
export function toolSummary(name, input) {
  const n = String(name ?? '');
  const i = input && typeof input === 'object' ? input : {};
  const base = n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  let s;
  switch (n) {
    case 'Bash': case 'shell': case 'exec_command': case 'local_shell': s = shellCommand(i); break;
    case 'BashOutput': case 'KillShell': case 'KillBash': s = i.bash_id ?? i.shell_id ?? ''; break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': s = i.file_path ?? i.path ?? ''; break;
    case 'NotebookEdit': case 'NotebookRead': s = i.notebook_path ?? i.file_path ?? ''; break;
    case 'Grep': s = i.pattern ? `"${i.pattern}"${i.path ? ` in ${i.path}` : i.glob ? ` in ${i.glob}` : ''}` : ''; break;
    case 'Glob': s = i.pattern ? `${i.pattern}${i.path ? ` in ${i.path}` : ''}` : ''; break;
    case 'WebFetch': s = i.url ?? ''; break;
    case 'WebSearch': case 'ToolSearch': s = i.query ?? ''; break;
    case 'Task': case 'Agent': s = [i.description, i.subagent_type ? `(${i.subagent_type})` : null].filter(Boolean).join(' '); break;
    case 'TodoWrite': s = Array.isArray(i.todos) ? `${i.todos.length} item${i.todos.length === 1 ? '' : 's'}` : ''; break;
    case 'update_plan': s = Array.isArray(i.plan) ? `${i.plan.length} step${i.plan.length === 1 ? '' : 's'}` : ''; break;
    case 'AskUserQuestion': s = (Array.isArray(i.questions) ? i.questions[0]?.question : i.question) ?? ''; break;
    case 'Skill': s = [i.skill, i.args].filter(Boolean).join(' '); break;
    case 'SendMessage': case 'send_message': s = i.to ?? i.target ?? ''; break;
    case 'spawn_agent': s = i.task_name ?? i.agent_type ?? ''; break;
    case 'apply_patch': { const f = patchFiles(typeof input === 'string' ? input : i.input ?? i.patch); s = f.length ? f.join(', ') : ''; break; }
    case 'exec': {
      // Codex's code-mode tool: JS that usually calls tools.exec_command({cmd: "..."}); the command is the useful part.
      const code = typeof input === 'string' ? input : i.input ?? i.code ?? '';
      const m = String(code).match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/) ?? String(code).match(/cmd\s*:\s*'((?:[^'\\]|\\.)*)'/);
      s = m ? m[1].replace(/\\(["'\\])/g, '$1').replace(/\\n/g, ' ') : code;
      break;
    }
    default: s = base !== n && i.query ? i.query : firstString(input);
  }
  return oneLine(s);
}

/** Bash's own description of a call ("Show repo history"), when the agent gave one. */
export function toolDescription(name, input) {
  return name === 'Bash' && typeof input?.description === 'string' && input.description.trim() ? oneLine(input.description, 120) : null;
}

/** A tool_result's content (a string, or text and image blocks) as plain text; images become [image]. */
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((b) => (b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text' ? b.text ?? '' : b?.type === 'image' || b?.type === 'input_image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** One result as a chat shows it: the output cut to RESULT_MAX chars, with its full length. */
export function resultEntry(toolUseId, content, { isError = false } = {}) {
  const text = resultText(content);
  return { toolUseId: toolUseId ?? null, isError: Boolean(isError), text: text.length > RESULT_MAX ? text.slice(0, RESULT_MAX) : text, chars: text.length };
}

/** Codex prints "Process exited with code N" in a command's output; anything but 0 is a failed call. */
export function codexOutputFailed(text) {
  const m = String(text ?? '').match(/Process exited with code (-?\d+)/);
  return m ? Number(m[1]) !== 0 : false;
}
