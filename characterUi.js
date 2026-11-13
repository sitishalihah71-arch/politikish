// Mode Watak (Character Expansion), phase 5: everything the player sees and
// presses for their character's powers. ui.js owns the screens; this module
// owns the "Kuasa" list in the character panel, the little dialogs each power
// needs (who? how much? which character?), the reports and notices that come
// back from the host, the Media Trial prompt, and the public strip (National
// Event, endorsements). No game rule lives here: every button just sends the
// request through match.js and shows what the host answers.
//
// Privacy: this only ever draws what the host sent to THIS player (their own
// results and notices) plus the public `shadow` state and `revealedCharacter`.

import { $, bus, formatMoney } from './utils.js';
import * as match from './match.js';
import * as sound from './sound.js';
import { renderAvatarSVG } from './avatar.js';
import { GAME_BALANCE } from './balance.js';
import { activeCharacters, getCharacter, getAbilityStatus } from './characters.js';
import { SPY_CATEGORIES } from './investigation.js';
import { buildCharacterCard } from './characterCard.js';

const kcfg = GAME_BALANCE.characters.kingmaker;
const pcfg = GAME_BALANCE.characters.populist;
const icfg = GAME_BALANCE.characters.investigation;
const mcfg = GAME_BALANCE.characters.mediaTrial;
const dcfg = GAME_BALANCE.characters.defamation;

const CATEGORY_NAMES = {
  finance: 'Kewangan',
  deals: 'Deal politik',
  corruption: 'Tahap rasuah',
  abilities: 'Penggunaan kuasa',
};
const CATEGORY_HINTS = {
  finance: 'Anggaran duit, Influence, pangkat',
  deals: 'Rakan, jenis dan nilai deal tersembunyi',
  corruption: 'Skandal, kepercayaan awam, rekod bukti',
  abilities: 'Bila kali terakhir guna kuasa',
};

let hooks = { showToast: () => {}, pushFeed: () => {}, openDeal: () => {} };
let trialTimer = null;
let journal = []; // newest first: { round, title, lines }
let categoryClues = {}; // targetId -> { category, label }: what an Investigative Report showed me

const snap = () => match.getMatchSnapshot();
const localOf = (s) => s.players.find((p) => p.id === s.localPlayerId) || null;
const nameOf = (id) => snap().players.find((p) => p.id === id)?.name || 'seorang pemain';
const effectiveId = (p) => p?.character?.copiedId || p?.character?.id || null;
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------- the one dialog every power uses ----------

function openPower(title, kicker, bodyNode) {
  $('#power-title').textContent = title;
  $('#power-kicker').textContent = kicker || 'Kuasa Watak';
  const body = $('#power-body');
  body.innerHTML = '';
  body.appendChild(bodyNode);
  $('#power-modal').hidden = false;
}

function closePower() {
  $('#power-modal').hidden = true;
  $('#power-body').innerHTML = '';
}

function playerRow(player, label, onPick, { sub = '', disabled = false, mark = false } = {}) {
  const btn = el('button', `target-picker-item${disabled ? ' is-disabled' : ''}${mark ? ' is-mark' : ''}`);
  btn.type = 'button';
  btn.disabled = disabled;
  const avatar = el('div', 'lobby-player-avatar');
  avatar.innerHTML = renderAvatarSVG(player.avatar, 36);
  btn.appendChild(avatar);
  const text = el('span', 'power-choice-text');
  text.appendChild(el('b', '', label || player.name));
  if (sub) text.appendChild(el('small', 'power-sub', sub));
  btn.appendChild(text);
  btn.addEventListener('click', () => { sound.playClick(); onPick(player); });
  return btn;
}

function choiceRow(label, hint, onPick) {
  const btn = el('button', 'target-picker-item power-choice');
  btn.type = 'button';
  const text = el('span', 'power-choice-text');
  text.appendChild(el('b', '', label));
  if (hint) text.appendChild(el('small', '', hint));
  btn.appendChild(text);
  btn.addEventListener('click', () => { sound.playClick(); onPick(); });
  return btn;
}

function listOf(...children) {
  const box = el('div', 'target-picker-list');
  children.flat().filter(Boolean).forEach((c) => box.appendChild(c));
  return box;
}

function note(text) {
  return el('p', 'setting-note power-note', text);
}

// Who? (every power that needs a player). `describe(player)` may add a sub-line,
// disable or mark a row.
function pickPlayer({ title, kicker, intro, includeSelf = false, describe = () => ({}), onPick }) {
  const s = snap();
  const me = localOf(s);
  const candidates = s.players.filter((p) => p.connected && (includeSelf || p.id !== me.id));
  const box = el('div');
  if (intro) box.appendChild(note(intro));
  box.appendChild(listOf(candidates.map((p) => playerRow(p, p.id === me.id ? `${p.name} (anda)` : p.name, (picked) => onPick(picked), describe(p)))));
  openPower(title, kicker, box);
}

