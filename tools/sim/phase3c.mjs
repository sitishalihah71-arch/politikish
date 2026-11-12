// Phase 3c checks: Kingmaker, Populist, Opportunist and the four Mode Watak
// National Events (maneuvers, campaigns, copying, exposure reactions, events).
// Four humans (host + three fake remote clients), characters forced onto the
// live player objects, every power used through the real message path.
// Run: NODE_NO_WARNINGS=1 node tools/sim/phase3c.mjs
import { connectFakeClient, seedRandom } from './harness.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';
import { dealCharacters, markAbilityUsed, checkAbilityUse } from '../../characters.js';
import { initMatchState } from '../../player.js';
import * as deals from '../../backroomDeals.js';
import * as evidence from '../../evidence.js';
import { armShield, reduceMoneyPenalty as reduce } from '../../abilities.js';
import * as inv from '../../investigation.js';
import * as man from '../../maneuvers.js';
import * as ev from '../../shadowEvents.js';
import { characterIdOf } from '../../abilities.js';

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
GAME_BALANCE.characters.disabled = []; // these suites exercise the Lawyer and the Ally, which are hidden in the live deck
const CFG = GAME_BALANCE.characters;

const rejects = [];
document.addEventListener('match:action-rejected', (e) => rejects.push(e.detail.reason));

// Slots 1..4 = indexes 0..3. Index 0 is the host; 1..3 are fake remote humans.
async function setup(chars, seed = 1, { parliament = false, events = false } = {}) {
  seedRandom(seed);
  await room.createRoom('Host');
  room.updateSettings({ maxPlayers: 4, rounds: 30, characters: true, nationalEvents: events, parliamentVoting: parliament });
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

const withRandom = (value, fn) => { const keep = Math.random; Math.random = () => value; try { return fn(); } finally { Math.random = keep; } };
const lastOf = (conn, type, pred = () => true) => [...conn.sent].reverse().find((m) => m.type === type && pred(m.payload))?.payload;
const act = (t, i, abilityId, payload) => {
  if (i === 0) match.useAbility(abilityId, payload);
  else send(t.clients[i - 1], 'ability-use', { abilityId, ...payload });
};

const notices = (conn, kind) => conn.sent.filter((m) => m.type === 'ability-notice' && m.payload.kind === kind).length;
const rejectOf = (conn) => last(conn, 'action-rejected')?.reason;
const snap = () => match.getMatchSnapshot();
async function makeDeal(t, from, to, money = 3000) {
  t.players[from].money = Math.max(t.players[from].money, 30000);
  const o = await offer(t, from, to, { money });
  await accept(t, to, o.dealId);
  const tokens = evidence.getTokens();
  return tokens[tokens.length - 1];
}
// Whistleblower (index wbi) investigates `target` (certain success) and exposes the first deal found.
async function exposeVia(t, wbi, target) {
  withRandom(0, () => act(t, wbi, 'special', { targetId: target.id }));
  await wait(10);
  const r = lastOf(t.clients[wbi - 1], 'ability-result', (p) => p.kind === 'investigation' && p.views);
  if (!r || !r.views.length) return false;
  act(t, wbi, 'follow', { viewId: r.views[0].viewId });
  await wait(15);
  return true;
}
const fake = (slot, extra = {}) => ({ id: `p${slot}`, slot, influence: 1000, money: 20000, approval: 50, scandal: 0, character: { id: 'ally' }, ...extra });

// ---------- 1. Opportunist ----------
console.log('1. Opportunist');
{
  const t = await setup(['bureaucrat', 'opportunist', 'fixer', 'lawyer']);
  const [, op] = t.players;
  await t.toTurn(1);
  rejects.length = 0;
  act(t, 1, 'special', {});
  await wait(10);
  const list = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'copy-options');
  eq(JSON.stringify(list?.options), JSON.stringify(['bureaucrat', 'fixer', 'lawyer']), 'options: the others\' characters, alphabetical, no Opportunist');
  act(t, 1, 'special', { characterId: 'wizard' });
  await wait(10);
  eq(rejectOf(t.clients[0]), 'character-not-in-match', 'a character not in the match cannot be copied');
  act(t, 1, 'special', { characterId: 'opportunist' });
  await wait(10);
  eq(rejectOf(t.clients[0]), 'character-not-in-match', 'cannot copy the Opportunist card itself');
  eq(characterIdOf(op), 'opportunist', 'failed copies change nothing');

  op.money = 50000;
  act(t, 1, 'special', { characterId: 'lawyer' });
  await wait(10);
  const copy = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'copy');
  ok(copy && copy.characterId === 'lawyer', 'copy confirmed to the Opportunist');
  eq(characterIdOf(op), 'lawyer', 'now plays the Lawyer');
  eq(op.character.id, 'opportunist', 'the dealt card is unchanged (private)');
  act(t, 1, 'special', { targetId: op.id });
  await wait(10);
  eq(rejectOf(t.clients[0]), 'special-used-this-turn', 'copying used this turn\'s one special');
  send(t.clients[0], 'deal-propose', { targetId: t.players[2].id, money: 1000, influence: 0, condition: { type: 'none' }, special: null });
  await wait(10);
  eq(rejectOf(t.clients[0]), 'cannot-initiate-deal', 'copied weakness: the Lawyer\'s No Backroom Deal');
  op.abilityState.shields = [];
  const pen = reduceFor(op, 1000);
  eq(pen.reducedBy, 100, 'copied passive: Legal Protection 10%');

  await t.next(1);
  act(t, 1, 'special', { targetId: op.id });
  await wait(10);
  eq(op.abilityState.shields?.length, 1, 'the copied Legal Defence works on the next turn, on fresh limits');
  await t.next(1); await t.next(1); await t.next(1);
  act(t, 1, 'special', { characterId: 'fixer' });
  await wait(10);
  eq(characterIdOf(op), 'lawyer', 'Copycat is spent: the copy is permanent');

  // privacy: nobody else ever sees the copy
  const others = [t.clients[1], t.clients[2]].map((c) => JSON.stringify(c.sent.filter((m) => m.type === 'match-update').slice(-1)[0]?.payload || {}));
  ok(others.every((x) => !x.includes('copiedId')), 'no other player\'s update carries the copy');
  const jr = { slot: 9, money: 50000, influence: 0, approval: 50, abilityState: {}, character: { id: 'journalist' } };
  ok(inv.resolveMediaTrial(jr, op, 'lawyer', true, t.players).correct, 'Media Trial: accusing the copied character is right');
  teardown();
}
function reduceFor(player, amount) { return reduce(player, amount, { players: [], involvedSlots: [] }); }

