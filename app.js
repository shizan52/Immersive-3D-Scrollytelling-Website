/**
 * Entry point — theme, page interactions, and the gate that decides whether the 3D hero
 * runs at all.
 *
 * Deliberately tiny and free of three.js: this bundle is what blocks interactivity, so
 * the WebGL half lives behind a dynamic import in hero.js and is only fetched once the
 * hero is near the viewport — and never at all on a device or connection that declined.
 */
import { initHero } from './hero.js';

// ═══════════════════════════════════════════════════════════════════ theme
//
// Order of authority: an explicit choice the visitor made before > their OS setting >
// night (the scene is authored for night, and it is what the hero art expects).
// A blocking inline script in <head> applies the stored value before first paint so the
// page never flashes the wrong theme.

const THEME_KEY = 'bdec-theme';
const THEMES = new Set(['night', 'day']);

function initTheme(onChange) {
  const root = document.documentElement;

  const stored = (() => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  })();

  let current = THEMES.has(stored) ? stored
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night');

  function apply(name, { persist = true } = {}) {
    if (!THEMES.has(name)) return;
    current = name;
    root.dataset.theme = name;
    if (persist) { try { localStorage.setItem(THEME_KEY, name); } catch { /* private mode */ } }
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      btn.setAttribute('aria-pressed', String(name === 'day'));
      btn.setAttribute('aria-label', name === 'night' ? 'Switch to day theme' : 'Switch to night theme');
      const icon = btn.querySelector('[data-theme-icon]');
      if (icon) icon.textContent = name === 'night' ? '🌙' : '☀️';
    }
    onChange?.(name);
  }

  apply(current, { persist: false });

  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.addEventListener('click', () => apply(current === 'night' ? 'day' : 'night'));
  }

  // Follow the OS only while the visitor has not expressed a preference of their own.
  if (!THEMES.has(stored)) {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      apply(e.matches ? 'day' : 'night', { persist: false });
    });
  }

  return { get current() { return current; }, apply };
}

// ══════════════════════════════════════════════════════════════════════ UI
//
// Everything below the hero. All of it is progressive — the markup is complete and
// readable before this runs, and stays readable if it never does.

/** Fade sections in as they arrive. Falls back to "already visible" without JS or IO. */
function revealOnScroll() {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length) return;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('is-revealed'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-revealed');
      io.unobserve(e.target); // one-shot: re-animating on every pass is noise
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  targets.forEach(el => io.observe(el));
}

/**
 * Work-visa tab group.
 *
 * Real ARIA tabs with arrow-key support: the three visa routes are the page's densest and
 * most consequential content, and someone deciding between them should not be forced
 * through a mouse.
 */
function initVisaTabs() {
  const group = document.querySelector('[data-tabs]');
  if (!group) return;
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));

  function select(index, { focus = false } = {}) {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (panels[i]) panels[i].hidden = !on;
    });
    if (focus) tabs[index].focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (delta) {
        e.preventDefault();
        select((i + delta + tabs.length) % tabs.length, { focus: true });
      } else if (e.key === 'Home') {
        e.preventDefault(); select(0, { focus: true });
      } else if (e.key === 'End') {
        e.preventDefault(); select(tabs.length - 1, { focus: true });
      }
    });
  });

  select(0);
}

function initMobileNav() {
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.dataset.open = String(open);
    document.body.classList.toggle('nav-open', open);
  };

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
}

/**
 * Arrows for the review carousel.
 *
 * Purely an enhancement: swiping and the scrollbar already work without any of this, and
 * the buttons stay hidden unless there is actually something to scroll to — so a track
 * with three reviews on a wide screen shows no arrows at all.
 */
function initReviews() {
  initCarousel('[data-reviews]', 'reviews', '.review', 16);
  initCarousel('[data-posts]', 'posts', '.post', 18);
  pauseOtherVideos();
}

/**
 * Only one clip plays at a time.
 *
 * Two videos talking over each other in the same row is the kind of thing nobody tests
 * for and everybody notices. Starting one stops the rest.
 */
function pauseOtherVideos() {
  document.addEventListener('play', (e) => {
    if (e.target.tagName !== 'VIDEO') return;
    for (const v of document.querySelectorAll('video')) if (v !== e.target) v.pause();
  }, true);
}

/** The arrows and keyboard support for a scroll-snap row. Both rows behave identically. */
function initCarousel(selector, prefix, cardSelector, gap) {
  for (const box of document.querySelectorAll(selector)) {
    const track = box.querySelector(`.${prefix}__track`);
    const prev = box.querySelector(`.${prefix}__nav--prev`);
    const next = box.querySelector(`.${prefix}__nav--next`);
    if (!track || !prev || !next) continue;

    const step = () => track.querySelector(cardSelector)?.getBoundingClientRect().width + gap || 320;
    const sync = () => {
      const max = track.scrollWidth - track.clientWidth;
      const scrollable = max > 8;
      prev.hidden = !scrollable || track.scrollLeft <= 4;
      next.hidden = !scrollable || track.scrollLeft >= max - 4;
    };

    prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
    track.addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync, { passive: true });

    // The track is focusable, so give it the arrow keys too.
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); next.click(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev.click(); }
    });

    sync();
    // Card widths depend on fonts, so re-check once they have settled.
    document.fonts?.ready.then(sync).catch(() => {});
  }
}

/**
 * Land anchor links on the section they name.
 *
 * Sections below the fold use `content-visibility: auto`, so until one has been rendered
 * the browser only has `contain-intrinsic-size` as a guess at its height. Jumping to
 * #faq computes a target from those guesses, the sections in between then lay out for
 * real, and the anchor slides out from under the scroll — measured 2,340 px off on a
 * cold load. It corrects itself on a second click, which is exactly the kind of bug that
 * looks like nothing until a visitor follows a link from search results.
 *
 * The fix is to re-aim after layout has settled: scroll, then keep nudging over the next
 * few frames until the element is where it said it would be. Cheap, and it stops as soon
 * as the position stops moving.
 */
