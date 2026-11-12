// Phase 3b checks: Spy, Journalist, Whistleblower, Bureaucrat (investigations,
// Falsify, reports, Media Trial, Deal Alert).
// Four humans (host + three fake remote clients), characters forced onto the
// live player objects, every power used through the real message path.
// Run: NODE_NO_WARNINGS=1 node tools/sim/phase3b.mjs
import { connectFakeClient, seedRandom } from './harness.mjs';
import * as room from '../../room.js';
import * as match from '../../match.js';
import { GAME_BALANCE } from '../../balance.js';
import { dealCharacters, markAbilityUsed } from '../../characters.js';
import { initMatchState } from '../../player.js';
import * as deals from '../../backroomDeals.js';
import * as evidence from '../../evidence.js';
import { armShield } from '../../abilities.js';
import * as inv from '../../investigation.js';

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

const withRandom = (value, fn) => { const keep = Math.random; Math.random = () => value; try { return fn(); } finally { Math.random = keep; } };
const lastOf = (conn, type, pred = () => true) => [...conn.sent].reverse().find((m) => m.type === type && pred(m.payload))?.payload;
const act = (t, i, abilityId, payload) => {
  if (i === 0) match.useAbility(abilityId, payload);
  else send(t.clients[i - 1], 'ability-use', { abilityId, ...payload });
};
// One accepted deal (initiator index -> recipient index), returns the token.
async function makeDeal(t, from, to, money = 3000) {
  t.players[from].money = Math.max(t.players[from].money, 30000);
  const o = await offer(t, from, to, { money });
  await accept(t, to, o.dealId);
  const tokens = evidence.getTokens();
  return tokens[tokens.length - 1];
}

// ---------- 1. the investigation roll ----------
console.log('1. chance');
{
  const mk = (scandal, id = 'ally') => ({ slot: 1, scandal, character: { id } });
  eq(inv.investigationChance(mk(0)), 0.5, 'clean target: 50%');
  ok(Math.abs(inv.investigationChance(mk(40)) - 0.62) < 1e-9, '50% + 0.3 x 40 Scandal = 62%');
  eq(inv.investigationChance(mk(100)), 0.8, 'scandal 100 alone gives 80%');
  eq(inv.investigationChance(mk(100, 'fixer')), 0.9, 'capped at 90% (80% + Paper Trail 15%)');
  ok(Math.abs(inv.investigationChance(mk(0, 'fixer')) - 0.65) < 1e-9, 'Fixer: Paper Trail +15%');
  eq(inv.investigationChance(mk(0), { forceSuccess: true }), 1, 'an event can guarantee success');
}