{
  const t = await setup(['bureaucrat', 'opportunist', 'spy', 'whistleblower']);
  const [bu, op, sp, wb] = t.players;
  await t.toTurn(1);
  const money = op.money;
  act(t, 1, 'special', { characterId: 'spy' });
  await wait(10);
  eq(op.money, money, 'copying a non-Money-Man (Spy) changes no money');
  await t.next(1);
  withRandom(0, () => act(t, 1, 'special', { targetId: bu.id, category: 'finance' }));
  await wait(10);
  const rep = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(rep && rep.success && rep.investigator === 'spy', 'copied Spy investigates on its next turn (fresh cooldown)');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'opportunist', 'moneyMan', 'whistleblower']);
  const [, op, mm] = t.players;
  await t.toTurn(1);
  const money = op.money;
  act(t, 1, 'special', { characterId: 'moneyMan' });
  await wait(10);
  eq(op.money, money + GAME_BALANCE.characters.moneyManStartingCapital, 'copying the Money Man pays its Starting Capital straight away');
  const res = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'copy');
  eq(res && res.startingCapital, GAME_BALANCE.characters.moneyManStartingCapital, 'the copier is told about the Starting Capital');
  eq(mm.money, mm.money, 'the real Money Man is untouched');
  await t.next(1);
  const beforeSecond = op.money; // turn income arrived in between, so compare around the second attempt only
  act(t, 1, 'special', { characterId: 'moneyMan' });
  await wait(10);
  eq(op.money, beforeSecond, 'Copycat is once per game: no second payment');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'opportunist', 'fixer', 'whistleblower']);
  const [, op, , wb] = t.players;
  await t.toTurn(1);
  act(t, 1, 'special', { characterId: 'whistleblower' });
  await wait(10);
  const o = await offer(t, 0, 1, { money: 2000 });
  await accept(t, 1, o.dealId);
  eq(evidence.getTokens().length, 0, 'copied weakness: Clean Hands, the Opportunist cannot accept deals');
  eq(notices(t.clients[0], 'clean-hands'), 1, 'Clean Hands: the refused Whistleblower is told why (no silent rejection)');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'opportunist', 'fixer', 'ally']);
  const [bu, op, fx] = t.players;
  await t.toTurn(1);
  act(t, 1, 'special', { characterId: 'bureaucrat' });
  await wait(10);
  await t.next(1);
  act(t, 1, 'special', { targetId: fx.id });
  await wait(10);
  ok(inv.isFalsified(fx.slot), 'copied Bureaucrat falsifies');
  await t.next(1); await t.next(1);
  act(t, 1, 'special', { targetId: bu.id });
  await wait(10);
  eq(rejectOf(t.clients[0]), 'limit-reached', 'and keeps the Bureaucrat\'s once-per-game limit');
  teardown();
}

