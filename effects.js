// Shared resolution helpers for scandal, Public Support, and seat capacity.
// Pure state mutations - no networking, no DOM.

import { clamp } from './utils.js';
import { RANKS, SEAT_CAPACITY } from './player.js';
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

  player.money = Math.floor(player.money * (1 - SCANDAL_MONEY_LOSS_PERCENT / 100));
  player.scandal = SCANDAL_PENALTY_RESET;

  const index = RANKS.indexOf(player.rank);
  if (index > 0) {
    const lowerRank = RANKS[index - 1];
    if (countAtRank(players, lowerRank) < SEAT_CAPACITY[lowerRank]) {
      player.rank = lowerRank;
    }
  }
  return true;
}

export function countAtRank(players, rank) {
  return players.filter((p) => p.rank === rank).length;
}

export function hasOpenSeat(players, rank) {
  return countAtRank(players, rank) < SEAT_CAPACITY[rank];
}
