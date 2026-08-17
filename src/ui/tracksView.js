// ---------------------------------------------------------------------------
// TRACKS VIEW  --  four cards that describe the real layers.
//
// Everything here is a pure function of a composerSnapshot plus a bag of
// callbacks. It never reaches into LoopEngine and never dispatches anything
// itself, so the picture on screen and the events in the log cannot drift.
//
// -- THE VOLUME DRAG, AND WHY IT HAS ITS OWN CLASS -------------------------
// Dragging a volume slider dispatches a session event on every step, and every
// session event re-renders the tracks. Rebuilding the cards mid-drag tears the
// slider out from under the pointer and the gesture dies -- so rendering is
// suppressed for the duration of the drag.
//
// Which makes ENDING the drag safety-critical: miss the end and the tracks stay
// frozen, and the next ON / MUTE / DELETE appears to do nothing. There are more
// ways to end a drag than there are to start one:
//
//     pointerup                 the ordinary case
//     lostpointercapture        the pointer was taken away from us
//     pointercancel             the browser gave up on the gesture
//     window pointerup          released outside the window
//     window blur               released after Alt+Tab, with no event at all
//     visibilitychange          the tab went away mid-drag
//     keyup / blur on the range keyboard adjustment finished
//
// setPointerCapture is what makes most of these arrive at all: without it, a
// pointer that leaves the slider stops sending us anything. The window-level
// listeners are the backstop for the cases even capture cannot see.
// ---------------------------------------------------------------------------

import { el, clearNode } from './dom.js';
import { clamp } from '../core/hash.js';

export class VolumeDrag {
  /** @param {() => void} onEnd called exactly once per gesture, after it ends */
  constructor(onEnd, opts = {}) {
    this.layer = null;
    this.onEnd = onEnd;
    this.isDocumentHidden = opts.isDocumentHidden || (() => document.hidden);
    this._end = () => this.end();
    this._visibilityEnd = () => {
      if (this.isDocumentHidden()) this.end();
    };
    // Bound once, for the whole life of the app. These fire constantly and do
    // nothing at all unless a drag is actually open.
    window.addEventListener('pointerup', this._end);
    window.addEventListener('pointercancel', this._end);
    window.addEventListener('blur', this._end);
    document.addEventListener('visibilitychange', this._visibilityEnd);
  }

  get active() {
    return this.layer !== null;
  }

  begin(layerId, pointerId, target) {
    this.layer = layerId;
    if (pointerId !== undefined && target && target.setPointerCapture) {
      try {
        target.setPointerCapture(pointerId);
      } catch (e) {
        /* capture is an optimisation here, not a requirement */
      }
    }
  }

  end() {
    if (this.layer === null) return;
    this.layer = null;
    this.onEnd();
  }

  dispose() {
    window.removeEventListener('pointerup', this._end);
    window.removeEventListener('pointercancel', this._end);
    window.removeEventListener('blur', this._end);
    document.removeEventListener('visibilitychange', this._visibilityEnd);
    this.layer = null;
  }
}

/**
 * A read of the notes in a loop.
 *
 *   x     = where the note starts, in BEATS. Tempo-independent: changing the
 *           tempo does not move a note within its loop.
 *   width = how long the note lasts. Note lengths are stored in SECONDS (they
 *           come from how long a finger stayed down), so the width has to be
 *           converted through a tempo. It uses `playingBpm` -- the tempo
 *           actually sounding, not the one selected on the slider -- so the
 *           picture matches what you hear. Speed the tempo up and the blocks
 *           get narrower, because a note now covers less of the bar.
 *
 * Pure: a composerSnapshot layer plus its context, no globals.
 */
export function buildTimeline(layer, { live = true, playingBpm = 120, beatsPerBar = 4 } = {}) {
  const node = el('div', { className: 'track-timeline' });
  const lenBeats = layer.lengthBeats || beatsPerBar;

  for (let b = beatsPerBar; b < lenBeats; b += beatsPerBar) {
    node.appendChild(el('i', { className: 'bar-line', style: { left: (b / lenBeats) * 100 + '%' } }));
  }

  for (const ev of layer.events) {
    const durBeats = Math.max((ev.duration || 0.12) * (playingBpm / 60), 0.05);
    const blk = el('i', {
      className: 'blk ' + (ev.instrument || 'drum'),
      style: {
        left: clamp((ev.b / lenBeats) * 100, 0, 100) + '%',
        width: clamp((durBeats / lenBeats) * 100, 0.4, 100) + '%',
        opacity: live ? '' : '0.3',
      },
      title: `${ev.instrument}${ev.part ? ' / ' + ev.part : ''} · beat ${ev.b.toFixed(2)} · ${(ev.duration || 0).toFixed(2)}s`,
    });
    node.appendChild(blk);
  }
  return node;
}

/**
 * Render the four cards.
 *
 * @param {HTMLElement} host
 * @param {object} view composerSnapshot()
 * @param {object} h callbacks: onToggle, onMute, onDelete, onVolume,
 *   onVolumeStart, onCreate, onPreset
 * @param {object} opts { composing, drag, presets }
 */
