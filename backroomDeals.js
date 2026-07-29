// Backroom Deals: bribery negotiation between two players, entirely outside
// the turn system - either player can propose or respond at any time, not
// just on their own turn. Privacy is enforced by NEVER broadcasting a
// pending deal: match.js keeps this module's registry host-side only and
// messages each party directly (see room.getConnectionsByPlayerId), the
// same privacy boundary already proven for KABEL/Political Network.

import { GAME_BALANCE } from './balance.js';

let dealSeq = 0;
const pendingDeals = new Map(); // dealId -> { offererId, targetId, money, influence }

function affordable(player, money, influence) {
  return player.money >= money && player.influence >= influence;
}

// reason codes: 'invalid-target' | 'invalid-amount' | 'insufficient-funds'
export function proposeDeal(offerer, target, money, influence) {
  const m = Math.max(0, Math.floor(money) || 0);
  const inf = Math.max(0, Math.floor(influence) || 0);
  if (!target || target.id === offerer.id) return { ok: false, reason: 'invalid-target' };
  if (m === 0 && inf === 0) return { ok: false, reason: 'invalid-amount' };
  if (!affordable(offerer, m, inf)) return { ok: false, reason: 'insufficient-funds' };

  dealSeq += 1;
  const dealId = `deal-${dealSeq}`;
  pendingDeals.set(dealId, { offererId: offerer.id, targetId: target.id, money: m, influence: inf });
  return { ok: true, dealId, money: m, influence: inf };
}

// Leak chance scales with whichever party is more scandalous - a clean
// politician is a safer bribery partner than a scandalous one.
function getLeakChance(offererScandal, targetScandal) {
  const { leakBaseChance, leakScandalWeightPercent, leakMaxChance } = GAME_BALANCE.backroomDeals;
  const maxScandal = Math.max(offererScandal, targetScandal);
  const chance = leakBaseChance + (maxScandal / 100) * leakScandalWeightPercent;
  return Math.min(chance, leakMaxChance) / 100;
}

// reason codes (ok:false): 'deal-not-found'. On ok:true, `accepted` tells
// the caller whether this was a Reject (no further effects at all - not
// even the other party is told why) or an Accept, which then either
// succeeded quietly (`leaked:false`) or leaked (`leaked:true`, resources
// never move, both parties get benched for their next turn instead).
export function respondToDeal(dealId, accept, players, rng = Math.random) {
  const deal = pendingDeals.get(dealId);
  if (!deal) return { ok: false, reason: 'deal-not-found' };
  const offerer = players.find((p) => p.id === deal.offererId);
  const target = players.find((p) => p.id === deal.targetId);
  pendingDeals.delete(dealId);
  if (!offerer || !target) return { ok: false, reason: 'deal-not-found' };

  if (!accept) {
    return { ok: true, accepted: false, offererId: deal.offererId, targetId: deal.targetId };
  }

  // The offerer's balance may have changed since the offer was sent (spent
  // it on something else in the meantime) - re-check host-authoritatively
  // rather than trusting the snapshot taken when the offer was made.
  if (!affordable(offerer, deal.money, deal.influence)) {
    return { ok: true, accepted: false, fellThrough: true, offererId: deal.offererId, targetId: deal.targetId };
  }

  const leaked = rng() < getLeakChance(offerer.scandal, target.scandal);

  if (leaked) {
    offerer.skipNextTurn = true;
    target.skipNextTurn = true;
    return {
      ok: true, accepted: true, leaked: true,
      offererId: deal.offererId, targetId: deal.targetId,
      money: deal.money, influence: deal.influence,
    };
  }

  offerer.money -= deal.money;
  offerer.influence -= deal.influence;
  target.money += deal.money;
  target.influence += deal.influence;

  return {
    ok: true, accepted: true, leaked: false,
    offererId: deal.offererId, targetId: deal.targetId,
    money: deal.money, influence: deal.influence,
  };
}

export function resetDeals() {
  pendingDeals.clear();
}