// ---------- 2. Kingmaker: Power Broker ----------
console.log('2. Power Broker');
{
  const t = await setup(['bureaucrat', 'kingmaker', 'fixer', 'ally']);
  const [, km, fx] = t.players;
  await t.toTurn(1);
  km.influence = 1000; fx.influence = 100;
  for (const amount of [249, 501, 300.5, 'abc', undefined, -300, 0]) {
    act(t, 1, 'special.powerBroker', { targetId: fx.id, amount });
    await wait(5);
    eq(rejectOf(t.clients[0]), 'invalid-amount', `amount ${amount} is invalid`);
  }
  act(t, 1, 'special.powerBroker', { targetId: km.id, amount: 300 });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'invalid-target', 'cannot broker to yourself');
  km.influence = 100;
  act(t, 1, 'special.powerBroker', { targetId: fx.id, amount: 300 });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'insufficient-influence', 'must hold the Influence');
  eq(km.influence, 100, 'a refused transfer moves nothing and pays no bonus');
  km.influence = 1000;
  act(t, 1, 'special.powerBroker', { targetId: fx.id, amount: 300 });
  await wait(10);
  eq(km.influence, 1000 - 300 + 200, 'sender: -300, +200 once');
  eq(fx.influence, 400, 'recipient: +300');
  ok(notices(t.clients[1], 'power-broker') === 1, 'recipient is notified');
  act(t, 1, 'special.powerBroker', { targetId: fx.id, amount: 300 });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'special-used-this-turn', 'one maneuver per turn');
  eq(km.influence, 900, 'no second bonus');
  await t.next(1);
  act(t, 1, 'special.powerBroker', { targetId: fx.id, amount: 250 });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'cooldown', 'cooldown 3 rounds');
  await t.next(1); await t.next(1);
  km.influence = 1000;
  act(t, 1, 'special.powerBroker', { targetId: fx.id, amount: 500 });
  await wait(10);
  eq(km.influence, 1000 - 500 + 200, 'max transfer 500 works after the cooldown');
  teardown();
}

