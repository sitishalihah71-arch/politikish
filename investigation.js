// Character Expansion, Phase 3b: investigations, the Bureaucrat's forgery and
// the Journalist's penalties. Host side only; pure state, no networking.
//
// What an investigator is shown about a player's Evidence Tokens is a VIEW:
// a copy with its own opaque id, so a view never says whether it is genuine.
// The Bureaucrat's Falsify marks a player: from then on the Spy and the
// Journalist see forged views of that player's tokens (wrong counterparty,
// wrong amounts). The real token and the real guilt never change, and the
// Whistleblower is not fooled. A Journalist who publishes a forged view gets
// nothing exposed and pays for it (applyForgedReportPenalty).
//
// Registry (forged players, forged copies, views) is host-private and reset
// with every match.

import { GAME_BALANCE } from './balance.js';
import { getCharacter, CHARACTERS } from './characters.js';
import { getTokens, getTokensInvolving } from './evidence.js';
import { characterIdOf, reduceMoneyPenalty } from './abilities.js';
import { adjustBalance, applyApprovalDelta } from './effects.js';

const cfg = GAME_BALANCE.characters;

let forgedSlots = new Set(); // slots whose tokens the Spy / Journalist see forged
let forgedCopies = new Map(); // tokenId -> the forged fields (same lie every time)
let views = new Map(); // viewId -> { viewerSlot, tokenId, forged, turnKey }
let viewSeq = 0;

