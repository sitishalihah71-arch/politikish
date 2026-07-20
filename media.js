// Kempen Imej cards. Three shapes: a straight cost->effect card ('direct'),
// a card with an internal success/fail roll ('chance'), and a card that also
// affects a chosen target ('target'). Add new cards here to extend the pool.

import { pickRandomUnique } from './utils.js';
import { applyScandalDelta } from './effects.js';

export const MEDIA_CARDS = [
  { id: 'sidang-media', name: 'Sidang Media', kind: 'direct', cost: 15000, scandalDelta: -10, supportTurns: 2 },
  { id: 'alih-perhatian', name: 'Alih Perhatian', kind: 'target', cost: 20000, selfScandalDelta: -10, targetScandalDelta: 10 },
  { id: 'kempen-digital', name: 'Kempen Digital', kind: 'direct', cost: 10000, scandalDelta: -20 },
  { id: 'program-rakyat', name: 'Program Rakyat', kind: 'direct', cost: 20000, scandalDelta: -10, influenceDelta: 100 },
  { id: 'temu-bual', name: 'Temu Bual Eksklusif', kind: 'chance', cost: 30000, chance: 0.5, successScandalDelta: -40, failScandalDelta: 20 },
  { id: 'iklan-tv', name: 'Iklan TV', kind: 'direct', cost: 35000, supportTurns: 3 },
];

export function generateMediaOffers() {
  return pickRandomUnique(MEDIA_CARDS, Math.min(3, MEDIA_CARDS.length));
}

export function getMediaCard(id) {
  return MEDIA_CARDS.find((c) => c.id === id) || null;
}

// reason codes: 'unknown-card' | 'insufficient-money' | 'invalid-target'
export function validateMedia(player, cardId, targetPlayer) {
  const card = getMediaCard(cardId);
  if (!card) return { ok: false, reason: 'unknown-card' };
  if (player.money < card.cost) return { ok: false, reason: 'insufficient-money' };
  if (card.kind === 'target' && (!targetPlayer || targetPlayer.id === player.id)) {
    return { ok: false, reason: 'invalid-target' };
  }
  return { ok: true, card };
}

export function resolveMedia(player, cardId, targetPlayer, rng = Math.random) {
  const validation = validateMedia(player, cardId, targetPlayer);
  if (!validation.ok) return validation;

  const { card } = validation;
  player.money -= card.cost;

  let success = true;
  if (card.kind === 'direct') {
    if (card.scandalDelta) applyScandalDelta(player, card.scandalDelta);
    if (card.influenceDelta) player.influence += card.influenceDelta;
    if (card.supportTurns) player.publicSupportTurns = card.supportTurns;
  } else if (card.kind === 'target') {
    applyScandalDelta(player, card.selfScandalDelta);
    applyScandalDelta(targetPlayer, card.targetScandalDelta);
  } else if (card.kind === 'chance') {
    success = rng() < card.chance;
    applyScandalDelta(player, success ? card.successScandalDelta : card.failScandalDelta);
  }

  return { ok: true, success, card };
}
