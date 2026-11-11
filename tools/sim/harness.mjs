// Headless match runner. Drives the REAL room.js / match.js / bots.js code:
// the host plus fake remote clients plus bots, every seat auto-played by the
// bot logic (humans are flagged isBot after joining so the host resolves
// their turns, while their fake connections still receive - and record -
// every personalised message the host sends them).
import './shim.mjs';
import crypto from 'node:crypto';
import { FakePeer } from './shim.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';

// Pace everything for speed. These are plain data in balance.js.
GAME_BALANCE.bots.turnDelayMs = 0;
GAME_BALANCE.backroomDeals.skipNoticeMs = 0;
GAME_BALANCE.parliament.voteDurationMs = 1;

export function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function connectFakeClient(peerId, name) {
  const conn = {
    peer: peerId,
    open: true,
    sent: [],
    handlers: {},
    on(event, fn) { this.handlers[event] = fn; },
    send(message) { this.sent.push(JSON.parse(JSON.stringify(message))); },
    close() { this.open = false; this.handlers.close?.(); },
  };
  FakePeer.host.emit('connection', conn);
  conn.handlers.open();
  conn.handlers.data({ type: 'join-request', payload: { name } });
  conn.handlers.data({ type: 'ready-toggle', payload: { ready: true } });
  return conn;
}

// Everything the golden fingerprint covers is public gameplay state that the
// pre-character game already had, so it stays comparable across all phases.
function fingerprintOf(players, snapshot) {
  const data = {
    round: snapshot.round,
    winnerSlot: players.find((p) => p.id === snapshot.winnerId)?.slot ?? null,
    players: players
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({
        slot: p.slot, rank: p.rank, money: p.money, influence: p.influence, scandal: p.scandal,
        approval: p.approval, betrayals: p.betrayals, stats: p.stats,
        assets: p.assets.map((a) => a.type).sort(),
        objective: p.secretObjective ? `${p.secretObjective.id}:${p.secretObjective.completed}` : null,
      })),
  };
  return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 12);
}

// options: { seed, players (2-6), rounds, advancedMode, humans, settings }
// `settings` is merged into the room settings (e.g. { characters: true }).
// Resolves with { fingerprint, players, clients, snapshot, settings }.
export async function runGame({ seed, players: count, rounds = 10, advancedMode = false, humans = 0, settings = {}, timeoutMs = 20000 }) {
  seedRandom(seed);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: count, rounds, nationalEvents: true, parliamentVoting: true, advancedMode, ...settings });

  const clients = [];
  for (let i = 0; i < Math.min(humans, count - 1); i += 1) {
    clients.push(connectFakeClient(`peer-${i + 2}`, `Human${i + 1}`));
  }
  while (room.getPlayersLive().length < count) room.addBot();

  room.setLocalReady(true);
  room.getPlayersLive().forEach((p) => { p.isBot = true; });

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener('match:updated', onUpdate);
      reject(new Error(`stuck: seed ${seed}, ${count} players, round ${match.getMatchSnapshot().round}`));
    }, timeoutMs);
    const onUpdate = (e) => {
      if (!e.detail.matchOver) return;
      clearTimeout(timer);
      document.removeEventListener('match:updated', onUpdate);
      resolve();
    };
    document.addEventListener('match:updated', onUpdate);
  });

  if (!room.startMatch()) throw new Error('match did not start');
  await finished;

  const live = room.getPlayersLive().map((p) => structuredClone(p));
  const snapshot = match.getMatchSnapshot();
  const result = {
    fingerprint: fingerprintOf(live, snapshot),
    players: live,
    clients,
    snapshot,
    settings: room.getRoomSnapshot().settings,
  };
  room.leaveRoom();
  return result;
}
