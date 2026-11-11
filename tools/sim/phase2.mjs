// Phase 2 checks: Shadow Politics (Corruption, Public Trust, Evidence Tokens,
// the one consequence table, skip-turn counter, Public Trust uses).
// Run: NODE_NO_WARNINGS=1 node tools/sim/phase2.mjs
import { runGame, seedRandom } from './harness.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';
import { initMatchState } from '../../player.js';
import { addSkipTurns, consumeSkipTurn, addCorruption } from '../../effects.js';
import { calculatePolitikChance, getTrustChanceBonus, resolvePolitik } from '../../politics.js';
import * as deals from '../../backroomDeals.js';
import * as evidence from '../../evidence.js';

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) { failures += 1; console.log(`  FAIL: ${message}`); }
}
const eq = (a, b, message) => ok(a === b, `${message} (got ${a}, want ${b})`);

const SP = GAME_BALANCE.shadowPolitics;
const T = SP.consequences;

function mk(slot, extra = {}) {
  const p = { id: `p${slot}`, slot, name: `P${slot}`, isHost: slot === 1, isBot: true, connected: true };
  initMatchState(p);
  return Object.assign(p, extra);
}
const table = () => [mk(1), mk(2), mk(3), mk(4)];
const accept = (offerer, target, players, { money = 3000, influence = 0, condition = null, ctx = {} } = {}) => {
  const proposed = deals.proposeDeal(offerer, target, money, influence, condition, players, { round: 1, maxRounds: 10, parliamentEnabled: false });
  return deals.respondToDeal(proposed.dealId, true, players, { round: 1, characters: true, ...ctx }, () => 0.99, target.id);
};

// ---------- 1. accepting a deal ----------
console.log('1. accepted deal');
{
  deals.resetDeals();
  const [a, b, c] = table();
  const players = [a, b, c];
  a.money = 20000;
  const r = accept(a, b, players);
  ok(r.ok && r.accepted, 'deal accepted');
  eq(a.scandal, 20, 'initiator +20 Corruption');
  eq(b.scandal, 20, 'recipient +20 Corruption');
  eq(c.scandal, 0, 'bystander untouched');
  eq(b.approval, 49, 'recipient -1 Public Trust');
  eq(a.approval, 50, 'initiator Public Trust untouched');
  const tokens = evidence.getTokens();
  eq(tokens.length, 1, 'exactly one token');
  const t = tokens[0];
  ok(t.initiatorSlot === 1 && t.recipientSlot === 2, 'token points at slots');
  ok(t.dealType === 'plain' && t.value.money === 3000 && t.value.influence === 0 && t.round === 1 && t.exposed === false, 'token records type, value, round, status');
  ok(!('initiatorId' in t) && !('recipientId' in t), 'token holds no player ids');

  // a rejected / fallen-through deal leaves nothing
  const p2 = deals.proposeDeal(a, c, 1000, 0, null, players, { round: 1 });
  deals.respondToDeal(p2.dealId, false, players, { round: 1, characters: true }, () => 0.99, c.id);
  eq(evidence.getTokens().length, 1, 'rejected deal: no token');
  eq(c.scandal, 0, 'rejected deal: no Corruption');

  // setting off: nothing at all
  deals.resetDeals();
  const [x, y] = [mk(1), mk(2)];
  x.money = 20000;
  accept(x, y, [x, y], { ctx: { characters: false } });
  ok(x.scandal === 0 && y.scandal === 0 && y.approval === 50 && evidence.getTokens().length === 0, 'Mode Watak off: deals change nothing');
}

// ---------- 2. Corruption cap and Public Support ----------
console.log('2. corruption cap');
{
  deals.resetDeals();
  const [a, b] = [mk(1), mk(2)];
  a.money = 20000;
  a.scandal = 90;
  b.scandal = 99;
  accept(a, b, [a, b]);
  eq(a.scandal, 99, '90 + 20 stops at 99');
  eq(b.scandal, 99, 'already at 99 stays');
  ok(a.scandal < GAME_BALANCE.scandal.penaltyThreshold, 'a deal cannot reach the 100% penalty');
  const c = mk(3);
  c.publicSupportTurns = 2;
  eq(addCorruption(c, 20), 10, 'Public Support still halves Corruption from deals');
}

