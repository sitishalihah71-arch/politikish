// Projek cards. Purely additive (money/influence/scandal) - projects always
// succeed, no separate success roll. Each card belongs to one of three
// categories (Infrastructure, Public Services, Administration); completing
// one feeds that category's Political Network progress (see
// player.politicalNetwork and match.js's maybeRollKabelUnlock). Add new
// tiers by extending GAME_BALANCE.projects.cards, not this file.

import { pickRandomUnique } from './utils.js';
import { applyScandalDelta, applyApprovalDelta } from './effects.js';
import { getEconomyScale } from './player.js';
import { hasAsset } from './politicalOpportunities.js';
import { GAME_BALANCE } from './balance.js';

export const PROJECT_CARDS = Object.entries(GAME_BALANCE.projects.cards).flatMap(([category, cards]) =>
  cards.map((card) => ({ ...card, category })),
);

export function generateProjectOffers() {
  return pickRandomUnique(PROJECT_CARDS, Math.min(3, PROJECT_CARDS.length));
}

export function getProjectCard(id) {
  return PROJECT_CARDS.find((c) => c.id === id) || null;
}

// Mutates `player` directly. Returns the applied card for the caller to
// surface as feedback. Money/influence rewards scale down slightly as the
// table grows (see getEconomyScale) so a full room doesn't flood the
// economy compared to a small one - scandal cost is untouched. Corporate
// Sponsor (a Political Asset) stacks on top of that scaling as a further
// money multiplier for its owner.
export function resolveProjek(player, cardId, playerCount) {
  const card = getProjectCard(cardId);
  if (!card) return null;

  const scale = getEconomyScale(playerCount);
  const sponsorBonus = hasAsset(player, 'corporateSponsor')
    ? 1 + GAME_BALANCE.politicalOpportunity.assets.corporateSponsor.projekMoneyBonusPercent / 100
    : 1;
  player.money += Math.round(card.money * scale * sponsorBonus);
  player.influence += Math.round(card.influence * scale);
  applyScandalDelta(player, card.scandal);
  applyApprovalDelta(player, GAME_BALANCE.approvalRating.projekGain);
  player.stats.projectsCompleted += 1;
  player.politicalNetwork[card.category] += 1;
  return card;
}
