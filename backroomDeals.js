// Backroom Deals: bribery negotiation between two players, entirely outside
// the turn system - either player can propose or respond at any time, not
// just on their own turn. Privacy is enforced by NEVER broadcasting a
// pending deal: match.js keeps this module's registry host-side only and
// messages each party directly (see room.getConnectionsByPlayerId), the
// same privacy boundary already proven for KABEL/Political Network.
//
// A deal may carry a CONDITION ("kontrak"): the offerer asks the target for
// something the host can check. Then the payment is split - the "held"
// share is taken from the offerer straight away and kept in escrow; it goes
// to the target if the condition is met, and back to the offerer if it is
// not (or can't be). A target who breaks the terms can be exposed by the
// offerer afterwards (see exposeContract).
//
//   vote       target votes YA/TIDAK in the next Parliament vote
//   noharm     target doesn't Sabotaj / Raid / smear the offerer for a window
//   sabotage   target Sabotajs a named rival on their next turn
//   nopolitik  target doesn't Politik into the seat above the offerer

import { GAME_BALANCE } from './balance.js';
import { RANK_LABELS, getNextRank } from './player.js';
import { validateSabotaj } from './sabotage.js';
import { applyScandalDelta, demoteOneRank } from './effects.js';
import { recordAcceptedDeal, applyExposedBeforeAccept, markContractExposed, resetEvidence } from './evidence.js';
import { applyFixerPerk, applyFundingBonus } from './abilities.js';

const cfg = GAME_BALANCE.backroomDeals;

export const CONDITION_TYPES = ['none', 'vote', 'noharm', 'sabotage', 'nopolitik'];

let dealSeq = 0;
let contractSeq = 0;
const pendingDeals = new Map(); // dealId -> { offererId, targetId, money, influence, condition }
let contracts = []; // host-side registry of conditional deals (all statuses)

// Only the currencies actually being offered are checked: a player in debt in
// one currency (negative Money or Influence, see exposeContract) can still pay
// in the other.
function affordable(player, money, influence) {
  return (money === 0 || player.money >= money) && (influence === 0 || player.influence >= influence);
}

// The round at the end of which the next Parliament session opens, or null
// if none will open before the match ends (sessions never open after the
// final round, see match.js's advanceTurn).
export function getNextVoteRound(round, maxRounds, parliamentEnabled) {
  if (!parliamentEnabled) return null;
  const interval = GAME_BALANCE.parliament.intervalRounds;
  const voteRound = Math.ceil(round / interval) * interval;
  return voteRound < maxRounds ? voteRound : null;
}

// Human-readable terms, shared by the offer preview, the incoming deal and
// the contracts list. `nameOf(id)` resolves a player id to a name.
export function describeCondition(condition, nameOf = () => 'seorang pemain') {
  switch (condition?.type) {
    case 'vote':
      return `Undi ${condition.choice === 'yes' ? 'YA' : 'TIDAK'} pada undian parlimen seterusnya (akhir ronda ${condition.voteRound})`;
    case 'noharm':
      return `Jangan Sabotaj, Raid atau serang imej saya hingga akhir ronda ${condition.untilRound}`;
    case 'sabotage':
      return `Sabotaj ${nameOf(condition.victimId)} pada giliran seterusnya`;
    case 'nopolitik':
      return `Jangan guna Politik ke kerusi ${RANK_LABELS[condition.rank] || ''} hingga akhir ronda ${condition.untilRound}`;
    default:
      return 'Tiada syarat';
  }
}

// Splits a payment: `heldPercent` of each currency is escrowed, the rest is
// paid up front.
export function splitPayment(money, influence) {
  const held = {
    money: Math.floor((money * cfg.heldPercent) / 100),
    influence: Math.floor((influence * cfg.heldPercent) / 100),
  };
  return {
    held,
    upfront: { money: money - held.money, influence: influence - held.influence },
  };
}

