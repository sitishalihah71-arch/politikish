// Screen routing + main menu / settings UI wiring. Pure UI logic - no game
// rules live here. Cross-module communication happens through `bus`.

import { $, $$, bus, loadSettings, saveSettings, randomInt, formatMoney } from './utils.js';
import * as room from './room.js';
import { HAIR_STYLES, FACE_STYLES, renderAvatarSVG } from './avatar.js';
import * as sound from './sound.js';
import * as match from './match.js';
import { RANKS, RANK_LABELS, getSeatCapacity, getNextRank } from './player.js';
import { hasOpenSeat } from './effects.js';
import * as politics from './politics.js';
import * as sabotage from './sabotage.js';
import * as opportunities from './politicalOpportunities.js';
import { SECRET_OBJECTIVES } from './objectives.js';
import { GAME_BALANCE } from './balance.js';
import { getProjekReward } from './projects.js';

let settings = loadSettings();
let toastTimer = null;
let draftAvatar = { hair: 0, face: 0 };

export function showScreen(screenName) {
  $$('.screen').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.screen === screenName);
  });
  // Lets CSS restyle things that live outside the screen (the corner icons).
  document.body.dataset.screen = screenName;
  bus.emit('ui:screen-changed', { screen: screenName });
}

export function showToast(message, duration = 3500) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    el.hidden = true;
  }, duration);
}

const JOIN_REJECT_MESSAGES = {
  'room-full': 'That room is already full.',
  'invalid-name': 'Please enter a valid name.',
};

function findLocalPlayer(snapshot) {
  return snapshot.players.find((p) => p.id === snapshot.localPlayerId) || null;
}

function applySoundUI() {
  const cornerBtn = $('#btn-sound-toggle');
  const settingSwitch = $('#setting-sound-toggle');
  const muted = settings.muted;

  cornerBtn.setAttribute('aria-pressed', String(muted));
  settingSwitch.setAttribute('aria-checked', String(!muted));
}

function setMuted(muted) {
  settings = { ...settings, muted };
  saveSettings(settings);
  applySoundUI();
  bus.emit('settings:changed', { ...settings });
}

function setVolume(volume) {
  settings = { ...settings, volume };
  saveSettings(settings);
  bus.emit('settings:changed', { ...settings });
}

function wireMainMenu() {
  $('#btn-create-room').addEventListener('click', () => {
    resetRoomHostScreen();
    showScreen('room-host');
  });

  $('#btn-join-room').addEventListener('click', () => {
    resetRoomJoinScreen();
    showScreen('room-join');
  });

  $('#btn-sound-toggle').addEventListener('click', () => {
    setMuted(!settings.muted);
  });
}

function resetRoomHostScreen() {
  $('#room-host-name').value = '';
  $('#room-host-error').hidden = true;
  $('#room-host-form-view').hidden = false;
  $('#btn-room-host-submit').disabled = false;
}

function resetRoomJoinScreen() {
  $('#room-join-name').value = '';
  $('#room-join-code').value = '';
  $('#room-join-error').hidden = true;
  $('#room-join-form-view').hidden = false;
  $('#room-join-connecting-view').hidden = true;
  $('#btn-room-join-submit').disabled = false;
}

function showRoomHostError(message) {
  const el = $('#room-host-error');
  el.textContent = message;
  el.hidden = false;
  $('#btn-room-host-submit').disabled = false;
}

function showRoomJoinError(message) {
  resetRoomJoinScreen();
  const el = $('#room-join-error');
  el.textContent = message;
  el.hidden = false;
}

function wireRoomHostScreen() {
  $('#btn-room-host-back').addEventListener('click', () => {
    room.leaveRoom();
    showScreen('main-menu');
  });

  $('#btn-room-host-submit').addEventListener('click', async () => {
    const name = $('#room-host-name').value.trim();
    if (!name) {
      showRoomHostError('Please enter your name.');
      return;
    }
    $('#room-host-error').hidden = true;
    $('#btn-room-host-submit').disabled = true;
    try {
      await room.createRoom(name);
      $('#room-host-form-view').hidden = true;
      enterCustomizeScreen();
    } catch (err) {
      showRoomHostError(err?.message || 'Could not create the room. Please try again.');
    }
  });
}

function wireRoomJoinScreen() {
  $('#btn-room-join-back').addEventListener('click', () => {
    room.leaveRoom();
    showScreen('main-menu');
  });

  $('#room-join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  $('#btn-room-join-submit').addEventListener('click', async () => {
    const name = $('#room-join-name').value.trim();
    const code = $('#room-join-code').value.trim();
    if (!name) {
      showRoomJoinError('Please enter your name.');
      return;
    }
    if (code.length !== 5) {
      showRoomJoinError('Room codes are 5 characters.');
      return;
    }
    $('#room-join-error').hidden = true;
    $('#room-join-form-view').hidden = true;
    $('#room-join-connecting-view').hidden = false;
    try {
      await room.joinRoom(code, name);
      // Success continues via the `room:joined` bus event once the host confirms.
    } catch (err) {
      const message = err?.type === 'peer-unavailable'
        ? 'Room not found. Check the code and try again.'
        : 'Could not connect. Please try again.';
      showRoomJoinError(message);
    }
  });
}

function currentLocalAvatar() {
  const snapshot = room.getRoomSnapshot();
  const me = snapshot.players.find((p) => p.id === snapshot.localPlayerId);
  return me ? { ...me.avatar } : { hair: 0, face: 0 };
}

function renderCustomizePreview() {
  $('#customize-preview').innerHTML = renderAvatarSVG(draftAvatar, 110);
  $('#customize-hair-label').textContent = `${HAIR_STYLES[draftAvatar.hair].name} · ${draftAvatar.hair + 1}/${HAIR_STYLES.length}`;
  $('#customize-face-label').textContent = `${FACE_STYLES[draftAvatar.face].name} · ${draftAvatar.face + 1}/${FACE_STYLES.length}`;
  renderCustomizeGrid('#customize-hair-grid', HAIR_STYLES, 'hair');
  renderCustomizeGrid('#customize-face-grid', FACE_STYLES, 'face');
}

// Every option is shown wearing the rest of the current draft, so the grid
// doubles as a preview of what each pick would look like.
function renderCustomizeGrid(selector, styles, key) {
  const grid = $(selector);
  grid.innerHTML = '';
  styles.forEach((style, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'customize-option';
    btn.setAttribute('aria-pressed', String(draftAvatar[key] === index));
    btn.setAttribute('aria-label', style.name);
    btn.innerHTML = renderAvatarSVG({ ...draftAvatar, [key]: index }, 44);
    const label = document.createElement('span');
    label.textContent = style.name;
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      sound.playClick();
      draftAvatar = { ...draftAvatar, [key]: index };
      renderCustomizePreview();
      room.updateLocalAvatar(draftAvatar);
    });
    grid.appendChild(btn);
  });
}

function enterCustomizeScreen() {
  draftAvatar = currentLocalAvatar();
  renderCustomizePreview();
  showScreen('customize');
}

function wireCustomizeScreen() {
  $('#btn-customize-back').addEventListener('click', () => {
    room.leaveRoom();
    showScreen('main-menu');
  });

  $('#btn-hair-prev').addEventListener('click', () => cycleHair(-1));
  $('#btn-hair-next').addEventListener('click', () => cycleHair(1));
  $('#btn-face-prev').addEventListener('click', () => cycleFace(-1));
  $('#btn-face-next').addEventListener('click', () => cycleFace(1));

  $('#btn-customize-random').addEventListener('click', () => {
    draftAvatar = {
      hair: randomInt(0, HAIR_STYLES.length - 1),
      face: randomInt(0, FACE_STYLES.length - 1),
    };
    renderCustomizePreview();
    room.updateLocalAvatar(draftAvatar);
  });

  $('#btn-customize-done').addEventListener('click', () => {
    renderLobby(room.getRoomSnapshot());
    showScreen('lobby');
  });
}

function cycleHair(delta) {
  const len = HAIR_STYLES.length;
  draftAvatar = { ...draftAvatar, hair: (draftAvatar.hair + delta + len) % len };
  renderCustomizePreview();
  room.updateLocalAvatar(draftAvatar);
}

function cycleFace(delta) {
  const len = FACE_STYLES.length;
  draftAvatar = { ...draftAvatar, face: (draftAvatar.face + delta + len) % len };
  renderCustomizePreview();
  room.updateLocalAvatar(draftAvatar);
}

