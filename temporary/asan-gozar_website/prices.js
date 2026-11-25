(() => {
  const byId = id => document.getElementById(id);
  const filters = byId('catalog-filters');
  const category = byId('plan-category');
  const duration = byId('plan-duration');
  const status = byId('catalog-status');
  const cards = byId('catalog-plans');
  const more = byId('catalog-more');
  const categories = new Map();
  const format = new Intl.NumberFormat('fa-IR');
  const emoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
  const pageSize = 9;
  let visible = pageSize;

  function planCard(plan) {
    const card = document.createElement('li');
    const volume = document.createElement('strong');
    volume.textContent = format.format(plan.gb) + ' گیگابایت';
    const term = document.createElement('span');
    term.textContent = format.format(plan.days) + ' روز اعتبار';
    const amount = document.createElement('b');
    amount.textContent = format.format(plan.price) + ' تومان';
    card.append(volume, term, amount);
    return card;
  }

  function render() {
    const current = categories.get(category.value)?.plans || [];
    const filtered = duration.value ? current.filter(plan => String(plan.days) === duration.value) : current;
    cards.replaceChildren(...filtered.slice(0, visible).map(planCard));
    status.textContent = filtered.length ? '' : 'بسته‌ای برای این انتخاب پیدا نشد.';
    more.hidden = filtered.length <= visible;
  }

  function updateCategory() {
    const current = categories.get(category.value)?.plans || [];
    const days = [...new Set(current.map(plan => plan.days))].sort((a, b) => a - b);
    duration.replaceChildren(new Option('همه مدت‌ها', ''), ...days.map(day => new Option(format.format(day) + ' روز', day)));
    visible = pageSize;
    render();
  }

  category.addEventListener('change', updateCategory);
  duration.addEventListener('change', () => {
    visible = pageSize;
    render();
  });
  more.addEventListener('click', () => {
    visible += pageSize;
    render();
  });

  async function load() {
    try {
      const response = await fetch('/shop/api/catalog', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Catalog unavailable');
      const { plans } = await response.json();
      const previous = category.value;
      categories.clear();
      for (const plan of plans) {
        const id = String(plan.categoryId);
        if (!categories.has(id)) {
          categories.set(id, { label: plan.category.replace(emoji, '').trim() || 'بسته‌ها', plans: [] });
        }
        categories.get(id).plans.push(plan);
      }
      category.replaceChildren(...Array.from(categories, ([id, group]) => new Option(group.label, id)));
      if (categories.has(previous)) category.value = previous;
      filters.hidden = !categories.size;
      updateCategory();
      if (!categories.size) status.textContent = 'در حال حاضر بسته‌ای برای خرید فعال نیست.';
    } catch {
      filters.hidden = true;
      cards.replaceChildren();
      more.hidden = true;
      status.textContent = 'در دریافت تعرفه‌ها مشکلی پیش آمد. صفحه را دوباره بارگذاری کنید.';
    }
  }

  window.addEventListener('pageshow', load);
})();
