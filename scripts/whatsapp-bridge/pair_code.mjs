#!/usr/bin/env node
/**
 * Pair the WhatsApp bridge with an 8-character link code instead of a QR scan.
 * (WhatsApp's linked-device scanner has no gallery/photo picker, so a QR that
 * lives in a chat cannot be scanned. A link code needs no camera.)
 *
 *   node pair_code.mjs <phone-in-E164-without-plus> [sessionDir] [eventFile]
 *
 * Events are appended as JSON lines to <eventFile>; the code is also printed.
 * The process stays alive until the phone finishes linking, then exits 0.
 */
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

const phone = (process.argv[2] || '').replace(/[^0-9]/g, '');
const sessionDir = process.argv[3] || path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session');
const eventFile = process.argv[4] || path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'pair', 'code.jsonl');

if (!phone || phone.length < 8) {
  console.error('usage: node pair_code.mjs <phone-with-country-code> [sessionDir] [eventFile]');
  process.exit(2);
}
mkdirSync(path.dirname(eventFile), { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const emit = (obj) => {
  try {
    appendFileSync(eventFile, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch {
    /* never let logging kill pairing */
  }
};

const log = pino({ level: 'silent' });
const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

// A stale bundled WA-Web version makes the server hang up with 405 before the
// link code ever reaches the phone, so resolve the current one first.
let version;
try {
  const fetched = await Promise.race([
    fetchLatestBaileysVersion(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timed out')), 15000)),
  ]);
  version = fetched.version;
  emit({ event: 'version', version: version?.join('.') });
} catch (err) {
  emit({ event: 'version_unavailable', error: String(err?.message || err) });
}

const sock = makeWASocket({
  ...(version ? { version } : {}),
  auth: state,
  logger: log,
  printQRInTerminal: false,
  browser: ['Hermes Agent', 'Chrome', '120.0'],
  syncFullHistory: false,
  markOnlineOnConnect: false,
  getMessage: async () => ({ conversation: '' }),
});

sock.ev.on('creds.update', () => {
  void saveCreds();
  emit({ event: 'creds_update' });
});

let requested = false;
sock.ev.on('connection.update', (update) => {
  const { connection, lastDisconnect, qr, passkeyRequired, passkeyError } = update;

  if (passkeyRequired) {
    emit({ event: 'error', error: 'passkey_required' });
    console.error('WhatsApp demands passkey verification — link code pairing cannot complete here.');
    process.exit(3);
  }
  if (passkeyError) {
    emit({ event: 'passkey_error', error: String(passkeyError?.message || passkeyError) });
  }

  if (qr && !requested && !sock.authState.creds.registered) {
    requested = true;
    (async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        emit({ event: 'pair_code', code });
        console.log(`PAIR_CODE ${code}`);
      } catch (err) {
        emit({ event: 'error', error: String(err?.message || err) });
        console.error('requestPairingCode failed:', err);
        process.exit(4);
      }
    })();
  }

  if (connection === 'open') {
    emit({ event: 'connected', me: sock.user?.id, name: sock.user?.name || sock.user?.verifiedName });
    console.log(`CONNECTED ${sock.user?.id || ''}`);
    setTimeout(() => process.exit(0), 1500);
  }

  if (connection === 'close') {
    const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
    emit({ event: 'closed', reason: status });
    if (status === DisconnectReason.loggedOut) {
      console.error('logged out');
      process.exit(1);
    }
  }
});

emit({ event: 'started', phone, session: sessionDir });
setTimeout(() => {
  emit({ event: 'timeout' });
  console.error('timeout: no link within 10 minutes');
  process.exit(5);
}, 10 * 60 * 1000).unref();
