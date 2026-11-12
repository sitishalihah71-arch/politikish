// Regression checks for the post-launch fixes (flow audit J1, J2, J5, J6, J7, J8, J11, J12).
//   J2  Journalist bots use the category clue for Media Trial; the clue plumbing is in phase3b.mjs
//   J5  Opportunist copying the Kingmaker is paid the War Chest straight away (the deal itself: phase3a.mjs)
//   J6  Lawyer and Ally are out of the deck (phase1.mjs) and cannot be accused in a Media Trial
//   J1  Whistleblower declined deals are explained: tested in phase3c.mjs
//   J7  Hypocrisy card text matches the exposure table
//   J11 A leaked deal adds its skip turn instead of overwriting a pending one
//   J12 Parliamentary Inquiry text says what the code does
import './shim.mjs';
import { GAME_BALANCE } from '../../balance.js';
import { createPlayer } from '../../player.js';
import { proposeDeal, respondToDeal } from '../../backroomDeals.js';
import { getCharacter, copyCharacter, activeCharacters } from '../../characters.js';
import { decideBotSpecial } from '../../bots.js';
import { isCharacterId } from '../../investigation.js';
import { SHADOW_EVENTS } from '../../shadowEvents.js';

let checks = 0; let failures = 0;
const ok = (c, m) => { checks += 1; if (!c) { failures += 1; console.log(`  FAIL: ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// J7: the card says what the table does (recipient 0 -> 2 for the Clean Politician; initiator 1 -> 2).
const text = getCharacter('cleanPolitician').weakness.summary;
ok(/skip 2 turns/.test(text) && !/instead of 1/.test(text), 'Hypocrisy text no longer claims "instead of 1"');
ok(/initiator/.test(text) && /recipient/.test(text), 'Hypocrisy text names both sides');
eq(GAME_BALANCE.characters ? GAME_BALANCE.shadowPolitics.consequences.exposedAfterAccept.recipient.skipTurns : null, 0, 'table: a recipient normally skips none (what the text now says)');
eq(GAME_BALANCE.shadowPolitics.consequences.cleanPoliticianSkipTurns, 2, 'table: the Clean Politician skips 2');

// J12
const inquiry = SHADOW_EVENTS.find((e) => e.id === 'parliamentary-inquiry').description;
ok(/hidden Evidence/.test(inquiry) && !/open investigation/.test(inquiry), 'Inquiry text describes hidden Evidence, not open investigations');

// J11: leaks are off in the live game; with them on, the skip must add up and stay capped at 2.
GAME_BALANCE.backroomDeals.leakEnabled = true;
GAME_BALANCE.backroomDeals.skipTurnsOnLeak = 1;
const fresh = (id, slot) => { const p = createPlayer({ id, slot, name: id, isHost: false }); p.money = 100000; p.influence = 1000; p.scandal = 0; p.approval = 50; return p; };
{
  const a = fresh('a', 0); const b = fresh('b', 1);
  b.skipNextTurn = 2; b.skipReason = 'deal-exposed'; // pending Hypocrisy-style suspension
  const d = proposeDeal(a, b, 1000, 0, null, [a, b], {});
  const r = respondToDeal(d.dealId, true, [a, b], {}, () => 0, b.id);
  ok(r.ok && r.leaked, 'the deal leaked (rng forced)');
  eq(a.skipNextTurn, 1, 'leak: a clean player skips 1');
  eq(a.skipReason, 'bribery-leak', 'leak: reason recorded');
  eq(b.skipNextTurn, 2, 'leak: a pending 2-turn skip is not erased (stays capped at 2)');
}
{
  const a = fresh('c', 0); const b = fresh('d', 1);
  b.skipNextTurn = 1;
  const d = proposeDeal(a, b, 1000, 0, null, [a, b], {});
  respondToDeal(d.dealId, true, [a, b], {}, () => 0, b.id);
  eq(b.skipNextTurn, 2, 'leak: 1 pending + 1 = 2');
}
GAME_BALANCE.backroomDeals.leakEnabled = false;

// J5: a copied Kingmaker brings its War Chest at once, a copied Spy brings nothing.
{
  const p = fresh('o', 0); p.character = { id: 'opportunist' };
  const before = { m: p.money, i: p.influence };
  const grant = copyCharacter(p, 'kingmaker');
  eq(grant.money, GAME_BALANCE.characters.kingmaker.startingMoneyBonus, 'copy Kingmaker: grant money');
  eq(grant.influence, GAME_BALANCE.characters.kingmaker.startingInfluence, 'copy Kingmaker: grant influence');
  eq(p.money - before.m, 20000, 'copy Kingmaker: +RM20,000 (the standard RM10,000 is already theirs)');
  eq(p.influence - before.i, 1000, 'copy Kingmaker: +1,000 Influence');
  const q = fresh('s', 1); q.character = { id: 'opportunist' };
  const none = copyCharacter(q, 'spy');
  ok(none.money === 0 && none.influence === 0, 'copy Spy: nothing');
}

// J6: hidden cards cannot be accused (they are not in the match, so a guess would be a free loss).
ok(!isCharacterId('lawyer') && !isCharacterId('ally') && isCharacterId('fixer'), 'Media Trial list leaves out the Lawyer and the Ally');
ok(!activeCharacters().some((c) => ['lawyer', 'ally'].includes(c.id)), 'activeCharacters excludes them');

// J2: a Journalist bot with a category clue accuses that player, and only names that category's cards.
{
  const deckIds = activeCharacters().map((c) => c.id);
  const bot = { id: 'jb', scandal: 0 };
  const rivals = [{ id: 'p1', scandal: 0 }, { id: 'p2', scandal: 0 }, { id: 'p3', scandal: 0 }];
  const players = [bot, ...rivals];
  const ctx = (clue) => ({
    characterId: 'journalist', ready: () => true, blocked: () => false, canFalsify: () => true,
    trialPendingIds: new Set(), revealedIds: new Set(), deckIds, copyOptions: [], endorsement: null, campaignCost: 5000,
    categoryClue: (id) => (clue && id === 'p2' ? clue : null), hasShield: false,
  });
  const c = GAME_BALANCE.bots.character;
  const saved = { u: c.useChance, k: c.mediaTrialKnownChance, b: c.mediaTrialChance };
  c.useChance = 100; c.mediaTrialKnownChance = 100; c.mediaTrialChance = 100;
  let allNarrow = true; let allTarget = true; const names = new Set();
  for (let i = 0; i < 400; i += 1) {
    const plan = decideBotSpecial(bot, players, ctx('dirty'));
    if (plan.abilityId !== 'special.mediaTrial') { allNarrow = false; continue; }
    if (plan.payload.targetId !== 'p2') allTarget = false;
    if (getCharacter(plan.payload.characterId).category !== 'dirty') allNarrow = false;
    names.add(plan.payload.characterId);
  }
  ok(allTarget, 'bot Journalist accuses the player whose category it knows');
  ok(allNarrow, 'and only names Dirty Politics cards');
  ok(names.size >= 3 && !names.has('lawyer') && !names.has('ally'), `and varies among the active dirty cards (${[...names].sort().join(', ')})`);
  const blind = new Set();
  for (let i = 0; i < 400; i += 1) blind.add(getCharacter(decideBotSpecial(bot, players, ctx(null)).payload.characterId).category);
  ok(blind.size >= 3, 'with no clue it still guesses across the whole deck');
  c.useChance = saved.u; c.mediaTrialKnownChance = saved.k; c.mediaTrialChance = saved.b;
}

console.log(failures ? `\nFIXES: ${failures} FAILED of ${checks} checks` : `\nFIXES: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
