// Sabotaj action: steal an occupied seat one rank up. Only available when
// the next rank has no empty seats (the mirror-image condition of Politik).

import { getNextRank } from './player.js';
import { applyScandalDelta, hasOpenSeat } from './effects.js';

export const SABOTAGE_TABLE = {
  ahli: { baseCost: 150, baseChance: 0.6 },
  ketua: { baseCost: 250, baseChance: 0.45 },
  deputy: { baseCost: 400, baseChance: 0.3 },
};

export const SABOTAGE_EXTRA_STEP = 50;
export const SABOTAGE_EXTRA_BONUS = 0.1;
export const SABOTAGE_MAX_CHANCE = 0.9;

export function calculateSabotajChance(fromRank, extraInfluence) {
  const config = SABOTAGE_TABLE[fromRank];
  if (!config) return 0;
  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  return Math.min(config.baseChance + steps * SABOTAGE_EXTRA_BONUS, SABOTAGE_MAX_CHANCE);
}

export function getSabotajCost(fromRank, extraInfluence) {
  const config = SABOTAGE_TABLE[fromRank];
  if (!config) return null;
  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  return config.baseCost + steps * SABOTAGE_EXTRA_STEP;
}

// reason codes: 'no-next-rank' | 'seat-not-full' | 'invalid-target' | 'insufficient-influence'
export function validateSabotaj(attacker, target, players, extraInfluence) {
  const toRank = getNextRank(attacker.rank);
  if (!toRank) return { ok: false, reason: 'no-next-rank' };
  if (hasOpenSeat(players, toRank)) return { ok: false, reason: 'seat-not-full' };
  if (!target || target.rank !== toRank || target.id === attacker.id) {
    return { ok: false, reason: 'invalid-target' };
  }
  const cost = getSabotajCost(attacker.rank, extraInfluence);
  if (attacker.influence < cost) return { ok: false, reason: 'insufficient-influence' };
  return { ok: true, toRank, cost };
}

export function resolveSabotaj(attacker, target, players, extraInfluence, rng = Math.random) {
  const validation = validateSabotaj(attacker, target, players, extraInfluence);
  if (!validation.ok) return validation;

  const { toRank, cost } = validation;
  const chance = calculateSabotajChance(attacker.rank, extraInfluence);
  attacker.influence -= cost;

  const success = rng() < chance;
  if (success) {
    const attackerOldRank = attacker.rank;
    attacker.rank = toRank;
    target.rank = attackerOldRank;
    applyScandalDelta(attacker, -15);
  } else {
    applyScandalDelta(attacker, 15);
  }

  return { ok: true, success, chance, cost, toRank, targetId: target.id };
}