// What the investigation roll is for this target (50% + 30% of Scandal, capped). Event bonuses and
// the Fixer's Paper Trail are not shown: this is the player-facing estimate.
const findChance = (target) => Math.round(Math.min(icfg.baseChance + icfg.scandalWeight * (target.scandal || 0), icfg.maxChance) * 10) / 10;
const scandalLine = (p) => `Skandal ${p.scandal}%`;

const send = (abilityId, params = {}) => {
  closePower();
  match.useAbility(abilityId, params);
};

// ---------- starting a power ----------

const FLOWS = {
  // Fixer / Money Man: the ordinary deal screens, with the special switched on.
  fixer: () => hooks.openDeal('fixer'),
  moneyMan: (abilityId, targetId) => hooks.openDeal('funding', targetId),

  spy: () => pickPlayer({
    title: 'Siasatan Rahsia', kicker: 'Perisik', intro: 'Siapa yang mahu disiasat? Sasaran tahu dia disiasat, tetapi bukan oleh siapa (kecuali penyamaran anda terbongkar).',
    describe: (p) => ({ sub: `${scandalLine(p)} · Risiko terbongkar ${Math.round((100 - findChance(p)) * 10) / 10}%` }),
    onPick: (target) => {
      const box = el('div');
      box.appendChild(note(`Siasat ${target.name} tentang: (peluang berjaya ${findChance(target)}% = ${icfg.baseChance}% + ${icfg.scandalWeight * 100}% daripada Skandal; selebihnya penyamaran terbongkar)`));
      box.appendChild(listOf(SPY_CATEGORIES.map((category) => choiceRow(CATEGORY_NAMES[category], CATEGORY_HINTS[category], () => send('special', { targetId: target.id, category })))));
      openPower('Pilih kategori', 'Perisik', box);
    },
  }),

  whistleblower: () => pickPlayer({
    title: 'Pendedahan Awam', kicker: 'Pembocor Rahsia', intro: 'Siasat seorang pemain. Jika dia ada deal yang sudah diterima, anda boleh mendedahkannya. Bukti palsu tidak boleh menipu anda.',
    describe: (p) => ({ sub: `${scandalLine(p)} · Peluang bukti ${findChance(p)}%` }),
    onPick: (target) => send('special', { targetId: target.id }),
  }),

  journalist: (abilityId) => {
    if (abilityId === 'special.report') {
      pickPlayer({
        title: 'Laporan Penyiasatan', kicker: 'Wartawan',
        intro: `Sistem melempar dadu: peluang = ${icfg.baseChance}% + ${icfg.scandalWeight * 100}% daripada Skandal sasaran (maksimum ${icfg.maxChance}%). Jika ditemui, anda boleh menerbitkan satu Dirty Deal.`,
        describe: (p) => ({ sub: `${scandalLine(p)} · Peluang bukti ${findChance(p)}%${categoryClues[p.id] ? ` · Petunjuk: ${categoryClues[p.id].label}` : ''}` }),
        onPick: (target) => send('special.report', { targetId: target.id }),
      });
      return;
    }
    pickPlayer({
      title: 'Perbicaraan Media', kicker: 'Wartawan',
      intro: `Tuduh seorang pemain sebagai watak tertentu. Dia menjawab "Betul, diakui" atau "Tuduhan salah" dan sistem menyemak kebenarannya. Tuduhan yang salah dan dinafikan: Defamation (−${formatMoney(dcfg.money)}, −${dcfg.trust}% Public Trust).`,
      describe: (p) => (p.revealedCharacter
        ? { sub: 'Watak sudah didedahkan', disabled: true }
        : { sub: categoryClues[p.id] ? `Kategori diketahui: ${categoryClues[p.id].label}` : 'Kategori tidak diketahui', mark: Boolean(categoryClues[p.id]) }),
      onPick: (target) => {
        const box = el('div');
        const me = localOf(snap());
        const clue = categoryClues[target.id];
        box.appendChild(note(clue
          ? `Siapakah ${target.name}? Laporan anda menunjukkan kategorinya: ${clue.label}.`
          : `Siapakah ${target.name}? Tiada petunjuk lagi. Terbitkan Laporan Penyiasatan dahulu untuk mengecilkan pilihan, kerana tekaan salah dikenakan Defamation.`));
        const unique = (GAME_BALANCE.characters.deckCopies || 1) <= 1; // with two copies, another player can hold your own card
        const names = activeCharacters().filter((c) => (!unique || c.id !== effectiveId(me)) && (!clue || c.category === clue.category));
        box.appendChild(listOf(names.map((c) => choiceRow(c.name, CATEGORY_LABELS_BY_ID[c.category], () => send('special.mediaTrial', { targetId: target.id, characterId: c.id })))));
        openPower('Pilih watak', 'Wartawan', box);
      },
    });
  },

  bureaucrat: () => {
    const me = localOf(snap());
    const done = me.abilityState?.falsifiedSlot;
    pickPlayer({
      title: 'Palsukan Bukti', kicker: 'Birokrat',
      intro: done !== undefined && done !== null
        ? 'Anda sudah memalsukan bukti seorang pemain (ditanda). Pemain lain tidak boleh dipilih lagi.'
        : 'Sekali sepanjang game. Perisik dan Wartawan akan nampak bukti palsu tentang pemain ini. Rekod sebenar tidak berubah.',
      describe: (p) => {
        const marked = done !== undefined && done !== null && p.slot === done;
        const locked = done !== undefined && done !== null;
        return { sub: marked ? 'Bukti dipalsukan' : '', mark: marked, disabled: locked && !marked };
      },
      onPick: (target) => send('special', { targetId: target.id }),
    });
  },

  lawyer: () => pickPlayer({
    title: 'Pembelaan Undang-undang', kicker: 'Peguam', includeSelf: true, intro: 'Penalti wang layak seterusnya ke atas pemain ini dikurangkan 50%. Tidak menghalang Dedahkan.',
    onPick: (target) => send('special', { targetId: target.id }),
  }),

  ally: () => pickPlayer({
    title: 'Perikatan Pelindung', kicker: 'Sekutu', intro: 'Lindungi pemain lain: penalti wang deal terdedah mereka dikurangkan 50%. Anda dapat +100 Influence jika berjaya.',
    onPick: (target) => send('special', { targetId: target.id }),
  }),

  populist: () => {
    const me = localOf(snap());
    const cost = Math.max(pcfg.campaignMinCost, Math.floor((Math.max(me.money, 0) * pcfg.campaignCostPercent) / 100));
    pickPlayer({
      title: 'Kempen Awam', kicker: 'Populis', includeSelf: true,
      intro: `Kos ${formatMoney(cost)} (${pcfg.campaignCostPercent}% wang anda, sekurang-kurangnya ${formatMoney(pcfg.campaignMinCost)}). Untuk diri sendiri: +${pcfg.campaignTrust}% kepercayaan awam dan +${pcfg.campaignInfluence} Influence. Untuk pemain lain: dia +${pcfg.campaignOtherTrust}%, anda +${pcfg.campaignInfluence} Influence.`,
      describe: (p) => ({ sub: `Public Trust ${p.approval}%`, mark: p.id === me.id }),
      onPick: (target) => {
        const self = target.id === me.id;
        const gain = self ? pcfg.campaignTrust : pcfg.campaignOtherTrust;
        const box = el('div');
        const dl = el('dl', 'power-facts');
        [
          ['Wang anda', formatMoney(me.money)],
          ['Kos', `−${formatMoney(cost)}`],
          [self ? 'Public Trust anda' : `Public Trust ${target.name}`, `${target.approval}% menjadi ${Math.min(100, target.approval + gain)}%`],
          ['Influence anda', `+${pcfg.campaignInfluence}`],
        ].forEach(([k, v]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); });
        box.appendChild(dl);
        if (target.approval + gain > 100) box.appendChild(note(`Public Trust ${self ? 'anda' : target.name} sudah tinggi: kempen hanya menambah sehingga 100%.`));
        if (!self) box.appendChild(note(`${target.name} akan diberitahu bahawa anda yang berkempen untuknya.`));
        const go = el('button', 'menu-btn menu-btn-primary');
        go.type = 'button';
        go.appendChild(el('span', 'menu-btn-label', 'Mulakan kempen'));
        go.addEventListener('click', () => { sound.playClick(); send('special', self ? {} : { targetId: target.id }); });
        box.appendChild(go);
        openPower('Mulakan kempen awam?', 'Populis', box);
      },
    });
  },

  opportunist: () => {
    // Ask the host what can be copied; the answer opens the picker (onAbilityResult).
    match.useAbility('special', {});
  },

  kingmaker: (abilityId) => {
    const me = localOf(snap());
    if (abilityId === 'special.powerBroker') {
      pickPlayer({
        title: 'Power Broker', kicker: 'Penentu Raja', intro: `Pindahkan ${kcfg.powerBrokerMin}-${kcfg.powerBrokerMax} Influence kepada pemain lain. Anda dapat +${kcfg.powerBrokerBonus} Influence bonus.`,
        describe: (p) => ({ sub: `${p.influence} Influence` }),
        onPick: (target) => {
          const max = Math.min(kcfg.powerBrokerMax, Math.floor(me.influence / 50) * 50);
          const box = el('div');
          if (max < kcfg.powerBrokerMin) {
            box.appendChild(note(`Anda perlukan sekurang-kurangnya ${kcfg.powerBrokerMin} Influence.`));
            openPower('Power Broker', 'Penentu Raja', box);
            return;
          }
          box.appendChild(note(`Pindahkan kepada ${target.name}:`));
          const value = el('div', 'power-amount', `${kcfg.powerBrokerMin} Influence`);
          const slider = el('input');
          slider.type = 'range';
          slider.min = String(kcfg.powerBrokerMin);
          slider.max = String(max);
          slider.step = '50';
          slider.value = String(kcfg.powerBrokerMin);
          slider.addEventListener('input', () => { value.textContent = `${slider.value} Influence`; });
          const go = el('button', 'menu-btn menu-btn-primary');
          go.type = 'button';
          go.appendChild(el('span', 'menu-btn-label', 'Pindahkan'));
          go.addEventListener('click', () => { sound.playClick(); send('special.powerBroker', { targetId: target.id, amount: Number(slider.value) }); });
          box.append(value, slider, go);
          openPower('Power Broker', 'Penentu Raja', box);
        },
      });
      return;
    }
    if (abilityId === 'special.endorsement') {
      pickPlayer({
        title: 'Sokongan Rasmi', kicker: 'Penentu Raja',
        intro: `Bayar ${kcfg.endorsementCost} Influence: pemain itu dapat ${kcfg.endorsementCost} Influence dan +${kcfg.endorsementTrust}% kepercayaan awam. Kedua-dua dapat +${kcfg.endorsementPerRound} Influence setiap ronda selama ${kcfg.endorsementRounds} ronda. Sekali sepanjang game, diumumkan kepada semua pemain. Jika dia terdedah, anda yang rugi.`,
        describe: (p) => ({ sub: `Public Trust ${p.approval}%` }),
        onPick: (target) => send('special.endorsement', { targetId: target.id }),
      });
      return;
    }
    if (abilityId === 'special.withdrawRenew') {
      const mine = (snap().shadow?.endorsements || []).filter((e) => e.kingmakerId === me.id);
      const box = el('div');
      mine.forEach((e) => box.appendChild(note(`Sokongan aktif: ${nameOf(e.targetId)}, sah sehingga ronda ${e.expiresRound}.`)));
      box.appendChild(note('Tarik balik: pemain itu hilang 2% kepercayaan awam, tiada bayaran balik, diumumkan kepada semua, dan tidak boleh disambung. Sambung: tambah 3 ronda (sekali sahaja).'));
      box.appendChild(listOf(
        choiceRow('Sambung sokongan', '+3 ronda, diumumkan kepada semua', () => send('special.withdrawRenew', { mode: 'renew' })),
        choiceRow('Tarik balik sokongan', 'Pemain itu −2% kepercayaan awam, diumumkan kepada semua', () => send('special.withdrawRenew', { mode: 'withdraw' })),
      ));
      openPower('Sambung / Tarik Balik', 'Penentu Raja', box);
    }
  },
};

