// Ícones SVG inline (traço 2px, 24×24, herdam a cor via currentColor).
(function () {
  const P = {
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22zM4 5.5V22"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h2"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    gift: '<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12M2 9h20M12 9H7.5a2.5 2.5 0 1 1 2.5-2.5V9Zm0 0h4.5A2.5 2.5 0 1 0 14 6.5V9Z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.5-3"/>',
    'plus-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>',
    'minus-circle': '<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    resume: '<path d="M5 4v16M9 4v16"/><path d="M13 4v16l8-8z"/>',
    pause: '<path d="M8 4v16M16 4v16"/>',
    close: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    flask: '<path d="M9 2h6M10 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-11V2"/><path d="M7 15h10"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    save: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h0"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
    open: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8M8 12l4-4 4 4"/>',
    tp: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    sl: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12l4 4 4-4"/>',
    hand: '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.6-1.5L8 15"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
  };
  window.icon = function (name, cls) {
    return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  };
  // <i data-icon="nome"></i> no HTML estático
  document.querySelectorAll('[data-icon]').forEach((el) => (el.outerHTML = window.icon(el.dataset.icon, el.className)));
})();
