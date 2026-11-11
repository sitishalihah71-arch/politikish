// Character Expansion, Phase 1: the 12 characters as plain data, the random
// deal at match start, and a generic ability-limit framework (cooldowns in
// rounds, per-game use counts). No ability has an EFFECT yet - this module
// only knows who each character is and whether an ability may be used right
// now. Effects arrive per character in later phases, all host-side.
//
// Everything here is only ever used when the room's "Mode Watak" setting is
// on; with it off no player gets a character and the game is unchanged.
//
// Privacy: a player's character is a secret (see player.js's
// PRIVATE_PLAYER_FIELDS); the host is the only place that reads it.

import { GAME_BALANCE } from './balance.js';
import { shuffle } from './utils.js';

export const CATEGORY_LABELS = {
  dirty: 'Dirty Politics',
  clean: 'Clean Politics',
  investigation: 'Investigation',
  flexible: 'Flexible',
};

// Limit shapes. `cooldown`: usable again `rounds` rounds after the round it
// was last used in (every player takes exactly one turn per round, so one
// round is one of the owner's own turns). `perGame`: at most `uses` times in
// the whole match. `none`: no limit of its own.
const cooldown = (rounds) => ({ type: 'cooldown', rounds });
const perGame = (uses = 1) => ({ type: 'perGame', uses });
const noLimit = { type: 'none' };

