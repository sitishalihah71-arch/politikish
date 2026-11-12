// Character Expansion, Phase 3c: the Kingmaker's Political Maneuvers, the
// Populist's Public Campaign, and what a confirmed exposure does to the two
// characters whose weakness is a scandal (Kingmaker: Political Liability,
// Populist: Scandal Damage). Host side only; pure state, no networking.
//
// The endorsement is the one thing here that is public (it is announced), so
// maneuvers.js hands match.js a small public view of it. Everything else
// (who armed a bonus vote, who was exposed) stays on the host.
//
// All figures live in GAME_BALANCE.characters.kingmaker / .populist.

import { GAME_BALANCE } from './balance.js';
import { adjustBalance, applyApprovalDelta } from './effects.js';
import { characterIdOf } from './abilities.js';

const kcfg = GAME_BALANCE.characters.kingmaker;
const pcfg = GAME_BALANCE.characters.populist;

// Each Kingmaker has at most one endorsement at a time. Normally there is one
// Kingmaker, but an Opportunist can copy the card, so this is keyed by slot.
let endorsements = new Map(); // kingmakerSlot -> { kingmakerSlot, targetSlot, expiresRound, renewed, liabilityDone }
let exposedSlots = new Set(); // everyone who has been confirmed exposed this match

export function resetManeuvers() {
  endorsements = new Map();
  exposedSlots = new Set();
}

// ---------- Kingmaker: Power Broker ----------

// reason codes: 'invalid-amount' | 'insufficient-influence'. The +200 Political
// Network bonus is paid here, once, and only after the transfer went through.
export function powerBroker(kingmaker, target, amount) {
  if (!Number.isInteger(amount) || amount < kcfg.powerBrokerMin || amount > kcfg.powerBrokerMax) return { ok: false, reason: 'invalid-amount' };
  if (!(kingmaker.influence >= amount)) return { ok: false, reason: 'insufficient-influence' };
  adjustBalance(kingmaker, 'influence', -amount);
  adjustBalance(target, 'influence', amount);
  const bonus = adjustBalance(kingmaker, 'influence', kcfg.powerBrokerBonus);
  return { ok: true, amount, bonus };
}

// ---------- Kingmaker: endorsements ----------

export const hasActiveEndorsement = () => endorsements.size > 0;

// The endorsement is active from the moment it is made until it expires or is
// withdrawn (then there is none). `round` is the round it is made in: it pays
// at the start of each of the next `endorsementRounds` rounds.
// reason codes: 'endorsement-active' | 'insufficient-influence'
export function startEndorsement(kingmaker, target, round) {
  if (endorsements.has(kingmaker.slot)) return { ok: false, reason: 'endorsement-active' };
  if (!(kingmaker.influence >= kcfg.endorsementCost)) return { ok: false, reason: 'insufficient-influence' };
  adjustBalance(kingmaker, 'influence', -kcfg.endorsementCost);
  adjustBalance(target, 'influence', kcfg.endorsementCost);
  const before = target.approval;
  applyApprovalDelta(target, kcfg.endorsementTrust);
  const made = {
    kingmakerSlot: kingmaker.slot,
    targetSlot: target.slot,
    expiresRound: round + kcfg.endorsementRounds,
    renewed: false,
    liabilityDone: false,
  };
  endorsements.set(kingmaker.slot, made);
  return { ok: true, trust: target.approval - before, expiresRound: made.expiresRound };
}

// reason codes: 'no-endorsement'
export function withdrawEndorsement(kingmaker, players) {
  const endorsement = endorsements.get(kingmaker.slot);
  if (!endorsement) return { ok: false, reason: 'no-endorsement' };
  const target = players.find((p) => p.slot === endorsement.targetSlot);
  const before = target ? target.approval : 0;
  if (target) applyApprovalDelta(target, -kcfg.withdrawTrust);
  endorsements.delete(kingmaker.slot); // withdrawn: gone for good, no refund, cannot be renewed
  return { ok: true, target, trust: target ? before - target.approval : 0 };
}

// One renewal per endorsement, only while it is active.
// reason codes: 'no-endorsement' | 'already-renewed'
export function renewEndorsement(kingmaker) {
  const endorsement = endorsements.get(kingmaker.slot);
  if (!endorsement) return { ok: false, reason: 'no-endorsement' };
  if (endorsement.renewed) return { ok: false, reason: 'already-renewed' };
  endorsement.renewed = true;
  endorsement.expiresRound += kcfg.endorsementRounds;
  return { ok: true, expiresRound: endorsement.expiresRound };
}

// The Kingmaker's own endorsement, for a bot deciding whether to renew or
// withdraw: { targetSlot, renewed } or null.
export function endorsementFor(kingmakerSlot) {
  const e = endorsements.get(kingmakerSlot);
  return e ? { targetSlot: e.targetSlot, renewed: e.renewed } : null;
}

