// ---------------------------------------------------------------------------
// DOM helpers.
//
// One rule, and it is the reason this file exists: USER TEXT NEVER TOUCHES
// innerHTML. Project titles, section names, loop names and the typed phrase are
// all strings a person chose, and one of them containing `<img onerror=...>`
// must be a piece of text on screen, not a script. `el()` sets `text` through
// `textContent`, which cannot execute anything, and `escapeHtml` exists only
// for the handful of places that genuinely have to build markup.
// ---------------------------------------------------------------------------

/**
 * @param {string} tag
 * @param {object} [attrs] className / text / title / dataset / style / on*
 * @param {(Node|string|null)[]} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'className') node.className = v;
    else if (k === 'html') node.innerHTML = v; // callers must pass built markup
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** replace a node's children in one go, without a string round-trip */
export function setChildren(node, children) {
  clearNode(node);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const $ = (id) => document.getElementById(id);
