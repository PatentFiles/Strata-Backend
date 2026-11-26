import WebSocket from 'ws';
import {endpoint} from './capture.mjs';
const MAX_PAYLOAD = 256 * 1024;
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_QUEUED_MESSAGES = 16;

// The running application has no URL/env override and cannot follow a redirect.
// The constructor seam is for fixture tests; runtime always uses ws with normal CA validation.
export function makeFixedTlsDial(Socket = WebSocket) {
  return async ({url, headers, followRedirects, signal}) => {
    if (url !== endpoint || followRedirects !== false || !(signal instanceof AbortSignal)) {
      throw Error('dial_scope_refused');
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const ws = new Socket(endpoint, {
        headers, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        followRedirects: false, perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD, handshakeTimeout: 5000,
      });
      const frames = [];
      let pending, queuedBytes = 0, ready = false, terminal = false, sent = false;
      const close = () => finish();
      function finish() {
        if (terminal) return;
        terminal = true;
        frames.length = 0; queuedBytes = 0;
        signal.removeEventListener('abort', close);
        const err = Error('book_socket_closed');
        if (!ready) reject(err);
        if (pending) { pending.reject(err); pending = undefined; }
        try { ws.terminate(); } catch {}
      }
      ws.on('error', finish);
      ws.on('close', finish);
      ws.on('message', (data, binary) => {
        if (terminal) return;
        if (!ready || binary || !Buffer.isBuffer(data) || data.length > MAX_PAYLOAD) return finish();
        if (pending) { pending.resolve(data.toString('utf8')); pending = undefined; return; }
        if (frames.length >= MAX_QUEUED_MESSAGES || queuedBytes + data.length > MAX_QUEUED_BYTES) return finish();
        frames.push(data); queuedBytes += data.length;
      });
      ws.once('open', () => {
        if (terminal) return;
        ready = true;
        resolve(Object.freeze({
          sendText(value) {
            if (terminal || sent || typeof value !== 'string' || Buffer.byteLength(value) > 256) {
              return Promise.reject(Error('book_socket_send_refused'));
            }
            sent = true;
            return new Promise((ok, no) => ws.send(value, {binary:false}, err => {
              if (err) {finish(); no(Error('book_socket_send_failed'));} else ok();
            }));
          },
          nextText() {
            if (terminal || pending) return Promise.reject(Error('book_socket_read_refused'));
            if (frames.length) {
              const head = frames.shift(); queuedBytes -= head.length;
              return Promise.resolve(head.toString('utf8'));
            }
            return new Promise((resolve, reject) => { pending = {resolve, reject}; });
          },
          close,
        }));
      });
      signal.addEventListener('abort', close, {once:true});
      if (signal.aborted) finish();
    });
  };
}
