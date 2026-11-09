// Genera data/sondeos.json cifrado a partir de elecciones29n.com. Si algo no cuadra, falla y conserva el último archivo bueno.
const crypto = require('crypto'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const SOURCE = 'https://elecciones29n.com/?lang=es';
const DATA_URL = 'https://elecciones29n.com/js/poll-data.js';
const ROOT = path.join(__dirname, '..');
const OUTPUT = process.env.FEED_OUTPUT ?? path.join(ROOT, 'data', 'sondeos.json');
const PUBLIC_KEY = process.env.FEED_PUBLIC_KEY ?? path.join(ROOT, 'clave-publica.json');
const FIELDS = ['id', 'label', 'pollster', 'client', 'published', 'start', 'end', 'sample', 'method', 'votes', 'seats', 'ranges', 'kind', 'provenance', 'source', 'compilation'];
const WINDOW_DAYS = 150;

// LOREG art. 69.7: sin difusión de sondeos durante los cinco días anteriores a la votación ni hasta el cierre.
function inBlackout(now) {
  const madrid = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }).format(now);
  return madrid >= '2026-11-24 00:00' && madrid < '2026-11-29 20:00';
}
// Interpreta solo listas, objetos, textos, números y null. Cualquier otra expresión hace fallar la tarea.
function parseLiteral(text, start) {
  let i = start;
  const fail = () => { throw new Error('Expresión inesperada en la lista de sondeos: ' + text.slice(i, i + 40)); };
  function skip() {
    for (;;) {
      while (/\s/.test(text[i] ?? '')) i++;
      if (text.startsWith('//', i)) { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; }
      else if (text.startsWith('/*', i)) { const n = text.indexOf('*/', i); if (n < 0) fail(); i = n + 2; }
      else return;
    }
  }
  function string() {
    const quote = text[i++];
    let out = '';
    while (text[i] !== quote) {
      if (i >= text.length || text[i] === '\n') fail();
      if (text[i] === '\\') {
        const c = text[i + 1];
        if (c === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\', '/': '/', '`': '`' };
        if (!(c in map)) fail();
        out += map[c]; i += 2; continue;
      }
      out += text[i++];
    }
    i++;
    return out;
  }
  function value() {
    skip();
    const c = text[i];
    if (c === '[') {
      i++; const list = [];
      for (;;) { skip(); if (text[i] === ']') { i++; return list; } list.push(value()); skip(); if (text[i] === ',') i++; else if (text[i] !== ']') fail(); }
    }
    if (c === '{') {
      i++; const object = Object.create(null);
      for (;;) {
        skip();
        if (text[i] === '}') { i++; return { ...object }; }
        let key;
        if (text[i] === '"' || text[i] === "'") key = string();
        else { const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 80)); if (!m) fail(); key = m[0]; i += key.length; }
        skip(); if (text[i] !== ':') fail(); i++;
        object[key] = value();
        skip(); if (text[i] === ',') i++; else if (text[i] !== '}') fail();
      }
    }
    if (c === '"' || c === "'") return string();
    for (const [word, result] of [['null', null], ['true', true], ['false', false]]) if (text.startsWith(word, i)) { i += word.length; return result; }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(i, i + 32));
    if (!number) fail();
    i += number[0].length;
    return Number(number[0]);
  }
  return value();
}
// Extrae los datos como texto; el código de la web nunca se ejecuta.
function extract(text) {
  const blocked = /POLLING_SERVER_BLOCKED\s*=\s*true/.test(text);
  if (!/POLLING_SERVER_BLOCKED\s*=\s*(true|false)/.test(text)) throw new Error('Formato desconocido');
  if (blocked) return { blocked, polls: [] };
  const declared = text.search(/export const POLLS\s*=\s*\[/);
  if (declared < 0) throw new Error('No se encuentra la lista de sondeos');
  return { blocked, polls: parseLiteral(text, text.indexOf('[', declared)) };
}
function check(all, today) {
  if (all.length < 300) throw new Error(`Solo ${all.length} sondeos: el archivo puede haber cambiado`);
  const newest = all.map(p => p.published).filter(Boolean).sort().at(-1);
  if ((Date.parse(today) - Date.parse(newest)) / 864e5 > 45) throw new Error('El sondeo más reciente es demasiado antiguo: ' + newest);
  for (const p of all) {
    for (const [id, v] of Object.entries(p.votes ?? {})) if (typeof v !== 'number' || !(v >= 0 && v <= 70)) throw new Error(`Valor imposible en ${p.id}: ${id}=${v}`);
    if (['pp', 'psoe', 'vox'].every(id => typeof p.votes?.[id] === 'number') && p.kind === 'estimate') {
      const main = p.votes.pp + p.votes.psoe + p.votes.vox;
      if (main < 40 || main > 95) throw new Error(`Suma improbable en ${p.id}: ${main}`);
    }
  }
}
function seal(value) {
  const publicJwk = JSON.parse(fs.readFileSync(PUBLIC_KEY, 'utf8'));
  const recipient = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secret = crypto.diffieHellman({ privateKey, publicKey: recipient });
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(32), 'observatorio29n-feed-v1', 32));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))), cipher.final(), cipher.getAuthTag()]);
  return { epk: publicKey.export({ format: 'jwk' }), iv: iv.toString('base64'), ct: body.toString('base64') };
}
function write(envelope) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch {}
  if (previous?.schema === 2 && previous.paused === envelope.paused && previous.digest === envelope.digest) { console.log('Sin cambios'); return; }
  fs.writeFileSync(OUTPUT, JSON.stringify(envelope) + '\n');
  console.log(`Escrito, pausa=${envelope.paused}`);
}
(async () => {
  const now = process.env.FEED_NOW ? new Date(process.env.FEED_NOW) : new Date();
  const today = now.toISOString().slice(0, 10);
  const paused = { schema: 2, paused: true, updated: today, digest: null };
  if (inBlackout(now)) { write(paused); return; }
  let text;
  if (process.env.SITE_FILE) text = fs.readFileSync(process.env.SITE_FILE, 'utf8');
  else {
    const response = await fetch(DATA_URL, { headers: { 'User-Agent': 'Observatorio29N-updater/1.0' } });
    if (!response.ok) throw new Error('La web respondió ' + response.status);
    text = await response.text();
  }
  const { blocked, polls: all } = extract(text);
  if (blocked) { console.log('La web tiene los sondeos bloqueados: se respeta'); write(paused); return; }
  check(all, today);
  const from = new Date(now - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const polls = all.filter(p => p.published >= from).map(p => Object.fromEntries(FIELDS.filter(k => p[k] !== undefined).map(k => [k, p[k]])));
  const digest = crypto.createHash('sha256').update(JSON.stringify(polls)).digest('hex');
  write({ schema: 2, paused: false, updated: today, digest, ...seal({ source: SOURCE, polls }) });
})().catch(error => { console.error(error.message); process.exit(1); });
