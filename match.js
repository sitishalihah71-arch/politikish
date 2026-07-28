// Host-authoritative match state: turn order, round counter, and dispatching
// the four actions (plus the Kabel roll and National Events, both of which
// extend the existing action/turn flow rather than adding parallel systems).
// Mirrors room.js's pattern - the host resolves and broadcasts, clients
// request and render. `ui.js` renders whatever this module emits via `bus`
// under the `match:*` events.
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
import { RANKS, initMatchState } from './player.js';
import { applyScandalPenalty, tickPublicSupport } from './effects.js';
import { generateProjectOffers, resolveProjek } from './projects.js';
import { generateMediaOffers, resolveMedia } from './media.js';
import { resolvePolitik } from './politics.js';
import { resolveSabotaj } from './sabotage.js';
import { pickNationalEvent, applyNationalEvent } from './events.js';
import { GAME_BALANCE } from './balance.js';

let matchStarted = false;
let currentRound = 1;
let maxRounds = GAME_BALANCE.room.defaultRounds; // captured from room settings at match start
let turnSlot = 1;
let matchOver = false;
let winnerId = null;
let clientPlayers = []; // client-side cache; irrelevant on host (uses room.getPlayersLive())
let lastAction = null; // descriptor of the most recently resolved action, for toasts/sound cues
let lastPenalized = []; // player ids hit by the 100% scandal penalty on the last turn
let actionSeq = 0; // lets ui.js tell a genuinely new action apart from a re-broadcast echo

// KABEL is now earned via the Political Network (see maybeRollKabelUnlock),
// not a per-click roll. `kabelClaimed` is global - once anyone wins the
// unlock roll, no further rolls happen for the rest of the match, whether
// or not that owner has actually used their card yet. Whether *this*
// player currently holds an unused card lives on the player object itself
// (`hasKabel`), which is why hostResolveSabotajOptions below is a lookup,
// not a roll - a client can't fake owning it since the host only ever acts
// on its own copy of that field.
let kabelClaimed = false;

// Host picks and applies the event, then broadcasts it once (with a seq so
// clients can tell a new event apart from a re-broadcast) - every client
// shows the full-screen announcement and dismisses it locally on Continue.
let pendingNationalEvent = null;
let eventSeq = 0;

function isHostRole() {
  return room.getRoomSnapshot().isHost;
}

function currentPlayers() {
  return isHostRole() ? room.getPlayersLive() : clientPlayers;
}

function getActivePlayer(players) {
  return players.find((p) => p.slot === turnSlot) || null;
}

// Political Network progress and KABEL ownership are completely private -
// every player's own entry keeps full data, but everyone else's copy of
// those two fields is stripped before it ever leaves this module, whether
// that's the payload sent to a remote client or the snapshot the host
// builds for its own local screen (both go through this same function, so
// there's exactly one place the privacy rule can be gotten wrong).
function maskPlayersFor(players, viewerId) {
  return players.map((p) => {
    if (p.id === viewerId) return { ...p };
    const { politicalNetwork, hasKabel, ...rest } = p;
    return rest;
  });
}

export function getMatchSnapshot() {
  const roomSnap = room.getRoomSnapshot();
  const players = currentPlayers();
  const active = getActivePlayer(players);
  return {
    started: matchStarted,
    round: Math.min(currentRound, maxRounds),
    maxRounds,
    turnSlot,
    activePlayerId: active ? active.id : null,
    matchOver,
    winnerId,
    players: maskPlayersFor(players, roomSnap.localPlayerId),
    localPlayerId: roomSnap.localPlayerId,
    isHost: roomSnap.isHost,
    lastAction,
    lastPenalized,
    pendingNationalEvent,
  };
}

function buildBroadcastPayloadFor(viewerId) {
  return {
    round: currentRound,
    maxRounds,
    turnSlot,
    matchOver,
    winnerId,
    players: maskPlayersFor(currentPlayers(), viewerId),
    lastAction,
    lastPenalized,
    pendingNationalEvent,
  };
}