function renderLobby(snapshot) {
  if (!snapshot.code) return;

  $('#lobby-code').textContent = snapshot.code;

  $('#lobby-settings-players').textContent = String(snapshot.settings.maxPlayers);
  $('#lobby-settings-rounds').textContent = String(snapshot.settings.rounds);
  const eventsBadge = $('#lobby-settings-events-badge');
  eventsBadge.textContent = `Events: ${snapshot.settings.nationalEvents ? 'ON' : 'OFF'}`;
  eventsBadge.classList.toggle('is-on', snapshot.settings.nationalEvents);
  const advancedBadge = $('#lobby-settings-advanced-badge');
  advancedBadge.textContent = `Advanced: ${snapshot.settings.advancedMode ? 'ON' : 'OFF'}`;
  advancedBadge.classList.toggle('is-on', Boolean(snapshot.settings.advancedMode));

  $('#lobby-count').textContent = `${snapshot.players.length} / ${snapshot.settings.maxPlayers}`;

  const listEl = $('#lobby-player-list');
  listEl.innerHTML = '';
  snapshot.players
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .forEach((player) => {
      const li = document.createElement('li');
      li.className = `lobby-player-row${player.connected ? '' : ' is-disconnected'}`;

      const avatar = document.createElement('div');
      avatar.className = 'lobby-player-avatar';
      avatar.innerHTML = renderAvatarSVG(player.avatar, 44);
      li.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'lobby-player-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'lobby-player-name';
      nameEl.textContent = player.name;
      if (player.isHost) {
        const tag = document.createElement('span');
        tag.className = 'player-tag';
        tag.textContent = 'Host';
        nameEl.appendChild(tag);
      }
      if (player.isBot) {
        const tag = document.createElement('span');
        tag.className = 'player-tag player-tag-bot';
        tag.textContent = 'Bot';
        nameEl.appendChild(tag);
      }
      info.appendChild(nameEl);
      if (!player.connected) {
        const status = document.createElement('span');
        status.className = 'lobby-player-status';
        status.textContent = 'Reconnecting…';
        info.appendChild(status);
      }
      li.appendChild(info);

      const badge = document.createElement('span');
      badge.className = `lobby-ready-badge${player.ready ? ' is-ready' : ''}`;
      badge.textContent = player.ready ? 'Ready' : 'Not Ready';
      li.appendChild(badge);

      if (player.isBot && snapshot.isHost) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'lobby-bot-remove';
        removeBtn.setAttribute('aria-label', `Remove ${player.name}`);
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          sound.playClick();
          room.removeBot(player.id);
        });
        li.appendChild(removeBtn);
      }

      listEl.appendChild(li);
    });

  // Open seats stay visible so the table's size reads at a glance.
  for (let i = snapshot.players.length; i < snapshot.settings.maxPlayers; i++) {
    const li = document.createElement('li');
    li.className = 'lobby-player-row is-empty';
    const ring = document.createElement('div');
    ring.className = 'lobby-empty-ring';
    li.appendChild(ring);
    const text = document.createElement('span');
    text.className = 'lobby-empty-text';
    text.textContent = 'Kosong. Menunggu pemain atau bot.';
    li.appendChild(text);
    listEl.appendChild(li);
  }

  const me = findLocalPlayer(snapshot);
  const readyBtn = $('#btn-lobby-ready');
  const isReady = Boolean(me?.ready);
  readyBtn.classList.toggle('is-ready', isReady);
  $('.menu-btn-label', readyBtn).textContent = isReady ? 'Not Ready' : 'Ready';

  $('#lobby-host-controls').hidden = !snapshot.isHost;
  $('#lobby-guest-controls').hidden = snapshot.isHost;

  if (snapshot.isHost) {
    $('#setting-lobby-players').value = String(snapshot.settings.maxPlayers);
    $('#setting-lobby-rounds').value = String(snapshot.settings.rounds);
    $('#setting-lobby-events').setAttribute('aria-checked', String(snapshot.settings.nationalEvents));
    $('#setting-lobby-parliament').setAttribute('aria-checked', String(snapshot.settings.parliamentVoting));
    $('#setting-lobby-advanced').setAttribute('aria-checked', String(Boolean(snapshot.settings.advancedMode)));

    const canStart = room.canStartMatch();
    const startBtn = $('#btn-lobby-start');
    startBtn.disabled = !canStart;
    $('#lobby-start-hint').textContent = canStart
      ? 'Ready to start!'
      : `Need ${snapshot.settings.maxPlayers} players, all ready (${snapshot.players.length}/${snapshot.settings.maxPlayers})…`;
    $('#btn-lobby-add-bot').hidden = snapshot.players.length >= snapshot.settings.maxPlayers;
  }
}

function populateSelect(selectEl, options, defaultValue) {
  selectEl.innerHTML = '';
  options.forEach((opt) => {
    const optionEl = document.createElement('option');
    optionEl.value = String(opt);
    optionEl.textContent = String(opt);
    selectEl.appendChild(optionEl);
  });
  selectEl.value = String(defaultValue);
}

function wireLobbyScreen() {
  populateSelect($('#setting-lobby-players'), GAME_BALANCE.room.playerOptions, GAME_BALANCE.room.defaultPlayers);
  populateSelect($('#setting-lobby-rounds'), GAME_BALANCE.room.roundOptions, GAME_BALANCE.room.defaultRounds);

  $('#btn-lobby-leave').addEventListener('click', () => {
    room.leaveRoom();
    showScreen('main-menu');
  });

  $('#btn-lobby-ready').addEventListener('click', () => {
    const snapshot = room.getRoomSnapshot();
    const me = findLocalPlayer(snapshot);
    room.setLocalReady(!me?.ready);
  });

  $('#btn-lobby-start').addEventListener('click', () => {
    room.startMatch();
  });

  $('#btn-lobby-add-bot').addEventListener('click', () => {
    sound.playClick();
    room.addBot();
  });

  $('#setting-lobby-players').addEventListener('change', (e) => {
    room.updateSettings({ maxPlayers: Number(e.target.value) });
  });

  $('#setting-lobby-rounds').addEventListener('change', (e) => {
    room.updateSettings({ rounds: Number(e.target.value) });
  });

  $('#setting-lobby-events').addEventListener('click', () => {
    const current = $('#setting-lobby-events').getAttribute('aria-checked') === 'true';
    room.updateSettings({ nationalEvents: !current });
  });

  $('#setting-lobby-parliament').addEventListener('click', () => {
    const current = $('#setting-lobby-parliament').getAttribute('aria-checked') === 'true';
    room.updateSettings({ parliamentVoting: !current });
  });

  $('#setting-lobby-advanced').addEventListener('click', () => {
    const current = $('#setting-lobby-advanced').getAttribute('aria-checked') === 'true';
    room.updateSettings({ advancedMode: !current });
  });
}

function wireRoomEvents() {
  bus.on('room:updated', (e) => {
    renderLobby(e.detail);
  });

  bus.on('room:joined', () => {
    $('#room-join-connecting-view').hidden = true;
    enterCustomizeScreen();
  });

  bus.on('room:join-rejected', (e) => {
    showRoomJoinError(JOIN_REJECT_MESSAGES[e.detail.reason] || 'Could not join that room.');
  });

  bus.on('room:host-disconnected', () => {
    showToast('The host ended the match.');
    showScreen('main-menu');
  });
}

// ---------- Match screen ----------

const SLOT_BADGE_COLORS = ['var(--gold)', 'var(--blue)', 'var(--green)', 'var(--purple)'];

const ACTION_REJECT_MESSAGES = {
  'no-next-rank': 'You are already President.',
  'seat-full': 'Use Sabotaj to rebut the seat.',
  'seat-not-full': 'The seat is not full — use Politik instead.',
  'invalid-target': 'Choose a valid target.',
  'invalid-amount': 'Offer at least some Money or Influence.',
  'insufficient-influence': 'Not enough Influence.',
  'insufficient-money': 'Not enough Money.',
  'insufficient-funds': 'You no longer have enough to make that offer.',
  'already-owned': 'You already own that Political Asset.',
  'duplicate-asset': 'You already own that Political Asset — no duplicates.',
  'out-of-stock': 'That asset is out of stock.',
  'market-closed': 'The Black Market is only open in Advanced Mode.',
};

let hasEnteredMatchScreen = false;
let hasEnteredMatchEndScreen = false;
let lastHandledActionSeq = -1;
let lastHandledPassiveSeq = 0;
let lastSeenEventSeq = -1;
let lastSeenVoteSeq = -1;
let voteCountdownInterval = null;
let wasMyTurn = false;
let currentAttempt = null; // { kind: 'politik' | 'sabotaj' | 'raid', targetId, assetId }
let currentDealTargetId = null;
let currentIncomingDeal = null; // { dealId, fromId, fromName, money, influence }

function makeCardLine(text, positive) {
  const div = document.createElement('div');
  div.className = `picker-card-line${positive ? ' is-positive' : ' is-negative'}`;
  div.textContent = text;
  return div;
}

const RANK_SHORT_LABELS = { ahli: 'AHLI', ketua: 'KETUA', deputy: 'TIMBALAN', president: 'PRESIDEN' };

function makeTag(text, className) {
  const tag = document.createElement('span');
  tag.className = `mtag ${className}`;
  tag.textContent = text;
  return tag;
}

function renderMatchPlayerList(snapshot) {
  const listEl = $('#match-player-list');
  listEl.innerHTML = '';
  snapshot.players
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .forEach((player) => {
      const card = document.createElement('div');
      card.className = 'match-player-card';
      card.dataset.rank = player.rank;
      if (player.id === snapshot.activePlayerId) card.classList.add('is-active-turn');
      if (!player.connected) card.classList.add('is-disconnected');

      const avatar = document.createElement('div');
      avatar.className = 'player-card-avatar';
      avatar.innerHTML = renderAvatarSVG(player.avatar, 42);
      card.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'player-card-info';
      const name = document.createElement('div');
      name.className = 'player-card-name';
      const nameText = document.createElement('span');
      nameText.textContent = player.name;
      name.appendChild(nameText);
      if (player.id === snapshot.localPlayerId) name.appendChild(makeTag('ANDA', 'mtag-you'));
      if (player.isBot) name.appendChild(makeTag('BOT', 'mtag-bot'));
      appendPublicSupportBadge(name, player);
      appendAssetBadges(name, player);
      info.appendChild(name);

      const stats = document.createElement('div');
      stats.className = 'player-card-stats';
      const scandalClass = player.scandal >= 60 ? ' stat-scandal-warn' : '';
      stats.innerHTML = `<span title="Duit">${formatMoney(player.money)}</span><span title="Influence">${player.influence} Inf</span><span class="${scandalClass}" title="Skandal">${player.scandal}%</span>`;
      info.appendChild(stats);
      card.appendChild(info);

      const side = document.createElement('div');
      side.className = 'player-card-side';
      const chip = document.createElement('span');
      chip.className = 'rank-chip';
      chip.textContent = RANK_SHORT_LABELS[player.rank] || player.rank.toUpperCase();
      side.appendChild(chip);
      const support = document.createElement('span');
      support.className = 'player-card-support';
      support.textContent = `Sokongan ${player.approval}%`;
      side.appendChild(support);
      card.appendChild(side);

      listEl.appendChild(card);
    });
}

function makeSeatStamp(kind, text) {
  const stamp = document.createElement('span');
  stamp.className = `seat-stamp seat-stamp-${kind}`;
  stamp.textContent = text;
  return stamp;
}

