// Mode Watak: the character card reveal. At match start every human gets a
// short ceremony - the curtain, a closed card rising, a tense shake, the flip,
// then the face and a "Saya faham" button - and the host holds the first turn
// until everyone confirmed (see match.js's reveal gate). The same screen can
// be reopened later from the Watak Rahsia panel to look at the card again.
//
// All timing and motion live in CSS (keyed on #character-reveal[data-phase]);
// this module only moves the phase along and fills in the text.
//
// The card art is the supplied PNG artwork (assets/characters/<id>.webp). A
// character without art (The Spy, for now) gets a plain text card instead, so
// nothing about the flow depends on the art being there.

import { $, bus } from './utils.js';
import * as match from './match.js';
import * as sound from './sound.js';
import { getCharacter, CATEGORY_LABELS } from './characters.js';
import { GAME_BALANCE } from './balance.js';

const ART_IDS = new Set([
  'fixer', 'cleanPolitician', 'whistleblower', 'journalist', 'kingmaker', 'lawyer',
  'moneyMan', 'opportunist', 'populist', 'bureaucrat', 'ally',
]);

export function getCardArt(characterId) {
  return ART_IDS.has(characterId) ? `assets/characters/${characterId}.webp` : null;
}

let root = null;
let phase = null; // curtain | rise | shake | flip | reveal | view | waiting
let mode = 'ceremony'; // 'ceremony' (match start) or 'view' (looking again later)
let timers = [];
let gateWasOpen = false;
let lastSnapshot = null;
let currentCharacter = null;
let returnFocus = null;

const SPARKS = [[10, 20], [86, 24], [5, 44], [92, 48], [18, 70], [80, 72], [48, 12], [30, 80], [66, 82], [94, 62], [8, 58], [52, 78]];