// A special ability may offer `options` (Kingmaker's four maneuvers,
// Journalist's Report / Media Trial). An option with its own `limit` is
// tracked on its own; one without shares the special's limit. Ability ids:
// 'special' or 'special.<optionId>'.
export const CHARACTERS = [
  {
    id: 'fixer',
    name: 'The Fixer',
    category: 'dirty',
    role: 'Backroom Deal Initiator',
    special: {
      name: 'Initiate Backroom Deal',
      summary: 'Start a Fixer Deal: only deals you start this way get the Fixer perks, including paying just +5 Corruption (everyone else pays +20).',
      limit: cooldown(2),
    },
    passive: { name: 'Deal Specialist', summary: '+10% extra reward from successfully completed Backroom Deals (rounded down).' },
    weakness: { name: 'Paper Trail', summary: 'Investigations against you succeed 15% more often.' },
  },
  {
    id: 'cleanPolitician',
    name: 'The Clean Politician',
    category: 'clean',
    role: 'Ethical Political Player',
    special: {
      name: 'Respond to Backroom Deal',
      summary: 'When someone offers you a Backroom Deal you may Accept, Expose or Reject Quietly. You are the only character who can Expose an offer.',
      limit: noLimit,
    },
    passive: { name: 'Public Integrity', summary: '+5% Public Trust when you successfully expose corruption (instead of the standard +2%). One exposure reward per round.' },
    weakness: { name: 'Hypocrisy', summary: 'If a deal you accepted is later exposed, you skip 2 turns instead of 1.' },
  },
  {
    id: 'whistleblower',
    name: 'The Whistleblower',
    category: 'clean',
    role: 'Corruption Exposer',
    special: {
      name: 'Public Exposure',
      summary: 'Investigate a player. If you find an accepted Backroom Deal you can expose it and reveal Fail 101: initiator, recipient and purpose. +5% Public Trust and +100 Influence for a successful exposure.',
      limit: cooldown(2),
    },
    passive: { name: 'Deal Alert', summary: 'You are notified whenever a Backroom Deal is accepted, but not who was involved.' },
    weakness: { name: 'Clean Hands', summary: 'You cannot accept Backroom Deals.' },
  },
  {
    id: 'spy',
    name: 'The Spy',
    category: 'investigation',
    role: 'Secret Investigator',
    special: {
      name: 'Secret Investigation',
      summary: 'Secretly investigate a player (financial transactions, political deals, Corruption Level or recent ability use) for an Intelligence Report. The target is told they were investigated, never by whom.',
      limit: cooldown(2),
    },
    passive: { name: 'Additional Clue', summary: 'Your Intelligence Reports include one additional clue.' },
    weakness: { name: 'Blown Cover', summary: 'If your investigation fails, the target learns who investigated them.' },
  },
  {
    id: 'journalist',
    name: 'The Journalist',
    category: 'investigation',
    role: 'Public Scandal Investigator',
    special: {
      name: 'Investigative Report / Media Trial',
      summary: 'Publish an Investigative Report using an Evidence Token you hold, or put a player on Media Trial by accusing them of being a specific character. One accusation per activation.',
      limit: cooldown(2),
      options: [
        { id: 'report', name: 'Investigative Report' },
        { id: 'mediaTrial', name: 'Media Trial' },
      ],
    },
    passive: { name: 'Public Influence', summary: '+200 Influence when a correct accusation is confirmed.' },
    weakness: { name: 'Defamation Risk', summary: 'A wrong Media Trial accusation costs you RM20,000 and 5% Public Trust.' },
  },
  {
    id: 'kingmaker',
    name: 'The Kingmaker',
    category: 'dirty',
    role: 'Political Influence Broker',
    special: {
      name: 'Political Maneuver',
      summary: 'Pick one maneuver per turn: Power Broker, Official Endorsement, Withdraw/Renew Support, or Bonus Voting Power.',
      limit: noLimit,
      oncePerTurn: true,
      options: [
        { id: 'powerBroker', name: 'Power Broker', summary: 'Transfer 250-500 Influence to another player.', limit: cooldown(3) },
        { id: 'endorsement', name: 'Official Endorsement', summary: 'Pay 300 Influence: the player gets 300 Influence and +2% Public Trust, and you both gain +100 Influence each turn for 3 rounds.', limit: perGame(1) },
        { id: 'withdrawRenew', name: 'Withdraw/Renew Support', summary: 'Withdraw an active endorsement (they lose 2% Public Trust, announced publicly, no refund) or renew it for 3 more rounds.', limit: noLimit },
        { id: 'bonusVote', name: 'Bonus Voting Power', summary: 'One extra vote in a Parliament session.', limit: perGame(1) },
      ],
    },
    passive: { name: "Kingmaker's Cut", summary: '+200 Influence after a successful Power Broker transfer (once per transfer).' },
    weakness: { name: 'Political Liability', summary: 'If a player you endorsed is exposed in a scandal while the endorsement is active, you lose 2% Public Trust and 500 Influence (once per endorsement).' },
  },
  {
    id: 'moneyMan',
    name: 'The Money Man',
    category: 'dirty',
    role: 'Secret Political Funder',
    special: {
      name: 'Secret Funding',
      summary: 'Secretly fund another Dirty Politics player. If they accept, you receive an extra 30% of the amount offered and both of you gain Corruption.',
      limit: cooldown(3),
    },
    passive: { name: 'Starting Capital', summary: 'Start the game with an extra RM10,000.' },
    weakness: { name: 'Investigation Risk', summary: 'You face a higher investigation risk during Corruption events.' },
  },
  {
    id: 'lawyer',
    name: 'The Lawyer',
    category: 'clean',
    role: 'Legal Defence Specialist',
    special: {
      name: 'Legal Defence',
      summary: 'Defend yourself or another player: their next eligible monetary penalty is cut by 50%. It cannot cancel Evidence, reverse an exposure or touch Dedahkan penalties.',
      limit: cooldown(3),
    },
    passive: { name: 'Legal Protection', summary: '10% less on eligible monetary penalties against you. Reductions on one penalty never exceed 50% in total.' },
    weakness: { name: 'No Backroom Deal', summary: 'You cannot initiate Backroom Deals.' },
  },
  {
    id: 'populist',
    name: 'The Populist',
    category: 'clean',
    role: 'Public Campaign Specialist',
    special: {
      name: 'Public Campaign',
      summary: 'Spend money on a campaign: +20% Public Trust and +100 Influence. The cost is 20% of your money (at least RM5,000).',
      limit: cooldown(3),
    },
    passive: { name: 'Public Support', summary: '+5% Public Trust at the start of every round (max 100%).' },
    weakness: { name: 'Scandal Damage', summary: 'If you are exposed in a scandal you lose an extra 40% Public Trust.' },
  },
  {
    id: 'bureaucrat',
    name: 'The Bureaucrat',
    category: 'dirty',
    role: 'Administrative Control Specialist',
    special: {
      name: 'Falsify Evidence',
      summary: 'Pick a player: any Evidence about them that a Spy or Journalist sees is forged for the rest of the game. The real record and the real guilt do not change.',
      limit: perGame(1),
    },
    passive: { name: 'Administrative Efficiency', summary: 'Government-related actions (Projek) are 20% cheaper.' },
    weakness: { name: 'Personal Involvement', summary: 'You cannot Falsify Evidence about a player you share a Backroom Deal with.' },
  },
  {
    id: 'ally',
    name: 'The Ally',
    category: 'dirty',
    role: 'Political Protection Specialist',
    special: {
      name: 'Protective Alliance',
      summary: "Protect another player: their next exposed-deal monetary penalty is cut by 50%. Evidence and turn suspensions stay.",
      limit: perGame(3),
    },
    passive: { name: 'Mutual Support', summary: '+100 Influence whenever you successfully protect another player.' },
    weakness: { name: 'Conflict of Interest', summary: 'You cannot protect anyone against a scandal you are personally involved in.' },
  },
  {
    id: 'opportunist',
    name: 'The Opportunist',
    category: 'flexible',
    role: 'Adaptive Political Player',
    special: {
      name: 'Copycat Politics',
      summary: 'Pick any character currently in the match and become a copy of them - Special, Passive and Weakness - for the rest of the game.',
      limit: perGame(1),
    },
    passive: { name: 'Ability Copy', summary: 'Copied abilities follow their own cooldowns and limits.' },
    weakness: { name: 'Unknown Identity', summary: 'You never learn which player holds which character.' },
  },
];