// ---------- 3. exposing an accepted deal ----------
console.log('3. exposure after acceptance');
{
  deals.resetDeals();
  const players = table();
  const [a, b, c] = players;
  a.money = 30000; a.influence = 500;
  b.money = 10000; b.influence = 300;
  accept(a, b, players, { money: 3000 });
  const token = evidence.getTokens()[0];
  const before = { a: { m: a.money, i: a.influence, s: a.scandal }, b: { m: b.money, i: b.influence, s: b.scandal }, c: c.approval };
  const r = evidence.exposeToken(token.id, players, { round: 2, exposerSlot: 3 });
  ok(r.ok, 'exposure works');
  eq(a.money, before.a.m - T.exposedAfterAccept.initiator.money, 'initiator -RM20,000');
  eq(a.influence, before.a.i - T.exposedAfterAccept.initiator.influence, 'initiator -200 Influence');
  eq(a.skipNextTurn, 1, 'initiator skips 1 turn');
  eq(b.money, before.b.m - T.exposedAfterAccept.recipient.money, 'recipient -RM2,000');
  eq(b.influence, before.b.i - T.exposedAfterAccept.recipient.influence, 'recipient -200 Influence');
  ok(b.skipNextTurn === false, 'recipient does not skip');
  eq(a.scandal, before.a.s + 20, 'being exposed: +20 Corruption (initiator)');
  eq(b.scandal, before.b.s + 20, 'being exposed: +20 Corruption (recipient)');
  eq(c.approval, before.c + SP.trustExposeSuccess, 'third-party exposer +2 Public Trust');
  eq(a.skipReason, 'deal-exposed', 'skip is announced as an exposed deal');

  // once per incident
  const snapshot = JSON.stringify(players);
  const again = evidence.exposeToken(token.id, players, { round: 2, exposerSlot: 3 });
  ok(!again.ok && again.reason === 'already-exposed', 'a token cannot be exposed twice');
  eq(JSON.stringify(players), snapshot, 'second attempt changes nothing');
  ok(evidence.getTokens()[0].exposed === true && evidence.getTokens()[0].exposedRound === 2, 'token marked exposed with the round');
  ok(!evidence.exposeToken('token-999', players).ok, 'unknown token refused');

  // floors: no one goes below zero from this table
  deals.resetDeals();
  const poor = [mk(1), mk(2)];
  poor[0].money = 20000;
  accept(poor[0], poor[1], poor, { money: 20000 });
  poor[0].influence = 50; poor[1].influence = 0; poor[1].money = 500;
  evidence.exposeToken(evidence.getTokens()[0].id, poor, { round: 3 });
  ok(poor[0].money >= 0 && poor[0].influence >= 0 && poor[1].money >= 0 && poor[1].influence >= 0, 'penalties never push anyone below zero');
  eq(poor[0].influence, 0, 'influence floors at 0');

  // the exposer being one of the two parties earns nothing
  deals.resetDeals();
  const pp = table();
  pp[0].money = 20000;
  accept(pp[0], pp[1], pp, {});
  const own = pp[1].approval;
  const r2 = evidence.exposeToken(evidence.getTokens()[0].id, pp, { round: 2, exposerSlot: 2 });
  ok(r2.ok && r2.exposerReward === 0 && pp[1].approval === own, 'a party exposing their own deal gets no Public Trust');
}

// ---------- 4. slots survive a reconnect ----------
console.log('4. slots, not ids');
{
  deals.resetDeals();
  const players = table();
  players[0].money = 20000;
  accept(players[0], players[1], players);
  players[0].id = 'brand-new-id'; // what a reconnect does
  const r = evidence.exposeToken(evidence.getTokens()[0].id, players, { round: 2 });
  ok(r.ok && r.result.initiator.playerId === 'brand-new-id', 'token still finds the player after an id change');
}