export function renderTracks(host, view, h, opts = {}) {
  const drag = opts.drag;
  const target = view.nextFreeLayer;

  // Mid-drag: touch nothing but the number. See the header.
  if (drag && drag.active) {
    const cell = host.querySelector(`.track[data-track="${drag.layer}"] .vol`);
    const l = view.layers[drag.layer];
    if (cell && l) cell.textContent = Math.round(l.volume * 100) + '%';
    const meter = host.querySelector(`.track[data-track="${drag.layer}"] .track-card`);
    if (meter && l) meter.classList.toggle('silent', !l.on || l.muted || l.volume <= 0.01);
    return;
  }

  clearNode(host);

  for (const l of view.layers) {
    const filled = l.eventCount > 0;
    const live = l.on && !l.muted && l.volume > 0.01;
    const card = el('div', {
      className:
        'track' +
        (filled ? '' : ' empty') +
        (filled && !live ? ' silent' : '') +
        (opts.composing && l.id === target ? ' active' : ''),
      dataset: { track: String(l.id) },
    });

    // --- head -------------------------------------------------------------
    const head = el('div', { className: 'track-head' }, [
      el('span', { className: 'track-num', text: 'TRACK ' + (l.id + 1) }),
      el('span', {
        className: 'track-name',
        // textContent, never innerHTML: a loop is named after the words that
        // were typed into it, and those are arbitrary user text.
        text: filled ? l.name : 'Empty',
        title: filled ? l.name : '',
      }),
      el('span', {
        className: 'track-kind',
        text: filled
          ? `${l.kind === 'builtin' ? 'preset' : 'typing'} · ${l.bars} bar${l.bars > 1 ? 's' : ''} · ${l.eventCount} notes`
          : '',
      }),
    ]);
    card.appendChild(head);

    if (filled) {
      const btns = el('span', { className: 'track-btns' }, [
        el('button', {
          className: 'chip ' + (l.on ? 'on' : 'off'),
          text: l.on ? 'ON' : 'OFF',
          'aria-pressed': l.on ? 'true' : 'false',
          title: l.on ? 'Playing — click to stop this track' : 'Stopped — click to play it',
          onclick: () => h.onToggle(l.id, !l.on),
        }),
        el('button', {
          className: 'chip' + (l.muted ? ' muted' : ''),
          text: l.muted ? 'MUTED' : 'MUTE',
          'aria-pressed': l.muted ? 'true' : 'false',
          onclick: () => h.onMute(l.id, !l.muted),
        }),
        el('button', {
          className: 'chip danger',
          text: 'DELETE',
          title: 'Delete this track (you can undo it)',
          onclick: () => h.onDelete(l.id),
        }),
      ]);
      head.appendChild(btns);

      card.appendChild(buildTimeline(l, { live, playingBpm: view.playingBpm, beatsPerBar: view.beatsPerBar }));

      const range = el('input', {
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: String(Math.round(l.volume * 100)),
        'aria-label': 'Track ' + (l.id + 1) + ' volume',
      });
      const volLabel = el('span', { className: 'vol', text: Math.round(l.volume * 100) + '%' });

      range.addEventListener('pointerdown', (e) => {
        if (drag) drag.begin(l.id, e.pointerId, range);
      });
      range.addEventListener('lostpointercapture', () => drag && drag.end());
      range.addEventListener('pointerup', () => drag && drag.end());
      range.addEventListener('pointercancel', () => drag && drag.end());
      // Keyboard adjustment is a drag too: arrow keys fire `input` just like a
      // pointer does, and rebuilding the card mid-press would move focus.
      range.addEventListener('keydown', () => drag && drag.begin(l.id));
      range.addEventListener('keyup', () => drag && drag.end());
      range.addEventListener('blur', () => drag && drag.end());
      range.addEventListener('input', (e) => h.onVolume(l.id, +(e.target.value / 100).toFixed(3)));

      card.appendChild(el('div', { className: 'track-foot' }, [
        el('span', { className: 'k', text: 'VOLUME' }),
        range,
        volLabel,
      ]));
    } else if (l.id === target) {
      card.appendChild(el('div', { className: 'track-empty-msg', text: 'The next loop lands here' }));
      const presetRow = el('div', { className: 'preset-row', hidden: true });
      for (const [keyName, label] of opts.presets || []) {
        presetRow.appendChild(el('button', { className: 'chip add', text: label, dataset: { loop: keyName }, onclick: () => h.onPreset(keyName) }));
      }
      const presetBtn = el('button', {
        className: 'ghost presetToggle',
        text: 'Add a preset',
        'aria-expanded': 'false',
        onclick: () => {
          presetRow.hidden = !presetRow.hidden;
          presetBtn.setAttribute('aria-expanded', presetRow.hidden ? 'false' : 'true');
        },
      });
      card.appendChild(el('div', { className: 'track-actions' }, [
        el('button', { className: 'primary typeLoop', text: '+ Type a loop', onclick: () => h.onCreate() }),
        presetBtn,
      ]));
      card.appendChild(presetRow);
    } else {
      // Loops always land in the first free track, so offering a create button
      // here would be a promise the engine does not keep.
      card.appendChild(el('div', { className: 'track-empty-msg', text: 'Tracks are filled from top to bottom' }));
      card.classList.add('waiting');
    }

    host.appendChild(card);
  }
}