// Returns { ok:true, condition } with the derived fields filled in (rounds,
// seat rank), or { ok:false, reason }. reason: 'condition-unavailable' |
// 'invalid-victim' | 'condition-pointless'
function buildCondition(raw, offerer, target, players, ctx) {
  const type = CONDITION_TYPES.includes(raw?.type) ? raw.type : 'none';
  if (type === 'none') return { ok: true, condition: { type: 'none' } };

  if (type === 'vote') {
    const voteRound = getNextVoteRound(ctx.round, ctx.maxRounds, ctx.parliamentEnabled);
    if (!voteRound || (raw.choice !== 'yes' && raw.choice !== 'no')) {
      return { ok: false, reason: 'condition-unavailable' };
    }
    return { ok: true, condition: { type, choice: raw.choice, voteRound } };
  }

  if (type === 'noharm') {
    return { ok: true, condition: { type, untilRound: ctx.round + cfg.contractRounds - 1 } };
  }

  if (type === 'sabotage') {
    const victim = players.find((p) => p.id === raw.victimId);
    if (!victim || victim.id === offerer.id || victim.id === target.id) {
      return { ok: false, reason: 'invalid-victim' };
    }
    // Only structural problems rule a victim out here - being a little
    // short of Influence right now is the target's own problem to solve.
    const check = validateSabotaj(target, victim, players, 0);
    if (!check.ok && check.reason !== 'insufficient-influence') {
      return { ok: false, reason: 'invalid-victim' };
    }
    return { ok: true, condition: { type, victimId: victim.id } };
  }

  // nopolitik: only meaningful when both of them are after the same seat.
  const rank = getNextRank(offerer.rank);
  if (!rank || getNextRank(target.rank) !== rank) return { ok: false, reason: 'condition-pointless' };
  return { ok: true, condition: { type, rank, untilRound: ctx.round + cfg.contractRounds - 1 } };
}

