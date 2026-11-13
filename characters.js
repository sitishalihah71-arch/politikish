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
    weakness: { name: 'Hypocrisy', summary: 'If a deal you are part of is later exposed, you skip 2 turns (other players skip 1 as the initiator and none as the recipient).' },
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
      summary: 'Investigate a player for a report (their money, Scandal and Public Trust this round, plus any Dirty Deals you may publish), or put a player on Media Trial by accusing them of being a specific character. One accusation per activation.',
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
      summary: 'Pick one maneuver per turn: Power Broker, Official Endorsement, or Withdraw/Renew Support. Every maneuver leaves a hidden Dirty Deal as evidence.',
      limit: noLimit,
      oncePerTurn: true,
      options: [
        { id: 'powerBroker', name: 'Power Broker', summary: 'Transfer 250-500 Influence to another player.', limit: cooldown(3) },
        { id: 'endorsement', name: 'Official Endorsement', summary: 'Pay 300 Influence: the player gets 300 Influence and +2% Public Trust, and you both gain +100 Influence each turn for 3 rounds.', limit: perGame(1) },
        { id: 'withdrawRenew', name: 'Withdraw/Renew Support', summary: 'Withdraw an active endorsement (they lose 2% Public Trust, announced publicly, no refund) or renew it for 3 more rounds.', limit: noLimit },
      ],
    },
    passive: {
      name: "Kingmaker's Cut",
      summary: 'Start the game with RM30,000 (the standard RM10,000 plus RM20,000) and 1,000 Influence. +200 Influence after a successful Power Broker transfer (once per transfer). Bonus Voting Power: every vote you cast in Parliament counts as 2 votes.',
    },
    weakness: { name: 'Political Liability', summary: 'If a player you endorsed is exposed in a scandal while the endorsement is active, you lose 2% Public Trust and 500 Influence (once per endorsement).' },
  },
  {
    id: 'moneyMan',
    name: 'The Money Man',
    category: 'dirty',
    role: 'Secret Political Funder',
    special: {
      name: 'Secret Funding',
      summary: 'You can see which players hold a Dirty Politics character, and you can only fund them. If they accept, you receive an extra 30% of the amount offered and both of you gain Corruption.',
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
      summary: 'Spend money on a campaign for yourself or another player: +20% Public Trust for them and +100 Influence for you. The cost is 20% of your money (at least RM5,000).',
      limit: cooldown(3),
    },
    passive: { name: 'Public Support', summary: '+3% Public Trust at the start of every round (max 100%).' },
    weakness: { name: 'Scandal Damage', summary: 'If you are exposed in a scandal you lose an extra 40% Public Trust.' },
  },
  {
    id: 'bureaucrat',
    name: 'The Bureaucrat',
    category: 'dirty',
    role: 'Administrative Control Specialist',
    special: {
      name: 'Falsify Evidence',
      summary: 'Pick a player: any Evidence about them that a Spy or Journalist sees is forged for the rest of the game (the other party is replaced by a random name). The real record and the real guilt do not change.',
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
      summary: 'Pick any character currently in the match and become a copy of them - Special, Passive and Weakness - for the rest of the game. Copying the Money Man or the Kingmaker pays out their starting money (and the Kingmaker 1,000 Influence) straight away.',
      limit: perGame(1),
    },
    passive: { name: 'Ability Copy', summary: 'Copied abilities follow their own cooldowns and limits.' },
    weakness: { name: 'Unknown Identity', summary: 'You never learn which player holds which character.' },
  },
];

export function getCharacter(id) {
  return CHARACTERS.find((c) => c.id === id) || null;
}

// Which character a player currently plays: normally the one they were dealt,
// but an Opportunist who has used Copycat Politics IS the character they
// copied from then on (Special, Passive and Weakness). One place to ask, so no
// rule has to know about the copy.
export function effectiveCharacterId(player) {
  return player?.character?.copiedId || player?.character?.id || null;
}

