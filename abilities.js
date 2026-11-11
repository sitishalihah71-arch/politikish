// Character Expansion, Phase 3a: the powers of the deal-and-defence family
// (Fixer, Clean Politician, Money Man, Lawyer, Ally). Pure state changes, host
// side only - no networking, no DOM. match.js decides who may use what and
// when; this module knows what each power does.
//
// Everything here is only reached in Mode Watak.

import { GAME_BALANCE } from './balance.js';
import { getCharacter, effectiveCharacterId } from './characters.js';
import { adjustBalance } from './effects.js';

const cfg = GAME_BALANCE.characters;

// Which character a player currently plays (an Opportunist who copied
// someone is that character; see characters.js).
export const characterIdOf = effectiveCharacterId;

export function categoryOf(player) {
  return getCharacter(characterIdOf(player))?.category || null;
}

// ---------- Fixer: Deal Specialist ----------

// Extra reward on a Fixer Deal that was accepted: a percentage of what was
// paid, rounded down, in each currency. Generated on top (not taken from the
// recipient). Returns { money, influence } actually credited to the Fixer.
export function applyFixerPerk(fixer, paid) {
  const pct = cfg.fixer.perkPercent;
  const bonus = {
    money: Math.floor((paid.money * pct) / 100),
    influence: Math.floor((paid.influence * pct) / 100),
  };
  if (bonus.money) adjustBalance(fixer, 'money', bonus.money);
  if (bonus.influence) adjustBalance(fixer, 'influence', bonus.influence);
  return bonus;
}

// ---------- Money Man: Secret Funding ----------

// A Dirty Politics player accepted Secret Funding: the Money Man receives an
// extra percentage of the amount offered, worked out on at most `fundingCap`
// per currency. Anyone else accepting gets the plain deal, silently.
export function applyFundingBonus(moneyMan, target, paid) {
  const empty = { money: 0, influence: 0 };
  if (categoryOf(target) !== 'dirty') return empty;
  const pct = cfg.moneyMan.fundingBonusPercent;
  const cap = cfg.moneyMan.fundingCap;
  const bonus = {
    money: Math.floor((Math.min(paid.money, cap) * pct) / 100),
    influence: Math.floor((Math.min(paid.influence, cap) * pct) / 100),
  };
  if (bonus.money) adjustBalance(moneyMan, 'money', bonus.money);
  if (bonus.influence) adjustBalance(moneyMan, 'influence', bonus.influence);
  return bonus;
}

// ---------- Lawyer and Ally: shields on monetary penalties ----------
// A shield is armed on a player (private, in abilityState) and cuts the NEXT
// eligible monetary penalty against them. Eligible = the Backroom Deal
// exposure table in evidence.js (Defamation joins it later); never Dedahkan,
// never Influence, never Evidence or turn suspensions.

export function armShield(target, kind, { sourceSlot, round }) {
  if (!target.abilityState) target.abilityState = {};
  const pct = kind === 'ally' ? cfg.shield.allyPct : cfg.shield.lawyerPct;
  // One shield of each kind per player: arming again refreshes, never stacks.
  const shields = (target.abilityState.shields || []).filter((s) => s.kind !== kind);
  shields.push({ kind, pct, sourceSlot, round });
  target.abilityState.shields = shields;
}

export function getShields(player) {
  return (player.abilityState?.shields || []).map((s) => ({ ...s }));
}

// Works out a monetary penalty after the Lawyer's passive and any armed
// shields, spending the shields it used. `involvedSlots` are the two parties
// of the exposed deal: an Ally's shield does nothing when the Ally is one of
// them (Conflict of Interest) and is kept. `players` lets the Ally be paid.
// Returns { amount, reducedBy, pct, shieldsUsed, allyBonus }.
export function reduceMoneyPenalty(player, amount, { players = [], involvedSlots = [] } = {}) {
  const none = { amount: Math.max(0, amount || 0), reducedBy: 0, pct: 0, shieldsUsed: [], allyBonus: [] };
  if (!(amount > 0)) return none;

  const shields = player.abilityState?.shields || [];
  const applicable = shields.filter((s) => !(s.kind === 'ally' && involvedSlots.includes(s.sourceSlot)));
  let pct = characterIdOf(player) === 'lawyer' ? cfg.shield.lawyerPassivePct : 0;
  applicable.forEach((s) => { pct += s.pct; });
  pct = Math.min(pct, cfg.shield.maxReductionPct);
  if (pct <= 0) return none;

  const reducedBy = Math.floor((amount * pct) / 100);
  const allyBonus = [];
  applicable.forEach((s) => {
    if (s.kind !== 'ally') return;
    const ally = players.find((p) => p.slot === s.sourceSlot);
    if (!ally) return;
    const gained = adjustBalance(ally, 'influence', cfg.shield.allyBonusInfluence);
    allyBonus.push({ slot: ally.slot, playerId: ally.id, influence: gained });
  });
  player.abilityState.shields = shields.filter((s) => !applicable.includes(s));
  return {
    amount: amount - reducedBy,
    reducedBy,
    pct,
    shieldsUsed: applicable.map((s) => ({ kind: s.kind, sourceSlot: s.sourceSlot })),
    allyBonus,
  };
}

// ---------- Clean Politician: Public Integrity ----------

// Whether the Clean Politician's one exposure reward for this round is still
// free, and if so spends it. Returns true when the bonus applies.
export function claimIntegrityBonus(player, round) {
  if (!player.abilityState) player.abilityState = {};
  const state = player.abilityState.publicIntegrity;
  if (state && state.lastRound === round) return false;
  player.abilityState.publicIntegrity = { lastRound: round };
  return true;
}
