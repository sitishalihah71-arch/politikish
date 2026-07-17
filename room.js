// Host-authoritative room state: creating/joining rooms, the 4-player cap,
// and reconnect-by-name within a grace window. Pure logic - `ui.js` renders
// whatever this module broadcasts via `bus`.

import { bus, generateRoomCode, saveSession, clearSession } from './utils.js';
import { createPlayer, MAX_PLAYERS } from './player.js';
import { normalizeAvatar } from './avatar.js';
import * as multiplayer from './multiplayer.js';

const RECONNECT_GRACE_MS = 120000;
const CREATE_ROOM_MAX_ATTEMPTS = 5;
const MAX_NAME_LENGTH = 16;

let role = null; // 'host' | 'client' | null
let roomCode = null;
let localPlayerId = null;
let players = [];
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
  for (let s = 1; s <= MAX_PLAYERS; s++) {
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
  };
}

function broadcastRoomUpdate() {
  multiplayer.send({ type: 'room-update', payload: { players: getRoomSnapshot().players } });
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
      { type: 'join-accepted', payload: { playerId: existing.id, roomCode, players: getRoomSnapshot().players } },
      conn,
    );
    broadcastRoomUpdate();
    bus.emit('room:updated', getRoomSnapshot());
    return;
  }

  if (players.length >= MAX_PLAYERS) {
    multiplayer.send({ type: 'join-rejected', payload: { reason: 'room-full' } }, conn);
    conn.close();
    return;
  }

  const slot = nextAvailableSlot();
  const player = createPlayer({ id: conn.peer, slot, name: dedupeName(name), isHost: false });
  players.push(player);
  connectionsByPlayerId.set(player.id, conn);

  multiplayer.send(
    { type: 'join-accepted', payload: { playerId: player.id, roomCode, players: getRoomSnapshot().players } },
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
      saveSession({ roomCode: normalizedCode, name, playerId: localPlayerId });
      bus.emit('room:joined', getRoomSnapshot());
    } else if (type === 'join-rejected') {
      bus.emit('room:join-rejected', { reason: payload.reason });
      leaveRoom();
    } else if (type === 'room-update') {
      players = payload.players;
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

export function canStartMatch() {
  return players.length === MAX_PLAYERS && players.every((p) => p.connected && p.ready);
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

export { getRoomSnapshot };
