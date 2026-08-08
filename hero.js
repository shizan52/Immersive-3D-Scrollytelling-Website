/**
 * Hero lifecycle: decide whether to run WebGL at all, mount it late, drive it from
 * scroll, and stop it the moment it is not on screen.
 *
 * Deliberately free of three.js — scene.js is behind a dynamic import(), so this file
 * stays in the tiny entry bundle while the 600 KB of 3D code is a separate chunk that
 * many visitors never fetch.
 */

const clamp01 = v => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

/**
 * Should this visitor get the 3D hero?
 *
 * Declining is a first-class outcome, not a failure: the page is fully readable without
 * it, and forcing 400 KB of geometry onto a metered connection or a device that cannot
 * hold 60 FPS makes the site worse, not more impressive.
 */
function shouldRender3D() {
  if (!webglSupported()) return { ok: false, reason: 'no-webgl' };
  if (navigator.connection?.saveData) return { ok: false, reason: 'save-data' };
  // 2G: the GLB alone would take longer than the visitor will wait.
  const type = navigator.connection?.effectiveType;
  if (type && /^(slow-)?2g$/.test(type)) return { ok: false, reason: 'slow-network' };
  if (navigator.deviceMemory && navigator.deviceMemory < 2) return { ok: false, reason: 'low-memory' };
  return { ok: true, reason: null };
}

