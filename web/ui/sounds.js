// Alert sounds, synthesized with WebAudio (no audio files). Each sound is a few
// oscillators or a noise burst through an envelope, short enough to stay polite
// and distinct enough to tell apart with eyes closed. Browsers start an
// AudioContext suspended until the page has seen a gesture; unlock() runs on
// the first pointer or key event, and play() also tries to resume.
let ac = null; let master = null;

function audio() {
  if (ac) return ac;
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  // A gentle limiter so overlapping alerts never clip.
  master = ac.createDynamicsCompressor();
  master.threshold.value = -12; master.knee.value = 12; master.ratio.value = 6; master.attack.value = 0.003; master.release.value = 0.2;
  master.connect(ac.destination);
  return ac;
}
export function unlock() { const c = audio(); if (c && c.state === 'suspended') c.resume().catch(() => {}); }
export function state() { return ac ? ac.state : 'not started'; }
for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, unlock, { capture: true, passive: true });

/** One oscillator note with an attack/decay envelope. */
function tone(t0, { freq, type = 'sine', dur = 0.3, gain = 0.5, attack = 0.005, glideTo, out }) {
  const o = ac.createOscillator(); const g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur * 0.9);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(out); o.start(t0); o.stop(t0 + dur + 0.05);
  return o;
}
let noiseBuf = null;
function noise(t0, { dur = 0.06, freq = 180, q = 4, gain = 0.8, out }) {
  if (!noiseBuf) { noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = ac.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(out); src.start(t0); src.stop(t0 + dur + 0.02);
}

const VOICES = {
  chime(t, out) { tone(t, { freq: 784, dur: 0.45, gain: 0.45, out }); tone(t + 0.13, { freq: 1175, dur: 0.6, gain: 0.4, out }); tone(t + 0.13, { freq: 2350, dur: 0.3, gain: 0.06, out }); },
  ping(t, out) { tone(t, { freq: 1760, dur: 0.28, gain: 0.5, out }); tone(t, { freq: 3520, dur: 0.12, gain: 0.08, out }); },
  pluck(t, out) {
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(4200, t); lp.frequency.exponentialRampToValueAtTime(380, t + 0.45); lp.connect(out);
    tone(t, { freq: 587, type: 'triangle', dur: 0.55, gain: 0.6, attack: 0.002, out: lp }); tone(t, { freq: 1174, type: 'sawtooth', dur: 0.12, gain: 0.08, attack: 0.002, out: lp });
  },
  bell(t, out) {
    // Two-operator FM: a modulator at 1.4x the carrier with a decaying index rings like a small bell.
    const car = ac.createOscillator(); const mod = ac.createOscillator(); const mg = ac.createGain(); const g = ac.createGain();
    car.frequency.value = 660; mod.frequency.value = 660 * 1.4;
    mg.gain.setValueAtTime(900, t); mg.gain.exponentialRampToValueAtTime(20, t + 1.4);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.45, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    mod.connect(mg).connect(car.frequency); car.connect(g).connect(out);
    car.start(t); mod.start(t); car.stop(t + 1.7); mod.stop(t + 1.7);
  },
  knock(t, out) { noise(t, { freq: 170, q: 3, dur: 0.07, gain: 1, out }); tone(t, { freq: 95, dur: 0.09, gain: 0.5, out }); noise(t + 0.16, { freq: 160, q: 3, dur: 0.07, gain: 0.9, out }); tone(t + 0.16, { freq: 90, dur: 0.09, gain: 0.45, out }); },
  blip(t, out) { const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(out); tone(t, { freq: 1320, type: 'square', dur: 0.05, gain: 0.25, attack: 0.001, out: lp }); },
  rise(t, out) { tone(t, { freq: 440, dur: 0.34, gain: 0.45, glideTo: 990, out }); tone(t + 0.02, { freq: 880, dur: 0.3, gain: 0.08, glideTo: 1980, out }); },
  fall(t, out) { tone(t, { freq: 990, dur: 0.36, gain: 0.45, glideTo: 440, out }); },
  alarm(t, out) {
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.connect(out);
    for (let i = 0; i < 4; i++) tone(t + i * 0.16, { freq: i % 2 ? 660 : 880, type: 'sawtooth', dur: 0.14, gain: 0.3, attack: 0.004, out: lp });
  },
  marimba(t, out) { [523.25, 659.25, 783.99].forEach((f, i) => { tone(t + i * 0.09, { freq: f, dur: 0.32, gain: 0.45, attack: 0.002, out }); tone(t + i * 0.09, { freq: f * 4, dur: 0.06, gain: 0.08, attack: 0.001, out }); }); },
};

/** Play a sound by id at volume 0..1. Resolves true when it was scheduled. */
export async function play(id, volume = 0.6) {
  if (!id || id === 'none' || !VOICES[id]) return false;
  const c = audio(); if (!c) return false;
  if (c.state === 'suspended') { try { await c.resume(); } catch { return false; } }
  if (c.state !== 'running') return false;
  const g = c.createGain(); g.gain.value = Math.max(0, Math.min(1, Number(volume) || 0)); g.connect(master);
  VOICES[id](c.currentTime + 0.02, g);
  setTimeout(() => g.disconnect(), 2500);
  return true;
}
export const SOUND_NAMES = Object.keys(VOICES);
