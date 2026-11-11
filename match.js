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

import { bus, formatMoney } from './utils.js';
import * as room from './room.js';
import * as multiplayer from './multiplayer.js';
import { RANKS, initMatchState, stripPrivateFields } from './player.js';
import { dealCharacters } from './characters.js';
import { applyScandalPenalty, tickPublicSupport } from './effects.js';
import { generateProjectOffers, resolveProjek } from './projects.js';
import { generateMediaOffers, resolveMedia } from './media.js';
import { resolvePolitik } from './politics.js';
import { resolveSabotaj, validateSabotaj } from './sabotage.js';
import { pickNationalEvent, applyNationalEvent } from './events.js';
import { dealStartingAssets, generateMarketStock, hasAsset, resolveRaid, generateMarketOffers, buyAsset } from './politicalOpportunities.js';
import {
  proposeDeal, respondToDeal, resetDeals, getContractViewsFor, getActiveContractsAsTarget,
  getBreachedContractsAsOfferer, handleAction as contractsOnAction, handleVoteResolved as contractsOnVote,
  handleRoundEnd as contractsOnRoundEnd, noteTurnStart as contractsNoteTurnStart, exposeContract,
  getNextVoteRound, getPendingDealViewsFor, hasDealBetween,
} from './backroomDeals.js';
import { recordMessage, getTranscript, resetChats } from './backroomChat.js';
import { PARLIAMENT_MOTIONS, pickMotion, applyMotion } from './parliament.js';
import { assignSecretObjective, checkSecretObjective } from './objectives.js';
import { decideBotAction, decideDealProposal, decideDealResponse, pickBotChatReply } from './bots.js';
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

// `feedText`/`feedType` are the one-line version for the Berita Terkini log
// (the overlay itself shows the full headline/description).
function postNews({ icon, headline, description, feedText = null, feedType = 'news' }) {
  newsSeq += 1;
  pendingNews = { icon, headline, description, feedText, feedType, seq: newsSeq };
}

// Parliament Voting: while `pendingVote` is set, every turn-gated action is
// blocked (see isActivePlayerId below) - the whole table pauses for this,
// unlike every other mechanic in the game which only ever gates one actor.
// `votes` is playerId -> 'yes'|'no'; anyone not in it by
// resolution time (including a disconnected player) is an abstention and
// is left out of the count entirely (voters only ever choose Yes or No). `voteTimer` is the host-side
// force-resolve clock; a vote also resolves early the moment every
// connected *human* has cast one (bots never vote, so they can't hold it up).
let pendingVote = null;
let voteSeq = 0;
let voteTimer = null;

// True for the short window in which a benched player's turn has "come up"
// but is being auto-skipped (Backroom Deal leak). Every turn-gated action is
// refused during it and the UI shows a skip banner instead of "your turn".
let turnSkipping = false;

// Advanced Mode: nobody starts with a Political Asset; the Black Market is
// the only source, from a finite table-wide `marketStock` (a list of asset
// types, one entry per copy left). Both are public, so both ride along in
// every broadcast.
let advancedMode = false;
let marketStock = [];

// Media Empire pays its owners at each round boundary with no action behind
// it, so it has no `lastAction` of its own. This is the passive equivalent:
// the most recent payout, with a seq so the UI logs each one exactly once.
let passivePayout = null;
let passiveSeq = 0;

