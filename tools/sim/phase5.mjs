// Phase 5 checks: the six-card deck and the removal of Secret Objectives.
// Run: node tools/sim/phase5.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { runGame } from './harness.mjs';
import { GAME_BALANCE } from '../../balance.js';
import { CHARACTERS, getDeck, isCharacterActive } from '../../characters.js';
import { isCharacterId } from '../../investigation.js';

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log(`  FAIL: ${message}`);
  }
}

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const LIVE = ['cleanPolitician', 'fixer', 'journalist'];

// ---------- 1. Secret Objectives are gone ----------
console.log('1. no Secret Objectives');
ok(!fs.existsSync(path.join(ROOT, 'objectives.js')), 'objectives.js is deleted');
const sources = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') || f === 'index.html');
ok(sources.every((f) => !/secretObjective|SECRET_OBJECTIVES|objectives\.js/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))), 'no source file mentions Secret Objectives');
for (const characters of [false, true]) {
  for (let n = 2; n <= 6; n += 1) {
    const g = await runGame({ seed: 5000 + n, players: n, rounds: 10, humans: Math.min(3, n - 1), settings: { characters } });
    ok(g.players.every((p) => !('secretObjective' in p)), `${n}p characters=${characters}: no player has an objective`);
    g.clients.forEach((c) => c.sent.forEach((m) => ok(!JSON.stringify(m.payload || {}).includes('bjective'), `${n}p characters=${characters}: no objective data on the wire (${m.type})`)));
  }
}

// ---------- 2. Only the six cards are dealt ----------
console.log('2. six-card deck');
{
  const seen = {};
  for (let n = 2; n <= 6; n += 1) {
    for (let i = 1; i <= 30; i += 1) {
      const g = await runGame({ seed: 6000 + n * 100 + i, players: n, rounds: 10, humans: Math.min(3, n - 1), settings: { characters: true } });
      const ids = g.players.map((p) => p.character.id);
      ids.forEach((id) => { seen[id] = (seen[id] || 0) + 1; });
      ok(ids.length === n && ids.every((id) => LIVE.includes(id)), `${n}p seed ${i}: every seat holds one of the three live characters`);
      const count = (id) => ids.filter((x) => x === id).length;
      ok(LIVE.every((id) => count(id) <= 2), `${n}p seed ${i}: at most two of any card`);
      if (n === 6) ok(LIVE.every((id) => count(id) === 2), '6p: two each of Clean, Dirty and Investigator');
    }
  }
  ok(Object.keys(seen).every((id) => LIVE.includes(id)), 'no other character was ever dealt');
  ok(LIVE.every((id) => seen[id] > 0), 'all three live characters do get dealt');
}

// ---------- 3. Hidden characters stay in the code, but out of play ----------
console.log('3. hidden cards');
{
  const hidden = CHARACTERS.filter((c) => !LIVE.includes(c.id));
  ok(hidden.length === 9, 'the other nine characters are still defined');
  ok(hidden.every((c) => !isCharacterActive(c.id)), 'all of them are inactive');
  ok(hidden.every((c) => !isCharacterId(c.id)), 'none can be named in a Media Trial');
  ok([2, 3, 4, 5, 6].every((n) => getDeck(n).every((c) => LIVE.includes(c.id))), 'no deck at any table size contains them');
  ok(hidden.every((c) => c.special && c.passive && c.weakness), 'their abilities are intact');
  ok(GAME_BALANCE.characters.deckCopies === 2, 'two copies of each live card');
}

console.log(failures ? `\nPHASE 5: ${failures} FAILED of ${checks} checks` : `\nPHASE 5: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