// What everyone may see (the endorsement is announced publicly).
export function endorsementView(players) {
  const find = (slot) => players.find((p) => p.slot === slot);
  return [...endorsements.values()].map((e) => ({
    kingmakerId: find(e.kingmakerSlot)?.id || null,
    targetId: find(e.targetSlot)?.id || null,
    expiresRound: e.expiresRound,
  }));
}

// ---------- Start of a round ----------

// Called once when a new round begins (never for round 1 or for a round after
// the match). Returns what happened, for the host to announce:
// { endorsementPaid: [{ id, influence }], endorsementExpired: [{ kingmakerId, targetId }],
//   populist: [{ id, trust }] }
export function startOfRound(round, players) {
  const out = { endorsementPaid: [], endorsementExpired: [], populist: [] };

  [...endorsements.values()].forEach((endorsement) => {
    const kingmaker = players.find((p) => p.slot === endorsement.kingmakerSlot);
    const target = players.find((p) => p.slot === endorsement.targetSlot);
    if (round > endorsement.expiresRound) {
      out.endorsementExpired.push({ kingmakerId: kingmaker?.id || null, targetId: target?.id || null });
      endorsements.delete(endorsement.kingmakerSlot);
    } else {
      [kingmaker, target].forEach((p) => {
        if (!p) return;
        out.endorsementPaid.push({ id: p.id, influence: adjustBalance(p, 'influence', kcfg.endorsementPerRound) });
      });
    }
  });

  players.forEach((p) => {
    if (characterIdOf(p) !== 'populist') return;
    const before = p.approval;
    applyApprovalDelta(p, pcfg.supportTrustPerRound);
    out.populist.push({ id: p.id, trust: p.approval - before });
  });
  return out;
}

// ---------- Kingmaker: Bonus Voting Power (passive) ----------

// A vote's weight: 1, or 2 for a Kingmaker (a copying Opportunist too), every time.
export const voteWeight = (player) => (characterIdOf(player) === 'kingmaker' ? 1 + kcfg.bonusVotes : 1);

// ---------- Populist: Public Campaign ----------

export function campaignCost(player) {
  return Math.max(pcfg.campaignMinCost, Math.floor((Math.max(player.money, 0) * pcfg.campaignCostPercent) / 100));
}

// A campaign for yourself (default) or for another player: the beneficiary gets
// the Public Trust, the Populist always pays the cost and gets the Influence.
// reason codes: 'insufficient-funds'
export function runCampaign(populist, beneficiary = populist) {
  const cost = campaignCost(populist);
  if (!(populist.money >= cost)) return { ok: false, reason: 'insufficient-funds', cost };
  adjustBalance(populist, 'money', -cost);
  const before = beneficiary.approval;
  applyApprovalDelta(beneficiary, beneficiary === populist ? pcfg.campaignTrust : pcfg.campaignOtherTrust);
  const influence = adjustBalance(populist, 'influence', pcfg.campaignInfluence);
  return { ok: true, cost, trust: beneficiary.approval - before, influence, forOther: beneficiary !== populist };
}

// ---------- Exposure reactions ----------

export const wasExposed = (slot) => exposedSlots.has(slot);
export const exposedSlotList = () => [...exposedSlots];

// Players were just confirmed exposed in a corruption scandal (a deal was
// exposed). Records them, then applies the two weaknesses:
//   - Populist: an extra -40% Public Trust, once per exposure;
//   - Kingmaker: if the endorsed player is among them while the endorsement is
//     active, -2% Public Trust and -500 Influence, once per endorsement.
// Returns { populist: [{ id, trust }], liabilities: [{ kingmakerId, targetId, trust, influence }] }.
export function reactToExposure(exposedPlayers, players) {
  const out = { populist: [], liabilities: [] };
  exposedPlayers.forEach((p) => exposedSlots.add(p.slot));

  exposedPlayers.forEach((p) => {
    if (characterIdOf(p) !== 'populist') return;
    const before = p.approval;
    applyApprovalDelta(p, -pcfg.scandalExtraTrust);
    out.populist.push({ id: p.id, trust: before - p.approval });
  });

  endorsements.forEach((endorsement) => {
    if (endorsement.liabilityDone || !exposedPlayers.some((p) => p.slot === endorsement.targetSlot)) return;
    const kingmaker = players.find((p) => p.slot === endorsement.kingmakerSlot);
    const target = players.find((p) => p.slot === endorsement.targetSlot);
    endorsement.liabilityDone = true;
    if (!kingmaker) return;
    const before = kingmaker.approval;
    applyApprovalDelta(kingmaker, -kcfg.liabilityTrust);
    const lost = -adjustBalance(kingmaker, 'influence', -kcfg.liabilityInfluence);
    out.liabilities.push({ kingmakerId: kingmaker.id, targetId: target?.id || null, trust: before - kingmaker.approval, influence: lost });
  });
  return out;
}
