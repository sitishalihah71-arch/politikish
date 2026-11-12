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

const kcfg = GAME_BALANCE.characters.kingmaker;
const pcfg = GAME_BALANCE.characters.populist;

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

function playerRow(player, label, onPick) {
  const btn = el('button', 'target-picker-item');
  btn.type = 'button';
  const avatar = el('div', 'lobby-player-avatar');
  avatar.innerHTML = renderAvatarSVG(player.avatar, 36);
  btn.appendChild(avatar);
  btn.appendChild(el('span', '', label || player.name));
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

// Who? (every power that needs a player). `includeSelf` for the Lawyer.
function pickPlayer({ title, kicker, intro, includeSelf = false, onPick }) {
  const s = snap();
  const me = localOf(s);
  const candidates = s.players.filter((p) => p.connected && (includeSelf || p.id !== me.id));
  const box = el('div');
  if (intro) box.appendChild(note(intro));
  box.appendChild(listOf(candidates.map((p) => playerRow(p, p.id === me.id ? `${p.name} (anda)` : p.name, (picked) => onPick(picked)))));
  openPower(title, kicker, box);
}

const send = (abilityId, params = {}) => {
  closePower();
  match.useAbility(abilityId, params);
};

// ---------- starting a power ----------

const FLOWS = {
  // Fixer / Money Man: the ordinary deal screens, with the special switched on.
  fixer: () => hooks.openDeal('fixer'),
  moneyMan: () => hooks.openDeal('funding'),

  spy: () => pickPlayer({
    title: 'Siasatan Rahsia', kicker: 'Perisik', intro: 'Siapa yang mahu disiasat? Sasaran tahu dia disiasat, tetapi bukan oleh siapa (kecuali anda gagal).',
    onPick: (target) => {
      const box = el('div');
      box.appendChild(note(`Siasat ${target.name} tentang:`));
      box.appendChild(listOf(SPY_CATEGORIES.map((category) => choiceRow(CATEGORY_NAMES[category], CATEGORY_HINTS[category], () => send('special', { targetId: target.id, category })))));
      openPower('Pilih kategori', 'Perisik', box);
    },
  }),

  whistleblower: () => pickPlayer({
    title: 'Pendedahan Awam', kicker: 'Pembocor Rahsia', intro: 'Siasat seorang pemain. Jika dia ada deal tersembunyi, anda boleh mendedahkannya.',
    onPick: (target) => send('special', { targetId: target.id }),
  }),

  journalist: (abilityId) => {
    if (abilityId === 'special.report') {
      pickPlayer({
        title: 'Laporan Penyiasatan', kicker: 'Wartawan', intro: 'Siasat seorang pemain. Jika berjaya anda boleh menerbitkan satu bukti. Berhati-hati: bukti boleh dipalsukan.',
        onPick: (target) => send('special.report', { targetId: target.id }),
      });
      return;
    }
    pickPlayer({
      title: 'Perbicaraan Media', kicker: 'Wartawan', intro: 'Tuduh seorang pemain sebagai watak tertentu. Tuduhan salah: anda kena Defamation.',
      onPick: (target) => {
        const box = el('div');
        const me = localOf(snap());
        const clue = categoryClues[target.id];
        box.appendChild(note(clue
          ? `Siapakah ${target.name}? Laporan anda menunjukkan kategorinya: ${clue.label}.`
          : `Siapakah ${target.name}? Tiada petunjuk lagi. Terbitkan Laporan Penyiasatan dahulu untuk mengetahui kategorinya.`));
        const names = activeCharacters().filter((c) => c.id !== effectiveId(me) && (!clue || c.category === clue.category));
        box.appendChild(listOf(names.map((c) => choiceRow(c.name, null, () => send('special.mediaTrial', { targetId: target.id, characterId: c.id })))));
        openPower('Pilih watak', 'Wartawan', box);
      },
    });
  },

  bureaucrat: () => pickPlayer({
    title: 'Palsukan Bukti', kicker: 'Birokrat', intro: 'Sekali sepanjang game. Perisik dan Wartawan akan nampak bukti palsu tentang pemain ini. Rekod sebenar tidak berubah.',
    onPick: (target) => send('special', { targetId: target.id }),
  }),

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
    const box = el('div');
    box.appendChild(note(`Kempen awam: kos ${formatMoney(cost)}. Ganjaran +${pcfg.campaignTrust}% kepercayaan awam dan +${pcfg.campaignInfluence} Influence.`));
    box.appendChild(listOf(choiceRow('Lancarkan kempen', `Bayar ${formatMoney(cost)}`, () => send('special', {}))));
    openPower('Kempen Awam', 'Populis', box);
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
        intro: `Bayar ${kcfg.endorsementCost} Influence: pemain itu dapat ${kcfg.endorsementCost} Influence dan +${kcfg.endorsementTrust}% kepercayaan awam. Kedua-dua dapat +${kcfg.endorsementPerRound} Influence setiap ronda selama ${kcfg.endorsementRounds} ronda. Sekali sepanjang game, diumumkan kepada semua. Jika dia terdedah, anda yang rugi.`,
        onPick: (target) => send('special.endorsement', { targetId: target.id }),
      });
      return;
    }
    if (abilityId === 'special.withdrawRenew') {
      const box = el('div');
      box.appendChild(note('Tarik balik: pemain itu hilang 2% kepercayaan awam, tiada bayaran balik, diumumkan, dan tidak boleh disambung. Sambung: tambah 3 ronda (sekali sahaja).'));
      box.appendChild(listOf(
        choiceRow('Sambung sokongan', '+3 ronda', () => send('special.withdrawRenew', { mode: 'renew' })),
        choiceRow('Tarik balik sokongan', 'Pemain itu −2% kepercayaan awam', () => send('special.withdrawRenew', { mode: 'withdraw' })),
      ));
      openPower('Sambung / Tarik Balik', 'Penentu Raja', box);
      return;
    }
    if (abilityId === 'special.bonusVote') send('special.bonusVote', {});
  },
};