export function resetInvestigations() {
  forgedSlots = new Set();
  forgedCopies = new Map();
  views = new Map();
  viewSeq = 0;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const roundTo = (n, step) => Math.round(n / step) * step;

// ---------- Chance ----------

// `ctx.forceSuccess` is for events that guarantee a result (a later phase).
export function investigationChance(target, { forceSuccess = false } = {}) {
  if (forceSuccess) return 1;
  const c = cfg.investigation;
  let pct = c.baseChance + c.scandalWeight * (target.scandal || 0);
  if (characterIdOf(target) === 'fixer') pct += c.fixerPaperTrailBonus; // weakness: Paper Trail
  return Math.min(pct, c.maxChance) / 100;
}

export function rollInvestigation(target, opts = {}) {
  return Math.random() < investigationChance(target, opts);
}

// ---------- Falsify ----------

// Bureaucrat only. reason codes: 'personal-involvement' | 'already-falsified'
export function falsify(bureaucrat, target) {
  const shared = getTokens().some((t) => (t.initiatorSlot === bureaucrat.slot && t.recipientSlot === target.slot)
    || (t.recipientSlot === bureaucrat.slot && t.initiatorSlot === target.slot));
  if (shared) return { ok: false, reason: 'personal-involvement' }; // weakness
  if (forgedSlots.has(target.slot)) return { ok: false, reason: 'already-falsified' };
  forgedSlots.add(target.slot);
  return { ok: true };
}

export function isFalsified(slot) {
  return forgedSlots.has(slot);
}

// ---------- Views of Evidence Tokens ----------

const DEAL_LABELS = { plain: 'Deal biasa', vote: 'Deal undian', noharm: 'Deal jangan serang', sabotage: 'Deal sabotaj', nopolitik: 'Deal jangan Politik' };
const DEAL_TYPES = Object.keys(DEAL_LABELS);
export const dealLabel = (type) => DEAL_LABELS[type] || DEAL_LABELS.plain;

function forgedCopyOf(token, target, players) {
  if (forgedCopies.has(token.id)) return forgedCopies.get(token.id);
  const realOtherSlot = token.initiatorSlot === target.slot ? token.recipientSlot : token.initiatorSlot;
  const pool = players.filter((p) => p.slot !== target.slot && p.slot !== realOtherSlot);
  const other = pool.length ? pick(pool) : players.find((p) => p.slot === realOtherSlot);
  const scale = (n) => (n ? Math.max(100, roundTo(n * (0.5 + Math.random() * 1.1), 100)) : 0);
  const copy = {
    counterpartySlot: other.slot,
    dealType: pick(DEAL_TYPES.filter((t) => t !== token.dealType)),
    money: scale(token.value.money),
    influence: scale(token.value.influence),
    round: Math.max(1, token.round + (Math.random() < 0.5 ? -1 : 1)),
  };
  forgedCopies.set(token.id, copy);
  return copy;
}

// The fields of one token as `target` would see them (real or forged).
function fieldsOf(token, target, players, forged) {
  const role = token.initiatorSlot === target.slot ? 'initiator' : 'recipient';
  const realOther = token.initiatorSlot === target.slot ? token.recipientSlot : token.initiatorSlot;
  const src = forged ? forgedCopyOf(token, target, players) : null;
  const otherSlot = forged ? src.counterpartySlot : realOther;
  const other = players.find((p) => p.slot === otherSlot);
  return {
    counterpartyId: other?.id || null,
    counterpartyName: other?.name || '?',
    role,
    dealType: forged ? src.dealType : token.dealType,
    money: forged ? src.money : token.value.money,
    influence: forged ? src.influence : token.value.influence,
    round: forged ? src.round : token.round,
  };
}

// Registers a view the investigator can later act on (publish / expose).
function registerView(viewerSlot, token, forged, turnKey) {
  viewSeq += 1;
  const viewId = `view-${viewSeq}`;
  views.set(viewId, { viewerSlot, tokenId: token.id, forged, turnKey });
  return viewId;
}

// Full views of the target's hidden (not yet exposed) tokens. Journalist and
// Whistleblower use this; only the Journalist is ever shown forged ones.
export function buildFullViews(viewerKind, viewer, target, players, turnKey) {
  const fooled = viewerKind === 'journalist' && forgedSlots.has(target.slot);
  return getTokensInvolving(target.slot, { includeExposed: false }).map((token) => ({
    viewId: registerView(viewer.slot, token, fooled, turnKey),
    ...fieldsOf(token, target, players, fooled),
    dealLabel: dealLabel(fieldsOf(token, target, players, fooled).dealType),
  }));
}

// What a Journalist may act on: the stored view, only on the turn it was made.
export function getView(viewerSlot, viewId, turnKey) {
  const v = views.get(viewId);
  if (!v || v.viewerSlot !== viewerSlot || v.turnKey !== turnKey) return null;
  return { ...v };
}

export function dropViews(viewerSlot) {
  views.forEach((v, id) => { if (v.viewerSlot === viewerSlot) views.delete(id); });
}

// K11: the number of hidden tokens on a player (what the Journalist sees in
// place of the Corruption card). Never forged.
export function hiddenTokenCount(slot) {
  return getTokensInvolving(slot, { includeExposed: false }).length;
}

// ---------- The Spy's Intelligence Report ----------

export const SPY_CATEGORIES = ['finance', 'deals', 'corruption', 'abilities'];

function pickClues(pool, count) {
  const chosen = [];
  const rest = pool.slice();
  while (chosen.length < count && rest.length) chosen.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
  return chosen;
}

function lastAbilityRound(player) {
  const state = player.abilityState || {};
  let last = 0;
  Object.entries(state).forEach(([key, value]) => {
    if (key.startsWith('special') && value && typeof value.lastRound === 'number') last = Math.max(last, value.lastRound);
  });
  return last;
}

// A successful investigation. Each category is a pool of possible clues; the
// report holds `clues` of them (+1 from Additional Clue). Deal clues come from
// the target's hidden tokens (forged ones for a falsified player).
// Returns { category, clues: [{ label, text }] } - empty clues = "nothing found".
export function spyReport(spy, target, category, players, round) {
  const count = cfg.spy.clues + (characterIdOf(spy) === 'spy' ? cfg.spy.extraClues : 0);
  const fooled = forgedSlots.has(target.slot);
  let clues = [];

  if (category === 'finance') {
    clues = pickClues([
      { label: 'Wang (anggaran)', text: `RM${roundTo(Math.max(target.money, 0), 5000).toLocaleString('en-US')}` },
      { label: 'Influence (anggaran)', text: String(roundTo(Math.max(target.influence, 0), 100)) },
      { label: 'Pangkat', text: target.rank },
      { label: 'Aset politik', text: String((target.assets || []).length) },
    ], count);
  } else if (category === 'corruption') {
    const tokens = getTokensInvolving(target.slot);
    clues = pickClues([
      { label: 'Skandal', text: `${target.scandal}%` },
      { label: 'Kepercayaan awam', text: `${target.approval}%` },
      { label: 'Rekod bukti tersembunyi', text: String(tokens.filter((t) => !t.exposed).length) },
      { label: 'Pernah didedah', text: tokens.some((t) => t.exposed) ? 'Ya' : 'Tidak' },
    ], count);
  } else if (category === 'abilities') {
    const last = lastAbilityRound(target);
    clues = pickClues([
      { label: 'Guna kuasa baru-baru ini', text: last >= round - 2 && last > 0 ? 'Ya' : 'Tidak' },
      { label: 'Kali terakhir guna kuasa', text: last ? `Ronda ${last}` : 'Belum pernah' },
      { label: 'Kategori watak', text: getCharacter(characterIdOf(target))?.category || '?' },
    ], count);
  } else if (category === 'deals') {
    const tokens = getTokensInvolving(target.slot, { includeExposed: false }).slice(-3);
    tokens.forEach((token) => {
      const f = fieldsOf(token, target, players, fooled);
      const pool = [
        { label: 'Rakan', text: f.counterpartyName },
        { label: 'Peranan', text: f.role === 'initiator' ? 'Pemula' : 'Penerima' },
        { label: 'Jenis', text: dealLabel(f.dealType) },
        { label: 'Nilai', text: [f.money ? `RM${f.money.toLocaleString('en-US')}` : '', f.influence ? `${f.influence} Influence` : ''].filter(Boolean).join(' + ') },
        { label: 'Ronda', text: String(f.round) },
      ];
      clues.push(...pickClues(pool, count));
    });
  }
  return { category, clues };
}

// ---------- Penalties for the Journalist ----------

// Takes money (shield-eligible, never below zero) and Public Trust.
function penalise(player, money, trust, players) {
  const penalty = reduceMoneyPenalty(player, money, { players, involvedSlots: [] });
  const lostMoney = penalty.amount ? -adjustBalance(player, 'money', -penalty.amount) : 0;
  const before = player.approval;
  applyApprovalDelta(player, -trust);
  return { money: lostMoney, trust: before - player.approval, reducedBy: penalty.reducedBy, shieldsUsed: penalty.shieldsUsed, allyBonus: penalty.allyBonus };
}

export const applyDefamation = (journalist, players) => penalise(journalist, cfg.defamation.money, cfg.defamation.trust, players);
export const applyForgedReportPenalty = (journalist, players) => penalise(journalist, cfg.forgedReport.money, cfg.forgedReport.trust, players);

// ---------- Media Trial ----------

export const isCharacterId = (id) => CHARACTERS.some((c) => c.id === id);

// Settles an accusation of identity. `admit` only matters when it is right.
// Returns { correct, confirmed, accusedTrust, journalistInfluence, defamation }.
export function resolveMediaTrial(journalist, accused, claimedId, admit, players) {
  const correct = characterIdOf(accused) === claimedId;
  if (!correct) {
    // Whatever the accused said, a wrong accusation is a challenge, and the
    // Journalist pays; the accused loses nothing.
    return { correct: false, confirmed: false, accusedTrust: 0, journalistInfluence: 0, defamation: applyDefamation(journalist, players) };
  }
  const t = cfg.mediaTrial;
  const trust = admit ? t.admitTrust : t.challengeTrust;
  const before = accused.approval;
  applyApprovalDelta(accused, -trust);
  const gained = adjustBalance(journalist, 'influence', t.journalistInfluence);
  return { correct: true, confirmed: true, accusedTrust: before - accused.approval, journalistInfluence: gained, defamation: null };
}