// ---------- 3. Endorsements ----------
console.log('3. Endorsements');
{
  // exact arithmetic on plain objects
  const km = fake(1, { character: { id: 'kingmaker' } });
  const tg = fake(2, { influence: 0 });
  const players = [km, tg];
  const started = man.startEndorsement(km, tg, 2);
  ok(started.ok, 'endorsement starts');
  eq(km.influence, 700, 'Kingmaker pays 300');
  eq(tg.influence, 300, 'endorsed player receives all 300');
  eq(tg.approval, 52, '+2% Public Trust');
  eq(man.startEndorsement(km, tg, 2).reason, 'endorsement-active', 'only one endorsement at a time');
  const paid = [3, 4, 5].map((r) => man.startOfRound(r, players));
  ok(paid.every((o) => o.endorsementPaid.length === 2), 'both are paid in each of the next 3 rounds');
  eq(km.influence, 1000, 'Kingmaker +100 x3');
  eq(tg.influence, 600, 'endorsed +100 x3');
  const gone = man.startOfRound(6, players);
  ok(gone.endorsementExpired.length === 1 && gone.endorsementPaid.length === 0, 'expires at round 6, nothing paid');
  eq(man.endorsementView(players).length, 0, 'and is gone');
  man.resetManeuvers();
}
{
  const t = await setup(['bureaucrat', 'kingmaker', 'fixer', 'ally']);
  const [, km, fx] = t.players;
  await t.toTurn(1);
  km.influence = 100;
  act(t, 1, 'special.endorsement', { targetId: fx.id });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'insufficient-influence', 'needs 300 Influence');
  act(t, 1, 'special.endorsement', { targetId: km.id });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'invalid-target', 'cannot endorse yourself');
  km.influence = 1000; fx.approval = 50; fx.influence = 0;
  const round0 = snap().round;
  act(t, 1, 'special.endorsement', { targetId: fx.id });
  await wait(10);
  eq(km.influence, 700, 'paid 300');
  eq(fx.influence, 300, 'received 300');
  eq(fx.approval, 52, '+2% Public Trust');
  eq(snap().pendingNews?.headline, 'SOKONGAN RASMI', 'announced publicly');
  const pub = lastOf(t.clients[2], 'match-update')?.shadow?.endorsements?.[0];
  ok(pub && pub.kingmakerId === km.id && pub.targetId === fx.id && pub.expiresRound === round0 + 3, 'everyone sees who endorsed whom, and until when');
  act(t, 1, 'special.withdrawRenew', { mode: 'renew' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'special-used-this-turn', 'endorse and renew are separate turns');
  await t.next(1);
  act(t, 1, 'special.endorsement', { targetId: fx.id });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'limit-reached', 'Official Endorsement: once per game');
  act(t, 1, 'special.withdrawRenew', { mode: 'sideways' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'invalid-mode', 'renew or withdraw only');
  act(t, 1, 'special.withdrawRenew', { mode: 'renew' });
  await wait(10);
  eq(snap().round, round0 + 1, 'sanity: next round');
  eq(lastOf(t.clients[2], 'match-update').shadow.endorsements[0].expiresRound, round0 + 6, 'renewal adds 3 rounds');
  await t.next(1);
  act(t, 1, 'special.withdrawRenew', { mode: 'renew' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'already-renewed', 'one renewal per endorsement');
  while (snap().round < round0 + 7) await t.pass();
  eq(notices(t.clients[0], 'endorsement-pay'), 6, 'Kingmaker paid in each of the 6 rounds');
  eq(notices(t.clients[1], 'endorsement-pay'), 6, 'endorsed player too');
  eq(notices(t.clients[0], 'endorsement-expired'), 1, 'expiry told once');
  eq(lastOf(t.clients[2], 'match-update').shadow.endorsements.length, 0, 'public endorsement cleared');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'kingmaker', 'fixer', 'ally']);
  const [, km, fx] = t.players;
  await t.toTurn(1);
  km.influence = 1000;
  act(t, 1, 'special.endorsement', { targetId: fx.id });
  await wait(10);
  await t.next(1);
  fx.approval = 50;
  const kmInf = km.influence;
  act(t, 1, 'special.withdrawRenew', { mode: 'withdraw' });
  await wait(10);
  eq(fx.approval, 48, 'withdrawn: the endorsed player loses 2%');
  eq(snap().pendingNews?.headline, 'SOKONGAN DITARIK BALIK', 'announced publicly');
  eq(km.influence, kmInf, 'no refund');
  eq(lastOf(t.clients[2], 'match-update').shadow.endorsements.length, 0, 'gone from the public view');
  await t.next(1);
  act(t, 1, 'special.withdrawRenew', { mode: 'renew' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'no-endorsement', 'a withdrawn endorsement cannot be renewed');
  act(t, 1, 'special.withdrawRenew', { mode: 'withdraw' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'no-endorsement', 'nor withdrawn twice');
  const paidBefore = notices(t.clients[0], 'endorsement-pay');
  for (let i = 0; i < 8; i += 1) await t.pass();
  eq(notices(t.clients[0], 'endorsement-pay'), paidBefore, 'nothing is paid after a withdrawal');
  teardown();
}

{
  // An Opportunist who copied the Kingmaker makes two Kingmakers: each has their own endorsement
  const k1 = fake(1, { character: { id: 'kingmaker' } });
  const k2 = fake(2, { character: { id: 'opportunist', copiedId: 'kingmaker' } });
  const a = fake(3); const b = fake(4);
  const players = [k1, k2, a, b];
  ok(man.startEndorsement(k1, a, 1).ok && man.startEndorsement(k2, b, 1).ok, 'two Kingmakers can each endorse');
  eq(man.endorsementView(players).length, 2, 'both are public');
  eq(man.startEndorsement(k2, a, 1).reason, 'endorsement-active', 'but each has only one at a time');
  const out = man.reactToExposure([b], players);
  eq(out.liabilities.length, 1, 'exposing one endorsed player only hurts their own Kingmaker');
  eq(out.liabilities[0].kingmakerId, k2.id, 'the right one');
  ok(man.withdrawEndorsement(k1, players).ok, 'withdrawing one leaves the other');
  eq(man.endorsementView(players).length, 1, 'one remains');
  man.resetManeuvers();
}

// ---------- 4. Political Liability ----------
console.log('4. Political Liability');
{
  const t = await setup(['bureaucrat', 'whistleblower', 'fixer', 'kingmaker']);
  const [, wb, fx, km] = t.players;
  await t.toTurn(3);
  km.influence = 3000;
  act(t, 3, 'special.endorsement', { targetId: fx.id });
  await wait(10);
  await makeDeal(t, 0, 2);
  await t.toTurn(1);
  const a = { trust: km.approval, inf: km.influence };
  ok(await exposeVia(t, 1, fx), 'the Whistleblower exposes the endorsed player\'s deal');
  eq(a.trust - km.approval, 2, 'Kingmaker loses 2% Public Trust');
  eq(a.inf - km.influence, 500, 'and 500 Influence');
  eq(notices(t.clients[2], 'political-liability'), 1, 'and is told');
  await t.next(1); await t.next(1);
  await makeDeal(t, 0, 2);
  const b = { trust: km.approval, inf: km.influence };
  ok(await exposeVia(t, 1, fx), 'a second deal is exposed');
  eq(b.trust, km.approval, 'once per endorsement: no second trust loss');
  eq(b.inf, km.influence, 'no second Influence loss');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'whistleblower', 'fixer', 'kingmaker']);
  const [, wb, fx, km] = t.players;
  await t.toTurn(3);
  km.influence = 3000;
  act(t, 3, 'special.endorsement', { targetId: fx.id });
  await wait(10);
  await t.next(3);
  act(t, 3, 'special.withdrawRenew', { mode: 'withdraw' });
  await wait(10);
  await makeDeal(t, 0, 2);
  await t.toTurn(1);
  const a = { trust: km.approval, inf: km.influence };
  ok(await exposeVia(t, 1, fx), 'deal exposed after the withdrawal');
  eq(km.approval, a.trust, 'withdrawn endorsement: no liability (trust)');
  eq(km.influence, a.inf, 'withdrawn endorsement: no liability (Influence)');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'whistleblower', 'fixer', 'kingmaker']);
  const [, wb, fx, km] = t.players;
  await t.toTurn(3);
  km.influence = 3000;
  act(t, 3, 'special.powerBroker', { targetId: fx.id, amount: 300 });
  await wait(10);
  await makeDeal(t, 0, 2);
  await t.toTurn(1);
  const a = { trust: km.approval, inf: km.influence };
  await exposeVia(t, 1, fx);
  eq(km.approval, a.trust, 'a Power Broker recipient being exposed costs the Kingmaker nothing (trust)');
  eq(km.influence, a.inf, 'a Power Broker recipient being exposed costs the Kingmaker nothing (Influence)');
  teardown();
}
{
  const km = fake(1, { character: { id: 'kingmaker' } });
  const tg = fake(2);
  const other = fake(3);
  const players = [km, tg, other];
  man.startEndorsement(km, tg, 1);
  eq(man.reactToExposure([other], players).liabilities.length, 0, 'someone else exposed: nothing');
  man.startOfRound(5, players);
  eq(man.reactToExposure([tg], players).liabilities.length, 0, 'expired endorsement: nothing');
  man.resetManeuvers();
}

