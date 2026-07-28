// National Event card pool - fires automatically every N rounds (per
// GAME_BALANCE.nationalEvents.intervalRounds) when the host has the setting
// enabled. Purely data-driven, same shape as projects.js/media.js: add a new
// event by extending this array, no engine changes needed. Effects only
// ever touch existing resources (money, influence, scandal, Public Support)
// equally for every player - never targets an individual.

import { randomChoice } from './utils.js';
import { applyScandalDelta } from './effects.js';

export const NATIONAL_EVENTS = [
  {
    id: 'economic-boom',
    name: 'Economic Boom',
    icon: '📈',
    description: 'The economy is thriving. Everyone gains RM20,000.',
    rarity: 'common',
    effects: { money: 20000 },
  },
  {
    id: 'economic-recession',
    name: 'Economic Recession',
    icon: '📉',
    description: 'A downturn hits the nation. Everyone loses RM15,000.',
    rarity: 'common',
    effects: { money: -15000 },
  },
  {
    id: 'public-holiday',
    name: 'Public Holiday Celebration',
    icon: '❤️',
    description: 'A national holiday lifts spirits. Everyone: Scandal -10%.',
    rarity: 'common',
    effects: { scandalDelta: -10 },
  },
  {
    id: 'anti-corruption',
    name: 'Anti-Corruption Operation',
    icon: '🚨',
    description: 'Investigators are on the move. Everyone: Scandal +15%.',
    rarity: 'common',
    effects: { scandalDelta: 15 },
  },
  {
    id: 'election-campaign',
    name: 'Election Campaign Season',
    icon: '🗳️',
    description: 'Campaign season energizes every camp. Everyone: Influence +150.',
    rarity: 'common',
    effects: { influence: 150 },
  },
  {
    id: 'media-frenzy',
    name: 'Media Frenzy',
    icon: '📺',
    description: 'A wave of favourable coverage. Everyone gains Public Support (1 Turn).',
    rarity: 'common',
    effects: { publicSupportTurns: 1 },
  },
  {
    id: 'government-budget',
    name: 'Government Budget',
    icon: '💸',
    description: 'Budget season pays out. Everyone gains RM10,000 and 100 Influence.',
    rarity: 'common',
    effects: { money: 10000, influence: 100 },
  },
  {
    id: 'parliamentary-crisis',
    name: 'Parliamentary Crisis',
    icon: '⚡',
    description: 'Gridlock grips parliament. Everyone loses 100 Influence.',
    rarity: 'common',
    effects: { influence: -100 },
  },
];

export function pickNationalEvent() {
  return randomChoice(NATIONAL_EVENTS);
}

// Mutates `player` directly, mirroring resolveProjek/resolveMedia. Returns
// the deltas actually applied (money/influence floor at 0, and a positive
// scandalDelta can come back reduced by an active Public Support via
// applyScandalDelta) in case a future UI wants to show a personalized
// summary - the announcement itself just shows the event card.
export function applyNationalEvent(event, player) {
  const { effects } = event;
  const applied = {};

  if (effects.money) {
    const before = player.money;
    player.money = Math.max(0, player.money + effects.money);
    applied.money = player.money - before;
  }
  if (effects.influence) {
    const before = player.influence;
    player.influence = Math.max(0, player.influence + effects.influence);
    applied.influence = player.influence - before;
  }
  if (effects.scandalDelta) {
    applied.scandal = applyScandalDelta(player, effects.scandalDelta);
  }
  if (effects.publicSupportTurns) {
    player.publicSupportTurns += effects.publicSupportTurns;
    applied.publicSupportTurns = effects.publicSupportTurns;
  }

  return applied;
}