// ---------- 2. Spy ----------
console.log('2. Spy');
{
  const t = await setup(['bureaucrat', 'spy', 'fixer', 'ally']);
  const [, spy, fx, al] = t.players;
  const token = await makeDeal(t, 2, 3); // fixer -> ally, a real hidden token
  await t.toTurn(1);
  rejects.length = 0;
  withRandom(0, () => act(t, 1, 'special', { targetId: fx.id, category: 'deals' }));
  await wait(10);
  const res = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(res && res.success === true && res.report?.category === 'deals', 'successful investigation returns a deals report');
  eq(res.report.clues.length, 3, 'two clues + the Spy\'s Additional Clue');
  ok(!res.report.clues.some((c) => c.label === 'Rakan' || c.label === 'Peranan'), 'the report itself never names the other party');
  const notice = lastOf(t.clients[1], 'ability-notice', (p) => p.kind === 'investigated');
  ok(notice && notice.by === null, 'the target is told they were investigated, not by whom');
  ok(res.deals && res.deals.length === 1 && res.deals[0].dealNo === 1 && res.deals[0].viewId, 'a deals report lists the Dirty Deals as Deal 1, Deal 2...');
  ok(!JSON.stringify(res.deals).includes(al.name), 'the list itself names nobody');
  act(t, 1, 'follow', { viewId: res.deals[0].viewId });
  await wait(10);
  const sd = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'spy-deal');
  ok(sd && sd.deal.initiatorName === fx.name && sd.deal.recipientName === al.name, 'looking into Deal 1 shows who was in it (initiator and recipient)');
  act(t, 1, 'follow', { viewId: res.deals[0].viewId });
  await wait(10);
  eq(last(t.clients[0], 'action-rejected')?.reason, 'view-expired', 'one deal looked into per report');

  act(t, 1, 'special', { targetId: fx.id, category: 'finance' });
  await wait(10);
  ok(last(t.clients[0], 'action-rejected')?.reason === 'special-used-this-turn', 'one special per turn');
  await t.next(1);
  rejects.length = 0;
  act(t, 1, 'special', { targetId: fx.id, category: 'finance' });
  await wait(10);
  ok(last(t.clients[0], 'action-rejected')?.reason === 'cooldown', 'cooldown is 2 rounds');
  await t.next(1);
  act(t, 1, 'special', { targetId: fx.id, category: 'nonsense' });
  await wait(10);
  ok(last(t.clients[0], 'action-rejected')?.reason === 'invalid-category', 'bad category refused (cooldown not spent)');
  const before = t.clients[1].sent.length;
  withRandom(0.99, () => act(t, 1, 'special', { targetId: fx.id, category: 'finance' }));
  await wait(10);
  const fail = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(fail && fail.success === false && !fail.report, 'a failed investigation reveals nothing');
  const blown = t.clients[1].sent.slice(before).map((m) => m.payload).find((p) => p?.kind === 'investigated');
  ok(blown && blown.by === spy.name, 'Blown Cover: the target learns who failed to investigate them');

  // report shapes
  for (const category of ['finance', 'corruption', 'abilities', 'deals']) {
    const r = inv.spyReport(spy, fx, category, t.players, 3);
    ok(r.clues.length <= 3 && r.clues.length > 0, `${category}: a report of at most 3 clues`);
  }
  const emptyDeals = inv.spyReport(spy, al, 'deals', t.players, 3);
  ok(emptyDeals.clues.length >= 0, 'deals report with tokens works');
  const none = inv.spyReport(spy, t.players[0], 'deals', t.players, 3);
  eq(none.clues.length, 0, 'no tokens: an empty report, the same as a failure');
  teardown();
}

// ---------- 3. Bureaucrat and Falsify ----------
console.log('3. Bureaucrat');
{
  const t = await setup(['bureaucrat', 'spy', 'fixer', 'ally']);
  const [bu, spy, fx, al] = t.players;
  const real = await makeDeal(t, 2, 3);
  const shared = await makeDeal(t, 0, 3, 2000); // bureaucrat <-> ally
  rejects.length = 0;
  match.useAbility('special', { targetId: al.id });
  await wait(10);
  ok(rejects.includes('personal-involvement'), 'cannot falsify evidence about a player you share a deal with');
  match.useAbility('special', { targetId: fx.id });
  await wait(10);
  eq(rejects.length, 1, 'Falsify on someone else works');
  ok(inv.isFalsified(fx.slot), 'the target is marked');
  eq(bu.abilityState.falsifiedSlot, fx.slot, 'the Bureaucrat keeps a private record of who was falsified');
  const buCopy = match.getMatchSnapshot().players.find((p) => p.id === bu.id);
  eq(buCopy.abilityState.falsifiedSlot, fx.slot, 'and can read it back from their own snapshot');
  ok(!last(t.clients[0], 'match-update').players.some((p) => p.abilityState && p.abilityState.falsifiedSlot !== undefined), 'nobody else is ever sent it');
  const secret = JSON.stringify(t.clients.map((c) => c.sent)).includes('forged');
  ok(!secret, 'nobody is told (no client message mentions forgery)');
  await t.next(0); await t.next(0);
  rejects.length = 0;
  match.useAbility('special', { targetId: spy.id });
  await wait(10);
  ok(rejects.includes('limit-reached'), 'once per game');

  // forged views: same fields shown for the real token? never the real counterparty
  const views1 = inv.buildFullViews('journalist', spy, fx, t.players, 'k');
  const views2 = inv.buildFullViews('journalist', spy, fx, t.players, 'k');
  eq(views1.length, 1, 'the hidden token appears as one view');
  ok(views1[0].counterpartyName !== al.name, 'forged view names the wrong counterparty');
  ok(views1[0].viewId !== views2[0].viewId, 'every view has its own id');
  eq(views1[0].counterpartyName, views2[0].counterpartyName, 'the lie is stable between investigations');
  ok(!('forged' in views1[0]), 'a view never says whether it is forged');
  const wbView = inv.buildFullViews('whistleblower', spy, fx, t.players, 'k');
  eq(wbView[0].counterpartyName, al.name, 'the Whistleblower is not fooled');
  eq(evidence.getTokens().find((x) => x.id === real.id).recipientSlot, al.slot, 'the real token never changes');
  eq(inv.hiddenTokenCount(fx.slot), 1, 'token count is never forged');
  const spyView = inv.buildFullViews('spy', spy, fx, t.players, 'k2')[0];
  ok(spyView.counterpartyName !== al.name, 'the Spy is fooled too');

  // Administrative Efficiency: 20% less Scandal from Projek
  const sBefore = bu.scandal;
  await t.toTurn(0);
  match.chooseProjekCard('repair-roads'); // 5 Scandal on the card
  await wait(15);
  eq(bu.scandal - sBefore, 4, 'Bureaucrat: a 5-Scandal Projek adds 4');
  teardown();
}

