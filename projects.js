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

// The Money/Influence a player would actually receive from `card` right now:
// the card's face values scaled by table size, with Corporate Sponsor
// stacked on the Money side for its owner. Single source for both the
// payout itself and every place the UI previews or reports it, so what is
// shown always matches what is paid.
export function getProjekReward(player, card, playerCount) {
  const scale = getEconomyScale(playerCount);
  const sponsorBonus = hasAsset(player, 'corporateSponsor')
    ? 1 + GAME_BALANCE.politicalOpportunity.assets.corporateSponsor.projekMoneyBonusPercent / 100
    : 1;
  return {
    money: Math.round(card.money * scale * sponsorBonus),
    influence: Math.round(card.influence * scale),
    sponsorBoosted: sponsorBonus > 1,
  };
}

// Mutates `player` directly. Returns the applied card plus the rewards
// actually paid for the caller to surface as feedback. Money/influence
// rewards scale down slightly as the table grows (see getEconomyScale) so a
// full room doesn't flood the economy compared to a small one - scandal
// cost is untouched.
export function resolveProjek(player, cardId, playerCount) {
  const card = getProjectCard(cardId);
  if (!card) return null;

  const reward = getProjekReward(player, card, playerCount);
  player.money += reward.money;
  player.influence += reward.influence;
  applyScandalDelta(player, card.scandal);
  applyApprovalDelta(player, GAME_BALANCE.approvalRating.projekGain);
  player.stats.projectsCompleted += 1;
  player.politicalNetwork[card.category] += 1;
  return { ...card, reward };
}
