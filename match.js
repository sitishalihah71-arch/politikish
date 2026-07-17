// Host-authoritative match state: turn order, round counter, and dispatching
// the four actions. Mirrors room.js's pattern - the host resolves and
// broadcasts, clients request and render. `ui.js` renders whatever this
// module emits via `bus` under the `match:*` events.
//
// Player *identity/connection* (id/slot/connected/name/avatar) stays owned
// by room.js throughout - including during a match, since Module 2's
// reconnect-by-name logic must keep working. On the host, this module reads
// and extends those same live player objects (via room.getPlayersLive())
// rather than keeping a separate copy, so a disconnect/reconnect handled by
// room.js is immediately visible here too. Clients just store whatever the
// host broadcasts.

import { bus } from './utils.js';
import * as room from './room.js';
import * as multiplayer from './multiplayer.js';
import { RANKS, MAX_PLAYERS, initMatchState } from './player.js';
import { applyScandalPenalty, tickMediaShields } from './effects.js';
import { generateProjectOffers, resolveProjek } from './projects.js';
import { generateMediaOffers, resolveMedia } from './media.js';
import { resolvePolitik } from './politics.js';
import { resolveSabotaj } from './sabotage.js';

const MAX_ROUNDS = 10;

let matchStarted = false;
let currentRound = 1;
let turnSlot = 1;
let matchOver = false;
let winnerId = null;
let clientPlayers = []; // client-side cache; irrelevant on host (uses room.getPlayersLive())
let lastAction = null; // descriptor of the most recently resolved action, for toasts/sound cues
let lastPenalized = []; // player ids hit by the 100% scandal penalty on the last turn
let actionSeq = 0; // lets ui.js tell a genuinely new action apart from a re-broadcast echo

function isHostRole() {
  return room.getRoomSnapshot().isHost;
}

function currentPlayers() {
  return isHostRole() ? room.getPlayersLive() : clientPlayers;
}

function getActivePlayer(players) {
  return players.find((p) => p.slot === turnSlot) || null;
}

export function getMatchSnapshot() {
  const roomSnap = room.getRoomSnapshot();
  const players = currentPlayers();
  const active = getActivePlayer(players);
  return {
    started: matchStarted,
    round: Math.min(currentRound, MAX_ROUNDS),
    turnSlot,
    activePlayerId: active ? active.id : null,
    matchOver,
    winnerId,
    players: players.map((p) => ({ ...p })),
    localPlayerId: roomSnap.localPlayerId,
    isHost: roomSnap.isHost,
    lastAction,
    lastPenalized,
  };
}

function buildBroadcastPayload() {
  return {
    round: currentRound,
    turnSlot,
    matchOver,
    winnerId,
    players: currentPlayers().map((p) => ({ ...p })),
    lastAction,
    lastPenalized,
  };
}

function broadcastMatchUpdate() {
  multiplayer.send({ type: 'match-update', payload: buildBroadcastPayload() });
  bus.emit('match:updated', getMatchSnapshot());
}

function determineWinner(players) {
  const president = players.find((p) => p.rank === 'president');
  if (president) return president.id;

  const sorted = [...players].sort((a, b) => {
    const rankDiff = RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank);
    if (rankDiff !== 0) return rankDiff;
    if (a.scandal !== b.scandal) return a.scandal - b.scandal;
    return a.slot - b.slot;
  });
  return sorted[0] ? sorted[0].id : null;
}

function endMatch(players) {
  matchOver = true;
  winnerId = determineWinner(players);
  broadcastMatchUpdate();
}

function computeNextSlotAndRound(slot, roundNum) {
  if (slot === MAX_PLAYERS) return { slot: 1, round: roundNum + 1 };
  return { slot: slot + 1, round: roundNum };
}

// Called after every resolved action (and after a disconnect forces a skip).
// Ticks shields, checks the 100% scandal penalty for everyone, then advances
// to the next connected player - or ends the match if round 10 just finished.
function advanceTurn() {
  const players = room.getPlayersLive();
  tickMediaShields(players);
  lastPenalized = players.filter((p) => applyScandalPenalty(p, players)).map((p) => p.id);

  let { slot, round } = computeNextSlotAndRound(turnSlot, currentRound);
  if (round > MAX_ROUNDS) {
    endMatch(players);
    return;
  }

  let guard = 0;
  while (guard < MAX_PLAYERS) {
    const candidate = players.find((p) => p.slot === slot);
    if (candidate && candidate.connected) break;
    ({ slot, round } = computeNextSlotAndRound(slot, round));
    if (round > MAX_ROUNDS) {
      endMatch(players);
      return;
    }
    guard += 1;
  }

  turnSlot = slot;
  currentRound = round;
  broadcastMatchUpdate();
}

function isActivePlayerId(playerId) {
  const active = getActivePlayer(room.getPlayersLive());
  return active && active.id === playerId;
}

// ---------- Host-side resolution (shared by local host actions and
// incoming client requests) ----------

function setLastAction(action) {
  actionSeq += 1;
  lastAction = { ...action, seq: actionSeq };
}

function hostResolveProjek(playerId, cardId) {
  if (!isActivePlayerId(playerId)) return;
  const player = room.getPlayersLive().find((p) => p.id === playerId);
  if (!player) return;
  const card = resolveProjek(player, cardId);
  if (!card) return;
  setLastAction({ type: 'projek', actorId: playerId, card });
  advanceTurn();
}

function hostResolveMedia(playerId, cardId, targetId) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  const target = targetId ? players.find((p) => p.id === targetId) : null;
  if (!player) return;
  const result = resolveMedia(player, cardId, target);
  if (!result.ok) return;
  setLastAction({ type: 'media', actorId: playerId, targetId: target?.id, success: result.success, card: result.card });
  advanceTurn();
}