// ---------- 5. Populist ----------
console.log('5. Populist');
{
  const t = await setup(['bureaucrat', 'populist', 'fixer', 'ally']);
  const [, pop] = t.players;
  await t.toTurn(1);
  pop.money = 3000;
  act(t, 1, 'special', {});
  await wait(5);
  eq(rejectOf(t.clients[0]), 'insufficient-funds', 'needs at least RM5,000');
  eq(pop.approval, 50, 'a refused campaign changes nothing');
  pop.money = 50000; pop.influence = 0;
  act(t, 1, 'special', {});
  await wait(10);
  const r = lastOf(t.clients[0], 'ability-result', (p) => p.cost !== undefined);
  eq(r?.cost, 10000, 'cost = 20% of money');
  eq(pop.money, 40000, 'money spent');
  eq(pop.approval, 70, '+20% Public Trust');
  eq(pop.influence, 100, '+100 Influence');
  act(t, 1, 'special', {});
  await wait(5);
  eq(rejectOf(t.clients[0]), 'special-used-this-turn', 'one special per turn');
  await t.next(1);
  act(t, 1, 'special', {});
  await wait(5);
  eq(rejectOf(t.clients[0]), 'cooldown', 'cooldown 3 rounds');
  await t.next(1); await t.next(1);
  pop.money = 10000; pop.approval = 90;
  act(t, 1, 'special', {});
  await wait(10);
  eq(lastOf(t.clients[0], 'ability-result', (p) => p.cost !== undefined).cost, 5000, 'cost never below RM5,000');
  eq(pop.approval, 100, 'Public Trust capped at 100');
  eq(lastOf(t.clients[0], 'ability-result', (p) => p.cost !== undefined).trust, 10, 'and only the gained part is reported');
  teardown();
}
{
  const pop = fake(1, { character: { id: 'populist' }, approval: 98 });
  const other = fake(2, { approval: 50 });
  const out = man.startOfRound(2, [pop, other]);
  eq(pop.approval, 100, 'Public Support: +3% capped at 100');
  eq(out.populist[0].trust, 2, 'reports the real gain');
  eq(other.approval, 50, 'nobody else gets it');
  pop.approval = 40;
  man.startOfRound(3, [pop, other]);
  eq(pop.approval, 43, '+3% each round (was +5%)');
  man.resetManeuvers();
  const t = await setup(['bureaucrat', 'populist', 'fixer', 'ally']);
  while (snap().round < 4) await t.pass();
  eq(notices(t.clients[0], 'public-support'), 3, 'rounds 2, 3 and 4 each paid once (not round 1)');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'whistleblower', 'populist', 'ally']);
  const [, wb, pop, al] = t.players;
  await makeDeal(t, 2, 3);
  await t.toTurn(1);
  pop.approval = 80; al.approval = 50;
  ok(await exposeVia(t, 1, pop), 'Populist\'s deal exposed');
  eq(pop.approval, 40, 'Scandal Damage: an extra -40% Public Trust');
  eq(al.approval, 50, 'the other party only gets the ordinary consequences');
  eq(notices(t.clients[1], 'scandal-damage'), 1, 'Populist is told');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'whistleblower', 'populist', 'ally']);
  const [, wb, pop] = t.players;
  await makeDeal(t, 2, 3);
  await t.toTurn(1);
  pop.approval = 30;
  await exposeVia(t, 1, pop);
  eq(pop.approval, 0, 'Public Trust floors at 0');
  teardown();
}
{
  const t = await setup(['bureaucrat', 'cleanPolitician', 'populist', 'ally']);
  const [, cp, pop] = t.players;
  pop.approval = 70;
  const o = await offer(t, 2, 1, { money: 1000 });
  send(t.clients[0], 'deal-expose-offer', { dealId: o.dealId });
  await wait(15);
  eq(pop.approval, 30, 'exposed before acceptance also costs the Populist -40%');
  teardown();
}

