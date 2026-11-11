// Minimal browser stand-ins so the game's own modules (room.js, match.js,
// bots.js ...) can run unmodified under Node. Import this FIRST.
//   - `document` is only used by utils.js's event bus (CustomEvent dispatch).
//   - `Peer` is the PeerJS global; the fake never touches a network, it just
//     opens instantly and lets the harness plug in fake client connections.
// localStorage / sessionStorage are already wrapped in try/catch by the game.

globalThis.document = new EventTarget();

export class FakePeer {
  static host = null;

  constructor(id) {
    this.id = id;
    this.handlers = {};
    if (String(id || '').startsWith('politikish-')) FakePeer.host = this;
  }

  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    if (event === 'open') queueMicrotask(() => fn());
    return this;
  }

  emit(event, ...args) {
    (this.handlers[event] || []).forEach((fn) => fn(...args));
  }

  connect() { throw new Error('FakePeer.connect is not used by the host-side harness'); }
  destroy() { if (FakePeer.host === this) FakePeer.host = null; }
}

globalThis.Peer = FakePeer;