function renderHierarchy(snapshot) {
  const oldRects = new Map();
  $$('.hierarchy-seat[data-player-id]').forEach((el) => {
    // Clear any in-flight FLIP transform before measuring, so the
    // measurement reflects the element's true resting position rather than
    // a mid-animation transient - renders can fire in quick succession
    // (e.g. several room/match updates landing back to back around match
    // start), and measuring mid-transform would compound into a wrong delta.
    el.style.transition = 'none';
    el.style.transform = '';
    oldRects.set(el.dataset.playerId, el.getBoundingClientRect());
  });

  const seatCapacity = getSeatCapacity(snapshot.players.length);
  const localPlayer = findLocalPlayer(snapshot);
  // The tier one rank above the local player is where Politik (empty seat)
  // and Sabotaj (occupied seat) apply - mark it so the ladder shows what's
  // within reach without having to read the action descriptions.
  const targetRank = localPlayer ? getNextRank(localPlayer.rank) : null;

  RANKS.forEach((rank) => {
    const isTargetTier = rank === targetRank;
    const tierEl = $(`.hierarchy-tier[data-rank="${rank}"]`);
    tierEl.classList.toggle('is-target', isTargetTier);
    $('.tier-flag', tierEl).hidden = !isTargetTier;

    const container = $(`#seats-${rank}`);
    container.innerHTML = '';
    const occupants = snapshot.players.filter((p) => p.rank === rank).sort((a, b) => a.slot - b.slot);
    const capacity = seatCapacity[rank];
    const slotCount = Math.max(capacity, occupants.length);

    for (let i = 0; i < slotCount; i++) {
      const player = occupants[i];
      const isYou = Boolean(player) && player.id === snapshot.localPlayerId;
      const wrap = document.createElement('div');
      wrap.className = 'hierarchy-seat-wrap';

      const seat = document.createElement('div');
      const nameLabel = document.createElement('span');
      nameLabel.className = 'hierarchy-seat-name';

      if (player) {
        seat.className = `hierarchy-seat is-occupied${isYou ? ' is-you' : ''}`;
        seat.dataset.rank = rank;
        seat.dataset.playerId = player.id;
        seat.innerHTML = renderAvatarSVG(player.avatar, 60);
        nameLabel.textContent = player.name;
      } else {
        seat.className = 'hierarchy-seat is-empty';
        wrap.classList.add('is-vacant');
        nameLabel.textContent = 'Kosong';
      }

      // Asset badges are inline (a player can own several, so they can't
      // share the shield badge's single absolutely-positioned corner spot).
      if (player) appendAssetBadges(nameLabel, player);

      wrap.appendChild(seat);
      wrap.appendChild(nameLabel);

      if (isYou) wrap.appendChild(makeSeatStamp('you', 'ANDA'));
      else if (isTargetTier && player) wrap.appendChild(makeSeatStamp('sabotaj', 'SABOTAJ'));
      else if (isTargetTier) wrap.appendChild(makeSeatStamp('politik', 'POLITIK'));

      // Anchored to `wrap` (not the overflow-hidden avatar box) so the badge
      // never gets clipped by the seat's `overflow: hidden`.
      if (player) appendPublicSupportBadge(wrap, player, 'hierarchy-shield-badge');
      container.appendChild(wrap);
    }

    $(`#count-${rank}`).textContent = `${occupants.length} / ${capacity} kerusi`;
  });

  $$('.hierarchy-seat[data-player-id]').forEach((el) => {
    const oldRect = oldRects.get(el.dataset.playerId);
    if (!oldRect) return;
    const newRect = el.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (dx === 0 && dy === 0) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = '';
      el.style.transform = '';
    });
  });
}

function getScandalZone(pct) {
  if (pct >= 100) return { key: 'arrested', label: 'Ditahan' };
  if (pct >= 60) return { key: 'investigated', label: 'Disiasat' };
  if (pct >= 30) return { key: 'watched', label: 'Diperhati' };
  return { key: 'clean', label: 'Bersih' };
}

function renderStatusAssets(localPlayer) {
  const container = $('#status-assets');
  container.innerHTML = '';
  const assets = (localPlayer && localPlayer.assets) || [];
  if (!assets.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-row';
    empty.innerHTML = '<span>Tiada aset politik.</span>';
    container.appendChild(empty);
    return;
  }
  assets.forEach((asset) => {
    const def = opportunities.OPPORTUNITY_DEFINITIONS[asset.type];
    if (!def) return;
    const row = document.createElement('div');
    row.className = 'asset-row';
    const name = document.createElement('b');
    name.textContent = def.name;
    const desc = document.createElement('span');
    desc.textContent = def.description();
    row.appendChild(name);
    row.appendChild(desc);
    container.appendChild(row);
  });
}

function renderActionPanel(snapshot) {
  const localPlayer = findLocalPlayer(snapshot);
  const isMyTurn = snapshot.activePlayerId === snapshot.localPlayerId;
  const activePlayer = snapshot.players.find((p) => p.id === snapshot.activePlayerId);
  // A pending vote pauses every turn-gated action host-side (see match.js's
  // isActivePlayerId) even for the player whose turn is technically queued
  // up next - the buttons must reflect that or they'd look clickable while
  // silently doing nothing.
  const votingOpen = Boolean(snapshot.pendingVote);
  // A turn being auto-skipped (leaked Backroom Deal) is nominally the
  // benched player's turn, but the host refuses every action during it - so
  // it must read and behave as a skipped turn, not as "your turn".
  const skipping = Boolean(snapshot.skipping) && !votingOpen;
  const blocked = votingOpen || skipping;

  const turnNameEl = $('#match-turn-name');
  turnNameEl.textContent = activePlayer ? activePlayer.name : '-';
  turnNameEl.hidden = isMyTurn;
  if (activePlayer && !isMyTurn) appendPublicSupportBadge(turnNameEl, activePlayer);
  $('#match-turn-label').textContent = skipping ? 'GILIRAN DILANGKAU' : isMyTurn ? 'GILIRAN ANDA' : 'GILIRAN';
  $('#match-turn-banner').classList.toggle('is-my-turn', isMyTurn && !blocked);
  $('#match-turn-banner').classList.toggle('is-skipping', skipping);
  $('#match-turn-hint').textContent = votingOpen
    ? 'Undian Parlimen sedang berlangsung.'
    : skipping
      ? (isMyTurn ? 'Perjanjian anda bocor — giliran ini dilangkau.' : `${activePlayer ? activePlayer.name : 'Pemain'} kehilangan giliran (perjanjian bocor).`)
      : isMyTurn
        ? 'Pilih 1 tindakan di bawah.'
        : activePlayer ? `Menunggu ${activePlayer.name}…` : '';
  renderVoteTimer(snapshot.pendingVote);

  const isPresident = localPlayer && localPlayer.rank === 'president';

  $('#btn-action-projek').disabled = !isMyTurn || blocked;
  $('#btn-action-politik').disabled = !isMyTurn || isPresident || blocked;
  $('#btn-action-sabotaj').disabled = !isMyTurn || isPresident || blocked;
  $('#btn-action-media').disabled = !isMyTurn || blocked;
  // Raid isn't tied to rank progression the way Sabotaj/Politik are, so
  // it's available to a President too - only turn-gated.
  $('#btn-action-raid').disabled = !isMyTurn || blocked;
  // The Black Market only exists in Advanced Mode.
  $('#btn-action-market').disabled = !isMyTurn || blocked || !snapshot.advancedMode;

  // Whatever picker the player had open belongs to a turn that is no longer
  // theirs to act on - close it rather than leave a dead modal on screen.
  // (Backroom Deals aren't turn-gated, so their target picker stays.)
  if (blocked || !isMyTurn) {
    const stale = ['action-picker-modal', 'attempt-modal'];
    if (targetPickerMode !== 'deal') stale.push('target-picker-modal');
    stale.forEach((id) => {
      const modal = document.getElementById(id);
      if (modal) modal.hidden = true;
    });
  }

  const skipBtn = $('#btn-host-skip');
  skipBtn.hidden = !snapshot.isHost;
  if (snapshot.isHost) {
    skipBtn.textContent = activePlayer ? `Skip ${activePlayer.name}'s Turn` : 'Skip Turn';
  }

  if (localPlayer) {
    $('#status-title').textContent = `Laporan ${localPlayer.name}`;
    const rankChip = $('#status-rank');
    rankChip.dataset.rank = localPlayer.rank;
    rankChip.textContent = RANK_LABELS[localPlayer.rank].toUpperCase();

    const pct = localPlayer.scandal;
    const zone = getScandalZone(pct);
    $('#match-scandal-pct').textContent = `${pct}%`;
    $('#match-scandal-zone').textContent = zone.label;
    $('#scandal-bar').dataset.zone = zone.key;
    $('#scandal-bar-fill').style.width = `${Math.min(100, pct)}%`;

    const approvalPct = localPlayer.approval;
    $('#match-approval-pct').textContent = `${approvalPct}%`;
    $('#approval-bar-fill').style.width = `${approvalPct}%`;
  }

  renderActionChips(localPlayer, snapshot);
  renderStatusAssets(localPlayer);
  renderPoliticalNetwork(localPlayer);
  renderSecretObjective(localPlayer);
}

// The action cards advertise what they'd cost right now (a base attempt with
// no extra Influence) so the dock reads at a glance; the attempt modal still
// has the real sliders. Projek/Kempen Imej keep their static labels - the
// first never costs anything and the second's price depends on the card dealt.
function setActionChips(buttonId, labels) {
  const chips = $$(`#${buttonId} .action-chips span`);
  labels.forEach((label, i) => {
    if (chips[i]) chips[i].textContent = label;
  });
}