// ---------- the list of powers in the character panel ----------

function powersFor(charId) {
  switch (charId) {
    case 'fixer': return [{ id: 'special', label: 'Fixer Deal', hint: 'Mulakan deal khas: +5 Skandal sahaja, +10% ganjaran' }];
    case 'moneyMan': return [{ id: 'special', label: 'Secret Funding', hint: 'Biayai pemain Dirty Politics: +30% untuk anda jika diterima' }];
    case 'whistleblower': return [{ id: 'special', label: 'Pendedahan Awam', hint: 'Siasat, kemudian dedah deal tersembunyi' }];
    case 'spy': return [{ id: 'special', label: 'Siasatan Rahsia', hint: 'Laporan risikan tentang seorang pemain' }];
    case 'journalist': return [
      { id: 'special.report', label: 'Laporan Penyiasatan', hint: 'Siasat dan terbitkan satu bukti' },
      { id: 'special.mediaTrial', label: 'Perbicaraan Media', hint: 'Tuduh seorang pemain sebagai watak tertentu' },
    ];
    case 'bureaucrat': return [{ id: 'special', label: 'Palsukan Bukti', hint: 'Sekali sepanjang game' }];
    case 'lawyer': return [{ id: 'special', label: 'Pembelaan Undang-undang', hint: 'Kurangkan 50% penalti wang seterusnya' }];
    case 'ally': return [{ id: 'special', label: 'Perikatan Pelindung', hint: 'Lindungi pemain lain, +100 Influence jika berjaya' }];
    case 'populist': return [{ id: 'special', label: 'Kempen Awam', hint: `+${pcfg.campaignTrust}% kepercayaan awam, +${pcfg.campaignInfluence} Influence` }];
    case 'opportunist': return [{ id: 'special', label: 'Copycat Politics', hint: 'Jadi salinan satu watak dalam permainan, untuk selamanya' }];
    case 'kingmaker': return [
      { id: 'special.powerBroker', label: 'Power Broker', hint: `Pindah ${kcfg.powerBrokerMin}-${kcfg.powerBrokerMax} Influence, +${kcfg.powerBrokerBonus} bonus` },
      { id: 'special.endorsement', label: 'Sokongan Rasmi', hint: 'Sekali sepanjang game' },
      { id: 'special.withdrawRenew', label: 'Sambung / Tarik Balik', hint: 'Untuk sokongan yang aktif' },
      { id: 'special.bonusVote', label: 'Undi Berganda', hint: 'Satu undi tambahan dalam sidang Parlimen' },
    ];
    default: return [];
  }
}

