// Secret Objectives: one private goal per player, assigned at match start
// and checked continuously as they play (see match.js's checkSecretObjective
// call sites). Unlike Approval Rating, completing one pays a real Money/
// Influence bonus the instant it's met - but the objective itself, and
// whether it's been completed, stays masked from every other player
// forever (see match.js's maskPlayersFor), the same rule already applied
// to Political Network/KABEL.

import { randomChoice } from './utils.js';
import { RANKS } from './player.js';

export const SECRET_OBJECTIVES = [
  {
    id: 'money-baron',
    name: 'Money Baron',
    description: 'Accumulate RM100,000 in Money.',
    check: (p) => p.money >= 100000,
    reward: { money: 20000 },
  },
  {
    id: 'influence-peddler',
    name: 'Influence Peddler',
    description: 'Accumulate 1,000 Influence.',
    check: (p) => p.influence >= 1000,
    reward: { influence: 150 },
  },
  {
    id: 'clean-hands',
    name: 'Clean Hands',
    description: 'Reach Ketua ADUN or higher while keeping Scandal under 20%.',
    check: (p) => RANKS.indexOf(p.rank) >= RANKS.indexOf('ketua') && p.scandal < 20,
    reward: { money: 15000 },
  },
  {
    id: 'asset-collector',
    name: 'Asset Collector',
    description: 'Own 2 Political Assets at the same time.',
    check: (p) => p.assets.length >= 2,
    reward: { influence: 200 },
  },
  {
    id: 'political-veteran',
    name: 'Political Veteran',
    description: 'Successfully use Sabotaj or KABEL twice.',
    check: (p) => p.stats.sabotagesSucceeded >= 2,
    reward: { money: 15000 },
  },
];

// One random objective per player, tracked as a small `{ id, completed }`
// pair on the player object itself - the definition (description/check/
// reward) is looked back up by id when needed, never duplicated onto the
// player, mirroring how backroomDeals.js keeps only an id on the wire.
export function assignSecretObjective(player) {
  const objective = randomChoice(SECRET_OBJECTIVES);
  player.secretObjective = { id: objective.id, completed: false };
}

// No-ops if there's no objective, it's already completed, or the condition
// isn't met yet - so callers can call this freely after any action without
// worrying about double-firing. Returns the definition (for the caller to
// announce) only the moment it's newly completed, otherwise null.
export function checkSecretObjective(player) {
  if (!player.secretObjective || player.secretObjective.completed) return null;
  const definition = SECRET_OBJECTIVES.find((o) => o.id === player.secretObjective.id);
  if (!definition || !definition.check(player)) return null;

  player.secretObjective.completed = true;
  if (definition.reward.money) player.money += definition.reward.money;
  if (definition.reward.influence) player.influence += definition.reward.influence;
  return definition;
}
