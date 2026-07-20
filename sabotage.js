// Sabotaj action: steal an occupied seat one rank up. Only available when
// the next rank has no empty seats (the mirror-image condition of Politik).

import { getNextRank } from './player.js';
import { applyScandalDelta, hasOpenSeat } from './effects.js';
import { GAME_BALANCE } from './balance.js';

const { sabotage: cfg } = GAME_BALANCE;

export const SABOTAGE_TABLE = {
  ahli: { baseCost: cfg.ahli.cost, baseChance: cfg.ahli.chance / 100 },
  ketua: { baseCost: cfg.ketua.cost, baseChance: cfg.ketua.chance / 100 },
  deputy: { baseCost: cfg.deputy.cost, baseChance: cfg.deputy.chance / 100 },
};

export const SABOTAGE_EXTRA_STEP = cfg.extraInfluenceStep;
export const SABOTAGE_EXTRA_BONUS = cfg.extraInfluenceBonus / 100;
export const SABOTAGE_MAX_CHANCE = cfg.maxChance / 100;
export const PUBLIC_SUPPORT_PENALTY = cfg.publicSupportPenalty / 100;
export const SABOTAGE_MIN_CHANCE = cfg.minimumChance / 100;

// Breaks the final chance down into its contributing components, so the UI
// can render the same "Base / Extra Influence / Public Support / Final"
// calculation shown to the player before they confirm the attack.
export function describeSabotajChance(fromRank, extraInfluence, targetHasPublicSupport) {
  const config = SABOTAGE_TABLE[fromRank];
  if (!config) return { base: 0, extraBonus: 0, publicSupportPenalty: 0, final: 0 };

  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  const preCap = config.baseChance + steps * SABOTAGE_EXTRA_BONUS;
  const capped = Math.min(preCap, SABOTAGE_MAX_CHANCE);
  const extraBonus = capped - config.baseChance;
  const penalty = targetHasPublicSupport ? PUBLIC_SUPPORT_PENALTY : 0;
  const final = Math.max(capped - penalty, SABOTAGE_MIN_CHANCE);

  return { base: config.baseChance, extraBonus, publicSupportPenalty: penalty, final };
}

export function calculateSabotajChance(fromRank, extraInfluence, targetHasPublicSupport = false) {
  return describeSabotajChance(fromRank, extraInfluence, targetHasPublicSupport).final;
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
  const targetHasPublicSupport = target.publicSupportTurns > 0;
  const chance = calculateSabotajChance(attacker.rank, extraInfluence, targetHasPublicSupport);
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
