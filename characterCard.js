// Mode Watak: the character card. One card, drawn from data: a cropped portrait
// (assets/characters/portrait/<id>.webp), the category ribbon, the name, and
// three newspaper panels (Special, Passive, Weakness). The Special panel holds
// the ability's own buttons, so a player presses what they read.
//
// This module only builds DOM. Whether a button is ready, cooling down, used
// or blocked is decided by the caller (characterUi.js) from the host's
// snapshot; pressing one calls `onPower(powerId)`.

import { CATEGORY_LABELS } from './characters.js';

const PORTRAITS = new Set([
  'fixer', 'cleanPolitician', 'whistleblower', 'journalist', 'kingmaker',
  'moneyMan', 'opportunist', 'populist', 'bureaucrat', 'spy',
]);

export const getPortrait = (characterId) => (PORTRAITS.has(characterId) ? `assets/characters/portrait/${characterId}.webp` : null);

const CATEGORY_CLASS = { dirty: 'dirty', clean: 'clean', investigation: 'investigation', flexible: 'flexible' };

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ICONS = {
  special: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  passive: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  weak: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.1"/>',
};

function ribbon(kind, label) {
  const tag = el('div', `cc-tag cc-tag-${kind}`);
  tag.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`;
  tag.appendChild(el('span', '', label));
  return tag;
}

// "Cooldown 2 ronda" / "Sekali sepanjang game" / "Satu setiap giliran" / "Reaktif"
export function limitChip(character) {
  const limit = character.special.limit;
  if (limit?.type === 'cooldown') return `Cooldown ${limit.rounds} ronda`;
  if (limit?.type === 'perGame') return limit.uses > 1 ? `${limit.uses} kali sepanjang game` : 'Sekali sepanjang game';
  if (character.id === 'cleanPolitician') return 'Reaktif';
  if (character.special.options?.length) return 'Satu setiap giliran';
  return '';
}

function actionButton(power, multi, onPower) {
  const btn = el('button', `cc-action${multi ? ' is-multi' : ''}${power.enabled ? '' : ' is-off'}`);
  btn.type = 'button';
  btn.disabled = !power.enabled;
  btn.appendChild(el('span', 'cc-action-name', power.name));
  btn.appendChild(el('span', 'cc-action-status', power.status));
  if (power.title) btn.title = power.title;
  btn.addEventListener('click', () => onPower(power.id));
  return btn;
}

// The Money Man's block: the Dirty Politics holders only he can see.
function fundingBlock(funding, onFund) {
  const box = el('div', 'cc-block cc-funding');
  box.appendChild(el('div', 'cc-block-head', 'Pemain Dirty Politics'));
  box.appendChild(el('p', 'cc-block-text', 'Anda nampak siapa memegang watak Dirty Politics. Hanya mereka boleh ditawarkan dana. Pemain lain tidak dipaparkan.'));
  if (!funding.players.length) {
    box.appendChild(el('p', 'cc-block-text cc-muted', 'Tiada pemain Dirty Politics lain dalam game ini.'));
  }
  funding.players.forEach((p) => {
    const row = el('div', 'cc-fund-row');
    row.appendChild(el('span', 'cc-fund-initial', p.name.charAt(0).toUpperCase()));
    const who = el('span', 'cc-fund-who');
    who.appendChild(el('b', '', p.name));
    who.appendChild(el('small', '', p.detail));
    row.appendChild(who);
    const btn = el('button', `cc-fund-btn${p.enabled ? '' : ' is-off'}`, p.enabled ? 'Tawar dana' : p.status);
    btn.type = 'button';
    btn.disabled = !p.enabled;
    btn.addEventListener('click', () => onFund(p.id));
    row.appendChild(btn);
    box.appendChild(row);
  });
  box.appendChild(el('p', 'cc-block-note', 'Jika diterima, anda juga dapat tambahan 30% (paling banyak RM6,000).'));
  return box;
}

function reactiveBlock() {
  const box = el('div', 'cc-block cc-reactive');
  box.appendChild(el('div', 'cc-block-head', 'Tiada butang diperlukan'));
  box.appendChild(el('p', 'cc-block-text', 'Bila seseorang menawarkan Backroom Deal, anda yang menjawab:'));
  const chips = el('div', 'cc-chips');
  ['Terima', 'Dedah', 'Tolak diam-diam'].forEach((t) => chips.appendChild(el('span', 'cc-chip', t)));
  box.appendChild(chips);
  return box;
}

function rule(kind, label, ability, extras = []) {
  const section = el('section', `cc-rule cc-rule-${kind}`);
  const head = el('div', 'cc-rule-head');
  head.appendChild(ribbon(kind, label));
  if (extras.chip) head.appendChild(el('span', 'cc-limit', extras.chip));
  section.appendChild(head);
  section.appendChild(el('h3', 'cc-rule-name', ability.name));
  section.appendChild(el('p', 'cc-rule-summary', ability.summary));
  return section;
}

// options: {
//   powers: [{ id, name, status, enabled, title? }],   buttons inside the Special panel
//   funding: { players: [{ id, name, detail, enabled, status }] } | null,
//   onPower(id), onFund(playerId),
//   note: string | null          a short line above the card (e.g. "Salinan dari Opportunist")
// }
export function buildCharacterCard(character, options = {}) {
  const { powers = [], funding = null, info = null, onPower = () => {}, onFund = () => {}, note = null, asCopy = false } = options;
  const wrap = el('article', `cc cc-${CATEGORY_CLASS[character.category] || 'flexible'}`);
  wrap.dataset.character = character.id;
  const inner = el('div', 'cc-inner');

  const art = el('div', 'cc-art');
  const src = getPortrait(character.id);
  if (src) {
    const img = el('img');
    img.src = src;
    img.alt = `${character.name}, ${CATEGORY_LABELS[character.category]}`;
    img.loading = 'lazy';
    art.appendChild(img);
  } else {
    art.classList.add('cc-art-none');
  }
  art.appendChild(el('div', 'cc-art-fade'));
  art.appendChild(el('div', 'cc-category', CATEGORY_LABELS[character.category]));
  const brand = el('div', 'cc-brand');
  brand.innerHTML = 'POLITIK<span>\'ISH</span>';
  art.appendChild(brand);
  const title = el('div', 'cc-title');
  const len = character.name.length;
  const name = el('h2', `cc-name${len > 16 ? ' is-long' : len > 12 ? ' is-mid' : ''}`, character.name);
  title.appendChild(name);
  title.appendChild(el('p', 'cc-role', character.role));
  art.appendChild(title);
  inner.appendChild(art);

  const paper = el('div', 'cc-paper');
  if (note) paper.appendChild(el('p', 'cc-copy-note', note));

  const special = rule('special', asCopy ? 'Special (salinan)' : 'Special', character.special, { chip: limitChip(character) });
  if (powers.length) {
    const grid = el('div', `cc-actions${powers.length > 1 ? ' is-multi' : ''}`);
    powers.forEach((p) => grid.appendChild(actionButton(p, powers.length > 1, onPower)));
    special.appendChild(grid);
  }
  if (character.id === 'cleanPolitician') special.appendChild(reactiveBlock());
  if (info) {
    const box = el('div', 'cc-block cc-reactive');
    box.appendChild(el('div', 'cc-block-head', info.title));
    box.appendChild(el('p', 'cc-block-text', info.text));
    special.appendChild(box);
  }
  if (funding) special.appendChild(fundingBlock(funding, onFund));
  paper.appendChild(special);
  paper.appendChild(rule('passive', 'Pasif', character.passive));
  paper.appendChild(rule('weak', 'Kelemahan', character.weakness));
  inner.appendChild(paper);
  wrap.appendChild(inner);
  return wrap;
}
