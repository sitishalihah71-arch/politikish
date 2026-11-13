// Phase 4 soak: bots play Mode Watak. Every seat is auto-played by the real bot
// code (see harness.mjs), thousands of turns across 2-6 players. Expectations:
//   - no game ever gets stuck (runGame rejects on a timeout),
//   - no bot asks for a power the host refuses (botDiagnostics.rejected is empty),
//   - every one of the 12 characters gets used by a bot somewhere,
//   - the meters, skip counters and endorsement state stay sane,
//   - nothing host-only ever rides in a client update.
// Run: NODE_NO_WARNINGS=1 node tools/sim/phase4.mjs [gamesPerCount]
import { runGame } from './harness.mjs';
import * as match from '../../match.js';
import { CHARACTERS, isCharacterActive } from '../../characters.js';
import { characterIdOf } from '../../abilities.js';

const PER_COUNT = Number(process.argv[2]) || 80;
let checks = 0;
let failures = 0;
const ok = (c, m) => { checks += 1; if (!c) { failures += 1; if (failures < 25) console.log(`  FAIL: ${m}`); } };

const wins = {}; const expected = {}; const seats = {};
const usedBy = new Set(); // characters a bot has really used (by end state)
const headlines = new Set();
let games = 0;
let turns = 0;
const onUpdate = (e) => { if (e.detail.pendingNews) headlines.add(e.detail.pendingNews.headline); };
document.addEventListener('match:updated', onUpdate);

for (const count of [2, 3, 4, 5, 6]) {
  for (let i = 1; i <= PER_COUNT; i += 1) {
    const seed = 40000 + count * 1000 + i;
    const rejectedBefore = match.botDiagnostics.rejected.length;
    const game = await runGame({
      seed, players: count, rounds: i % 2 ? 10 : 20, advancedMode: i % 5 === 0,
      humans: Math.floor((count - 1) / 2), settings: { characters: true },
    });
    games += 1;
    turns += game.snapshot.round * count;
    ok(game.snapshot.matchOver && game.snapshot.winnerId, `seed ${seed}: the game finished with a winner`);
    ok(match.botDiagnostics.rejected.length === rejectedBefore, `seed ${seed}: a bot asked for something refused: ${JSON.stringify(match.botDiagnostics.rejected.slice(rejectedBefore, rejectedBefore + 2))}`);
    game.players.forEach((p) => {
      const cid = characterIdOf(p);
      seats[cid] = (seats[cid] || 0) + 1;
      expected[cid] = (expected[cid] || 0) + 1 / count;
      if (p.id === game.snapshot.winnerId) wins[cid] = (wins[cid] || 0) + 1;
    });
    game.players.forEach((p) => {
      ok(Boolean(characterIdOf(p)), `seed ${seed}: everyone has a character`);
      ok(p.scandal >= 0 && p.scandal <= 100 && p.approval >= 0 && p.approval <= 100, `seed ${seed}: meters in range`);
      ok(p.skipNextTurn === false || (p.skipNextTurn >= 1 && p.skipNextTurn <= 2), `seed ${seed}: skip counter sane`);
      const state = p.abilityState || {};
      if (Object.keys(state).some((k) => k.startsWith('special'))) usedBy.add(characterIdOf(p));
      if (p.character?.copiedId) usedBy.add('opportunist');
    });
    game.clients.forEach((c) => c.sent.filter((m) => m.type === 'match-update').forEach((m) => {
      const text = JSON.stringify(m.payload);
      ok(!/liabilityDone|bonusVoters|exposedSlots|"forged"|view-\d|token-\d/.test(text), `seed ${seed}: no host-only state in a client update`);
    }));
  }
}
document.removeEventListener('match:updated', onUpdate);

if (headlines.has('TAWARAN RASUAH DIDEDAH')) usedBy.add('cleanPolitician');
console.log(`${games} games, ~${turns} turns, bot powers used: ${JSON.stringify(match.botDiagnostics.used)}`);
console.log(`characters seen using a power: ${[...usedBy].sort().join(', ')}`);
// Informational (first balance preview, not asserted): wins against what an even table would give.
console.log('balance preview (wins / fair share, 1.00 = even):');
Object.keys(seats).sort((a, b) => (wins[b] || 0) / expected[b] - (wins[a] || 0) / expected[a]).forEach((c) => {
  console.log(`  ${c.padEnd(16)} ${((wins[c] || 0) / expected[c]).toFixed(2)}  (${wins[c] || 0} wins in ${seats[c]} seats)`);
});
CHARACTERS.filter((c) => isCharacterActive(c.id)).forEach((c) => ok(usedBy.has(c.id), `${c.id} was never used by a bot`));
// The hidden cards are never dealt, so they never show up at a table.
CHARACTERS.filter((c) => !isCharacterActive(c.id)).forEach((c) => ok(!seats[c.id], `${c.id} is hidden: never dealt in ${games} games`));
// A headline only has to appear if the character that makes it is live.
[['FAIL 101 DIDEDAH', 'journalist'], ['SOKONGAN RASMI', 'kingmaker']].forEach(([h, who]) => ok(!isCharacterActive(who) || headlines.has(h), `no "${h}" news across the soak`));

console.log(failures ? `\nPHASE 4: ${failures} FAILED of ${checks} checks` : `\nPHASE 4: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
