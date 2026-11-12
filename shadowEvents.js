// Character Expansion, Phase 3c: the four National Events of Mode Watak (GDD
// section 6). They have their own deck and beat (GAME_BALANCE.shadowEvents) and
// sit beside the ordinary National Events, which are untouched. Host side only.
//
// An event is drawn at a round boundary and is active for the round that
// follows. Three of them are modifiers other modules ask about; Public Trust
// Collapse is instant. Nothing here moves money or Influence.

import { GAME_BALANCE } from './balance.js';
import { applyApprovalDelta } from './effects.js';
import { getTokensInvolving } from './evidence.js';
import { characterIdOf } from './abilities.js';
import { wasExposed } from './maneuvers.js';
import { randomChoice } from './utils.js';

const cfg = GAME_BALANCE.shadowEvents;

export const SHADOW_EVENTS = [
  {
    id: 'leaked-audio',
    name: 'Leaked Audio',
    icon: '🎧',
    description: 'A recording surfaces. This round every investigation is certain to find what is hidden.',
  },
  {
    id: 'anti-corruption-commission',
    name: 'Anti-Corruption Commission',
    icon: '🕵️',
    description: 'The commission opens its files. This round the heavily compromised are easy targets, and the Spy, Journalist and Whistleblower each get one extra free investigation.',
  },
  {
    id: 'public-trust-collapse',
    name: 'Public Trust Collapse',
    icon: '📉',
    description: `Voters have had enough. Everyone with an exposed scandal loses ${cfg.trustCollapse}% Public Trust.`,
  },
  {
    id: 'parliamentary-inquiry',
    name: 'Parliamentary Inquiry',
    icon: '🏛️',
    description: 'Parliament opens an inquiry. This round the Lawyer, the Ally and the Bureaucrat cannot use their Special if they, or the player they target, hold hidden Evidence.',
  },
];

let active = null; // { id, round, freeUsed: Set<slot> }
let lastId = null;

export function resetShadowEvents() {
  active = null;
  lastId = null;
}

// Whether `completedRound` ends with a draw: round `firstRound`, then every
// `intervalRounds`.
export function isEventBoundary(completedRound) {
  return completedRound >= cfg.firstRound && (completedRound - cfg.firstRound) % cfg.intervalRounds === 0;
}

// Call at the start of every new round: clears an event whose round is over,
// then draws the next one if this boundary has one. Returns the event drawn
// (with, for Public Trust Collapse, who lost how much) or null.
export function advanceShadowEvents(round, players) {
  if (active && active.round < round) active = null;
  if (!isEventBoundary(round - 1)) return null;

  const pool = SHADOW_EVENTS.filter((e) => e.id !== lastId);
  const event = randomChoice(pool);
  lastId = event.id;
  active = { id: event.id, round, freeUsed: new Set() };

  const result = { event, affected: [] };
  if (event.id === 'public-trust-collapse') {
    players.filter((p) => wasExposed(p.slot)).forEach((p) => {
      const before = p.approval;
      applyApprovalDelta(p, -cfg.trustCollapse);
      result.affected.push({ id: p.id, trust: before - p.approval });
    });
  }
  return result;
}

export const getActiveEvent = () => (active ? SHADOW_EVENTS.find((e) => e.id === active.id) : null);

// Public view for the match payload.
export function shadowEventView() {
  const event = getActiveEvent();
  return event ? { id: event.id, name: event.name, icon: event.icon, description: event.description, round: active.round } : null;
}

// ---------- Modifiers ----------

const isActive = (id) => Boolean(active && active.id === id);

// How an investigation of `target` is changed this round: { forceSuccess, bonus }.
export function investigationModifiers(target) {
  if (isActive('leaked-audio')) return { forceSuccess: true, bonus: 0 };
  let bonus = 0;
  if (isActive('anti-corruption-commission')) {
    if (target.scandal >= cfg.commissionScandalThreshold) bonus += cfg.commissionTargetBonus;
    if (characterIdOf(target) === 'moneyMan') bonus += cfg.moneyManRiskBonus; // Investigation Risk
  }
  return { forceSuccess: false, bonus };
}

// The Commission's free investigation: the first one each investigator makes
// during the event. It ignores the cooldown and does not start one.
export function freeInvestigationAvailable(player) {
  return isActive('anti-corruption-commission') && !active.freeUsed.has(player.slot);
}

export function claimFreeInvestigation(player) {
  if (freeInvestigationAvailable(player)) active.freeUsed.add(player.slot);
}

// Parliamentary Inquiry: whether `actor` may use an ability that obstructs or
// modifies an investigation, with `target` (or nobody) as its object. Blocked
// when the actor or the target holds a hidden Evidence Token.
export function inquiryBlocks(actor, target = null) {
  if (!isActive('parliamentary-inquiry')) return false;
  if (!cfg.inquiryBlocked.includes(characterIdOf(actor))) return false;
  const underInvestigation = (p) => Boolean(p) && getTokensInvolving(p.slot, { includeExposed: false }).length > 0;
  return underInvestigation(actor) || underInvestigation(target);
}
