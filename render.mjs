/**
 * site.json  ->  HTML
 *
 * The page used to be hand-written markup. It is now generated from site.json so the
 * admin panel can edit every word, colour, image and animation without anyone touching
 * code — and, crucially, the output is still a fully static prerendered document. The
 * visitor's browser does no assembly work, so the 153 KB / 304 ms first paint survives.
 *
 * Every block type here has a matching editor in admin.html. Adding a block type means
 * touching three places: BLOCKS below, the editor in admin.html, and the CSS.
 */

const ANIMATIONS = new Set(['none', 'fade', 'fade-up', 'fade-down', 'zoom', 'slide-left', 'slide-right']);
const FRAMES = new Set(['none', 'soft', 'bordered', 'shadow', 'polaroid', 'circle']);

/** Escape text that must never be read as markup. */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Content that is allowed to carry simple inline markup (bold, links, line breaks).
 *
 * The admin is password-protected and single-user, so this is not a defence against a
 * hostile author — it is a guard against a stray "<" in ordinary Bengali copy silently
 * eating the rest of a paragraph. Anything not on the allow-list is escaped.
 */
export function rich(s) {
  const ALLOWED = /^<\/?(strong|b|em|i|br|span|a|small|u)(\s[^<>]*)?>$/i;
  return String(s ?? '').replace(/<[^>]*>/g, (tag) => (ALLOWED.test(tag) ? tag : esc(tag)));
}

/** Inline style from the per-block colour controls. Empty when nothing is set. */
function styleAttr(b) {
  const out = [];
  if (b.color) out.push(`color:${cssColor(b.color)}`);
  if (b.bg) out.push(`background:${cssColor(b.bg)}`);
  if (b.align) out.push(`text-align:${['left', 'center', 'right'].includes(b.align) ? b.align : 'start'}`);
  if (b.maxWidth) out.push(`max-width:${Number(b.maxWidth) || 40}rem`);
  if (b.padding) out.push(`padding:${Number(b.padding) || 0}rem`);
  if (b.radius) out.push(`border-radius:${Number(b.radius) || 0}rem`);
  return out.length ? ` style="${out.join(';')}"` : '';
}

