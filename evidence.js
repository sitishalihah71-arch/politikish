// Shadow Politics (Mode Watak): Evidence Tokens and the Backroom Deal
// consequence matrix (GDD sections 4 and 5).
//
// Every ACCEPTED Backroom Deal leaves exactly one Evidence Token in a
// host-only registry. A token records who, what, how much and when, and stays
// hidden until a valid exposure reveals it. Nothing here is ever broadcast:
// the characters that read tokens (Phase 3) ask the host, like every other
// private thing in this game.
//
// Rules this module enforces:
//   - one token per accepted deal; tokens are never copied or recreated;
//   - a token can be exposed once, and its penalties are applied once;
//   - tokens point at player SLOTS, not ids (an id changes when someone
//     reconnects, see room.js);
//   - every figure comes from GAME_BALANCE.shadowPolitics.consequences.
//
// Pure state changes only: no networking, no DOM, no timers.

import { GAME_BALANCE } from './balance.js';
import { adjustBalance, addCorruption, addSkipTurns, applyApprovalDelta } from './effects.js';
import { reduceMoneyPenalty } from './abilities.js';

const cfg = GAME_BALANCE.shadowPolitics;
const CLEAN_POLITICIAN = 'cleanPolitician';

let tokenSeq = 0;
let tokens = []; // every token ever recorded this match, host-side only

export function resetEvidence() {
  tokens = [];
  tokenSeq = 0;
}

const isCleanPolitician = (player) => player?.character?.id === CLEAN_POLITICIAN;

// What a player's skip is when one of their deals is exposed: the table's
// number, or the Clean Politician's longer suspension.
function skipTurnsFor(player, base) {
  return isCleanPolitician(player) ? Math.max(base, cfg.consequences.cleanPoliticianSkipTurns) : base;
}

// ---------- Recording ----------

// A deal was just accepted and its payment moved. Applies the Corruption and
// Public Trust the acceptance itself costs (GDD 4.1, 4.2) and records the
// token. Returns { token, corruption: {initiator, recipient} }.
// `initiatorCorruption` overrides the standard amount for one named case: the
// Fixer's own Fixer Deal (GDD 4.1: character exceptions must be explicit).
export function recordAcceptedDeal({ initiator, recipient, dealType, money, influence, round, contractId = null, initiatorCorruption = cfg.corruptionPerAcceptedDeal }) {
  const corruption = {
    initiator: addCorruption(initiator, initiatorCorruption),
    recipient: addCorruption(recipient, cfg.corruptionPerAcceptedDeal),
  };
  applyApprovalDelta(recipient, cfg.trustAcceptCorruptDeal);

  tokenSeq += 1;
  const token = {
    id: `token-${tokenSeq}`,
    initiatorSlot: initiator.slot,
    recipientSlot: recipient.slot,
    dealType,
    value: { money, influence },
    round,
    contractId,
    exposed: false,
    exposedRound: null,
  };
  tokens.push(token);
  return { token: copyOf(token), corruption };
}

function copyOf(token) {
  return { ...token, value: { ...token.value } };
}

export function getTokens() {
  return tokens.map(copyOf);
}

export function getToken(tokenId) {
  const token = tokens.find((t) => t.id === tokenId);
  return token ? copyOf(token) : null;
}

// Hidden tokens that involve a slot (either side).
export function getTokensInvolving(slot, { includeExposed = true } = {}) {
  return tokens.filter((t) => (t.initiatorSlot === slot || t.recipientSlot === slot) && (includeExposed || !t.exposed)).map(copyOf);
}

// A Dedahkan on a conditional deal is that deal's public exposure, so its
// token is spent with it: it cannot be exposed a second time for the same
// deal. (The Dedahkan penalties themselves are separate and unchanged.)
export function markContractExposed(contractId, round) {
  const token = tokens.find((t) => t.contractId === contractId);
  if (token && !token.exposed) {
    token.exposed = true;
    token.exposedRound = round;
  }
}