const CATEGORY_LABELS_BY_ID = { dirty: 'Dirty Politics', clean: 'Clean Politics', investigation: 'Investigation', flexible: 'Flexible' };

// ---------- the character card, with its buttons ----------

// The buttons inside a card's Special panel: [{ id, name, hint }].
function powersFor(charId) {
  const c = getCharacter(charId);
  switch (charId) {
    case 'cleanPolitician': return [];
    case 'journalist': return [
      { id: 'special.report', name: 'Investigative Report', hint: 'Siasat seorang pemain; jika berjaya terbitkan satu Dirty Deal' },
      { id: 'special.mediaTrial', name: 'Media Trial', hint: 'Tuduh seorang pemain sebagai watak tertentu' },
    ];
    case 'kingmaker': return [
      { id: 'special.powerBroker', name: 'Power Broker', hint: `Pindah ${kcfg.powerBrokerMin}-${kcfg.powerBrokerMax} Influence, +${kcfg.powerBrokerBonus} bonus` },
      { id: 'special.endorsement', name: 'Official Endorsement', hint: 'Sekali sepanjang game, diumumkan kepada semua' },
      { id: 'special.withdrawRenew', name: 'Withdraw / Renew', hint: 'Untuk sokongan yang aktif' },
    ];
    case 'populist': {
      return [{ id: 'special', name: c.special.name, hint: `+${pcfg.campaignTrust}% Public Trust dan +${pcfg.campaignInfluence} Influence (diri sendiri atau pemain lain)` }];
    }
    default: return [{ id: 'special', name: c.special.name, hint: c.special.summary }];
  }
}