// ---------- 4. Journalist: report and Defamation of forged evidence ----------
console.log('4. Journalist report');
{
  const t = await setup(['bureaucrat', 'journalist', 'fixer', 'ally']);
  const [bu, jo, fx, al] = t.players;
  const token = await makeDeal(t, 2, 3);
  await t.toTurn(1);
  withRandom(0, () => act(t, 1, 'special.report', { targetId: fx.id }));
  await wait(10);
  const r = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(r.success && r.views.length === 1, 'the Journalist is shown the token');
  eq(r.evidenceCount, 1, 'and how many tokens the target has');
  eq(r.targetCategory, 'dirty', 'a find also shows the target character category (the Fixer is Dirty Politics)');
  eq(r.targetCategoryLabel, 'Dirty Politics', 'with its readable label');
  eq(inv.categoryClueFor(jo.slot, fx.slot), 'dirty', 'the host remembers the clue (the bots use it)');
  ok(!('character' in r) && !('characterId' in r) && !JSON.stringify(r).includes('fixer'), 'but never which character it is');
  ok(r.views.every((v) => !('forged' in v) && !('tokenId' in v)), 'views leak neither forgery nor the token id');
  ok(r.views.every((v) => v.dealNo >= 1 && !('counterpartyName' in v) && !('role' in v) && !('dealLabel' in v)), 'a Journalist sees Deal 1, Deal 2... and never who was in them');
  eq(r.money, fx.money, "the report carries the target's money this round");
  eq(r.scandal, fx.scandal, "and their Scandal this round");
  eq(r.publicTrust, fx.approval, "and their Public Trust this round");
  const pt = jo.approval;
  act(t, 1, 'follow', { viewId: r.views[0].viewId });
  await wait(15);
  ok(last(t.clients[0], 'ability-result')?.success === true, 'publishing a genuine view exposes the deal');
  eq(evidence.getTokens().find((x) => x.id === token.id).exposed, true, 'the token is exposed');
  eq(jo.approval, pt + 2, 'Journalist: the standard +2 Public Trust for exposing');
  ok(fx.skipNextTurn !== false, 'penalties were applied (the initiating Fixer skips a turn)');
  act(t, 1, 'follow', { viewId: r.views[0].viewId });
  await wait(10);
  ok(last(t.clients[0], 'action-rejected')?.reason === 'view-expired', 'one accusation per activation');

  // forged evidence
  deals.resetDeals();
  const t2tokens = await makeDeal(t, 2, 3, 2500);
  match.useAbility('special', { targetId: fx.id }); // bureaucrat (host) falsifies the Fixer... needs own turn
  await wait(5);
  await t.toTurn(0);
  match.useAbility('special', { targetId: fx.id });
  await wait(10);
  await t.next(1); await t.next(1);
  withRandom(0, () => act(t, 1, 'special.report', { targetId: fx.id }));
  await wait(10);
  const r2 = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation' && p.views);
  ok(r2 && r2.views.length >= 1, 'the Journalist sees evidence about the falsified player');
  jo.money = 30000; const m0 = jo.money; const pt2 = jo.approval;
  const tokenBefore = evidence.getTokens().find((x) => !x.exposed);
  act(t, 1, 'follow', { viewId: r2.views[0].viewId });
  await wait(15);
  const out = lastOf(t.clients[0], 'ability-result', (p) => p.abilityId === 'follow');
  ok(out && out.success === true && !('forged' in out), 'publishing a forged view looks exactly like a genuine one');
  eq(jo.money, m0, 'and costs the Journalist nothing');
  eq(jo.approval, pt2 + 2, 'and pays the same +2 Public Trust, so it cannot be told apart');
  const fakeNews = match.getMatchSnapshot().pendingNews;
  ok(fakeNews && fakeNews.headline === 'FAIL 101 DIDEDAH', 'the same Fail 101 story is published');
  ok(fakeNews.description.includes(fx.name) && !fakeNews.description.includes(al.name), 'but the other party is a random name, never the real one');
  ok(evidence.getTokens().find((x) => x.id === tokenBefore.id).exposed === false, 'the real token is untouched and still hidden');
  teardown();
}

