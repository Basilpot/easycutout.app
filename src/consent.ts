// Analytics (Google Analytics + Microsoft Clarity) with region-aware consent.
// EEA, UK and Switzerland: nothing loads until the visitor accepts the banner.
// Everywhere else: analytics load straight away and no banner is shown.

const GA_ID = 'G-WH9GN6DTP0';
const CLARITY_ID = 'z6o63erp7h';
const KEY = 'ec-consent'; // 'granted' | 'denied'

// EU-27 + Iceland, Liechtenstein, Norway (EEA) + UK + Switzerland.
const CONSENT_REGIONS = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' '),
);

type Choice = 'granted' | 'denied';
type Fn = (...args: unknown[]) => void;
const w = window as unknown as { dataLayer: unknown[]; gtag: Fn; clarity: Fn & { q?: unknown[] } };

const store = {
  get: (): Choice | null => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'granted' || v === 'denied' ? v : null;
    } catch {
      return null;
    }
  },
  set: (v: Choice) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {}
  },
};

function addScript(src: string) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.append(s);
}

let loaded = false;
function loadAnalytics(needsConsent: boolean) {
  if (loaded) return;
  loaded = true;
  w.dataLayer = w.dataLayer || [];
  // gtag and Clarity expect the raw `arguments` object, not an array.
  w.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
  };
  w.clarity =
    w.clarity ||
    function () {
      // eslint-disable-next-line prefer-rest-params
      (w.clarity.q = w.clarity.q || []).push(arguments);
    };
  // We show no ads, so ad storage stays off everywhere.
  w.gtag('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  w.gtag('js', new Date());
  w.gtag('config', GA_ID);
  if (needsConsent) w.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
  addScript(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`);
  addScript(`https://www.clarity.ms/tag/${CLARITY_ID}`);
}

// Withdrawing consent after it was given: tell both tools, which then drop their cookies.
function revoke() {
  if (!loaded) return;
  w.gtag('consent', 'update', { analytics_storage: 'denied' });
  w.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
}

let banner: HTMLElement | null = null;
function showBanner() {
  if (banner) return void (banner.hidden = false);
  banner = document.createElement('div');
  banner.className = 'consent';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML = `
    <p>We’d like to use cookies from Google Analytics and Microsoft Clarity to see how EasyCutout is used and make it better. Your images are never shared. <a href="/privacy">Privacy policy</a></p>
    <div class="consent-actions">
      <button type="button" class="btn btn-ghost" data-choice="denied">Decline</button>
      <button type="button" class="btn btn-primary" data-choice="granted">Accept</button>
    </div>`;
  banner.addEventListener('click', (e) => {
    const choice = (e.target as HTMLElement).closest<HTMLElement>('[data-choice]')?.dataset.choice as Choice | undefined;
    if (!choice) return;
    store.set(choice);
    banner!.hidden = true;
    if (choice === 'granted') loadAnalytics(true);
    else revoke();
  });
  document.body.append(banner);
}

async function inConsentRegion(): Promise<boolean> {
  const forced = new URLSearchParams(location.search).get('consent-region'); // debug: ?consent-region=GB
  if (forced) return CONSENT_REGIONS.has(forced.toUpperCase());
  try {
    // Cloudflare answers this on every proxied hostname with the visitor's country (loc=XX).
    const res = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
    const loc = res.ok ? /^loc=([A-Z]{2})$/m.exec(await res.text())?.[1] : undefined;
    if (loc) return CONSENT_REGIONS.has(loc);
  } catch {}
  // Fallback: European time zone → treat as consent region (errs on the side of asking).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  return tz.startsWith('Europe/') || /^Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$/.test(tz);
}

async function init() {
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (isLocal && !location.search.includes('consent-region')) return; // keep dev/test visits out of the stats
  if (!(await inConsentRegion())) return loadAnalytics(false);

  const settings = document.querySelector<HTMLButtonElement>('[data-cookie-settings]');
  if (settings) {
    settings.hidden = false;
    settings.addEventListener('click', showBanner);
  }
  const saved = store.get();
  if (saved === 'granted') loadAnalytics(true);
  else if (!saved) showBanner();
}

void init();