// The characters an Opportunist may copy: those held by the OTHER players,
// listed alphabetically so the list says nothing about who holds which.
export function copyableCharacterIds(opportunist, players) {
  const ids = players
    .filter((p) => p.id !== opportunist.id && p.character)
    .map((p) => effectiveCharacterId(p))
    .filter((id) => id && id !== 'opportunist');
  return [...new Set(ids)].sort();
}

// Becomes a copy of `characterId` for the rest of the game. The copy starts
// with its own fresh cooldowns and limits (the Opportunist's single use of
// Copycat is spent); shields and other armed effects stay.
// Returns the one-off { money, influence } the copy brought with it. A copied
// Money Man's Starting Capital or Kingmaker's War Chest is paid the moment it
// is copied, since the copier never "started the game" as one.
export function copyCharacter(player, characterId) {
  player.character = { id: player.character.id, copiedId: characterId };
  const state = player.abilityState || {};
  Object.keys(state).forEach((key) => { if (key === 'special' || key.startsWith('special.')) delete state[key]; });
  player.abilityState = state;
  const grant = startingGrant(characterId);
  player.money += grant.money;
  player.influence = (player.influence || 0) + grant.influence;
  return grant;
}

// What a character's passive hands over at the very start of the game.
function startingGrant(characterId) {
  const c = GAME_BALANCE.characters;
  if (characterId === 'moneyMan') return { money: c.moneyManStartingCapital, influence: 0 };
  if (characterId === 'kingmaker') return { money: c.kingmaker.startingMoneyBonus, influence: c.kingmaker.startingInfluence };
  return { money: 0, influence: 0 };
}

// The characters that can be dealt at this table size. The Opportunist's
// pick list is "who is in the match", which at a small table would hand them
// the opponents' identities outright, so it needs a minimum player count.
export function getDeck(playerCount) {
  const { minPlayers } = GAME_BALANCE.characters;
  return activeCharacters().filter((c) => !minPlayers[c.id] || playerCount >= minPlayers[c.id]);
}

// The characters currently in play: everyone except the cards held back in
// GAME_BALANCE.characters.disabled.
export function isCharacterActive(id) {
  return !GAME_BALANCE.characters.disabled.includes(id);
}
export function activeCharacters() {
  return CHARACTERS.filter((c) => isCharacterActive(c.id));
}

// Deals one character card to every player (host-side, at match start). The deck holds
// `deckCopies` copies of every active card, so with the live six-card deck two players can
// hold the same character. It is never shorter than the table: extra copies are added if a
// small config would leave it short.
export function dealCharacters(players) {
  const distinct = getDeck(players.length);
  const copies = Math.max(GAME_BALANCE.characters.deckCopies || 1, Math.ceil(players.length / distinct.length));
  const deck = shuffle(Array.from({ length: copies }, () => distinct).flat());
  players.forEach((player) => {
    const card = deck.pop();
    player.character = { id: card.id };
    player.abilityState = {};
    // Starting Capital (Money Man) and War Chest (Kingmaker).
    const grant = startingGrant(card.id);
    player.money += grant.money;
    player.influence = (player.influence || 0) + grant.influence;
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
  const resolved = resolveAbilityLimit(effectiveCharacterId(player), abilityId);
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
  const resolved = resolveAbilityLimit(effectiveCharacterId(player), abilityId);
  if (!resolved) return false;
  if (!player.abilityState) player.abilityState = {};
  const used = player.abilityState[resolved.key] || { lastRound: round, count: 0 };
  player.abilityState[resolved.key] = { lastRound: round, count: used.count + 1 };
  return true;
}

// For the UI: what to show next to an ability.
export function getAbilityStatus(player, abilityId, round) {
  const check = checkAbilityUse(player, abilityId, round);
  const resolved = player?.character ? resolveAbilityLimit(effectiveCharacterId(player), abilityId) : null;
  const count = resolved ? (player.abilityState?.[resolved.key]?.count || 0) : 0;
  return {
    ready: check.ok,
    reason: check.reason || null,
    roundsLeft: check.reason === 'cooldown' ? check.availableRound - round : 0,
    usesLeft: resolved?.limit.type === 'perGame' ? Math.max(0, resolved.limit.uses - count) : null,
  };
}