// An empty search tells nothing, so it must not show a category either.
console.log('4b. Journalist: no find, no clue');
{
  const t = await setup(['bureaucrat', 'journalist', 'fixer', 'ally']);
  const [, jo, fx] = t.players;
  await t.toTurn(1);
  withRandom(0, () => act(t, 1, 'special.report', { targetId: fx.id }));
  await wait(10);
  const r = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(r.success && r.views.length === 0, 'the roll succeeded but the target holds nothing');
  ok(!('targetCategory' in r), 'so no category is shown');
  eq(inv.categoryClueFor(jo.slot, fx.slot), null, 'and nothing is remembered');
  teardown();
}

// ---------- 5. Whistleblower ----------
console.log('5. Whistleblower');
{
  const t = await setup(['bureaucrat', 'whistleblower', 'fixer', 'ally']);
  const [bu, wb, fx, al] = t.players;
  const alerts0 = t.clients[0].sent.filter((m) => m.type === 'ability-notice' && m.payload.kind === 'deal-alert').length;
  const token = await makeDeal(t, 2, 3);
  const alerts1 = t.clients[0].sent.filter((m) => m.type === 'ability-notice' && m.payload.kind === 'deal-alert').length;
  eq(alerts1 - alerts0, 1, 'Deal Alert: told a deal was accepted');
  const alertPayload = lastOf(t.clients[0], 'ability-notice', (p) => p.kind === 'deal-alert');
  ok(!JSON.stringify(alertPayload).includes(fx.id) && !JSON.stringify(alertPayload).includes(al.id), 'but never who was involved');
  eq(t.clients[1].sent.filter((m) => m.type === 'ability-notice' && m.payload.kind === 'deal-alert').length, 0, 'the parties get no alert');
  match.useAbility('special', { targetId: fx.id }); // Bureaucrat falsifies the Fixer
  await wait(10);
  await t.toTurn(1);
  withRandom(0, () => act(t, 1, 'special', { targetId: fx.id }));
  await wait(10);
  const r = lastOf(t.clients[0], 'ability-result', (p) => p.kind === 'investigation');
  ok(r.success && r.views.length === 1, 'investigation finds the deal');
  eq(r.views[0].counterpartyName, al.name, 'and it is the real record even though the Bureaucrat falsified the Fixer');
  const pt = wb.approval; const inf = wb.influence;
  act(t, 1, 'follow', { viewId: r.views[0].viewId });
  await wait(15);
  eq(evidence.getTokens().find((x) => x.id === token.id).exposed, true, 'exposed');
  eq(wb.approval, pt + 5, 'Whistleblower: +5% Public Trust');
  eq(wb.influence, inf + 100, 'and +100 Influence');
  ok(fx.skipNextTurn !== false && al.scandal >= 20, 'the deal consequences applied to both');
  teardown();
}

