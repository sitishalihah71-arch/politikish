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
import { dealStartingAssets, hasAsset, resolveRaid, generateMarketOffers, buyAsset } from './politicalOpportunities.js';
import { proposeDeal, respondToDeal, resetDeals } from './backroomDeals.js';
import { PARLIAMENT_MOTIONS, pickMotion, applyMotion } from './parliament.js';
import { assignSecretObjective, checkSecretObjective } from './objectives.js';
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

// Generic "breaking news" surface: any host-side module can post one, and
// every client shows the same full-screen announcement and dismisses it
// locally on Continue. National Events post through this; Backroom Deal
// leaks (the one moment a private deal becomes public) are the other
// current producer. The seq lets clients tell a new item apart from a
// re-broadcast of the same one.
let pendingNews = null;
let newsSeq = 0;

function postNews({ icon, headline, description }) {
  newsSeq += 1;
  pendingNews = { icon, headline, description, seq: newsSeq };
}

// Parliament Voting: while `pendingVote` is set, every turn-gated action is
// blocked (see isActivePlayerId below) - the whole table pauses for this,
// unlike every other mechanic in the game which only ever gates one actor.
// `votes` is playerId -> 'yes'|'no'; anyone not in it by resolution time
// (including a disconnected player) counts as a "no". `voteTimer` is the
// host-side force-resolve clock; a vote also resolves early the moment
// every currently-connected player has cast one.
let pendingVote = null;
let voteSeq = 0;
let voteTimer = null;

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
    const { politicalNetwork, hasKabel, secretObjective, ...rest } = p;
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
    pendingNews,
    pendingVote,
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
    pendingNews,
    pendingVote,
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
  postNews({ icon: event.icon, headline: event.name, description: event.description });
}

// Fires at the same round-boundary checkpoint as National Events, on its
// own independent interval - checked *after* the maxRounds/endMatch check
// in advanceTurn() so a session never opens on the match's last round with
// no next turn left to resume into. Opens a full-table vote instead of
// resolving instantly: `pendingVote` blocks every turn-gated action (see
// isActivePlayerId) until hostCastVote/resolveVote closes it out.
function maybeTriggerParliamentSession(completedRound, players) {
  if (completedRound === null) return;
  if (!room.getRoomSnapshot().settings.parliamentVoting) return;
  if (completedRound % GAME_BALANCE.parliament.intervalRounds !== 0) return;

  const { motion, target } = pickMotion(players);
  const description = motion.type === 'no-confidence'
    ? motion.description.replace('{target}', target.name)
    : motion.description;

  voteSeq += 1;
  pendingVote = {
    seq: voteSeq,
    motionId: motion.id,
    name: motion.name,
    description,
    targetId: target ? target.id : null,
    deadline: Date.now() + GAME_BALANCE.parliament.voteDurationMs,
    votes: {},
  };
  clearTimeout(voteTimer);
  voteTimer = setTimeout(resolveVote, GAME_BALANCE.parliament.voteDurationMs);
}

// Any connected player can cast a vote while one is open - not gated by
// whose turn it is, same precedent as Backroom Deals. Resolves immediately
// once every currently-connected player has voted, instead of waiting out
// the full timer; a player who disconnects mid-vote simply drops out of
// that "everyone" check rather than blocking resolution.
function hostCastVote(playerId, choice) {
  if (!pendingVote) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  if (!player || !player.connected) return;

  pendingVote.votes[playerId] = choice === 'yes' ? 'yes' : 'no';

  const stillWaiting = players.some((p) => p.connected && !pendingVote.votes[p.id]);
  if (!stillWaiting) resolveVote();
}

