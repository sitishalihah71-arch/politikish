// Political Assets: permanent, publicly-visible bonuses (the opposite of
// KABEL/Political Network - the whole point is other players can see
// what's worth raiding from you). Each player is dealt at most one at match
// start; Political Raid is the only way ownership changes afterward -
// assets are never destroyed, only reassigned.
//
// The spec's `activate()` idea doesn't survive going over the wire (WebRTC
// data channels can't serialize functions), so an asset is plain data
// (id/type/owner) and the actual passive-effect logic lives here in a
// definitions registry, read only host-side - exactly like sabotage.js/
// politics.js's resolve functions already are.

import { GAME_BALANCE } from './balance.js';
import { shuffle, pickRandomUnique } from './utils.js';

export const ASSET_TYPES = ['mediaEmpire', 'corporateSponsor', 'partyMachinery', 'royalConnection'];

export const OPPORTUNITY_DEFINITIONS = {
  mediaEmpire: {
    name: 'Media Empire',
    icon: '📺',
    description: () => `+${GAME_BALANCE.politicalOpportunity.assets.mediaEmpire.influencePerRound} Influence every round.`,
  },
  corporateSponsor: {
    name: 'Corporate Sponsor',
    icon: '🏦',
    description: () => `Projects generate +${GAME_BALANCE.politicalOpportunity.assets.corporateSponsor.projekMoneyBonusPercent}% Money.`,
  },
  partyMachinery: {
    name: 'Party Machinery',
    icon: '⚙️',
    description: () => `+${GAME_BALANCE.politicalOpportunity.assets.partyMachinery.promotionChanceBonusPercent}% Politik success chance.`,
  },
  royalConnection: {
    name: 'Royal Connection',
    icon: '👑',
    description: () => `-${GAME_BALANCE.politicalOpportunity.assets.royalConnection.sabotageDefensePercent}% chance of being Sabotaj'd or Kabel'd.`,
  },
};

export function createAsset(type, ownerId) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    owner: ownerId,
  };
}

// One random distinct asset per player at match start (host-only). With
// more players than asset types, the extras simply start with none - an
// intentional reason to Raid early rather than a bug.
export function dealStartingAssets(players) {
  const shuffledTypes = shuffle(ASSET_TYPES);
  players.forEach((player, i) => {
    const type = shuffledTypes[i];
    player.assets = type ? [createAsset(type, player.id)] : [];
  });
}

export function hasAsset(player, type) {
  return player.assets.some((a) => a.type === type);
}

// --- Political Raid: same base -> extra -> cap -> floor shape already
// established by Sabotaj/Kabel, but with its own tunables (stealing an
// asset is a different risk/reward than stealing a seat) - not literally
// sharing sabotage.js's helper since the underlying constants differ.
const { raid: raidCfg } = GAME_BALANCE.politicalOpportunity;

export function describeRaidChance(extraInfluence) {
  const steps = Math.floor(Math.max(extraInfluence, 0) / raidCfg.extraInfluenceStep);
  const preCap = raidCfg.baseChance + steps * raidCfg.extraInfluenceBonus;
  const capped = Math.min(preCap, raidCfg.maxChance);
  const final = Math.max(capped, raidCfg.minimumChance) / 100;
  return { base: raidCfg.baseChance / 100, extraBonus: (capped - raidCfg.baseChance) / 100, final };
}

export function calculateRaidChance(extraInfluence) {
  return describeRaidChance(extraInfluence).final;
}

export function getRaidCost(extraInfluence) {
  const steps = Math.floor(Math.max(extraInfluence, 0) / raidCfg.extraInfluenceStep);
  return raidCfg.cost + steps * raidCfg.extraInfluenceStep;
}

// reason codes: 'invalid-target' | 'insufficient-influence'
export function validateRaid(attacker, target, assetId, extraInfluence) {
  const asset = target?.assets.find((a) => a.id === assetId);
  if (!target || target.id === attacker.id || !asset) {
    return { ok: false, reason: 'invalid-target' };
  }
  const cost = getRaidCost(extraInfluence);
  if (attacker.influence < cost) return { ok: false, reason: 'insufficient-influence' };
  return { ok: true, cost, asset };
}

// Steals = reassigns ownership, never destroys - the asset object itself is
// moved from target.assets to attacker.assets with a new `.owner`.
export function resolveRaid(attacker, target, assetId, extraInfluence, rng = Math.random) {
  const validation = validateRaid(attacker, target, assetId, extraInfluence);
  if (!validation.ok) return validation;

  const { cost, asset } = validation;
  const chance = calculateRaidChance(extraInfluence);
  attacker.influence -= cost;

  const success = rng() < chance;
  if (success) {
    target.assets = target.assets.filter((a) => a.id !== asset.id);
    asset.owner = attacker.id;
    attacker.assets.push(asset);
  }

  return { ok: true, success, chance, cost, assetType: asset.type, targetId: target.id };
}

// --- Black Market: the guaranteed, Money-priced counterpart to Raid's
// risky, Influence-priced theft - same asset pool, reused createAsset,
// just a different acquisition path with no chance roll involved.
const { blackMarket: marketCfg } = GAME_BALANCE;

export function getMarketPrice() {
  return marketCfg.price;
}

// Only offers types the buyer doesn't already own - a duplicate of
// something Raid could otherwise steal isn't an interesting purchase.
// Returns fewer than `offerCount` once fewer types remain, and an empty
// array once the buyer already owns all of them.
export function generateMarketOffers(player) {
  const available = ASSET_TYPES.filter((type) => !hasAsset(player, type));
  return pickRandomUnique(available, Math.min(marketCfg.offerCount, available.length));
}

// reason codes: 'already-owned' | 'insufficient-money'
export function validateMarketPurchase(player, type) {
  if (!ASSET_TYPES.includes(type) || hasAsset(player, type)) return { ok: false, reason: 'already-owned' };
  if (player.money < marketCfg.price) return { ok: false, reason: 'insufficient-money' };
  return { ok: true, price: marketCfg.price };
}

export function buyAsset(player, type) {
  const validation = validateMarketPurchase(player, type);
  if (!validation.ok) return validation;

  player.money -= validation.price;
  const asset = createAsset(type, player.id);
  player.assets.push(asset);

  return { ok: true, assetType: type, price: validation.price };
}
