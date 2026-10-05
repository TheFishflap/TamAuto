// Kanal-Schlüssel (Referenz für Tests und Lizenz-GUI) – Verfahren v1:
// - Gerät: ECDH P-256, öffentlicher Schlüssel pk = base64url(raw, 65 Byte), in Anfrage/Status des Scripts
// - Lizenz-Feld cke = { e: Ephemeral-pk, i: IV, c: AES-GCM(ck) }; AES-Schlüssel = SHA-256(ECDH-Geheimnis ‖ "tam-ck-v1")
// - ck (32 Byte, für alle Lizenzen gleich) → Kanalname "tamk-" + base32(HMAC(ck, "topic:<name>"))[0..24]
//   und Nachrichtenschlüssel HMAC(ck, "enc") → Meldungen { v: 2, i, c } (AES-GCM, schützt Inhalt und Echtheit)
'use strict';
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const getRandomValues = (a) => webcrypto.getRandomValues(a);

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s) => new TextEncoder().encode(s);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

async function sealChannelKey(pk, ck) {
  const dev = await subtle.importKey('raw', fromB64u(pk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: dev }, eph.privateKey, 256));
  const aes = await subtle.importKey('raw', await subtle.digest('SHA-256', new Uint8Array([...bits, ...utf8('tam-ck-v1')])), 'AES-GCM', false, ['encrypt']);
  const iv = getRandomValues(new Uint8Array(12));
  const c = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, ck);
  return { e: b64u(await subtle.exportKey('raw', eph.publicKey)), i: b64u(iv), c: b64u(c) };
}
const hmac = async (ck, label) => new Uint8Array(await subtle.sign('HMAC',
  await subtle.importKey('raw', ck, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), utf8(label)));
async function channelTopic(ck, name) { return 'tamk-' + [...(await hmac(ck, `topic:${name}`)).slice(0, 24)].map((x) => B32[x % 32]).join(''); }
const msgKey = async (ck) => subtle.importKey('raw', await hmac(ck, 'enc'), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function encryptMsg(ck, obj) {
  const iv = getRandomValues(new Uint8Array(12));
  return { v: 2, i: b64u(iv), c: b64u(await subtle.encrypt({ name: 'AES-GCM', iv }, await msgKey(ck), utf8(JSON.stringify(obj)))) };
}
async function decryptMsg(ck, m) {
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(m.i) }, await msgKey(ck), fromB64u(m.c))));
}
const newChannelKey = () => getRandomValues(new Uint8Array(32));

module.exports = { sealChannelKey, channelTopic, encryptMsg, decryptMsg, newChannelKey, b64u };