// Backroom contracts are private: the host keeps the registry (backroomDeals.js),
// each client only ever receives its own, riding on its personalised
// match-update payload.
let clientContracts = [];
let clientPendingDeals = []; // this player's own unanswered offers (same privacy)
const botChatTimers = new Set(); // pending canned bot replies, cleared on reset

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
//
// The same goes for a player's secret character and ability cooldowns (see
// player.js's PRIVATE_PLAYER_FIELDS) - except that characters are revealed to
// everyone once the match is over. Secret Objectives stay masked even then.
function maskPlayersFor(players, viewerId) {
  return players.map((p) => {
    if (p.id === viewerId) return { ...p };
    return stripPrivateFields(p, { keepCharacter: matchOver });
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
    skipping: turnSkipping,
    advancedMode,
    marketStock: [...marketStock],
    passivePayout,
    contracts: isHostRole() ? getContractViewsFor(roomSnap.localPlayerId) : clientContracts,
    pendingDeals: isHostRole() ? getPendingDealViewsFor(roomSnap.localPlayerId) : clientPendingDeals,
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
    pendingVote: pendingVote ? { ...pendingVote, remainingMs: Math.max(0, pendingVote.deadline - Date.now()) } : null,
    skipping: turnSkipping,
    advancedMode,
    marketStock: [...marketStock],
    passivePayout,
    contracts: getContractViewsFor(viewerId),
    pendingDeals: getPendingDealViewsFor(viewerId),
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

// Refreshes just the two parties of a deal (their own private contracts /
// pending offers ride on this) without telling anyone else anything happened.
function sendUpdateToParties(ids) {
  const localId = room.getRoomSnapshot().localPlayerId;
  ids.forEach((id) => {
    if (id === localId) {
      bus.emit('match:updated', getMatchSnapshot());
      return;
    }
    const conn = room.getConnectionsByPlayerId().get(id);
    if (conn) multiplayer.send({ type: 'match-update', payload: buildBroadcastPayloadFor(id) }, conn);
  });
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
  // A bot that took a bribe to vote does so right away (or, if it means to
  // betray the deal, votes the other way). Other bots still abstain.
  players.forEach((p) => {
    if (!p.isBot) return;
    getActiveContractsAsTarget(p.id)
      .filter((c) => c.condition.type === 'vote' && pendingVote.seq > c.afterVoteSeq)
      .forEach((c) => {
        const { choice } = c.condition;
        pendingVote.votes[p.id] = c.botWillBreak ? (choice === 'yes' ? 'no' : 'yes') : choice;
      });
  });
  clearTimeout(voteTimer);
  voteTimer = setTimeout(resolveVote, GAME_BALANCE.parliament.voteDurationMs);
}

// Any connected player can cast a vote while one is open - not gated by
// whose turn it is, same precedent as Backroom Deals. Resolves immediately
// once every connected human has voted, instead of waiting out the full
// timer; a player who disconnects mid-vote simply drops out of that
// "everyone" check rather than blocking resolution, and bots (which never
// vote) aren't waited on at all.
function hostCastVote(playerId, choice) {
  if (!pendingVote) return;
  const players = room.getPlayersLive();
  const player = players.find((p) => p.id === playerId);
  if (!player || !player.connected || player.isBot) return;
  if (choice !== 'yes' && choice !== 'no') return;

  pendingVote.votes[playerId] = choice;

  const stillWaiting = players.some((p) => p.connected && !p.isBot && !pendingVote.votes[p.id]);
  if (!stillWaiting) resolveVote();
}

// Tallies Yes vs No - everyone else (never voted, bots,
// or disconnected before casting) is an abstention and doesn't count either
// way. The motion passes only on a strict Yes majority, so a tie or a fully
// silent table never passes it. Applies the motion only if it passed, posts
// the result through the same News surface every other announcement in this
// game already uses, then clears pendingVote so the turn that was already
// computed underneath becomes interactive again.
function resolveVote() {
  if (!pendingVote) return;
  clearTimeout(voteTimer);
  voteTimer = null;

  const vote = pendingVote;
  const players = room.getPlayersLive();
  const yesCount = players.filter((p) => vote.votes[p.id] === 'yes').length;
  const noCount = players.filter((p) => vote.votes[p.id] === 'no').length;
  const abstainCount = players.length - yesCount - noCount;
  const passed = yesCount > noCount;

  const motion = PARLIAMENT_MOTIONS.find((m) => m.id === vote.motionId);
  const target = vote.targetId ? players.find((p) => p.id === vote.targetId) : null;
  if (passed) applyMotion(motion, target, players);
  processContractEvents(contractsOnVote(vote, players));

  pendingVote = null;

  const outcomeNote = motion.type === 'no-confidence' && passed ? ` ${target?.name} is demoted to Ahli Biasa.` : '';
  postNews({
    icon: '🏛️',
    headline: passed ? 'MOTION PASSED' : 'MOTION FAILED',
    description: `${vote.name} — ${passed ? 'Passed' : 'Failed'} (${yesCount} Yes, ${noCount} No, ${abstainCount} Abstain). ${vote.description}${outcomeNote}`,
    feedText: `🏛️ ${vote.name} — ${passed ? 'PASSED' : 'FAILED'} (${yesCount} Yes, ${noCount} No, ${abstainCount} Abstain).${outcomeNote}`,
    feedType: 'parliament',
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
  const ownerIds = [];
  players.forEach((p) => {
    if (hasAsset(p, 'mediaEmpire')) {
      p.influence += bonus;
      ownerIds.push(p.id);
    }
  });
  if (ownerIds.length > 0) {
    passiveSeq += 1;
    passivePayout = { seq: passiveSeq, assetType: 'mediaEmpire', ownerIds, amount: bonus, round: completedRound };
  }
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
  turnSkipping = false;
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
  processContractEvents(contractsOnRoundEnd(completedRound, players));

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
  if (newActive) contractsNoteTurnStart(newActive, room.getPlayersLive());
  if (newActive && newActive.skipNextTurn) {
    newActive.skipNextTurn = false;
    turnSkipping = true;
    // The move that just resolved gets broadcast first - otherwise the skip
    // notice would overwrite it as `lastAction` before anyone ever saw it.
    broadcastMatchUpdate();
    setLastAction({ type: 'skip', actorId: newActive.id, reason: 'bribery-leak' });
    broadcastMatchUpdate();
    const skippedSlot = turnSlot;
    // Re-checked on firing: a disconnect (or anything else) may already have
    // moved the turn on, in which case advancing again would skip an
    // innocent player.
    setTimeout(() => {
      if (turnSkipping && turnSlot === skippedSlot) advanceTurn();
    }, GAME_BALANCE.backroomDeals.skipNoticeMs);
    return;
  }

  broadcastMatchUpdate();
  maybeTriggerBotTurn(newActive);
}

// A bot has no real PeerJS connection to send it a turn over - the host
// just calls its own resolvers directly after a pacing delay, the same
// deferred-setTimeout pattern already used above for the bribery-leak
// auto-skip, so a human opponent visibly sees the bot "take" its turn
// instead of it resolving instantly.
function maybeTriggerBotTurn(active) {
  if (active && active.isBot) {
    setTimeout(() => resolveBotTurn(active.id), GAME_BALANCE.bots.turnDelayMs);
  }
}

// Bots skip the offer round-trip protocol entirely (that's a network
// artifact for remote clients) - it generates the same offer pools the UI
// would have requested, decides directly via bots.js, then calls the exact
// same hostResolveX a real client's message would have driven. A deal
// proposal never consumes the turn (see the comment on hostProposeDeal
// below), so a bot may propose one and still take a normal action after.
function resolveBotTurn(botId) {
  const players = room.getPlayersLive();
  const bot = players.find((p) => p.id === botId);
  if (!bot || !isActivePlayerId(botId)) return;

  // A bot whose deal was broken exposes the culprit most of the time.
  getBreachedContractsAsOfferer(bot.id).forEach((c) => {
    if (Math.random() < 0.8) hostExposeContract(bot.id, c.id);
  });

  const voteAhead = Boolean(getNextVoteRound(currentRound, maxRounds, room.getRoomSnapshot().settings.parliamentVoting));
  const proposal = decideDealProposal(bot, players, { voteAhead });
  if (proposal) hostProposeDeal(bot.id, proposal.targetId, proposal.money, proposal.influence, proposal.condition, () => {});

  const offers = {
    projekOffers: generateProjectOffers(),
    mediaOffers: generateMediaOffers(),
    marketOffers: advancedMode ? generateMarketOffers(bot, marketStock) : [],
  };
  const action = decideBotAction(bot, players, offers, buildBotContractPlan(bot, players));
  const noop = () => {};

  if (action.type === 'projek') hostResolveProjek(botId, action.cardId);
  else if (action.type === 'politik') hostResolvePolitik(botId, action.extraInfluence, noop);
  else if (action.type === 'sabotaj') hostResolveSabotaj(botId, action.targetId, action.extraInfluence, noop);
  else if (action.type === 'media') hostResolveMedia(botId, action.cardId, action.targetId);
  else if (action.type === 'raid') hostResolveRaid(botId, action.targetId, action.assetId, action.extraInfluence, noop);
  else if (action.type === 'market') hostResolveMarketPurchase(botId, action.assetType, noop);
}

// A pending vote pauses every turn-gated action for the whole table, not
// just the active player - so this returns false for everyone while
// `pendingVote` is set, exactly as if nobody's turn was active. The same
// goes for a turn that is being auto-skipped: it is nominally someone's
// turn, but they must not be able to act on it.
function isActivePlayerId(playerId) {
  if (pendingVote || turnSkipping) return false;
  const active = getActivePlayer(room.getPlayersLive());
  return active && active.id === playerId;
}

// ---------- Host-side resolution (shared by local host actions and
// incoming client requests) ----------

function setLastAction(action) {
  actionSeq += 1;
  lastAction = { ...action, seq: actionSeq };
  // Every resolved turn action may fulfil or break a Backroom contract.
  if (isHostRole()) processContractEvents(contractsOnAction(lastAction, room.getPlayersLive()));
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
    partyMachinery: hasAsset(player, 'partyMachinery'),
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
    targetRoyal: hasAsset(target, 'royalConnection'),
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
  if (!advancedMode) {
    respond({ type: 'action-rejected', payload: { reason: 'market-closed' } });
    return;
  }
  respond({ type: 'market-offers', payload: { offers: generateMarketOffers(player, marketStock) } });
}

function hostResolveMarketPurchase(playerId, assetType, respond) {
  if (!isActivePlayerId(playerId)) return;
  const player = room.getPlayersLive().find((p) => p.id === playerId);
  if (!player) return;
  if (!advancedMode) {
    respond({ type: 'action-rejected', payload: { reason: 'market-closed' } });
    return;
  }
  const result = buyAsset(player, assetType, marketStock);
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  setLastAction({ type: 'market', actorId: playerId, assetType: result.assetType, price: result.price, scandalGain: result.scandalGain });
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
function hostProposeDeal(offererId, targetId, money, influence, condition, respond) {
  const players = room.getPlayersLive();
  const offerer = players.find((p) => p.id === offererId);
  const target = players.find((p) => p.id === targetId);
  if (!offerer) return;
  const result = proposeDeal(offerer, target, money, influence, condition, players, dealContext());
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: result.reason } });
    return;
  }
  // A bot target has no connection/local screen for notifyPlayer to reach -
  // it never "receives" the offer through the normal channel, so its
  // accept/reject decision is driven directly instead. It turns down a
  // "Sabotaj X" it couldn't carry out.
  if (target.isBot) {
    const victim = players.find((p) => p.id === result.condition.victimId);
    const canComply = result.condition.type !== 'sabotage'
      || (victim && validateSabotaj(target, victim, players, 0, { isKabel: Boolean(target.hasKabel) }).ok);
    const accept = decideDealResponse(target, { money: result.money, influence: result.influence, canComply });
    hostRespondToDeal(target.id, result.dealId, accept);
    return;
  }

  notifyPlayer(targetId, 'deal-offer', {
    dealId: result.dealId,
    fromId: offererId,
    fromName: offerer.name,
    money: result.money,
    influence: result.influence,
    condition: result.condition,
  });
  // The offerer's own copy of the pending offer (what the chat hangs off).
  sendUpdateToParties([offererId]);
}

// What backroomDeals.js needs to know about the match around a deal.
function dealContext() {
  return {
    round: currentRound,
    maxRounds,
    voteSeq,
    parliamentEnabled: Boolean(room.getRoomSnapshot().settings.parliamentVoting),
  };
}

function hostRespondToDeal(responderId, dealId, accept) {
  const players = room.getPlayersLive();
  const result = respondToDeal(dealId, accept, players, dealContext(), Math.random, responderId);
  if (!result.ok) return; // already resolved/expired - nothing to do

  if (!result.accepted) {
    notifyPlayer(result.offererId, 'deal-result', { accepted: false, fellThrough: Boolean(result.fellThrough) });
    sendUpdateToParties([result.offererId]);
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
  const detail = {
    accepted: true,
    leaked: result.leaked,
    money: result.money,
    influence: result.influence,
    condition: result.condition,
    upfront: result.upfront || null,
    held: result.held || null,
  };
  notifyPlayer(result.offererId, 'deal-result', { ...detail, role: 'offerer', otherId: result.targetId });
  notifyPlayer(result.targetId, 'deal-result', { ...detail, role: 'target', otherId: result.offererId });
  broadcastMatchUpdate();
}

// Tells each party (privately) what just happened to their contract and
// re-checks Secret Objectives, since escrow just moved Money/Influence.
// Safe to call with no events.
function processContractEvents(events) {
  if (!events.length) return;
  const players = room.getPlayersLive();
  events.forEach((event) => {
    const detail = { kind: event.kind, contract: event.contract };
    notifyPlayer(event.offererId, 'deal-contract-event', { ...detail, role: 'offerer', otherId: event.targetId });
    notifyPlayer(event.targetId, 'deal-contract-event', { ...detail, role: 'target', otherId: event.offererId });
    [event.offererId, event.targetId].forEach((id) => {
      const p = players.find((pl) => pl.id === id);
      if (p) maybeCompleteObjective(p);
    });
  });
}

// "Dedahkan" - the one moment a contract goes public.
function hostExposeContract(requesterId, contractId) {
  const players = room.getPlayersLive();
  const result = exposeContract(contractId, requesterId, players, { round: currentRound });
  if (!result.ok) return;
  const { offerer, target, refund, debt, penalty } = result;
  const cfgD = GAME_BALANCE.backroomDeals;
  const money = (p) => [p.money ? formatMoney(p.money) : '', p.influence ? `${p.influence} Influence` : ''].filter(Boolean).join(' + ');
  const refundText = money(refund) ? ` ${target.name} dipaksa memulangkan ${money(refund)}.` : '';
  const fineText = money(penalty.target) ? ` ${target.name} turut didenda ${money(penalty.target)}.` : '';
  const seatText = penalty.target.ranksLost ? ` ${target.name} jatuh ${penalty.target.ranksLost} kerusi.` : '';
  const debtText = money(debt) ? ` Wang sudah habis? Tiada alasan — ${money(debt)} dikira sebagai hutang.` : '';
  const offererText = penalty.offerer.money ? ` ${offerer.name} didenda ${formatMoney(penalty.offerer.money)}.` : '';
  postNews({
    icon: '🗂️',
    headline: 'DOKUMEN RASUAH BOCOR',
    description: `${offerer.name} mendedahkan bahawa ${target.name} memungkiri perjanjian sulit mereka. ${target.name} +${cfgD.exposeTargetScandal}% Skandal dan digelar Pecah Amanah; ${offerer.name} +${cfgD.exposeOffererScandal}% Skandal kerana terlibat sama.${refundText}${fineText}${seatText}${debtText}${offererText}`,
    feedText: `🗂️ ${offerer.name} mendedahkan ${target.name} — Pecah Amanah!${penalty.target.ranksLost ? ` ${target.name} jatuh kerusi.` : ''} (+${cfgD.exposeTargetScandal}% Skandal)`,
    feedType: 'news',
  });
  maybeCompleteObjective(offerer);
  maybeCompleteObjective(target);
  notifyPlayer(offerer.id, 'deal-contract-event', { kind: 'exposed', contract: result.contract, role: 'offerer', otherId: target.id });
  notifyPlayer(target.id, 'deal-contract-event', { kind: 'exposed', contract: result.contract, role: 'target', otherId: offerer.id });
  broadcastMatchUpdate();
}

// ---------- Backroom chat (private; see backroomChat.js) ----------

function deliverChat(message, aId, bId) {
  notifyPlayer(aId, 'deal-chat', { otherId: bId, message });
  notifyPlayer(bId, 'deal-chat', { otherId: aId, message });
}

// The host is the authority: it checks the two are linked by a deal/contract,
// records the message, and delivers it to those two players only. A bot on
// the other end just answers with a stock line.
function hostSendChat(senderId, otherId, text, respond) {
  const players = room.getPlayersLive();
  const sender = players.find((p) => p.id === senderId);
  const other = players.find((p) => p.id === otherId);
  if (!sender || !other) return;
  const result = recordMessage(senderId, otherId, text, currentRound, hasDealBetween(senderId, otherId));
  if (!result.ok) {
    respond({ type: 'action-rejected', payload: { reason: `chat-${result.reason}` } });
    return;
  }
  deliverChat(result.message, senderId, otherId);

  if (other.isBot && !sender.isBot) {
    const timer = setTimeout(() => {
      botChatTimers.delete(timer);
      const kind = getContractViewsFor(senderId).some((c) => c.offererId === otherId || c.targetId === otherId) ? 'contract' : 'pending';
      const reply = recordMessage(otherId, senderId, pickBotChatReply(kind), currentRound, hasDealBetween(senderId, otherId));
      if (reply.ok) deliverChat(reply.message, otherId, senderId);
    }, GAME_BALANCE.backroomDeals.chat.botReplyDelayMs);
    botChatTimers.add(timer);
  }
}

function hostChatHistory(requesterId, otherId, respond) {
  const allowed = hasDealBetween(requesterId, otherId);
  respond({ type: 'deal-chat-history', payload: { otherId, messages: allowed ? getTranscript(requesterId, otherId) : [] } });
}

function clearBotChatTimers() {
  botChatTimers.forEach((t) => clearTimeout(t));
  botChatTimers.clear();
}

// What a bot has to do (or may try to dodge) to stay on the right side of
// the contracts it accepted. A bot that decided to betray one does the
// forbidden thing whenever it is possible. Everything here is validated
// against the same rules the resolvers use, because a rejected bot action
// would leave the turn stuck.
function buildBotContractPlan(bot, players) {
  const plan = { avoidTargetIds: new Set(), avoidPolitikRank: null, forceSabotajVictimId: null, betrayTargetId: null, betrayPolitikRank: null };
  getActiveContractsAsTarget(bot.id).forEach((c) => {
    const { condition } = c;
    if (condition.type === 'noharm') {
      if (c.botWillBreak) plan.betrayTargetId = c.offererId; else plan.avoidTargetIds.add(c.offererId);
    } else if (condition.type === 'nopolitik') {
      if (c.botWillBreak) plan.betrayPolitikRank = condition.rank; else plan.avoidPolitikRank = condition.rank;
    } else if (condition.type === 'sabotage') {
      if (c.botWillBreak) plan.avoidTargetIds.add(condition.victimId);
      else if (c.feasible) plan.forceSabotajVictimId = condition.victimId;
    }
  });
  return plan;
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
    hostProposeDeal(conn.peer, payload?.targetId, payload?.money || 0, payload?.influence || 0, payload?.condition, respond);
  } else if (type === 'deal-respond') {
    hostRespondToDeal(conn.peer, payload?.dealId, Boolean(payload?.accept));
  } else if (type === 'deal-expose') {
    hostExposeContract(conn.peer, payload?.contractId);
  } else if (type === 'chat-send') {
    hostSendChat(conn.peer, payload?.otherId, payload?.text, respond);
  } else if (type === 'chat-history') {
    hostChatHistory(conn.peer, payload?.otherId, respond);
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
    // The host's clock isn't ours, so the countdown is rebuilt from the
    // time-remaining it sent rather than from its absolute deadline.
    pendingVote = payload.pendingVote ? { ...payload.pendingVote, deadline: Date.now() + payload.pendingVote.remainingMs } : null;
    turnSkipping = Boolean(payload.skipping);
    advancedMode = Boolean(payload.advancedMode);
    marketStock = payload.marketStock || [];
    passivePayout = payload.passivePayout || null;
    clientContracts = payload.contracts || [];
    clientPendingDeals = payload.pendingDeals || [];
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
  } else if (type === 'deal-contract-event') {
    bus.emit('match:deal-contract-event', payload);
  } else if (type === 'deal-chat') {
    bus.emit('match:deal-chat', payload);
  } else if (type === 'deal-chat-history') {
    bus.emit('match:deal-chat-history', payload);
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
    bus.emit('match:offers', { action: 'market', offers: player && advancedMode ? generateMarketOffers(player, marketStock) : [] });
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
export function proposeBackroomDeal(targetId, money, influence, condition = { type: 'none' }) {
  if (isHostRole()) {
    hostProposeDeal(room.getRoomSnapshot().localPlayerId, targetId, money, influence, condition, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'deal-propose', payload: { targetId, money, influence, condition } });
  }
}

// "Dedahkan" a contract the other side broke. Free; only the offerer can.
export function exposeBackroomContract(contractId) {
  if (isHostRole()) {
    hostExposeContract(room.getRoomSnapshot().localPlayerId, contractId);
  } else {
    multiplayer.send({ type: 'deal-expose', payload: { contractId } });
  }
}

export function respondToBackroomDeal(dealId, accept) {
  if (isHostRole()) {
    hostRespondToDeal(room.getRoomSnapshot().localPlayerId, dealId, accept);
  } else {
    multiplayer.send({ type: 'deal-respond', payload: { dealId, accept } });
  }
}

// Private chat with the other party of a pending deal / contract. Any time,
// never turn-gated; the host validates and records it.
export function sendBackroomChat(otherId, text) {
  if (isHostRole()) {
    hostSendChat(room.getRoomSnapshot().localPlayerId, otherId, text, (msg) => {
      bus.emit('match:action-rejected', { reason: msg.payload.reason });
    });
  } else {
    multiplayer.send({ type: 'chat-send', payload: { otherId, text } });
  }
}

export function requestBackroomChatHistory(otherId) {
  if (isHostRole()) {
    hostChatHistory(room.getRoomSnapshot().localPlayerId, otherId, (msg) => bus.emit('match:deal-chat-history', msg.payload));
  } else {
    multiplayer.send({ type: 'chat-history', payload: { otherId } });
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
  turnSkipping = false;
  passivePayout = null;
  clearTimeout(voteTimer);
  voteTimer = null;
  resetDeals();
  resetChats();
  clearBotChatTimers();
  clientPendingDeals = [];

  const roomSnap = room.getRoomSnapshot();
  maxRounds = roomSnap.settings.rounds;
  advancedMode = Boolean(roomSnap.settings.advancedMode);
  marketStock = [];

  if (isHostRole()) {
    const players = room.getPlayersLive();
    players.forEach(initMatchState);
    if (advancedMode) {
      marketStock = generateMarketStock(players.length);
      players.forEach((p) => { p.assets = []; });
    } else {
      dealStartingAssets(players);
    }
    players.forEach(assignSecretObjective);
    // Mode Watak: each player is dealt a distinct secret character. Skipped
    // entirely when the setting is off, so the match is exactly as before.
    if (roomSnap.settings.characters) dealCharacters(players);
    currentRound = 1;
    const bySlot = [...players].sort((a, b) => a.slot - b.slot);
    turnSlot = (bySlot.find((p) => p.connected) || bySlot[0]).slot;
    multiplayer.onMessage(handleHostMatchMessage);
    broadcastMatchUpdate();
    maybeTriggerBotTurn(getActivePlayer(players));
  } else {
    multiplayer.onMessage(handleClientMatchMessage);
  }
});

bus.on('room:left', () => resetMatch());

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
  clientContracts = [];
  clientPendingDeals = [];
  kabelClaimed = false;
  pendingNews = null;
  pendingVote = null;
  turnSkipping = false;
  advancedMode = false;
  marketStock = [];
  passivePayout = null;
  clearTimeout(voteTimer);
  voteTimer = null;
  resetDeals();
  resetChats();
  clearBotChatTimers();
}