/** Only let through colours we can validate — never raw CSS from the editor. */
function cssColor(v) {
  const s = String(v).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*(\/\s*[\d.]+%?\s*)?\)$/i.test(s)) return s;
  if (/^var\(--[a-z0-9-]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;           // named colours
  return 'inherit';
}

/** data-reveal drives the scroll-in animation; app.js adds .is-revealed. */
function anim(b, fallback = 'fade-up') {
  const a = ANIMATIONS.has(b.animation) ? b.animation : fallback;
  return a === 'none' ? '' : ` data-reveal="${a}"`;
}

function frameClass(v) {
  return FRAMES.has(v) && v !== 'none' ? ` frame--${v}` : '';
}

/** <img> with the sizing/lazy attributes that keep CLS at zero. */
function imgTag(b, extraClass = '') {
  if (!b.src) return '';
  const w = b.width ? ` width="${Number(b.width)}"` : '';
  const h = b.height ? ` height="${Number(b.height)}"` : '';
  return `<img src="${esc(b.src)}" alt="${esc(b.alt || '')}"${w}${h} `
    + `loading="lazy" decoding="async" class="blk-img${frameClass(b.frame)}${extraClass}">`;
}

// ══════════════════════════════════════════════════════════════════ blocks

const BLOCKS = {
  eyebrow: (b) => `<p class="eyebrow"${styleAttr(b)}${anim(b, 'none')}>${rich(b.text)}</p>`,

  heading: (b) => {
    const lvl = [2, 3, 4].includes(Number(b.level)) ? Number(b.level) : 2;
    return `<h${lvl}${styleAttr(b)}${anim(b, 'none')}>${rich(b.text)}</h${lvl}>`;
  },

  text: (b) => {
    const cls = b.style === 'lead' ? ' class="lead"' : '';
    return `<p${cls}${styleAttr(b)}${anim(b, 'none')}>${rich(b.text)}</p>`;
  },

  image: (b) => {
    const cap = b.caption ? `<figcaption>${rich(b.caption)}</figcaption>` : '';
    const align = b.align === 'center' ? ' figure--center' : b.align === 'right' ? ' figure--right' : '';
    return `<figure class="figure${align}"${styleAttr({ maxWidth: b.maxWidth })}${anim(b)}>`
      + `${imgTag(b)}${cap}</figure>`;
  },

  imageText: (b) => {
    const side = b.side === 'right' ? ' media--flip' : '';
    const body = [
      b.heading ? `<h3>${rich(b.heading)}</h3>` : '',
      b.text ? `<p>${rich(b.text)}</p>` : '',
      b.buttons?.length ? BLOCKS.buttons({ items: b.buttons, animation: 'none' }) : '',
    ].join('');
    return `<div class="media${side}"${anim(b)}>`
      + `<div class="media__img">${imgTag(b)}</div>`
      + `<div class="media__body"${styleAttr({ color: b.color, align: b.align })}>${body}</div></div>`;
  },

  cards: (b) => {
    const cards = (b.items || []).map((it) => {
      const mark = it.mark
        ? `<p class="card__mark"${it.markLang ? ` lang="${esc(it.markLang)}"` : ''} aria-hidden="true">${esc(it.mark)}</p>`
        : '';
      const img = it.src ? imgTag(it, ' card__img') : '';
      return `<article class="card"${styleAttr(it)}>${img}${mark}`
        + `<h3>${rich(it.title)}</h3><p>${rich(it.text)}</p></article>`;
    }).join('');
    return `<div class="grid"${anim(b)}>${cards}</div>`;
  },

  columns: (b) => `<div class="visa"${anim(b)}>${(b.columns || []).map(columnHtml).join('')}</div>`,

  tabs: (b) => {
    const tabs = (b.tabs || []);
    const list = tabs.map((t, i) => `<li role="presentation"><button class="tabs__tab" role="tab" `
      + `type="button" id="tab-${esc(t.id)}" aria-controls="panel-${esc(t.id)}" `
      + `aria-selected="${i === 0}"${i === 0 ? '' : ' tabindex="-1"'}>${esc(t.label)}</button></li>`).join('');
    const panels = tabs.map((t, i) => `<div class="tabs__panel" role="tabpanel" id="panel-${esc(t.id)}" `
      + `aria-labelledby="tab-${esc(t.id)}" tabindex="0"${i === 0 ? '' : ' hidden'}>`
      + (t.heading ? `<h3>${rich(t.heading)}</h3>` : '')
      + `<div class="visa">${(t.columns || []).map(columnHtml).join('')}</div></div>`).join('');
    return `<div class="tabs" data-tabs${anim(b)}>`
      + `<ul class="tabs__list" role="tablist" aria-label="${esc(b.label || '')}">${list}</ul>${panels}</div>`;
  },

  table: (b) => {
    const head = (b.head || []).map(h => `<th scope="col">${rich(h)}</th>`).join('');
    const rows = (b.rows || []).map(r => {
      const [first, ...rest] = r;
      return `<tr><th scope="row">${rich(first)}</th>${rest.map(c => `<td>${rich(c)}</td>`).join('')}</tr>`;
    }).join('');
    return `<div class="table-scroll"${anim(b)}><table>`
      + (b.caption ? `<caption>${rich(b.caption)}</caption>` : '')
      + `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  },

  steps: (b) => {
    const items = (b.items || []).map(it =>
      `<li><h3>${rich(it.title)}</h3><p>${rich(it.text)}</p></li>`).join('');
    return `<ol class="steps"${anim(b)}>${items}</ol>`;
  },

  offices: (b) => {
    const items = (b.items || []).map(o => {
      const phones = (o.phones || []).map(p =>
        `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>`).join('<br>');
      return `<article class="card office">`
        + (o.flag ? `<p class="office__flag" aria-hidden="true">${esc(o.flag)}</p>` : '')
        + `<h3>${rich(o.name)}</h3><address>${rich(o.address)}</address>`
        + (phones ? `<p>${phones}</p>` : '') + `</article>`;
    }).join('');
    return `<div class="grid"${anim(b)}>${items}</div>`;
  },

  contactCards: (b) => {
    const items = (b.items || []).map(c =>
      `<div class="contact__card"><h3>${rich(c.title)}</h3><p>${rich(c.text)}</p>`
      + `<a class="btn btn--${c.style === 'primary' ? 'primary' : 'ghost'} btn--sm" `
      + `href="${esc(c.href)}"${/^https?:/.test(c.href || '') ? ' rel="noopener"' : ''}>${esc(c.label)}</a></div>`).join('');
    return `<div class="contact"${anim(b)}>${items}</div>`;
  },

  buttons: (b) => {
    const items = (b.items || []).map(buttonHtml).join('');
    return `<div class="btn-row"${styleAttr({ align: b.align })}${anim(b)}>${items}</div>`;
  },

  /**
   * Frequently asked questions.
   *
   * Native <details>, so it opens and closes with no JavaScript and every answer is in
   * the HTML from the start — which is exactly what a search engine or an AI crawler
   * needs to read. The same items become FAQPage structured data (renderJsonLd), so what
   * Google may show in results is word-for-word what is on the page.
   */
  faq: (b) => {
    const items = (b.items || []).map((it, i) => `<details class="faq__item"${i === 0 ? ' open' : ''}>`
      + `<summary>${rich(it.q)}</summary>`
      + `<div class="faq__a">${rich(it.a)}</div></details>`).join('');
    return `<div class="faq"${anim(b)}>${items}</div>`;
  },

  quote: (b) => `<blockquote class="quote"${styleAttr(b)}${anim(b)}>`
    + `<p>${rich(b.text)}</p>${b.cite ? `<cite>${rich(b.cite)}</cite>` : ''}</blockquote>`,

  /**
   * Student reviews.
   *
   * One markup, three behaviours, all from CSS: a scroll-snapping flex track. On a wide
   * screen the cards divide the row so four sit side by side; as the screen narrows they
   * grow until, on a phone, one fills the view and the rest are a swipe away. No
   * JavaScript is required for any of that — the arrows added by app.js are an
   * enhancement for mouse users, not the mechanism.
   */
  reviews: (b) => {
    const per = [2, 3, 4].includes(Number(b.columns)) ? Number(b.columns) : 4;
    const cards = (b.items || []).map((r) => {
      const stars = Number(r.rating) >= 1
        ? `<p class="review__stars" aria-label="${Number(r.rating)} / 5">${'★'.repeat(Math.min(5, Math.round(r.rating)))}<span>${'★'.repeat(5 - Math.min(5, Math.round(r.rating)))}</span></p>`
        : '';
      const photo = r.src
        ? `<img class="review__photo" src="${esc(r.src)}" alt="" width="56" height="56" loading="lazy" decoding="async">`
        : `<span class="review__photo review__photo--initial" aria-hidden="true">${esc(String(r.name || '?').trim().charAt(0))}</span>`;
      return `<figure class="review"${styleAttr({ bg: r.bg, color: r.color })}>`
        + stars
        + `<blockquote class="review__text">${rich(r.text)}</blockquote>`
        + `<figcaption class="review__who">${photo}`
        + `<span><b>${esc(r.name)}</b>${r.meta ? `<small>${esc(r.meta)}</small>` : ''}</span>`
        + `</figcaption></figure>`;
    }).join('');
    return `<div class="reviews" data-reviews style="--per:${per}"${anim(b)}>`
      + `<button class="reviews__nav reviews__nav--prev" type="button" aria-label="Previous review" hidden>‹</button>`
      + `<div class="reviews__track" tabindex="0" role="group" aria-label="Student experiences">${cards}</div>`
      + `<button class="reviews__nav reviews__nav--next" type="button" aria-label="Next review" hidden>›</button>`
      + `</div>`;
  },

  /**
   * Course fees.
   *
   * A price is the thing people scroll looking for, so it is a card per course rather
   * than a table: a table forces the eye across columns to answer "what does this one
   * cost", and it collapses badly on a phone. One card carries one answer.
   */
  fees: (b) => {
    const cards = (b.items || []).map((f) => {
      const includes = (f.includes || []).filter(Boolean)
        .map(i => `<li>${rich(i)}</li>`).join('');
      return `<article class="fee${f.featured ? ' fee--featured' : ''}"${styleAttr({ bg: f.bg })}>`
        + (f.badge ? `<p class="fee__badge">${esc(f.badge)}</p>` : '')
        + `<h3 class="fee__name">${rich(f.name)}</h3>`
        + (f.sub ? `<p class="fee__sub">${rich(f.sub)}</p>` : '')
        + `<p class="fee__amount">${rich(f.amount)}`
        + (f.unit ? `<span class="fee__unit">${esc(f.unit)}</span>` : '') + `</p>`
        + (includes ? `<ul class="fee__list">${includes}</ul>` : '')
        + (f.note ? `<p class="fee__note">${rich(f.note)}</p>` : '')
        + (f.buttonTarget || f.buttonLabel
            ? `<div class="fee__cta">${buttonHtml({
                target: f.buttonTarget, label: f.buttonLabel,
                href: f.buttonHref, style: f.buttonStyle || 'primary',
              })}</div>`
            : '')
        + `</article>`;
    }).join('');
    const foot = b.note ? `<p class="fee__foot">${rich(b.note)}</p>` : '';
    return `<div class="fees"${anim(b)}>${cards}</div>${foot}`;
  },

  /**
   * Recent posts — photos and clips, the way they are shared on Facebook.
   *
   * Deliberately one scrolling row rather than a grid: a grid of six invites the eye to
   * compare, a row invites it to move along, and on a phone the row is the only shape
   * that works at all. Videos carry sound but never autoplay with it — a page that
   * starts talking is a page people close.
   */
  media: (b) => {
    const per = [2, 3, 4].includes(Number(b.columns)) ? Number(b.columns) : 3;
    const posts = (b.items || []).slice(0, 6).map((m, i) => {
      // A post keeps its photo and its clip in separate fields, so switching between the
      // two never throws one away — `src` is the older single-field form, still honoured.
      const isVideo = m.kind === 'video';
      const video = m.video || (isVideo ? m.src : '');
      const image = m.image || (isVideo ? '' : m.src);

      let figure = '';
      if (isVideo && video) {
        figure = `<video class="post__media" ${m.poster ? `poster="${esc(m.poster)}" ` : ''}`
          + `preload="metadata" playsinline controls${m.loop ? ' loop' : ''}`
          + `${m.muted ? ' muted' : ''}><source src="${esc(video)}">`
          + `Your browser cannot play video.</video>`;
      } else if (!isVideo && image) {
        figure = `<img class="post__media" src="${esc(image)}" alt="${esc(m.alt || '')}"`
          + `${m.width ? ` width="${Number(m.width)}"` : ''}${m.height ? ` height="${Number(m.height)}"` : ''}`
          + ` loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">`;
      }
      const body = (m.title || m.text)
        ? `<div class="post__body">`
          + (m.title ? `<h3 class="post__title">${rich(m.title)}</h3>` : '')
          + (m.text ? `<p class="post__text">${rich(m.text)}</p>` : '')
          + `</div>`
        : '';
      const meta = (m.date || m.tag)
        ? `<p class="post__meta">${m.tag ? `<span class="post__tag">${esc(m.tag)}</span>` : ''}`
          + `${m.date ? `<span>${esc(m.date)}</span>` : ''}</p>`
        : '';
      const inner = `<figure class="post__frame${frameClass(m.frame || b.frame)}">${figure}`
        + (isVideo && video ? '<span class="post__play" aria-hidden="true">▶</span>' : '')
        + `</figure>${meta}${body}`;

      // Wrapping a video in a link would swallow its controls — you could never press
      // play. So a video post puts the link on its caption instead of the whole card.
      if (!m.href) return `<article class="post">${inner}</article>`;
      const ext = /^https?:/i.test(m.href) ? ' target="_blank" rel="noopener"' : '';
      if (isVideo && video) {
        return `<article class="post">${inner}`
          + `<p class="post__more"><a href="${esc(m.href)}"${ext}>See more →</a></p></article>`;
      }
      return `<article class="post"><a class="post__link" href="${esc(m.href)}"${ext}>${inner}</a></article>`;
    }).join('');

    return `<div class="posts" data-posts style="--per:${per}"${anim(b)}>`
      + `<button class="posts__nav posts__nav--prev" type="button" aria-label="Previous post" hidden>‹</button>`
      + `<div class="posts__track" tabindex="0" role="group" aria-label="Recent posts">${posts}</div>`
      + `<button class="posts__nav posts__nav--next" type="button" aria-label="Next post" hidden>›</button>`
      + `</div>`;
  },

  html: (b) => `<div class="raw"${styleAttr(b)}${anim(b)}>${b.html || ''}</div>`,

  divider: (b) => `<hr class="divider"${styleAttr(b)}>`,

  spacer: (b) => `<div style="height:${Number(b.size) || 2}rem" aria-hidden="true"></div>`,
};

