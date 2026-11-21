// Messages Claude Code records outside its user records. Pure; every reader of Claude transcripts (claude.js turns,
// transcript-export.js entries, search/extract.js index units, search/grep.js parts) asks this one module.
//
// A message that reaches a session while a turn runs is queued, and when the model sees it Claude Code (verified on
// 2.1.278 through 2.1.330) writes it as an attachment, never as a user record:
//
//   { type: 'attachment', attachment: { type: 'queued_command', prompt, origin: { kind, ... }, isMeta?, commandMode? },
//     rendered: [{ content: '<system-reminder>The user sent a new message while you were working: ...' }],
//     renderedRole: 'system', userType: 'external', uuid, timestamp, sessionId, agentId?, isSidechain? }
//
// That covers what the owner types into a busy session's prompt box, and everything typed into the agent panel's
// "Message @<agent>" box for a background subagent (its own transcript, subagents/agent-<id>.jsonl). prompt is a
// string or content blocks (text, image). origin.kind says who sent it:
//   human               the owner typing
//   peer                another session's inbox message (or Drover relaying the owner): its body is origin.body
//   coordinator         the session that started a subagent, writing to it
//   task-notification, auto-continuation   Claude Code's own bookkeeping: not a message
// A subagent's copy is marked isMeta even when the owner typed it, and a task notification is not, so isMeta does not
// tell them apart: origin does. Before origin existed (2.1.2xx) commandMode "prompt" marked a typed one.

/** "drover (<actor>)" (and "apx-web (<actor>)" before the rename): someone typing through Drover, the owner as OWNER. */
const RELAY = /^(?:drover|apx-web)\s*\(([^)]+)\)$/i;

/**
 * Who sent an inbox message, from its origin ({ kind: 'peer', name, body }): via 'drover' with the actor Drover relayed,
 * or via 'peer' with the sending session's name in from. null when the origin is not a peer message with a body.
 */
export function peerSender(o) {
  if (o?.kind !== 'peer' || typeof o.body !== 'string') return null;
  const from = typeof o.name === 'string' ? o.name : null;
  const relay = from?.match(RELAY);
  return { via: relay ? 'drover' : 'peer', from: relay ? null : from, actor: relay ? relay[1] : null };
}

/** The strings a prompt is made of (text blocks, in order) and how many images it carried. */
function promptParts(p) {
  if (typeof p === 'string') return { parts: p ? [p] : [], images: 0 };
  if (!Array.isArray(p)) return { parts: [], images: 0 };
  const parts = [];
  let images = 0;
  for (const b of p) {
    if (typeof b === 'string') { if (b) parts.push(b); }
    else if (b?.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text);
    else if (b?.type === 'image') images++;
  }
  return { parts, images };
}

/**
 * The message a queued_command attachment carries, or null for any other record and for Claude Code's bookkeeping:
 * { kind: 'human' | 'peer' | 'coordinator', via, from, actor, text, parts, images }. via is 'queued' for the owner's
 * own typing, 'drover' or 'peer' for an inbox message (as peerSender), 'coordinator' for the parent session writing
 * to its subagent (actor and from 'coordinator', so a client names it rather than reading it as the owner's). parts are the strings as the record holds them (grep places matches in them); text joins them.
 */
export function queuedMessage(d) {
  if (d?.type !== 'attachment') return null;
  const a = d.attachment;
  if (a?.type !== 'queued_command') return null;
  const kind = a.origin?.kind ?? (a.commandMode === 'prompt' ? 'human' : null);
  if (kind === 'peer') {
    const who = peerSender(a.origin);
    if (!who || !a.origin.body.trim()) return null;
    return { kind, ...who, text: a.origin.body, parts: [a.origin.body], images: 0 };
  }
  if (kind !== 'human' && kind !== 'coordinator') return null;
  const { parts, images } = promptParts(a.prompt);
  const text = parts.join('\n');
  if (!text.trim() && !images) return null;
  return kind === 'human'
    ? { kind, via: 'queued', from: null, actor: null, text, parts, images }
    : { kind, via: 'coordinator', from: 'coordinator', actor: 'coordinator', text, parts, images };
}