function renderActionChips(localPlayer, snapshot) {
  if (!localPlayer) return;
  const rank = localPlayer.rank;
  const percent = (value) => `${Math.round(value * 100)}%`;

  if (politics.PROMOTION_TABLE[rank]) {
    const hasMachinery = (localPlayer.assets || []).some((a) => a.type === 'partyMachinery');
    setActionChips('btn-action-politik', [
      `${politics.getPolitikCost(rank, 0)} Inf`,
      percent(politics.calculatePolitikChance(rank, 0, hasMachinery)),
    ]);
    setActionChips('btn-action-sabotaj', [
      `${sabotage.getSabotajCost(rank, 0)} Inf`,
      percent(sabotage.SABOTAGE_TABLE[rank].baseChance),
    ]);
  } else {
    setActionChips('btn-action-politik', ['Pangkat tertinggi', '']);
    setActionChips('btn-action-sabotaj', ['Pangkat tertinggi', '']);
  }

  setActionChips('btn-action-raid', [`${opportunities.getRaidCost(0)} Inf`, percent(opportunities.describeRaidChance(0).base)]);
  if (snapshot && snapshot.advancedMode) {
    const left = (snapshot.marketStock || []).length;
    setActionChips('btn-action-market', [formatMoney(GAME_BALANCE.blackMarket.price), `+${GAME_BALANCE.blackMarket.scandalGain}% Skandal · ${left} stok`]);
  } else {
    setActionChips('btn-action-market', ['Ditutup', 'Advanced sahaja']);
  }
}

// Secret Objective data only ever appears on the local player's own entry
// (see match.js's maskPlayersFor, which strips it exactly like
// politicalNetwork/hasKabel) - this panel is never rendered for anyone
// else's data, by construction.
function renderSecretObjective(localPlayer) {
  const panel = $('#secret-objective-panel');
  if (!localPlayer || !localPlayer.secretObjective) {
    panel.hidden = true;
    return;
  }
  const definition = SECRET_OBJECTIVES.find((o) => o.id === localPlayer.secretObjective.id);
  if (!definition) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#secret-objective-description').textContent = definition.description;
  const statusEl = $('#secret-objective-status');
  const completed = localPlayer.secretObjective.completed;
  statusEl.textContent = completed ? 'Selesai' : 'Belum selesai';
  statusEl.classList.toggle('is-complete', completed);
}

// Political Network progress and KABEL ownership only ever appear on the
// *local* player's own entry (see match.js's maskPlayersFor) - this panel
// is never rendered for anyone else's data, by construction, not just by
// convention.
const POLITICAL_NETWORK_THRESHOLD = GAME_BALANCE.politicalNetwork.threshold;
let hadKabel = false;

function renderPoliticalNetwork(localPlayer) {
  if (!localPlayer || !localPlayer.politicalNetwork) return;
  const { politicalNetwork } = localPlayer;
  ['infrastructure', 'publicServices', 'administration'].forEach((key) => {
    const value = politicalNetwork[key];
    $(`#pn-${key}`).textContent = `${value}/${POLITICAL_NETWORK_THRESHOLD}`;
    $$(`.pn-track[data-pn="${key}"] i`).forEach((pip, index) => {
      pip.classList.toggle('is-on', index < value);
    });
  });

  if (localPlayer.hasKabel && !hadKabel) {
    showToast('🕴️ Your political network paid off - you secretly hold KABEL!', 5000);
    sound.playPromotion();
  }
  hadKabel = Boolean(localPlayer.hasKabel);
}

function renderBottomBar(snapshot) {
  const localPlayer = findLocalPlayer(snapshot);
  if (!localPlayer) return;
  $('#bottom-money').textContent = formatMoney(localPlayer.money);
  $('#bottom-influence').textContent = String(localPlayer.influence);
  $('#bottom-scandal').textContent = `${localPlayer.scandal}%`;
  $('#bottom-rank').textContent = RANK_LABELS[localPlayer.rank];
  $('#status-money').textContent = formatMoney(localPlayer.money);
  $('#status-influence').textContent = String(localPlayer.influence);
}

const MONEY_ICON = '💰';
const INFLUENCE_ICON = '⭐';
const SCANDAL_ICON = '⚠️';
const SHIELD_ICON = '🛡️';
const CATEGORY_LABELS = {
  infrastructure: '🏗️ Infrastructure',
  publicServices: '🏥 Public Services',
  administration: '🏢 Administration',
};
const PUBLIC_SUPPORT_TOOLTIP = `Public Support - Incoming Scandal reduced by ${GAME_BALANCE.publicSupport.scandalReduction}%. Enemy Sabotaj success chance reduced by ${GAME_BALANCE.sabotage.publicSupportPenalty}%.`;

// Appends a "🛡️N" badge after a player's name wherever it's displayed, so
// Public Support is visible at a glance in every player-name spot in the UI.
function appendPublicSupportBadge(container, player, extraClass) {
  if (!(player.publicSupportTurns > 0)) return;
  const badge = document.createElement('span');
  badge.className = extraClass ? `public-support-badge ${extraClass}` : 'public-support-badge';
  badge.textContent = `${SHIELD_ICON}${player.publicSupportTurns}`;
  badge.title = PUBLIC_SUPPORT_TOOLTIP;
  container.appendChild(badge);
}

// Political Assets are public (unlike Public Support's badge, this is
// about broadcasting "here's what's worth raiding from me", not a private
// buff indicator) - one small icon badge per owned asset.
function appendAssetBadges(container, player, extraClass) {
  (player.assets || []).forEach((asset) => {
    const def = opportunities.OPPORTUNITY_DEFINITIONS[asset.type];
    if (!def) return;
    const badge = document.createElement('span');
    badge.className = extraClass ? `asset-badge ${extraClass}` : 'asset-badge';
    badge.textContent = def.icon;
    badge.title = `${def.name} - ${def.description()}`;
    container.appendChild(badge);
  });
}

function describeMediaCardLine(card) {
  const lines = [];
  if (card.kind === 'direct') {
    if (card.scandalDelta) lines.push(makeCardLine(`${SCANDAL_ICON} ${card.scandalDelta}% Scandal`, card.scandalDelta < 0));
    if (card.influenceDelta) lines.push(makeCardLine(`${INFLUENCE_ICON} +${card.influenceDelta} Influence`, true));
    if (card.supportTurns) lines.push(makeCardLine(`${SHIELD_ICON} Public Support ${card.supportTurns} Turns`, true));
  } else if (card.kind === 'target') {
    lines.push(makeCardLine(`${SCANDAL_ICON} You: ${card.selfScandalDelta}% Scandal`, true));
    lines.push(makeCardLine(`${SCANDAL_ICON} Target: +${card.targetScandalDelta}% Scandal`, false));
  } else if (card.kind === 'chance') {
    lines.push(makeCardLine(`${SCANDAL_ICON} 50% Success: ${card.successScandalDelta}% Scandal`, true));
    lines.push(makeCardLine(`${SCANDAL_ICON} 50% Fail: +${card.failScandalDelta}% Scandal`, false));
  }
  return lines;
}

function openOffersModal(action, offers) {
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);

  $('#picker-title').textContent = action === 'projek' ? 'Pilih Projek' : action === 'market' ? 'Black Market' : 'Pilih Kempen Imej';
  const container = $('#picker-cards');
  container.innerHTML = '';

  // Black Market offers are plain asset-type strings, not card objects -
  // a distinct enough shape that it gets its own short branch rather than
  // threading a third case through the projek/media logic below.
  if (action === 'market') {
    const price = GAME_BALANCE.blackMarket.price;
    const stock = snapshot.marketStock || [];
    offers.forEach((assetType) => {
      const def = opportunities.OPPORTUNITY_DEFINITIONS[assetType];
      const left = stock.filter((t) => t === assetType).length;
      const btn = document.createElement('button');
      btn.className = 'picker-card-item';
      btn.type = 'button';

      const name = document.createElement('div');
      name.className = 'picker-card-name';
      name.textContent = `${def.icon} ${def.name}`;
      btn.appendChild(name);
      btn.appendChild(makeCardLine(def.description(), true));
      btn.appendChild(makeCardLine(`${MONEY_ICON} Cost: ${formatMoney(price)}`, false));
      btn.appendChild(makeCardLine(`${SCANDAL_ICON} +${GAME_BALANCE.blackMarket.scandalGain}% Scandal`, false));
      btn.appendChild(makeCardLine(`📦 Stock left: ${left}`, true));
      btn.disabled = localPlayer.money < price;

      btn.addEventListener('click', () => {
        sound.playClick();
        $('#action-picker-modal').hidden = true;
        match.chooseMarketAsset(assetType);
      });

      container.appendChild(btn);
    });
    $('#action-picker-modal').hidden = false;
    return;
  }

  offers.forEach((card) => {
    const btn = document.createElement('button');
    btn.className = 'picker-card-item';
    btn.type = 'button';

    const name = document.createElement('div');
    name.className = 'picker-card-name';
    name.textContent = card.name;
    btn.appendChild(name);

    if (action === 'projek' && card.category) {
      const category = document.createElement('div');
      category.className = 'picker-card-category';
      category.textContent = CATEGORY_LABELS[card.category] || card.category;
      btn.appendChild(category);
    }

    if (action === 'projek') {
      // Show what this player would actually be paid (table-size scaling and
      // Corporate Sponsor included), not the card's face values.
      const reward = getProjekReward(localPlayer, card, snapshot.players.length);
      btn.appendChild(makeCardLine(`${MONEY_ICON} +${formatMoney(reward.money)}${reward.sponsorBoosted ? ' 🏦' : ''}`, true));
      btn.appendChild(makeCardLine(`${INFLUENCE_ICON} +${reward.influence} Influence`, true));
      btn.appendChild(makeCardLine(`${SCANDAL_ICON} +${card.scandal}% Scandal`, false));
    } else {
      btn.appendChild(makeCardLine(`${MONEY_ICON} Cost: ${formatMoney(card.cost)}`, false));
      describeMediaCardLine(card).forEach((line) => btn.appendChild(line));
      btn.disabled = localPlayer.money < card.cost;
    }

    btn.addEventListener('click', () => {
      sound.playClick();
      $('#action-picker-modal').hidden = true;
      if (action === 'projek') {
        match.chooseProjekCard(card.id);
      } else if (card.kind === 'target') {
        openTargetPicker({ mode: 'media', cardId: card.id });
      } else {
        match.chooseMediaCard(card.id, null);
      }
    });

    container.appendChild(btn);
  });

  $('#action-picker-modal').hidden = false;
}