function columnHtml(col) {
  const items = (col.items || []).map(i => `<li>${rich(i)}</li>`).join('');
  const note = col.note ? `<p class="lead" style="margin-top:1rem;font-size:.93rem">${rich(col.note)}</p>` : '';
  const mod = col.accent === 'gold' ? ' visa__block--perks' : '';
  return `<div class="visa__block${mod}">`
    + (col.title ? `<h3>${rich(col.title)}</h3>` : '')
    + `<ul class="checklist">${items}</ul>${note}</div>`;
}

function renderBlock(b) {
  const fn = BLOCKS[b?.type];
  if (!fn) return `<!-- unknown block: ${esc(b?.type)} -->`;
  try {
    return fn(b);
  } catch (err) {
    // One malformed block must never take the whole page down.
    console.warn(`[render] block "${b.type}" failed: ${err.message}`);
    return `<!-- block ${esc(b.type)} failed to render -->`;
  }
}

// ════════════════════════════════════════════════════════════════ sections

export function renderSections(site) {
  return (site.sections || [])
    .filter(s => s.visible !== false)
    .map((s) => {
      const style = styleAttr({ bg: s.bg, color: s.color });
      const label = s.blocks?.find(b => b.type === 'heading');
      const labelId = label ? ` aria-labelledby="${esc(s.id)}-title"` : '';
      const blocks = (s.blocks || []).map((b, i) => {
        let html = renderBlock(b);
        // Give the section's first heading a stable id so aria-labelledby resolves.
        if (label && b === label) html = html.replace(/^<h(\d)/, `<h$1 id="${esc(s.id)}-title"`);
        return html;
      }).join('\n      ');
      return `  <section class="section" id="${esc(s.id)}"${labelId}${style}`
        + `${s.animation === 'none' ? '' : ' data-reveal'}>\n      ${blocks}\n  </section>`;
    })
    .join('\n\n');
}

