// Spoken summaries through speechSynthesis. With localOnly (the default) only
// voices the OS renders on this machine (localService) are used, so no alert
// text is sent to a cloud voice.
const synth = globalThis.speechSynthesis ?? null;

export function supported() { return Boolean(synth && globalThis.SpeechSynthesisUtterance); }

/** Voices, waiting briefly for Chrome to load them. */
export async function voices({ localOnly = true } = {}) {
  if (!supported()) return [];
  let list = synth.getVoices();
  if (!list.length) {
    await new Promise((res) => { const t = setTimeout(res, 1200); synth.addEventListener?.('voiceschanged', () => { clearTimeout(t); res(); }, { once: true }); });
    list = synth.getVoices();
  }
  return list.filter((v) => !localOnly || v.localService);
}

function pick(list, voiceURI) {
  return list.find((v) => v.voiceURI === voiceURI) ?? list.find((v) => v.default && /^en/i.test(v.lang)) ?? list.find((v) => /^en/i.test(v.lang)) ?? list[0] ?? null;
}

/** Speak a short line. Returns false when no allowed voice exists. */
export async function speak(text, { voiceURI = '', rate = 1, pitch = 1, localOnly = true } = {}) {
  if (!supported() || !text) return false;
  const list = await voices({ localOnly });
  const v = pick(list, voiceURI);
  if (!v) return false;
  if (synth.speaking || synth.pending) synth.cancel();   // alerts are news; never queue a backlog of them
  const u = new SpeechSynthesisUtterance(String(text).slice(0, 300));
  u.voice = v; u.lang = v.lang; u.rate = rate; u.pitch = pitch;
  synth.speak(u);
  return true;
}
