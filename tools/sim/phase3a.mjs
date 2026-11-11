// Phase 3a checks: Fixer, Clean Politician, Money Man, Lawyer, Ally.
// Four humans (host + three fake remote clients), characters forced onto the
// live player objects, every power used through the real message path.
// Run: NODE_NO_WARNINGS=1 node tools/sim/phase3a.mjs
import { connectFakeClient, seedRandom } from './harness.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';
import { dealCharacters, markAbilityUsed } from '../../characters.js';
import { initMatchState } from '../../player.js';
import * as deals from '../../backroomDeals.js';
import * as evidence from '../../evidence.js';
import { reduceMoneyPenalty, armShield } from '../../abilities.js';

let failures = 0;
let checks = 0;
function ok(condition, message) {
  checks += 1;
  if (!condition) { failures += 1; console.log(`  FAIL: ${message}`); }
}
const eq = (a, b, message) => ok(a === b, `${message} (got ${a}, want ${b})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
GAME_BALANCE.backroomDeals.skipNoticeMs = 0;
GAME_BALANCE.bots.turnDelayMs = 0;

const rejects = [];
document.addEventListener('match:action-rejected', (e) => rejects.push(e.detail.reason));

// Slots 1..4 = indexes 0..3. Index 0 is the host; 1..3 are fake remote humans.
async function setup(chars, seed = 1) {
  seedRandom(seed);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: 4, rounds: 30, characters: true, nationalEvents: false, parliamentVoting: false });
  const clients = [connectFakeClient('peer-2', 'H2'), connectFakeClient('peer-3', 'H3'), connectFakeClient('peer-4', 'H4')];
  room.setLocalReady(true);
  if (!room.startMatch()) throw new Error('match did not start');
  match.confirmCharacterReveal();
  clients.forEach((c) => c.handlers.data({ type: 'character-ready', payload: {} }));
  const players = room.getPlayersLive().slice().sort((a, b) => a.slot - b.slot);
  chars.forEach((id, i) => { players[i].character = { id }; players[i].abilityState = {}; });
  players.forEach((p) => { p.money = 50000; p.influence = 1000; p.scandal = 0; p.approval = 50; });
  const conn = (i) => (i === 0 ? null : clients[i - 1]);
  const idx = (id) => players.findIndex((p) => p.id === id);
  const active = () => idx(match.getMatchSnapshot().activePlayerId);
  async function pass() {
    const i = active();
    players[i].money = Math.max(players[i].money, 30000);
    if (i === 0) match.chooseProjekCard('repair-roads');
    else conn(i).handlers.data({ type: 'projek-choice', payload: { cardId: 'repair-roads' } });
    await wait(15);
  }
  async function toTurn(i) { for (let n = 0; n < 12 && active() !== i; n += 1) await pass(); }
  // The player's NEXT turn: pass first, so it is never the turn we are already on.
  async function next(i) { await pass(); await toTurn(i); }
  const sentSince = (c, from) => c.sent.slice(from);
  return { players, clients, conn, idx, active, pass, toTurn, next, sentSince };
}
const last = (conn, type) => [...conn.sent].reverse().find((m) => m.type === type)?.payload;
const send = (c, type, payload = {}) => c.handlers.data({ type, payload });
const teardown = () => room.leaveRoom();

// An offer from `from` (index) to `to` (index): resolves with the dealId.
async function offer(t, from, to, { money = 3000, influence = 0, condition = { type: 'none' }, special = null } = {}) {
  if (from === 0) match.proposeBackroomDeal(t.players[to].id, money, influence, condition, special);
  else send(t.clients[from - 1], 'deal-propose', { targetId: t.players[to].id, money, influence, condition, special });
  await wait(10);
  return last(t.clients[to - 1], 'deal-offer');
}
const accept = async (t, to, dealId) => { send(t.clients[to - 1], 'deal-respond', { dealId, accept: true }); await wait(10); };

// ---------- 1. Fixer ----------
console.log('1. Fixer');
{
  const t = await setup(['fixer', 'cleanPolitician', 'ally', 'lawyer']);
  const [fixer, rec] = t.players;
  fixer.money = 20000; rec.money = 10000;
  rejects.length = 0;
  const o = await offer(t, 0, 1, { money: 3000, special: 'fixer' });
  ok(o && o.dealId, 'Fixer Deal offered');
  eq(o.canExpose, true, 'a Clean Politician target may expose');
  await accept(t, 1, o.dealId);
  eq(fixer.money, 20000 - 3000 + 300, 'Fixer: pays 3000, +10% (300) generated');
  eq(rec.money, 13000, 'recipient receives the full 3000');
  eq(fixer.scandal, 5, 'Fixer pays only +5 Corruption');
  eq(rec.scandal, 20, 'recipient pays the standard +20');
  eq(evidence.getTokens().length, 1, 'still one Evidence Token');

  // once per turn, cooldown 2
  const o2 = await offer(t, 0, 2, { money: 1000, special: 'fixer' });
  ok(!o2 || o2.dealId !== undefined, 'second attempt does not crash');
  ok(rejects.includes('special-used-this-turn'), 'a second special on the same turn is refused');
  await t.next(0);
  eq(match.getMatchSnapshot().round, 2, 'next own turn is round 2');
  rejects.length = 0;
  await offer(t, 0, 2, { money: 1000, special: 'fixer' });
  ok(rejects.includes('cooldown'), 'Fixer special on cooldown the next round');
  await t.next(0);
  rejects.length = 0;
  const o3 = await offer(t, 0, 2, { money: 1000, special: 'fixer' });
  ok(o3 && o3.dealId, 'cooldown over after 2 rounds');
  const sBefore = t.players[2].scandal;
  await accept(t, 2, o3.dealId);
  eq(t.players[2].scandal - sBefore, 20, 'second Fixer Deal: recipient +20 again');

  // a plain deal from the Fixer has no perks
  await t.toTurn(1);
  fixer.money = 20000; t.players[3].money = 10000;
  const before = { f: fixer.money, s: fixer.scandal };
  const o4 = await offer(t, 0, 3, { money: 2000 });
  await accept(t, 3, o4.dealId);
  eq(fixer.money, before.f - 2000, 'plain deal: no 10% perk');
  eq(fixer.scandal, before.s + 20, 'plain deal: standard +20 Corruption');

  // not the Fixer, or not your turn
  rejects.length = 0;
  send(t.clients[0], 'deal-propose', { targetId: fixer.id, money: 500, influence: 0, condition: { type: 'none' }, special: 'fixer' });
  await wait(10);
  ok(last(t.clients[0], 'action-rejected')?.reason === 'ability-unavailable', 'a non-Fixer cannot use the Fixer special');
  teardown();
}

// ---------- 2. Money Man ----------
console.log('2. Money Man');
{
  const t = await setup(['moneyMan', 'ally', 'lawyer', 'bureaucrat']);
  const [mm, dirty, clean, dirty2] = t.players;
  mm.money = 30000; dirty.money = 5000; clean.money = 5000; dirty2.money = 5000;
  const o = await offer(t, 0, 1, { money: 10000, special: 'funding' });
  await accept(t, 1, o.dealId);
  eq(mm.money, 30000 - 10000 + 3000, 'funding a Dirty player: +30% (3000) generated');
  eq(dirty.money, 15000, 'funded player gets the full amount');
  eq(mm.scandal, 20, 'Money Man gains Corruption');
  eq(dirty.scandal, 20, 'funded player gains Corruption');
  const mmResult = [...t.clients[0].sent].some((m) => m.type === 'deal-result' && m.payload.perk);
  ok(!mmResult, 'the funded player is never told about the perk');

  await t.next(0); await t.next(0); await t.next(0); // cooldown 3 rounds
  mm.money = 30000; clean.money = 5000;
  const o2 = await offer(t, 0, 2, { money: 10000, special: 'funding' });
  ok(o2 && o2.dealId, 'second funding after the cooldown');
  await accept(t, 2, o2.dealId);
  eq(mm.money, 20000, 'a Clean player accepting gives no bonus (silently)');
  eq(clean.money, 15000, 'but the deal itself still happens');

  // cap: 100000 offered pays the bonus on 20000 only
  const mmP = { money: 100000, influence: 0 };
  const probe = { slot: 9, id: 'x', money: 0, influence: 0, character: { id: 'moneyMan' } };
  const dirtyProbe = { slot: 8, id: 'y', character: { id: 'fixer' } };
  const { applyFundingBonus } = await import('../../abilities.js');
  const capped = applyFundingBonus(probe, dirtyProbe, mmP);
  eq(capped.money, 6000, 'bonus is worked out on at most RM20,000 (max 6,000)');
  teardown();

  // Starting Capital
  let seen = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    seedRandom(seed);
    const ps = [1, 2, 3, 4, 5].map((n) => { const p = { id: `p${n}`, slot: n }; initMatchState(p); return p; });
    dealCharacters(ps);
    ps.forEach((p) => {
      if (p.character.id === 'moneyMan') { seen += 1; eq(p.money, 20000, 'Money Man starts with +RM10,000'); } else eq(p.money, 10000, 'everyone else starts with RM10,000');
    });
  }
  ok(seen > 0, 'the Money Man was dealt in some games');
}

// ---------- 3. Clean Politician ----------
console.log('3. Clean Politician');
{
  const t = await setup(['fixer', 'cleanPolitician', 'ally', 'bureaucrat']);
  const [a, cp, other] = t.players;
  a.money = 30000; a.influence = 500;
  const o = await offer(t, 0, 1, { money: 3000 });
  eq(o.canExpose, true, 'offer shows Expose to the Clean Politician');
  const oOther = await offer(t, 0, 2, { money: 3000 });
  eq(oOther.canExpose, false, 'nobody else gets the Expose option');

  rejects.length = 0;
  send(t.clients[1], 'deal-expose-offer', { dealId: oOther.dealId });
  await wait(10);
  eq(last(t.clients[1], 'action-rejected')?.reason, 'ability-unavailable', 'a non-Clean-Politician cannot expose an offer');

  send(t.clients[0], 'deal-expose-offer', { dealId: o.dealId });
  await wait(15);
  eq(a.money, 30000 - 20000, 'offerer −RM20,000');
  eq(a.influence, 500 - 200, 'offerer −200 Influence');
  eq(a.skipNextTurn, 1, 'offerer skips 1 turn');
  eq(cp.approval, 50 + 20 + 5, 'exposer +20 (table) +5 (Public Integrity)');
  eq(cp.influence, 1000 + 100, 'exposer +100 Influence');
  eq(evidence.getTokens().length, 0, 'no token: nothing was accepted');
  const r = last(t.clients[0], 'deal-result');
  ok(r && r.exposed === true && r.accepted === false, 'exposer is told it was exposed');
  const again = last(t.clients[0], 'deal-offer');
  send(t.clients[0], 'deal-expose-offer', { dealId: o.dealId });
  await wait(10);
  eq(last(t.clients[0], 'action-rejected')?.reason, 'deal-not-found', 'the same offer cannot be exposed twice');
  ok(again !== undefined, 'offer existed');

  // Public Integrity: once per round
  a.money = 30000; a.influence = 500;
  const o2 = await offer(t, 0, 1, { money: 1000 });
  const pt = cp.approval;
  send(t.clients[0], 'deal-expose-offer', { dealId: o2.dealId });
  await wait(15);
  eq(cp.approval, Math.min(100, pt + 20), 'second exposure the same round: only the table +20');

  // Hypocrisy covered in phase 2; Clean Politician who accepts a deal
  const o3 = await offer(t, 0, 1, { money: 1000 });
  await accept(t, 1, o3.dealId);
  eq(cp.scandal, 20, 'a Clean Politician accepting still pays Corruption');
  teardown();
}

// ---------- 4. Whistleblower can't accept ----------
console.log('4. Whistleblower');
{
  const t = await setup(['fixer', 'whistleblower', 'ally', 'bureaucrat']);
  const [a, wb] = t.players;
  const o = await offer(t, 0, 1, { money: 3000 });
  await accept(t, 1, o.dealId);
  eq(evidence.getTokens().length, 0, 'accepting is treated as a rejection: no token');
  eq(wb.scandal, 0, 'no Corruption for the Whistleblower');
  eq(a.money, 50000, 'nothing was paid');
  teardown();
}

// ---------- 5. Lawyer ----------
console.log('5. Lawyer');
{
  const t = await setup(['lawyer', 'fixer', 'ally', 'bureaucrat']);
  const [lawyer, b, c] = t.players;
  rejects.length = 0;
  match.proposeBackroomDeal(b.id, 1000, 0, { type: 'none' });
  await wait(10);
  ok(rejects.includes('cannot-initiate-deal'), 'Lawyer cannot start a Backroom Deal');
  ok(!last(t.clients[0], 'deal-offer'), 'and no offer was sent');

  rejects.length = 0;
  match.useAbility('special', { targetId: b.id });
  await wait(10);
  eq(rejects.length, 0, 'Legal Defence on another player works');
  eq(b.abilityState.shields?.length, 1, 'shield armed on the target');
  ok(!!last(t.clients[0], 'ability-notice'), 'the target is told (anonymously)');
  rejects.length = 0;
  match.useAbility('special', { targetId: c.id });
  await wait(10);
  ok(rejects.includes('special-used-this-turn'), 'one special per turn');
  await t.next(0);
  rejects.length = 0;
  match.useAbility('special', { targetId: lawyer.id });
  await wait(10);
  ok(rejects.includes('cooldown'), 'Legal Defence cooldown is 3 rounds');
  await t.next(0); await t.next(0);
  rejects.length = 0;
  match.useAbility('special', { targetId: lawyer.id });
  await wait(10);
  eq(rejects.length, 0, 'usable again after 3 rounds, on yourself');

  // eligible penalty: an exposed accepted deal
  deals.resetDeals();
  b.abilityState = {}; c.abilityState = {};
  armShield(b, 'lawyer', { sourceSlot: lawyer.slot, round: 1 });
  b.money = 30000; c.money = 10000; b.influence = 1000;
  const initiatorPaid = (await (async () => {
    const proposed = deals.proposeDeal(b, c, 3000, 0, null, t.players, { round: 1 });
    deals.respondToDeal(proposed.dealId, true, t.players, { round: 1, characters: true }, () => 0.99, c.id);
    const before = b.money;
    evidence.exposeToken(evidence.getTokens()[0].id, t.players, { round: 2 });
    return before - b.money;
  })());
  eq(initiatorPaid, 10000, 'shielded initiator pays 10,000 instead of 20,000');
  eq(b.abilityState.shields.length, 0, 'the shield is spent by the penalty');
  ok(b.influence === 1000 - 200, 'Influence loss is never reduced');
  eq(b.skipNextTurn, 1, 'turn suspension stays');
  eq(evidence.getTokens()[0].exposed, true, 'the Evidence is not cancelled');

  // passive 10% and the 50% cap
  const law = { slot: 7, id: 'L', money: 50000, influence: 0, character: { id: 'lawyer' }, abilityState: {} };
  eq(reduceMoneyPenalty(law, 20000).amount, 18000, 'Legal Protection: 10% off by itself');
  armShield(law, 'lawyer', { sourceSlot: 7, round: 1 });
  armShield(law, 'ally', { sourceSlot: 8, round: 1 });
  const stacked = reduceMoneyPenalty(law, 20000, { players: [] });
  eq(stacked.amount, 10000, 'passive + Lawyer shield + Ally shield never exceed 50% off');
  eq(stacked.pct, 50, 'reported reduction is capped at 50');
  // non-monetary / zero penalties do not burn a shield
  const idle = { slot: 6, id: 'I', abilityState: {}, character: { id: 'fixer' } };
  armShield(idle, 'lawyer', { sourceSlot: 1, round: 1 });
  eq(reduceMoneyPenalty(idle, 0).amount, 0, 'zero penalty: nothing to reduce');
  eq(idle.abilityState.shields.length, 1, 'and the shield is kept');
  armShield(idle, 'lawyer', { sourceSlot: 1, round: 2 });
  eq(idle.abilityState.shields.length, 1, 'arming twice refreshes, never stacks');
  teardown();
}

// ---------- 6. Ally ----------
console.log('6. Ally');
{
  const t = await setup(['ally', 'fixer', 'lawyer', 'bureaucrat']);
  const [ally, b, c, d] = t.players;
  rejects.length = 0;
  match.useAbility('special', { targetId: ally.id });
  await wait(10);
  ok(rejects.includes('invalid-target'), 'the Ally cannot protect themselves');
  match.useAbility('special', { targetId: b.id });
  await wait(10);
  eq(b.abilityState.shields?.[0]?.kind, 'ally', 'Protective Alliance arms an Ally shield');

  // protected player is the initiator of an exposed deal
  deals.resetDeals();
  b.money = 30000; c.money = 10000; ally.influence = 500;
  const p1 = deals.proposeDeal(b, c, 3000, 0, null, t.players, { round: 1 });
  deals.respondToDeal(p1.dealId, true, t.players, { round: 1, characters: true }, () => 0.99, c.id);
  const before = b.money;
  evidence.exposeToken(evidence.getTokens()[0].id, t.players, { round: 2 });
  eq(before - b.money, 10000, 'Ally shield: the penalty is halved');
  eq(ally.influence, 600, 'Mutual Support: +100 Influence when it actually saved money');
  eq(b.skipNextTurn, 1, 'suspension is not reduced');

  // Conflict of Interest: the Ally is one of the two parties
  deals.resetDeals();
  armShield(b, 'ally', { sourceSlot: ally.slot, round: 2 });
  ally.influence = 500; b.money = 30000; b.influence = 1000;
  const p2 = deals.proposeDeal(b, ally, 3000, 0, null, t.players, { round: 2 });
  deals.respondToDeal(p2.dealId, true, t.players, { round: 2, characters: true }, () => 0.99, ally.id);
  const before2 = b.money;
  evidence.exposeToken(evidence.getTokens()[0].id, t.players, { round: 3 });
  eq(before2 - b.money, 20000, 'Conflict of Interest: no protection from a scandal the Ally is in');
  eq(b.abilityState.shields.length, 1, 'and the shield is kept for a later penalty');
  ok(ally.influence <= 500, 'no Mutual Support bonus either');

  // per-game limit: 3
  const a2 = { slot: 5, id: 'a2', character: { id: 'ally' }, abilityState: {} };
  [1, 2, 3].forEach((r) => markAbilityUsed(a2, 'special', r * 5));
  const { checkAbilityUse } = await import('../../characters.js');
  ok(checkAbilityUse(a2, 'special', 50).reason === 'limit-reached', 'Ally gets 3 uses per game');
  teardown();
}

// ---------- 7. Dedahkan is out of reach ----------
console.log('7. Dedahkan stays hard');
{
  const t = await setup(['fixer', 'lawyer', 'ally', 'bureaucrat']);
  const [a, law, , ] = t.players;
  deals.resetDeals();
  armShield(law, 'lawyer', { sourceSlot: law.slot, round: 1 });
  law.abilityState.shields.push({ kind: 'ally', pct: 50, sourceSlot: 3, round: 1 });
  a.money = 40000; law.money = 20000;
  const proposed = deals.proposeDeal(a, law, 10000, 0, { type: 'noharm' }, t.players, { round: 1, maxRounds: 30 });
  const r = deals.respondToDeal(proposed.dealId, true, t.players, { round: 1, characters: true }, () => 0.99, law.id);
  deals.handleAction({ type: 'sabotaj', actorId: law.id, targetId: a.id }, t.players);
  const money0 = law.money;
  const ex = deals.exposeContract(r.contractId, a.id, t.players, { round: 2 });
  ok(ex.ok, 'Dedahkan works');
  const fine = GAME_BALANCE.backroomDeals.exposeTargetFineMoney;
  eq(money0 - law.money, r.upfront.money + fine, 'the Lawyer pays the full Dedahkan refund and fine: no reduction at all');
  eq(law.abilityState.shields.length, 2, 'shields are untouched by Dedahkan');
  teardown();
}

// ---------- 8. chaos: random legal use of every 3a power ----------
console.log('8. chaos');
{
  let uses = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const chars = ['fixer', 'cleanPolitician', 'moneyMan', 'lawyer', 'ally', 'whistleblower', 'bureaucrat', 'populist'];
    seedRandom(seed * 31);
    const pick = [0, 1, 2, 3].map(() => chars[Math.floor(Math.random() * chars.length)]);
    const t = await setup(pick, seed + 500);
    const specialsThisTurn = new Map();
    const rnd = (n) => Math.floor(Math.random() * n);
    for (let turn = 0; turn < 60; turn += 1) {
      const i = t.active();
      const p = t.players[i];
      const others = t.players.filter((q, qi) => q.id !== p.id && qi !== 0); // the host is never offered to here
      const target = others[rnd(others.length)];
      const ti = t.players.indexOf(target);
      const cid = p.character.id;
      const roll = Math.random();
      const ask = async (from, special) => {
        const o = await offer(t, from, ti, { money: 1000 + rnd(4000), special });
        return o;
      };
      if (cid === 'lawyer' || cid === 'ally') {
        if (i === 0) match.useAbility('special', { targetId: Math.random() < 0.5 ? target.id : p.id });
        else send(t.clients[i - 1], 'ability-use', { abilityId: 'special', targetId: Math.random() < 0.5 ? target.id : p.id });
        await wait(5);
        uses += 1;
      } else if (cid === 'fixer' || cid === 'moneyMan') {
        await ask(i, roll < 0.7 ? (cid === 'fixer' ? 'fixer' : 'funding') : null);
        uses += 1;
      } else if (roll < 0.4) {
        await ask(i, null);
      }
      // random answers to whatever is waiting
      for (let k = 1; k < 4; k += 1) {
        const off = last(t.clients[k - 1], 'deal-offer');
        if (off && Math.random() < 0.7) {
          const how = Math.random();
          if (how < 0.5) send(t.clients[k - 1], 'deal-respond', { dealId: off.dealId, accept: true });
          else if (how < 0.7) send(t.clients[k - 1], 'deal-expose-offer', { dealId: off.dealId });
          else send(t.clients[k - 1], 'deal-respond', { dealId: off.dealId, accept: false });
          t.clients[k - 1].sent = t.clients[k - 1].sent.filter((m) => m.type !== 'deal-offer' || m.payload.dealId !== off.dealId);
          await wait(5);
        }
      }
      // random exposure of a random token
      const tokens = evidence.getTokens().filter((x) => !x.exposed);
      if (tokens.length && Math.random() < 0.3) evidence.exposeToken(tokens[rnd(tokens.length)].id, t.players, { round: match.getMatchSnapshot().round, exposerSlot: Math.random() < 0.5 ? target.slot : null });
      await t.pass();

      // invariants
      t.players.forEach((q) => {
        ok(q.money >= 0 && q.influence >= 0, `seed ${seed}: ${q.character.id} balance never below zero (money ${q.money}, inf ${q.influence})`);
        ok(q.scandal >= 0 && q.scandal <= 100, `seed ${seed}: Scandal in range`);
        ok(q.approval >= 0 && q.approval <= 100, `seed ${seed}: Public Trust in range`);
        ok(q.skipNextTurn === false || (q.skipNextTurn >= 1 && q.skipNextTurn <= GAME_BALANCE.shadowPolitics.maxSkipTurns), `seed ${seed}: skip counter sane`);
        const shields = q.abilityState?.shields || [];
        ok(shields.length <= 2 && new Set(shields.map((s) => s.kind)).size === shields.length, `seed ${seed}: at most one shield per kind`);
        ok(shields.every((s) => s.pct <= GAME_BALANCE.characters.shield.maxReductionPct), `seed ${seed}: shield pct bounded`);
      });
      const tk = evidence.getTokens();
      ok(new Set(tk.map((x) => x.id)).size === tk.length, `seed ${seed}: token ids unique`);
      // keep money topped up so a broke table doesn't hide behaviour
      t.players.forEach((q) => { if (q.money < 5000) q.money = 20000; });
    }
    teardown();
  }
  ok(uses > 50, 'the chaos agent used plenty of powers');
}

console.log(failures ? `\nPHASE 3A: ${failures} FAILED of ${checks} checks` : `\nPHASE 3A: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
