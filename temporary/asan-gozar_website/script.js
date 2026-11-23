
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const themeButton = $('themeToggle');
  const menuButton = $('menuToggle');
  const nav = $('mainNav');

  // تم انتخابی بین بازدیدها حفظ می‌شود.
  try {
    if (localStorage.getItem('ag-theme') === 'light') body.classList.add('light');
  } catch (_) {}
  const syncTheme = () => {
    if (!themeButton) return;
    const light = body.classList.contains('light');
    themeButton.textContent = light ? '☾' : '☼';
    themeButton.setAttribute('aria-pressed', String(light));
    themeButton.setAttribute('aria-label', light ? 'فعال‌کردن پوسته تیره' : 'فعال‌کردن پوسته روشن');
  };
  syncTheme();
  themeButton?.addEventListener('click', () => {
    body.classList.toggle('light');
    try { localStorage.setItem('ag-theme', body.classList.contains('light') ? 'light' : 'dark'); } catch (_) {}
    syncTheme();
  });

  // منوی موبایل با وضعیت قابل‌خواندن برای صفحه‌خوان
  menuButton?.addEventListener('click', () => {
    const open = nav?.classList.toggle('open') ?? false;
    menuButton.setAttribute('aria-expanded', String(open));
  });
  nav?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    nav.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  }));
  document.addEventListener('click', e => {
    if (nav?.classList.contains('open') && !nav.contains(e.target) && !menuButton?.contains(e.target)) {
      nav.classList.remove('open');
      menuButton?.setAttribute('aria-expanded', 'false');
    }
  });

  // محاسبه‌گر تعرفه‌های عادی
  const service = $('calcService'), volume = $('calcVolume'), total = $('calcTotal');
  const format = n => new Intl.NumberFormat('fa-IR').format(n) + ' تومان';
  const calculate = () => {
    if (!service || !volume || !total) return;
    const amount = Number(volume.value);
    if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
      total.textContent = 'حجم را بین ۱ تا ۱۰۰٬۰۰۰ وارد کن';
      return;
    }
    total.textContent = format(amount * Number(service.value));
  };
  service?.addEventListener('change', calculate);
  volume?.addEventListener('input', calculate);
  calculate();

  // جست‌وجوی پرسش‌های متداول
  const faqSearch = $('faqSearch'), faqCount = $('faqCount');
  if (faqSearch) {
    const items = [...document.querySelectorAll('.faq-item')];
    const filterFaq = () => {
      const q = faqSearch.value.trim().toLocaleLowerCase('fa');
      let shown = 0;
      items.forEach(item => {
        const match = item.textContent.toLocaleLowerCase('fa').includes(q);
        item.hidden = !match;
        if (match) shown++;
      });
      if (faqCount) faqCount.textContent = `${new Intl.NumberFormat('fa-IR').format(shown)} پرسش پیدا شد`;
    };
    faqSearch.addEventListener('input', filterFaq);
  }

  // پنجره اطلاعیه: فقط معرفی کانال رسمی، بدون نمایش تخفیف یا خبر ساختگی
  const dialog = $('noticeDialog'), openNotice = $('noticeOpen'), closeNotice = $('noticeClose');
  let previousFocus = null;
  const openDialog = () => {
    if (!dialog) return;
    previousFocus = document.activeElement;
    dialog.hidden = false;
    closeNotice?.focus();
  };
  const closeDialog = () => {
    if (!dialog) return;
    dialog.hidden = true;
    previousFocus?.focus?.();
  };
  openNotice?.addEventListener('click', openDialog);
  closeNotice?.addEventListener('click', closeDialog);
  dialog?.addEventListener('click', e => { if (e.target === dialog) closeDialog(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialog && !dialog.hidden) closeDialog(); });
  try {
    const last = Number(localStorage.getItem('ag-notice-time') || 0);
    if (dialog && Date.now() - last > 7 * 24 * 60 * 60 * 1000) {
      window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          openDialog();
          localStorage.setItem('ag-notice-time', String(Date.now()));
        }
      }, 9000);
    }
  } catch (_) {}

  // بازگشت به بالای صفحه
  const topButton = $('backToTop');
  const getScrollPosition = () => Math.max(
    window.scrollY || 0,
    document.documentElement?.scrollTop || 0,
    document.body?.scrollTop || 0
  );
  const updateTop = () => {
    if (!topButton) return;
    topButton.classList.toggle('visible', getScrollPosition() > 250);
  };
  window.addEventListener('scroll', updateTop, { passive: true });
  document.addEventListener('scroll', updateTop, { passive: true, capture: true });
  window.addEventListener('resize', updateTop, { passive: true });
  window.addEventListener('load', updateTop, { once: true });
  updateTop();
  topButton?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
})();
