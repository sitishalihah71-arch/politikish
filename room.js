// Host-authoritative room state: creating/joining rooms, the 4-player cap,
// and reconnect-by-name within a grace window. Pure logic - `ui.js` renders
// whatever this module broadcasts via `bus`.

import { bus, generateRoomCode, saveSession, clearSession, randomChoice, randomInt } from './utils.js';
import { createPlayer } from './player.js';
import { normalizeAvatar, HAIR_STYLES, FACE_STYLES } from './avatar.js';
import { GAME_BALANCE } from './balance.js';
import * as multiplayer from './multiplayer.js';

const RECONNECT_GRACE_MS = 120000;
const CREATE_ROOM_MAX_ATTEMPTS = 5;
const MAX_NAME_LENGTH = 16;

// A match needs at least two players to be a contest at all - the upper
// bound is the host-selected `gameSettings.maxPlayers`, enforced when
// players join.
export const MIN_PLAYERS_TO_START = 2;

function defaultSettings() {
  return {
    maxPlayers: GAME_BALANCE.room.defaultPlayers,
    rounds: GAME_BALANCE.room.defaultRounds,
    nationalEvents: GAME_BALANCE.room.defaultNationalEvents,
    parliamentVoting: GAME_BALANCE.room.defaultParliamentVoting,
  };
}

let role = null; // 'host' | 'client' | null
let roomCode = null;
let localPlayerId = null;
let players = [];
// Host-authoritative room settings (players/rounds/national events), same
// sharing pattern as `players`: the host mutates it directly, clients only
// ever receive it over the wire.
let gameSettings = defaultSettings();
const connectionsByPlayerId = new Map();
const reconnectTimers = new Map();

// Closing a connection (e.g. host rejecting a 5th player, or leaveRoom()
// itself) also fires the same low-level "connection closed" event as a
// genuine unexpected drop. This flag lets the client tell them apart so a
// deliberate close doesn't get misreported as "host disconnected".
let suppressHostLost = false;

function sanitizeName(raw) {
  return (raw || '').trim().slice(0, MAX_NAME_LENGTH);
}

function dedupeName(name) {
  const taken = new Set(players.filter((p) => p.connected).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has(`${name.toLowerCase()} (${i})`)) i++;
  return `${name} (${i})`;
}

function nextAvailableSlot() {
  const used = new Set(players.map((p) => p.slot));
  for (let s = 1; s <= gameSettings.maxPlayers; s++) {
    if (!used.has(s)) return s;
  }
  return null;
}

function getRoomSnapshot() {
  return {
    code: roomCode,
    isHost: role === 'host',
    localPlayerId,
    players: players.map((p) => ({ ...p })),
    settings: { ...gameSettings },
  };
}

function broadcastRoomUpdate() {
  multiplayer.send({ type: 'room-update', payload: { players: getRoomSnapshot().players, settings: gameSettings } });
}

function clearReconnectTimer(playerId) {
  const timer = reconnectTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(playerId);
  }
}

