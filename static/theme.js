/* Load before styles so a saved theme is applied before the first paint. */
(() => {
  'use strict';
  const KEY = 'dlpromo_theme';
  const root = document.documentElement;
  const normalize = value => value === 'constructivist' ? value : 'pixel';
  let initial = 'pixel';
  try { initial = normalize(localStorage.getItem(KEY)); } catch (_) { /* Storage may be unavailable. */ }

  function apply(value) {
    const theme = normalize(value);
    root.dataset.theme = theme;
    const mode = document.body?.dataset.mode;
    document.querySelector('meta[name="theme-color"]').content = theme === 'pixel' ? '#f6f7f2'
      : mode === 'short' ? '#1e50aa' : mode === 'long' ? '#1e8a3c' : '#ffd100';
    document.querySelectorAll('[data-theme-select]').forEach(select => { select.value = theme; });
    document.querySelectorAll('[data-pixel-copy]').forEach(element => {
      element.textContent = theme === 'pixel' ? element.dataset.pixelCopy : element.dataset.originalCopy;
    });
  }
  apply(initial);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-pixel-copy]').forEach(element => {
      element.dataset.originalCopy = element.textContent;
    });
    apply(root.dataset.theme);
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.addEventListener('change', () => {
        apply(select.value);
        try { localStorage.setItem(KEY, root.dataset.theme); } catch (_) { /* Keep this session usable. */ }
      });
    });
  });
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) apply(event.newValue);
  });
})();
