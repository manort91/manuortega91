// Lee la primera tabla de estimación de voto de la página de sondeos de Wikipedia.
const SECTION = '2026 (with Broad Front)';
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const PARTY_IDS = { PP:'pp', PSOE:'psoe', Vox:'vox', FA:'sumar', FV:'compromis', ERC:'erc', Junts:'junts', 'EH Bildu':'bildu', PNV:'pnv', BNG:'bng', CCa:'cc', Podemos:'podemos', SALF:'salf' };

function sectionTable(wikitext, section = SECTION) {
  const heading = wikitext.search(new RegExp('=+\\s*' + section.replace(/[()]/g, '\\$&') + '\\s*=+'));
  if (heading < 0) throw new Error('No se encuentra la sección: ' + section);
  const start = wikitext.indexOf('{|', heading);
  const end = wikitext.indexOf('\n|}', start);
  if (start < 0 || end < 0) throw new Error('Tabla incompleta');
  return wikitext.slice(start, end);
}
function partyColumns(headerRow) {
  const parties = [];
  for (const line of headerRow.split('\n')) {
    if (!line.startsWith('!') || /rowspan/.test(line) && !/File:|\[\[/.test(line)) continue;
    if (/Polling firm|Fieldwork|Sample|Turnout|Lead/.test(line)) continue;
    if (/Adelante/.test(line)) { parties.push('adelante'); continue; }
    const label = line.match(/\|([^|\]]+)\]\]\s*$/)?.[1]?.trim();
    if (!label || !PARTY_IDS[label]) throw new Error('Columna de partido desconocida: ' + line.slice(0, 120));
    parties.push(PARTY_IDS[label]);
  }
  return parties;
}
const stripRefs = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref\b[^>]*\/>/g, '').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, '').replace(/\{\{efn[\s\S]*?\}\}/gi, '');
function splitCells(row) {
  const cells = [];
  for (const line of stripRefs(row).split('\n')) {
    if (/^\|[-}+]/.test(line) || line.startsWith('!')) continue;
    if (line.startsWith('|')) cells.push(line.slice(1));
    else if (cells.length) cells[cells.length - 1] += '\n' + line;
  }
  return cells.map(cell => {
    const m = cell.match(/^\s*((?:\{\{[^{}]*\}\}\s*)?(?:(?:colspan|rowspan|style|class)\s*=\s*"?[^|"]*"?\s*)*)\|(?!\|)(.*)$/s);
    const attrs = m ? m[1] : '', text = (m ? m[2] : cell).trim();
    const span = name => Number(attrs.match(new RegExp(name + '\\s*=\\s*"?(\\d+)'))?.[1] ?? 1);
    return { text, colspan: span('colspan'), rowspan: span('rowspan') };
  });
}
function fieldwork(text, year) {
  const t = text.replace(/&ndash;|—/g, '–').replace(/\[\[|\]\]/g, '').trim();
  const m = t.match(/^(\d{1,2})(?:\s+([A-Za-z]{3}))?(?:\s*–\s*(\d{1,2})\s+([A-Za-z]{3}))?(?:\s+([A-Za-z]{3}))?/);
  if (!m) return null;
  const endMonth = MONTHS[(m[4] ?? m[2] ?? m[5] ?? '').toLowerCase()];
  if (!endMonth) return null;
  const startMonth = MONTHS[(m[2] ?? m[4] ?? '').toLowerCase()] ?? endMonth;
  const iso = (d, mo) => `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: iso(m[1], startMonth), end: iso(m[3] ?? m[1], endMonth) };
}
function citeDate(raw) {
  const m = raw.match(/\|\s*date\s*=\s*(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
}
function cellValue(text) {
  const clean = text.replace(/'''/g, '').trim();
  const vote = clean.match(/^(\d+(?:\.\d+)?)/);
  const seat = clean.match(/text=\s*(\d+)(?:[/–-](\d+))?/);
  return { vote: vote ? Number(vote[1]) : null, seats: seat ? Number(seat[1]) : null, range: seat?.[2] ? [Number(seat[1]), Number(seat[2])] : null };
}
const slug = s => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = s => s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').trim();

function parsePolls(wikitext, { year = 2026 } = {}) {
  const table = sectionTable(wikitext);
  const rows = table.split(/\n\|-[^\n]*/);
  const parties = partyColumns(rows[1]);
  const fixed = 4, polls = [], carry = [];
  for (const raw of rows.slice(2)) {
    if (raw.split('\n').some(l => l.startsWith('!')) && !/\n\|/.test(raw)) continue;
    const grid = [];
    const queue = splitCells(raw);
    let col = 0;
    while (queue.length || carry[col]?.left > 0) {
      if (carry[col]?.left > 0) { grid[col] = carry[col].text; carry[col].left--; col++; continue; }
      const cell = queue.shift();
      if (!cell) break;
      for (let i = 0; i < cell.colspan; i++) {
        // Una celda que une varias columnas de partido cuenta solo en la primera.
        const text = i === 0 ? cell.text : '';
        grid[col + i] = text;
        if (cell.rowspan > 1) carry[col + i] = { text, left: cell.rowspan - 1 };
      }
      col += cell.colspan;
    }
    const name = plain(grid[0] ?? '');
    const dates = fieldwork(grid[1] ?? '', year);
    if (!name || !dates || /general election/i.test(name)) continue;
    const [pollster, ...rest] = name.split('/').map(s => s.trim());
    const votes = {}, seats = {}, ranges = {};
    parties.forEach((id, i) => {
      const v = cellValue(grid[fixed + i] ?? '');
      if (v.vote != null) votes[id] = v.vote;
      if (v.range) ranges[id] = v.range; else if (v.seats != null) seats[id] = v.seats;
    });
    if (!Object.keys(votes).length) continue;
    const url = raw.match(/\|\s*url\s*=\s*(https:\/\/[^\s|}]+)/)?.[1] ?? null;
    const published = citeDate(raw) ?? dates.end;
    const sample = Number((grid[2] ?? '').replace(/[^\d]/g, '')) || null;
    const internal = /^(PP|PSOE|Vox|Sumar|Podemos|FA|Frente Amplio)$/i.test(pollster);
    polls.push({ id: `${slug(pollster)}-${published}-${dates.end}`, ...(internal ? { kind: 'internal' } : {}), pollster, client: rest.join(' / ') || null, published, start: dates.start, end: dates.end, sample, votes, seats: Object.keys(seats).length ? seats : null, ranges: Object.keys(ranges).length ? ranges : null, source: url });
  }
  return { parties, polls };
}
module.exports = { parsePolls, slug };
