// The look of the pages: the shared TSS theme tokens, the brand mark in the
// upper left, DM Sans (as in Cockpit), and the writing rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, ago, age, launchRoute } from '../public/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const src = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

test('the stylesheet carries the shared TSS theme tokens and names no brand color of its own', () => {
  const css = src('styles.css');
  const block = css.slice(css.indexOf('/* tss-theme:start */'), css.indexOf('/* tss-theme:end */'));
  const tokens = Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m, i) => [`${i < 20 ? 'light' : 'dark'}:${m[1]}`, m[2].toUpperCase()]));
  const shared = { 'light:bg': '#F6F4EE', 'light:surface': '#FFFFFF', 'light:sunken': '#F1EEE5', 'light:text': '#222724', 'light:primary': '#0A3269', 'light:primary-hover': '#0D4284', 'light:primary-subtle': '#E6EBF3', 'light:accent': '#A9512F', 'light:border': '#DDD7CA', 'light:focus': '#1F6FB2', 'dark:bg': '#191D1A', 'dark:surface': '#222724', 'dark:primary': '#82A9D2', 'dark:primary-text': '#10243D', 'dark:accent': '#E99073' };
  for (const [k, v] of Object.entries(shared)) assert.equal(tokens[k], v, k);
  const rest = css.slice(css.indexOf('/* tss-theme:end */'));
  for (const brand of ['#0a3269', '#17457f', '#c87255', '#a9512f', '#f6f4ee', '#ddd7ca']) assert.ok(!rest.toLowerCase().includes(brand), `${brand} named outside the theme tokens`);
  assert.ok(css.includes('@font-face { font-family: "DM Sans"; src: url("/fonts/dm-sans.woff2")'), 'DM Sans, served from this app, as in Cockpit');
  assert.ok(fs.existsSync(path.join(pub, 'fonts', 'dm-sans.woff2')), 'the font file ships with the app');
});

test('upper left of every screen: TSS wordmark, the Vault icon, the name, Wally', () => {
  const html = src('index.html');
  assert.match(html, /<aside class="side">\s*<a class="brandbar"[^>]*>.*brandbar-tss.*brandbar-icon.*<span class="brandbar-name">Vault<\/span>.*brandbar-wally/);
  assert.match(html, /<h1 class="brandbar brandbar-login">.*brandbar-tss.*brandbar-icon.*Vault.*brandbar-wally/);
  for (const f of ['brand/tss-wordmark.webp', 'brand/tss-wordmark-light.webp', 'brand/wally.webp', 'brand/vault.png']) assert.ok(fs.existsSync(path.join(pub, f)), f);
  assert.doesNotMatch(html, /TSS[- ]Vault|TSS[- ]Work/, 'TSS appears only as the wordmark');
});

test('interface text has no em dash and does not call the app TSS-anything', () => {
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    const text = src(f);
    assert.ok(!text.includes('—'), `${f} has an em dash`);
    assert.doesNotMatch(text, /TSS-\w/, `${f} names an app TSS-something`);
  }
});

test('the first screen has exactly three buttons: Message Board, Case Notes, Directory', () => {
  const js = src('app.js');
  const home = js.slice(js.indexOf('async function showHome'), js.indexOf('// ---- message board'));
  assert.deepEqual([...home.matchAll(/<a class="door" href="#\/(\w+)"><span class="t">([^<]+)</g)].map((m) => [m[1], m[2]]),
    [['board', 'Message Board'], ['notes', 'Case Notes'], ['directory', 'Directory']]);
});

test('the page helpers escape and say how long ago and how old', () => {
  assert.equal(esc(`<b>"O'Brien" & co</b>`), '&lt;b&gt;&quot;O&#39;Brien&quot; &amp; co&lt;/b&gt;');
  assert.equal(ago('', '2026-11-03'), 'never');
  assert.equal(ago('2026-11-03', '2026-11-03'), 'today');
  assert.equal(ago('2026-11-02', '2026-11-03'), 'yesterday');
  assert.equal(ago('2026-10-01', '2026-11-03'), '33 days ago');
  assert.equal(ago('2026-05-01', '2026-11-03'), '6 months ago');
  assert.equal(age('2010-11-04', '2026-11-03'), 15);
  assert.equal(age('2010-11-03', '2026-11-03'), 16);
  assert.equal(age('', '2026-11-03'), null);
});

test('a launch from Cockpit may name a screen, and only a plain hash route is kept', () => {
  assert.equal(launchRoute('#tss_launch=abc&tss_to=%23%2Fboard%3Fpost%3Dp-1'), '#/board?post=p-1');
  assert.equal(launchRoute('#tss_launch=abc'), '');
  assert.equal(launchRoute('#tss_launch=abc&tss_to=javascript%3Aalert(1)'), '');
  assert.equal(launchRoute('#tss_launch=abc&tss_to=%23%2F%3Cimg%3E'), '');
});
