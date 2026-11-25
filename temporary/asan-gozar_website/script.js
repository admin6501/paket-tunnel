
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const themeButton = $('themeToggle');
  const menuButton = $('menuToggle');
  const nav = $('mainNav');

  const accountLink = $('siteAccount');
  const syncAccount = signedIn => {
    if (accountLink) accountLink.textContent = signedIn ? 'حساب من' : 'ورود به حساب';
  };
  if (body.classList.contains('shop-page')) {
    document.addEventListener('shop:session', event => syncAccount(event.detail.signedIn));
  } else if (accountLink) {
    window.addEventListener('pageshow', async () => {
      try {
        const response = await fetch('/shop/api/session', { cache: 'no-store' });
        syncAccount(response.ok && (await response.json()).signedIn === true);
      } catch { syncAccount(false); }
    });
  }

  // تم انتخابی بین بازدیدها حفظ می‌شود.
  try {
    if (localStorage.getItem('ag-theme') === 'light') body.classList.add('light');
  } catch (_) {}
  const syncTheme = () => {
    if (!themeButton) return;
    const light = body.classList.contains('light');
    themeButton.textContent = light ? 'تیره' : 'روشن';
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
  const closeMenu = () => {
    nav?.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  };
  menuButton?.addEventListener('click', () => {
    const open = nav?.classList.toggle('open') ?? false;
    menuButton.setAttribute('aria-expanded', String(open));
  });
  nav?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  document.addEventListener('click', e => {
    if (nav?.classList.contains('open') && !nav.contains(e.target) && !menuButton?.contains(e.target)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || $('noticeDialog')?.open || !nav?.classList.contains('open')) return;
    closeMenu();
    menuButton?.focus();
  });

  // جست‌وجوی پرسش‌های متداول
  const faqSearch = $('faqSearch'), faqCount = $('faqCount');
  if (faqSearch) {
    const normalize = value => value.toLocaleLowerCase('fa')
      .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
      .replace(/[\s\u200c\u200d]+/g, ' ').trim();
    const items = [...document.querySelectorAll('.faq-item')].map(
      item => ({ item, text: normalize(item.textContent) })
    );
    const filterFaq = () => {
      const q = normalize(faqSearch.value);
      let shown = 0;
      items.forEach(({ item, text }) => {
        const match = text.includes(q);
        item.hidden = !match;
        if (match) shown++;
      });
      if (faqCount) faqCount.textContent = `${new Intl.NumberFormat('fa-IR').format(shown)} پرسش پیدا شد`;
    };
    faqSearch.addEventListener('input', filterFaq);
    filterFaq();
  }

  // پنجره اطلاعیه: فقط معرفی کانال رسمی، بدون نمایش تخفیف یا خبر ساختگی
  const dialog = $('noticeDialog'), openNotice = $('noticeOpen'), closeNotice = $('noticeClose');
  const openDialog = () => {
    if (dialog && !dialog.open) dialog.showModal();
  };
  const closeDialog = () => dialog?.close();
  openNotice?.addEventListener('click', openDialog);
  closeNotice?.addEventListener('click', closeDialog);
  dialog?.addEventListener('click', e => { if (e.target === dialog) closeDialog(); });
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
    $('main')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
})();
