// Sabotaj action: steal an occupied seat one rank up. Only available when
// the next rank has no empty seats (the mirror-image condition of Politik).
//
// KABEL is not a separate system - it's the same action with the "directly
// above, and only if full" restriction lifted, and its own target-rank-based
// chance table instead of the attacker-rank-based one. Both modes share the
// same cost/chance math, resolution (rank swap), and confirmation dialog.

import { RANKS, getNextRank } from './player.js';
import { applyScandalDelta, hasOpenSeat } from './effects.js';
import { hasAsset } from './politicalOpportunities.js';
import { GAME_BALANCE } from './balance.js';

const { sabotage: cfg, kabel: kabelCfg } = GAME_BALANCE;
const ROYAL_CONNECTION_PENALTY = GAME_BALANCE.politicalOpportunity.assets.royalConnection.sabotageDefensePercent / 100;

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

// KABEL: base chance is keyed by the TARGET's rank (how hard that seat is
// to take), not the attacker's - there's no "from rank" step ladder since
// it can jump straight from Ahli to President.
export const KABEL_TABLE = {
  ketua: { chance: kabelCfg.targetChances.ketua / 100 },
  deputy: { chance: kabelCfg.targetChances.deputy / 100 },
  president: { chance: kabelCfg.targetChances.president / 100 },
};
export const KABEL_COST = kabelCfg.cost;

// Shared by both normal Sabotaj and Kabel - only the base chance differs.
// Public Support and Royal Connection stack as two independent penalties -
// a well-defended target can hold both at once.
function computeChanceBreakdown(baseChance, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection) {
  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  const preCap = baseChance + steps * SABOTAGE_EXTRA_BONUS;
  const capped = Math.min(preCap, SABOTAGE_MAX_CHANCE);
  const extraBonus = capped - baseChance;
  const publicSupportPenalty = targetHasPublicSupport ? PUBLIC_SUPPORT_PENALTY : 0;
  const royalConnectionPenalty = targetHasRoyalConnection ? ROYAL_CONNECTION_PENALTY : 0;
  const final = Math.max(capped - publicSupportPenalty - royalConnectionPenalty, SABOTAGE_MIN_CHANCE);
  return { base: baseChance, extraBonus, publicSupportPenalty, royalConnectionPenalty, final };
}

// Breaks the final chance down into its contributing components, so the UI
// can render the same "Base / Extra Influence / Public Support / Royal
// Connection / Final" calculation shown to the player before they confirm.
export function describeSabotajChance(fromRank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection) {
  const config = SABOTAGE_TABLE[fromRank];
  if (!config) return { base: 0, extraBonus: 0, publicSupportPenalty: 0, royalConnectionPenalty: 0, final: 0 };
  return computeChanceBreakdown(config.baseChance, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection);
}

export function describeKabelChance(targetRank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection) {
  const config = KABEL_TABLE[targetRank];
  if (!config) return { base: 0, extraBonus: 0, publicSupportPenalty: 0, royalConnectionPenalty: 0, final: 0 };
  return computeChanceBreakdown(config.chance, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection);
}

export function calculateSabotajChance(fromRank, extraInfluence, targetHasPublicSupport = false, targetHasRoyalConnection = false) {
  return describeSabotajChance(fromRank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection).final;
}

export function calculateKabelChance(targetRank, extraInfluence, targetHasPublicSupport = false, targetHasRoyalConnection = false) {
  return describeKabelChance(targetRank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection).final;
}

export function getSabotajCost(fromRank, extraInfluence) {
  const config = SABOTAGE_TABLE[fromRank];
  if (!config) return null;
  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  return config.baseCost + steps * SABOTAGE_EXTRA_STEP;
}

export function getKabelCost(extraInfluence) {
  const steps = Math.floor(Math.max(extraInfluence, 0) / SABOTAGE_EXTRA_STEP);
  return KABEL_COST + steps * SABOTAGE_EXTRA_STEP;
}

// reason codes: 'no-next-rank' | 'seat-not-full' | 'invalid-target' | 'insufficient-influence'
export function validateSabotaj(attacker, target, players, extraInfluence, { isKabel = false } = {}) {
  if (isKabel) {
    if (!target || target.id === attacker.id || RANKS.indexOf(target.rank) <= RANKS.indexOf(attacker.rank)) {
      return { ok: false, reason: 'invalid-target' };
    }
    const cost = getKabelCost(extraInfluence);
    if (attacker.influence < cost) return { ok: false, reason: 'insufficient-influence' };
    return { ok: true, toRank: target.rank, cost, isKabel: true };
  }

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

export function resolveSabotaj(attacker, target, players, extraInfluence, options = {}, rng = Math.random) {
  const validation = validateSabotaj(attacker, target, players, extraInfluence, options);
  if (!validation.ok) return validation;

  const { toRank, cost, isKabel } = validation;
  const targetHasPublicSupport = target.publicSupportTurns > 0;
  const targetHasRoyalConnection = hasAsset(target, 'royalConnection');
  const chance = isKabel
    ? calculateKabelChance(target.rank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection)
    : calculateSabotajChance(attacker.rank, extraInfluence, targetHasPublicSupport, targetHasRoyalConnection);
  attacker.influence -= cost;

  const success = rng() < chance;
  if (success) {
    const attackerOldRank = attacker.rank;
    attacker.rank = toRank;
    target.rank = attackerOldRank;
    attacker.stats.sabotagesSucceeded += 1;
    applyScandalDelta(attacker, -15);
  } else {
    applyScandalDelta(attacker, 15);
  }

  return { ok: true, success, chance, cost, toRank, targetId: target.id, isKabel: Boolean(isKabel) };
}