export function renderNav(site) {
  return (site.nav || []).map(n =>
    `      <li><a href="${esc(n.href)}">${esc(n.label)}</a></li>`).join('\n');
}

/**
 * Where a hero button can point.
 *
 * Presets exist so the owner picks "Registration" instead of remembering that the URL is
 * /register.html — and so a later change of that path is one edit here, not a hunt through
 * every panel. `custom` keeps the escape hatch.
 */
export const BUTTON_TARGETS = {
  register: { label: 'Register now', href: '/register.html' },
  contact: { label: 'Get in touch', href: '#contact' },
  consult: { label: 'Free consultation', href: '#contact' },
  workVisa: { label: 'See work visas', href: '#work-visa' },
  studentVisa: { label: 'See student visa', href: '#student-visa' },
  process: { label: 'See the process', href: '#process' },
  offices: { label: 'See our offices', href: '#offices' },
  reviews: { label: 'Student experiences', href: '#reviews' },
  whatsapp: { label: 'Message on WhatsApp', href: 'https://wa.me/8801689447591' },
  call: { label: 'Call now', href: 'tel:+8801689447591' },
  email: { label: 'Send an email', href: 'mailto:bdeducationcentre748@gmail.com' },
};

/** A preset fills label and href; anything typed in the panel still wins. */
export function resolveButton(b) {
  const preset = BUTTON_TARGETS[b?.target];
  return {
    label: b?.label || preset?.label || 'Button',
    href: b?.href || preset?.href || '#',
    style: b?.style === 'ghost' ? 'ghost' : 'primary',
  };
}

