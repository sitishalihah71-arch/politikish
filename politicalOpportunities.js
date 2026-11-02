// Political Assets: permanent, publicly-visible bonuses (the opposite of
// KABEL/Political Network - the whole point is other players can see
// what's worth raiding from you). In a normal match each player is dealt
// one at match start; in Advanced Mode nobody starts with any and they are
// bought from the Black Market instead. Political Raid is the other way
// ownership changes - assets are never destroyed, only reassigned. A
// player never holds two of the same type (Raid and Black Market both
// refuse it).
//
// The spec's `activate()` idea doesn't survive going over the wire (WebRTC
// data channels can't serialize functions), so an asset is plain data
// (id/type/owner) and the actual passive-effect logic lives here in a
// definitions registry, read only host-side - exactly like sabotage.js/
// politics.js's resolve functions already are.

import { GAME_BALANCE } from './balance.js';
import { shuffle, randomChoice } from './utils.js';
import { applyScandalDelta } from './effects.js';

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

// Normal (non-Advanced) match start, host-only: every player gets exactly
// one random asset. Types are dealt from a reshuffled deck, so with up to
// four players nobody shares a type; with more players than types the deck
// simply restarts (different players may then own the same type - the
// no-duplicates rule is per player, not per table).
export function dealStartingAssets(players) {
  let deck = [];
  players.forEach((player) => {
    if (deck.length === 0) deck = shuffle(ASSET_TYPES);
    player.assets = [createAsset(deck.pop(), player.id)];
  });
}

// Advanced Mode match start: the whole table starts empty-handed and the
// Black Market is the only source. Stock is limited to `stockPerPlayer`
// items per player, picked at random, with no single type exceeding the
// player count (more copies than players could never all be bought, since
// nobody may own two of a type).
export function generateMarketStock(playerCount) {
  const total = playerCount * GAME_BALANCE.blackMarket.stockPerPlayer;
  const counts = Object.fromEntries(ASSET_TYPES.map((type) => [type, 0]));
  const stock = [];
  while (stock.length < total) {
    const open = ASSET_TYPES.filter((type) => counts[type] < playerCount);
    if (open.length === 0) break;
    const type = randomChoice(open);
    counts[type] += 1;
    stock.push(type);
  }
  return stock;
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

// reason codes: 'invalid-target' | 'duplicate-asset' | 'insufficient-influence'
export function validateRaid(attacker, target, assetId, extraInfluence) {
  const asset = target?.assets.find((a) => a.id === assetId);
  if (!target || target.id === attacker.id || !asset) {
    return { ok: false, reason: 'invalid-target' };
  }
  if (hasAsset(attacker, asset.type)) return { ok: false, reason: 'duplicate-asset' };
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

// Every distinct type still in stock that the buyer doesn't already own -
// a copy of something they hold is never offered, and the type comes off
// the list once the last copy is bought. Order follows ASSET_TYPES so the
// picker doesn't reshuffle between opens.
export function generateMarketOffers(player, stock) {
  return ASSET_TYPES.filter((type) => stock.includes(type) && !hasAsset(player, type));
}

// reason codes: 'already-owned' | 'out-of-stock' | 'insufficient-money'
export function validateMarketPurchase(player, type, stock) {
  if (!ASSET_TYPES.includes(type) || hasAsset(player, type)) return { ok: false, reason: 'already-owned' };
  if (!stock.includes(type)) return { ok: false, reason: 'out-of-stock' };
  if (player.money < marketCfg.price) return { ok: false, reason: 'insufficient-money' };
  return { ok: true, price: marketCfg.price };
}

// Takes one copy out of `stock` (mutated in place - it's the table-wide
// supply), charges the price, and adds the Scandal hit that makes this the
// dirty route compared to Raid.
export function buyAsset(player, type, stock) {
  const validation = validateMarketPurchase(player, type, stock);
  if (!validation.ok) return validation;

  stock.splice(stock.indexOf(type), 1);
  player.money -= validation.price;
  const scandalGain = applyScandalDelta(player, marketCfg.scandalGain);
  player.assets.push(createAsset(type, player.id));

  return { ok: true, assetType: type, price: validation.price, scandalGain };
}
