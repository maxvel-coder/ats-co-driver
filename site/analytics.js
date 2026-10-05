// Visitor and click counting with GoatCounter: no cookies, no personal data, nothing stored in the
// browser (so no cookie banner). Counts page views and clicks on links marked data-track
// ("download", "coffee", "source"). Set the code in index.html; empty or placeholder = off.
// Support buttons without a real link yet (placeholder) are hidden, with the card around them.
document.addEventListener('DOMContentLoaded', () => {
  for (const a of document.querySelectorAll('a[href*="BUY_ME_A_COFFEE_URL"]')) (a.closest('.coffee-card') ?? a).hidden = true;
});
(() => {
  const code = window.CODRIVER_GOATCOUNTER;
  if (!code || /GOATCOUNTER/.test(code) || /^(localhost|127\.|192\.168\.)/.test(location.hostname)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  document.head.appendChild(s);
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-track]');
    if (!a || !window.goatcounter?.count) return;
    window.goatcounter.count({ path: 'click-' + a.dataset.track, title: a.textContent.trim().slice(0, 60), event: true });
  });
})();