const buttonHtml = (b) => {
  const r = resolveButton(b);
  return `<a class="btn btn--${r.style}" href="${esc(r.href)}"`
    + `${/^https?:/.test(r.href) ? ' rel="noopener"' : ''}>${esc(r.label)}</a>`;
};

const HERO_POSITIONS = new Set(['center', 'top', 'bottom', 'left', 'right']);

export function renderHeroPanels(site) {
  // Three is the ceiling: the panels are keyed to fixed points along the camera path, and
  // a fourth would have nowhere of its own to appear.
  return (site.hero?.panels || []).slice(0, 3).map((p, i) => {
    const eyebrow = p.eyebrow
      ? `<p class="eyebrow${p.eyebrowLang ? ' eyebrow--latin hero__jp' : ''}"`
        + `${p.eyebrowLang ? ` lang="${esc(p.eyebrowLang)}"` : ''}>${rich(p.eyebrow)}</p>`
      : '';
    const buttons = (p.buttons || []).map(buttonHtml).join('\n        ');
    // Only the first panel carries the h1. The others are the same headline restated as
    // the camera moves, and a page with three h1 elements tells a search engine it has
    // three subjects — so they render as h2 while looking identical.
    const tag = i === 0 ? 'h1' : 'h2';
    const titleId = i === 0 ? ' id="hero-title"' : '';

    // Media panels put an image or a short clip behind the copy; the 3D street keeps
    // running underneath either way. Photo and clip live in separate fields so switching
    // a panel between them never loses either; `src` is the older single-field form.
    const panelImage = p.image || (p.kind === 'image' ? p.src : '');
    const panelVideo = p.video || (p.kind === 'video' ? p.src : '');

    let media = '';
    if (p.kind === 'image' && panelImage) {
      media = `      <div class="hero__media${frameClass(p.frame)}">`
        + `<img src="${esc(panelImage)}" alt="${esc(p.alt || '')}" loading="lazy" decoding="async"`
        + `${p.width ? ` width="${Number(p.width)}"` : ''}${p.height ? ` height="${Number(p.height)}"` : ''}></div>\n`;
    } else if (p.kind === 'video' && panelVideo) {
      // Muted + playsinline + loop is the only combination browsers will autoplay, and
      // preload="none" keeps the bytes off the critical path until the panel is reached.
      media = `      <div class="hero__media${frameClass(p.frame)}">`
        + `<video src="${esc(panelVideo)}"${p.poster ? ` poster="${esc(p.poster)}"` : ''}`
        + ` autoplay muted loop playsinline preload="none"${p.alt ? ` aria-label="${esc(p.alt)}"` : ''}>`
        + `</video></div>\n`;
    }

    const pos = HERO_POSITIONS.has(p.position) ? p.position : 'center';
    const style = styleAttr({ color: p.color, align: p.align });

    return `    <div class="hero__panel hero__panel--${pos}" id="${esc(p.id)}"`
      + `${i === 0 ? '' : ' hidden'}${style}>\n`
      + media
      + (eyebrow ? `      ${eyebrow}\n` : '')
      + (p.title ? `      <${tag}${titleId} class="hero__title">${rich(p.title)}</${tag}>\n` : '')
      + (p.sub ? `      <p class="hero__sub">${rich(p.sub)}</p>\n` : '')
      + (buttons ? `      <div class="hero__actions">\n        ${buttons}\n      </div>\n` : '')
      + `    </div>`;
  }).join('\n\n');
}