function makeTargetPickerRow(player, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'target-picker-item';
  btn.type = 'button';

  const avatar = document.createElement('div');
  avatar.className = 'lobby-player-avatar';
  avatar.innerHTML = renderAvatarSVG(player.avatar, 36);
  btn.appendChild(avatar);

  const name = document.createElement('span');
  name.textContent = label;
  btn.appendChild(name);

  btn.addEventListener('click', onClick);
  return btn;
}

// Every (owner, asset) pair the local player could actually take: another
// player's asset of a type the local player doesn't already hold - stealing
// a copy of something they own would just be a wasted turn (and the host
// refuses it as 'duplicate-asset').
function getRaidableAssets(snapshot, localPlayer) {
  const ownedTypes = new Set((localPlayer.assets || []).map((a) => a.type));
  return snapshot.players
    .filter((p) => p.id !== localPlayer.id)
    .flatMap((p) => (p.assets || []).map((asset) => ({ player: p, asset })))
    .filter(({ asset }) => !ownedTypes.has(asset.type));
}

let targetPickerMode = null;

function openTargetPicker(context) {
  targetPickerMode = context.mode;
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);

  // Political Raid targets a specific (player, asset) pair, not just a
  // player - flatten every other player's owned assets into one list so
  // there's no separate "now pick which asset" step.
  if (context.mode === 'raid') {
    $('#target-picker-title').textContent = 'Pilih Aset untuk Dirampas';
    $('#kabel-banner').hidden = true;
    const listEl = $('#target-picker-list');
    listEl.innerHTML = '';
    const rows = getRaidableAssets(snapshot, localPlayer);
    rows.forEach(({ player, asset }) => {
      const def = opportunities.OPPORTUNITY_DEFINITIONS[asset.type];
      const label = `${player.name} — ${def ? `${def.icon} ${def.name}` : asset.type}`;
      listEl.appendChild(makeTargetPickerRow(player, label, () => {
        sound.playClick();
        $('#target-picker-modal').hidden = true;
        openAttemptModal('raid', player.id, false, asset.id);
      }));
    });
    $('#target-picker-modal').hidden = false;
    return;
  }

  // Backroom Deal just needs a target to open the offer modal against -
  // resolution isn't a chance roll like the other actions.
  if (context.mode === 'deal') {
    $('#target-picker-title').textContent = 'Pilih Sasaran Backroom Deal';
    $('#kabel-banner').hidden = true;
    const listEl = $('#target-picker-list');
    listEl.innerHTML = '';
    snapshot.players
      .filter((p) => p.id !== localPlayer.id && p.connected)
      .forEach((player) => {
        listEl.appendChild(makeTargetPickerRow(player, player.name, () => {
          sound.playClick();
          $('#target-picker-modal').hidden = true;
          openDealOfferModal(player);
        }));
      });
    $('#target-picker-modal').hidden = false;
    return;
  }

  const localRankIndex = RANKS.indexOf(localPlayer.rank);
  const candidates = context.mode === 'sabotaj'
    ? (context.isKabel
        ? snapshot.players.filter((p) => p.id !== localPlayer.id && RANKS.indexOf(p.rank) > localRankIndex)
        : snapshot.players.filter((p) => p.rank === context.rank && p.id !== localPlayer.id))
    : snapshot.players.filter((p) => p.id !== localPlayer.id && p.connected);

  $('#target-picker-title').textContent = context.mode === 'sabotaj' ? 'Pilih Sasaran Sabotaj' : 'Pilih Sasaran';
  $('#kabel-banner').hidden = !context.isKabel;
  const listEl = $('#target-picker-list');
  listEl.innerHTML = '';

  candidates.forEach((player) => {
    const btn = document.createElement('button');
    btn.className = 'target-picker-item';
    btn.type = 'button';

    const avatar = document.createElement('div');
    avatar.className = 'lobby-player-avatar';
    avatar.innerHTML = renderAvatarSVG(player.avatar, 36);
    btn.appendChild(avatar);

    const name = document.createElement('span');
    name.textContent = player.name;
    appendPublicSupportBadge(name, player);
    btn.appendChild(name);

    btn.addEventListener('click', () => {
      sound.playClick();
      $('#target-picker-modal').hidden = true;
      if (context.mode === 'sabotaj') {
        openAttemptModal('sabotaj', player.id, context.isKabel);
      } else {
        match.chooseMediaCard(context.cardId, player.id);
      }
    });

    listEl.appendChild(btn);
  });

  $('#target-picker-modal').hidden = false;
}

// Composing an offer never touches match.js/the network until Send is
// clicked - the slider max is just this player's own current holdings, so
// they physically can't compose an offer they can't afford.
function openDealOfferModal(target) {
  currentDealTargetId = target.id;
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);

  $('#deal-offer-target-line').textContent = `Offer to: ${target.name}`;

  const moneySlider = $('#deal-offer-money-slider');
  moneySlider.min = '0';
  moneySlider.max = String(localPlayer.money);
  moneySlider.step = '1000';
  moneySlider.value = '0';
  moneySlider.oninput = () => { $('#deal-offer-money-value').textContent = formatMoney(Number(moneySlider.value)); };

  const influenceSlider = $('#deal-offer-influence-slider');
  influenceSlider.min = '0';
  influenceSlider.max = String(localPlayer.influence);
  influenceSlider.step = '50';
  influenceSlider.value = '0';
  influenceSlider.oninput = () => { $('#deal-offer-influence-value').textContent = `+${influenceSlider.value}`; };

  $('#deal-offer-money-value').textContent = formatMoney(0);
  $('#deal-offer-influence-value').textContent = '+0';
  $('#deal-offer-error').hidden = true;
  $('#deal-offer-modal').hidden = false;
}