// ---------- 5. Clean Politician ----------
console.log('5. Clean Politician');
{
  deals.resetDeals();
  const players = table();
  players[1].character = { id: 'cleanPolitician' };
  players[0].money = 20000;
  accept(players[0], players[1], players);
  evidence.exposeToken(evidence.getTokens()[0].id, players, { round: 2 });
  eq(players[1].skipNextTurn, 2, 'Clean Politician recipient skips 2 turns');
  eq(players[0].skipNextTurn, 1, 'the other side still skips 1');

  deals.resetDeals();
  const p2 = table();
  p2[0].character = { id: 'cleanPolitician' };
  p2[0].money = 20000;
  accept(p2[0], p2[1], p2);
  evidence.exposeToken(evidence.getTokens()[0].id, p2, { round: 2 });
  eq(p2[0].skipNextTurn, 2, 'Clean Politician initiator skips 2 turns');
  addSkipTurns(p2[0], 5, 'deal-exposed');
  eq(p2[0].skipNextTurn, SP.maxSkipTurns, 'skip counter never exceeds the cap');
}

// ---------- 6. exposed before acceptance ----------
console.log('6. exposure before acceptance');
{
  deals.resetDeals();
  const players = table();
  const [a, b, c] = players;
  a.money = 30000; a.influence = 500; b.influence = 50;
  const pending = deals.proposeDeal(a, b, 3000, 0, null, players, { round: 1 });
  ok(!deals.exposePendingDeal(pending.dealId, c.id, players).ok, 'only the recipient can expose it');
  const r = deals.exposePendingDeal(pending.dealId, b.id, players);
  ok(r.ok, 'recipient exposes the offer');
  eq(a.money, 10000, 'initiator -RM20,000');
  eq(a.influence, 300, 'initiator -200 Influence');
  eq(a.skipNextTurn, 1, 'initiator skips 1 turn');
  eq(b.approval, 70, 'recipient +20 Public Trust');
  eq(b.influence, 150, 'recipient +100 Influence');
  eq(evidence.getTokens().length, 0, 'nothing was accepted: no token');
  eq(a.scandal + b.scandal, 0, 'no Corruption either way');
  ok(!deals.exposePendingDeal(pending.dealId, b.id, players).ok, 'the offer is gone: cannot expose twice');
  const gone = deals.respondToDeal(pending.dealId, true, players, { round: 1, characters: true }, () => 0.99, b.id);
  ok(!gone.ok, 'and cannot be accepted afterwards');

  const p2 = table();
  p2[0].character = { id: 'cleanPolitician' };
  p2[0].money = 30000; p2[0].influence = 500;
  const pending2 = deals.proposeDeal(p2[0], p2[1], 3000, 0, null, p2, { round: 1 });
  deals.exposePendingDeal(pending2.dealId, p2[1].id, p2);
  eq(p2[0].skipNextTurn, 2, 'a Clean Politician whose offer is exposed skips 2');
}

// ---------- 7. Dedahkan is a separate incident, unchanged ----------
console.log('7. Dedahkan');
{
  deals.resetDeals();
  const players = table();
  const [a, b] = players;
  a.money = 40000;
  b.money = 5000;
  const r = accept(a, b, players, { money: 10000, condition: { type: 'noharm' } });
  ok(r.ok && r.contractId, 'conditional deal made');
  eq(evidence.getTokens().length, 1, 'conditional deal also leaves one token');
  eq(evidence.getTokens()[0].contractId, r.contractId, 'token is linked to its contract');
  deals.handleAction({ type: 'sabotaj', actorId: b.id, targetId: a.id }, players); // breaches the contract
  const sA = a.scandal, sB = b.scandal;
  const ex = deals.exposeContract(r.contractId, a.id, players, { round: 2 });
  ok(ex.ok, 'Dedahkan still works');
  eq(b.scandal, Math.min(sB + GAME_BALANCE.backroomDeals.exposeTargetScandal, 99), 'Dedahkan target Scandal as before (capped at 99)');
  eq(a.scandal, Math.min(sA + GAME_BALANCE.backroomDeals.exposeOffererScandal, 99), 'Dedahkan offerer Scandal as before');
  ok(evidence.getTokens()[0].exposed, 'Dedahkan spends the deal\'s token');
  const dup = evidence.exposeToken(evidence.getTokens()[0].id, players, { round: 3 });
  ok(!dup.ok && dup.reason === 'already-exposed', 'the same deal cannot be punished again through its token');
}

