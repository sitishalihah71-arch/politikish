// Single source of truth for gameplay balance numbers. Politics, sabotage,
// scandal, and Public Support logic all read from this object instead of
// hardcoding values, so rebalancing never requires touching gameplay code.
// Chances are stored as 0-100 (percent) and converted where each module
// needs a 0-1 fraction.

export const GAME_BALANCE = {
  politics: {
    ahli: { cost: 100, chance: 80 },
    ketua: { cost: 200, chance: 65 },
    deputy: { cost: 350, chance: 50 },
    extraInfluenceBonus: 10,
    extraInfluenceStep: 50,
    maxChance: 95,
  },

  sabotage: {
    ahli: { cost: 150, chance: 60 },
    ketua: { cost: 250, chance: 45 },
    deputy: { cost: 400, chance: 30 },
    extraInfluenceBonus: 10,
    extraInfluenceStep: 50,
    maxChance: 90,
    publicSupportPenalty: 30,
    minimumChance: 5,
  },

  scandal: {
    penaltyThreshold: 100,
    resetTo: 30,
    moneyLossPercent: 50,
  },

  publicSupport: {
    scandalReduction: 50,
  },

  room: {
    playerOptions: [2, 3, 4, 5, 6],
    defaultPlayers: 4,
    roundOptions: [10, 20, 30, 40, 50],
    defaultRounds: 10,
    defaultNationalEvents: true,
  },

  // Seat capacity per rank is derived from the live player count (N) as
  // N minus these offsets, floored at 1 - president is always exactly 1
  // seat regardless of player count (there's only ever one winner). With
  // the default offsets this reproduces the original fixed 4-player
  // layout exactly (4/3/2/1) and generalizes to any player count without
  // further changes.
  hierarchy: {
    seatOffsets: { ahli: 0, ketua: 1, deputy: 2 },
  },

  // Projek rewards shrink slightly as the table gets bigger, so a 6-player
  // match doesn't flood the economy compared to a 2-player one.
  economy: {
    baselinePlayers: 2,
    projekRewardReductionPerExtraPlayerPercent: 5,
  },

  nationalEvents: {
    intervalRounds: 10,
  },

  kabel: {
    cost: 500,
    spawnChancePercent: 4,
    targetChances: { ketua: 50, deputy: 30, president: 15 },
  },
};
