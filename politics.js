// Politik action: promote into an EMPTY seat one rank up. Keyed by the
// player's *current* rank (the rank being promoted from).

import { getNextRank } from './player.js';
import { applyScandalDelta, applyApprovalDelta, hasOpenSeat } from './effects.js';
import { hasAsset } from './politicalOpportunities.js';
import { GAME_BALANCE } from './balance.js';

const { politics: cfg } = GAME_BALANCE;
const PARTY_MACHINERY_BONUS = GAME_BALANCE.politicalOpportunity.assets.partyMachinery.promotionChanceBonusPercent / 100;

export const PROMOTION_TABLE = {
  ahli: { baseCost: cfg.ahli.cost, baseChance: cfg.ahli.chance / 100 },
  ketua: { baseCost: cfg.ketua.cost, baseChance: cfg.ketua.chance / 100 },
  deputy: { baseCost: cfg.deputy.cost, baseChance: cfg.deputy.chance / 100 },
};

export const PROMOTION_EXTRA_STEP = cfg.extraInfluenceStep;
export const PROMOTION_EXTRA_BONUS = cfg.extraInfluenceBonus / 100;
export const PROMOTION_MAX_CHANCE = cfg.maxChance / 100;

// Party Machinery (a Political Asset) adds a flat bonus on top of the
// extra-influence bonus, still capped the same way.
export function calculatePolitikChance(fromRank, extraInfluence, hasPartyMachinery = false) {
  const config = PROMOTION_TABLE[fromRank];
  if (!config) return 0;
  const steps = Math.floor(Math.max(extraInfluence, 0) / PROMOTION_EXTRA_STEP);
  const machineryBonus = hasPartyMachinery ? PARTY_MACHINERY_BONUS : 0;
  return Math.min(config.baseChance + steps * PROMOTION_EXTRA_BONUS + machineryBonus, PROMOTION_MAX_CHANCE);
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
  const chance = calculatePolitikChance(player.rank, extraInfluence, hasAsset(player, 'partyMachinery'));
  player.influence -= cost;

  const success = rng() < chance;
  if (success) {
    player.rank = toRank;
    player.stats.promotionsSucceeded += 1;
    applyScandalDelta(player, -15);
    applyApprovalDelta(player, GAME_BALANCE.approvalRating.politikSuccessGain);
  }

  return { ok: true, success, chance, cost, toRank };
}
