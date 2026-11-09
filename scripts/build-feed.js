// Genera data/sondeos.json a partir de Wikipedia. Si algo no cuadra, falla y conserva el último archivo bueno.
const fs = require('fs'), path = require('path');
const { parsePolls } = require('./wiki-polls');
const PAGE = 'Opinion_polling_for_the_2026_Spanish_general_election';
const SOURCE = 'https://en.wikipedia.org/wiki/' + PAGE;
const API = `https://en.wikipedia.org/w/api.php?action=parse&page=${PAGE}&prop=wikitext%7Crevid&format=json&formatversion=2`;
const OUTPUT = process.env.FEED_OUTPUT ?? path.join(__dirname, '..', 'data', 'sondeos.json');

// LOREG art. 69.7: sin difusión de sondeos durante los cinco días anteriores a la votación ni hasta el cierre.
function inBlackout(now = new Date()) {
  const madrid = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' }).format(now);
  return madrid >= '2026-11-24 00:00' && madrid < '2026-11-29 20:00';
}
function check(polls, today) {
  if (polls.length < 15) throw new Error(`Solo ${polls.length} sondeos: la tabla puede haber cambiado`);
  const newest = polls.map(p => p.published).sort().at(-1);
  if ((Date.parse(today) - Date.parse(newest)) / 864e5 > 45) throw new Error('El sondeo más reciente es demasiado antiguo: ' + newest);
  let complete = 0;
  for (const p of polls) {
    for (const [id, v] of Object.entries(p.votes)) if (!(v >= 0 && v <= 70)) throw new Error(`Valor imposible en ${p.id}: ${id}=${v}`);
    if (['pp', 'psoe', 'vox'].every(id => typeof p.votes[id] === 'number')) {
      complete++;
      const main = p.votes.pp + p.votes.psoe + p.votes.vox;
      if (main < 40 || main > 95) throw new Error(`Suma improbable en ${p.id}: ${main}`);
    }
  }
  if (complete / polls.length < .8) throw new Error('Demasiados sondeos sin PP, PSOE y Vox: las columnas pueden haber cambiado');
}
async function wikitext() {
  if (process.env.WIKITEXT_FILE) return { text: fs.readFileSync(process.env.WIKITEXT_FILE, 'utf8'), revision: 0 };
  const r = await fetch(API, { headers: { 'User-Agent': 'Observatorio29N-updater/1.0' } });
  if (!r.ok) throw new Error('Wikipedia respondió ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info);
  return { text: j.parse.wikitext, revision: j.parse.revid };
}
function write(feed) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch {}
  const body = f => JSON.stringify({ ...f, updated: null, revision: null });
  if (previous && body(previous) === body(feed)) { console.log('Sin cambios'); return; }
  fs.writeFileSync(OUTPUT, JSON.stringify(feed, null, 1) + '\n');
  console.log(`Escrito: ${feed.polls.length} sondeos, pausa=${feed.paused}`);
}
(async () => {
  const now = process.env.FEED_NOW ? new Date(process.env.FEED_NOW) : new Date();
  const base = { schema: 1, source: SOURCE, license: 'CC BY-SA 4.0', updated: now.toISOString().slice(0, 10) };
  if (inBlackout(now)) { write({ ...base, revision: null, paused: true, polls: [] }); return; }
  const { text, revision } = await wikitext();
  const { polls } = parsePolls(text);
  check(polls, base.updated);
  write({ ...base, revision, paused: false, polls });
})().catch(error => { console.error(error.message); process.exit(1); });
