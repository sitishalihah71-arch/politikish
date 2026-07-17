// Politik action: promote into an EMPTY seat one rank up. Keyed by the
// player's *current* rank (the rank being promoted from).

import { getNextRank } from './player.js';
import { applyScandalDelta, hasOpenSeat } from './effects.js';

export const PROMOTION_TABLE = {
  ahli: { baseCost: 100, baseChance: 0.8 },
  ketua: { baseCost: 200, baseChance: 0.65 },
  deputy: { baseCost: 350, baseChance: 0.5 },
};

export const PROMOTION_EXTRA_STEP = 50;
export const PROMOTION_EXTRA_BONUS = 0.1;
export const PROMOTION_MAX_CHANCE = 0.95;

export function calculatePolitikChance(fromRank, extraInfluence) {
  const config = PROMOTION_TABLE[fromRank];
  if (!config) return 0;
  const steps = Math.floor(Math.max(extraInfluence, 0) / PROMOTION_EXTRA_STEP);
  return Math.min(config.baseChance + steps * PROMOTION_EXTRA_BONUS, PROMOTION_MAX_CHANCE);
}

export function getPolitikCost(fromRank, extraInfluence) {
  const config = PROMOTION_TABLE[fromRank];
  if (!config) return null;
  const steps = Math.floor(Math.max(extraInfluence, 0) / PROMOTION_EXTRA_STEP);
  return config.baseCost + steps * PROMOTION_EXTRA_STEP;
}

// reason codes: 'no-next-rank' | 'seat-full' | 'insufficient-influence'
export function validatePolitik(player, players, extraInfluence) {
  const toRank = getNextRank(player.rank);
  if (!toRank) return { ok: false, reason: 'no-next-rank' };
  if (!hasOpenSeat(players, toRank)) return { ok: false, reason: 'seat-full' };
  const cost = getPolitikCost(player.rank, extraInfluence);
  if (player.influence < cost) return { ok: false, reason: 'insufficient-influence' };
  return { ok: true, toRank, cost };
}

export function resolvePolitik(player, players, extraInfluence, rng = Math.random) {
  const validation = validatePolitik(player, players, extraInfluence);
  if (!validation.ok) return validation;

  const { toRank, cost } = validation;
  const chance = calculatePolitikChance(player.rank, extraInfluence);
  player.influence -= cost;

  const success = rng() < chance;
  if (success) {
    player.rank = toRank;
    applyScandalDelta(player, -15);
  }

  return { ok: true, success, chance, cost, toRank };
}
