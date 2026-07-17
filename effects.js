// Shared resolution helpers for scandal, Media Shield, and seat capacity.
// Pure state mutations - no networking, no DOM.

import { clamp } from './utils.js';
import { RANKS, SEAT_CAPACITY } from './player.js';

export const SCANDAL_PENALTY_THRESHOLD = 100;
export const SCANDAL_PENALTY_RESET = 30;
export const MEDIA_SHIELD_REDUCTION = 0.5;

export function getScandalStatus(scandal) {
  if (scandal >= 100) return 'Ditahan';
  if (scandal >= 60) return 'Disiasat';
  if (scandal >= 30) return 'Diperhati';
  return 'Bersih';
}

// Positive delta = incoming scandal (reduced by an active Media Shield).
// Negative delta = a reduction, applied directly with no shield interaction.
export function applyScandalDelta(player, delta) {
  let applied = delta;
  if (delta > 0 && player.mediaShieldTurns > 0) {
    applied = Math.round(delta * MEDIA_SHIELD_REDUCTION);
  }
  player.scandal = clamp(player.scandal + applied, 0, 100);
  return applied;
}

// Ticks down every player's Media Shield once per turn taken at the table
// (not just the shield-holder's own turns) - the shield exists to protect
// against Sabotaj/Alih Perhatian between a player's own turns.
export function tickMediaShields(players) {
  players.forEach((p) => {
    if (p.mediaShieldTurns > 0) p.mediaShieldTurns -= 1;
  });
}

// Returns true if a rank was actually lost. If the player is already at the
// lowest rank, or the rank below is at capacity (a rare 3-vs-1 seat squeeze
// with only 4 players), the demotion is skipped but money/scandal still
// reset - the invariant "count(rank) <= SEAT_CAPACITY[rank]" is best-effort,
// not hard-enforced, since the spec gives no fallback for that edge case.
export function applyScandalPenalty(player, players) {
  if (player.scandal < SCANDAL_PENALTY_THRESHOLD) return false;

  player.money = Math.floor(player.money / 2);
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