function powerState(power, charId, s, me, myTurn) {
  const status = getAbilityStatus(me, power.id, s.round);
  const freeCommission = s.shadow?.event?.id === 'anti-corruption-commission'
    && (charId === 'spy' || charId === 'whistleblower' || power.id === 'special.report');
  const ready = status.ready || freeCommission;
  let text;
  if (freeCommission && !status.ready) text = 'Percuma (Suruhanjaya)';
  else if (status.ready) text = 'Sedia';
  else if (status.reason === 'cooldown') text = `Sedia dalam ${status.roundsLeft} ronda`;
  else text = 'Telah digunakan';

  const mine = (s.shadow?.endorsements || []).some((e) => e.kingmakerId === me.id);
  let enabled = ready && myTurn;
  if (!myTurn && ready) text = 'Tunggu giliran anda';
  if (ready && myTurn && charId === 'populist') {
    const cost = Math.max(pcfg.campaignMinCost, Math.floor((Math.max(me.money, 0) * pcfg.campaignCostPercent) / 100));
    text = `Kos ${formatMoney(cost)}`;
  }
  if (power.id === 'special.withdrawRenew' && !mine) { enabled = false; text = 'Tiada sokongan aktif'; }
  if (power.id === 'special.endorsement' && mine && status.ready) { enabled = false; text = 'Sokongan masih aktif'; }
  return { enabled, status: text };
}

