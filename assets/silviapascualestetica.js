/**
 * <scheduled-badge data-start="unix_seconds" data-end="unix_seconds">
 *
 * Etiqueta programada del grid de productos. Se muestra solo entre data-start y data-end
 * (cualquiera de los dos es opcional) y se actualiza sola al llegar la hora de inicio o fin,
 * sin necesidad de recargar la página.
 */
if (!window.customElements.get('scheduled-badge')) {
  class ScheduledBadge extends HTMLElement {
    connectedCallback() {
      this.start = this.dataset.start ? parseInt(this.dataset.start, 10) * 1000 : null;
      this.end = this.dataset.end ? parseInt(this.dataset.end, 10) * 1000 : null;
      this.update();
    }

    disconnectedCallback() {
      clearTimeout(this.timer);
    }

    update() {
      clearTimeout(this.timer);

      const now = Date.now();
      const started = this.start === null || now >= this.start;
      const ended = this.end !== null && now >= this.end;

      this.hidden = !started || ended;

      // Programar el siguiente cambio (inicio o fin). setTimeout admite como máximo ~24,8 días.
      const next = !started ? this.start : (!ended && this.end !== null ? this.end : null);

      if (next !== null) {
        this.timer = setTimeout(() => this.update(), Math.min(next - now + 50, 2147483647));
      }
    }
  }

  window.customElements.define('scheduled-badge', ScheduledBadge);
}

/**
 * Descuentos automáticos de Shopify en grid y ficha de producto.
 *
 * Liquid no puede leerlos, así que se crea un carrito temporal con la API de Storefront (independiente del
 * carrito del cliente) y se usa el descuento que Shopify calcula para cada variante con cantidad 1.
 * Los descuentos con código no se aplican, y si la consulta falla se mantiene el precio normal.
 */