// reason codes: 'invalid-target' | 'invalid-amount' | 'insufficient-funds' |
// 'condition-unavailable' | 'invalid-victim' | 'condition-pointless'
export function proposeDeal(offerer, target, money, influence, rawCondition = null, players = [], ctx = {}) {
  const m = Math.max(0, Math.floor(money) || 0);
  const inf = Math.max(0, Math.floor(influence) || 0);
  if (!target || target.id === offerer.id) return { ok: false, reason: 'invalid-target' };
  if (m === 0 && inf === 0) return { ok: false, reason: 'invalid-amount' };
  if (!affordable(offerer, m, inf)) return { ok: false, reason: 'insufficient-funds' };

  const built = buildCondition(rawCondition, offerer, target, players, ctx);
  if (!built.ok) return built;

  dealSeq += 1;
  const dealId = `deal-${dealSeq}`;
  // `ctx.special` ('fixer' | 'funding') marks a deal started with a character
  // power; match.js has already checked the offerer may use it.
  pendingDeals.set(dealId, { offererId: offerer.id, targetId: target.id, money: m, influence: inf, condition: built.condition, special: ctx.special || null });
  return { ok: true, dealId, money: m, influence: inf, condition: built.condition };
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
// A successful conditional deal also returns the new `contract`.
export function respondToDeal(dealId, accept, players, ctx = {}, rng = Math.random, responderId = null) {
  const deal = pendingDeals.get(dealId);
  if (!deal) return { ok: false, reason: 'deal-not-found' };
  // Only the person the deal was addressed to may answer it.
  if (responderId && responderId !== deal.targetId) return { ok: false, reason: 'deal-not-found' };
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

  // Off by default (cfg.leakEnabled): a deal only becomes public when the
  // offerer chooses to Dedahkan a breached contract.
  const leaked = Boolean(cfg.leakEnabled) && rng() < getLeakChance(offerer.scandal, target.scandal);
  const base = {
    ok: true, accepted: true,
    offererId: deal.offererId, targetId: deal.targetId,
    money: deal.money, influence: deal.influence,
    condition: deal.condition,
  };

  if (leaked) {
    offerer.skipNextTurn = true;
    target.skipNextTurn = true;
    return { ...base, leaked: true };
  }

  const conditional = deal.condition.type !== 'none';
  const { held, upfront } = conditional
    ? splitPayment(deal.money, deal.influence)
    : { held: { money: 0, influence: 0 }, upfront: { money: deal.money, influence: deal.influence } };

  // The whole payment leaves the offerer now; the held share sits in the
  // contract rather than with either party.
  offerer.money -= deal.money;
  offerer.influence -= deal.influence;
  target.money += upfront.money;
  target.influence += upfront.influence;

  // Mode Watak (ctx.characters): an accepted deal costs Corruption and Public
  // Trust and leaves one Evidence Token (evidence.js). Off: nothing changes.
  const dealType = deal.condition.type === 'none' ? 'plain' : deal.condition.type;
  const fixerDeal = Boolean(ctx.characters) && deal.special === 'fixer';
  const record = (contractId = null) => (ctx.characters
    ? recordAcceptedDeal({
      initiator: offerer, recipient: target, dealType, money: deal.money, influence: deal.influence, round: ctx.round || 1, contractId,
      ...(fixerDeal ? { initiatorCorruption: GAME_BALANCE.characters.fixer.corruptionAsInitiator } : {}),
    })
    : null);
  // Character perks on an accepted deal, paid on what was offered.
  const perks = () => {
    if (!ctx.characters || !deal.special) return null;
    const paid = { money: deal.money, influence: deal.influence };
    const bonus = deal.special === 'fixer' ? applyFixerPerk(offerer, paid) : applyFundingBonus(offerer, target, paid);
    return { kind: deal.special, bonus };
  };

  if (!conditional) {
    const shadow = record();
    const perk = perks();
    return { ...base, leaked: false, ...(shadow ? { corruption: shadow.corruption } : {}), ...(perk ? { perk } : {}) };
  }

  contractSeq += 1;
  const contract = {
    id: `contract-${contractSeq}`,
    offererId: offerer.id,
    targetId: target.id,
    money: deal.money,
    influence: deal.influence,
    upfront,
    held,
    condition: deal.condition,
    status: 'active',
    createdRound: ctx.round || 1,
    afterVoteSeq: ctx.voteSeq || 0,
    feasible: true, // sabotage: refreshed at the start of the target's turn
    botWillBreak: Boolean(target.isBot) && rng() * 100 < cfg.botBreakChance,
  };
  contracts.push(contract);
  const shadow = record(contract.id);
  const perk = perks();
  return { ...base, leaked: false, contract: viewOf(contract), contractId: contract.id, upfront, held, ...(shadow ? { corruption: shadow.corruption } : {}), ...(perk ? { perk } : {}) };
}

// ---------- Contract lifecycle ----------

function viewOf(c) {
  return {
    id: c.id,
    offererId: c.offererId,
    targetId: c.targetId,
    money: c.money,
    influence: c.influence,
    upfront: c.upfront,
    held: c.held,
    condition: c.condition,
    status: c.status,
    createdRound: c.createdRound,
    // Only once exposed: the record of how it ended.
    ...(c.status === 'exposed' ? { exposedRound: c.exposedRound, refund: c.refund, debt: c.debt, penalty: c.penalty } : {}),
  };
}

// What one player is allowed to see: only contracts they are a party to.
export function getContractViewsFor(playerId) {
  return contracts
    .filter((c) => c.offererId === playerId || c.targetId === playerId)
    .map((c) => ({ ...viewOf(c), role: c.offererId === playerId ? 'offerer' : 'target' }));
}

// Raw active contracts where `playerId` is the target - used by match.js to
// steer bots, never sent anywhere.
export function getActiveContractsAsTarget(playerId) {
  return contracts.filter((c) => c.targetId === playerId && c.status === 'active');
}

export function getBreachedContractsAsOfferer(playerId) {
  return contracts.filter((c) => c.offererId === playerId && c.status === 'breached');
}

// fulfilled: escrow goes to the target. breached/expired: escrow goes back
// to the offerer. Returns the event for the caller to announce.
function settle(contract, kind, players) {
  const offerer = players.find((p) => p.id === contract.offererId);
  const target = players.find((p) => p.id === contract.targetId);
  const recipient = kind === 'fulfilled' ? target : offerer;
  if (recipient) {
    recipient.money += contract.held.money;
    recipient.influence += contract.held.influence;
  }
  contract.status = kind;
  return { kind, contract: viewOf(contract), offererId: contract.offererId, targetId: contract.targetId };
}

function activeContracts() {
  return contracts.filter((c) => c.status === 'active');
}

// Called for every resolved turn action (match.js's setLastAction). Only the
// target's own actions can fulfil or break a contract.
export function handleAction(action, players) {
  const events = [];
  if (!action || action.type === 'skip') return events;
  activeContracts().forEach((c) => {
    if (c.targetId !== action.actorId) return;
    const { condition } = c;

    if (condition.type === 'noharm') {
      const hostile = ['sabotaj', 'raid', 'media'].includes(action.type) && action.targetId === c.offererId;
      if (hostile) events.push(settle(c, 'breached', players));
    } else if (condition.type === 'nopolitik') {
      if (action.type === 'politik' && action.toRank === condition.rank) events.push(settle(c, 'breached', players));
    } else if (condition.type === 'sabotage') {
      if (action.type === 'sabotaj' && action.targetId === condition.victimId) {
        events.push(settle(c, 'fulfilled', players));
      } else {
        // If Sabotaj on that rival was no longer possible this turn, it
        // can't be held against them - the deal just lapses.
        events.push(settle(c, c.feasible ? 'breached' : 'expired', players));
      }
    }
  });
  return events;
}

// A Parliament vote just closed: settle every vote contract that was struck
// before it opened.
export function handleVoteResolved(vote, players) {
  const events = [];
  activeContracts().forEach((c) => {
    if (c.condition.type !== 'vote' || vote.seq <= c.afterVoteSeq) return;
    const cast = vote.votes[c.targetId];
    events.push(settle(c, cast === c.condition.choice ? 'fulfilled' : 'breached', players));
  });
  return events;
}

// A round just completed: windows that have run out without a breach are
// fulfilled, anything still waiting past its deadline lapses.
export function handleRoundEnd(completedRound, players) {
  const events = [];
  if (completedRound === null) return events;
  activeContracts().forEach((c) => {
    const { condition } = c;
    if ((condition.type === 'noharm' || condition.type === 'nopolitik') && completedRound >= condition.untilRound) {
      events.push(settle(c, 'fulfilled', players));
    } else if (condition.type === 'sabotage' && completedRound >= c.createdRound + cfg.contractRounds) {
      events.push(settle(c, 'expired', players));
    } else if (condition.type === 'vote' && completedRound > condition.voteRound) {
      events.push(settle(c, 'expired', players));
    }
  });
  return events;
}

// A turn just started: note whether the target of a "Sabotaj X" contract
// can actually do it right now, so a turn that makes it impossible isn't
// counted as a breach.
export function noteTurnStart(activePlayer, players) {
  activeContracts().forEach((c) => {
    if (c.condition.type !== 'sabotage' || c.targetId !== activePlayer.id) return;
    const victim = players.find((p) => p.id === c.condition.victimId);
    c.feasible = Boolean(victim) && validateSabotaj(activePlayer, victim, players, 0, { isKabel: Boolean(activePlayer.hasKabel) }).ok;
  });
}

// "Dedahkan": only the offerer, only for a breached contract, free, and
// GUARANTEED ("jaminan"): the target hands back everything they were paid up
// front, whatever they have left. What they can cover comes out of their
// balance; the rest is taken as debt - their Money / Influence goes negative
// (see effects.js's adjustBalance) and their next income pays it off. The
// offerer is made whole immediately. On top of the refund the target pays a
// fine (Money + Influence), takes a Scandal hit, loses a seat and gets a
// Pecah Amanah mark - all always applied. The offerer, being in on it, takes
// a smaller Scandal hit and a Money fine (capped at what they hold) but keeps
// their seat. Fines are burned; the refund is only moved.
// reason codes: 'contract-not-found' | 'not-exposable'
export function exposeContract(contractId, requesterId, players, ctx = {}) {
  const c = contracts.find((x) => x.id === contractId);
  if (!c || c.offererId !== requesterId) return { ok: false, reason: 'contract-not-found' };
  if (c.status !== 'breached') return { ok: false, reason: 'not-exposable' };
  const offerer = players.find((p) => p.id === c.offererId);
  const target = players.find((p) => p.id === c.targetId);
  if (!offerer || !target) return { ok: false, reason: 'contract-not-found' };

  const refund = { money: c.upfront.money, influence: c.upfront.influence };
  const targetFine = { money: cfg.exposeTargetFineMoney, influence: cfg.exposeTargetFineInfluence };
  // Whatever the target owes (refund + fine) beyond what they hold is debt.
  const debt = {
    money: Math.max(0, refund.money + targetFine.money - Math.max(target.money, 0)),
    influence: Math.max(0, refund.influence + targetFine.influence - Math.max(target.influence, 0)),
  };
  target.money -= refund.money + targetFine.money;
  target.influence -= refund.influence + targetFine.influence;
  offerer.money += refund.money;
  offerer.influence += refund.influence;
  const offererFine = { money: Math.min(cfg.exposeOffererFineMoney, Math.max(offerer.money, 0)) };
  offerer.money -= offererFine.money;

  applyScandalDelta(target, cfg.exposeTargetScandal);
  applyScandalDelta(offerer, cfg.exposeOffererScandal);
  if (cfg.exposeScandalCappedBelowPenalty) {
    // Dedahkan counts on its own: it must not also set off the 100% Scandal
    // penalty (which would be a second demotion and a 50% Money loss).
    const cap = GAME_BALANCE.scandal.penaltyThreshold - 1;
    [target, offerer].forEach((p) => { p.scandal = Math.min(p.scandal, cap); });
  }
  let ranksLost = 0;
  for (let i = 0; i < cfg.exposeTargetRanksLost; i += 1) {
    if (demoteOneRank(target, players)) ranksLost += 1;
  }
  target.betrayals = (target.betrayals || 0) + 1;
  c.status = 'exposed';
  c.exposedRound = ctx.round || c.createdRound;
  markContractExposed(c.id, c.exposedRound); // the same deal cannot be exposed again through its token
  c.refund = refund;
  c.debt = debt;
  c.penalty = { target: { ...targetFine, ranksLost }, offerer: offererFine };

  return { ok: true, contract: viewOf(c), refund, debt, penalty: c.penalty, offerer, target };
}

// Mode Watak: the person a deal was offered to exposes it instead of
// answering (the Clean Politician's special, wired up later). Only the
// recipient may, and only while it is still unanswered; nothing was paid, so
// there is no token. Penalties come from evidence.js's single table.
// reason codes: 'deal-not-found'
export function exposePendingDeal(dealId, exposerId, players) {
  const deal = pendingDeals.get(dealId);
  if (!deal || deal.targetId !== exposerId) return { ok: false, reason: 'deal-not-found' };
  const offerer = players.find((p) => p.id === deal.offererId);
  const target = players.find((p) => p.id === deal.targetId);
  pendingDeals.delete(dealId);
  if (!offerer || !target) return { ok: false, reason: 'deal-not-found' };
  return { ok: true, offerer, target, ...applyExposedBeforeAccept(offerer, target, players) };
}

// Pending offers the player has made and not yet had answered - their own
// side only. (The target sees theirs as the incoming-deal prompt.)
export function getPendingDealViewsFor(playerId) {
  const views = [];
  pendingDeals.forEach((d, dealId) => {
    if (d.offererId !== playerId) return;
    views.push({ dealId, targetId: d.targetId, money: d.money, influence: d.influence, condition: d.condition });
  });
  return views;
}

// Two players may talk privately while a deal between them is waiting for an
// answer, and for as long as a contract between them is still open (any status
// - a broken one still has to be argued over before it is exposed). Once a
// contract is exposed it is over: the chat closes and the host refuses further
// messages (the transcript stays in the host's record). Two players with
// another open deal between them can still talk.
export function hasDealBetween(aId, bId) {
  for (const d of pendingDeals.values()) {
    if ((d.offererId === aId && d.targetId === bId) || (d.offererId === bId && d.targetId === aId)) return true;
  }
  return contracts.some((c) => c.status !== 'exposed'
    && ((c.offererId === aId && c.targetId === bId) || (c.offererId === bId && c.targetId === aId)));
}

export function resetDeals() {
  pendingDeals.clear();
  contracts = [];
  resetEvidence();
}