// ---------- 6. Bonus Voting Power ----------
console.log('6. Bonus Voting Power');
GAME_BALANCE.parliament.voteDurationMs = 150;
async function sessionTest(arm, kmVotes) {
  const t = await setup(['bureaucrat', 'kingmaker', 'fixer', 'ally'], 5, { parliament: true });
  const [, km] = t.players;
  act(t, 1, 'special.bonusVote', {});
  await wait(5);
  const early = rejectOf(t.clients[0]);
  for (let i = 0; i < 60 && !snap().pendingVote; i += 1) await t.pass();
  ok(snap().pendingVote, 'a session opened');
  if (arm) { act(t, 1, 'special.bonusVote', {}); await wait(10); }
  if (arm) { act(t, 1, 'special.bonusVote', {}); await wait(5); }
  const again = rejectOf(t.clients[0]);
  if (kmVotes) send(t.clients[0], 'vote-cast', { choice: 'yes' });
  send(t.clients[1], 'vote-cast', { choice: 'no' });
  await wait(400);
  const news = snap().pendingNews;
  const used = km.abilityState?.['special.bonusVote'] ? true : false;
  const check = checkAbilityUse(km, 'special.bonusVote', snap().round);
  teardown();
  return { early, again, news, used, check };
}
{
  const control = await sessionTest(false, true);
  eq(control.early, 'no-vote-open', 'no session, no bonus');
  eq(control.news?.headline, 'MOTION FAILED', 'without the bonus a 1-1 tie fails');
  const armed = await sessionTest(true, true);
  eq(armed.news?.headline, 'MOTION PASSED', 'with the bonus 2 vs 1 passes');
  ok(armed.news?.description.includes('berganda'), 'the tally says one vote counted twice');
  eq(armed.again, 'already-armed', 'arming twice is refused');
  eq(armed.check.reason, 'limit-reached', 'spent: once per game');
  const silent = await sessionTest(true, false);
  eq(silent.news?.headline, 'MOTION FAILED', 'a Kingmaker who does not vote gets no extra vote');
  ok(silent.check.ok, 'and the bonus is not consumed');
}
GAME_BALANCE.parliament.voteDurationMs = 90000;