// Tallies yes vs no - anyone without a recorded vote (never voted, or
// disconnected before casting one) counts as a "no", so a silent table
// never accidentally passes a motion. Applies the motion only if it
// passed, posts the result through the same News surface every other
// announcement in this game already uses, then clears pendingVote so the
// turn that was already computed underneath becomes interactive again.
function resolveVote() {
  if (!pendingVote) return;
  clearTimeout(voteTimer);
  voteTimer = null;

  const vote = pendingVote;
  const players = room.getPlayersLive();
  const yesCount = players.filter((p) => vote.votes[p.id] === 'yes').length;
  const noCount = players.length - yesCount;
  const passed = yesCount > noCount;

  const motion = PARLIAMENT_MOTIONS.find((m) => m.id === vote.motionId);
  const target = vote.targetId ? players.find((p) => p.id === vote.targetId) : null;
  if (passed) applyMotion(motion, target, players);

  pendingVote = null;

  const outcomeNote = motion.type === 'no-confidence' && passed ? ` ${target?.name} is demoted to Ahli Biasa.` : '';
  postNews({
    icon: '🏛️',
    headline: passed ? 'MOTION PASSED' : 'MOTION FAILED',
    description: `${vote.name} — ${passed ? 'Passed' : 'Failed'} (${yesCount} Yes, ${noCount} No). ${vote.description}${outcomeNote}`,
  });
  // Clears pendingVote above already ran; now settle whatever the turn
  // state underneath actually is. If the player now up disconnected while
  // the vote was blocking everything (the one path that could have skipped
  // them was itself suppressed for the same reason - see the room:updated
  // handler below), route through advanceTurn() so its own guard loop skips
  // them properly instead of broadcasting a turn nobody can take.
  const newActive = getActivePlayer(room.getPlayersLive());
  if (newActive && !newActive.connected) {
    advanceTurn();
  } else {
    settleTurnState();
  }
}

// Media Empire pays out once per completed round, to every owner - not tied
// to any single action the way the other assets' bonuses are.
function applyMediaEmpirePassive(completedRound, players) {
  if (completedRound === null) return;
  const bonus = GAME_BALANCE.politicalOpportunity.assets.mediaEmpire.influencePerRound;
  players.forEach((p) => {
    if (hasAsset(p, 'mediaEmpire')) p.influence += bonus;
  });
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
    maybeCompleteObjective(endingPlayer);
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

  applyMediaEmpirePassive(completedRound, players);
  maybeTriggerNationalEvent(completedRound, players);

  if (round > maxRounds) {
    endMatch(players);
    return;
  }

  maybeTriggerParliamentSession(completedRound, players);
  settleTurnState();
}

// Broadcasts the now-current turn state - unless a Parliament vote just
// opened (in which case that alone is broadcast, and this same check runs
// again once the vote resolves - see resolveVote), or the player now up has
// a leftover bribery-leak skip flag from backroomDeals.js, auto-resolved
// the moment their turn comes up exactly like the manual host skip: they
// still "take" the turn (a visible skip notification fires) rather than
// being silently passed over the way a disconnected player is. Broadcast
// before recursing so that when a leak benches two players in a row, both
// skips reach every client instead of the second overwriting the first's
// lastAction. The recursive call is deferred a beat so the host's own
// screen - which renders synchronously off this same call stack - actually
// paints each skip toast instead of collapsing them all into the final one.
function settleTurnState() {
  if (pendingVote) {
    broadcastMatchUpdate();
    return;
  }

  const newActive = getActivePlayer(room.getPlayersLive());
  if (newActive && newActive.skipNextTurn) {
    newActive.skipNextTurn = false;
    setLastAction({ type: 'skip', actorId: newActive.id, reason: 'bribery-leak' });
    broadcastMatchUpdate();
    setTimeout(() => advanceTurn(), 1500);
    return;
  }

  broadcastMatchUpdate();
}

