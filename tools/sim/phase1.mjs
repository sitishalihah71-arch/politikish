// Phase 1 checks: character deal, privacy over the wire, ability-limit
// framework, room setting. Run: node tools/sim/phase1.mjs
import { runGame } from './harness.mjs';
import * as room from '../../room.js';
import { GAME_BALANCE } from '../../balance.js';
import { CHARACTERS, getDeck, isCharacterActive, activeCharacters, checkAbilityUse, markAbilityUsed, getAbilityStatus, resolveAbilityLimit } from '../../characters.js';

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log(`  FAIL: ${message}`);
  }
}

const PRIVATE = ['politicalNetwork', 'hasKabel', 'secretObjective', 'character', 'abilityState'];
const IDS = new Set(CHARACTERS.map((c) => c.id));

// Walks any message and reports every private field found on a player-like
// object (anything with a string `id` and `slot`).
function scanPrivate(value, found = [], context = {}) {
  if (Array.isArray(value)) {
    value.forEach((v) => scanPrivate(v, found, context));
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && 'slot' in value) {
      PRIVATE.forEach((field) => {
        // A null character (setting off) reveals nothing, so it is not a leak.
        if (value[field] !== undefined && value[field] !== null) found.push({ playerId: value.id, field, ...context });
      });
    }
    Object.values(value).forEach((v) => scanPrivate(v, found, context));
  }
  return found;
}

// ---------- 1. Mode Watak OFF: nothing changes ----------
console.log('1. setting off');
for (let i = 1; i <= 15; i += 1) {
  const g = await runGame({ seed: 500 + i, players: 4, rounds: 10, humans: 2 });
  ok(g.settings.characters === false, 'characters setting defaults to false');
  ok(g.players.every((p) => p.character === null), 'no character dealt when off');
  g.clients.forEach((c) => c.sent.forEach((m) => {
    scanPrivate(m.payload, [], { type: m.type }).forEach((f) => {
      if (f.field === 'character' || f.field === 'abilityState') ok(f.playerId === c.peer, `off: ${f.field} leaked in ${m.type}`);
    });
  }));
}

// ---------- 2. Mode Watak ON: deal, uniqueness, privacy, reveal ----------
console.log('2. setting on');
for (let n = 2; n <= 6; n += 1) {
  for (let i = 1; i <= 12; i += 1) {
    const seed = n * 100 + i;
    const hostViews = [];
    const record = (e) => hostViews.push(JSON.parse(JSON.stringify(e.detail)));
    document.addEventListener('match:updated', record);
    const g = await runGame({ seed, players: n, rounds: 10, humans: Math.min(3, n - 1), settings: { characters: true } });
    document.removeEventListener('match:updated', record);

    ok(g.settings.characters === true, 'characters setting reaches the snapshot');
    const ids = g.players.map((p) => p.character?.id);
    ok(ids.every((id) => IDS.has(id)), `${n}p seed ${seed}: every player has a valid character`);
    ok(new Set(ids).size === n, `${n}p seed ${seed}: characters are unique`);
    if (n < 4) ok(!ids.includes('opportunist'), `${n}p seed ${seed}: no Opportunist below 4 players`);
    ok(g.players.every((p) => p.abilityState && typeof p.abilityState === 'object'), 'abilityState exists');

    // Over the wire, every client may only ever see its own private data -
    // except characters, revealed by the final match-update (matchOver).
    g.clients.forEach((c) => {
      c.sent.forEach((m) => {
        const revealing = m.type === 'match-update' && m.payload.matchOver === true;
        scanPrivate(m.payload, [], { type: m.type }).forEach((f) => {
          const own = f.playerId === c.peer && m.type === 'match-update';
          const allowedReveal = revealing && f.field === 'character';
          ok(own || allowedReveal, `${n}p seed ${seed}: ${f.field} of ${f.playerId} leaked to ${c.peer} in ${m.type}`);
        });
      });
      const last = [...c.sent].reverse().find((m) => m.type === 'match-update');
      ok(last.payload.players.every((p) => p.character && IDS.has(p.character.id)), 'final update reveals every character');
      ok(last.payload.players.filter((p) => p.id !== c.peer).every((p) => p.secretObjective === undefined), 'secret objectives stay hidden at match end');
    });

    // The host's own screen goes through the same masking.
    hostViews.forEach((view) => {
      view.players.forEach((p) => {
        if (p.id === view.localPlayerId) return;
        ok(view.matchOver || p.character === undefined, `${n}p seed ${seed}: host view leaked another player's character`);
        ok(p.abilityState === undefined, 'host view leaked abilityState');
      });
    });
  }
}

// ---------- 3. Same seed deals the same characters ----------
console.log('3. deal is reproducible');
{
  const a = await runGame({ seed: 777, players: 5, settings: { characters: true } });
  const b = await runGame({ seed: 777, players: 5, settings: { characters: true } });
  ok(a.players.map((p) => p.character.id).join() === b.players.map((p) => p.character.id).join(), 'same seed, same deal');
}