function hostResolvePolitik(playerId, extraInfluence, respond) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  if (!player) return;
  const result = resolvePolitik(player, players, extraInfluence);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  setLastAction({
    type: 'politik',
    actorId: playerId,
    success: result.success,
    chance: result.chance,
    cost: result.cost,
    toRank: result.toRank,
  });
  advanceTurn();
}

function hostResolveSabotaj(playerId, targetId, extraInfluence, respond) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  const target = players.find((p) => p.id === targetId);
  if (!player) return;
  const result = resolveSabotaj(player, target, players, extraInfluence);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  setLastAction({
    type: 'sabotaj',
    actorId: playerId,
    targetId,
    success: result.success,
    chance: result.chance,
    cost: result.cost,
    toRank: result.toRank,
  });
  advanceTurn();
}

function handleHostMatchMessage(type, payload, conn) {
  if (!matchStarted || !isHostRole()) return;
  const respond = (msg) => multiplayer.send(msg, conn);

  if (type === 'projek-start') {
    if (!isFromConn(conn)) return;
    respond({ type: 'projek-offers', payload: { offers: generateProjectOffers() } });
  } else if (type === 'projek-choice') {
    if (!isFromConn(conn)) return;
    hostResolveProjek(conn.peer, payload?.cardId);
  } else if (type === 'media-start') {
    if (!isFromConn(conn)) return;
    respond({ type: 'media-offers', payload: { offers: generateMediaOffers() } });
  } else if (type === 'media-choice') {
    if (!isFromConn(conn)) return;
    hostResolveMedia(conn.peer, payload?.cardId, payload?.targetId);
  } else if (type === 'politik-attempt') {
    if (!isFromConn(conn)) return;
    hostResolvePolitik(conn.peer, payload?.extraInfluence || 0, respond);
  } else if (type === 'sabotaj-attempt') {
    if (!isFromConn(conn)) return;
    hostResolveSabotaj(conn.peer, payload?.targetId, payload?.extraInfluence || 0, respond);
  }
}

function isFromConn(conn) {
  return isActivePlayerId(conn.peer);
}

// ---------- Client-side message handling ----------

function handleClientMatchMessage(type, payload) {
  if (type === 'match-update') {
    currentRound = payload.round;
    turnSlot = payload.turnSlot;
    matchOver = payload.matchOver;
    winnerId = payload.winnerId;
    clientPlayers = payload.players;
    lastAction = payload.lastAction;
    lastPenalized = payload.lastPenalized || [];
    bus.emit('match:updated', getMatchSnapshot());
  } else if (type === 'projek-offers') {
    bus.emit('match:offers', { action: 'projek', offers: payload.offers });
  } else if (type === 'media-offers') {
    bus.emit('match:offers', { action: 'media', offers: payload.offers });
  } else if (type === 'action-rejected') {
    bus.emit('match:action-rejected', { reason: payload.reason });
  }
}

// ---------- Public API used by ui.js (branches on host/client internally,
// same pattern as room.js) ----------

export function requestProjekOffers() {
  if (isHostRole()) {
    bus.emit('match:offers', { action: 'projek', offers: generateProjectOffers() });
  } else {
    multiplayer.send({ type: 'projek-start' });
  }
}

export function chooseProjekCard(cardId) {
  if (isHostRole()) {
    hostResolveProjek(room.getRoomSnapshot().localPlayerId, cardId);
  } else {
    multiplayer.send({ type: 'projek-choice', payload: { cardId } });
  }
}

export function requestMediaOffers() {
  if (isHostRole()) {
    bus.emit('match:offers', { action: 'media', offers: generateMediaOffers() });
  } else {
    multiplayer.send({ type: 'media-start' });
  }
}

export function chooseMediaCard(cardId, targetId) {
  if (isHostRole()) {
    hostResolveMedia(room.getRoomSnapshot().localPlayerId, cardId, targetId);
  } else {
    multiplayer.send({ type: 'media-choice', payload: { cardId, targetId } });
  }
}

export function attemptPolitik(extraInfluence) {
  if (isHostRole()) {
    hostResolvePolitik(room.getRoomSnapshot().localPlayerId, extraInfluence, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'politik-attempt', payload: { extraInfluence } });
  }
}

export function attemptSabotaj(targetId, extraInfluence) {
  if (isHostRole()) {
    hostResolveSabotaj(room.getRoomSnapshot().localPlayerId, targetId, extraInfluence, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'sabotaj-attempt', payload: { targetId, extraInfluence } });
  }
}

// ---------- Match start / lifecycle ----------

bus.on('room:match-started', () => {
  matchStarted = true;
  matchOver = false;
  winnerId = null;

  if (isHostRole()) {
    const players = room.getPlayersLive();
    players.forEach(initMatchState);
    currentRound = 1;
    turnSlot = (players.find((p) => p.connected) || players[0]).slot;
    multiplayer.onMessage(handleHostMatchMessage);
    broadcastMatchUpdate();
  } else {
    multiplayer.onMessage(handleClientMatchMessage);
  }
});

// Keep the match in sync with room-level connection changes (disconnect,
// reconnect) - auto-skip the active player's turn if they just dropped, or
// simply re-broadcast so everyone's "reconnecting..." state stays current.
bus.on('room:updated', () => {
  if (!matchStarted || matchOver || !isHostRole()) return;
  const players = room.getPlayersLive();
  const active = getActivePlayer(players);
  if (active && !active.connected) {
    advanceTurn();
  } else {
    broadcastMatchUpdate();
  }
});

export function resetMatch() {
  matchStarted = false;
  currentRound = 1;
  turnSlot = 1;
  matchOver = false;
  winnerId = null;
  clientPlayers = [];
}