// Sends a *personalized* payload to each connected client - not a single
// shared broadcast - so each one only ever receives its own Political
// Network/KABEL data on the wire, never another player's. The host's own
// local view goes through the same masking via getMatchSnapshot().
function broadcastMatchUpdate() {
  room.getConnectionsByPlayerId().forEach((conn, playerId) => {
    multiplayer.send({ type: 'match-update', payload: buildBroadcastPayloadFor(playerId) }, conn);
  });
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

// Fires once when `completedRound` is a National Events milestone (every
// `intervalRounds` rounds) and the host has the setting on. Applies the
// event to every player immediately (host-authoritative "final outcome"),
// same as every other action - the announcement is purely a presentational
// pause layered on top by ui.js, not a second source of truth.
function maybeTriggerNationalEvent(completedRound, players) {
  if (completedRound === null) return;
  if (!room.getRoomSnapshot().settings.nationalEvents) return;
  if (completedRound % GAME_BALANCE.nationalEvents.intervalRounds !== 0) return;

  const event = pickNationalEvent();
  players.forEach((p) => applyNationalEvent(event, p));
  eventSeq += 1;
  pendingNationalEvent = { event, seq: eventSeq };
}

// Turn order cycles through whichever slots are actually present, sorted
// ascending - not a hardcoded 1..N range. This has to hold up in two cases:
// starting a match with fewer players than the room's cap, and a player
// being permanently removed (reconnect grace period expiring) mid-match,
// which can leave a gap in the slot numbers.
//
// Public Support only decays at the end of its own owner's turn (not on
// every turn taken at the table), so only the player whose turn is ending
// here gets ticked - never the whole roster. `skipSupportTick` covers the
// one exception: the turn a Media card just granted/refreshed the shield,
// which must not immediately eat into the duration it just set.
function advanceTurn({ skipSupportTick = false } = {}) {
  const players = room.getPlayersLive();
  const endingPlayer = players.find((p) => p.slot === turnSlot);
  if (endingPlayer) {
    if (!skipSupportTick) tickPublicSupport(endingPlayer);
    endingPlayer.stats.turnsPlayed += 1;
  }
  lastPenalized = players.filter((p) => applyScandalPenalty(p, players)).map((p) => p.id);

  const activeSlots = players.map((p) => p.slot).sort((a, b) => a - b);
  if (activeSlots.length === 0) return;

  const currentIndex = activeSlots.indexOf(turnSlot);
  let nextIndex = currentIndex === -1 ? 0 : currentIndex + 1;
  let round = currentRound;
  // Only the primary wrap counts as a "completed round" for the National
  // Event check - if a chain of disconnected players causes the guard loop
  // below to wrap more than once in the same call, that's an already-rare
  // edge case and only the first completed round is treated as a milestone.
  let completedRound = null;
  if (nextIndex >= activeSlots.length) {
    nextIndex = 0;
    completedRound = round;
    round += 1;
  }

  let guard = 0;
  while (guard < activeSlots.length) {
    const candidate = players.find((p) => p.slot === activeSlots[nextIndex]);
    if (candidate && candidate.connected) break;
    nextIndex += 1;
    if (nextIndex >= activeSlots.length) {
      nextIndex = 0;
      round += 1;
    }
    guard += 1;
  }

  turnSlot = activeSlots[nextIndex];
  currentRound = round;

  maybeTriggerNationalEvent(completedRound, players);

  if (round > maxRounds) {
    endMatch(players);
    return;
  }

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

// Once a player has `threshold` successful Projects in one category, every
// further success in that same category re-rolls the unlock chance - never
// resetting their progress, never punishing bad luck - until either they
// win KABEL or someone else already has (checked first, so a claimed KABEL
// silently stops all further rolls for the rest of the match).
function maybeRollKabelUnlock(player, category) {
  if (kabelClaimed) return;
  if (player.politicalNetwork[category] < GAME_BALANCE.politicalNetwork.threshold) return;
  if (Math.random() < GAME_BALANCE.politicalNetwork.unlockChancePercent / 100) {
    kabelClaimed = true;
    player.hasKabel = true;
  }
}

function hostResolveProjek(playerId, cardId) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  if (!player) return;
  const card = resolveProjek(player, cardId, players.length);
  if (!card) return;
  maybeRollKabelUnlock(player, card.category);
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
  advanceTurn({ skipSupportTick: Boolean(result.card.supportTurns) });
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

// Card-generation step for Sabotaj, mirroring requestProjekOffers/
// requestMediaOffers - except there's no randomness here anymore. Whether
// this attempt gets the Kabel treatment is a pure lookup against the
// player's own `hasKabel` flag (set by maybeRollKabelUnlock), which the
// host is the only one ever mutating, so a client can't just claim it owns
// one.
function hostResolveSabotajOptions(playerId, respond) {
  if (!isActivePlayerId(playerId)) return;
  const player = room.getPlayersLive().find((p) => p.id === playerId);
  respond({ type: 'sabotaj-options', payload: { isKabel: Boolean(player?.hasKabel) } });
}

function hostResolveSabotaj(playerId, targetId, extraInfluence, respond) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  const target = players.find((p) => p.id === targetId);
  if (!player) return;
  const isKabel = Boolean(player.hasKabel);
  const result = resolveSabotaj(player, target, players, extraInfluence, { isKabel });
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  // KABEL is a one-time-use card: it's spent the moment it's actually used
  // in an attempt (win or lose), not merely offered - so backing out of the
  // target picker or attempt modal doesn't cost the player their card.
  if (isKabel) player.hasKabel = false;
  setLastAction({
    type: 'sabotaj',
    actorId: playerId,
    targetId,
    success: result.success,
    chance: result.chance,
    cost: result.cost,
    toRank: result.toRank,
    isKabel: result.isKabel,
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
  } else if (type === 'sabotaj-start') {
    if (!isFromConn(conn)) return;
    hostResolveSabotajOptions(conn.peer, respond);
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
    maxRounds = payload.maxRounds;
    turnSlot = payload.turnSlot;
    matchOver = payload.matchOver;
    winnerId = payload.winnerId;
    clientPlayers = payload.players;
    lastAction = payload.lastAction;
    lastPenalized = payload.lastPenalized || [];
    pendingNationalEvent = payload.pendingNationalEvent || null;
    bus.emit('match:updated', getMatchSnapshot());
  } else if (type === 'projek-offers') {
    bus.emit('match:offers', { action: 'projek', offers: payload.offers });
  } else if (type === 'media-offers') {
    bus.emit('match:offers', { action: 'media', offers: payload.offers });
  } else if (type === 'sabotaj-options') {
    bus.emit('match:sabotaj-options', { isKabel: Boolean(payload.isKabel) });
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

// Rolls (host-side) whether this Sabotaj attempt gets the Kabel treatment.
// Must be called before opening the target picker so ui.js knows which
// candidate list and chance table to use.
export function requestSabotajOptions() {
  if (isHostRole()) {
    hostResolveSabotajOptions(room.getRoomSnapshot().localPlayerId, (msg) => {
      bus.emit('match:sabotaj-options', msg.payload);
    });
  } else {
    multiplayer.send({ type: 'sabotaj-start' });
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

// Host-only manual override: forces the current player's turn to end with
// no resolution (no cost, no resource change) - for a player who's still
// connected but has stepped away, which the automatic disconnect-skip in
// advanceTurn() can't detect on its own.
export function skipCurrentPlayer() {
  if (!isHostRole() || !matchStarted || matchOver) return;
  const active = getActivePlayer(room.getPlayersLive());
  if (!active) return;
  setLastAction({ type: 'skip', actorId: active.id });
  advanceTurn();
}

// ---------- Match start / lifecycle ----------

bus.on('room:match-started', () => {
  matchStarted = true;
  matchOver = false;
  winnerId = null;
  kabelClaimed = false;
  pendingNationalEvent = null;

  const roomSnap = room.getRoomSnapshot();
  maxRounds = roomSnap.settings.rounds;

  if (isHostRole()) {
    const players = room.getPlayersLive();
    players.forEach(initMatchState);
    currentRound = 1;
    const bySlot = [...players].sort((a, b) => a.slot - b.slot);
    turnSlot = (bySlot.find((p) => p.connected) || bySlot[0]).slot;
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
  maxRounds = GAME_BALANCE.room.defaultRounds;
  turnSlot = 1;
  matchOver = false;
  winnerId = null;
  clientPlayers = [];
  kabelClaimed = false;
  pendingNationalEvent = null;
}
