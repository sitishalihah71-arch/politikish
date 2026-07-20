// Screen routing + main menu / settings UI wiring. Pure UI logic - no game
// rules live here. Cross-module communication happens through `bus`.

import { $, $$, bus, loadSettings, saveSettings, randomInt, formatMoney } from './utils.js';
import * as room from './room.js';
import { HAIR_STYLES, FACE_STYLES, renderAvatarSVG } from './avatar.js';
import * as sound from './sound.js';
import * as match from './match.js';
import { RANKS, RANK_LABELS, SEAT_CAPACITY, getNextRank } from './player.js';
import { hasOpenSeat } from './effects.js';
import * as politics from './politics.js';
import * as sabotage from './sabotage.js';
import { GAME_BALANCE } from './balance.js';

let settings = loadSettings();
let toastTimer = null;
let draftAvatar = { hair: 0, face: 0 };

export function showScreen(screenName) {
  $$('.screen').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.screen === screenName);
  });
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
  'room-full': 'That room already has 4 players.',
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
  $('#customize-hair-label').textContent = HAIR_STYLES[draftAvatar.hair].name;
  $('#customize-face-label').textContent = FACE_STYLES[draftAvatar.face].name;
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

      listEl.appendChild(li);
    });

  const me = findLocalPlayer(snapshot);
  const readyBtn = $('#btn-lobby-ready');
  const isReady = Boolean(me?.ready);
  readyBtn.classList.toggle('is-ready', isReady);
  $('.menu-btn-label', readyBtn).textContent = isReady ? 'Not Ready' : 'Ready';

  $('#lobby-host-controls').hidden = !snapshot.isHost;
  $('#lobby-guest-controls').hidden = snapshot.isHost;

  if (snapshot.isHost) {
    const canStart = room.canStartMatch();
    const startBtn = $('#btn-lobby-start');
    startBtn.disabled = !canStart;
    $('#lobby-start-hint').textContent = canStart
      ? 'Ready to start!'
      : snapshot.players.length < room.MIN_PLAYERS_TO_START
        ? `Need at least ${room.MIN_PLAYERS_TO_START} players (${snapshot.players.length}/${room.MIN_PLAYERS_TO_START})…`
        : 'Waiting for all players to be ready…';
  }
}

function wireLobbyScreen() {
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
  'insufficient-influence': 'Not enough Influence.',
  'insufficient-money': 'Not enough Money.',
};

let hasEnteredMatchScreen = false;
let hasEnteredMatchEndScreen = false;
let lastHandledActionSeq = -1;
let wasMyTurn = false;
let currentAttempt = null; // { kind: 'politik' | 'sabotaj', targetId }