// A pending vote pauses every turn-gated action for the whole table, not
// just the active player - so this returns false for everyone while
// `pendingVote` is set, exactly as if nobody's turn was active.
function isActivePlayerId(playerId) {
  if (pendingVote) return false;
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

// Checks (and, if newly met, applies + announces) a player's Secret
// Objective. Called after every turn-ending action and after a clean
// Backroom Deal transfer - the only two places a player's Money/Influence
// change mid-match. Privately notifies just that player (never broadcast,
// same privacy boundary as Backroom Deals) so the objective and its
// completion stay masked from everyone else per maskPlayersFor.
function maybeCompleteObjective(player) {
  const definition = checkSecretObjective(player);
  if (definition) {
    notifyPlayer(player.id, 'objective-complete', { name: definition.name, reward: definition.reward });
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

function hostResolveRaid(playerId, targetId, assetId, extraInfluence, respond) {
  if (!isActivePlayerId(playerId)) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  const target = players.find((p) => p.id === targetId);
  if (!player) return;
  const result = resolveRaid(player, target, assetId, extraInfluence);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  setLastAction({
    type: 'raid',
    actorId: playerId,
    targetId,
    success: result.success,
    chance: result.chance,
    cost: result.cost,
    assetType: result.assetType,
  });
  advanceTurn();
}

// Card-generation step for Black Market, mirroring requestProjekOffers -
// offers are generated fresh each time (not stored), so backing out of the
// modal costs nothing.
function hostResolveMarketOffers(playerId, respond) {
  if (!isActivePlayerId(playerId)) return;
  const player = room.getPlayersLive().find((p) => p.id === playerId);
  if (!player) return;
  respond({ type: 'market-offers', payload: { offers: generateMarketOffers(player) } });
}

function hostResolveMarketPurchase(playerId, assetType, respond) {
  if (!isActivePlayerId(playerId)) return;
  const player = room.getPlayersLive().find((p) => p.id === playerId);
  if (!player) return;
  const result = buyAsset(player, assetType);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  setLastAction({ type: 'market', actorId: playerId, assetType: result.assetType, price: result.price });
  advanceTurn();
}

// Delivers a message to exactly one player, whether that's a remote client
// (over their own connection) or the host's own local screen (via bus,
// since the host never sends itself network messages) - used for Backroom
// Deal offers/results, which must never be broadcast to anyone else.
function notifyPlayer(playerId, type, payload) {
  if (playerId === room.getRoomSnapshot().localPlayerId) {
    bus.emit(`match:${type}`, payload);
    return;
  }
  const conn = room.getConnectionsByPlayerId().get(playerId);
  if (conn) multiplayer.send({ type, payload }, conn);
}

// Backroom Deals are not turn actions - any connected player can propose or
// respond at any time (see backroomDeals.js), so neither of these checks
// isActivePlayerId the way every other resolver does.
function hostProposeDeal(offererId, targetId, money, influence, respond) {
  const players = room.getPlayersLive();
  const offerer = players.find((p) => p.id === offererId);
  const target = players.find((p) => p.id === targetId);
  if (!offerer) return;
  const result = proposeDeal(offerer, target, money, influence);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  notifyPlayer(targetId, 'deal-offer', {
    dealId: result.dealId,
    fromId: offererId,
    fromName: offerer.name,
    money: result.money,
    influence: result.influence,
  });
}

function hostRespondToDeal(responderId, dealId, accept) {
  const players = room.getPlayersLive();
  const result = respondToDeal(dealId, accept, players);
  if (!result.ok) return; // already resolved/expired - nothing to do

  if (!result.accepted) {
    notifyPlayer(result.offererId, 'deal-result', { accepted: false, fellThrough: Boolean(result.fellThrough) });
    return;
  }

  const offerer = players.find((p) => p.id === result.offererId);
  const target = players.find((p) => p.id === result.targetId);

  if (result.leaked) {
    postNews({
      icon: '📰',
      headline: 'BREAKING NEWS',
      description: `A secret political deal between ${offerer?.name || 'a politician'} and ${target?.name || 'a politician'} was exposed! Both lose their next turn.`,
    });
  } else {
    // A clean transfer is the one place a player's Money/Influence can
    // change outside their own turn - check both parties' Secret
    // Objectives here too, not just in advanceTurn().
    if (offerer) maybeCompleteObjective(offerer);
    if (target) maybeCompleteObjective(target);
  }

  // Deliberately no setLastAction here - deals never generate the usual
  // "X did Y" toast, leaked or not. The only public trace of a leaked deal
  // is the news item above; a clean deal leaves none at all.
  notifyPlayer(result.offererId, 'deal-result', { accepted: true, leaked: result.leaked, role: 'offerer', money: result.money, influence: result.influence });
  notifyPlayer(result.targetId, 'deal-result', { accepted: true, leaked: result.leaked, role: 'target', money: result.money, influence: result.influence });
  broadcastMatchUpdate();
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
  } else if (type === 'raid-attempt') {
    if (!isFromConn(conn)) return;
    hostResolveRaid(conn.peer, payload?.targetId, payload?.assetId, payload?.extraInfluence || 0, respond);
  } else if (type === 'market-start') {
    if (!isFromConn(conn)) return;
    hostResolveMarketOffers(conn.peer, respond);
  } else if (type === 'market-choice') {
    if (!isFromConn(conn)) return;
    hostResolveMarketPurchase(conn.peer, payload?.assetType, respond);
  } else if (type === 'deal-propose') {
    // Not turn-gated - any connected player can propose a bribe at any time.
    hostProposeDeal(conn.peer, payload?.targetId, payload?.money || 0, payload?.influence || 0, respond);
  } else if (type === 'deal-respond') {
    hostRespondToDeal(conn.peer, payload?.dealId, Boolean(payload?.accept));
  } else if (type === 'vote-cast') {
    // Not turn-gated - any connected player votes while pendingVote is open.
    hostCastVote(conn.peer, payload?.choice);
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
    pendingNews = payload.pendingNews || null;
    pendingVote = payload.pendingVote || null;
    bus.emit('match:updated', getMatchSnapshot());
  } else if (type === 'projek-offers') {
    bus.emit('match:offers', { action: 'projek', offers: payload.offers });
  } else if (type === 'media-offers') {
    bus.emit('match:offers', { action: 'media', offers: payload.offers });
  } else if (type === 'sabotaj-options') {
    bus.emit('match:sabotaj-options', { isKabel: Boolean(payload.isKabel) });
  } else if (type === 'market-offers') {
    bus.emit('match:offers', { action: 'market', offers: payload.offers });
  } else if (type === 'deal-offer') {
    bus.emit('match:deal-offer', payload);
  } else if (type === 'deal-result') {
    bus.emit('match:deal-result', payload);
  } else if (type === 'objective-complete') {
    bus.emit('match:objective-complete', payload);
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

export function attemptRaid(targetId, assetId, extraInfluence) {
  if (isHostRole()) {
    hostResolveRaid(room.getRoomSnapshot().localPlayerId, targetId, assetId, extraInfluence, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'raid-attempt', payload: { targetId, assetId, extraInfluence } });
  }
}

export function requestMarketOffers() {
  if (isHostRole()) {
    const player = room.getPlayersLive().find((p) => p.id === room.getRoomSnapshot().localPlayerId);
    bus.emit('match:offers', { action: 'market', offers: player ? generateMarketOffers(player) : [] });
  } else {
    multiplayer.send({ type: 'market-start' });
  }
}

export function chooseMarketAsset(assetType) {
  if (isHostRole()) {
    hostResolveMarketPurchase(room.getRoomSnapshot().localPlayerId, assetType, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'market-choice', payload: { assetType } });
  }
}

// Backroom Deals are never turn-gated - can be called any time, by anyone.
export function proposeBackroomDeal(targetId, money, influence) {
  if (isHostRole()) {
    hostProposeDeal(room.getRoomSnapshot().localPlayerId, targetId, money, influence, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'deal-propose', payload: { targetId, money, influence } });
  }
}

export function respondToBackroomDeal(dealId, accept) {
  if (isHostRole()) {
    hostRespondToDeal(room.getRoomSnapshot().localPlayerId, dealId, accept);
  } else {
    multiplayer.send({ type: 'deal-respond', payload: { dealId, accept } });
  }
}

// Parliament Voting is never turn-gated - any connected player can vote
// while pendingVote is open.
export function castVote(choice) {
  if (isHostRole()) {
    hostCastVote(room.getRoomSnapshot().localPlayerId, choice);
  } else {
    multiplayer.send({ type: 'vote-cast', payload: { choice } });
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
  pendingNews = null;
  pendingVote = null;
  clearTimeout(voteTimer);
  voteTimer = null;
  resetDeals();

  const roomSnap = room.getRoomSnapshot();
  maxRounds = roomSnap.settings.rounds;

  if (isHostRole()) {
    const players = room.getPlayersLive();
    players.forEach(initMatchState);
    dealStartingAssets(players);
    players.forEach(assignSecretObjective);
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
// While a vote is open, never advance the turn here even if the queued-up
// active player just disconnected - that would silently shift turnSlot out
// from under the still-pending vote. resolveVote() re-checks this itself
// once the vote actually closes, so it's caught there instead.
bus.on('room:updated', () => {
  if (!matchStarted || matchOver || !isHostRole()) return;
  const players = room.getPlayersLive();
  const active = getActivePlayer(players);
  if (active && !active.connected && !pendingVote) {
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
  pendingNews = null;
  pendingVote = null;
  clearTimeout(voteTimer);
  voteTimer = null;
  resetDeals();
}
