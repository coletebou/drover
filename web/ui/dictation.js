// Push-to-talk dictation for the composer through the Web Speech API.
//
// On-device first: Chrome can run recognition locally (SpeechRecognition with
// processLocally, or the older mode "ondevice-only"), after a one-time language
// pack install. When only Chrome's cloud recognizer is available, audio would
// go to Google's servers; that path stays off unless the owner turns on
// dictation.allowCloud in Settings, and the UI says which one is in use.
const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;

export function supported() { return Boolean(SR); }

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown' (API too old to say). */
export async function onDeviceStatus(lang = 'en-US') {
  if (!SR) return 'unavailable';
  try {
    if (typeof SR.available === 'function') return await SR.available({ langs: [lang], processLocally: true });
    if (typeof SR.availableOnDevice === 'function') return await SR.availableOnDevice(lang);
  } catch { return 'unknown'; }
  return 'unknown';
}

/** Download the on-device language pack (Chrome asks once). Resolves true when installed. */
export async function installOnDevice(lang = 'en-US') {
  if (!SR) throw new Error('This browser has no speech recognition');
  if (typeof SR.install === 'function') return Boolean(await SR.install({ langs: [lang], processLocally: true }));
  if (typeof SR.installOnDevice === 'function') return Boolean(await SR.installOnDevice(lang));
  throw new Error('This Chrome cannot install on-device speech packs (needs Chrome 139 or later)');
}

/**
 * Which engine a start() would use: { engine: 'on-device'|'cloud'|null, status, reason }.
 * engine null means dictation is not allowed right now (reason says why).
 */
export async function plan({ lang = 'en-US', allowCloud = false } = {}) {
  if (!SR) return { engine: null, status: 'unavailable', reason: 'This browser has no speech recognition.' };
  const status = await onDeviceStatus(lang);
  if (status === 'available') return { engine: 'on-device', status, reason: 'On-device recognition: audio stays on this Mac.' };
  if (allowCloud) return { engine: 'cloud', status, reason: 'Cloud recognition: Chrome sends the audio to Google for transcription.' };
  const why = status === 'downloadable' ? 'Install the on-device language pack in Settings, or allow cloud recognition there.'
    : status === 'downloading' ? 'The on-device language pack is still downloading.'
      : 'On-device recognition is not available here; cloud recognition is off (Settings, Dictation).';
  return { engine: null, status, reason: why };
}

/**
 * Start listening. Callbacks: onText(finalText, interimText) on every result,
 * onEnd(finalText), onError(message). Returns { stop(), abort(), engine }.
 */
export async function start({ lang = 'en-US', allowCloud = false, onText, onEnd, onError, onState } = {}) {
  const p = await plan({ lang, allowCloud });
  if (!p.engine) throw new Error(p.reason);
  const rec = new SR();
  rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  if (p.engine === 'on-device') {
    if ('processLocally' in rec) rec.processLocally = true;
    else if ('mode' in rec) rec.mode = 'ondevice-only';
  }
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += (finalText && !/\s$/.test(finalText) ? ' ' : '') + r[0].transcript.trim();
      else interim += r[0].transcript;
    }
    onText?.(finalText, interim.trim());
  };
  rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') onError?.(e.error === 'not-allowed' ? 'Microphone access was refused' : e.error === 'language-not-supported' ? `No recognizer for ${lang}` : `Speech recognition: ${e.error}`); };
  rec.onstart = () => onState?.('listening');
  rec.onend = () => { onState?.('idle'); onEnd?.(finalText); };
  rec.start();
  return { engine: p.engine, stop: () => { try { rec.stop(); } catch { /* already stopped */ } }, abort: () => { try { rec.abort(); } catch { /* fine */ } } };
}
