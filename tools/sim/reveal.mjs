// Mode Watak reveal gate: the first turn waits until every human confirmed
// their card; nobody can act and no bot moves meanwhile; confirm / timeout /
// disconnect all release it. Run: NODE_NO_WARNINGS=1 node tools/sim/reveal.mjs
import { connectFakeClient, seedRandom } from './harness.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) { failures += 1; console.log(`  FAIL: ${message}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
GAME_BALANCE.bots.turnDelayMs = 0;

// Host (slot 1, human) + one remote human + two bots.
async function setup({ characters = true, hostIsBot = false } = {}) {
  seedRandom(42);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: 4, rounds: 10, characters });
  const human = connectFakeClient('peer-2', 'Human');
  room.addBot();
  room.addBot();
  room.setLocalReady(true);
  if (hostIsBot) room.getPlayersLive().forEach((p) => { p.isBot = true; });
  ok(room.startMatch(), 'match starts');
  return human;
}
const lastUpdate = (conn) => [...conn.sent].reverse().find((m) => m.type === 'match-update')?.payload;
const snap = () => match.getMatchSnapshot();
const hostId = () => room.getRoomSnapshot().localPlayerId;

// ---- 1. gate holds the table ----
console.log('1. gate holds');
{
  const human = await setup();
  const s = snap();
  ok(s.characterReveal && s.characterReveal.waitingIds.length === 2, 'two humans are waited for');
  ok(s.characterReveal.waitingIds.includes(hostId()), 'host is waited for');
  ok(lastUpdate(human).characterReveal?.waitingIds.length === 2, 'remote human receives the gate view');
  ok(JSON.stringify(lastUpdate(human).characterReveal).includes('character') === false, 'gate view carries no character data');

  const moneyBefore = snap().players.find((p) => p.id === hostId()).money;
  match.chooseProjekCard('repair-roads');
  await wait(30);
  ok(snap().lastAction === null || snap().lastAction === undefined, 'host action ignored while gated');
  ok(snap().players.find((p) => p.id === hostId()).money === moneyBefore, 'no resources moved while gated');
  match.skipCurrentPlayer();
  ok(snap().round === 1 && snap().activePlayerId === hostId(), 'manual skip ignored while gated');

  human.handlers.data({ type: 'character-ready', payload: {} });
  ok(snap().characterReveal.waitingIds.length === 1, 'remote confirm removes one');
  human.handlers.data({ type: 'character-ready', payload: {} });
  ok(snap().characterReveal.waitingIds.length === 1, 'duplicate confirm changes nothing');
  ok(lastUpdate(human).characterReveal.waitingIds.length === 1, 'clients see the shrinking list');

  match.confirmCharacterReveal();
  ok(snap().characterReveal === null, 'last confirm releases the gate');
  ok(lastUpdate(human).characterReveal === null, 'clients are told the gate closed');
  match.chooseProjekCard('repair-roads');
  await wait(30);
  ok(snap().lastAction?.type === 'projek', 'host can act once released');
  room.leaveRoom();
}

// ---- 2. timeout releases ----
console.log('2. timeout');
{
  GAME_BALANCE.characters.revealTimeoutMs = 40;
  await setup();
  ok(snap().characterReveal !== null, 'gate open at start');
  await wait(120);
  ok(snap().characterReveal === null, 'timeout releases the table');
  room.leaveRoom();
  GAME_BALANCE.characters.revealTimeoutMs = 60000;
}

// ---- 3. leaving releases ----
console.log('3. disconnect');
{
  const human = await setup();
  match.confirmCharacterReveal();
  ok(snap().characterReveal?.waitingIds.length === 1, 'still waiting for the remote human');
  human.close();
  await wait(30);
  ok(snap().characterReveal === null, 'a human who left no longer holds the table');
  room.leaveRoom();
}

// ---- 4. nothing changes when it should not exist ----
console.log('4. no gate');
{
  await setup({ characters: false });
  ok(snap().characterReveal === null, 'setting off: no gate');
  room.leaveRoom();
}

// ---- 5. a match of only bots never gates ----
console.log('5. bots only');
{
  seedRandom(7);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: 3, rounds: 10, characters: true });
  room.addBot();
  room.addBot();
  room.setLocalReady(true);
  room.getPlayersLive().forEach((p) => { p.isBot = true; });
  ok(room.startMatch(), 'match starts');
  ok(snap().characterReveal === null, 'no humans, no gate');
  room.leaveRoom();
}

console.log(failures ? `\nREVEAL: ${failures} FAILED of ${checks} checks` : `\nREVEAL: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
