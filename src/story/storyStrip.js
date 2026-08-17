// ---------------------------------------------------------------------------
// STORY STRIP  --  four loops become a piece of music.
//
// Stacking four loops gives you a texture, not a song. What a song has is
// CHANGE over time: something starts alone, something joins, everything drops
// out, everything comes back.
//
// A full DAW answers that with an arrangement timeline: a horizontal ruler you
// draw regions on. That is the wrong answer here, for one specific reason --
// it stops being a performance. You would be editing the piece instead of
// playing it, and this instrument's whole claim is that typing skill becomes
// playing skill.
//
// So a SECTION is not a region on a timeline. It is a saved MIX -- which
// tracks are on, muted, and how loud -- with a name. Pressing a section applies
// that mix right now, live, as a performance gesture. The strip is the set of
// gestures you have prepared, and playing the piece means pressing them in
// order, on the beat, by hand.
//
// -- WHY APPLYING A SECTION EMITS EVERY EVENT --------------------------------
// A diff ("only send what changed") would be smaller, and wrong. The events it
// produced would depend on the state it happened to be applied from, so the
// same section pressed twice in a set would put different things in the log,
// and a replay that arrived at a slightly different mix would diverge from
// there on. Emitting the complete mix, in a fixed order, every time makes
// applying a section IDEMPOTENT and its event list a pure function of the
// section alone. That is worth twelve small events.
//
// The order within a track matters too: LAYER_ON resets `muted` (turning a
// track on is a "make this audible" gesture), so MUTE has to follow it, and
// VOLUME follows both.
// ---------------------------------------------------------------------------

import { EV } from '../session/sessionEvents.js';
import { clamp, deepClone } from '../core/hash.js';

export const DEFAULT_SECTION_NAMES = ['INTRO', 'BUILD', 'FULL', 'SPACE', 'END'];

let seq = 0;
export function makeSectionId(name, at = Date.now()) {
  seq = (seq + 1) % 100000;
  return 'sec-' + at.toString(36) + '-' + seq.toString(36) + '-' + String(name || '').toLowerCase().slice(0, 8);
}

/** the mix a section stores: one entry per track, always all of them */
export function mixFromSnapshot(view) {
  return view.layers.map((l) => ({
    layer: l.id,
    on: !!l.on,
    muted: !!l.muted,
    volume: clamp(typeof l.volume === 'number' ? l.volume : 1, 0, 1),
  }));
}

export function makeSection(name, mix) {
  return { id: makeSectionId(name), name: String(name || 'SECTION').slice(0, 40), mix: deepClone(mix) };
}

/**
 * The starting five, proposed from what is actually in the tracks.
 *
 * A PROPOSAL, not a rule: every one of them is immediately editable, and
 * "SAVE MIX" overwrites whichever is selected. The point is that a player who
 * has just made two loops should not have to invent the concept of an
 * arrangement before hearing one.
 *
 * Returns [] when there is nothing to arrange yet -- offering five empty
 * sections over a single loop is noise.
 */
export function proposeSections(view) {
  const filled = view.layers.filter((l) => l.eventCount > 0).map((l) => l.id);
  if (filled.length < 2) return [];

  const first = filled[0];
  const firstTwo = filled.slice(0, 2);
  const last = filled[filled.length - 1];

  const mix = (isOn, vol) =>
    view.layers.map((l) => ({
      layer: l.id,
      on: l.eventCount > 0 && isOn(l.id),
      muted: false,
      volume: clamp(vol ? vol(l.id) : 1, 0, 1),
    }));

  return [
    makeSection('INTRO', mix((id) => id === first)),
    makeSection('BUILD', mix((id) => firstTwo.includes(id))),
    makeSection('FULL', mix(() => true)),
    // SPACE is the section beginners never think to make and every piece needs:
    // take almost everything away so the return of FULL means something.
    makeSection('SPACE', mix((id) => id === last, () => 0.75)),
    makeSection('END', mix(() => false)),
  ];
}

/**
 * The exact session events that applying `section` produces.
 *
 * PURE: same section in, same array out, whatever the engine is currently
 * doing. That is what makes the replay of a set reproduce its arrangement, and
 * what makes the self-test able to check the order without an audio context.
 *
 * @param {object} section
 * @param {number} layerCount from composerSnapshot -- not a constant repeated here
 * @returns {{type: string, data: object}[]}
 */
export function planSectionEvents(section, layerCount) {
  const out = [];
  if (!section || !Array.isArray(section.mix)) return out;
  const byLayer = new Map(section.mix.map((m) => [m.layer, m]));
  for (let id = 0; id < layerCount; id++) {
    const m = byLayer.get(id);
    if (!m) continue;
    out.push({ type: EV.LAYER_ON, data: { layer: id, value: !!m.on } });
    out.push({ type: EV.LAYER_MUTE, data: { layer: id, value: !!m.muted } });
    out.push({ type: EV.LAYER_VOLUME, data: { layer: id, value: +clamp(m.volume, 0, 1).toFixed(3) } });
  }
  return out;
}

/** does the current mix already match this section? (drives the "playing" dot) */
export function sectionMatches(section, view) {
  if (!section || !Array.isArray(section.mix)) return false;
  const cur = new Map(view.layers.map((l) => [l.id, l]));
  return section.mix.every((m) => {
    const l = cur.get(m.layer);
    if (!l) return false;
    return !!l.on === !!m.on && !!l.muted === !!m.muted && Math.abs((l.volume ?? 1) - m.volume) < 0.02;
  });
}

/** how many tracks a section leaves audible -- shown on the chip */
export function sectionWeight(section) {
  if (!section || !Array.isArray(section.mix)) return 0;
  return section.mix.filter((m) => m.on && !m.muted && m.volume > 0.02).length;
}

// ---------------------------------------------------------------------------
// The strip itself. Plain data plus the small edits the UI needs, kept here so
// that reordering and renaming cannot be reimplemented differently in two
// places. Every method returns a NEW list; nothing is mutated in place, which
// is what makes a one-step UNDO a matter of keeping the previous array.
// ---------------------------------------------------------------------------
export function renameSection(sections, id, name) {
  return sections.map((s) => (s.id === id ? { ...s, name: String(name || 'SECTION').slice(0, 40) } : s));
}

export function duplicateSection(sections, id) {
  const i = sections.findIndex((s) => s.id === id);
  if (i < 0) return sections;
  const src = sections[i];
  const copy = { id: makeSectionId(src.name), name: nextCopyName(src.name, sections), mix: deepClone(src.mix) };
  return [...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)];
}

function nextCopyName(name, sections) {
  const base = String(name).replace(/\s\d+$/u, '');
  let n = 2;
  const taken = new Set(sections.map((s) => s.name));
  while (taken.has(base + ' ' + n) && n < 99) n++;
  return (base + ' ' + n).slice(0, 40);
}

export function moveSection(sections, id, delta) {
  const i = sections.findIndex((s) => s.id === id);
  if (i < 0) return sections;
  const j = clamp(i + delta, 0, sections.length - 1);
  if (i === j) return sections;
  const out = sections.slice();
  const [s] = out.splice(i, 1);
  out.splice(j, 0, s);
  return out;
}

export function removeSection(sections, id) {
  return sections.filter((s) => s.id !== id);
}

export function saveMixInto(sections, id, view) {
  return sections.map((s) => (s.id === id ? { ...s, mix: mixFromSnapshot(view) } : s));
}
