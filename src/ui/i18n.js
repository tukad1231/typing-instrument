// UI language is a local preference. It is deliberately not part of a
// project or the session log: changing the words on screen must never change
// the music or replay output.

const STORAGE_KEY = 'typing-instrument.ui-language';

function initialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch (e) {
    /* private browsing can deny storage */
  }
  return String(navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let locale = initialLocale();

export function getLocale() {
  return locale;
}

export function isJapanese() {
  return locale === 'ja';
}

export function tr(en, ja) {
  return locale === 'ja' ? ja : en;
}

export function setLocale(next) {
  locale = next === 'ja' ? 'ja' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch (e) {
    /* the choice lasts for this tab even when it cannot be persisted */
  }
  document.documentElement.lang = locale;
  return locale;
}

export function localField(item, field) {
  if (!item) return '';
  const translated = item[field + 'Ja'];
  return locale === 'ja' && translated ? translated : item[field];
}

export function localizeDocument(root = document) {
  document.documentElement.lang = locale;
  for (const node of root.querySelectorAll('[data-en][data-ja]')) {
    node.textContent = locale === 'ja' ? node.dataset.ja : node.dataset.en;
  }
  for (const node of root.querySelectorAll('[data-placeholder-en][data-placeholder-ja]')) {
    node.placeholder = locale === 'ja' ? node.dataset.placeholderJa : node.dataset.placeholderEn;
  }
  for (const node of root.querySelectorAll('[data-title-en][data-title-ja]')) {
    node.title = locale === 'ja' ? node.dataset.titleJa : node.dataset.titleEn;
  }
  for (const node of root.querySelectorAll('[data-aria-en][data-aria-ja]')) {
    node.setAttribute('aria-label', locale === 'ja' ? node.dataset.ariaJa : node.dataset.ariaEn);
  }
}