function cardFor(me, s, myTurn, charId, { asCopy = false } = {}) {
  const character = getCharacter(charId);
  const powers = (asCopy ? [] : powersFor(charId)).map((p) => ({ ...p, title: p.hint, ...powerState(p, charId, s, me, myTurn) }));
  if (asCopy) {
    // The Opportunist's own card: its one special is spent for good.
    powers.push({ id: 'special', name: character.special.name, status: 'Telah digunakan', enabled: false });
  }
  let funding = null;
  if (charId === 'moneyMan' && !asCopy) {
    const ready = powers[0]?.enabled;
    const reason = powers[0]?.status || '';
    funding = {
      players: (me.intel?.dirtyIds || []).map((id) => s.players.find((p) => p.id === id)).filter(Boolean).map((p) => ({
        id: p.id, name: p.name, detail: `Dirty Politics · Wang ${formatMoney(p.money)}`, enabled: Boolean(ready), status: reason,
      })),
    };
    powers.length = 0; // the funding block carries the buttons
  }
  let info = null;
  if (charId === 'bureaucrat' && me.abilityState?.falsifiedSlot !== undefined && me.abilityState?.falsifiedSlot !== null) {
    const f = s.players.find((p) => p.slot === me.abilityState.falsifiedSlot);
    if (f) info = { title: 'Bukti dipalsukan', text: `Anda telah memalsukan bukti tentang ${f.name}. Perisik dan Wartawan melihat rekod palsu tentang dia.` };
  }
  return buildCharacterCard(character, {
    powers,
    funding,
    info,
    asCopy,
    note: asCopy ? 'Kad asal anda. Satu kuasa Copycat sudah digunakan; anda kini memegang salinan di bawah.' : null,
    onPower: (id) => (FLOWS[charId] || (() => {}))(id),
    onFund: (id) => FLOWS.moneyMan('special', id),
  });
}

let cardSignature = '';

function renderPowers(s, me) {
  const host = $('#character-cards');
  const charId = effectiveId(me);
  const myTurn = s.activePlayerId === me.id && !s.skipping && !s.pendingVote && !s.characterReveal;
  const copied = Boolean(me.character?.copiedId);
  const sig = JSON.stringify([charId, copied, myTurn, s.round, me.money, me.influence, me.abilityState, me.intel, (s.shadow?.endorsements || []).length, s.shadow?.event?.id, s.players.map((p) => `${p.id}:${p.money}`).join()]);
  if (sig === cardSignature && host.childElementCount) return;
  cardSignature = sig;
  host.innerHTML = '';
  if (!charId) return;
  if (copied) host.appendChild(cardFor(me, s, myTurn, me.character.id, { asCopy: true }));
  host.appendChild(cardFor(me, s, myTurn, charId));
}

// The newest intelligence the player gathered (reports vanish from the dialog
// once closed), kept for the rest of the match.
function renderJournal() {
  const wrap = $('#character-journal-wrap');
  wrap.hidden = journal.length === 0;
  const list = $('#character-journal');
  list.innerHTML = '';
  journal.forEach((entry) => {
    const item = el('div', 'journal-entry');
    item.appendChild(el('b', '', `Ronda ${entry.round} · ${entry.title}`));
    entry.lines.forEach((line) => item.appendChild(el('span', '', line)));
    list.appendChild(item);
  });
}

function addJournal(title, lines) {
  journal.unshift({ round: snap().round, title, lines });
  journal = journal.slice(0, 8);
  renderJournal();
}

// ---------- the public strip: National Event, endorsements ----------

