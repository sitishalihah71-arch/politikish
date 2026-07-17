// Thin PeerJS/WebRTC transport wrapper. No game rules live here - just
// connection lifecycle and message passing. `room.js` builds the
// host-authoritative protocol on top of this.

const PEER_ID_PREFIX = 'politikish-';
const CONNECT_TIMEOUT_MS = 8000;

let peer = null;
const connections = new Set();

let messageHandlers = [];
let peerLeftHandlers = [];
let hostLostHandlers = [];

function wireConnection(conn, { isHostSide }) {
  conn.on('data', (data) => {
    if (!data || typeof data.type !== 'string') return;
    messageHandlers.forEach((h) => h(data.type, data.payload, conn));
  });

  const handleGone = () => {
    if (!connections.has(conn)) return;
    connections.delete(conn);
    if (isHostSide) {
      peerLeftHandlers.forEach((h) => h(conn));
    } else {
      hostLostHandlers.forEach((h) => h());
    }
  };

  conn.on('close', handleGone);
  conn.on('error', handleGone);
}

export function startHost(roomCode) {
  return new Promise((resolve, reject) => {
    const p = new Peer(PEER_ID_PREFIX + roomCode, { debug: 0 });
    peer = p;

    p.on('open', () => resolve());

    p.on('error', (err) => {
      try { p.destroy(); } catch { /* already gone */ }
      if (peer === p) peer = null;
      reject(err);
    });

    p.on('connection', (conn) => {
      connections.add(conn);
      conn.on('open', () => wireConnection(conn, { isHostSide: true }));
    });
  });
}

export function joinHost(roomCode) {
  return new Promise((resolve, reject) => {
    const p = new Peer(undefined, { debug: 0 });
    peer = p;
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(arg);
    };

    const timeout = setTimeout(() => {
      finish(reject, new Error('timeout'));
      teardown();
    }, CONNECT_TIMEOUT_MS);

    p.on('open', () => {
      const conn = p.connect(PEER_ID_PREFIX + roomCode, { reliable: true });
      conn.on('open', () => {
        connections.add(conn);
        wireConnection(conn, { isHostSide: false });
        finish(resolve);
      });
      conn.on('error', (err) => finish(reject, err));
    });

    p.on('error', (err) => finish(reject, err));
  });
}

export function send(message, targetConn) {
  if (targetConn) {
    if (targetConn.open) targetConn.send(message);
    return;
  }
  connections.forEach((conn) => {
    if (conn.open) conn.send(message);
  });
}

export function onMessage(handler) {
  messageHandlers.push(handler);
}

export function onPeerLeft(handler) {
  peerLeftHandlers.push(handler);
}

export function onHostConnectionLost(handler) {
  hostLostHandlers.push(handler);
}

export function teardown() {
  connections.forEach((conn) => {
    try { conn.close(); } catch { /* already closed */ }
  });
  connections.clear();

  if (peer) {
    try { peer.destroy(); } catch { /* already gone */ }
    peer = null;
  }

  messageHandlers = [];
  peerLeftHandlers = [];
  hostLostHandlers = [];
}