function makeCardLine(text, positive) {
  const div = document.createElement('div');
  div.className = `picker-card-line${positive ? ' is-positive' : ' is-negative'}`;
  div.textContent = text;
  return div;
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
      if (player.id === snapshot.activePlayerId) card.classList.add('is-active-turn');
      if (!player.connected) card.classList.add('is-disconnected');

      const badge = document.createElement('div');
      badge.className = 'player-card-badge';
      badge.style.background = SLOT_BADGE_COLORS[player.slot - 1] || 'var(--gold)';
      badge.textContent = String(player.slot);
      card.appendChild(badge);

      const avatar = document.createElement('div');
      avatar.className = 'player-card-avatar';
      avatar.innerHTML = renderAvatarSVG(player.avatar, 38);
      card.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'player-card-info';
      const name = document.createElement('div');
      name.className = 'player-card-name';
      name.textContent = player.name;
      appendPublicSupportBadge(name, player);
      info.appendChild(name);

      const stats = document.createElement('div');
      stats.className = 'player-card-stats';
      const scandalClass = player.scandal >= 60 ? ' stat-scandal-warn' : '';
      stats.innerHTML = `<span>${formatMoney(player.money)}</span><span>${player.influence} Inf</span><span class="${scandalClass}">${player.scandal}%</span>`;
      info.appendChild(stats);

      card.appendChild(info);
      listEl.appendChild(card);
    });
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

  RANKS.forEach((rank) => {
    const container = $(`#seats-${rank}`);
    container.innerHTML = '';
    const occupants = snapshot.players.filter((p) => p.rank === rank).sort((a, b) => a.slot - b.slot);
    const capacity = SEAT_CAPACITY[rank];
    const slotCount = Math.max(capacity, occupants.length);

    for (let i = 0; i < slotCount; i++) {
      const player = occupants[i];
      const wrap = document.createElement('div');
      wrap.className = 'hierarchy-seat-wrap';

      const seat = document.createElement('div');
      const nameLabel = document.createElement('span');
      nameLabel.className = 'hierarchy-seat-name';

      if (player) {
        seat.className = 'hierarchy-seat is-occupied';
        seat.dataset.rank = rank;
        seat.dataset.playerId = player.id;
        seat.innerHTML = renderAvatarSVG(player.avatar, 56);
        nameLabel.textContent = player.name;
      } else {
        seat.className = 'hierarchy-seat is-empty';
        nameLabel.innerHTML = '&nbsp;';
      }

      wrap.appendChild(seat);
      wrap.appendChild(nameLabel);
      // Anchored to `wrap` (not the overflow-hidden avatar box) so the badge
      // never gets clipped by the seat's `overflow: hidden`.
      if (player) appendPublicSupportBadge(wrap, player, 'hierarchy-shield-badge');
      container.appendChild(wrap);
    }

    $(`#count-${rank}`).textContent = `${occupants.length} / ${capacity}`;
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

function renderActionPanel(snapshot) {
  const localPlayer = findLocalPlayer(snapshot);
  const isMyTurn = snapshot.activePlayerId === snapshot.localPlayerId;
  const activePlayer = snapshot.players.find((p) => p.id === snapshot.activePlayerId);
  const turnNameEl = $('#match-turn-name');
  turnNameEl.textContent = activePlayer ? activePlayer.name : '-';
  if (activePlayer) appendPublicSupportBadge(turnNameEl, activePlayer);

  const isPresident = localPlayer && localPlayer.rank === 'president';

  $('#btn-action-projek').disabled = !isMyTurn;
  $('#btn-action-politik').disabled = !isMyTurn || isPresident;
  $('#btn-action-sabotaj').disabled = !isMyTurn || isPresident;
  $('#btn-action-media').disabled = !isMyTurn;

  const skipBtn = $('#btn-host-skip');
  skipBtn.hidden = !snapshot.isHost;
  if (snapshot.isHost) {
    skipBtn.textContent = activePlayer ? `Skip ${activePlayer.name}'s Turn` : 'Skip Turn';
  }

  if (localPlayer) {
    const pct = localPlayer.scandal;
    $('#match-scandal-pct').textContent = `${pct}%`;
    $('#scandal-bar-fill').style.width = `${100 - pct}%`;
  }
}

function renderBottomBar(snapshot) {
  const localPlayer = findLocalPlayer(snapshot);
  if (!localPlayer) return;
  $('#bottom-money').textContent = formatMoney(localPlayer.money);
  $('#bottom-influence').textContent = String(localPlayer.influence);
  $('#bottom-scandal').textContent = `${localPlayer.scandal}%`;
  $('#bottom-rank').textContent = RANK_LABELS[localPlayer.rank];
}

const MONEY_ICON = '💰';
const INFLUENCE_ICON = '⭐';
const SCANDAL_ICON = '⚠️';
const SHIELD_ICON = '🛡️';
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

  $('#picker-title').textContent = action === 'projek' ? 'Pilih Projek' : 'Pilih Kempen Imej';
  const container = $('#picker-cards');
  container.innerHTML = '';

  offers.forEach((card) => {
    const btn = document.createElement('button');
    btn.className = 'picker-card-item';
    btn.type = 'button';

    const name = document.createElement('div');
    name.className = 'picker-card-name';
    name.textContent = card.name;
    btn.appendChild(name);

    if (action === 'projek') {
      btn.appendChild(makeCardLine(`${MONEY_ICON} +${formatMoney(card.money)}`, true));
      btn.appendChild(makeCardLine(`${INFLUENCE_ICON} +${card.influence} Influence`, true));
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

function openTargetPicker(context) {
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);
  const candidates = context.mode === 'sabotaj'
    ? snapshot.players.filter((p) => p.rank === context.rank && p.id !== localPlayer.id)
    : snapshot.players.filter((p) => p.id !== localPlayer.id && p.connected);

  $('#target-picker-title').textContent = context.mode === 'sabotaj' ? 'Pilih Sasaran Sabotaj' : 'Pilih Sasaran';
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
        openAttemptModal('sabotaj', player.id);
      } else {
        match.chooseMediaCard(context.cardId, player.id);
      }
    });

    listEl.appendChild(btn);
  });

  $('#target-picker-modal').hidden = false;
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

