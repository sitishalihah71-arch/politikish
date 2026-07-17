// Lightweight sound cues via Web Audio oscillators - no audio files, so it
// stays fast-loading. Respects the mute/volume settings from ui.js.

let ctx = null;
let muted = false;
let volume = 0.7;

function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, duration, type = 'sine', gainScale = 1) {
  if (muted || volume <= 0) return;
  const audioCtx = getContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume * 0.2 * gainScale;
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

export function applySoundSettings(settings) {
  muted = settings.muted;
  volume = settings.volume;
}

export function playClick() {
  tone(440, 0.08, 'square', 0.5);
}

export function playSuccess() {
  tone(523, 0.12);
  setTimeout(() => tone(784, 0.18), 90);
}

export function playFailure() {
  tone(220, 0.25, 'sawtooth', 0.6);
}

export function playCoins() {
  tone(660, 0.08, 'triangle', 0.6);
  setTimeout(() => tone(880, 0.1, 'triangle', 0.6), 60);
}

export function playWarning() {
  tone(300, 0.15, 'square', 0.5);
}

export function playPromotion() {
  [523, 659, 784, 1047].forEach((freq, i) => {
    setTimeout(() => tone(freq, 0.15), i * 80);
  });
}

export function playTurnStart() {
  tone(392, 0.1, 'sine', 0.4);
}