function renderShadowBanner(s) {
  const banner = $('#shadow-banner');
  const event = s.shadow?.event || null;
  const endorsements = s.shadow?.endorsements || [];
  if (!event && endorsements.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const box = $('#shadow-banner-body');
  box.innerHTML = '';
  if (event) {
    const line = el('div', 'shadow-line shadow-event');
    line.appendChild(el('b', '', `${event.icon} ${event.name}`));
    line.appendChild(el('span', '', event.description));
    box.appendChild(line);
  }
  endorsements.forEach((e) => {
    const line = el('div', 'shadow-line');
    line.appendChild(el('b', '', `🤝 ${nameOf(e.kingmakerId)} menyokong ${nameOf(e.targetId)}`));
    line.appendChild(el('span', '', `Sehingga ronda ${e.expiresRound}`));
    box.appendChild(line);
  });
}

// The Public Trust stat in the bottom bar, only when characters are in play.
function renderTrust(me) {
  const wrap = $('#bottom-trust-wrap');
  wrap.hidden = !me?.character;
  if (me?.character) $('#bottom-trust').textContent = `${me.approval}%`;
}

// A short tag for a player card: the character they were exposed as in a Media Trial.
export function publicCharacterTag(player) {
  const id = player.revealedCharacter;
  return id ? getCharacter(id)?.name || null : null;
}

// What the end screen adds about a character: the stats grid already names the card,
// so this only says who an Opportunist copied (everything is public by then).
export function endScreenCharacterLine(player) {
  if (!player.character?.copiedId) return null;
  const base = getCharacter(player.character.id)?.name || '';
  const copy = getCharacter(player.character.copiedId)?.name;
  return copy ? `${base}, menyalin ${copy}` : null;
}

// ---------- the host's answers ----------

// A found Dirty Deal, opened: the Whistleblower sees who was in it and may Dedahkan it.
function showDealDetail(r, v, dealNo) {
  const box = el('div');
  const targetIsInitiator = v.role === 'initiator';
  const initiator = targetIsInitiator ? nameOf(r.targetId) : v.counterpartyName;
  const recipient = targetIsInitiator ? v.counterpartyName : nameOf(r.targetId);
  const value = [v.money ? formatMoney(v.money) : '', v.influence ? `${v.influence} Influence` : ''].filter(Boolean).join(' + ');
  const dl = el('dl', 'power-facts');
  [['Pemula', initiator], ['Penerima', recipient], ['Jenis', v.dealLabel], ['Nilai', value || '-'], ['Ronda', String(v.round)]]
    .forEach(([k, val]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', val)); });
  box.appendChild(dl);
  box.appendChild(note('Jika didedahkan, pemula dan penerima dikenakan penalti dan deal ini menjadi berita awam. Tidak boleh dibatalkan.'));
  const go = el('button', 'menu-btn menu-btn-primary power-danger');
  go.type = 'button';
  go.appendChild(el('span', 'menu-btn-label', 'Dedahkan'));
  go.addEventListener('click', () => { sound.playClick(); closePower(); match.useAbility('follow', { viewId: v.viewId }); });
  box.appendChild(go);
  openPower(`Dirty Deal ${dealNo}`, 'Pembocor Rahsia', box);
}

function showViews(r) {
  const box = el('div');
  const isJournalist = r.investigator === 'journalist';
  const dl = el('dl', 'power-facts');
  const facts = [['Dirty Deal', String(r.evidenceCount)]];
  if (isJournalist) {
    facts.push([`Wang ${nameOf(r.targetId)}`, formatMoney(r.money)], ['Skandal', `${r.scandal}%`]);
  }
  facts.push(['Kepercayaan awam', `${r.publicTrust}%`]);
  if (isJournalist && r.targetCategory) {
    categoryClues[r.targetId] = { category: r.targetCategory, label: r.targetCategoryLabel };
    facts.push(['Petunjuk watak', `${r.targetCategoryLabel}`]);
  }
  facts.forEach(([k, v]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); });
  box.appendChild(dl);
  if (isJournalist && r.targetCategory) box.appendChild(note('Petunjuk watak diingati dan mengecilkan pilihan bila anda membuat Media Trial.'));
  if (!r.views.length) {
    box.appendChild(note('Tiada Dirty Deal untuk diterbitkan.'));
  } else {
    box.appendChild(note(isJournalist
      ? 'Pilih SATU Dirty Deal untuk diterbitkan. Nama pemain yang terlibat tidak ditunjukkan.'
      : 'Pilih satu Dirty Deal untuk melihat butirannya. Anda tidak boleh ditipu oleh bukti palsu.'));
    box.appendChild(listOf(r.views.map((v, i) => choiceRow(
      `Deal ${v.dealNo || i + 1}`,
      isJournalist ? 'Terbitkan deal ini' : 'Lihat butiran dan dedahkan',
      () => {
        if (isJournalist) { closePower(); match.useAbility('follow', { viewId: v.viewId }); } else showDealDetail(r, v, v.dealNo || i + 1);
      },
    ))));
  }
  openPower(isJournalist ? 'Bukti ditemui' : 'Deal ditemui', isJournalist ? 'Wartawan' : 'Pembocor Rahsia', box);
  addJournal(`Siasatan ${nameOf(r.targetId)}`, [
    `${r.evidenceCount} Dirty Deal`,
    ...(isJournalist ? [`Wang ${formatMoney(r.money)}, Skandal ${r.scandal}%, kepercayaan awam ${r.publicTrust}%`] : []),
    ...(isJournalist && r.targetCategoryLabel ? [`Petunjuk watak: ${r.targetCategoryLabel}`] : []),
  ]);
}

function showSpyReport(r) {
  const box = el('div');
  box.appendChild(note(`Laporan risikan: ${nameOf(r.targetId)} · ${CATEGORY_NAMES[r.report.category] || r.report.category}`));
  const clues = r.report.clues;
  if (!clues.length) box.appendChild(note('Tiada apa-apa ditemui.'));
  const dl = el('dl', 'power-clues');
  clues.forEach((c) => { dl.appendChild(el('dt', '', c.label)); dl.appendChild(el('dd', '', c.text)); });
  if (clues.length) box.appendChild(dl);
  box.appendChild(note('Maklumat ini mungkin tidak benar jika seorang Birokrat campur tangan.'));
  if (r.deals?.length) {
    box.appendChild(note('Pilih SATU Dirty Deal untuk disiasat: antara siapa?'));
    box.appendChild(listOf(r.deals.map((d) => choiceRow(`Deal ${d.dealNo}`, 'Siasat deal ini', () => { closePower(); match.useAbility('follow', { viewId: d.viewId }); }))));
  }
  openPower('Laporan Risikan', 'Perisik', box);
  addJournal(`Risikan ${nameOf(r.targetId)} (${CATEGORY_NAMES[r.report.category] || ''})`, clues.length ? clues.map((c) => `${c.label}: ${c.text}`) : ['Tiada apa-apa ditemui']);
}

function showSpyDeal(d) {
  const box = el('div');
  const value = [d.money ? formatMoney(d.money) : '', d.influence ? `${d.influence} Influence` : ''].filter(Boolean).join(' + ');
  const dl = el('dl', 'power-facts');
  [['Pemula', d.initiatorName], ['Penerima', d.recipientName], ['Jenis', d.dealLabel], ['Nilai (anggaran)', value || '-'], ['Ronda', String(d.round)]]
    .forEach(([k, v]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); });
  box.appendChild(dl);
  box.appendChild(note('Maklumat ini mungkin tidak benar jika salah seorang yang terlibat dilindungi Birokrat.'));
  openPower('Dirty Deal: antara siapa?', 'Perisik', box);
  addJournal('Dirty Deal disiasat', [`${d.initiatorName} dan ${d.recipientName}: ${d.dealLabel}, ronda ${d.round}`]);
}

function showCopyPicker(options) {
  const box = el('div');
  if (!options.length) {
    box.appendChild(note('Tiada watak untuk disalin.'));
    openPower('Copycat Politics', 'Oportunis', box);
    return;
  }
  box.appendChild(note('Pilih satu watak yang ada dalam permainan ini. Anda tidak tahu siapa yang memegangnya. Anda akan menjadi salinannya (kuasa, pasif dan kelemahan) untuk selamanya.'));
  box.appendChild(listOf(options.map((id) => {
    const c = getCharacter(id);
    return choiceRow(c.name, c.special.name, () => send('special', { characterId: id }));
  })));
  openPower('Copycat Politics', 'Oportunis', box);
}

function onAbilityResult(r) {
  if (r.kind === 'copy-options') return showCopyPicker(r.options || []);
  if (r.kind === 'copy') {
    const gifts = [r.startingCapital ? formatMoney(r.startingCapital) : '', r.startingInfluence ? `${r.startingInfluence} Influence` : ''].filter(Boolean).join(' dan ');
    const capital = gifts ? ` Anda terima ${gifts} sebagai modal permulaan.` : '';
    hooks.showToast(`Anda kini ialah ${r.characterName}.${capital} Kuasanya boleh digunakan pada giliran seterusnya.`, 6000);
    sound.playPromotion();
    return undefined;
  }
  if (r.kind === 'investigation') {
    const target = nameOf(r.targetId);
    if (r.investigator === 'spy') {
      if (r.success) showSpyReport(r);
      else { hooks.showToast(`Siasatan ke atas ${target} gagal. ${target} tahu anda yang cuba.`, 5500); sound.playWarning(); addJournal(`Siasatan ${target}`, ['Gagal, penyamaran terbongkar']); }
    } else if (r.success) showViews(r);
    else { hooks.showToast(`Tiada bukti ditemui tentang ${target}.`, 4500); addJournal(`Siasatan ${target}`, ['Tiada bukti ditemui']); }
    return undefined;
  }
  if (r.kind === 'spy-deal') { showSpyDeal(r.deal); return undefined; }
  if (r.abilityId === 'follow') {
    if (r.success) { hooks.showToast('Fail 101 didedahkan! Tahniah.', 5000); sound.playPromotion(); }
    else { hooks.showToast(r.text || 'Laporan anda tidak dapat disahkan.', 7000); sound.playWarning(); }
    return undefined;
  }
  if (r.pending) { hooks.showToast(`Tuduhan dihantar kepada ${nameOf(r.targetId)}. Menunggu jawapan.`, 5000); return undefined; }
  if (r.amount !== undefined && r.bonus !== undefined) { hooks.showToast(`Power Broker: ${r.amount} Influence dipindahkan, anda dapat +${r.bonus} bonus.`, 5000); sound.playCoins(); return undefined; }
  if (r.cost !== undefined) {
    hooks.showToast(r.forName
      ? `Kempen untuk ${r.forName} berjaya! −${formatMoney(r.cost)}, dia +${r.trust}% kepercayaan awam, anda +${r.influence} Influence.`
      : `Kempen berjaya! −${formatMoney(r.cost)}, +${r.trust}% kepercayaan awam, +${r.influence} Influence.`, 5500);
    sound.playPromotion();
    return undefined;
  }
  if (r.mode === 'renew') { hooks.showToast(`Sokongan disambung sehingga ronda ${r.expiresRound}.`, 4500); return undefined; }
  if (r.mode === 'withdraw') { hooks.showToast('Sokongan ditarik balik dan diumumkan.', 4500); return undefined; }
  if (r.expiresRound) { hooks.showToast(`Sokongan rasmi diumumkan. Sah sehingga ronda ${r.expiresRound}.`, 5000); sound.playPromotion(); return undefined; }
  const me = localOf(snap());
  const id = effectiveId(me);
  if (id === 'lawyer') hooks.showToast('Pembelaan dipasang. Penalti wang layak seterusnya dikurangkan 50%.', 4500);
  else if (id === 'ally') hooks.showToast('Perlindungan dipasang.', 4000);
  else if (id === 'bureaucrat') hooks.showToast('Bukti dipalsukan. Tiada siapa tahu.', 4500);
  return undefined;
}

const QUIET_NOTICES = new Set(['public-support', 'endorsement-pay']);
const NOTICE_ICONS = {
  shield: '🛡️', investigated: '🕵️', 'deal-alert': '🔔', 'trial-won': '🎙️', 'trial-lost': '⚖️', 'trial-cleared': '✅', 'trial-lied': '🤥', 'trial-unproven': '❔', 'campaign-for-you': '📣',
  'power-broker': '🤝', 'scandal-damage': '📉', 'political-liability': '📉', 'endorsement-expired': '⌛',
  'shield-used': '🛡️', 'ally-bonus': '⭐',
};

function onAbilityNotice(n) {
  const text = `${NOTICE_ICONS[n.kind] || ''} ${n.text}`.trim();
  if (QUIET_NOTICES.has(n.kind)) {
    hooks.pushFeed(text, 'news', snap().round);
    return;
  }
  hooks.showToast(text, 6000);
  if (['investigated', 'scandal-damage', 'political-liability', 'trial-lost'].includes(n.kind)) sound.playWarning();
}

// ---------- Media Trial: the accused answers ----------

function onMediaTrial(t) {
  clearInterval(trialTimer);
  $('#trial-text').textContent = t.text;
  $('#trial-overlay').dataset.trialId = t.trialId;
  const deadline = Date.now() + mcfg.responseMs;
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $('#trial-countdown').textContent = `${Math.ceil(left / 1000)}s`;
    if (left <= 0) hideTrial(); // the host counts silence as denying
  };
  tick();
  trialTimer = setInterval(tick, 500);
  $('#trial-overlay').hidden = false;
  sound.playWarning();
}