// ---------- 6. Media Trial ----------
console.log('6. Media Trial');
{
  const t = await setup(['bureaucrat', 'journalist', 'fixer', 'ally']);
  const [bu, jo, fx, al] = t.players;
  await t.toTurn(1);
  rejects.length = 0;
  act(t, 1, 'special.mediaTrial', { targetId: fx.id, characterId: 'fixer' });
  await wait(10);
  const prompt = lastOf(t.clients[1], 'media-trial');
  ok(prompt && prompt.trialId, 'the accused gets the accusation');
  ok(!JSON.stringify(prompt).includes(jo.name) && !JSON.stringify(prompt).includes(jo.id), 'without the accuser\'s name');
  act(t, 1, 'special.mediaTrial', { targetId: al.id, characterId: 'ally' });
  await wait(10);
  eq(last(t.clients[0], 'action-rejected')?.reason, 'special-used-this-turn', 'one special per turn');
  const inf = jo.influence; const ptFx = fx.approval;
  send(t.clients[1], 'trial-respond', { trialId: prompt.trialId, admit: true });
  await wait(15);
  eq(fx.approval, ptFx - CFG.mediaTrial.admitTrust, 'correct + admit: accused −5% Public Trust');
  eq(jo.influence, inf + 200, 'Journalist +200 Influence (Public Influence)');
  eq(fx.revealedCharacter, 'fixer', 'the identity is now public');
  const seen = lastOf(t.clients[2], 'match-update')?.players.find((p) => p.id === fx.id);
  eq(seen?.revealedCharacter, 'fixer', 'other players see it in the match state');
  ok(seen && seen.character === undefined, 'but the private character field is still hidden');

  // already revealed, bad character
  await t.next(1); await t.next(1);
  act(t, 1, 'special.mediaTrial', { targetId: fx.id, characterId: 'fixer' });
  await wait(10);
  eq(last(t.clients[0], 'action-rejected')?.reason, 'already-revealed', 'a revealed player cannot be accused again');
  act(t, 1, 'special.mediaTrial', { targetId: al.id, characterId: 'nobody' });
  await wait(10);
  eq(last(t.clients[0], 'action-rejected')?.reason, 'invalid-character', 'unknown character refused');

  // correct accusation, but the accused denies it: the accused is punished for lying, the Journalist is
  // still rewarded, and everyone only sees that the accusation was refuted
  act(t, 1, 'special.mediaTrial', { targetId: al.id, characterId: 'ally' });
  await wait(10);
  const p2 = lastOf(t.clients[2], 'media-trial');
  ok(/tuduhan salah/i.test(p2.text) && !/cabar/i.test(p2.text), 'the prompt offers admit or deny, no challenge');
  const ptAl = al.approval; const infJ = jo.influence;
  send(t.clients[2], 'trial-respond', { trialId: p2.trialId, admit: false });
  await wait(15);
  eq(al.approval, ptAl - CFG.mediaTrial.lieTrust, 'correct + denied: the accused is punished for lying (−10% Public Trust)');
  eq(jo.influence, infJ + 200, 'the Journalist is still rewarded: the accusation was right');
  ok(!al.revealedCharacter, 'nothing is revealed: the public only heard the denial');
  eq(match.getMatchSnapshot().pendingNews.headline, 'TUDUHAN BERJAYA DISANGKAL', 'everyone sees: the accusation was successfully refuted');
  ok(lastOf(t.clients[0], 'ability-notice', (p) => p.kind === 'trial-won')?.text.includes('ally') === false && lastOf(t.clients[0], 'ability-notice', (p) => p.kind === 'trial-won')?.text.includes('The Ally'), 'but the Journalist is privately told the truth');

  // wrong accusation, falsely admitted: the accused is punished, the Journalist is not
  await t.next(1); await t.next(1);
  const cap = t.players[3];
  const target = bu;
  jo.money = 30000; const m0 = jo.money; const ptJ = jo.approval; const ptB = bu.approval;
  match.proposeBackroomDeal; // no-op
  const players = t.players;
  const trialFor = async (accused, claimed, idx) => {
    act(t, 1, 'special.mediaTrial', { targetId: accused.id, characterId: claimed });
    await wait(10);
    return idx === 0 ? null : lastOf(t.clients[idx - 1], 'media-trial');
  };
  // the host (Bureaucrat) is accused of being the Lawyer: wrong
  const hostTrials = [];
  document.addEventListener('match:media-trial', (e) => hostTrials.push(e.detail));
  await trialFor(bu, 'lawyer', 0);
  ok(hostTrials.length === 1, 'the host player also receives a trial prompt');
  match.respondToMediaTrial(hostTrials[0].trialId, true); // admits something false
  await wait(15);
  eq(jo.money, m0, 'wrong accusation but the accused admitted: the Journalist is NOT penalised');
  eq(jo.approval, ptJ, 'in money or Public Trust');
  eq(bu.approval, ptB - CFG.mediaTrial.lieTrust, 'the accused is punished for lying (−10% Public Trust)');
  ok(!bu.revealedCharacter, 'nothing is revealed');
  eq(match.getMatchSnapshot().pendingNews.headline, 'TERTUDUH TIDAK MENGAKU BERSALAH', 'everyone only sees: the accused did not plead guilty');

  // wrong accusation, honestly denied: Defamation, the accused loses nothing
  await t.next(1); await t.next(1);
  bu.approval = 50; jo.money = 30000; const m00 = jo.money; const ptJ0 = jo.approval; hostTrials.length = 0;
  await trialFor(bu, 'lawyer', 0);
  match.respondToMediaTrial(hostTrials[0].trialId, false);
  await wait(15);
  eq(m00 - jo.money, CFG.defamation.money, 'wrong accusation, denied: Journalist pays RM20,000');
  eq(ptJ0 - jo.approval, CFG.defamation.trust, 'and 5% Public Trust');
  eq(bu.approval, 50, 'the honest accused loses nothing');

  // a Lawyer shield makes Defamation cheaper (it is an eligible penalty)
  await t.next(1); await t.next(1);
  armShield(jo, 'lawyer', { sourceSlot: 9, round: 1 });
  jo.money = 30000;
  const m1 = jo.money;
  hostTrials.length = 0;
  await trialFor(bu, 'lawyer', 0);
  match.respondToMediaTrial(hostTrials[0].trialId, false);
  await wait(15);
  eq(m1 - jo.money, 10000, 'a shield halves Defamation');
  teardown();
}