function makeBreakdownRow(label, value, cls) {
  const row = document.createElement('div');
  row.className = `attempt-breakdown-row${cls ? ` ${cls}` : ''}`;
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

// Centralizes the "which cost/chance table applies" branching so both the
// slider setup (openAttemptModal) and the live preview (updateAttemptPreview)
// stay in sync instead of re-deriving it separately. Kabel is just Sabotaj
// with the target-rank-keyed KABEL_TABLE/cost instead of the attacker-rank
// one - same math, same confirmation dialog.
// Owned Political Assets change the real odds (Party Machinery for the
// attacker's Politik, Royal Connection for a Sabotaj/Kabel target), so the
// preview has to know about them or it would quote the wrong chance.
let attemptCtx = { hasMachinery: false, targetRoyal: false };
const PARTY_MACHINERY_BONUS = GAME_BALANCE.politicalOpportunity.assets.partyMachinery.promotionChanceBonusPercent / 100;

function resolveAttemptConfig(kind, fromRank, isKabel, targetRank) {
  if (kind === 'raid') {
    return {
      baseCost: opportunities.getRaidCost(0),
      baseChance: opportunities.describeRaidChance(0).base,
      step: GAME_BALANCE.politicalOpportunity.raid.extraInfluenceStep,
      bonus: GAME_BALANCE.politicalOpportunity.raid.extraInfluenceBonus / 100,
      maxChance: GAME_BALANCE.politicalOpportunity.raid.maxChance / 100,
      getCost: (extra) => opportunities.getRaidCost(extra),
      getChance: (extra) => opportunities.calculateRaidChance(extra),
      describe: null,
    };
  }
  if (kind === 'politik') {
    const config = politics.PROMOTION_TABLE[fromRank];
    const machinery = attemptCtx.hasMachinery ? PARTY_MACHINERY_BONUS : 0;
    return {
      baseCost: config.baseCost,
      baseChance: config.baseChance + machinery,
      step: politics.PROMOTION_EXTRA_STEP,
      bonus: politics.PROMOTION_EXTRA_BONUS,
      maxChance: politics.PROMOTION_MAX_CHANCE,
      getCost: (extra) => politics.getPolitikCost(fromRank, extra),
      getChance: (extra) => politics.calculatePolitikChance(fromRank, extra, attemptCtx.hasMachinery),
      describe: (extra) => {
        const final = politics.calculatePolitikChance(fromRank, extra, attemptCtx.hasMachinery);
        return { base: config.baseChance, machinery, extraBonus: Math.max(0, final - config.baseChance - machinery), final };
      },
    };
  }
  if (isKabel) {
    return {
      baseCost: sabotage.KABEL_COST,
      baseChance: sabotage.KABEL_TABLE[targetRank].chance,
      step: sabotage.SABOTAGE_EXTRA_STEP,
      bonus: sabotage.SABOTAGE_EXTRA_BONUS,
      maxChance: sabotage.SABOTAGE_MAX_CHANCE,
      getCost: (extra) => sabotage.getKabelCost(extra),
      getChance: (extra, support) => sabotage.calculateKabelChance(targetRank, extra, support, attemptCtx.targetRoyal),
      describe: (extra, support) => sabotage.describeKabelChance(targetRank, extra, support, attemptCtx.targetRoyal),
    };
  }
  return {
    baseCost: sabotage.SABOTAGE_TABLE[fromRank].baseCost,
    baseChance: sabotage.SABOTAGE_TABLE[fromRank].baseChance,
    step: sabotage.SABOTAGE_EXTRA_STEP,
    bonus: sabotage.SABOTAGE_EXTRA_BONUS,
    maxChance: sabotage.SABOTAGE_MAX_CHANCE,
    getCost: (extra) => sabotage.getSabotajCost(fromRank, extra),
    getChance: (extra, support) => sabotage.calculateSabotajChance(fromRank, extra, support, attemptCtx.targetRoyal),
    describe: (extra, support) => sabotage.describeSabotajChance(fromRank, extra, support, attemptCtx.targetRoyal),
  };
}

function renderSabotajBreakdown(breakdown, targetHasPublicSupport) {
  const el = $('#attempt-breakdown');
  el.innerHTML = '';
  el.appendChild(makeBreakdownRow('Base Chance', `${Math.round(breakdown.base * 100)}%`));
  el.appendChild(makeBreakdownRow('Extra Influence', `+${Math.round(breakdown.extraBonus * 100)}%`, 'is-positive'));
  if (targetHasPublicSupport) {
    el.appendChild(makeBreakdownRow(`${SHIELD_ICON} Public Support`, `-${Math.round(breakdown.publicSupportPenalty * 100)}%`, 'is-negative'));
  }
  if (breakdown.royalConnectionPenalty) {
    el.appendChild(makeBreakdownRow('👑 Royal Connection', `-${Math.round(breakdown.royalConnectionPenalty * 100)}%`, 'is-negative'));
  }
  el.appendChild(makeBreakdownRow('Final Chance', `${Math.round(breakdown.final * 100)}%`, 'is-final'));
  el.hidden = false;
}

function renderPolitikBreakdown(breakdown) {
  const el = $('#attempt-breakdown');
  el.innerHTML = '';
  el.appendChild(makeBreakdownRow('Base Chance', `${Math.round(breakdown.base * 100)}%`));
  if (breakdown.machinery) {
    el.appendChild(makeBreakdownRow('⚙️ Party Machinery', `+${Math.round(breakdown.machinery * 100)}%`, 'is-positive'));
  }
  el.appendChild(makeBreakdownRow('Extra Influence', `+${Math.round(breakdown.extraBonus * 100)}%`, 'is-positive'));
  el.appendChild(makeBreakdownRow('Final Chance', `${Math.round(breakdown.final * 100)}%`, 'is-final'));
  el.hidden = false;
}

function updateAttemptPreview(kind, fromRank, localPlayer, extra, targetHasPublicSupport, isKabel, targetRank) {
  const config = resolveAttemptConfig(kind, fromRank, isKabel, targetRank);
  const cost = config.getCost(extra);
  const chance = config.getChance(extra, targetHasPublicSupport);

  $('#attempt-extra-value').textContent = `+${extra}`;
  $('#attempt-cost').textContent = String(cost);
  $('#attempt-chance').textContent = `${Math.round(chance * 100)}%`;

  if (kind === 'sabotaj') {
    renderSabotajBreakdown(config.describe(extra, targetHasPublicSupport), targetHasPublicSupport);
  } else if (kind === 'politik') {
    renderPolitikBreakdown(config.describe(extra));
  } else {
    $('#attempt-breakdown').hidden = true;
  }

  const affordable = localPlayer.influence >= cost;
  $('#btn-attempt-confirm').disabled = !affordable;
  $('#attempt-error').hidden = affordable;
  if (!affordable) $('#attempt-error').textContent = 'Not enough Influence.';
}

function openAttemptModal(kind, targetId, isKabel = false, assetId = null) {
  currentAttempt = { kind, targetId, assetId };
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);
  const fromRank = localPlayer.rank;
  const target = kind !== 'politik' ? snapshot.players.find((p) => p.id === targetId) : null;
  const targetHasPublicSupport = Boolean(target && target.publicSupportTurns > 0);
  const targetRank = target ? target.rank : null;
  attemptCtx = {
    hasMachinery: (localPlayer.assets || []).some((a) => a.type === 'partyMachinery'),
    targetRoyal: Boolean(target && (target.assets || []).some((a) => a.type === 'royalConnection')),
  };

  const titles = { politik: 'Politik', raid: 'Political Raid', sabotaj: isKabel ? '🕴️ KABEL' : 'Sabotaj' };
  $('#attempt-title').textContent = titles[kind];
  $('#btn-attempt-confirm .menu-btn-label').textContent = kind === 'politik' ? 'Confirm' : 'Attack';

  const targetLine = $('#attempt-target-line');
  if (kind === 'raid') {
    const def = opportunities.OPPORTUNITY_DEFINITIONS[snapshot.players.find((p) => p.id === targetId)?.assets.find((a) => a.id === assetId)?.type];
    targetLine.textContent = `Target: ${target ? target.name : ''} — ${def ? def.name : ''}`;
    targetLine.hidden = false;
  } else if (kind === 'sabotaj') {
    targetLine.textContent = '';
    targetLine.appendChild(document.createTextNode(`Target: ${target ? target.name : ''}`));
    if (target) appendPublicSupportBadge(targetLine, target);
    targetLine.hidden = false;
  } else {
    targetLine.hidden = true;
  }

  const config = resolveAttemptConfig(kind, fromRank, isKabel, targetRank);
  const { maxChance, bonus, step, baseCost } = config;

  const maxStepsForChance = Math.ceil((maxChance - config.baseChance) / bonus);
  const maxAffordableExtra = Math.max(0, localPlayer.influence - baseCost);
  const maxExtraSteps = Math.min(maxStepsForChance, Math.floor(maxAffordableExtra / step));
  const maxExtra = Math.max(0, maxExtraSteps * step);

  const slider = $('#attempt-extra-slider');
  slider.min = '0';
  slider.max = String(maxExtra);
  slider.step = String(step);
  slider.value = '0';
  slider.oninput = () => updateAttemptPreview(kind, fromRank, localPlayer, Number(slider.value), targetHasPublicSupport, isKabel, targetRank);

  updateAttemptPreview(kind, fromRank, localPlayer, 0, targetHasPublicSupport, isKabel, targetRank);
  $('#attempt-modal').hidden = false;
}

function handleActionFeedback(snapshot) {
  handleActionResult(snapshot);
  handlePassivePayout(snapshot);
}

function handleActionResult(snapshot) {
  const action = snapshot.lastAction;
  const isNewAction = action && action.seq !== lastHandledActionSeq;
  if (!isNewAction) return;
  lastHandledActionSeq = action.seq;

  const actor = snapshot.players.find((p) => p.id === action.actorId);
  const actorName = actor ? actor.name : 'Someone';
  let message = '';

  if (action.type === 'projek') {
    const reward = action.card.reward || { money: action.card.money, influence: action.card.influence };
    message = `${actorName} used ${action.card.name}: +${formatMoney(reward.money)}, +${reward.influence} Influence`;
    if (reward.sponsorBoosted) message += ' (Corporate Sponsor +20%)';
    sound.playCoins();
  } else if (action.type === 'media') {
    message = `${actorName} used ${action.card.name}`;
    if (action.card.kind === 'chance') message += action.success ? ' — Success!' : ' — Failed.';
    sound.playCoins();
  } else if (action.type === 'politik') {
    const odds = `${Math.round(action.chance * 100)}%${action.partyMachinery ? ', Party Machinery' : ''}`;
    message = action.success
      ? `${actorName} was promoted to ${RANK_LABELS[action.toRank]}! (${odds})`
      : `${actorName}'s Politik attempt failed. (${odds})`;
    if (action.success) sound.playPromotion(); else sound.playFailure();
  } else if (action.type === 'sabotaj') {
    const target = snapshot.players.find((p) => p.id === action.targetId);
    const targetName = target ? target.name : 'a player';
    const label = action.isKabel ? 'KABEL' : 'Sabotaj';
    message = action.success
      ? `${actorName} used ${label} on ${targetName} and took their seat!`
      : `${actorName}'s ${label} on ${targetName} failed.${action.targetRoyal ? ' (Royal Connection protected them)' : ''}`;
    if (action.success) sound.playPromotion(); else sound.playFailure();
  } else if (action.type === 'raid') {
    const target = snapshot.players.find((p) => p.id === action.targetId);
    const targetName = target ? target.name : 'a player';
    const assetDef = opportunities.OPPORTUNITY_DEFINITIONS[action.assetType];
    const assetName = assetDef ? `${assetDef.icon} ${assetDef.name}` : 'an asset';
    message = action.success
      ? `${actorName} raided ${targetName} and stole ${assetName}!`
      : `${actorName}'s raid on ${targetName} failed — ${assetName} stays put.`;
    if (action.success) sound.playPromotion(); else sound.playFailure();
  } else if (action.type === 'market') {
    const assetDef = opportunities.OPPORTUNITY_DEFINITIONS[action.assetType];
    const assetName = assetDef ? `${assetDef.icon} ${assetDef.name}` : 'an asset';
    message = `${actorName} bought ${assetName} on the Black Market for ${formatMoney(action.price)}`;
    if (action.scandalGain) message += ` (+${action.scandalGain}% Scandal)`;
    sound.playCoins();
  } else if (action.type === 'skip') {
    message = action.reason === 'bribery-leak'
      ? `${actorName}'s turn was skipped — their backroom deal leaked!`
      : `Host skipped ${actorName}'s turn.`;
    sound.playWarning();
  }

  if (message) {
    showToast(message, 4000);
    pushFeed(message, action.type, snapshot.round);
  }

  if (snapshot.lastPenalized && snapshot.lastPenalized.length) {
    snapshot.lastPenalized.forEach((pid) => {
      const p = snapshot.players.find((pl) => pl.id === pid);
      if (!p) return;
      const penaltyMessage = `${p.name} hit 100% Scandal — lost 50% money and dropped a rank.`;
      showToast(penaltyMessage, 4500);
      pushFeed(penaltyMessage, 'scandal', snapshot.round);
    });
    sound.playWarning();
  }
}