function hideTrial() {
  clearInterval(trialTimer);
  trialTimer = null;
  $('#trial-overlay').hidden = true;
}

// ---------- wiring and rendering entry points ----------

let wired = false;

export function initCharacterUi(callbacks) {
  hooks = { ...hooks, ...callbacks };
  if (wired) return;
  wired = true;
  $('#btn-power-close').addEventListener('click', () => { sound.playClick(); closePower(); });
  $('#shadow-banner').addEventListener('click', () => $('#shadow-banner').classList.toggle('is-open'));
  $('#power-modal').addEventListener('click', (e) => { if (e.target.id === 'power-modal') closePower(); });
  $('#btn-trial-admit').addEventListener('click', () => {
    sound.playClick();
    match.respondToMediaTrial($('#trial-overlay').dataset.trialId, true);
    hideTrial();
  });
  $('#btn-trial-deny').addEventListener('click', () => {
    sound.playClick();
    match.respondToMediaTrial($('#trial-overlay').dataset.trialId, false);
    hideTrial();
  });
  bus.on('match:ability-result', (e) => onAbilityResult(e.detail));
  bus.on('match:ability-notice', (e) => onAbilityNotice(e.detail));
  bus.on('match:media-trial', (e) => onMediaTrial(e.detail));
  bus.on('room:left', () => { journal = []; categoryClues = {}; closePower(); hideTrial(); });
}

// Called on every match update.
let lastRoundSeen = 0;
export function renderCharacterUi(snapshot) {
  // The round counter going backwards means a new match began: clues about the old one are stale.
  if (snapshot.round < lastRoundSeen) { categoryClues = {}; }
  lastRoundSeen = snapshot.round;
  const me = localOf(snapshot);
  const active = Boolean(me?.character);
  renderShadowBanner(snapshot);
  renderTrust(me);
  if (!active) { cardSignature = ''; return; }
  renderPowers(snapshot, me);
  renderJournal();
}
