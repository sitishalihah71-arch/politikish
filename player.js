// Shared player data model and rank/hierarchy config.

import { GAME_BALANCE } from './balance.js';

export function createPlayer({ id, slot, name, isHost, isBot = false }) {
  return {
    id,
    slot,
    name,
    isHost,
    isBot,
    connected: true,
    avatar: { hair: 0, face: 0 },
    ready: false,
  };
}

// Lowest to highest. Order matters - callers walk this array to find the
// "next rank up" from a given rank.
export const RANKS = ['ahli', 'ketua', 'deputy', 'president'];

export const RANK_LABELS = {
  ahli: 'Ahli Biasa',
  ketua: 'Ketua ADUN',
  deputy: 'Timbalan Presiden',
  president: 'Presiden',
};

// Seat capacity scales with however many players are actually in the
// match instead of a fixed table, so the hierarchy works the same way for
// 2 players as it does for 6 (or beyond) with no further changes. President
// always stays a single seat - there's only ever one winner. The offsets
// live in GAME_BALANCE so rebalancing never touches this formula; with the
// default offsets this reproduces the original fixed 4-player layout
// exactly (4/3/2/1).
export function getSeatCapacity(playerCount) {
  const { seatOffsets } = GAME_BALANCE.hierarchy;
  return {
    ahli: Math.max(1, playerCount - seatOffsets.ahli),
    ketua: Math.max(1, playerCount - seatOffsets.ketua),
    deputy: Math.max(1, playerCount - seatOffsets.deputy),
    president: 1,
  };
}

// No stated starting resources in the spec - money gives everyone enough to
// take one Kempen Imej card, but nobody can afford Politik (100+ Influence)
// until they run a Projek first, which paces the opening of the match.
const STARTING_MONEY = 10000;
const STARTING_INFLUENCE = 0;
const STARTING_SCANDAL = 0;

export function initMatchState(player) {
  player.money = STARTING_MONEY;
  player.influence = STARTING_INFLUENCE;
  player.scandal = STARTING_SCANDAL;
  player.rank = 'ahli';
  player.publicSupportTurns = 0;
  // Approval Rating: a second, purely-informational public-standing meter
  // (see balance.js's `approvalRating` comment for its one actual job).
  player.approval = 50;
  player.stats = {
    projectsCompleted: 0,
    promotionsSucceeded: 0,
    sabotagesSucceeded: 0,
    mediaCardsUsed: 0,
    turnsPlayed: 0,
  };
  // Political Network progress and KABEL ownership are completely private -
  // match.js masks both out of every other player's view of this object
  // before it ever reaches the network (see maskPlayersFor in match.js).
  player.politicalNetwork = { infrastructure: 0, publicServices: 0, administration: 0 };
  player.hasKabel = false;
  // Political Assets are the opposite of Kabel/Political Network - public
  // and openly visible, since the whole point is other players can see
  // what's worth raiding from you.
  player.assets = [];
  // Set by backroomDeals.js when a bribe leaks; consumed automatically the
  // next time this player's turn comes up (see match.js's advanceTurn).
  player.skipNextTurn = false;
  // Assigned properly by objectives.js's assignSecretObjective right after
  // this runs - completely private, masked out of every other player's
  // view exactly like politicalNetwork/hasKabel above (see match.js's
  // maskPlayersFor), and never relaxed even at match end.
  player.secretObjective = null;
}

export function getNextRank(rank) {
  const index = RANKS.indexOf(rank);
  if (index === -1 || index === RANKS.length - 1) return null;
  return RANKS[index + 1];
}

// Projek rewards shrink slightly per extra player above the baseline, so a
// full table doesn't flood the economy compared to a small one. Returns a
// 0-1 multiplier, e.g. baselinePlayers:2 + 5%/extra gives 2p:1.00, 4p:0.90,
// 6p:0.80.
export function getEconomyScale(playerCount) {
  const { baselinePlayers, projekRewardReductionPerExtraPlayerPercent } = GAME_BALANCE.economy;
  const extraPlayers = Math.max(0, playerCount - baselinePlayers);
  const reduction = extraPlayers * projekRewardReductionPerExtraPlayerPercent;
  return Math.max(0, 100 - reduction) / 100;
}
