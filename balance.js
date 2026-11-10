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
    defaultParliamentVoting: true,
    defaultAdvancedMode: false,
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

  // Backroom Deals never appear in any broadcast the other players can see.
  // The only way one becomes public is the offerer choosing to Dedahkan a
  // breached contract. The old random "leak" roll (checked when the target
  // accepts; chance scaled with whichever party was more scandalous) is kept
  // but switched off: set leakEnabled to true to bring it back (the How to
  // Play text no longer mentions it).
  backroomDeals: {
    leakEnabled: false,
    leakBaseChance: 10,
    leakScandalWeightPercent: 60,
    leakMaxChance: 90,
    skipTurnsOnLeak: 1,
    skipNoticeMs: 2500, // how long the "turn skipped" notice stays up before play moves on

    // Conditional deals ("kontrak"): the payment is split. `heldPercent` of it
    // stays in escrow until the condition is met - released to the target when
    // it is, handed back to the offerer when it isn't. A target who breaks
    // the terms can then be exposed ("Dedahkan", free): refund of what they
    // already received, a public Scandal hit, and a Pecah Amanah mark.
    heldPercent: 50,
    contractRounds: 2, // window for "don't harm me" / "don't Politik" / "Sabotaj X"
    // Penalties when a breached contract is exposed. The target also hands
    // back the up-front payment (see exposeContract); every figure below is
    // on top of that. Fines are burned (paid to nobody). The target's
    // penalties always apply in full - a shortfall becomes debt.
    // Dedahkan has its own penalties, so the Scandal it adds is capped just
    // below the 100% threshold: it can never on its own also trigger the
    // 100% Scandal penalty (-50% Money, lose a seat) on top of them.
    exposeScandalCappedBelowPenalty: true,
    exposeTargetScandal: 30,
    exposeTargetFineMoney: 5000,
    exposeTargetFineInfluence: 100,
    exposeTargetRanksLost: 1, // seats dropped (skipped if there is no free seat below)
    exposeOffererScandal: 10,
    exposeOffererFineMoney: 5000, // paid from what they have; never pushes them into debt
    botBreakChance: 25, // chance a bot that accepts a contract means to betray it

    // "Jaminan" (guarantee): Dedahkan always succeeds. The refund is the whole
    // up-front payment; whatever the target can no longer cover is taken as a
    // negative balance (debt, "hutang") that later income pays off first. No
    // number here on purpose - the guarantee has no cap.

    // Private chat between the two parties of a pending deal / contract. Lives
    // host-side only; every figure below is enforced by the host.
    chat: {
      maxLength: 200, // characters per message
      minIntervalMs: 800, // gap between two messages from the same sender
      burstWindowMs: 10000,
      burstMax: 6, // at most this many messages per sender per window
      maxMessages: 150, // per conversation (both directions together)
      botReplyDelayMs: 1400,
    },
  },

  // Approval Rating is a second public-standing meter alongside Scandal
  // (0-100, starts neutral at 50). It has no mechanical effect of its own
  // this phase beyond tracking who's popular - its one job is deciding who
  // is eligible to be targeted by a Vote of No Confidence motion (see
  // `parliament`). Deltas are applied inline by the same resolve functions
  // that already produce these outcomes (resolveProjek/resolvePolitik/
  // resolveMedia/resolveSabotaj/applyScandalPenalty).
  approvalRating: {
    projekGain: 3,
    politikSuccessGain: 8,
    kempenImejGain: 5,
    seatLostPenalty: 10,
    scandalPenaltyPenalty: 15,
  },

  // Parliament Voting: a full-table pause every `intervalRounds` (checked
  // at the same round-boundary checkpoint as National Events, on its own
  // independent cadence). The motion pool itself lives in parliament.js
  // (same split as National Events: cadence here, content there).
  parliament: {
    intervalRounds: 7,
    voteDurationMs: 90000,
  },

  // Black Market (Advanced Mode only): the guaranteed, Money-priced
  // counterpart to Political Raid's risky, Influence-priced theft. In
  // Advanced Mode nobody starts with a Political Asset - they have to be
  // bought here, from a stock shared by the whole table and capped at
  // `stockPerPlayer` items per player in the room. Buying is expensive and
  // dirty: flat price, plus a Scandal hit.
  blackMarket: {
    price: 60000,
    scandalGain: 50,
    stockPerPlayer: 2,
  },

  // Bot players: AI-controlled seats so a single human can fill a match.
  // Every bot turn is resolved host-side through the exact same resolvers
  // real actions use - this section only tunes pacing and the weighted
  // random-but-valid decision policy (see bots.js).
  bots: {
    namePool: [
      'Ahmad', 'Ramli', 'Zarina', 'Farid', 'Halim', 'Ita',
      'Rosnah', 'Zulkifli', 'Salmah', 'Hafiz', 'Mazlan', 'Aina',
    ],
    turnDelayMs: 3000, // long enough for the action story pop-up to be read
    actionWeights: {
      projek: 30,
      politik: 20,
      sabotaj: 15,
      media: 15,
      raid: 10,
      market: 10,
      dealPropose: 8,
    },
    dealOfferPercent: 20,
    dealAcceptMinValue: 300,
  },
};