/**
 * The whole brand lock-up: mark (or logo), name and tagline.
 *
 * Rendered as one unit so each piece can carry its own colour and size from the panel.
 * An uploaded logo replaces the emoji outright — same slot — so switching between them
 * needs no layout change. Both are aria-hidden: the brand name sits right beside them,
 * and a screen reader announcing "torii gate" or a file name adds nothing.
 */
export function renderBrand(site) {
  const b = site.brand ?? {};

  const mark = b.logo
    ? `<img class="brand__logo" src="${esc(b.logo)}" alt=""`
      + `${b.logoWidth ? ` width="${Number(b.logoWidth)}"` : ''}`
      + `${b.logoHeight ? ` height="${Number(b.logoHeight)}"` : ''}`
      + `${b.logoSize ? ` style="block-size:${Number(b.logoSize)}rem"` : ''}`
      + ` decoding="async">`
    : `<span class="brand__torii" aria-hidden="true"${styleAttr({ color: b.markColor })}>`
      + `${esc(b.mark ?? '')}</span>`;

  return `  <a class="brand" href="#top">\n`
    + `    ${mark}\n`
    + `    <span>\n`
    + `      <strong class="brand__name"${styleAttr({ color: b.nameColor })}>${esc(b.name ?? '')}</strong>\n`
    + `      <small class="brand__tag"${styleAttr({ color: b.taglineColor })}>${esc(b.tagline ?? '')}</small>\n`
    + `    </span>\n`
    + `  </a>`;
}

/** The header's call-to-action button. */
export function renderHeaderCta(site) {
  const b = site.brand ?? {};
  if (!b.ctaLabel) return '';
  const style = b.ctaStyle === 'ghost' ? 'ghost' : 'primary';
  return `    <a class="btn btn--${style} btn--sm header-cta" href="${esc(b.ctaHref ?? '#contact')}">`
    + `${esc(b.ctaLabel)}</a>`;
}

/**
 * Favicon links.
 *
 * With a logo uploaded, the PNGs are generated from it and lead. Without one, the drawn
 * SVG leads and the shipped default PNGs follow as the fallback — every one of these
 * files exists in both states, so the <head> never points at a 404.
 */