// ---------- 8. Public Trust nudges Politik ----------
console.log('8. Public Trust and Politik');
{
  eq(getTrustChanceBonus(50), 0, 'trust 50: no change');
  ok(Math.abs(getTrustChanceBonus(100) - 0.05) < 1e-9, 'trust 100: +5%');
  ok(Math.abs(getTrustChanceBonus(0) + 0.05) < 1e-9, 'trust 0: -5%');
  ok(Math.abs(calculatePolitikChance('ahli', 0, false, 0) - 0.8) < 1e-9, 'default chance unchanged');
  ok(Math.abs(calculatePolitikChance('ahli', 0, false, 0.05) - 0.85) < 1e-9, 'bonus adds');
  ok(calculatePolitikChance('ahli', 300, true, 0.05) <= 0.95 + 1e-9, 'still capped at 95%');
  ok(calculatePolitikChance('deputy', 0, false, -5) === 0, 'never below zero');
  const players = table();
  const p = players[0];
  p.influence = 1000; p.approval = 100;
  const on = resolvePolitik(p, players, 0, () => 0.99, { trust: true });
  const p2 = players[1];
  p2.influence = 1000; p2.approval = 100;
  const off = resolvePolitik(p2, players, 0, () => 0.99, {});
  ok(on.ok && Math.abs(on.chance - 0.85) < 1e-9, 'Mode Watak on: trust 100 gives +5%');
  ok(off.ok && Math.abs(off.chance - 0.8) < 1e-9, 'Mode Watak off: chance exactly as before');
}

// ---------- 9. skip counter ----------
console.log('9. skip counter');
{
  const p = mk(1);
  p.skipNextTurn = true; // the old leak flag
  eq(consumeSkipTurn(p), 'bribery-leak', 'old boolean flag still means one skip');
  eq(p.skipNextTurn, false, 'and empties back to false');
  addSkipTurns(p, 2, 'deal-exposed');
  eq(consumeSkipTurn(p), 'deal-exposed', 'counter reports its reason');
  eq(p.skipNextTurn, 1, 'one left');
  consumeSkipTurn(p);
  ok(p.skipNextTurn === false && !('skipReason' in p), 'empty counter clears the reason');
}

// ---------- 10. skips happen in a real match, one per turn ----------
console.log('10. skips in a match');
{
  GAME_BALANCE.bots.turnDelayMs = 0;
  GAME_BALANCE.backroomDeals.skipNoticeMs = 0;
  seedRandom(77);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: 3, rounds: 10, characters: true });
  room.addBot();
  room.addBot();
  room.setLocalReady(true);
  room.getPlayersLive().forEach((p) => { p.isBot = true; });
  let victimId = null;
  let last = null;
  const reasons = new Set();
  let decrements = 0;
  const skippedOthers = new Set();
  const done = new Promise((resolve) => {
    const on = (e) => {
      const a = e.detail.lastAction;
      const me = e.detail.players.find((p) => p.id === victimId);
      const value = me ? (Number(me.skipNextTurn) || 0) : 0;
      if (last !== null && value < last) {
        decrements += 1;
      }
      if (a && a.type === 'skip' && a.actorId === victimId) reasons.add(a.reason);
      if (me) last = value;
      if (a && a.type === 'skip' && a.actorId !== victimId) skippedOthers.add(a.actorId);
      if (e.detail.matchOver) { document.removeEventListener('match:updated', on); resolve(); }
    };
    document.addEventListener('match:updated', on);
  });
  ok(room.startMatch(), 'match starts');
  const victim = room.getPlayersLive()[2];
  victimId = victim.id;
  addSkipTurns(victim, 2, 'deal-exposed');
  last = 2;
  await done;
  eq(decrements, 2, 'the benched player used up exactly two skips');
  ok(reasons.size === 1 && reasons.has('deal-exposed'), 'skips announced as an exposed deal');
  eq(victim.skipNextTurn, false, 'counter ends empty');
  eq(skippedOthers.size, 0, 'nobody else was skipped');
  room.leaveRoom();
}