function renderSabotajBreakdown(fromRank, extra, targetHasPublicSupport) {
  const breakdown = sabotage.describeSabotajChance(fromRank, extra, targetHasPublicSupport);
  const el = $('#attempt-breakdown');
  el.innerHTML = '';
  el.appendChild(makeBreakdownRow('Base Chance', `${Math.round(breakdown.base * 100)}%`));
  el.appendChild(makeBreakdownRow('Extra Influence', `+${Math.round(breakdown.extraBonus * 100)}%`, 'is-positive'));
  if (targetHasPublicSupport) {
    el.appendChild(makeBreakdownRow(`${SHIELD_ICON} Public Support`, `-${Math.round(breakdown.publicSupportPenalty * 100)}%`, 'is-negative'));
  }
  el.appendChild(makeBreakdownRow('Final Chance', `${Math.round(breakdown.final * 100)}%`, 'is-final'));
  el.hidden = false;
}

function updateAttemptPreview(kind, fromRank, localPlayer, extra, targetHasPublicSupport) {
  const table = kind === 'politik' ? politics : sabotage;
  const cost = kind === 'politik' ? table.getPolitikCost(fromRank, extra) : table.getSabotajCost(fromRank, extra);
  const chance = kind === 'politik'
    ? table.calculatePolitikChance(fromRank, extra)
    : table.calculateSabotajChance(fromRank, extra, targetHasPublicSupport);

  $('#attempt-extra-value').textContent = `+${extra}`;
  $('#attempt-cost').textContent = String(cost);
  $('#attempt-chance').textContent = `${Math.round(chance * 100)}%`;

  if (kind === 'sabotaj') {
    renderSabotajBreakdown(fromRank, extra, targetHasPublicSupport);
  } else {
    $('#attempt-breakdown').hidden = true;
  }

  const affordable = localPlayer.influence >= cost;
  $('#btn-attempt-confirm').disabled = !affordable;
  $('#attempt-error').hidden = affordable;
  if (!affordable) $('#attempt-error').textContent = 'Not enough Influence.';
}

function openAttemptModal(kind, targetId) {
  currentAttempt = { kind, targetId };
  const snapshot = match.getMatchSnapshot();
  const localPlayer = findLocalPlayer(snapshot);
  const fromRank = localPlayer.rank;
  const target = kind === 'sabotaj' ? snapshot.players.find((p) => p.id === targetId) : null;
  const targetHasPublicSupport = Boolean(target && target.publicSupportTurns > 0);

  $('#attempt-title').textContent = kind === 'politik' ? 'Politik' : 'Sabotaj';
  $('#btn-attempt-confirm .menu-btn-label').textContent = kind === 'sabotaj' ? 'Attack' : 'Confirm';

  const targetLine = $('#attempt-target-line');
  if (kind === 'sabotaj') {
    targetLine.textContent = '';
    targetLine.appendChild(document.createTextNode(`Target: ${target ? target.name : ''}`));
    if (target) appendPublicSupportBadge(targetLine, target);
    targetLine.hidden = false;
  } else {
    targetLine.hidden = true;
  }

  const table = kind === 'politik' ? politics : sabotage;
  const config = table[kind === 'politik' ? 'PROMOTION_TABLE' : 'SABOTAGE_TABLE'][fromRank];
  const maxChance = kind === 'politik' ? politics.PROMOTION_MAX_CHANCE : sabotage.SABOTAGE_MAX_CHANCE;
  const bonus = kind === 'politik' ? politics.PROMOTION_EXTRA_BONUS : sabotage.SABOTAGE_EXTRA_BONUS;
  const step = kind === 'politik' ? politics.PROMOTION_EXTRA_STEP : sabotage.SABOTAGE_EXTRA_STEP;
  const baseCost = config.baseCost;

  const maxStepsForChance = Math.ceil((maxChance - config.baseChance) / bonus);
  const maxAffordableExtra = Math.max(0, localPlayer.influence - baseCost);
  const maxExtraSteps = Math.min(maxStepsForChance, Math.floor(maxAffordableExtra / step));
  const maxExtra = Math.max(0, maxExtraSteps * step);

  const slider = $('#attempt-extra-slider');
  slider.min = '0';
  slider.max = String(maxExtra);
  slider.step = String(step);
  slider.value = '0';
  slider.oninput = () => updateAttemptPreview(kind, fromRank, localPlayer, Number(slider.value), targetHasPublicSupport);

  updateAttemptPreview(kind, fromRank, localPlayer, 0, targetHasPublicSupport);
  $('#attempt-modal').hidden = false;
}

