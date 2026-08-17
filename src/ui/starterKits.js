// ---------------------------------------------------------------------------
// STARTER KITS  --  a room to play in, not a piece of music.
//
// The blank page is the real problem for a first-time user, and the wrong fix
// is to hand them something that already sounds finished: if the app writes the
// music, the user is an audience. So a kit sets up the ROOM -- which sound
// world, what tempo, how much of the rule set is switched on, how hard the grid
// pulls -- and at most drops in ONE foundation loop to play over.
//
// The melody, the phrasing, the arrangement and every note anyone will remember
// still have to be typed. That is the whole product.
//
// -- WHY THE EVENT ORDER IS FIXED ------------------------------------------
// Applying a kit is a real performance action and goes into the session log
// like any other. Its events are emitted in one fixed order -- sound, tempo,
// complexity, timing, then the foundation -- so that the same kit applied to
// the same state always writes the same thing. Sound comes first on purpose:
// it also chooses the pitch material, and ADD_BUILTIN_LOOP reads that material
// when it builds its notes, so a foundation added before the sound world was
// set would be built from the previous world's scale.
// ---------------------------------------------------------------------------

import { EV } from '../session/sessionEvents.js';

export const STARTER_KITS = [
  {
    id: 'dusk-piano',
    name: 'DUSK PIANO',
    nameJa: '夕暮れのピアノ',
    tagline: 'Melancholy keys over a dusty slow beat',
    taglineJa: '哀愁のあるピアノと、乾いたスロービート',
    detail: 'An original downtempo room: restrained piano, soft bass and plenty of air.',
    detailJa: '静かなピアノ、柔らかい低音、広い余白。ダウンテンポのオリジナル作例です。',
    accent: 'dusk',
    settings: { soundSet: 'piano', bpm: 92, complexity: 20, quantize: 'LIGHT' },
    foundation: 'dusk',
    firstMove: 'Play H J K slowly, then leave a breath before you repeat it',
    firstMoveJa: 'H・J・Kをゆっくり弾き、少し間を空けて繰り返してみてください',
  },
  {
    id: 'neon-pulse',
    name: 'NEON PULSE',
    tagline: 'A clear beat to play over',
    detail: 'Electronic. The steady one — your right hand can just sing over the top.',
    accent: 'neon',
    settings: { soundSet: 'electronic', bpm: 120, complexity: 40, quantize: 'LIGHT' },
    foundation: 'beat',
    firstMove: 'Type 8–24 letters with your right hand',
    nameJa: 'ネオン・パルス',
    taglineJa: '上に音を重ねやすい、はっきりしたビート',
    detailJa: '電子音。一定のビートに、右手でメロディーを重ねられます。',
    firstMoveJa: '右手側のキーを8〜24回打ってみてください',
  },
  {
    id: 'warm-keys',
    name: 'WARM KEYS',
    tagline: 'Piano, and room to breathe',
    detail: 'Notes fade on their own, so the gaps you leave are part of the music.',
    accent: 'warm',
    settings: { soundSet: 'piano', bpm: 96, complexity: 30, quantize: 'LIGHT' },
    foundation: 'ambient',
    firstMove: 'Play a few notes, then stop and let them ring',
    nameJa: 'ウォーム・キーズ',
    taglineJa: 'ピアノと、音が呼吸する余白',
    detailJa: '音は自然に小さくなります。キーを打たない時間も音楽になります。',
    firstMoveJa: '数音だけ弾き、止まって余韻を聴いてください',
  },
  {
    id: 'wood-and-wire',
    name: 'WOOD & WIRE',
    tagline: 'Short, plucked, repeatable',
    detail: 'Rewards a small figure you repeat — the same three keys, over and over.',
    accent: 'wood',
    settings: { soundSet: 'plucked', bpm: 108, complexity: 35, quantize: 'STRONG' },
    foundation: 'pulse',
    firstMove: 'Repeat a short pattern — j k l, j k l',
    nameJa: 'ウッド＆ワイヤー',
    taglineJa: '短く、弦らしく、繰り返しやすい音',
    detailJa: '同じ3キーを繰り返すような、小さなフレーズに向いています。',
    firstMoveJa: 'J・K・L、J・K・Lのように短い型を繰り返してください',
  },
  {
    id: 'empty-canvas',
    name: 'EMPTY CANVAS',
    tagline: 'Nothing but you',
    detail: 'No foundation, no grid pulling at your timing. Everything is your typing.',
    accent: 'plain',
    settings: { soundSet: 'electronic', bpm: 110, complexity: 40, quantize: 'OFF' },
    foundation: null,
    firstMove: 'Type anything at all',
    nameJa: '空のキャンバス',
    taglineJa: 'あなたのタイピングだけ',
    detailJa: '土台もタイミング補正もありません。すべてがあなたの打鍵です。',
    firstMoveJa: 'まずは自由に何か打ってみてください',
  },
];

export function findKit(id) {
  return STARTER_KITS.find((k) => k.id === id) || null;
}

/**
 * The session events applying a kit produces.
 *
 * PURE and ORDER-STABLE -- see the header. `hasFreeTrack` is passed in rather
 * than read from an engine so this stays testable without an audio context,
 * and so a kit chosen when all four tracks are full quietly skips its
 * foundation instead of failing.
 *
 * @returns {{type: string, data: object}[]}
 */
export function planKitEvents(kit, { hasFreeTrack = true } = {}) {
  if (!kit) return [];
  const s = kit.settings;
  const out = [
    { type: EV.SET_SOUND, data: { value: s.soundSet } },
    { type: EV.SET_BPM, data: { value: s.bpm } },
    { type: EV.SET_COMPLEXITY, data: { value: s.complexity } },
    { type: EV.SET_QUANTIZE, data: { value: s.quantize } },
  ];
  if (kit.foundation && hasFreeTrack) {
    out.push({ type: EV.ADD_BUILTIN_LOOP, data: { loop: kit.foundation } });
  }
  return out;
}

/**
 * A short phrase to audition a sound world with.
 *
 * PREVIEW ONLY. These are PerformanceEvents in the ordinary shape, but they are
 * played on the preview bus and are never dispatched, never collected into a
 * loop and never recorded -- see SoundEngine.playPreview. Auditioning a sound
 * must not put a note in the piece you are working on.
 */
export function previewPhrase(scale, midiToFreq) {
  const degrees = [0, 2, 4, 2];
  return degrees.map((d, i) => {
    const midi = scale.root + scale.steps[d % scale.steps.length];
    return {
      at: i * 0.16,
      ev: {
        time: 0,
        sourceSeq: -9000 - i,
        instrument: i === 3 ? 'bass' : 'melody',
        part: null,
        note: i === 3 ? midi - 12 : midi,
        freq: midiToFreq(i === 3 ? midi - 12 : midi),
        duration: i === 3 ? 0.9 : 0.5,
        gated: false,
        velocity: i === 0 ? 104 : 88,
        pan: 0,
        fx: { delay: 0.08, reverb: 0.2, drive: 0.1, feedback: 0.2, brightness: 0.7 },
        tag: 'preview',
      },
    };
  });
}