function limitText(limit) {
  if (!limit || limit.type === 'none') return 'Tiada had';
  if (limit.type === 'cooldown') return `Cooldown: ${limit.rounds} pusingan`;
  return limit.uses === 1 ? 'Sekali setiap permainan' : `${limit.uses} kali setiap permainan`;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function buildOverlay() {
  root = document.createElement('div');
  root.id = 'character-reveal';
  root.className = 'cr';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Watak rahsia anda');
  root.innerHTML = `
    <div class="cr-rays"></div>
    <div class="cr-aura"></div>
    <div class="cr-caption" aria-live="polite">
      <div class="cr-kicker" id="cr-kicker"></div>
      <div class="cr-title" id="cr-title"></div>
      <div class="cr-sub" id="cr-sub"></div>
    </div>
    <div class="cr-stage">
      <div class="cr-lift"><div class="cr-tremor"><div class="cr-card">
        <div class="cr-flipper">
          <div class="cr-face cr-back">
            <div class="cr-back-brand">POLITIK<span>'ISH</span></div>
            <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true">
              <defs><linearGradient id="cr-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6dc8f"/><stop offset=".6" stop-color="#e0b04a"/><stop offset="1" stop-color="#a97a22"/></linearGradient></defs>
              <circle cx="75" cy="75" r="70" fill="none" stroke="url(#cr-gold)" stroke-width="3"/>
              <circle cx="75" cy="75" r="60" fill="none" stroke="#8a6420" stroke-width="1"/>
              <circle cx="75" cy="75" r="64" fill="none" stroke="#8a6420" stroke-width="1" stroke-dasharray="2 6"/>
              <text x="75" y="106" text-anchor="middle" font-family="Playfair Display, serif" font-style="italic" font-weight="900" font-size="88" fill="url(#cr-gold)">?</text>
            </svg>
            <div class="cr-back-label">WATAK RAHSIA</div>
          </div>
          <div class="cr-face cr-front" id="cr-front"></div>
        </div>
        <button type="button" class="cr-zoom-hit" id="cr-zoom-open" aria-label="Zum kad" hidden></button>
      </div></div></div>
    </div>
    <div class="cr-sparks" id="cr-sparks" aria-hidden="true"></div>
    <div class="cr-beat" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="cr-flash" aria-hidden="true"></div>
    <div class="cr-actions">
      <button type="button" class="cr-btn cr-btn-primary" id="cr-confirm">SAYA FAHAM</button>
      <button type="button" class="cr-btn cr-btn-ghost" id="cr-rules">LIHAT PERATURAN WATAK</button>
      <p class="cr-hint" id="cr-hint">Rahsiakan watak anda. Hanya anda boleh melihat kad ini.</p>
    </div>
    <div class="cr-curtain">
      <div class="cr-deck" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="cr-curtain-title">Watak anda sedang dipilih<span>.</span><span>.</span><span>.</span></div>
      <div class="cr-curtain-sub">Semua pemain menerima kad serentak.</div>
    </div>
    <div class="cr-wait">
      <div class="cr-wait-card" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 40 40"><path d="M8 21l8 8 16-17" fill="none" stroke="#e0b04a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="cr-wait-title">Watak anda disimpan</div>
      <div class="cr-wait-sub">Menunggu pemain lain membaca kad mereka.</div>
      <ul class="cr-wait-list" id="cr-wait-list"></ul>
      <div class="cr-hint">Pemain bot mengesahkan secara automatik.</div>
    </div>
    <div class="cr-sheet" id="cr-sheet" hidden>
      <div class="cr-sheet-panel">
        <div class="cr-sheet-handle"></div>
        <div class="cr-sheet-kicker">PERATURAN WATAK ANDA</div>
        <div class="cr-sheet-name" id="cr-sheet-name"></div>
        <div class="cr-sheet-body" id="cr-sheet-body"></div>
        <p class="cr-sheet-note">Ini ialah peraturan yang dikuatkuasakan permainan.</p>
        <button type="button" class="cr-btn cr-btn-paper" id="cr-sheet-close">TUTUP</button>
      </div>
    </div>
    <div class="cr-zoom" id="cr-zoom" hidden>
      <div class="cr-zoom-bar"><span>SERET UNTUK BACA</span><button type="button" class="cr-btn cr-btn-ghost" id="cr-zoom-close">TUTUP</button></div>
      <div class="cr-zoom-scroll"><img id="cr-zoom-img" alt=""></div>
    </div>`;
  document.body.appendChild(root);

  const sparks = $('#cr-sparks');
  SPARKS.forEach(([x, y], i) => {
    const s = document.createElement('i');
    s.style.left = `${x}%`;
    s.style.top = `${y}%`;
    s.style.setProperty('--d', `${0.35 + (i % 6) * 0.12}s`);
    s.style.setProperty('--z', `${4 + (i % 3) * 2}px`);
    sparks.appendChild(s);
  });

  const cfg = GAME_BALANCE.characters.reveal;
  root.style.setProperty('--cr-rise', `${cfg.riseMs}ms`);
  root.style.setProperty('--cr-shake', `${cfg.shakeMs}ms`);
  root.style.setProperty('--cr-flip', `${cfg.flipMs}ms`);
}

function clearTimers() {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
}

function later(ms, fn) {
  timers.push(setTimeout(fn, ms));
}

const CAPTIONS = {
  rise: ['AGIHAN SELESAI', 'Kad anda telah tiba', 'Jangan tunjuk kepada sesiapa.'],
  shake: ['MEMBUKA KAD', 'Bersedia…', 'Hanya anda yang akan tahu.'],
  flip: ['DEDAH', 'Watak anda ialah…', ''],
};

function setPhase(next) {
  phase = next;
  root.dataset.phase = next;
  let caption = CAPTIONS[next];
  if (next === 'reveal' || next === 'view') {
    const c = currentCharacter;
    caption = [next === 'view' ? 'KAD ANDA' : 'WATAK RAHSIA ANDA', c.name, `${CATEGORY_LABELS[c.category]} · ${c.role}`];
  }
  if (caption) {
    $('#cr-kicker').textContent = caption[0];
    $('#cr-title').textContent = caption[1];
    $('#cr-sub').textContent = caption[2];
  }
  const confirm = $('#cr-confirm');
  confirm.textContent = next === 'view' ? 'TUTUP' : 'SAYA FAHAM';
  $('#cr-hint').hidden = next === 'view';
  if (next === 'reveal' || next === 'view') confirm.focus({ preventScroll: true });
}

// Fills the face of the card: the artwork, or a plain text card without it.
function fillFront(character) {
  const front = $('#cr-front');
  front.innerHTML = '';
  const art = getCardArt(character.id);
  const zoomOpen = $('#cr-zoom-open');
  zoomOpen.hidden = !art;
  if (art) {
    const img = document.createElement('img');
    img.src = art;
    img.alt = `${character.name}, ${CATEGORY_LABELS[character.category]}`;
    img.decoding = 'async';
    front.appendChild(img);
    return;
  }
  const plain = document.createElement('div');
  plain.className = 'cr-plain';
  plain.dataset.cat = character.category;
  const cat = document.createElement('span');
  cat.className = 'cr-plain-cat';
  cat.textContent = CATEGORY_LABELS[character.category];
  const name = document.createElement('b');
  name.textContent = character.name;
  const role = document.createElement('em');
  role.textContent = character.role;
  plain.append(cat, name, role);
  front.appendChild(plain);
}

function ruleBlock(kind, label, name, summary, limit, options) {
  const block = document.createElement('div');
  block.className = `cr-rule cr-rule-${kind}`;
  const head = document.createElement('div');
  head.className = 'cr-rule-head';
  const tag = document.createElement('span');
  tag.className = 'cr-tag';
  tag.textContent = label;
  head.appendChild(tag);
  if (limit) {
    const lim = document.createElement('span');
    lim.className = 'cr-limit';
    lim.textContent = limit;
    head.appendChild(lim);
  }
  const title = document.createElement('div');
  title.className = 'cr-rule-name';
  title.textContent = name;
  const text = document.createElement('div');
  text.className = 'cr-rule-text';
  text.textContent = summary;
  block.append(head, title, text);
  (options || []).forEach((option) => {
    const line = document.createElement('div');
    line.className = 'cr-rule-option';
    line.textContent = `• ${option.name}${option.summary ? `: ${option.summary}` : ''}`;
    block.appendChild(line);
  });
  return block;
}

function fillRules(character) {
  $('#cr-sheet-name').textContent = character.name;
  const body = $('#cr-sheet-body');
  body.innerHTML = '';
  body.append(
    ruleBlock('special', 'SPECIAL', character.special.name, character.special.summary, limitText(character.special.limit), character.special.options),
    ruleBlock('passive', 'PASIF', character.passive.name, character.passive.summary),
    ruleBlock('weakness', 'KELEMAHAN', character.weakness.name, character.weakness.summary),
  );
}

function localCharacter(snapshot) {
  const me = snapshot?.players?.find((p) => p.id === snapshot.localPlayerId);
  return me?.character ? getCharacter(me.character.id) : null;
}

function renderWait(snapshot) {
  const list = $('#cr-wait-list');
  list.innerHTML = '';
  const waiting = new Set(snapshot?.characterReveal?.waitingIds || []);
  (snapshot?.players || []).forEach((p) => {
    const li = document.createElement('li');
    const ready = !waiting.has(p.id);
    li.className = ready ? 'is-ready' : '';
    const name = document.createElement('span');
    name.textContent = p.id === snapshot.localPlayerId ? 'Anda' : p.name;
    const status = document.createElement('b');
    status.textContent = ready ? 'BERSEDIA' : 'MEMBACA…';
    li.append(name, status);
    list.appendChild(li);
  });
}

function open() {
  returnFocus = document.activeElement;
  fillFront(currentCharacter);
  fillRules(currentCharacter);
  $('#cr-sheet').hidden = true;
  $('#cr-zoom').hidden = true;
  root.hidden = false;
  document.body.classList.add('cr-open');
}

function close({ landed = false } = {}) {
  if (!root || root.hidden) return;
  clearTimers();
  root.hidden = true;
  phase = null;
  delete root.dataset.phase;
  document.body.classList.remove('cr-open');
  const panel = $('#character-panel');
  if (landed && panel) {
    panel.classList.remove('cr-landed');
    void panel.offsetWidth; // restart the animation
    panel.classList.add('cr-landed');
    setTimeout(() => panel.classList.remove('cr-landed'), 1200);
  }
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

function startCeremony(character) {
  clearTimers();
  mode = 'ceremony';
  currentCharacter = character;
  open();
  // Warm the image while the curtain is up.
  const art = getCardArt(character.id);
  if (art) new Image().src = art;

  if (prefersReducedMotion()) {
    setPhase('reveal');
    return;
  }
  const cfg = GAME_BALANCE.characters.reveal;
  setPhase('curtain');
  later(cfg.curtainMs, () => setPhase('rise'));
  later(cfg.curtainMs + cfg.riseMs, () => {
    setPhase('shake');
    sound.playWarning();
  });
  later(cfg.curtainMs + cfg.riseMs + cfg.shakeMs, () => {
    setPhase('flip');
    sound.playPromotion();
  });
  later(cfg.curtainMs + cfg.riseMs + cfg.shakeMs + cfg.flipMs, () => setPhase('reveal'));
}

function openView() {
  const character = localCharacter(lastSnapshot);
  if (!character || !root.hidden) return;
  clearTimers();
  mode = 'view';
  currentCharacter = character;
  open();
  setPhase('view');
}

function onConfirm() {
  if (mode === 'view') {
    close();
    return;
  }
  // Mark myself ready on screen straight away; the host's broadcast confirms
  // it (and closes this screen once everyone is ready).
  if (lastSnapshot?.characterReveal) {
    lastSnapshot = {
      ...lastSnapshot,
      characterReveal: { waitingIds: lastSnapshot.characterReveal.waitingIds.filter((id) => id !== lastSnapshot.localPlayerId) },
    };
  }
  setPhase('waiting');
  renderWait(lastSnapshot);
  match.confirmCharacterReveal();
}

function onMatchUpdated(snapshot) {
  lastSnapshot = snapshot;
  const gateOpen = Boolean(snapshot.characterReveal);
  const mine = localCharacter(snapshot);

  if (gateOpen && !gateWasOpen && mine && snapshot.characterReveal.waitingIds.includes(snapshot.localPlayerId)) {
    startCeremony(mine);
  }
  gateWasOpen = gateOpen;

  if (!root || root.hidden || mode !== 'ceremony') return;
  if (snapshot.matchOver || !gateOpen) {
    close({ landed: !snapshot.matchOver });
  } else if (phase === 'waiting') {
    renderWait(snapshot);
  }
}

export function initCharacterReveal() {
  if (root) return;
  buildOverlay();
  bus.on('match:updated', (e) => onMatchUpdated(e.detail));
  bus.on('room:left', () => {
    gateWasOpen = false;
    lastSnapshot = null;
    close();
  });

  $('#cr-confirm').addEventListener('click', () => { sound.playClick(); onConfirm(); });
  $('#cr-rules').addEventListener('click', () => { $('#cr-sheet').hidden = false; $('#cr-sheet-close').focus({ preventScroll: true }); });
  $('#cr-sheet-close').addEventListener('click', () => { $('#cr-sheet').hidden = true; $('#cr-confirm').focus({ preventScroll: true }); });
  $('#cr-zoom-open').addEventListener('click', () => {
    const art = getCardArt(currentCharacter.id);
    if (!art) return;
    const img = $('#cr-zoom-img');
    img.src = art;
    img.alt = currentCharacter.name;
    $('#cr-zoom').hidden = false;
    $('#cr-zoom-close').focus({ preventScroll: true });
  });
  $('#cr-zoom-close').addEventListener('click', () => { $('#cr-zoom').hidden = true; $('#cr-confirm').focus({ preventScroll: true }); });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#cr-zoom').hidden) $('#cr-zoom').hidden = true;
    else if (!$('#cr-sheet').hidden) $('#cr-sheet').hidden = true;
    else if (mode === 'view') close();
  });

  const viewButton = $('#character-view-btn');
  if (viewButton) viewButton.addEventListener('click', () => { sound.playClick(); openView(); });
}