export function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || null;
}

// The characters that can be dealt at this table size. The Opportunist's
// pick list is "who is in the match", which at a small table would hand them
// the opponents' identities outright, so it needs a minimum player count.
export function getDeck(playerCount) {
  const { minPlayers } = GAME_BALANCE.characters;
  return CHARACTERS.filter((c) => !minPlayers[c.id] || playerCount >= minPlayers[c.id]);
}

// Deals one distinct character to every player (host-side, at match start).
// The deck is never shorter than the table (11+ cards vs at most 6 seats).
export function dealCharacters(players) {
  const deck = shuffle(getDeck(players.length));
  players.forEach((player) => {
    const card = deck.pop();
    player.character = { id: card.id };
    player.abilityState = {};
  });
}

// ---------- Ability limits ----------

// Finds the limit that governs `abilityId` ('special' or 'special.<option>')
// for a character: { key, limit } or null if the ability does not exist.
export function resolveAbilityLimit(characterId, abilityId) {
  const character = getCharacter(characterId);
  if (!character) return null;
  if (abilityId === 'special') return { key: 'special', limit: character.special.limit };

  const [head, optionId] = String(abilityId).split('.');
  if (head !== 'special' || !optionId) return null;
  const option = (character.special.options || []).find((o) => o.id === optionId);
  if (!option) return null;
  if (option.limit) return { key: abilityId, limit: option.limit };
  return { key: 'special', limit: character.special.limit };
}

// Whether `player` may use `abilityId` in `round`. reason codes: 'no-character'
// | 'unknown-ability' | 'cooldown' (with `availableRound`) | 'limit-reached'.
export function checkAbilityUse(player, abilityId, round) {
  if (!player?.character) return { ok: false, reason: 'no-character' };
  const resolved = resolveAbilityLimit(player.character.id, abilityId);
  if (!resolved) return { ok: false, reason: 'unknown-ability' };

  const { key, limit } = resolved;
  const used = (player.abilityState || {})[key];
  if (!used) return { ok: true };

  if (limit.type === 'cooldown') {
    const availableRound = used.lastRound + limit.rounds;
    if (round < availableRound) return { ok: false, reason: 'cooldown', availableRound };
  } else if (limit.type === 'perGame') {
    if (used.count >= limit.uses) return { ok: false, reason: 'limit-reached' };
  }
  return { ok: true };
}

// Records a use. Callers check checkAbilityUse first; this never refuses.
export function markAbilityUsed(player, abilityId, round) {
  const resolved = resolveAbilityLimit(player.character?.id, abilityId);
  if (!resolved) return false;
  if (!player.abilityState) player.abilityState = {};
  const used = player.abilityState[resolved.key] || { lastRound: round, count: 0 };
  player.abilityState[resolved.key] = { lastRound: round, count: used.count + 1 };
  return true;
}

// For the UI: what to show next to an ability.
export function getAbilityStatus(player, abilityId, round) {
  const check = checkAbilityUse(player, abilityId, round);
  const resolved = player?.character ? resolveAbilityLimit(player.character.id, abilityId) : null;
  const count = resolved ? (player.abilityState?.[resolved.key]?.count || 0) : 0;
  return {
    ready: check.ok,
    reason: check.reason || null,
    roundsLeft: check.reason === 'cooldown' ? check.availableRound - round : 0,
    usesLeft: resolved?.limit.type === 'perGame' ? Math.max(0, resolved.limit.uses - count) : null,
  };
}