function handleActionFeedback(snapshot) {
  const action = snapshot.lastAction;
  const isNewAction = action && action.seq !== lastHandledActionSeq;
  if (!isNewAction) return;
  lastHandledActionSeq = action.seq;

  const actor = snapshot.players.find((p) => p.id === action.actorId);
  const actorName = actor ? actor.name : 'Someone';
  let message = '';

  if (action.type === 'projek') {
    message = `${actorName} used ${action.card.name}: +${formatMoney(action.card.money)}, +${action.card.influence} Influence`;
    sound.playCoins();
  } else if (action.type === 'media') {
    message = `${actorName} used ${action.card.name}`;
    if (action.card.kind === 'chance') message += action.success ? ' — Success!' : ' — Failed.';
    sound.playCoins();
  } else if (action.type === 'politik') {
    message = action.success
      ? `${actorName} was promoted to ${RANK_LABELS[action.toRank]}!`
      : `${actorName}'s Politik attempt failed.`;
    if (action.success) sound.playPromotion(); else sound.playFailure();
  } else if (action.type === 'sabotaj') {
    const target = snapshot.players.find((p) => p.id === action.targetId);
    const targetName = target ? target.name : 'a player';
    message = action.success
      ? `${actorName} sabotaged ${targetName} and took their seat!`
      : `${actorName}'s Sabotaj on ${targetName} failed.`;
    if (action.success) sound.playPromotion(); else sound.playFailure();
  } else if (action.type === 'skip') {
    message = `Host skipped ${actorName}'s turn.`;
    sound.playWarning();
  }

  if (message) showToast(message, 4000);

  if (snapshot.lastPenalized && snapshot.lastPenalized.length) {
    snapshot.lastPenalized.forEach((pid) => {
      const p = snapshot.players.find((pl) => pl.id === pid);
      if (p) showToast(`${p.name} hit 100% Scandal — lost 50% money and dropped a rank.`, 4500);
    });
    sound.playWarning();
  }
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
      : `Highest rank at Round 10: ${RANK_LABELS[winner.rank]}`;
    winnerEl.appendChild(sub);
  }

  const standingsEl = $('#match-end-standings');
  standingsEl.innerHTML = '';
  snapshot.players
    .slice()
    .sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank) || a.scandal - b.scandal)
    .forEach((p) => {
      const li = document.createElement('li');
      li.className = 'lobby-player-row';

      const avatar = document.createElement('div');
      avatar.className = 'lobby-player-avatar';
      avatar.innerHTML = renderAvatarSVG(p.avatar, 44);
      li.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'lobby-player-info';
      const name = document.createElement('span');
      name.className = 'lobby-player-name';
      name.textContent = p.name;
      info.appendChild(name);
      li.appendChild(info);

      const badge = document.createElement('span');
      badge.className = `lobby-ready-badge${p.id === snapshot.winnerId ? ' is-ready' : ''}`;
      badge.textContent = RANK_LABELS[p.rank];
      li.appendChild(badge);

      standingsEl.appendChild(li);
    });

  sound.playPromotion();
}

function renderMatchScreen(snapshot) {
  if (!snapshot.started) return;

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
    showScreen('match');
  }

  $('#match-round-label').textContent = `ROUND ${snapshot.round} / 10`;
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
    const snapshot = match.getMatchSnapshot();
    const localPlayer = findLocalPlayer(snapshot);
    const nextRank = getNextRank(localPlayer.rank);
    if (!nextRank) return;
    if (hasOpenSeat(snapshot.players, nextRank)) {
      showToast('The seat is not full — use Politik instead.');
      return;
    }
    openTargetPicker({ mode: 'sabotaj', rank: nextRank });
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
    } else {
      match.attemptSabotaj(currentAttempt.targetId, extra);
    }
    $('#attempt-modal').hidden = true;
  });

  $('#btn-match-end-menu').addEventListener('click', () => {
    room.leaveRoom();
    match.resetMatch();
    hasEnteredMatchScreen = false;
    hasEnteredMatchEndScreen = false;
    lastHandledActionSeq = -1;
    wasMyTurn = false;
    showScreen('main-menu');
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

export function getSettings() {
  return { ...settings };
}

export function initUI() {
  wireMainMenu();
  wireSettingsModal();
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