function powerState(power, charId, s, me) {
  const myTurn = s.activePlayerId === me.id && !s.skipping && !s.pendingVote && !s.characterReveal;
  const status = getAbilityStatus(me, power.id, s.round);
  const freeCommission = s.shadow?.event?.id === 'anti-corruption-commission'
    && (charId === 'spy' || charId === 'whistleblower' || power.id === 'special.report');
  let ready = status.ready || freeCommission;
  let note = '';
  if (freeCommission && !status.ready) note = 'Percuma (Suruhanjaya)';
  else if (status.ready) note = status.usesLeft !== null ? `Sedia (${status.usesLeft} lagi)` : 'Sedia';
  else if (status.reason === 'cooldown') note = `Cooldown ${status.roundsLeft} ronda`;
  else note = 'Sudah digunakan';

  const mine = (s.shadow?.endorsements || []).some((e) => e.kingmakerId === me.id);
  let enabled = ready && myTurn;
  if (!myTurn && ready) note = 'Pada giliran anda';
  if (power.id === 'special.bonusVote') {
    enabled = ready && Boolean(s.pendingVote);
    if (ready) note = s.pendingVote ? 'Aktifkan sekarang' : 'Hanya semasa sidang Parlimen';
  }
  if (power.id === 'special.withdrawRenew') {
    ready = ready && mine;
    enabled = ready && myTurn;
    if (!mine) note = 'Tiada sokongan aktif';
  }
  if (power.id === 'special.endorsement' && mine && status.ready) { enabled = false; note = 'Sokongan masih aktif'; }
  return { enabled, note };
}