// ---------- Exposure ----------

// Takes money / Influence the way every other effect does: never below zero
// for someone who is not already in debt. The Money part first goes through
// the Lawyer's passive and any armed Lawyer / Ally shield (abilities.js);
// Influence is never reduced. Returns what was really taken.
function take(player, money, influence, ctx) {
  const penalty = reduceMoneyPenalty(player, money, ctx);
  const lostMoney = penalty.amount ? -adjustBalance(player, 'money', -penalty.amount) : 0;
  const lostInfluence = influence ? -adjustBalance(player, 'influence', -influence) : 0;
  return { money: lostMoney, influence: lostInfluence, reducedBy: penalty.reducedBy, shieldsUsed: penalty.shieldsUsed, allyBonus: penalty.allyBonus };
}

// An accepted deal was exposed by someone holding its token. `exposer` is
// whoever did it (gets the small Public Trust reward unless they are one of
// the two parties). Penalties are applied once: a second call is refused.
// reason codes: 'token-not-found' | 'already-exposed' | 'player-missing'
export function exposeToken(tokenId, players, { round = null, exposerSlot = null } = {}) {
  const token = tokens.find((t) => t.id === tokenId);
  if (!token) return { ok: false, reason: 'token-not-found' };
  if (token.exposed) return { ok: false, reason: 'already-exposed' };
  const initiator = players.find((p) => p.slot === token.initiatorSlot);
  const recipient = players.find((p) => p.slot === token.recipientSlot);
  if (!initiator || !recipient) return { ok: false, reason: 'player-missing' };

  // Marked first: whatever happens below, these penalties can never repeat.
  token.exposed = true;
  token.exposedRound = round;

  const table = cfg.consequences.exposedAfterAccept;
  const result = { initiator: {}, recipient: {} };
  [['initiator', initiator], ['recipient', recipient]].forEach(([side, player]) => {
    const row = table[side];
    const lost = take(player, row.money || 0, row.influence || 0, { players, involvedSlots: [initiator.slot, recipient.slot] });
    const skipTurns = skipTurnsFor(player, row.skipTurns || 0);
    addSkipTurns(player, skipTurns, 'deal-exposed');
    const corruption = row.corruption ? addCorruption(player, row.corruption) : 0;
    result[side] = { playerId: player.id, slot: player.slot, ...lost, skipTurns, corruption };
  });

  let exposerReward = 0;
  const exposer = exposerSlot === null ? null : players.find((p) => p.slot === exposerSlot);
  if (exposer && exposer.slot !== initiator.slot && exposer.slot !== recipient.slot) {
    const before = exposer.approval;
    applyApprovalDelta(exposer, cfg.trustExposeSuccess);
    exposerReward = exposer.approval - before;
  }
  return { ok: true, token: copyOf(token), result, exposerReward };
}

// A deal was exposed before the recipient accepted it (nothing was paid, no
// token exists). The initiator pays, the recipient is rewarded.
export function applyExposedBeforeAccept(initiator, recipient, players = []) {
  const row = cfg.consequences.exposedBeforeAccept;
  const lost = take(initiator, row.initiator.money, row.initiator.influence, { players, involvedSlots: [initiator.slot, recipient.slot] });
  const skipTurns = skipTurnsFor(initiator, row.initiator.skipTurns);
  addSkipTurns(initiator, skipTurns, 'deal-exposed');

  const trustBefore = recipient.approval;
  applyApprovalDelta(recipient, row.recipient.trust);
  const influenceBefore = recipient.influence;
  adjustBalance(recipient, 'influence', row.recipient.influence);
  return {
    initiator: { playerId: initiator.id, slot: initiator.slot, ...lost, skipTurns },
    recipient: {
      playerId: recipient.id,
      slot: recipient.slot,
      trust: recipient.approval - trustBefore,
      influence: recipient.influence - influenceBefore,
    },
  };
}
