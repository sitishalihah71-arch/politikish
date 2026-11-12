// Phase 6 balance harness: many all-bot Mode Watak games, win rate per character.
// "Ratio" = wins / fair share, where each seat's fair share is 1/players. 1.00 is
// an even table; the go-live target is every character inside 1.00 +/- 0.40.
//
// Run: NODE_NO_WARNINGS=1 node tools/sim/balance.mjs [options]
//   --per N            games per player count (default 400; 5 counts => 2,000 games)
//   --counts 2,3,4,5,6 which player counts to play
//   --seed S           first seed (default 100000); use different seeds per process
//   --set a.b.c=V      override a GAME_BALANCE value for this run only (repeatable),
//                      for trying a change before it goes into balance.js
//   --out file.json    write the raw tallies, so several runs can be merged
//   --merge a.json b.json ...   merge tallies instead of playing, then report
import fs from 'node:fs';
import { runGame } from './harness.mjs';
import { GAME_BALANCE } from '../../balance.js';
import { CHARACTERS, isCharacterActive } from '../../characters.js';
import { characterIdOf } from '../../abilities.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));

function setPath(path, raw) {
  const keys = path.split('.');
  let node = GAME_BALANCE;
  keys.slice(0, -1).forEach((k) => { node = node[k]; if (node === undefined) throw new Error(`no such balance path: ${path}`); });
  const last = keys[keys.length - 1];
  if (!(last in node)) throw new Error(`no such balance key: ${path}`);
  node[last] = Number.isNaN(Number(raw)) ? raw : Number(raw);
}

function report(t, title) {
  const ids = CHARACTERS.filter((c) => isCharacterActive(c.id)).map((c) => c.id); // hidden cards are never dealt
  const rows = ids.map((id) => {
    const seats = t.seats[id] || 0;
    const expected = t.expected[id] || 0;
    const wins = t.wins[id] || 0;
    const ratio = expected ? wins / expected : 0;
    // One standard error of the ratio, treating wins as Poisson.
    const se = expected ? Math.sqrt(Math.max(wins, 1)) / expected : 0;
    return { id, seats, wins, expected, ratio, se };
  }).sort((a, b) => b.ratio - a.ratio);
  console.log(`\n${title}: ${t.games} games, ${t.seatsTotal} seats`);
  console.log('character         ratio  +/-    wins  seats');
  rows.forEach((r) => {
    const flag = Math.abs(r.ratio - 1) > 0.4 ? '  <-- outside +/-40%' : Math.abs(r.ratio - 1) > 0.25 ? '  (watch)' : '';
    console.log(`${r.id.padEnd(16)} ${r.ratio.toFixed(2)}  ${r.se.toFixed(2)}  ${String(r.wins).padStart(5)}  ${String(r.seats).padStart(5)}${flag}`);
  });
  const outside = rows.filter((r) => Math.abs(r.ratio - 1) > 0.4);
  console.log(outside.length ? `OUTSIDE TARGET: ${outside.map((r) => r.id).join(', ')}` : 'ALL WITHIN +/-40%');
  return outside.length;
}

const fresh = () => ({ games: 0, seatsTotal: 0, wins: {}, expected: {}, seats: {}, stuck: 0 });

if (argv.includes('--merge')) {
  const files = argv.slice(argv.indexOf('--merge') + 1).filter((f) => f.endsWith('.json'));
  const t = fresh();
  files.forEach((f) => {
    const part = JSON.parse(fs.readFileSync(f, 'utf8'));
    t.games += part.games; t.seatsTotal += part.seatsTotal; t.stuck += part.stuck;
    ['wins', 'expected', 'seats'].forEach((k) => Object.entries(part[k]).forEach(([id, v]) => { t[k][id] = (t[k][id] || 0) + v; }));
  });
  process.exit(report(t, `merged ${files.length} runs`) ? 1 : 0);
}

all('--set').forEach((s) => { const [p, v] = s.split('='); setPath(p, v); });
const per = Number(opt('--per', 400));
const counts = opt('--counts', '2,3,4,5,6').split(',').map(Number);
const seed0 = Number(opt('--seed', 100000));
const t = fresh();
const started = Date.now();

for (const count of counts) {
  for (let i = 0; i < per; i += 1) {
    const seed = seed0 + count * 100000 + i;
    let game;
    try {
      game = await runGame({ seed, players: count, rounds: i % 2 ? 10 : 20, advancedMode: i % 5 === 0, humans: 0, settings: { characters: true } });
    } catch (e) { t.stuck += 1; console.log(`  stuck: ${e.message}`); continue; }
    t.games += 1;
    game.players.forEach((p) => {
      const cid = p.character?.id || characterIdOf(p); // the card they drew, not a copied one
      t.seatsTotal += 1;
      t.seats[cid] = (t.seats[cid] || 0) + 1;
      t.expected[cid] = (t.expected[cid] || 0) + 1 / count;
      if (p.id === game.snapshot.winnerId) t.wins[cid] = (t.wins[cid] || 0) + 1;
    });
  }
}

const out = opt('--out', null);
if (out) fs.writeFileSync(out, JSON.stringify(t));
console.log(`(${((Date.now() - started) / 1000).toFixed(0)}s${t.stuck ? `, ${t.stuck} stuck games` : ''})`);
process.exit(report(t, 'balance run') ? 1 : 0);
