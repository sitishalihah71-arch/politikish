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

  // Three categories x three tiers, each rewarding a different playstyle
  // instead of one flat difficulty ladder. Money is deliberately modest
  // here - Influence stays the primary progression resource, and Money's
  // main job is funding Kempen Imej (Public Support) and Sabotaj/Politik
  // extra-influence bids.
  projects: {
    cards: {
      infrastructure: [
        { id: 'repair-roads', name: 'Repair Local Roads', money: 8000, influence: 120, scandal: 5 },
        { id: 'new-bridge', name: 'New Bridge', money: 12000, influence: 180, scandal: 10 },
        { id: 'expressway', name: 'Expressway', money: 18000, influence: 250, scandal: 20 },
      ],
      publicServices: [
        { id: 'rural-clinic', name: 'Rural Clinic', money: 7000, influence: 150, scandal: 5 },
        { id: 'school-upgrade', name: 'School Upgrade', money: 10000, influence: 180, scandal: 8 },
        { id: 'new-hospital', name: 'New Hospital', money: 15000, influence: 220, scandal: 15 },
      ],
      administration: [
        { id: 'digital-portal', name: 'Digital Portal', money: 9000, influence: 130, scandal: 5 },
        { id: 'smart-city', name: 'Smart City System', money: 14000, influence: 200, scandal: 12 },
        { id: 'gov-complex', name: 'Government Complex', money: 20000, influence: 260, scandal: 20 },
      ],
    },
  },

  // The Political Network: completing `threshold` Projects in the same
  // category opens a chance to unlock KABEL, re-rolled on every further
  // successful Project in that category until either this player wins it
  // or someone else already has (see match.js's maybeRollKabelUnlock).
  politicalNetwork: {
    threshold: 3,
    unlockChancePercent: 30,
  },

  nationalEvents: {
    intervalRounds: 10,
  },

  kabel: {
    cost: 500,
    targetChances: { ketua: 50, deputy: 30, president: 15 },
  },

  // Political Assets are permanent, publicly-visible bonuses (unlike KABEL/
  // Political Network, there's nothing secret about who owns one - the
  // whole point is that they're worth raiding). Each player is dealt one
  // at match start; Political Raid is the only way to take one afterward.
  politicalOpportunity: {
    assets: {
      mediaEmpire: { influencePerRound: 40 },
      corporateSponsor: { projekMoneyBonusPercent: 20 },
      partyMachinery: { promotionChanceBonusPercent: 10 },
      royalConnection: { sabotageDefensePercent: 15 },
    },
    raid: {
      cost: 300,
      baseChance: 40,
      extraInfluenceBonus: 10,
      extraInfluenceStep: 50,
      maxChance: 80,
      minimumChance: 10,
    },
  },

  // Backroom Deals never appear in any broadcast the other players can see
  // - only the leak roll (checked when the target accepts) has a visible
  // consequence. Leak chance scales with whichever party is more scandalous,
  // so a "clean" politician is a safer bribery partner than a scandalous one.
  backroomDeals: {
    leakBaseChance: 10,
    leakScandalWeightPercent: 60,
    leakMaxChance: 90,
    skipTurnsOnLeak: 1,
  },
};