// Media Empire pays out at the round boundary with no action behind it, so
// it's tracked on its own seq rather than riding on `lastAction`.
function handlePassivePayout(snapshot) {
  const payout = snapshot.passivePayout;
  if (payout && payout.seq !== lastHandledPassiveSeq) {
    lastHandledPassiveSeq = payout.seq;
    const names = payout.ownerIds
      .map((id) => snapshot.players.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    const payoutMessage = `📺 Media Empire paid +${payout.amount} Influence to ${names}.`;
    pushFeed(payoutMessage, 'media_empire', payout.round);
    if (payout.ownerIds.includes(snapshot.localPlayerId)) showToast(`📺 Media Empire: +${payout.amount} Influence`, 3500);
  }
}

// Full per-player match summary (Feature 8) - Money/Influence/Scandal plus
// the counters tracked in player.stats throughout the match.
function makeStatsGrid(player) {
  const grid = document.createElement('div');
  grid.className = 'match-end-stats-grid';
  const rows = [
    ['Money', formatMoney(player.money)],
    ['Influence', String(player.influence)],
    ['Scandal', `${player.scandal}%`],
    ['Projects', String(player.stats.projectsCompleted)],
    ['Promotions', String(player.stats.promotionsSucceeded)],
    ['Sabotages', String(player.stats.sabotagesSucceeded)],
    ['Media Used', String(player.stats.mediaCardsUsed)],
    ['Turns', String(player.stats.turnsPlayed)],
  ];
  // Only ever present on the local player's own card - secretObjective is
  // masked out of everyone else's data (see match.js's maskPlayersFor).
  if (player.secretObjective) {
    const definition = SECRET_OBJECTIVES.find((o) => o.id === player.secretObjective.id);
    if (definition) rows.push(['Secret Objective', `${definition.name}${player.secretObjective.completed ? ' ✅' : ''}`]);
  }
  rows.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.className = 'match-end-stat-item';
    const labelEl = document.createElement('span');
    labelEl.className = 'match-end-stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'match-end-stat-value';
    valueEl.textContent = value;
    item.appendChild(labelEl);
    item.appendChild(valueEl);
    grid.appendChild(item);
  });
  return grid;
}

function renderMatchEnd(snapshot) {
  const winner = snapshot.players.find((p) => p.id === snapshot.winnerId);
  const winnerEl = $('#match-end-winner');
  winnerEl.innerHTML = '';

  if (winner) {
    const avatar = document.createElement('div');
    avatar.className = 'lobby-player-avatar';
    avatar.innerHTML = renderAvatarSVG(winner.avatar, 88);
    winnerEl.appendChild(avatar);

    const name = document.createElement('div');
    name.className = 'match-end-winner-name';
    name.textContent = `${winner.name} Wins!`;
    winnerEl.appendChild(name);

    const sub = document.createElement('div');
    sub.className = 'match-end-winner-sub';
    sub.textContent = winner.rank === 'president'
      ? 'Presiden'
      : `Highest rank at Round ${snapshot.maxRounds}: ${RANK_LABELS[winner.rank]}`;
    winnerEl.appendChild(sub);

    winnerEl.appendChild(makeStatsGrid(winner));
  }

  const standingsEl = $('#match-end-standings');
  standingsEl.innerHTML = '';
  snapshot.players
    .slice()
    .sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank) || a.scandal - b.scandal)
    .forEach((p) => {
      const li = document.createElement('li');
      li.className = 'match-end-player-row';
      li.dataset.rank = p.rank;
      li.classList.toggle('is-winner', p.id === snapshot.winnerId);

      const header = document.createElement('div');
      header.className = 'match-end-player-header';

      const avatar = document.createElement('div');
      avatar.className = 'lobby-player-avatar';
      avatar.innerHTML = renderAvatarSVG(p.avatar, 40);
      header.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'lobby-player-info';
      const name = document.createElement('span');
      name.className = 'lobby-player-name';
      name.textContent = p.name;
      info.appendChild(name);
      header.appendChild(info);

      const badge = document.createElement('span');
      badge.className = `lobby-ready-badge${p.id === snapshot.winnerId ? ' is-ready' : ''}`;
      badge.textContent = RANK_LABELS[p.rank];
      header.appendChild(badge);

      li.appendChild(header);
      li.appendChild(makeStatsGrid(p));
      standingsEl.appendChild(li);
    });

  sound.playPromotion();
}

// A News item (National Event or a leaked Backroom Deal) is a top-layer
// announcement, not a screen of its own - it can land on top of the match
// screen mid-game or right as the match ends, and either way just sits
// above whatever's already rendered until the player dismisses it locally
// (no host round-trip needed for that, since the effects have already been
// applied server-side).
function showNewsOverlay(pending) {
  if (!pending || pending.seq === lastSeenEventSeq) return;
  lastSeenEventSeq = pending.seq;
  $('#news-icon').textContent = pending.icon;
  $('#news-headline').textContent = pending.headline;
  $('#news-description').textContent = pending.description;
  $('#news-overlay').hidden = false;
  sound.playWarning();
}

// Parliament Voting pauses every client at once, not just the active
// player - the overlay shows on every screen the moment `pendingVote`
// appears, with a live countdown ticking down to the host's deadline.
// Voting hides *this client's* overlay immediately (already did their
// part); the overlay only reappears for the next session's seq, or the
// result arrives through the normal News overlay once the host resolves it.
function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The countdown next to the "Undian Parlimen sedang berlangsung" hint keeps
// ticking for everyone, including players who already voted and dismissed
// the overlay - they're still waiting on the table, so they still need it.
let voteHintInterval = null;
function renderVoteTimer(pendingVote) {
  const el = $('#match-vote-timer');
  if (!pendingVote) {
    el.hidden = true;
    clearInterval(voteHintInterval);
    voteHintInterval = null;
    return;
  }
  const tick = () => { el.textContent = `⏱ ${formatCountdown(pendingVote.deadline - Date.now())}`; };
  el.hidden = false;
  tick();
  clearInterval(voteHintInterval);
  voteHintInterval = setInterval(tick, 500);
}

function showParliamentOverlay(pendingVote) {
  if (!pendingVote) {
    $('#parliament-overlay').hidden = true;
    clearInterval(voteCountdownInterval);
    voteCountdownInterval = null;
    return;
  }
  if (pendingVote.seq === lastSeenVoteSeq) return;
  lastSeenVoteSeq = pendingVote.seq;

  $('#parliament-motion-name').textContent = pendingVote.name;
  $('#parliament-motion-description').textContent = pendingVote.description;
  $('#parliament-overlay').hidden = false;
  sound.playWarning();

  const tick = () => {
    $('#parliament-countdown').textContent = formatCountdown(pendingVote.deadline - Date.now());
  };
  clearInterval(voteCountdownInterval);
  tick();
  voteCountdownInterval = setInterval(tick, 1000);
}

// Newest-first log of what just happened, shown as "Berita Terkini". Built
// client-side from the same action snapshots that already drive the toasts,
// so it needs no extra data from the host.
const FEED_LIMIT = 6;
const FEED_TYPE_LABELS = {
  projek: 'PROJEK',
  media: 'KEMPEN IMEJ',
  politik: 'POLITIK',
  sabotaj: 'SABOTAJ',
  raid: 'RAMPASAN ASET',
  market: 'PASAR GELAP',
  media_empire: 'EMPAYAR MEDIA',
  skip: 'GILIRAN DILANGKAU',
  scandal: 'SKANDAL',
};
const matchFeed = [];

function pushFeed(text, type, round) {
  matchFeed.unshift({ text, meta: `${FEED_TYPE_LABELS[type] || ''} · RONDA ${round}` });
  matchFeed.length = Math.min(matchFeed.length, FEED_LIMIT);
  renderFeed();
}

function renderFeed() {
  const container = $('#match-feed');
  container.innerHTML = '';
  if (!matchFeed.length) {
    const empty = document.createElement('p');
    empty.className = 'feed-empty';
    empty.textContent = 'Belum ada berita. Setiap tindakan pemain akan dilaporkan di sini.';
    container.appendChild(empty);
    return;
  }
  matchFeed.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'feed-item';
    const text = document.createElement('span');
    text.className = 'feed-text';
    text.textContent = entry.text;
    const meta = document.createElement('span');
    meta.className = 'feed-meta';
    meta.textContent = entry.meta;
    item.appendChild(text);
    item.appendChild(meta);
    container.appendChild(item);
  });
}

function renderRoundHeader(round, maxRounds) {
  $('#match-round-label').innerHTML = `<span>RONDA</span> <span>${round} / ${maxRounds}</span>`;
  const pips = $('#match-round-pips');
  pips.innerHTML = '';
  for (let i = 1; i <= maxRounds; i++) {
    const pip = document.createElement('span');
    pip.className = `round-pip${i < round ? ' is-past' : i === round ? ' is-current' : ''}`;
    pips.appendChild(pip);
  }
}

function renderMatchScreen(snapshot) {
  if (!snapshot.started) return;

  showNewsOverlay(snapshot.pendingNews);
  showParliamentOverlay(snapshot.pendingVote);

  if (snapshot.matchOver) {
    if (!hasEnteredMatchEndScreen) {
      hasEnteredMatchEndScreen = true;
      renderMatchEnd(snapshot);
      showScreen('match-end');
    }
    return;
  }

  if (!hasEnteredMatchScreen) {
    hasEnteredMatchScreen = true;
    matchFeed.length = 0;
    renderFeed();
    showScreen('match');
  }

  renderRoundHeader(snapshot.round, snapshot.maxRounds);
  renderMatchPlayerList(snapshot);
  renderHierarchy(snapshot);
  renderActionPanel(snapshot);
  renderBottomBar(snapshot);
  handleActionFeedback(snapshot);

  const isMyTurnNow = snapshot.activePlayerId === snapshot.localPlayerId;
  if (isMyTurnNow && !wasMyTurn) sound.playTurnStart();
  wasMyTurn = isMyTurnNow;
}