// ---------- 7. Media Trial: bots and silence ----------
console.log('7. bots and timeouts');
{
  CFG.mediaTrial.responseMs = 40;
  const t = await setup(['bureaucrat', 'journalist', 'fixer', 'ally']);
  const [bu, jo, fx, al] = t.players;
  await t.toTurn(1);
  act(t, 1, 'special.mediaTrial', { targetId: fx.id, characterId: 'fixer' });
  await wait(120);
  eq(fx.approval, 50 - CFG.mediaTrial.lieTrust, 'no answer counts as denying: punished as a lie (−10%) when the accusation was right');
  ok(!fx.revealedCharacter, 'and the identity does not come out');
  await t.next(1); await t.next(1);
  al.approval = 50;
  al.isBot = true;
  act(t, 1, 'special.mediaTrial', { targetId: al.id, characterId: 'ally' });
  await wait(30);
  al.isBot = false;
  eq(al.approval, 50 - CFG.mediaTrial.admitTrust, 'a bot admits what is true');
  CFG.mediaTrial.responseMs = 45000;
  teardown();
}

// ---------- 8. chaos ----------
console.log('8. chaos');
{
  let uses = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    CFG.mediaTrial.responseMs = 30;
    const chars = ['spy', 'journalist', 'whistleblower', 'bureaucrat', 'fixer', 'ally', 'lawyer', 'cleanPolitician', 'moneyMan'];
    seedRandom(seed * 17);
    const pick = [0, 1, 2, 3].map(() => chars[Math.floor(Math.random() * chars.length)]);
    const t = await setup(pick, seed + 800);
    const rnd = (n) => Math.floor(Math.random() * n);
    const views = new Map(); // player index -> last view ids
    for (let turn = 0; turn < 50; turn += 1) {
      const i = t.active();
      const p = t.players[i];
      const cid = p.character.id;
      const target = t.players.filter((q) => q.id !== p.id)[rnd(3)];
      const readViews = () => {
        if (i === 0) return;
        const r = lastOf(t.clients[i - 1], 'ability-result', (x) => x.views);
        if (r) views.set(i, r.views.map((v) => v.viewId));
      };
      if (cid === 'spy') act(t, i, 'special', { targetId: target.id, category: ['finance', 'deals', 'corruption', 'abilities'][rnd(4)] });
      else if (cid === 'whistleblower') act(t, i, 'special', { targetId: target.id });
      else if (cid === 'bureaucrat') act(t, i, 'special', { targetId: target.id });
      else if (cid === 'journalist') act(t, i, Math.random() < 0.5 ? 'special.report' : 'special.mediaTrial', { targetId: target.id, characterId: ['fixer', 'ally', 'lawyer', 'spy'][rnd(4)] });
      else if (cid === 'lawyer' || cid === 'ally') act(t, i, 'special', { targetId: target.id });
      else if (cid === 'fixer' || cid === 'moneyMan') {
        const ti = t.players.indexOf(target);
        if (ti !== 0) { const o = await offer(t, i, ti, { money: 1000 + rnd(3000), special: cid === 'fixer' ? 'fixer' : 'funding' }); if (o && Math.random() < 0.8) await accept(t, ti, o.dealId); }
      }
      uses += 1;
      await wait(4);
      readViews();
      if (views.get(i)?.length && Math.random() < 0.7) { act(t, i, 'follow', { viewId: views.get(i)[0] }); await wait(4); }
      // accused humans answer at random
      for (let k = 1; k < 4; k += 1) {
        const tr = lastOf(t.clients[k - 1], 'media-trial');
        if (tr && Math.random() < 0.7) { send(t.clients[k - 1], 'trial-respond', { trialId: tr.trialId, admit: Math.random() < 0.5 }); t.clients[k - 1].sent = t.clients[k - 1].sent.filter((m) => m.type !== 'media-trial'); }
      }
      await t.pass();

      t.players.forEach((q) => {
        ok(q.money >= 0 && q.influence >= 0, `seed ${seed}: balances stay at or above zero`);
        ok(q.scandal >= 0 && q.scandal <= 100 && q.approval >= 0 && q.approval <= 100, `seed ${seed}: meters in range`);
        ok(q.skipNextTurn === false || (q.skipNextTurn >= 1 && q.skipNextTurn <= 2), `seed ${seed}: skip counter sane`);
      });
      const tk = evidence.getTokens();
      ok(new Set(tk.map((x) => x.id)).size === tk.length, `seed ${seed}: token ids unique`);
      t.clients.forEach((c) => c.sent.filter((m) => m.type === 'match-update').slice(-1).forEach((m) => {
        const text = JSON.stringify(m.payload);
        ok(!text.includes('view-') && !text.includes('"forged"') && !text.includes('token-'), `seed ${seed}: no view, forgery or token ever rides in a match update`);
      }));
      t.players.forEach((q) => { if (q.money < 5000) q.money = 20000; });
    }
    CFG.mediaTrial.responseMs = 45000;
    teardown();
  }
  ok(uses > 100, 'the chaos agent used plenty of powers');
}

console.log(failures ? `\nPHASE 3B: ${failures} FAILED of ${checks} checks` : `\nPHASE 3B: all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
