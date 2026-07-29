// Parliament Voting motion pool - fires on its own periodic checkpoint (see
// GAME_BALANCE.parliament.intervalRounds), same data-driven shape as
// events.js's NATIONAL_EVENTS: add a new policy motion by extending this
// array, no engine changes needed. `no-confidence` is the one exception -
// instead of a plain effects object it demotes a single targeted player
// back to the bottom rank, so it's resolved by applyMotion below rather
// than the generic per-player effect loop.

import { randomChoice } from './utils.js';
import { applyScandalDelta } from './effects.js';

export const PARLIAMENT_MOTIONS = [
  {
    id: 'infrastructure-bill',
    name: 'Infrastructure Spending Bill',
    description: 'Fund new public works nationwide. If passed: everyone gains RM15,000.',
    effects: { money: 15000 },
  },
  {
    id: 'austerity-measures',
    name: 'Austerity Measures',
    description: 'Tighten government belts. If passed: everyone loses RM10,000, Scandal -10%.',
    effects: { money: -10000, scandalDelta: -10 },
  },
  {
    id: 'transparency-act',
    name: 'Transparency Act',
    description: 'Stronger disclosure rules for public officials. If passed: everyone gains Scandal +12%.',
    effects: { scandalDelta: 12 },
  },
  {
    id: 'civic-engagement',
    name: 'Civic Engagement Programme',
    description: 'Invest in public outreach. If passed: everyone gains 120 Influence.',
    effects: { influence: 120 },
  },
  {
    id: 'no-confidence',
    name: 'Vote of No Confidence',
    description: 'A motion to remove {target} from their current rank.',
    type: 'no-confidence',
  },
];

// The `no-confidence` motion only makes sense against a player who currently
// holds a rank above the bottom one - demoting someone already at Ahli Biasa
// does nothing. Ties broken by slot, matching the tiebreak convention used
// everywhere else in this app (see match.js's determineWinner).
function pickNoConfidenceTarget(players) {
  const eligible = players
    .filter((p) => p.rank !== 'ahli')
    .sort((a, b) => a.approval - b.approval || a.slot - b.slot);
  return eligible[0] || null;
}

// Draws one motion at random. Excludes `no-confidence` from the pool
// entirely when no player qualifies as a target (e.g. everyone is still
// Ahli Biasa early in the match), rather than drawing it with no target.
// Returns `{ motion, target }` - target is always null for a policy motion.
export function pickMotion(players) {
  const target = pickNoConfidenceTarget(players);
  const pool = target ? PARLIAMENT_MOTIONS : PARLIAMENT_MOTIONS.filter((m) => m.type !== 'no-confidence');
  const motion = randomChoice(pool);
  return { motion, target: motion.type === 'no-confidence' ? target : null };
}

// Applies a *passed* motion. For `no-confidence`, demotes just the target
// back to Ahli Biasa - no seat-capacity check is needed the way the
// existing scandal-penalty demotion has one, since Ahli Biasa's capacity is
// always >= the player count (see effects.js's getSeatCapacity). For a
// policy motion, mutates every player the same way events.js's
// applyNationalEvent does for a single player, just looped across the
// whole table here since a passed motion always affects everyone.
export function applyMotion(motion, target, players) {
  if (motion.type === 'no-confidence') {
    if (!target) return null;
    target.rank = 'ahli';
    return { type: 'no-confidence', targetId: target.id };
  }

  const { effects } = motion;
  players.forEach((player) => {
    if (effects.money) player.money = Math.max(0, player.money + effects.money);
    if (effects.influence) player.influence = Math.max(0, player.influence + effects.influence);
    if (effects.scandalDelta) applyScandalDelta(player, effects.scandalDelta);
    if (effects.publicSupportTurns) player.publicSupportTurns += effects.publicSupportTurns;
  });
  return { type: 'policy', motionId: motion.id };
}
