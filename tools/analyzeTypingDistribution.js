// ---------------------------------------------------------------------------
// TYPING DISTRIBUTION ANALYSIS
//
//   node tools/analyzeTypingDistribution.js
//
// The mapping assumes a roughly even spread of work across the six playing
// zones. Real text is not even, and Japanese romaji is not even in the same
// way English is: every kana ends in a vowel, so A I U E O carry enormous
// weight -- and in this mapping A is the kick drum while I, U and O are bells.
//
// This tool measures that instead of guessing, so mapping changes can be argued
// from numbers. It does not change the instrument; it reports on it.
// ---------------------------------------------------------------------------

import { DEFAULT_MAPPING, ZONES, handOf, rowOf } from '../src/perf/mapping.js';

// --- fixtures ---------------------------------------------------------------
// Deliberately ordinary text, not random strings: the point is what fingers
// actually do when a person writes.
const FIXTURES = {
  'Japanese romaji (lyrics-ish)': [
    'fujirock ni detai',
    'natsu no owari ni kimi to aruita michi',
    'kono oto ga kikoeru nara sore de ii',
    'ashita mo mata koko de aou',
    'yoru no machi wa shizuka de tsumetai',
  ].join(' '),

  'Japanese romaji (plain prose)': [
    'kyou wa asa kara ame ga futte imashita',
    'densha ga okurete kaisha ni chikoku shisou desu',
    'hirugohan wa konbini no onigiri ni shimashita',
    'yoru ni naru to sukoshi samuku narimasu',
  ].join(' '),

  'English prose': [
    'the quick brown fox jumps over the lazy dog',
    'typing is the instrument and the keyboard is already in your hands',
    'nothing here is random so you can find the same sound again tomorrow',
    'we should ship the thing before we polish the thing',
  ].join(' '),

  'Deliberate playing (not language)': 'ffjjkllaaasss hjkl hjkl asdf asdf jjjj kkkk lllljjjj hjhjhjhj',
};

// --- analysis ---------------------------------------------------------------
const CHAR_TO_CODE = {};
for (const c of 'abcdefghijklmnopqrstuvwxyz') CHAR_TO_CODE[c] = 'Key' + c.toUpperCase();
for (const d of '0123456789') CHAR_TO_CODE[d] = 'Digit' + d;
Object.assign(CHAR_TO_CODE, {
  ' ': 'Space', '-': 'Minus', '=': 'Equal', ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight',
});

function analyze(text) {
  const keys = {};
  const zones = {};
  const hands = {};
  const rows = {};
  let total = 0;
  let unmapped = 0;

  for (const ch of text.toLowerCase()) {
    const code = CHAR_TO_CODE[ch];
    if (!code) continue;
    total++;
    keys[ch] = (keys[ch] || 0) + 1;
    hands[handOf(code)] = (hands[handOf(code)] || 0) + 1;
    rows[rowOf(code)] = (rows[rowOf(code)] || 0) + 1;
    const m = DEFAULT_MAPPING[code];
    if (!m) {
      unmapped++;
      continue;
    }
    const label = m.zone === 'transport' ? 'transport' : ZONES[m.zone].label;
    zones[label] = (zones[label] || 0) + 1;
  }
  return { keys, zones, hands, rows, total, unmapped };
}

function pct(n, total) {
  return total ? ((n / total) * 100).toFixed(1).padStart(5) + '%' : '   0.0%';
}

function table(title, obj, total) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  console.log('  ' + title);
  for (const [k, v] of rows) {
    const bar = '#'.repeat(Math.round((v / total) * 40));
    console.log('    ' + String(k).padEnd(12) + String(v).padStart(5) + '  ' + pct(v, total) + '  ' + bar);
  }
  console.log('');
}

console.log('');
console.log('TYPING DISTRIBUTION  --  mapping "' + DEFAULT_MAPPING.name + '"');
console.log('='.repeat(72));

const summary = [];
for (const [name, text] of Object.entries(FIXTURES)) {
  const r = analyze(text);
  console.log('');
  console.log(name + '   (' + r.total + ' keys' + (r.unmapped ? ', ' + r.unmapped + ' unmapped' : '') + ')');
  console.log('-'.repeat(72));
  table('by zone', r.zones, r.total);
  table('by hand', r.hands, r.total);
  table('by row', r.rows, r.total);

  const top = Object.entries(r.keys).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('  hottest keys: ' + top.map(([k, v]) => `${k === ' ' ? '␣' : k}:${v}`).join('  '));
  console.log('');

  summary.push({
    fixture: name,
    left: pct(r.hands.left || 0, r.total).trim(),
    right: pct(r.hands.right || 0, r.total).trim(),
    melody: pct(r.zones.Melody || 0, r.total).trim(),
    drums: pct(r.zones.Drums || 0, r.total).trim(),
    bell: pct(r.zones.Bell || 0, r.total).trim(),
    bass: pct(r.zones.Bass || 0, r.total).trim(),
  });
}

console.log('='.repeat(72));
console.log('SUMMARY');
console.table(summary);
