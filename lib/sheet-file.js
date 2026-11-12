// A file someone exported from another system (Regroup, a spreadsheet, a
// database) read into one table, so the importer sees columns and rows the
// same way whatever came in: CSV, tab-separated text, Excel (.xlsx) or JSON.
// No dependency: an .xlsx is a zip of XML parts, read here with zlib.
//
// readTableFile({ name, data }) → { sheets: ['Directory', ...], sheet, csv }
//   name: the file's name (its type comes from the name, never a browser label)
//   data: the file's bytes, as a Buffer or base64 text
//   sheet: optional, which sheet of a workbook (or list in a JSON file) to read

import zlib from 'node:zlib';
import { PublicError } from './public-error.js';

const MAX_UNZIPPED = 60 * 1024 * 1024;
const unreadable = (msg) => new PublicError(400, 'unreadable_file', msg);

const quote = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const tableToCsv = (rows) => `${rows.map((r) => r.map(quote).join(',')).join('\r\n')}\r\n`;

export function readTableFile({ name, data, sheet = '' }) {
  const ext = (/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw unreadable('The file is empty');
  if (ext === 'xlsx' || ext === 'xlsm') return pick(readXlsx(buf), sheet);
  if (ext === 'xls') throw unreadable('That is an old Excel file. Save it as .xlsx or CSV and choose it again.');
  if (ext === 'numbers' || ext === 'ods') throw unreadable('Save the sheet as .xlsx or CSV and choose it again.');
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (ext === 'json' || (!ext && /^\s*[[{]/.test(text))) return pick(readJson(text), sheet);
  // CSV or tab-separated: a header line with tabs and no commas is tab-separated.
  const first = text.split(/\r?\n/, 1)[0] || '';
  if (ext === 'tsv' || (first.includes('\t') && !first.includes(','))) {
    return { sheets: [], sheet: '', csv: tableToCsv(text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'))) };
  }
  return { sheets: [], sheet: '', csv: text };
}

// Several tables (workbook sheets, lists in a JSON file): the one asked for,
// else the first with rows.
function pick(tables, want) {
  if (!tables.length) throw unreadable('No table was found in the file');
  const chosen = tables.find((t) => t.name === want) || tables.find((t) => t.rows.length > 1) || tables[0];
  return { sheets: tables.map((t) => t.name), sheet: chosen.name, csv: tableToCsv(chosen.rows) };
}

// ---- JSON: a list of records, or an object holding lists of records ----

function readJson(text) {
  let v;
  try { v = JSON.parse(text); } catch (_) { throw unreadable('The JSON file could not be read'); }
  const tables = [];
  const visit = (val, label, depth) => {
    if (Array.isArray(val) && val.some((x) => x && typeof x === 'object' && !Array.isArray(x))) { tables.push({ name: label || 'Records', rows: recordsToRows(val) }); return; }
    if (val && typeof val === 'object' && !Array.isArray(val) && depth < 3) for (const [k, x] of Object.entries(val)) visit(x, label ? `${label}.${k}` : k, depth + 1);
  };
  visit(v, '', 0);
  return tables;
}

// Nested fields become "contact.phone"; a list of plain values becomes "a; b".
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x ?? ''))).join('; ');
    else out[key] = v ?? '';
  }
  return out;
}

function recordsToRows(list) {
  const flat = list.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => flatten(x));
  const headers = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return [headers, ...flat.map((r) => headers.map((h) => (r[h] === undefined ? '' : String(r[h]))))];
}

// ---- XLSX ----

function unzip(buf) {
  // End of central directory: the last "PK\5\6" in the final 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw unreadable('The Excel file could not be read');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^(xl\/|\[Content_Types\])/.test(name) || !/\.(xml|rels)$/.test(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let out;
    try { out = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }); } catch (_) { throw unreadable('The Excel file is too large or damaged'); }
    total += out.length;
    if (total > MAX_UNZIPPED) throw unreadable('The Excel file is too large');
    files.set(name, out.toString('utf8'));
  }
  return files;
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? decode(m[1]) : ''; };
// All the text of an element, rich-text runs joined, phonetic hints left out.
const textOf = (xml) => decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map([...stylesXml.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode')]));
  const isDate = (id) => DATE_FORMATS.has(id) || (custom.has(id) && /[dmy]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || '';
  const out = new Set();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => { if (isDate(Number(attr(m[0], 'numFmtId')))) out.add(i); });
  return out;
}

// An Excel day number as YYYY-MM-DD, with the time when it has one.
function excelDay(serial, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] || '') n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

function readXlsx(buf) {
  const files = unzip(buf);
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw unreadable('The Excel file could not be read');
  const rels = new Map([...(files.get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(files.get('xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const tables = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const file = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = files.get(file);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const inner = c[2] || '';
        const type = attr(tag, 't');
        const v = decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || '');
        let val = v;
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = textOf(inner);
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (type !== 'str' && type !== 'e' && v !== '' && dates.has(Number(attr(tag, 's') || 0)) && Number.isFinite(Number(v))) val = excelDay(Number(v), date1904);
        const ref = attr(tag, 'r');
        const i = ref ? colIndex(ref) : row.length;
        if (i >= 0 && i < 1000) row[i] = val;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    const kept = rows.filter((r) => r.some((x) => String(x).trim() !== ''));
    tables.push({ name: attr(m[0], 'name') || `Sheet ${tables.length + 1}`, rows: kept });
  }
  return tables;
}