// ---------- 11. whole matches with Mode Watak ----------
console.log('11. bot matches');
GAME_BALANCE.bots.turnDelayMs = 0;
{
  let tokenGames = 0;
  for (let n = 2; n <= 6; n += 1) {
    for (const rounds of [20, 50]) {
      for (let i = 1; i <= 3; i += 1) {
        const seed = 9000 + n * 100 + rounds + i;
        let tokens = [];
        const grab = (e) => { if (e.detail.matchOver) tokens = evidence.getTokens(); };
        document.addEventListener('match:updated', grab);
        const g = await runGame({ seed, players: n, rounds, settings: { characters: true }, timeoutMs: 60000 });
        document.removeEventListener('match:updated', grab);
        const slots = new Set(g.players.map((p) => p.slot));
        const ids = new Set(tokens.map((t) => t.id));
        ok(ids.size === tokens.length, `${n}p ${rounds}r seed ${seed}: token ids unique`);
        ok(tokens.every((t) => slots.has(t.initiatorSlot) && slots.has(t.recipientSlot) && t.initiatorSlot !== t.recipientSlot), `${n}p seed ${seed}: tokens point at two different seated players`);
        ok(tokens.every((t) => t.value.money >= 0 && t.value.influence >= 0 && t.value.money + t.value.influence > 0), `${n}p seed ${seed}: token values sane`);
        ok(tokens.every((t) => t.round >= 1 && t.round <= rounds), `${n}p seed ${seed}: token rounds in range`);
        ok(tokens.every((t) => !t.exposed || t.contractId !== null), `${n}p seed ${seed}: only a Dedahkan (a contract) has exposed a token`);
        ok(g.players.every((p) => p.scandal >= 0 && p.scandal <= 100), `${n}p seed ${seed}: Scandal in range`);
        ok(g.players.every((p) => p.approval >= 0 && p.approval <= 100), `${n}p seed ${seed}: Public Trust in range`);
        ok(g.players.every((p) => p.skipNextTurn === false || p.skipNextTurn === undefined || p.skipNextTurn > 0), `${n}p seed ${seed}: skip counter is false or positive`);
        const tokensPublic = g.clients.every((c) => c.sent.every((m) => !JSON.stringify(m.payload).includes('token-')));
        ok(tokensPublic, `${n}p seed ${seed}: no token ever reaches a client`);
        if (tokens.length) tokenGames += 1;
      }
    }
  }
  ok(tokenGames > 0, 'bots actually made deals in at least one match');

  // setting off: not a single token
  for (let i = 1; i <= 6; i += 1) {
    let tokens = null;
    const grab = (e) => { if (e.detail.matchOver) tokens = evidence.getTokens(); };
    document.addEventListener('match:updated', grab);
    await runGame({ seed: 9500 + i, players: 4, rounds: 20 });
    document.removeEventListener('match:updated', grab);
    ok(tokens && tokens.length === 0, `setting off, seed ${9500 + i}: no tokens`);
  }
}

console.log(failures ? `\nPHASE 2: ${failures} FAILED of ${checks} checks` : `\nPHASE 2: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
