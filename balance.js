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
};