// ---------- 4. Deck size ----------
console.log('4. deck');
const held = GAME_BALANCE.characters.disabled; // Lawyer and Ally are hidden for now
ok(held.join() === 'lawyer,ally', 'the Lawyer and the Ally are held back');
ok(getDeck(2).length === 12 - held.length - 1 && getDeck(3).length === 12 - held.length - 1, 'Opportunist excluded at 2-3 players');
ok(getDeck(4).length === 12 - held.length && getDeck(6).length === 12 - held.length, 'full deck from 4 players');
ok([2, 3, 4, 5, 6].every((n) => !getDeck(n).some((c) => held.includes(c.id))), 'no deck ever holds a hidden character');
ok(!isCharacterActive('lawyer') && !isCharacterActive('ally') && isCharacterActive('fixer'), 'isCharacterActive follows the list');
ok(activeCharacters().length === 12 - held.length, 'activeCharacters leaves them out');

// ---------- 5. Ability limits ----------
console.log('5. ability limits');
const mk = (id) => ({ character: { id }, abilityState: {} });
{
  const spy = mk('spy'); // cooldown 2
  ok(checkAbilityUse(spy, 'special', 3).ok, 'unused ability is ready');
  markAbilityUsed(spy, 'special', 3);
  const early = checkAbilityUse(spy, 'special', 4);
  ok(!early.ok && early.reason === 'cooldown' && early.availableRound === 5, 'cooldown 2: used r3, blocked r4, back r5');
  ok(checkAbilityUse(spy, 'special', 5).ok, 'cooldown 2: ready again in round 5');
  ok(getAbilityStatus(spy, 'special', 4).roundsLeft === 1, 'status: 1 round left');

  const bureaucrat = mk('bureaucrat'); // once per game
  markAbilityUsed(bureaucrat, 'special', 2);
  ok(checkAbilityUse(bureaucrat, 'special', 50).reason === 'limit-reached', 'once per game never comes back');
  ok(getAbilityStatus(bureaucrat, 'special', 3).usesLeft === 0, 'status: no uses left');

  const ally = mk('ally'); // 3 uses
  [1, 1, 1].forEach((r) => { ok(checkAbilityUse(ally, 'special', r).ok, 'ally use allowed'); markAbilityUsed(ally, 'special', r); });
  ok(checkAbilityUse(ally, 'special', 9).reason === 'limit-reached', 'ally: 4th use refused');

  const king = mk('kingmaker');
  markAbilityUsed(king, 'special.powerBroker', 2); // cooldown 3 of its own
  ok(checkAbilityUse(king, 'special.powerBroker', 4).reason === 'cooldown', 'power broker on its own cooldown');
  ok(checkAbilityUse(king, 'special.powerBroker', 5).ok, 'power broker back after 3 rounds');
  ok(checkAbilityUse(king, 'special.endorsement', 2).ok, 'endorsement independent of power broker');
  markAbilityUsed(king, 'special.endorsement', 2);
  ok(checkAbilityUse(king, 'special.endorsement', 30).reason === 'limit-reached', 'endorsement once per game');
  ok(checkAbilityUse(king, 'special.bonusVote', 2).reason === 'unknown-ability', 'Bonus Voting Power is passive: it is not an ability any more');

  const journo = mk('journalist'); // report + media trial share one cooldown
  markAbilityUsed(journo, 'special.report', 4);
  ok(checkAbilityUse(journo, 'special.mediaTrial', 5).reason === 'cooldown', 'report and media trial share the cooldown');
  ok(checkAbilityUse(journo, 'special.mediaTrial', 6).ok, 'shared cooldown ends after 2 rounds');
}
ok(checkAbilityUse({ character: null }, 'special', 1).reason === 'no-character', 'no character, no ability');
ok(checkAbilityUse(mk('spy'), 'special.nope', 1).reason === 'unknown-ability', 'unknown option refused');
ok(resolveAbilityLimit('ghost', 'special') === null, 'unknown character has no limit');
ok(CHARACTERS.length === 12 && new Set(CHARACTERS.map((c) => c.id)).size === 12, '12 distinct characters');
ok(CHARACTERS.every((c) => c.special && c.passive && c.weakness), 'every character has special, passive and weakness');

// ---------- 6. Room setting ----------
console.log('6. room setting');
{
  await room.createRoom('Host');
  ok(room.getRoomSnapshot().settings.characters === false, 'defaults off');
  room.updateSettings({ characters: true });
  ok(room.getRoomSnapshot().settings.characters === true, 'host can switch it on');
  room.updateSettings({ characters: 'yes' });
  ok(room.getRoomSnapshot().settings.characters === true, 'non-boolean value ignored');
  room.updateSettings({ characters: false });
  ok(room.getRoomSnapshot().settings.characters === false, 'host can switch it off');
  room.leaveRoom();
}

console.log(failures ? `\nPHASE 1: ${failures} FAILED of ${checks} checks` : `\nPHASE 1: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