// ---------- 7. National Events ----------
console.log('7. National Events');
{
  ok(ev.isEventBoundary(3) && ev.isEventBoundary(7) && ev.isEventBoundary(11), 'draws after rounds 3, 7, 11');
  ok(!ev.isEventBoundary(1) && !ev.isEventBoundary(2) && !ev.isEventBoundary(4) && !ev.isEventBoundary(8), 'and not between');
  const ids = new Set();
  [0, 0.3, 0.55, 0.95].forEach((v) => {
    ev.resetShadowEvents();
    const r = withRandom(v, () => ev.advanceShadowEvents(4, []));
    ids.add(r.event.id);
  });
  eq(ids.size, 4, 'the deck holds four different events');
  ev.resetShadowEvents();
  withRandom(0, () => ev.advanceShadowEvents(4, []));
  ok(ev.shadowEventView() !== null, 'active during its round');
  eq(ev.advanceShadowEvents(5, []), null, 'no draw on a non-boundary round');
  eq(ev.shadowEventView(), null, 'and it is over');
  const first = withRandom(0, () => ev.advanceShadowEvents(8, [])).event.id;
  const second = withRandom(0, () => ev.advanceShadowEvents(12, [])).event.id;
  ok(first !== second, 'never the same event twice in a row');
  ev.resetShadowEvents();
}
const force = (id) => { ev.resetShadowEvents(); const idx = ev.SHADOW_EVENTS.findIndex((e) => e.id === id); withRandom((idx + 0.5) / 4, () => ev.advanceShadowEvents(4, [])); eq(ev.getActiveEvent()?.id, id, `forced ${id}`); };
{
  // Leaked Audio
  const t = await setup(['bureaucrat', 'spy', 'fixer', 'moneyMan']);
  const [, sp, fx, mm] = t.players;
  await t.toTurn(1);
  force('leaked-audio');
  withRandom(0.999, () => act(t, 1, 'special', { targetId: mm.id, category: 'finance' }));
  await wait(10);
  eq(lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation')?.success, true, 'Leaked Audio: an investigation cannot fail');
  ev.resetShadowEvents();
  await t.next(1); await t.next(1);
  withRandom(0.999, () => act(t, 1, 'special', { targetId: mm.id, category: 'finance' }));
  await wait(10);
  eq(lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation')?.success, false, 'control: without the event the same roll fails');
  teardown();
}
{
  // Anti-Corruption Commission
  const t = await setup(['bureaucrat', 'spy', 'fixer', 'moneyMan']);
  const [, sp, fx, mm] = t.players;
  await t.toTurn(1);
  withRandom(0, () => act(t, 1, 'special', { targetId: fx.id, category: 'finance' }));
  await wait(10);
  await t.next(1);
  force('anti-corruption-commission');
  withRandom(0, () => act(t, 1, 'special', { targetId: fx.id, category: 'finance' }));
  await wait(10);
  eq(lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation')?.success, true, 'Commission: a free investigation despite the cooldown');
  const cd = sp.abilityState.special;
  eq(cd.count, 1, 'and it did not restart the cooldown');
  ok(!ev.freeInvestigationAvailable(sp), 'only one free investigation per event');
  act(t, 1, 'special', { targetId: fx.id, category: 'finance' });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'special-used-this-turn', 'and it still counts as the turn\'s special');
  const mods = (p) => ev.investigationModifiers(p);
  mm.scandal = 0; fx.scandal = 70; t.players[0].scandal = 70;
  eq(mods(mm).bonus, 15, 'Money Man: Investigation Risk during the Commission');
  eq(mods(fx).bonus, 15, 'a target at 60%+ Scandal is easier');
  t.players[0].scandal = 10;
  eq(mods(t.players[0]).bonus, 0, 'a low-Scandal player is not');
  ok(Math.abs(inv.investigationChance(mm, mods(mm)) - 0.65) < 1e-9, 'Money Man chance 50% + 15%');
  ev.resetShadowEvents();
  eq(mods(mm).bonus, 0, 'no event, no extra risk');
  teardown();
}
{
  // Public Trust Collapse
  const t = await setup(['bureaucrat', 'whistleblower', 'fixer', 'ally']);
  const [bu, wb, fx, al] = t.players;
  await makeDeal(t, 2, 3);
  await t.toTurn(1);
  await exposeVia(t, 1, fx);
  [bu, wb, fx, al].forEach((p) => { p.approval = 60; });
  force('public-trust-collapse');
  ev.resetShadowEvents();
  const r = withRandom((2 + 0.5) / 4, () => ev.advanceShadowEvents(4, t.players));
  eq(r.event.id, 'public-trust-collapse', 'drawn');
  eq(fx.approval, 50, 'exposed player: -10%');
  eq(al.approval, 50, 'exposed player: -10%');
  eq(bu.approval, 60, 'unexposed: untouched');
  eq(wb.approval, 60, 'the exposer is not punished');
  teardown();
}
{
  // Parliamentary Inquiry
  const t = await setup(['bureaucrat', 'lawyer', 'fixer', 'ally']);
  const [bu, lw, fx, al] = t.players;
  await makeDeal(t, 2, 3);
  await t.toTurn(1);
  force('parliamentary-inquiry');
  rejects.length = 0;
  act(t, 1, 'special', { targetId: fx.id });
  await wait(5);
  eq(rejectOf(t.clients[0]), 'inquiry-blocked', 'Legal Defence cannot shield someone under investigation');
  act(t, 1, 'special', { targetId: bu.id });
  await wait(10);
  eq(bu.abilityState.shields?.length, 1, 'but can shield someone with no open investigation');
  await t.toTurn(0);
  match.useAbility('special', { targetId: fx.id });
  await wait(10);
  eq(rejects[rejects.length - 1], 'inquiry-blocked', 'Falsify Evidence is blocked against an involved player');
  ok(!inv.isFalsified(fx.slot), 'nothing was falsified');
  match.useAbility('special', { targetId: lw.id });
  await wait(10);
  ok(inv.isFalsified(lw.slot), 'Falsify on an uninvolved player is fine');
  ev.resetShadowEvents();
  teardown();
}
{
  // Mode Watak's own deck runs whatever the room's ordinary National Events setting says, the real turn flow draws on schedule, and the public view is shared
  const off = await setup(['bureaucrat', 'spy', 'fixer', 'ally'], 3, { events: false });
  while (snap().round < 4) await off.pass();
  ok(ev.shadowEventView() !== null, 'National Events off: the Shadow deck still draws (round 4)');
  teardown();
  const t = await setup(['bureaucrat', 'spy', 'fixer', 'ally'], 3, { events: true });
  while (snap().round < 4) await t.pass();
  ok(ev.shadowEventView() !== null, 'round 4 (after round 3): an event is active');
  ok(lastOf(t.clients[0], 'match-update')?.shadow?.event, 'and it rides in the public match update');
  while (snap().round < 5) await t.pass();
  eq(ev.shadowEventView(), null, 'round 5: over');
  while (snap().round < 8) await t.pass();
  ok(ev.shadowEventView() !== null, 'round 8: the next one');
  teardown();
}

// ---------- 8. Privacy ----------
console.log('8. Privacy');
{
  const t = await setup(['bureaucrat', 'kingmaker', 'opportunist', 'populist']);
  await t.toTurn(2);
  act(t, 2, 'special', { characterId: 'populist' });
  await wait(10);
  await t.toTurn(1);
  t.players[1].influence = 2000;
  act(t, 1, 'special.endorsement', { targetId: t.players[3].id });
  await wait(10);
  for (const c of t.clients) {
    for (const m of c.sent.filter((x) => x.type === 'match-update')) {
      const text = JSON.stringify(m.payload);
      ok(!/liabilityDone|bonusVoters|exposedSlots|forged/.test(text), 'no host-only maneuver or event state in any update');
    }
  }
  const forOpportunist = JSON.stringify(t.clients[1].sent.filter((m) => m.type === 'match-update').slice(-1)[0].payload);
  ok(forOpportunist.includes('copiedId'), 'the Opportunist sees their own copy');
  ['0', '2'].forEach((i) => {
    const text = JSON.stringify(t.clients[Number(i)].sent.filter((m) => m.type === 'match-update').slice(-1)[0].payload);
    ok(!text.includes('copiedId'), `client ${i}: no copy visible`);
  });
  teardown();
}

// ---------- 9. Chaos ----------
console.log('9. Chaos');
{
  let uses = 0;
  const seen = new Set();
  for (let seed = 1; seed <= 14; seed += 1) {
    CFG.mediaTrial.responseMs = 30;
    GAME_BALANCE.parliament.voteDurationMs = 40;
    seedRandom(seed * 31);
    const all = ['kingmaker', 'populist', 'opportunist', 'spy', 'journalist', 'whistleblower', 'bureaucrat', 'fixer', 'ally', 'lawyer', 'cleanPolitician', 'moneyMan'];
    const pool = all.slice().sort(() => Math.random() - 0.5);
    const pick = pool.slice(0, 4);
    if (seed % 3 === 0) pick[1 + (seed % 3)] = 'kingmaker';
    if (!pick.includes('populist') && seed % 2 === 0) pick[2] = 'populist';
    if (!pick.includes('opportunist') && seed % 2 === 1) pick[3] = 'opportunist';
    const t = await setup(pick, seed + 900, { parliament: true, events: true });
    const rnd = (n) => Math.floor(Math.random() * n);
    for (let turn = 0; turn < 60; turn += 1) {
      const i = t.active();
      const p = t.players[i];
      const cid = characterIdOf(p);
      const others = t.players.filter((q) => q.id !== p.id);
      const target = others[rnd(others.length)];
      seen.add(cid);
      if (cid === 'kingmaker') {
        const which = ['powerBroker', 'endorsement', 'withdrawRenew', 'bonusVote'][rnd(4)];
        act(t, i, `special.${which}`, { targetId: target.id, amount: 200 + rnd(400), mode: Math.random() < 0.5 ? 'renew' : 'withdraw' });
      } else if (cid === 'populist') act(t, i, 'special', {});
      else if (cid === 'opportunist') {
        act(t, i, 'special', {});
        await wait(4);
        const o = lastOf(i === 0 ? t.clients[0] : t.clients[i - 1], 'ability-result', (x) => x.kind === 'copy-options');
        if (o && o.options.length && Math.random() < 0.8) act(t, i, 'special', { characterId: o.options[rnd(o.options.length)] });
      } else if (cid === 'spy') act(t, i, 'special', { targetId: target.id, category: ['finance', 'deals', 'corruption', 'abilities'][rnd(4)] });
      else if (cid === 'whistleblower' || cid === 'bureaucrat' || cid === 'lawyer' || cid === 'ally') act(t, i, 'special', { targetId: target.id });
      else if (cid === 'journalist') act(t, i, Math.random() < 0.5 ? 'special.report' : 'special.mediaTrial', { targetId: target.id, characterId: all[rnd(all.length)] });
      else if (cid === 'fixer' || cid === 'moneyMan') {
        const ti = t.players.indexOf(target);
        if (ti !== 0) { const o = await offer(t, i, ti, { money: 1000 + rnd(3000), special: cid === 'fixer' ? 'fixer' : 'funding' }); if (o && Math.random() < 0.8) await accept(t, ti, o.dealId); }
      }
      uses += 1;
      await wait(4);
      const follow = i === 0 ? null : lastOf(t.clients[i - 1], 'ability-result', (x) => x.views);
      if (follow?.views?.length && Math.random() < 0.7) { act(t, i, 'follow', { viewId: follow.views[0].viewId }); await wait(4); }
      for (let k = 1; k < 4; k += 1) {
        const tr = lastOf(t.clients[k - 1], 'media-trial');
        if (tr && Math.random() < 0.7) { send(t.clients[k - 1], 'trial-respond', { trialId: tr.trialId, admit: Math.random() < 0.5 }); t.clients[k - 1].sent = t.clients[k - 1].sent.filter((m) => m.type !== 'media-trial'); }
      }
      if (snap().pendingVote) {
        t.clients.forEach((c) => send(c, 'vote-cast', { choice: Math.random() < 0.5 ? 'yes' : 'no' }));
        match.castVote('yes');
        await wait(60);
      }
      if (snap().matchOver) break;
      await t.pass();

      t.players.forEach((q) => {
        ok(q.money >= 0 && q.influence >= 0, `seed ${seed}: balances stay at or above zero`);
        ok(q.scandal >= 0 && q.scandal <= 100 && q.approval >= 0 && q.approval <= 100, `seed ${seed}: meters in range`);
        ok(q.skipNextTurn === false || (q.skipNextTurn >= 1 && q.skipNextTurn <= 2), `seed ${seed}: skip counter sane`);
        ok(Boolean(characterIdOf(q)), `seed ${seed}: everyone always has a character`);
      });
      const tk = evidence.getTokens();
      ok(new Set(tk.map((x) => x.id)).size === tk.length, `seed ${seed}: token ids unique`);
      t.clients.forEach((c) => c.sent.filter((m) => m.type === 'match-update').slice(-1).forEach((m) => {
        const text = JSON.stringify(m.payload);
        ok(!text.includes('view-') && !text.includes('"forged"') && !text.includes('token-') && !/liabilityDone|bonusVoters/.test(text), `seed ${seed}: no view, forgery, token or host-only state in an update`);
      }));
      t.players.forEach((q) => { if (q.money < 5000) q.money = 20000; if (q.influence < 600) q.influence = 1500; });
    }
    CFG.mediaTrial.responseMs = 45000;
    GAME_BALANCE.parliament.voteDurationMs = 90000;
    teardown();
  }
  ok(uses > 300, 'the chaos agent used plenty of powers');
  ok(['kingmaker', 'populist', 'opportunist'].every((c) => seen.has(c)), 'chaos covered the three new characters');
}

console.log(failures ? `\nPHASE 3C: ${failures} FAILED of ${checks} checks` : `\nPHASE 3C: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