(() => {
  const API_VERSION = '2026-10';
  const BATCH_SIZE = 50;
  const CACHE_KEY = 'auto-discounts-v1';
  const CACHE_TTL = 5 * 60 * 1000;
  const SELECTOR = '[data-auto-discount-variant]:not([data-auto-discount-done])';
  const QUERY = `mutation($input: CartInput!) {
    cartCreate(input: $input) {
      cart { lines(first: ${BATCH_SIZE}) { nodes {
        merchandise { ... on ProductVariant { id } }
        cost { subtotalAmount { amount } }
        discountAllocations { __typename discountedAmount { amount } }
      } } }
    }
  }`;

  const known = new Map(); // id de variante -> proporción del precio final (0.85 = 15 % de descuento)
  const pending = new Set();
  let timer;

  const readCache = () => {
    try {
      const cache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cache && cache.country === window.Shopify?.country && Date.now() - cache.time < CACHE_TTL) {
        Object.entries(cache.ratios).forEach(([id, ratio]) => known.set(id, ratio));
      }
    } catch (error) { /* sin caché */ }
  };

  const writeCache = () => {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        time: Date.now(),
        country: window.Shopify?.country,
        ratios: Object.fromEntries(known)
      }));
    } catch (error) { /* sin caché */ }
  };

  const formatMoney = (cents, format) => {
    const render = (decimals, thousands, decimal) => {
      const [integer, fraction] = (cents / 100).toFixed(decimals).split('.');
      const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return fraction ? `${grouped}${decimal}${fraction}` : grouped;
    };

    return format.replace(/\{\{\s*(\w+)\s*\}\}/, (match, type) => ({
      amount: render(2, ',', '.'),
      amount_no_decimals: render(0, ',', '.'),
      amount_with_comma_separator: render(2, '.', ','),
      amount_no_decimals_with_comma_separator: render(0, '.', ','),
      amount_with_apostrophe_separator: render(2, "'", '.'),
      amount_with_space_separator: render(2, ' ', ','),
      amount_no_decimals_with_space_separator: render(0, ' ', ',')
    })[type] ?? render(2, ',', '.'));
  };

  const setMoneyText = (element, html) => {
    const label = element.querySelector('.sr-only');
    element.innerHTML = '';
    if (label) element.append(label);
    element.insertAdjacentHTML('beforeend', html);
  };

  const applyPriceList = (list, ratio) => {
    const price = Number(list.dataset.price);
    const compareAt = Number(list.dataset.compareAt);
    const original = Math.max(price, compareAt);
    const final = Math.round(price * ratio);
    const format = list.dataset.moneyFormat;
    const salePrice = list.querySelector('sale-price');
    if (!salePrice) return;

    const money = formatMoney(final, format);
    setMoneyText(salePrice, list.dataset.fromTemplate ? list.dataset.fromTemplate.replace('__PRICE__', money) : money);
    salePrice.className = list.dataset.onSaleClass;

    let compare = list.querySelector('compare-at-price');
    if (!compare) {
      compare = document.createElement('compare-at-price');
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = list.dataset.regularLabel;
      compare.append(label);
      salePrice.after(compare);
    }
    compare.className = list.dataset.compareClass;
    setMoneyText(compare, formatMoney(original, format));
  };

  // En móvil la barra flotante muestra el precio dentro del botón, no en la lista de precios.
  const syncFloatingButton = (list, ratio) => {
    const content = list.closest('floating-atc-button')?.querySelector('.floating-atc-button__mobile button-content');
    if (!content) return;

    const price = Number(list.dataset.price);
    const original = Math.max(price, Number(list.dataset.compareAt));
    const final = Math.round(price * ratio);
    if (final >= original) return;

    const text = content.textContent.trim();
    const separator = text.lastIndexOf(' · ');
    const label = separator === -1 ? text : text.slice(0, separator);
    const format = list.dataset.moneyFormat;
    const finalMoney = formatMoney(final, format);

    content.textContent = `${label} · `;
    const compare = document.createElement('s');
    compare.className = 'floating-atc-button__compare';
    compare.textContent = formatMoney(original, format);
    content.append(compare, ` ${finalMoney}`);

    // El texto de la animación del botón no admite tachado: solo lleva el precio final.
    ['up-text', 'rotated-text'].forEach((attribute) => {
      if (content.hasAttribute(attribute)) content.setAttribute(attribute, `${label} · ${finalMoney}`);
    });
  };

  const applyBadge = (badge, ratio) => {
    const price = Number(badge.dataset.price);
    const original = Math.max(price, Number(badge.dataset.compareAt));
    const final = Math.round(price * ratio);
    const savings = badge.dataset.discountMode === 'percentage'
      ? `${Math.round((original - final) * 100 / original)}%`
      : formatMoney(original - final, badge.dataset.moneyFormat);

    badge.innerHTML = badge.dataset.badgeTemplate.replace('__SAVINGS__', savings);
    badge.hidden = false;
  };

  const render = () => {
    document.querySelectorAll(SELECTOR).forEach((element) => {
      const ratio = known.get(element.dataset.autoDiscountVariant);
      if (ratio === undefined) return;

      element.setAttribute('data-auto-discount-done', '');
      if (element.matches('price-list')) syncFloatingButton(element, ratio);
      if (ratio >= 1) return;

      if (element.matches('price-list')) applyPriceList(element, ratio);
      else applyBadge(element, ratio);
    });
  };

  const fetchBatch = async (ids) => {
    const input = { lines: ids.map((id) => ({ merchandiseId: `gid://shopify/ProductVariant/${id}`, quantity: 1 })) };
    if (window.Shopify?.country) input.buyerIdentity = { countryCode: window.Shopify.country };

    const response = await fetch(`https://${window.Shopify.shop}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { input } })
    });
    const { data } = await response.json();
    const lines = data?.cartCreate?.cart?.lines?.nodes;
    if (!lines) return;

    ids.forEach((id) => known.set(id, 1));
    lines.forEach((line) => {
      const id = line.merchandise?.id?.split('/').pop();
      const subtotal = Number(line.cost.subtotalAmount.amount);
      const discount = line.discountAllocations
        .filter((allocation) => allocation.__typename === 'CartAutomaticDiscountAllocation')
        .reduce((total, allocation) => total + Number(allocation.discountedAmount.amount), 0);
      if (id && subtotal > 0) known.set(id, Math.max(0, (subtotal - discount) / subtotal));
    });
  };

  const update = async () => {
    render();

    const missing = [...new Set([...document.querySelectorAll(SELECTOR)].map((el) => el.dataset.autoDiscountVariant))]
      .filter((id) => !known.has(id) && !pending.has(id));
    if (!missing.length || !window.Shopify?.shop) return;

    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE));
    missing.forEach((id) => pending.add(id));

    await Promise.all(batches.map((batch) => fetchBatch(batch).catch(() => {})));
    missing.forEach((id) => pending.delete(id));
    writeCache();
    render();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 50);
  };

  readCache();
  update();
  new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.addedNodes.length)) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