export function renderIcons(site, hasLogo) {
  const png = `<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">\n`
    + `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
  if (hasLogo) return png;
  return `<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n${png}`;
}

export function renderFooter(site) {
  const cols = (site.footer?.columns || []).map(c =>
    `    <div>\n      <h2>${rich(c.title)}</h2>\n      <p>${rich(c.html)}</p>\n    </div>`).join('\n');
  return cols;
}

/** Markup → plain text, for the JSON-LD and llms.txt copies of on-page content. */
export const plain = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const allBlocks = (site) => (site.sections || [])
  .filter(s => s.visible !== false)
  .flatMap(s => (s.blocks || []).map(b => [s, b]));

/**
 * Everything a machine needs to understand this business, as schema.org JSON-LD.
 *
 * The graph is built from the same site.json the page is rendered from, so it can never
 * drift from what a visitor reads — which is precisely what Google's structured-data
 * guidelines require, and what makes the markup safe to trust.
 *
 * Deliberately NOT emitted: Review / AggregateRating. The review entries in site.json are
 * placeholder copy, not collected customer feedback. Publishing them as rating markup
 * would be fabricated structured data and is a manual-action risk. Once real, attributed
 * reviews exist, add them here.
 */
export function renderJsonLd(site, origin) {
  const blocks = allBlocks(site);
  const brand = site.brand || {};
  const seo = site.seo || {};
  const orgId = `${origin}/#org`;

  const offices = blocks.filter(([, b]) => b.type === 'offices').flatMap(([, b]) => b.items || []);
  const phones = [...new Set(offices.flatMap(o => o.phones || []).map(p => p.replace(/[^\d+]/g, '')))];

  const businesses = offices.map((o, i) => ({
    '@type': 'LocalBusiness',
    '@id': `${origin}/#office-${i}`,
    name: `${brand.name || ''} — ${plain(o.name).replace(/\s*Office$/i, '')}`.trim(),
    parentOrganization: { '@id': orgId },
    url: `${origin}/#offices`,
    ...(o.phones?.length ? { telephone: o.phones.map(p => p.replace(/[^\d+]/g, '')) } : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: plain(o.address),
      ...(o.city ? { addressLocality: o.city } : {}),
      ...(o.region ? { addressRegion: o.region } : {}),
      ...(o.postal ? { postalCode: o.postal } : {}),
      addressCountry: o.country || (o.flag === '🇯🇵' ? 'JP' : 'BD'),
    },
  }));

  // One Service per visa route, taken from the tab/heading structure already on the page.
  // These are what people actually search for, so they are what we name.
  const services = blocks
    .filter(([, b]) => b.type === 'tabs')
    .flatMap(([sec, b]) => (b.tabs || []).map(t => ({
      '@type': 'Service',
      '@id': `${origin}/#service-${sec.id}-${t.id}`,
      name: plain(t.label),
      serviceType: plain(t.heading || t.label),
      provider: { '@id': orgId },
      areaServed: [{ '@type': 'Country', name: 'Bangladesh' }, { '@type': 'Country', name: 'Japan' }],
      audience: { '@type': 'Audience', audienceType: 'Bangladeshi students and workers' },
      ...(t.columns?.length ? {
        description: t.columns.flatMap(c => (c.items || []).map(plain)).slice(0, 6).join('; '),
      } : {}),
    })));

  const faqItems = blocks
    .filter(([, b]) => b.type === 'faq')
    .flatMap(([, b]) => b.items || [])
    .filter(f => f.q && f.a);

  const faqPage = faqItems.length ? [{
    '@type': 'FAQPage',
    '@id': `${origin}/#faq`,
    mainEntity: faqItems.map(f => ({
      '@type': 'Question',
      name: plain(f.q),
      acceptedAnswer: { '@type': 'Answer', text: plain(f.a) },
    })),
  }] : [];

  // Courses with a price. People search for course fees more often than for anything
  // else on this site, so the numbers are stated in a form Google can read.
  const courses = blocks
    .filter(([, b]) => b.type === 'fees')
    .flatMap(([sec, b]) => (b.items || []).map((f, i) => {
      const digits = plain(f.amount).replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/[^\d]/g, '');
      return {
        '@type': 'Course',
        '@id': `${origin}/#course-${sec.id}-${i}`,
        name: plain(f.name),
        description: plain(f.sub) || plain(f.name),
        provider: { '@id': orgId },
        inLanguage: 'en',
        teaches: (f.includes || []).map(plain).filter(Boolean).join('; ') || undefined,
        ...(digits ? {
          offers: {
            '@type': 'Offer',
            price: digits,
            priceCurrency: 'BDT',
            category: 'Tuition',
            availability: 'https://schema.org/InStock',
            url: `${origin}/#${sec.id}`,
          },
        } : {}),
        hasCourseInstance: {
          '@type': 'CourseInstance',
          courseMode: 'onsite',
          location: businesses[0] ? { '@id': businesses[0]['@id'] } : undefined,
        },
      };
    }));

  const steps = blocks.filter(([, b]) => b.type === 'steps').flatMap(([, b]) => b.items || []);
  const howTo = steps.length ? [{
    '@type': 'HowTo',
    '@id': `${origin}/#process`,
    name: 'Bangladesh to Japan — Application Steps',
    step: steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: plain(s.title),
      text: plain(s.text),
      url: `${origin}/#process`,
    })),
  }] : [];

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['EducationalOrganization', 'LocalBusiness'],
        '@id': orgId,
        name: brand.name,
        url: `${origin}/`,
        ...(brand.logo ? { logo: { '@type': 'ImageObject', url: origin + brand.logo } } : {}),
        image: `${origin}/og-cover.png`,
        slogan: brand.tagline,
        description: plain(seo.description),
        ...(seo.foundingClaim ? { disambiguatingDescription: plain(seo.foundingClaim) } : {}),
        knowsLanguage: ['bn', 'en', 'ja'],
        ...(phones.length ? { telephone: phones } : {}),
        email: 'bdeducationcentre748@gmail.com',
        areaServed: [
          { '@type': 'Country', name: 'Bangladesh' },
          { '@type': 'Country', name: 'Japan' },
        ],
        ...(businesses[0] ? { address: businesses[0].address } : {}),
        contactPoint: [{
          '@type': 'ContactPoint',
          contactType: 'admissions',
          ...(phones.length ? { telephone: phones[0] } : {}),
          email: 'bdeducationcentre748@gmail.com',
          availableLanguage: ['Bengali', 'English', 'Japanese'],
          areaServed: ['BD', 'JP'],
        }],
        department: businesses.map(b => ({ '@id': b['@id'] })),
        ...(services.length ? { makesOffer: services.map(s => ({ '@id': s['@id'] })) } : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#site`,
        url: `${origin}/`,
        name: brand.name,
        inLanguage: 'en',
        publisher: { '@id': orgId },
      },
      {
        '@type': 'WebPage',
        '@id': `${origin}/`,
        url: `${origin}/`,
        name: plain(seo.title),
        description: plain(seo.description),
        inLanguage: 'en',
        isPartOf: { '@id': `${origin}/#site` },
        about: { '@id': orgId },
        ...(faqItems.length ? { mainEntity: { '@id': `${origin}/#faq` } } : {}),
      },
      ...businesses,
      ...services,
      ...courses,
      ...faqPage,
      ...howTo,
    ],
  }, null, 2);
}

