// Projek cards. Purely additive (money/influence/scandal) - projects always
// succeed, no separate success roll. Add new tiers here to extend the pool.

import { pickRandomUnique } from './utils.js';
import { applyScandalDelta } from './effects.js';

export const PROJECT_CARDS = [
  { id: 'small', name: 'Projek Kecil', money: 10000, influence: 50, scandal: 5 },
  { id: 'medium', name: 'Projek Sederhana', money: 35000, influence: 180, scandal: 15 },
  { id: 'mega', name: 'Projek Mega', money: 70000, influence: 400, scandal: 30 },
];

export function generateProjectOffers() {
  return pickRandomUnique(PROJECT_CARDS, Math.min(3, PROJECT_CARDS.length));
}

export function getProjectCard(id) {
  return PROJECT_CARDS.find((c) => c.id === id) || null;
}

// Mutates `player` directly. Returns the applied card for the caller to
// surface as feedback.
export function resolveProjek(player, cardId) {
  const card = getProjectCard(cardId);
  if (!card) return null;

  player.money += card.money;
  player.influence += card.influence;
  applyScandalDelta(player, card.scandal);
  return card;
}
