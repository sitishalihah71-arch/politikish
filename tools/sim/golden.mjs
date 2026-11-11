// Regression guard for the LIVE game: with "Mode Watak" off, a fixed set of
// seeded games must end in exactly the same state before and after every
// phase of the character expansion.
//   node tools/sim/golden.mjs --write    record tools/sim/golden.json
//   node tools/sim/golden.mjs            check against it (exit 1 on drift)
//   node tools/sim/golden.mjs --repeat   run twice, prove the sim is deterministic
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { runGame } from './harness.mjs';

const FILE = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'golden.json');
const PLAYER_COUNTS = [2, 3, 4, 5, 6];
const SEEDS_PER_COUNT = 20;

async function runAll() {
  const out = {};
  for (const players of PLAYER_COUNTS) {
    for (let i = 1; i <= SEEDS_PER_COUNT; i += 1) {
      const seed = players * 1000 + i;
      const game = await runGame({
        seed, players, rounds: i % 2 ? 10 : 20, advancedMode: i % 5 === 0, humans: Math.floor((players - 1) / 2),
      });
      out[`${players}p-seed${seed}`] = game.fingerprint;
    }
  }
  return out;
}

const mode = process.argv[2];
const first = await runAll();

if (mode === '--write') {
  fs.writeFileSync(FILE, `${JSON.stringify(first, null, 2)}\n`);
  console.log(`wrote ${Object.keys(first).length} fingerprints to tools/sim/golden.json`);
} else if (mode === '--repeat') {
  const second = await runAll();
  const diff = Object.keys(first).filter((k) => first[k] !== second[k]);
  console.log(diff.length ? `NOT deterministic: ${diff.length}/${Object.keys(first).length} differ (${diff.slice(0, 5).join(', ')})` : `deterministic: ${Object.keys(first).length}/${Object.keys(first).length} identical`);
  process.exit(diff.length ? 1 : 0);
} else {
  const golden = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const diff = Object.keys(golden).filter((k) => golden[k] !== first[k]);
  console.log(diff.length ? `DRIFT in ${diff.length}/${Object.keys(golden).length} games: ${diff.slice(0, 8).join(', ')}` : `golden OK: ${Object.keys(golden).length}/${Object.keys(golden).length} games identical`);
  process.exit(diff.length ? 1 : 0);
}
process.exit(0);