export function initHero({ glbUrl, pathUrl }) {
  const heroEl = document.getElementById('hero');
  const canvasEl = document.getElementById('webgl');
  const loaderEl = document.getElementById('loader');
  const barEl = document.getElementById('loader-bar');
  const pctEl = document.getElementById('loader-pct');
  const introEl = document.getElementById('hero-intro');
  const revealEl = document.getElementById('hero-reveal');
  const hintEl = document.getElementById('hero-hint');
  if (!heroEl || !canvasEl) return null;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const decision = shouldRender3D();

  /** Overlay copy is driven by scroll whether or not WebGL ever starts. */
  function updateOverlay(p) {
    const introOut = 1 - smoothstep(0.02, 0.24, p);
    introEl.style.opacity = introOut;
    introEl.style.transform = `translate3d(0, ${(1 - introOut) * -40}px, 0)`;
    introEl.hidden = introOut < 0.01;

    const revealIn = smoothstep(0.72, 0.96, p);
    revealEl.style.opacity = revealIn;
    revealEl.style.transform = `translate3d(0, ${(1 - revealIn) * 40}px, 0)`;
    revealEl.hidden = revealIn < 0.01;

    if (hintEl) hintEl.style.opacity = 1 - smoothstep(0, 0.12, p);
  }

  function scrollProgress() {
    const span = heroEl.offsetHeight - innerHeight;
    return clamp01(scrollY / (span > 0 ? span : 1));
  }

  // ---------------------------------------------------------------- no 3D
  if (!decision.ok) {
    document.documentElement.dataset.hero = decision.reason;
    loaderEl?.remove();
    // The hero still scrolls and still reveals its copy — it just does it over the CSS
    // sky instead of over a rendered street.
    heroEl.style.height = '160vh';
    addEventListener('scroll', () => updateOverlay(scrollProgress()), { passive: true });
    updateOverlay(scrollProgress());
    return { mode: 'fallback', reason: decision.reason };
  }

  document.documentElement.dataset.hero = 'webgl';

  let stage = null;
  let visible = false;
  let ticking = false;

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const p = scrollProgress();
      updateOverlay(p);
      stage?.setProgress(p);
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  updateOverlay(scrollProgress());

  // Start the render loop only while the hero is actually on screen. IntersectionObserver
  // instead of comparing scrollY to offsetHeight: it is the browser's own answer, it
  // survives layout changes, and it costs nothing per frame.
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!stage) return;
    if (visible) stage.start(); else stage.stop();
  }, { rootMargin: '10% 0px' });
  visibility.observe(heroEl);

  // Pause when the tab is hidden — a backgrounded tab still gets rAF in some browsers,
  // and a visitor leaving the tab open should not pay for it in battery.
  addEventListener('visibilitychange', () => {
    if (!stage) return;
    if (document.hidden) stage.stop();
    else if (visible) stage.start();
  });

  /** Kick off the download only once the hero is within a screen of the viewport. */
  const proximity = new IntersectionObserver((entries) => {
    if (!entries.some(e => e.isIntersecting)) return;
    proximity.disconnect();
    boot();
  }, { rootMargin: '100% 0px' });
  proximity.observe(heroEl);

  /** Boot breadcrumbs — the hero starts late and asynchronously, so when it does not
   *  appear, "how far did it get" is the first question worth answering. */
  const trace = [];
  const mark = (step) => { trace.push({ step, t: Math.round(performance.now()) }); };

  const api = {
    mode: 'webgl',
    setTheme: (name) => stage?.applyTheme(name),
    get stage() { return stage; },
    get trace() { return trace; },
  };

  /**
   * Yield until the page has painted and gone idle.
   *
   * Importing the 3D module costs ~600 KB of JavaScript to parse and compile on the main
   * thread. Started eagerly it competes with the first paint, and measurably pushed FCP
   * out — the headline is the whole point of the page and it must not wait behind
   * three.js. The hero is decorative; it can start a beat later.
   */
  function whenIdle() {
    return new Promise((resolve) => {
      const idle = () => ('requestIdleCallback' in window)
        ? requestIdleCallback(resolve, { timeout: 2000 })
        : setTimeout(resolve, 100);
      if (document.readyState === 'complete') idle();
      else addEventListener('load', idle, { once: true });
    });
  }

  async function boot() {
    mark('boot');
    await whenIdle();
    mark('idle');
    if (document.documentElement.dataset.hero !== 'webgl') return;

    let Stage;
    try {
      ({ Stage } = await import('./scene.js'));
      mark('module');
    } catch (err) {
      console.error('[hero] could not load the 3D module', err);
      loaderEl?.remove();
      document.documentElement.dataset.hero = 'error';
      return;
    }

    stage = new Stage(canvasEl, { reducedMotion });
    mark('stage-constructed');
    // The theme may already have been toggled by the visitor before the scene arrived.
    stage.applyTheme(document.documentElement.dataset.theme === 'day' ? 'day' : 'night',
      { immediate: true });

    try {
      await stage.load({
        glbUrl,
        pathUrl,
        onProgress: (f) => {
          const pct = Math.round(f * 100);
          if (barEl) barEl.style.width = pct + '%';
          if (pctEl) pctEl.textContent = `Loading scene… ${pct}%`;
        },
      });
      mark('loaded');
    } catch (err) {
      mark('load-failed');
      console.error('[hero] scene failed to load', err);
      if (pctEl) pctEl.textContent = 'Scene failed to load — the rest of the page still works normally.';
      setTimeout(() => loaderEl?.classList.add('is-hidden'), 1200);
      document.documentElement.dataset.hero = 'error';
      stage.dispose();
      stage = null;
      return;
    }

    stage.jumpTo(scrollProgress());
    stage.renderOnce();
    // Cross-fade from the CSS backdrop to the rendered scene, and only then let the CSS
    // sky/stars layers go — dropping them any earlier would flash the page background.
    document.documentElement.setAttribute('data-hero-ready', '');
    mark('ready');
    loaderEl?.classList.add('is-hidden');
    loaderEl?.addEventListener('transitionend', () => loaderEl.remove(), { once: true });
    if (visible) stage.start();

    // Release the GPU context on the way out rather than waiting for the collector.
    addEventListener('pagehide', () => stage?.dispose(), { once: true });

    if (location.hash === '#perf') attachPerfHud(stage);
  }

  return api;
}

/**
 * Opt-in performance HUD (append #perf to the URL).
 *
 * The point of this project is a set of numbers — 60 FPS, GPU headroom, a memory ceiling.
 * Those are claims about the visitor's hardware, not ours, so ship a way for anyone to
 * check them on their own machine.
 */
function attachPerfHud(stage) {
  const el = document.createElement('div');
  el.className = 'perf-hud';
  document.body.appendChild(el);

  let frames = 0;
  let last = performance.now();

  const tick = () => {
    frames++;
    const now = performance.now();
    if (now - last >= 500) {
      const fps = Math.round((frames * 1000) / (now - last));
      frames = 0;
      last = now;
      const s = stage.stats;
      const mem = performance.memory
        ? ` · js ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB` : '';
      el.textContent = `${fps} fps · ${s.calls} draws · ${(s.triangles / 1000).toFixed(0)}k tris `
        + `· ${s.geometries} geo · ${s.programs} prog · tier ${s.tier}${mem}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
