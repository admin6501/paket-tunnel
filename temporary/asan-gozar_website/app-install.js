const storeAppRegistration = 'serviceWorker' in navigator
  ? navigator.serviceWorker.register('/app-worker.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).catch(() => null)
  : Promise.resolve(null);

const storeAppInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const storeApplePhone = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

{
  const button = document.getElementById('app-install');
  const hint = document.getElementById('app-install-hint');
  let prompt;
  window.addEventListener('beforeinstallprompt', event => {
    if (!button) return;
    event.preventDefault();
    prompt = event;
  });
  if (button && !storeAppInstalled()) {
    button.hidden = false;
    button.addEventListener('click', async () => {
      if (prompt) {
        const install = prompt;
        prompt = null;
        await install.prompt();
        return;
      }
      hint.textContent = storeApplePhone
        ? 'در Safari دکمهٔ اشتراک‌گذاری را بزنید، Add to Home Screen را انتخاب کنید و برنامه را از صفحهٔ اصلی باز کنید.'
        : 'از منوی مرورگر، «نصب برنامه» یا «افزودن به صفحهٔ اصلی» را انتخاب کنید.';
    });
    window.addEventListener('appinstalled', () => { button.hidden = true; hint.textContent = ''; prompt = null; });
  }
}