function handleJoinRequest(conn, rawName) {
  const name = sanitizeName(rawName);
  if (!name) {
    multiplayer.send({ type: 'join-rejected', payload: { reason: 'invalid-name' } }, conn);
    conn.close();
    return;
  }

  const existing = players.find((p) => !p.connected && p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    clearReconnectTimer(existing.id);
    connectionsByPlayerId.delete(existing.id);
    existing.id = conn.peer;
    existing.connected = true;
    existing.ready = false;
    connectionsByPlayerId.set(existing.id, conn);

    multiplayer.send(
      { type: 'join-accepted', payload: { playerId: existing.id, roomCode, players: getRoomSnapshot().players, settings: gameSettings } },
      conn,
    );
    broadcastRoomUpdate();
    bus.emit('room:updated', getRoomSnapshot());
    return;
  }

  if (players.length >= gameSettings.maxPlayers) {
    multiplayer.send({ type: 'join-rejected', payload: { reason: 'room-full' } }, conn);
    conn.close();
    return;
  }

  const slot = nextAvailableSlot();
  const player = createPlayer({ id: conn.peer, slot, name: dedupeName(name), isHost: false });
  players.push(player);
  connectionsByPlayerId.set(player.id, conn);

  multiplayer.send(
    { type: 'join-accepted', payload: { playerId: player.id, roomCode, players: getRoomSnapshot().players, settings: gameSettings } },
    conn,
  );
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

function handleAvatarUpdate(conn, rawAvatar) {
  const player = players.find((p) => p.id === conn.peer);
  if (!player) return;
  player.avatar = normalizeAvatar(rawAvatar);
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

function handleReadyToggle(conn, ready) {
  const player = players.find((p) => p.id === conn.peer);
  if (!player) return;
  player.ready = Boolean(ready);
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

function handleHostMessage(type, payload, conn) {
  if (role !== 'host') return;
  if (type === 'join-request') handleJoinRequest(conn, payload?.name);
  else if (type === 'avatar-update') handleAvatarUpdate(conn, payload?.avatar);
  else if (type === 'ready-toggle') handleReadyToggle(conn, payload?.ready);
}

function handleConnectionClosed(conn) {
  const player = players.find((p) => p.id === conn.peer);
  if (!player || player.isHost) return;

  player.connected = false;
  player.ready = false;
  connectionsByPlayerId.delete(player.id);
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());

  const timer = setTimeout(() => {
    players = players.filter((p) => p.id !== player.id);
    reconnectTimers.delete(player.id);
    broadcastRoomUpdate();
    bus.emit('room:updated', getRoomSnapshot());
  }, RECONNECT_GRACE_MS);
  reconnectTimers.set(player.id, timer);
}

export async function createRoom(hostName) {
  const name = sanitizeName(hostName);
  if (!name) throw new Error('Enter a name first.');

  let lastErr = null;
  for (let attempt = 0; attempt < CREATE_ROOM_MAX_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    try {
      await multiplayer.startHost(code);
      role = 'host';
      roomCode = code;
      localPlayerId = 'host';
      players = [createPlayer({ id: 'host', slot: 1, name, isHost: true })];
      gameSettings = defaultSettings();

      multiplayer.onPeerLeft(handleConnectionClosed);
      multiplayer.onMessage(handleHostMessage);

      bus.emit('room:updated', getRoomSnapshot());
      return code;
    } catch (err) {
      lastErr = err;
      if (err?.type !== 'unavailable-id') throw err;
    }
  }
  throw lastErr || new Error('Could not create a room. Please try again.');
}

export async function joinRoom(code, playerName) {
  const name = sanitizeName(playerName);
  if (!name) throw new Error('Enter a name first.');

  const normalizedCode = code.trim().toUpperCase();
  role = 'client';
  roomCode = normalizedCode;

  await multiplayer.joinHost(normalizedCode);

  multiplayer.onMessage((type, payload) => {
    if (type === 'join-accepted') {
      localPlayerId = payload.playerId;
      players = payload.players;
      gameSettings = payload.settings || gameSettings;
      saveSession({ roomCode: normalizedCode, name, playerId: localPlayerId });
      bus.emit('room:joined', getRoomSnapshot());
    } else if (type === 'join-rejected') {
      bus.emit('room:join-rejected', { reason: payload.reason });
      leaveRoom();
    } else if (type === 'room-update') {
      players = payload.players;
      gameSettings = payload.settings || gameSettings;
      bus.emit('room:updated', getRoomSnapshot());
    } else if (type === 'match-start') {
      bus.emit('room:match-started', getRoomSnapshot());
    }
  });

  multiplayer.onHostConnectionLost(() => {
    if (suppressHostLost) {
      suppressHostLost = false;
      return;
    }
    bus.emit('room:host-disconnected');
    leaveRoom();
  });

  multiplayer.send({ type: 'join-request', payload: { name } });
}

export function leaveRoom() {
  suppressHostLost = true;
  multiplayer.teardown();
  reconnectTimers.forEach((timer) => clearTimeout(timer));
  reconnectTimers.clear();
  connectionsByPlayerId.clear();
  role = null;
  roomCode = null;
  localPlayerId = null;
  players = [];
  gameSettings = defaultSettings();
  clearSession();
}

export function updateLocalAvatar(avatar) {
  const normalized = normalizeAvatar(avatar);
  if (role === 'host') {
    const me = players.find((p) => p.id === localPlayerId);
    if (!me) return;
    me.avatar = normalized;
    broadcastRoomUpdate();
    bus.emit('room:updated', getRoomSnapshot());
  } else if (role === 'client') {
    multiplayer.send({ type: 'avatar-update', payload: { avatar: normalized } });
  }
}

export function setLocalReady(ready) {
  const value = Boolean(ready);
  if (role === 'host') {
    const me = players.find((p) => p.id === localPlayerId);
    if (!me) return;
    me.ready = value;
    broadcastRoomUpdate();
    bus.emit('room:updated', getRoomSnapshot());
  } else if (role === 'client') {
    multiplayer.send({ type: 'ready-toggle', payload: { ready: value } });
  }
}

// Host-only: change players/rounds/national-events pre-match. Validated
// against the option lists so a stray value can never desync the room -
// invalid partial fields are just dropped rather than rejecting the whole
// update, since each field is otherwise independent.
export function updateSettings(partial) {
  if (role !== 'host') return;
  const next = { ...gameSettings };
  if (GAME_BALANCE.room.playerOptions.includes(partial.maxPlayers)) next.maxPlayers = partial.maxPlayers;
  if (GAME_BALANCE.room.roundOptions.includes(partial.rounds)) next.rounds = partial.rounds;
  if (typeof partial.nationalEvents === 'boolean') next.nationalEvents = partial.nationalEvents;
  if (typeof partial.parliamentVoting === 'boolean') next.parliamentVoting = partial.parliamentVoting;
  gameSettings = next;
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

export function canStartMatch() {
  return players.length === gameSettings.maxPlayers && players.every((p) => p.connected && p.ready);
}

// Host-only: fills the next open slot with an AI-controlled player. Unlike
// a real join, there's no handshake to wait on - a bot is connected and
// ready from the instant it exists, so it needs zero further changes to
// canStartMatch() or any of the target-picker filters that already gate on
// `connected`.
export function addBot() {
  if (role !== 'host' || players.length >= gameSettings.maxPlayers) return;
  const slot = nextAvailableSlot();
  if (slot === null) return;
  const name = dedupeName(randomChoice(GAME_BALANCE.bots.namePool));
  const player = createPlayer({ id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, slot, name, isHost: false, isBot: true });
  player.ready = true;
  player.avatar = normalizeAvatar({ hair: randomInt(0, HAIR_STYLES.length - 1), face: randomInt(0, FACE_STYLES.length - 1) });
  players.push(player);
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

// Host-only, pre-match cleanup for a bot added by mistake - matches don't
// call this (no way to remove a bot mid-match, same as a real player).
export function removeBot(botId) {
  if (role !== 'host') return;
  const player = players.find((p) => p.id === botId && p.isBot);
  if (!player) return;
  players = players.filter((p) => p.id !== botId);
  broadcastRoomUpdate();
  bus.emit('room:updated', getRoomSnapshot());
}

export function startMatch() {
  if (role !== 'host' || !canStartMatch()) return false;
  multiplayer.send({ type: 'match-start', payload: { players: getRoomSnapshot().players } });
  bus.emit('room:match-started', getRoomSnapshot());
  return true;
}

// Live (non-copied) reference to the authoritative player array. Host-side
// use only, for trusted sibling modules (match.js) that need to extend these
// same player objects with match-phase fields and stay in sync with
// room.js's own connect/disconnect/reconnect handling. Never exposed over
// the network directly - broadcasts still go through getRoomSnapshot().
export function getPlayersLive() {
  return players;
}

// Host-side only, mirrors getPlayersLive()'s trust model: lets match.js send
// a *different* payload to each connected player (needed for data that must
// stay private per-player, like Political Network progress/KABEL ownership)
// instead of the single shared broadcast every other message type uses.
export function getConnectionsByPlayerId() {
  return connectionsByPlayerId;
}

export { getRoomSnapshot };