function initAnchors() {
  /** Run fn once scrolling has come to rest. `scrollend` where it exists, quiet-time else. */
  const afterScrollStops = (fn) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      removeEventListener('scrollend', done);
      removeEventListener('scroll', quiet);
      fn();
    };
    const quiet = () => { clearTimeout(timer); timer = setTimeout(done, 100); };
    addEventListener('scrollend', done, { once: true });
    addEventListener('scroll', quiet, { passive: true });
    quiet();
  };

  let cancel = null;
  const settle = (el) => {
    let tries = 0, stop = false;
    cancel?.();
    // Never fight the visitor: the moment they scroll or type, we are done.
    const off = () => { stop = true; removeEventListener('wheel', off); removeEventListener('touchstart', off); removeEventListener('keydown', off); };
    addEventListener('wheel', off, { once: true, passive: true });
    addEventListener('touchstart', off, { once: true, passive: true });
    addEventListener('keydown', off, { once: true });
    cancel = off;

    const step = () => {
      if (stop) return;
      const before = window.scrollY;
      // Asking again is the measurement: scrollIntoView honours scroll-margin-top, so
      // once it no longer has to move the page, everything below has finished laying out.
      el.scrollIntoView({ block: 'start', behavior: 'instant' });
      if (Math.abs(window.scrollY - before) > 1 && tries++ < 16) requestAnimationFrame(step);
      else off();
    };
    requestAnimationFrame(step);
  };

  document.addEventListener('click', (e) => {
    // Something closer to the target already handled it — the chat launcher, for one,
    // which is an <a href="#contact"> that opens a panel instead of scrolling.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || a.getAttribute('href') === '#') return;
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (!el) return;
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // Correcting mid-animation is pointless — the smooth scroll is still driving towards
    // its own stale target and simply overrides us. Wait for it to actually stop.
    afterScrollStops(() => settle(el));
  });

  // Arriving with a hash already in the URL — a shared link, or a search result.
  const onHash = () => {
    const el = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (el) settle(el);
  };
  window.addEventListener('hashchange', onHash);
  if (location.hash.length > 1) {
    onHash();
    // Fonts change line-breaks, which changes section heights, which moves the anchor.
    document.fonts?.ready.then(onHash).catch(() => {});
    addEventListener('load', onHash, { once: true });
  }
}

/** Highlight the nav link for whichever section is currently in view. */
function initScrollSpy() {
  const links = [...document.querySelectorAll('#site-nav a[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;

  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const sections = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
  if (!sections.length) return;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach(a => a.removeAttribute('aria-current'));
      byId.get(e.target.id)?.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });

  sections.forEach(s => io.observe(s));
}

// ═══════════════════════════════════════════════════════════════════ start

const hero = initHero({
  // build.mjs writes the content-hashed asset names onto <html>.
  glbUrl: document.documentElement.dataset.glb || '/assets/street.glb',
  pathUrl: document.documentElement.dataset.path || '/assets/camera_path.json',
});

const theme = initTheme((name) => hero?.setTheme(name));

revealOnScroll();
initVisaTabs();
initReviews();
initMobileNav();
initScrollSpy();
initAnchors();

const yearEl = document.querySelector('[data-year]');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// ════════════════════════════════════════════════════════════════════ chat
//
// The launcher is already in the HTML and fixed to the viewport, so it is visible and
// stable from the first paint. The panel itself is a separate chunk, fetched the first
// time someone shows interest — and prefetched quietly once the page is idle so that
// first click still feels instant.
{
  const launcher = document.getElementById('chat-launcher');
  if (launcher) {
    let loading = null;
    const load = () => (loading ??= import('./chat.js'));

    const onFirstClick = async (e) => {
      e.preventDefault();
      try {
        const { mountChat } = await load();
        mountChat(launcher);     // opens the panel and takes over the launcher from here
      } catch (err) {
        // The chunk did not load. Restore the plain link behaviour rather than leaving a
        // button that silently does nothing.
        console.error('[chat] module failed to load', err);
        launcher.removeAttribute('aria-controls');
        launcher.removeEventListener('click', onFirstClick);
        location.hash = '#contact';
      }
    };
    launcher.addEventListener('click', onFirstClick, { once: true });

    // Upgrade the link into a disclosure control now that JS is running, and warm the
    // chunk while the browser is idle so the first click feels instant.
    launcher.setAttribute('aria-expanded', 'false');
    const idle = () => ('requestIdleCallback' in window)
      ? requestIdleCallback(() => load().catch(() => {}), { timeout: 6000 })
      : setTimeout(() => load().catch(() => {}), 3000);
    if (document.readyState === 'complete') idle();
    else addEventListener('load', idle, { once: true });
  }
}

/**
 * Small debugging surface, kept in the production bundle on purpose: the performance
 * claims this site makes are about the visitor's hardware, and anyone should be able to
 * check them without a build of their own. Costs ~200 bytes.
 *
 *   __bdec.progress(0.85)   drive the hero camera directly
 *   __bdec.theme('day')     switch theme
 *   __bdec.stats()          draw calls, triangles, quality tier
 *   __bdec.hero.trace       boot sequence with timings
 *   …or append #perf to the URL for a live HUD.
 */
globalThis.__bdec = {
  progress(p) { hero?.stage?.jumpTo(p); hero?.stage?.renderOnce(); },
  theme(name) { theme.apply(name); },
  stats() { return hero?.stage?.stats ?? { mode: hero?.mode ?? 'none' }; },
  get hero() { return hero; },
};
