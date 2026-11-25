(() => {
  const target = document.getElementById('featured-plans');
  const status = document.getElementById('featured-status');
  const number = new Intl.NumberFormat('fa-IR');
  const emoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;

  window.addEventListener('pageshow', async () => {
    try {
      const response = await fetch('/shop/api/featured', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Prices unavailable');
      const { plans } = await response.json();
      const cards = plans.map(plan => {
        const card = document.createElement('a');
        card.className = 'featured-card';
        card.href = '/prices.html?category=' + encodeURIComponent(plan.categoryId);
        const title = document.createElement('h3');
        title.textContent = plan.category.replace(emoji, '').trim() || 'اشتراک';
        const price = document.createElement('strong');
        price.textContent = 'از ' + number.format(plan.price) + ' تومان';
        const detail = document.createElement('span');
        detail.textContent = number.format(plan.gb) + ' گیگابایت، ' + number.format(plan.days) + ' روز';
        card.append(title, price, detail);
        return card;
      });
      target.replaceChildren(...cards);
      target.hidden = !cards.length;
      status.textContent = cards.length ? '' : 'در حال حاضر بستهٔ فعالی برای خرید موجود نیست.';
    } catch {
      target.replaceChildren();
      target.hidden = true;
      status.textContent = 'قیمت‌ها را از صفحهٔ تعرفه‌ها بررسی کنید.';
    }
  });
})();
