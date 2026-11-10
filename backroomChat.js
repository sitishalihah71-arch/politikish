// Private chat between the two parties of a Backroom deal. Same privacy
// boundary as backroomDeals.js: the transcripts live HOST-SIDE ONLY and are
// never part of any broadcast - match.js hands each message to exactly the
// two people in the conversation (see room.getConnectionsByPlayerId).
//
// The host is the authority. Every message is checked here (sender, length,
// rate, size cap) and then recorded as a frozen entry - sender id, text, time
// and round - so nobody can edit or deny what they said afterwards. There is
// deliberately no edit/delete API.
//
// One conversation per pair of players, whichever way the deals go; whether
// a pair may talk at all is decided by the caller (backroomDeals.js's
// hasDealBetween), passed in as `allowed`.

import { GAME_BALANCE } from './balance.js';

const cfg = GAME_BALANCE.backroomDeals.chat;

const threads = new Map(); // "idA|idB" (sorted) -> frozen message entries
const recentBySender = new Map(); // senderId -> send times (ms) inside the burst window
let messageSeq = 0;

function threadKey(aId, bId) {
  return [aId, bId].sort().join('|');
}

// Strip control characters / collapse whitespace so a message can't smuggle
// in line breaks or invisible padding, then cap the length.
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cfg.maxLength);
}

// reason codes: 'not-allowed' | 'empty' | 'too-fast' | 'thread-full'
// `allowed` = may these two talk right now (a deal or contract links them).
export function recordMessage(senderId, otherId, text, round, allowed, now = Date.now()) {
  if (!senderId || !otherId || senderId === otherId || !allowed) return { ok: false, reason: 'not-allowed' };
  const clean = cleanText(text);
  if (!clean) return { ok: false, reason: 'empty' };

  const recent = (recentBySender.get(senderId) || []).filter((t) => now - t < cfg.burstWindowMs);
  if (recent.length && now - recent[recent.length - 1] < cfg.minIntervalMs) return { ok: false, reason: 'too-fast' };
  if (recent.length >= cfg.burstMax) return { ok: false, reason: 'too-fast' };

  const key = threadKey(senderId, otherId);
  const thread = threads.get(key) || [];
  if (thread.length >= cfg.maxMessages) return { ok: false, reason: 'thread-full' };

  messageSeq += 1;
  const message = Object.freeze({ id: `msg-${messageSeq}`, from: senderId, text: clean, ts: now, round: round || 1 });
  thread.push(message);
  threads.set(key, thread);
  recent.push(now);
  recentBySender.set(senderId, recent);
  return { ok: true, message };
}

// The recorded conversation between two players (a copy; entries are frozen).
export function getTranscript(aId, bId) {
  return [...(threads.get(threadKey(aId, bId)) || [])];
}

export function resetChats() {
  threads.clear();
  recentBySender.clear();
}