/**
 * The whole site as clean Markdown, for llms.txt.
 *
 * An AI crawler that fetches this gets the page's own words with no markup, no navigation
 * and no JavaScript in the way — the same facts a human reads, in the cheapest possible
 * form to parse. Generated from site.json at build time, so it cannot go stale.
 */
export function renderLlmsTxt(site, origin, extra = '') {
  const out = [];
  const brand = site.brand || {};
  const seo = site.seo || {};

  out.push(`# ${brand.name || 'Website'}`, '');
  out.push(`> ${plain(seo.description)}`, '');
  if (seo.foundingClaim) out.push(`**${plain(seo.foundingClaim)}**`, '');
  out.push(
    `- Site: ${origin}/`,
    `- Language: English (main), বাংলা, 日本語`,
    `- Services: Japan student visas, work visas (Engineer/Humanities, SSW, TITP),`
      + ` Japanese language training, job placement and permanent residency consulting`,
    `- Region: Bangladesh (Dhaka, Barishal) and Japan (Tokyo)`,
    '',
  );

  const line = (b) => {
    switch (b.type) {
      case 'heading': return `\n${'#'.repeat(Math.min(6, (b.level || 2) + 1))} ${plain(b.text)}\n`;
      case 'eyebrow': return `**${plain(b.text)}**\n`;
      case 'text': case 'quote': return `${plain(b.text)}\n`;
      case 'imageText': return `${b.heading ? `**${plain(b.heading)}** — ` : ''}${plain(b.text)}\n`;
      case 'image': return b.caption ? `_${plain(b.caption)}_\n` : '';
      case 'cards':
        return (b.items || []).map(i => `- **${plain(i.title)}** — ${plain(i.text)}`).join('\n') + '\n';
      case 'steps':
        return (b.items || []).map((i, n) => `${n + 1}. **${plain(i.title)}** — ${plain(i.text)}`).join('\n') + '\n';
      case 'columns':
        return (b.columns || []).map(c =>
          `**${plain(c.title)}**\n` + (c.items || []).map(i => `- ${plain(i)}`).join('\n')).join('\n\n') + '\n';
      case 'tabs':
        return (b.tabs || []).map(t =>
          `#### ${plain(t.label)}\n${t.heading ? plain(t.heading) + '\n' : ''}`
          + (t.columns || []).map(c =>
            `**${plain(c.title)}**\n` + (c.items || []).map(i => `- ${plain(i)}`).join('\n')).join('\n\n')
        ).join('\n\n') + '\n';
      case 'table': {
        const head = (b.head || []).map(plain);
        const rows = (b.rows || []).map(r => r.map(plain));
        if (!head.length && !rows.length) return '';
        return `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n`
          + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';
      }
      case 'fees':
        return (b.items || []).map(f =>
          `- **${plain(f.name)}** — ${plain(f.amount)}${f.unit ? ' ' + plain(f.unit) : ''}`
          + (f.sub ? ` (${plain(f.sub)})` : '')
          + ((f.includes || []).length ? `\n  Includes: ${(f.includes).map(plain).join(', ')}` : '')
        ).join('\n') + (b.note ? `\n\n${plain(b.note)}\n` : '\n');
      case 'media':
        return (b.items || []).filter(m => m.title || m.text).map(m =>
          `- ${m.kind === 'video' ? '🎬' : '🖼'} **${plain(m.title)}**`
          + (m.date ? ` (${plain(m.date)})` : '') + (m.text ? ` — ${plain(m.text)}` : '')).join('\n') + '\n';
      case 'faq':
        return (b.items || []).map(f => `**Q: ${plain(f.q)}**\nA: ${plain(f.a)}`).join('\n\n') + '\n';
      case 'reviews':
        return (b.items || []).map(r => `- ${plain(r.name)}${r.meta ? ` (${plain(r.meta)})` : ''}: ${plain(r.text)}`).join('\n') + '\n';
      case 'offices':
        return (b.items || []).map(o =>
          `- **${plain(o.name)}** — ${plain(o.address)}`
          + (o.phones?.length ? ` · Phone: ${o.phones.join(', ')}` : '')).join('\n') + '\n';
      case 'contactCards':
        return (b.items || []).map(c => `- **${plain(c.title)}** — ${plain(c.text)}`).join('\n') + '\n';
      default: return '';
    }
  };

  for (const sec of site.sections || []) {
    if (sec.visible === false) continue;
    out.push(`## ${plain((sec.blocks || []).find(b => b.type === 'heading')?.text) || sec.id}`);
    out.push(`Anchor: ${origin}/#${sec.id}`, '');
    for (const b of sec.blocks || []) {
      if (b.type === 'heading' && b.level <= 2) continue;   // already the section title
      const t = line(b);
      if (t.trim()) out.push(t);
    }
    out.push('');
  }

  out.push('## Registration', `Application form: ${origin}/register.html`, '');
  if (extra) out.push('## Additional information', '', extra.trim(), '');

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