function wireMatchActions() {
  // Keys 1-6 mirror the numbered action cards. Ignored while typing, while
  // any dialog is open, or when the card is disabled (not your turn).
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (!$('#screen-match').classList.contains('is-active')) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if ($$('.modal-overlay').some((overlay) => !overlay.hidden)) return;
    const card = $(`.action-card[data-key="${e.key}"]`);
    if (!card || card.disabled) return;
    e.preventDefault();
    card.click();
  });

  $('#btn-host-skip').addEventListener('click', () => {
    sound.playClick();
    match.skipCurrentPlayer();
  });

  $('#btn-action-projek').addEventListener('click', () => {
    sound.playClick();
    match.requestProjekOffers();
  });

  $('#btn-action-media').addEventListener('click', () => {
    sound.playClick();
    match.requestMediaOffers();
  });

  $('#btn-action-politik').addEventListener('click', () => {
    sound.playClick();
    const snapshot = match.getMatchSnapshot();
    const localPlayer = findLocalPlayer(snapshot);
    const nextRank = getNextRank(localPlayer.rank);
    if (!nextRank) return;
    if (!hasOpenSeat(snapshot.players, nextRank)) {
      showToast('Use Sabotaj to rebut the seat.');
      return;
    }
    openAttemptModal('politik', null);
  });

  $('#btn-action-sabotaj').addEventListener('click', () => {
    sound.playClick();
    match.requestSabotajOptions();
  });

  $('#btn-action-raid').addEventListener('click', () => {
    sound.playClick();
    const snapshot = match.getMatchSnapshot();
    const localPlayer = findLocalPlayer(snapshot);
    if (getRaidableAssets(snapshot, localPlayer).length === 0) {
      showToast('No Political Assets you can raid — you already own every type others hold.');
      return;
    }
    openTargetPicker({ mode: 'raid' });
  });

  $('#btn-action-market').addEventListener('click', () => {
    sound.playClick();
    const snapshot = match.getMatchSnapshot();
    const localPlayer = findLocalPlayer(snapshot);
    const ownedTypes = new Set((localPlayer.assets || []).map((a) => a.type));
    if (opportunities.ASSET_TYPES.every((type) => ownedTypes.has(type))) {
      showToast('You already own every Political Asset.');
      return;
    }
    match.requestMarketOffers();
  });

  // Backroom Deal is never turn-gated - available any time to any player.
  $('#btn-backroom-deal').addEventListener('click', () => {
    sound.playClick();
    openTargetPicker({ mode: 'deal' });
  });

  $('#btn-picker-cancel').addEventListener('click', () => {
    $('#action-picker-modal').hidden = true;
  });

  $('#btn-target-picker-cancel').addEventListener('click', () => {
    $('#target-picker-modal').hidden = true;
  });

  $('#btn-attempt-cancel-x').addEventListener('click', () => {
    $('#attempt-modal').hidden = true;
  });

  $('#btn-attempt-confirm').addEventListener('click', () => {
    const extra = Number($('#attempt-extra-slider').value);
    sound.playClick();
    if (currentAttempt.kind === 'politik') {
      match.attemptPolitik(extra);
    } else if (currentAttempt.kind === 'raid') {
      match.attemptRaid(currentAttempt.targetId, currentAttempt.assetId, extra);
    } else {
      match.attemptSabotaj(currentAttempt.targetId, extra);
    }
    $('#attempt-modal').hidden = true;
  });

  $('#btn-deal-offer-cancel-x').addEventListener('click', () => {
    $('#deal-offer-modal').hidden = true;
  });

  $('#btn-deal-offer-send').addEventListener('click', () => {
    const money = Number($('#deal-offer-money-slider').value);
    const influence = Number($('#deal-offer-influence-slider').value);
    if (money === 0 && influence === 0) {
      $('#deal-offer-error').hidden = false;
      $('#deal-offer-error').textContent = 'Offer at least some Money or Influence.';
      return;
    }
    sound.playClick();
    match.proposeBackroomDeal(currentDealTargetId, money, influence);
    $('#deal-offer-modal').hidden = true;
    showToast('Offer sent secretly.');
  });

  $('#btn-deal-accept').addEventListener('click', () => {
    sound.playClick();
    $('#deal-incoming-overlay').hidden = true;
    if (currentIncomingDeal) match.respondToBackroomDeal(currentIncomingDeal.dealId, true);
    currentIncomingDeal = null;
  });

  $('#btn-deal-reject').addEventListener('click', () => {
    sound.playClick();
    $('#deal-incoming-overlay').hidden = true;
    if (currentIncomingDeal) match.respondToBackroomDeal(currentIncomingDeal.dealId, false);
    currentIncomingDeal = null;
  });

  $('#btn-match-end-menu').addEventListener('click', () => {
    room.leaveRoom();
    match.resetMatch();
    hasEnteredMatchScreen = false;
    hasEnteredMatchEndScreen = false;
    lastHandledActionSeq = -1;
    lastHandledPassiveSeq = 0;
    lastSeenEventSeq = -1;
    lastSeenVoteSeq = -1;
    clearInterval(voteCountdownInterval);
    voteCountdownInterval = null;
    wasMyTurn = false;
    hadKabel = false;
    showScreen('main-menu');
  });

  $('#btn-news-continue').addEventListener('click', () => {
    sound.playClick();
    $('#news-overlay').hidden = true;
  });

  $('#btn-vote-yes').addEventListener('click', () => {
    sound.playClick();
    match.castVote('yes');
    $('#parliament-overlay').hidden = true;
    clearInterval(voteCountdownInterval);
    voteCountdownInterval = null;
  });

  $('#btn-vote-no').addEventListener('click', () => {
    sound.playClick();
    match.castVote('no');
    $('#parliament-overlay').hidden = true;
    clearInterval(voteCountdownInterval);
    voteCountdownInterval = null;
  });

  $('#btn-vote-abstain').addEventListener('click', () => {
    sound.playClick();
    match.castVote('abstain');
    $('#parliament-overlay').hidden = true;
    clearInterval(voteCountdownInterval);
    voteCountdownInterval = null;
  });
}

function wireMatchEvents() {
  bus.on('match:updated', (e) => renderMatchScreen(e.detail));
  bus.on('match:offers', (e) => {
    // A slow network response can arrive after the turn has already moved
    // on (e.g. the player double-clicked, or someone disconnected and got
    // auto-skipped in the meantime) - ignore it rather than popping the
    // picker open on a turn that isn't active anymore.
    const snapshot = match.getMatchSnapshot();
    if (snapshot.activePlayerId !== snapshot.localPlayerId) return;
    openOffersModal(e.detail.action, e.detail.offers);
  });
  bus.on('match:action-rejected', (e) => {
    showToast(ACTION_REJECT_MESSAGES[e.detail.reason] || 'Action not available.');
  });
  bus.on('match:sabotaj-options', (e) => {
    const snapshot = match.getMatchSnapshot();
    if (snapshot.activePlayerId !== snapshot.localPlayerId) return;
    const localPlayer = findLocalPlayer(snapshot);
    const { isKabel } = e.detail;

    if (isKabel) {
      openTargetPicker({ mode: 'sabotaj', isKabel: true });
      return;
    }

    const nextRank = getNextRank(localPlayer.rank);
    if (!nextRank) return;
    if (hasOpenSeat(snapshot.players, nextRank)) {
      showToast('The seat is not full — use Politik instead.');
      return;
    }
    openTargetPicker({ mode: 'sabotaj', rank: nextRank, isKabel: false });
  });

  // A Backroom Deal offer/result is delivered only to the two people
  // involved (see match.js's notifyPlayer) - this listener is the entire
  // client-side surface for that, no polling or turn-gating needed since
  // it can land at any moment for any player.
  bus.on('match:deal-offer', (e) => {
    currentIncomingDeal = e.detail;
    const { fromName, money, influence } = e.detail;
    const parts = [];
    if (money) parts.push(formatMoney(money));
    if (influence) parts.push(`${influence} Influence`);
    $('#deal-incoming-description').textContent = `${fromName} secretly offers you ${parts.join(' + ')}.`;
    $('#deal-incoming-overlay').hidden = false;
    sound.playWarning();
  });

  bus.on('match:deal-result', (e) => {
    const { accepted, leaked, fellThrough, role, money, influence } = e.detail;
    const parts = [];
    if (money) parts.push(formatMoney(money));
    if (influence) parts.push(`${influence} Influence`);
    const amountText = parts.join(' + ');
    let message;
    if (!accepted) {
      message = fellThrough ? 'Your offer fell through — you no longer had enough to cover it.' : 'Your offer was declined.';
    } else if (leaked) {
      message = 'Your backroom deal leaked! You will skip your next turn.';
    } else if (role === 'offerer') {
      message = `Deal done — you paid ${amountText}.`;
    } else {
      message = `Deal done — you received ${amountText}.`;
    }
    showToast(message, 4500);
    if (accepted && !leaked) sound.playCoins(); else if (leaked) sound.playWarning(); else sound.playClick();
  });

  bus.on('match:objective-complete', (e) => {
    const { name, reward } = e.detail;
    const parts = [];
    if (reward?.money) parts.push(formatMoney(reward.money));
    if (reward?.influence) parts.push(`${reward.influence} Influence`);
    showToast(`🎯 Objective Complete: ${name}! +${parts.join(' + ')}`, 5000);
    sound.playPromotion();
  });
}

function wireSettingsModal() {
  const modal = $('#settings-modal');
  const volumeSlider = $('#setting-volume');

  $('#btn-open-settings').addEventListener('click', () => {
    modal.hidden = false;
  });

  $('#btn-close-settings').addEventListener('click', () => {
    modal.hidden = true;
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  $('#setting-sound-toggle').addEventListener('click', () => {
    setMuted(!settings.muted);
  });

  volumeSlider.value = String(Math.round(settings.volume * 100));
  volumeSlider.addEventListener('input', () => {
    setVolume(Number(volumeSlider.value) / 100);
  });
}

// Read-only reference content - no game state involved, so it's just a
// modal any player (host or guest) can open/close from the lobby, mirroring
// wireSettingsModal()'s open/close/backdrop/Escape pattern exactly.
function wireHowtoModal() {
  const modal = $('#howto-modal');

  ['#btn-lobby-help', '#btn-menu-help'].forEach((selector) => {
    $(selector).addEventListener('click', () => {
      sound.playClick();
      modal.hidden = false;
    });
  });

  $('#btn-close-howto').addEventListener('click', () => {
    modal.hidden = true;
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}

export function getSettings() {
  return { ...settings };
}

export function initUI() {
  wireMainMenu();
  wireSettingsModal();
  wireHowtoModal();
  wireRoomHostScreen();
  wireRoomJoinScreen();
  wireCustomizeScreen();
  wireLobbyScreen();
  wireRoomEvents();
  wireMatchActions();
  wireMatchEvents();
  applySoundUI();
  sound.applySoundSettings(settings);
  bus.on('settings:changed', (e) => sound.applySoundSettings(e.detail));
  showScreen('main-menu');
}
