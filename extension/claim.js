// Adapted from spin311/epic-free-games-claim (GPL-3.0); modified 2026-11-05.
// Runs in Chrome's isolated extension world. No credentials or challenge answers are read.
globalThis.FGK_EPIC_STEP = function (clicked, priceProof = {}) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const roots = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument && visible(frame)) roots.push(frame.contentDocument); } catch {}
  }
  if (/\/id\/login/.test(location.pathname)) return { result: 'login_required' };
  for (const root of roots) {
    const text = root.body?.innerText || '';
    if (/verify you are human|complete a security check|one more step|checking your browser/i.test(text)) return { result: 'captcha' };
    for (const frame of root.querySelectorAll('iframe[src*="hcaptcha.com"],iframe[src*="challenges.cloudflare.com"]')) if (visible(frame)) return { result: 'captcha' };
    if (/thanks for your order|it['’]s all yours|has been added to your library/i.test(text)) return { result: 'claimed' };
    const buy = [...root.querySelectorAll('[data-testid="purchase-cta-button"],button[class*="_sidebarBuyButton_"]')].find(visible);
    if (buy && /^in library$/i.test(buy.innerText.trim())) return { result: 'claimed' };
    const age = root.querySelector('#btn_age_continue');
    if (age && visible(age) && !age.disabled && !clicked.includes('age')) { age.click(); return { clicked: 'age' }; }
    if (buy && /^get$/i.test(buy.innerText.trim()) && !clicked.includes('get')) { buy.click(); return { clicked: 'get' }; }
    for (const dialog of root.querySelectorAll('[role="dialog"]')) if (/not\s+(supported|compatible)/i.test(dialog.innerText)) {
      const next = [...dialog.querySelectorAll('button')].find(b => visible(b) && /^continue$/i.test(b.innerText.trim()) && !b.disabled);
      if (next && !clicked.includes('device')) { next.click(); return { clicked: 'device' }; }
    }
    for (const label of ['Place Order', 'Add to library', 'I accept']) {
      if (clicked.includes(label)) continue;
      const button = [...root.querySelectorAll('button')].find(b => visible(b) && !b.disabled && b.innerText.trim().toLowerCase() === label.toLowerCase());
      if (!button) continue;
      if (label === 'I accept' && !clicked.some(c => c === 'Place Order' || c === 'Add to library')) continue;
      if (label !== 'I accept') {
        const dialog = button.closest('[role="dialog"],dialog');
        const priceText = (dialog || root.body)?.innerText || '';
        const currency = '(?:(?:USD|CNY|RMB|HKD|EUR|GBP|AUD|CAD|JPY|KRW)\\s*|(?:US|CN|HK|AU|CA)?[$€£¥￥]\\s*)?';
        const totalPattern = new RegExp('(?:^|\\n)\\s*(?:total|总计|合计)\\s*[:：]?\\s*' + currency + '(free|免费|[0-9][\\d.,]*)(?=\\s|$)', 'gim');
        const totals = [...priceText.matchAll(totalPattern)];
        const hasTotalLabel = /(?:^|\n)\s*(?:total\b|总计|合计)/i.test(priceText);
        const isZero = value => /^(?:free|免费|0+(?:[.,]0+)?)$/i.test(value);
        const explicitZero = totals.length > 0 && totals.every(m => isZero(m[1]));
        const freshProof = priceProof.zeroPriceVerified === true && Number.isFinite(priceProof.priceVerifiedAt) &&
          Date.now() >= priceProof.priceVerifiedAt && Date.now() - priceProof.priceVerifiedAt <= 120000;
        const moneyValues = [...priceText.matchAll(/(?:[$€£¥￥]|\b(?:USD|CNY|RMB|HKD|EUR|GBP))\s*([0-9][\d.,]*)/gi)];
        const noNonzeroMoney = moneyValues.every(m => isZero(m[1]));
        // New Epic free-acquisition dialog has "Add to library" and no amount field.
        // Only accept it after this task's Get click AND a just-in-time backend zero-price check.
        const freeLibraryDialog = label === 'Add to library' && clicked.includes('get') && freshProof &&
          (dialog || root !== document) && !hasTotalLabel && noNonzeroMoney;
        if (!explicitZero && !freeLibraryDialog) return { result: 'price_unconfirmed' };
      }
      button.click(); return { clicked: label };
    }
  }
  return {};
};