function renderPowers(s, me) {
  const box = $('#character-powers');
  const charId = effectiveId(me);
  const powers = powersFor(charId);
  box.innerHTML = '';
  if (me.character?.copiedId) {
    box.appendChild(el('p', 'power-copy', `Anda telah menyalin ${getCharacter(me.character.copiedId)?.name || ''} untuk selamanya.`));
  }
  if (charId === 'cleanPolitician') {
    box.appendChild(el('p', 'power-copy', 'Bila ada tawaran Backroom Deal, anda boleh Terima, Tolak atau Dedah tawaran itu.'));
  }
  if (!powers.length) return;
  powers.forEach((power) => {
    const { enabled, note: status } = powerState(power, charId, s, me);
    const row = el('button', `power-btn${enabled ? '' : ' is-off'}`);
    row.type = 'button';
    row.disabled = !enabled;
    const text = el('span', 'power-text');
    text.appendChild(el('b', '', power.label));
    text.appendChild(el('small', '', power.hint));
    row.appendChild(text);
    row.appendChild(el('span', 'power-status', status));
    row.addEventListener('click', () => {
      sound.playClick();
      (FLOWS[charId] || (() => {}))(power.id);
    });
    box.appendChild(row);
  });
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

function showViews(r) {
  const box = el('div');
  const isJournalist = r.investigator === 'journalist';
  box.appendChild(note(`${nameOf(r.targetId)}: ${r.evidenceCount} rekod tersembunyi · kepercayaan awam ${r.publicTrust}%.`));
  if (isJournalist && r.targetCategory) {
    categoryClues[r.targetId] = { category: r.targetCategory, label: r.targetCategoryLabel };
    box.appendChild(note(`Petunjuk watak: ${nameOf(r.targetId)} ialah watak ${r.targetCategoryLabel}. Berguna untuk Perbicaraan Media.`));
  }
  if (!r.views.length) {
    box.appendChild(note('Tiada deal tersembunyi untuk didedahkan.'));
  } else {
    box.appendChild(note(isJournalist
      ? 'Pilih SATU bukti untuk diterbitkan. Jika bukti itu palsu, anda yang rugi.'
      : 'Pilih SATU deal untuk didedahkan. Anda tidak boleh ditipu.'));
    box.appendChild(listOf(r.views.map((v) => {
      const value = [v.money ? formatMoney(v.money) : '', v.influence ? `${v.influence} Influence` : ''].filter(Boolean).join(' + ');
      return choiceRow(
        `${v.role === 'initiator' ? 'Pemula' : 'Penerima'} dengan ${v.counterpartyName}`,
        `${v.dealLabel}${value ? ` · ${value}` : ''} · ronda ${v.round}`,
        () => { closePower(); match.useAbility('follow', { viewId: v.viewId }); },
      );
    })));
  }
  openPower(isJournalist ? 'Bukti ditemui' : 'Deal ditemui', isJournalist ? 'Wartawan' : 'Pembocor Rahsia', box);
  addJournal(`Siasatan ${nameOf(r.targetId)}`, [`${r.evidenceCount} rekod tersembunyi`, ...r.views.map((v) => `${v.role === 'initiator' ? 'Pemula' : 'Penerima'} dengan ${v.counterpartyName}: ${v.dealLabel}, ronda ${v.round}`)]);
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
  openPower('Laporan Risikan', 'Perisik', box);
  addJournal(`Risikan ${nameOf(r.targetId)} (${CATEGORY_NAMES[r.report.category] || ''})`, clues.length ? clues.map((c) => `${c.label}: ${c.text}`) : ['Tiada apa-apa ditemui']);
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
  if (r.abilityId === 'follow') {
    if (r.success) { hooks.showToast('Fail 101 didedahkan! Tahniah.', 5000); sound.playPromotion(); }
    else { hooks.showToast(r.text || 'Laporan anda tidak dapat disahkan.', 7000); sound.playWarning(); }
    return undefined;
  }
  if (r.pending) { hooks.showToast(`Tuduhan dihantar kepada ${nameOf(r.targetId)}. Menunggu jawapan.`, 5000); return undefined; }
  if (r.amount !== undefined && r.bonus !== undefined) { hooks.showToast(`Power Broker: ${r.amount} Influence dipindahkan, anda dapat +${r.bonus} bonus.`, 5000); sound.playCoins(); return undefined; }
  if (r.cost !== undefined) { hooks.showToast(`Kempen berjaya! −${formatMoney(r.cost)}, +${r.trust}% kepercayaan awam, +${r.influence} Influence.`, 5500); sound.playPromotion(); return undefined; }
  if (r.mode === 'renew') { hooks.showToast(`Sokongan disambung sehingga ronda ${r.expiresRound}.`, 4500); return undefined; }
  if (r.mode === 'withdraw') { hooks.showToast('Sokongan ditarik balik dan diumumkan.', 4500); return undefined; }
  if (r.armed) { hooks.showToast('Undi berganda diaktifkan. Anda mesti mengundi untuk menggunakannya.', 5500); return undefined; }
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
  shield: '🛡️', investigated: '🕵️', 'deal-alert': '🔔', 'trial-won': '🎙️', 'trial-lost': '⚖️', 'trial-cleared': '✅',
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
  const deadline = Date.now() + GAME_BALANCE.characters.mediaTrial.responseMs;
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $('#trial-countdown').textContent = `${Math.ceil(left / 1000)}s`;
    if (left <= 0) hideTrial(); // the host counts silence as a challenge
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
  $('#btn-trial-challenge').addEventListener('click', () => {
    sound.playClick();
    match.respondToMediaTrial($('#trial-overlay').dataset.trialId, false);
    hideTrial();
  });
  $('#btn-bonus-vote').addEventListener('click', () => {
    sound.playClick();
    match.useAbility('special.bonusVote', {});
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
  $('#character-powers-wrap').hidden = !active;
  renderShadowBanner(snapshot);
  renderTrust(me);
  // The Kingmaker's "Undi Berganda" lives in the Parliament overlay too.
  const bonus = $('#btn-bonus-vote');
  const isKingmaker = active && effectiveId(me) === 'kingmaker';
  const ready = isKingmaker && getAbilityStatus(me, 'special.bonusVote', snapshot.round).ready;
  bonus.hidden = !(ready && snapshot.pendingVote);
  if (!active) return;
  renderPowers(snapshot, me);
  renderJournal();
}
