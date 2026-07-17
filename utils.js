// Shared DOM, math, storage and event-bus helpers used across all modules.

export const $ = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomChoice(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

// Fisher-Yates shuffle, returns a new array.
export function shuffle(arr) {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function pickRandomUnique(arr, count) {
  return shuffle(arr).slice(0, count);
}

export function formatMoney(amount) {
  return `RM${amount.toLocaleString('en-MY')}`;
}

export function generateRoomCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
  let code = '';
  for (let i = 0; i < length; i++) code += chars[randomInt(0, chars.length - 1)];
  return code;
}

const STORAGE_PREFIX = 'politikish:';

export function loadSettings() {
  const defaults = { muted: false, volume: 0.7 };
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}settings`);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}settings`, JSON.stringify(settings));
  } catch {
    // storage unavailable (private browsing etc.) - settings just won't persist
  }
}

export function saveSession(session) {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}session`, JSON.stringify(session));
  } catch {
    // ignore
  }
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}session`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(`${STORAGE_PREFIX}session`);
  } catch {
    // ignore
  }
}

// Minimal event bus so UI modules and game-logic modules stay decoupled.
export const bus = {
  emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  },
  on(name, handler) {
    document.addEventListener(name, handler);
  },
  off(name, handler) {
    document.removeEventListener(name, handler);
  },
};
