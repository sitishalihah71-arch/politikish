// Shared resolution helpers for scandal, Public Support, and seat capacity.
// Pure state mutations - no networking, no DOM.

import { clamp } from './utils.js';
import { RANKS, getSeatCapacity } from './player.js';
import { GAME_BALANCE } from './balance.js';

export const SCANDAL_PENALTY_THRESHOLD = GAME_BALANCE.scandal.penaltyThreshold;
export const SCANDAL_PENALTY_RESET = GAME_BALANCE.scandal.resetTo;
export const SCANDAL_MONEY_LOSS_PERCENT = GAME_BALANCE.scandal.moneyLossPercent;
export const PUBLIC_SUPPORT_SCANDAL_REDUCTION = GAME_BALANCE.publicSupport.scandalReduction / 100;

export function getScandalStatus(scandal) {
  if (scandal >= 100) return 'Ditahan';
  if (scandal >= 60) return 'Disiasat';
  if (scandal >= 30) return 'Diperhati';
  return 'Bersih';
}

// Approval Rating has no interactions to account for (unlike Scandal's
// Public Support reduction) - just a plain clamp.
export function applyApprovalDelta(player, delta) {
  player.approval = clamp(player.approval + delta, 0, 100);
}

// Money/Influence can go negative in exactly one way: a Dedahkan refund the
// target can no longer cover is taken as debt (backroomDeals.js). Every other
// effect that moves a balance must go through here so it neither pushes a
// debtor deeper nor quietly wipes the debt: a loss never drops the balance
// below max-of(0, what they already had), and a gain pays the debt down first.
export function adjustBalance(player, key, delta) {
  const current = player[key];
  player[key] = Math.max(Math.min(current, 0), current + delta);
  return player[key] - current;
}

// Positive delta = incoming scandal (reduced by active Public Support).
// Negative delta = a reduction, applied directly with no interaction.
export function applyScandalDelta(player, delta) {
  let applied = delta;
  if (delta > 0 && player.publicSupportTurns > 0) {
    applied = Math.round(delta * (1 - PUBLIC_SUPPORT_SCANDAL_REDUCTION));
  }
  player.scandal = clamp(player.scandal + applied, 0, 100);
  return applied;
}

// Public Support only ticks down at the end of its owner's own turn, not on
// every turn taken at the table - callers pass just that one player.
export function tickPublicSupport(player) {
  if (player && player.publicSupportTurns > 0) player.publicSupportTurns -= 1;
}

// Returns true if a rank was actually lost. If the player is already at the
// lowest rank, or the rank below is at capacity (a rare 3-vs-1 seat squeeze
// with only 4 players), the demotion is skipped but money/scandal still
// reset - the invariant "count(rank) <= SEAT_CAPACITY[rank]" is best-effort,
// not hard-enforced, since the spec gives no fallback for that edge case.
export function applyScandalPenalty(player, players) {
  if (player.scandal < SCANDAL_PENALTY_THRESHOLD) return false;

  // Debt is not "money" to lose half of (halving a negative would forgive it).
  if (player.money > 0) player.money = Math.floor(player.money * (1 - SCANDAL_MONEY_LOSS_PERCENT / 100));
  player.scandal = SCANDAL_PENALTY_RESET;
  applyApprovalDelta(player, -GAME_BALANCE.approvalRating.scandalPenaltyPenalty);

  demoteOneRank(player, players);
  return true;
}

// Drops a player one rank if there is one below and it has a free seat
// (best-effort, as above). Returns true if the rank actually changed.
export function demoteOneRank(player, players) {
  const index = RANKS.indexOf(player.rank);
  if (index <= 0) return false;
  const lowerRank = RANKS[index - 1];
  if (countAtRank(players, lowerRank) >= getSeatCapacity(players.length)[lowerRank]) return false;
  player.rank = lowerRank;
  return true;
}

export function countAtRank(players, rank) {
  return players.filter((p) => p.rank === rank).length;
}

export function hasOpenSeat(players, rank) {
  return countAtRank(players, rank) < getSeatCapacity(players.length)[rank];
}

// ---------- Turn-skip counter ----------
// `skipNextTurn` started life as a boolean (a leaked bribe benches you once).
// It is now a counter so one incident can bench a player for several turns
// (Shadow Politics: the Clean Politician skips 2). `true` still means 1, and
// an empty counter is stored as `false`, exactly like before.
export function addSkipTurns(player, turns, reason = null) {
  if (!(turns > 0)) return 0;
  const cap = GAME_BALANCE.shadowPolitics.maxSkipTurns;
  const total = Math.min(cap, (Number(player.skipNextTurn) || 0) + turns);
  player.skipNextTurn = total > 0 ? total : false;
  if (reason) player.skipReason = reason;
  return total;
}

// Uses up one pending skip. Returns the reason to announce.
export function consumeSkipTurn(player) {
  const left = (Number(player.skipNextTurn) || 0) - 1;
  const reason = player.skipReason || 'bribery-leak';
  player.skipNextTurn = left > 0 ? left : false;
  if (!player.skipNextTurn) delete player.skipReason;
  return reason;
}

// ---------- Corruption (Shadow Politics) ----------
// Corruption Points are the Scandal meter. Gains from deals are reduced by
// active Public Support like any other Scandal and stop at the cap, so they
// never trigger the 100% penalty by themselves. Returns what was actually added.
export function addCorruption(player, amount) {
  const before = player.scandal;
  applyScandalDelta(player, amount);
  const cap = GAME_BALANCE.shadowPolitics.corruptionCap;
  // Never above the cap, and never pulling down someone who already sits above it.
  player.scandal = Math.min(player.scandal, Math.max(before, cap));
  return player.scandal - before;
}
