// Shared player data model and rank/hierarchy config.

export const MAX_PLAYERS = 4;

export function createPlayer({ id, slot, name, isHost }) {
  return {
    id,
    slot,
    name,
    isHost,
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

export const SEAT_CAPACITY = {
  ahli: 4,
  ketua: 3,
  deputy: 2,
  president: 1,
};

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
  player.mediaShieldTurns = 0;
}

export function getNextRank(rank) {
  const index = RANKS.indexOf(rank);
  if (index === -1 || index === RANKS.length - 1) return null;
  return RANKS[index + 1];
}
