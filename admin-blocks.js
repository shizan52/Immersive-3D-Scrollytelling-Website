/* eslint-env browser */
/* global $, $$, el, S, api, toast, modal, closeModal, confirmBox, clone, uid, touch,
          render, refreshPreview */

/* ═══════════════════════════════════════════════════════════════════════
   Editors — one per tab, plus the block library that powers the page builder.

   Everything writes straight into S.content and calls touch(), which autosaves
   the draft and refreshes the preview. Nothing here talks to site.json directly.
   ═══════════════════════════════════════════════════════════════════════ */

/* ---------------------------------------------------------------- pieces */

/** Labelled text input bound to obj[key]. */
function field(label, obj, key, { area = false, ph = '', hint = '', oninput } = {}) {
  const node = area
    ? el('textarea', { class: 'in', placeholder: ph })
    : el('input', { class: 'in', type: 'text', placeholder: ph });
  node.value = obj[key] ?? '';
  node.addEventListener('input', () => {
    obj[key] = node.value;
    oninput?.(node.value);
    touch();
  });
  return el('div', {}, [
    el('label', { class: 'lbl', text: label }),
    node,
    hint ? el('p', { class: 'small dim', style: { marginTop: '.2rem' }, text: hint }) : null,
  ]);
}

function selectField(label, obj, key, options, fallback, onChange) {
  const sel = el('select', { class: 'in' });
  options.forEach(([v, l]) => sel.append(el('option', { value: v, text: l })));
  sel.value = String(obj[key] ?? fallback);
  sel.addEventListener('change', () => {
    // A <select> value is always a string. Storing "false" where the renderer expects a
    // boolean makes every option truthy, so a "no" reads as a "yes".
    const original = options.find(([v]) => String(v) === sel.value)?.[0];
    obj[key] = typeof original === 'boolean' || typeof original === 'number' ? original : sel.value;
    touch();
    onChange?.(obj[key]);
  });
  return el('div', {}, [el('label', { class: 'lbl', text: label }), sel]);
}

function numberField(label, obj, key, { min = 0, max = 100, step = 1, suffix = '' } = {}) {
  const n = el('input', { class: 'in', type: 'number', min, max, step });
  n.value = obj[key] ?? '';
  n.addEventListener('input', () => {
    obj[key] = n.value === '' ? undefined : Number(n.value);
    touch();
  });
  return el('div', {}, [el('label', { class: 'lbl', text: label + suffix }), n]);
}

/** Brand-aware colour picker. Theme tokens keep day/night working automatically. */
const TOKENS = [
  ['', 'Default'],
  ['var(--fg)', 'Main text'],
  ['var(--muted)', 'Muted text'],
  ['var(--accent)', 'Brand pink'],
  ['var(--accent-2)', 'Brand blue'],
  ['var(--gold)', 'Gold'],
];

function colorField(label, obj, key) {
  const wrap = el('div', { class: 'swatches' });
  const paint = () => $$('.sw', wrap).forEach(b =>
    b.classList.toggle('on', (obj[key] ?? '') === b.dataset.v));

  TOKENS.forEach(([v, title]) => {
    const b = el('button', {
      class: 'sw' + (v ? '' : ' sw--none'), type: 'button', title,
      'data-v': v, style: v ? { background: v } : {},
      onclick: () => { obj[key] = v || undefined; paint(); touch(); },
    });
    if (!v) b.textContent = '✕';
    wrap.append(b);
  });

  const custom = el('input', {
    type: 'color', title: 'Custom colour',
    onchange: (e) => { obj[key] = e.target.value; paint(); touch(); },
  });
  if (/^#/.test(obj[key] || '')) custom.value = obj[key];
  wrap.append(custom);
  paint();
  return el('div', {}, [el('label', { class: 'lbl', text: label }), wrap]);
}

const ANIMS = [['fade-up', '↑ from below'], ['fade', 'Fade in slowly'], ['fade-down', '↓ from above'],
  ['zoom', 'Zoom'], ['slide-left', '← from the left'], ['slide-right', '→ from the right'], ['none', 'None']];

/* Keep in step with BUTTON_TARGETS in render.mjs. */
const BUTTON_TARGETS = {
  register: ['Register now', '/register.html'],
  consult: ['Free consultation', '#contact'],
  contact: ['Get in touch', '#contact'],
  workVisa: ['See work visas', '#work-visa'],
  studentVisa: ['See student visa', '#student-visa'],
  process: ['See the process', '#process'],
  offices: ['See our offices', '#offices'],
  reviews: ['Student experiences', '#reviews'],
  whatsapp: ['Message on WhatsApp', 'https://wa.me/8801689447591'],
  call: ['Call now', 'tel:+8801689447591'],
  email: ['Send an email', 'mailto:bdeducationcentre748@gmail.com'],
};

/**
 * One button, chosen from a preset.
 *
 * Picking "Register now" fills in both the wording and the link, so nobody has to know
 * that the page is at /register.html. The two text boxes stay editable underneath —
 * anything typed there wins — and "custom" gives a blank slate.
 */
function buttonEditor(x, onChange) {
  const wrap = el('div', { style: { display: 'grid', gap: '.5rem' } });

  const draw = () => {
    wrap.textContent = '';
    const preset = el('select', { class: 'in' });
    preset.append(el('option', { value: '', text: '— Write my own —' }));
    for (const [k, [label]] of Object.entries(BUTTON_TARGETS)) {
      preset.append(el('option', { value: k, text: label }));
    }
    preset.value = x.target || '';
    preset.addEventListener('change', () => {
      x.target = preset.value || undefined;
      // Adopt the preset's wording unless the owner already wrote their own.
      const p = BUTTON_TARGETS[preset.value];
      if (p) { x.label = undefined; x.href = undefined; }
      draw(); touch();
    });

    const p = BUTTON_TARGETS[x.target];
    const labelIn = el('input', { class: 'in', type: 'text', placeholder: p ? p[0] : 'Button text' });
    labelIn.value = x.label ?? '';
    labelIn.addEventListener('input', () => { x.label = labelIn.value || undefined; touch(); });

    const hrefIn = el('input', { class: 'in', type: 'text', placeholder: p ? p[1] : '#contact' });
    hrefIn.value = x.href ?? '';
    hrefIn.addEventListener('input', () => { x.href = hrefIn.value || undefined; touch(); });

    wrap.append(
      el('div', {}, [el('label', { class: 'lbl', text: 'Where it goes' }), preset]),
      el('div', { class: 'grid2' }, [
        el('div', {}, [el('label', { class: 'lbl', text: 'Text' }), labelIn]),
        el('div', {}, [el('label', { class: 'lbl', text: 'Link' }), hrefIn]),
      ]),
      selectField('Style', x, 'style', [['primary', '▮ Filled'], ['ghost', '▯ Outline']], 'primary'),
      p ? el('p', { class: 'small dim', text: `Preset: "${p[0]}" → ${p[1]}` }) : null,
    );
    onChange?.();
  };

  draw();
  return wrap;
}
// Keep in step with MAX_VIDEO_MB in admin.py — the panel refuses oversized clips before
// spending minutes of a phone connection uploading one.
const MAX_VIDEO_MB = 40;

const FRAMES = [['none', 'No frame'], ['soft', 'Soft shadow'], ['bordered', 'Bordered'],
  ['shadow', 'Deep shadow'], ['polaroid', 'Polaroid'], ['circle', 'Circle']];
const ALIGNS = [['', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']];

/** The shared look-and-feel drawer every block gets. */
function styler(b, { animation = true, align = true, color = true, bg = false, width = false } = {}) {
  const grid = el('div', { class: 'styler__grid' }, [
    animation ? selectField('Animation', b, 'animation', ANIMS, 'fade-up') : null,
    align ? selectField('Position', b, 'align', ALIGNS, '') : null,
    width ? numberField('Max width', b, 'maxWidth', { min: 10, max: 80, suffix: ' (rem)' }) : null,
  ].filter(Boolean));
  return el('details', { class: 'styler' }, [
    el('summary', { class: 'small muted', style: { cursor: 'pointer' }, text: '🎨 Appearance' }),
    grid,
    color ? colorField('Text colour', b, 'color') : null,
    bg ? colorField('Background colour', b, 'bg') : null,
  ].filter(Boolean));
}

/** Reorder / delete controls shared by sections and blocks. */
function moveBar(list, i, onChange, extra = [], onRemove) {
  const mk = (label, title, run, disabled) =>
    el('button', { class: 'btn icon ghost sm', text: label, title, disabled, onclick: (e) => { e.stopPropagation(); run(); } });
  return el('div', { class: 'row', style: { gap: '.15rem' } }, [
    ...extra,
    mk('↑', 'Move up', () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; onChange(); }, i === 0),
    mk('↓', 'Move down', () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; onChange(); }, i === list.length - 1),
    mk('⧉', 'Duplicate', () => { list.splice(i + 1, 0, clone(list[i])); onChange(); }),
    el('button', {
      class: 'btn icon danger sm', text: '🗑', title: 'Delete',
      onclick: async (e) => {
        e.stopPropagation();
        const warn = onRemove
          ? 'The post will be deleted, and its photo/video will be removed from the server immediately.'
          : 'This cannot be undone (though pressing "Discard" before publishing will restore it).';
        if (!await confirmBox('Delete this?', warn, 'Delete')) return;
        const [gone] = list.splice(i, 1);
        onChange();
        // After the removal is saved, so the server sees the file is genuinely unused.
        onRemove?.(gone);
      },
    }),
  ]);
}

/* ═════════════════════════════════════════════════════════ block library */

const BLOCK_KINDS = [
  ['heading', '🔠 Heading'],
  ['text', '¶ Paragraph'],
  ['eyebrow', '▸ Small label'],
  ['image', '🖼 Image'],
  ['imageText', '🖼¶ Image + text'],
  ['cards', '▦ Cards'],
  ['reviews', '⭐ Reviews'],
  ['fees', '💰 Course fees'],
  ['media', '📸 Photo & video posts'],
  ['faq', '❓ FAQ'],
  ['columns', '☰ List columns'],
  ['steps', '① Steps'],
  ['table', '▤ Table'],
  ['tabs', '⧉ Tabs'],
  ['offices', '📍 Offices'],
  ['contactCards', '☎ Contact cards'],
  ['buttons', '⬒ Buttons'],
  ['quote', '❝ Quote'],
  ['divider', '— Divider'],
  ['spacer', '␣ Empty space'],
];

function newBlock(type) {
  const base = { type, animation: 'fade-up' };
  const seed = {
    heading: { level: 2, text: 'New heading' },
    text: { text: 'Your text here…' },
    eyebrow: { text: 'Small label' },
    image: { src: '', alt: '', caption: '', frame: 'soft', align: 'center' },
    imageText: { src: '', alt: '', side: 'left', heading: 'Heading', text: 'Description…', frame: 'soft' },
    cards: { items: [{ mark: '★', title: 'Card', text: 'Description…' }] },
    reviews: { columns: 4, items: [{ name: 'Student name', meta: 'Visa · City', rating: 5, text: 'Experience…' }] },
    faq: { items: [{ q: 'Enter a question?', a: 'Enter an answer…' }] },
    fees: { items: [{ name: 'Course name', amount: '00,000', unit: 'BDT', includes: ['What is included'], featured: false }] },
    media: { columns: 3, frame: 'soft', items: [{ kind: 'image', src: '', title: '', text: '', date: '' }] },
    buttons: { items: [{ target: 'register', style: 'primary' }] },
    columns: { columns: [{ title: 'Column', accent: 'accent', items: ['First point'] }] },
    steps: { items: [{ title: 'Step 1', text: 'Description…' }] },
    table: { caption: '', head: ['Column 1', 'Column 2'], rows: [['Row', 'Value']] },
    tabs: { label: 'Tab', tabs: [{ id: uid(), label: 'Tab 1', heading: '', columns: [{ title: 'Heading', accent: 'accent', items: ['Point'] }] }] },
    offices: { items: [{ flag: '🇧🇩', name: 'Office', address: 'Address', phones: [] }] },
    contactCards: { items: [{ title: 'Heading', text: 'Description', label: 'Button', href: '#', style: 'ghost' }] },
    buttons: { items: [{ label: 'Button', href: '#', style: 'primary' }] },
    quote: { text: 'Quote…', cite: '' },
    divider: {},
    spacer: { size: 2 },
  }[type] || {};
  return { ...base, ...seed };
}

const peek = (b) => {
  const t = b.text || b.heading || b.caption || b.label || b.title || '';
  if (t) return String(t).replace(/<[^>]+>/g, '').slice(0, 60);
  if (b.items) return `${b.items.length} items`;
  if (b.columns) return `${b.columns.length} columns`;
  if (b.tabs) return `${b.tabs.length} tabs`;
  if (b.rows) return `${b.rows.length} rows`;
  if (b.src) return b.src.split('/').pop();
  return '';
};

/* ------------------------------------------------------------ list editor */

/** Editable string list (checklist items, phone numbers, …). */
function stringList(arr, onChange, { ph = '', rich = true } = {}) {
  const wrap = el('div', { style: { display: 'grid', gap: '.35rem' } });
  const draw = () => {
    wrap.textContent = '';
    arr.forEach((v, i) => {
      const inp = el('input', { class: 'in', type: 'text', placeholder: ph });
      inp.value = v;
      inp.addEventListener('input', () => { arr[i] = inp.value; touch(); });
      wrap.append(el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, [
        inp,
        el('button', { class: 'btn icon ghost sm', text: '↑', disabled: i === 0,
          onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; draw(); touch(); } }),
        el('button', { class: 'btn icon ghost sm', text: '↓', disabled: i === arr.length - 1,
          onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; draw(); touch(); } }),
        el('button', { class: 'btn icon danger sm', text: '🗑',
          onclick: () => { arr.splice(i, 1); draw(); touch(); } }),
      ]));
    });
    wrap.append(el('button', {
      class: 'btn sm ghost', text: '+ Item',
      onclick: () => { arr.push(''); draw(); touch(); },
    }));
    if (rich) wrap.append(el('p', { class: 'small dim', text: '<strong>Bold</strong> and <br> can be used.' }));
  };
  draw();
  return wrap;
}

/** Repeating object editor — cards, steps, offices, contact cards, buttons. */
function objectList(arr, fieldsFor, opts) {
  // Older callers pass a bare callback here; newer ones pass options.
  const { onStructureChange, max = Infinity, onRemove, blank } =
    typeof opts === 'function' ? { onStructureChange: opts } : (opts || {});

  const wrap = el('div', { style: { display: 'grid', gap: '.5rem' } });
  const draw = () => {
    wrap.textContent = '';
    arr.forEach((item, i) => {
      wrap.append(el('div', { class: 'sub' }, [
        el('div', { class: 'sub__bar' }, [
          el('strong', { text: `#${i + 1}` }),
          el('span', { class: 'spacer', style: { flex: 1 } }),
          moveBar(arr, i, () => { draw(); touch(); }, [], onRemove),
        ]),
        ...fieldsFor(item, i),
      ]));
    });
    if (arr.length < max) {
      wrap.append(el('button', {
        class: 'btn sm', text: '+ Add',
        onclick: () => {
          // A duplicate of the last entry is a good starting point for a table row, but a
          // terrible one for a post — it would clone the photo and two cards would share
          // one file, so deleting either would break the other.
          arr.push(blank ? blank() : clone(arr[arr.length - 1] || {}));
          draw(); touch();
        },
      }));
    } else {
      wrap.append(el('p', { class: 'small dim', text: `Maximum ${max} — no more can be added.` }));
    }
    onStructureChange?.();
  };
  draw();
  return wrap;
}

/* ═══════════════════════════════════════════════════════ block editors */

function blockEditor(b) {
  const body = el('div', { class: 'blk__body' });
  const add = (...n) => body.append(...n.filter(Boolean));

  switch (b.type) {
    case 'heading':
      add(field('Text', b, 'text'),
        selectField('Size', b, 'level', [[2, 'Large (H2)'], [3, 'Medium (H3)'], [4, 'Small (H4)']], 2),
        styler(b));
      break;

    case 'text':
      add(field('Text', b, 'text', { area: true, hint: '<strong>Bold</strong>, <em>italic</em>, <br> work' }),
        selectField('Style', b, 'style', [['', 'Normal'], ['lead', 'Large (lead)']], ''),
        styler(b));
      break;

    case 'eyebrow':
      add(field('Text', b, 'text'), styler(b, { align: false }));
      break;

    case 'image':
      add(imagePicker(b), field('Alt text', b, 'alt', { hint: 'Read by screen readers, or shown if the image fails to load' }),
        field('Caption below the image', b, 'caption'),
        el('div', { class: 'grid2' }, [
          selectField('Frame', b, 'frame', FRAMES, 'soft'),
          selectField('Position', b, 'align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], 'center'),
        ]),
        numberField('Max width', b, 'maxWidth', { min: 8, max: 70, suffix: ' (rem)' }),
        styler(b, { align: false, color: false }));
      break;

    case 'imageText':
      add(imagePicker(b),
        el('div', { class: 'grid2' }, [
          selectField('Image side', b, 'side', [['left', 'Left'], ['right', 'Right']], 'left'),
          selectField('Frame', b, 'frame', FRAMES, 'soft'),
        ]),
        field('Alt text', b, 'alt'),
        field('Heading', b, 'heading'),
        field('Description', b, 'text', { area: true }),
        styler(b, { align: false }));
      break;

    case 'cards':
      add(el('p', { class: 'small dim', text: 'Each card gets a mark/image, a heading, and a description.' }),
        objectList(b.items, (it) => [
          el('div', { class: 'grid2' }, [field('Mark (one character/emoji)', it, 'mark'), field('Mark language', it, 'markLang', { ph: 'ja' })]),
          field('Heading', it, 'title'),
          field('Description', it, 'text', { area: true }),
          imagePicker(it, 'Card image (optional)'),
        ]),
        styler(b, { align: false, color: false }));
      break;

    case 'columns':
      add(objectList(b.columns, (c) => [
        field('Column heading', c, 'title'),
        selectField('Bullet colour', c, 'accent', [['accent', 'Pink'], ['gold', 'Gold']], 'accent'),
        el('div', {}, [el('label', { class: 'lbl', text: 'Points' }), stringList(c.items, null)]),
        field('Note below (optional)', c, 'note', { area: true }),
      ]), styler(b, { align: false, color: false }));
      break;

    case 'steps':
      add(objectList(b.items, (it) => [field('Heading', it, 'title'), field('Description', it, 'text', { area: true })]),
        styler(b, { align: false, color: false }));
      break;

    case 'table':
      add(field('Table caption', b, 'caption'), tableEditor(b), styler(b, { align: false, color: false }));
      break;

    case 'tabs':
      add(field('Tab group name (for screen readers)', b, 'label'),
        objectList(b.tabs, (t) => [
          field('Tab label', t, 'label'),
          field('Inner heading', t, 'heading'),
          el('div', {}, [el('label', { class: 'lbl', text: 'Columns' }),
            objectList(t.columns || (t.columns = []), (c) => [
              field('Column heading', c, 'title'),
              selectField('Bullet colour', c, 'accent', [['accent', 'Pink'], ['gold', 'Gold']], 'accent'),
              el('div', {}, [el('label', { class: 'lbl', text: 'Points' }), stringList(c.items || (c.items = []), null)]),
            ])]),
        ]),
        styler(b, { align: false, color: false }));
      break;

    case 'offices':
      add(objectList(b.items, (o) => [
        el('div', { class: 'grid2' }, [field('Flag', o, 'flag'), field('Name', o, 'name')]),
        field('Address', o, 'address', { area: true, hint: 'Use <br> to break lines' }),
        el('div', {}, [el('label', { class: 'lbl', text: 'Phone numbers' }),
          stringList(o.phones || (o.phones = []), null, { ph: '+88 01XXXXXXXXX', rich: false })]),
        // Google Business / Maps needs the city and country as separate fields, not buried
        // in the address text. Filling these is what makes the office show up in
        // "Japan consultancy near me" style local searches.
        el('details', { class: 'sub' }, [
          el('summary', { text: '🔍 Local search info (for Google Maps / search)' }),
          el('div', { class: 'grid2' }, [
            field('City', o, 'city', { ph: 'Barishal' }),
            field('Region / division', o, 'region', { ph: 'Barishal Division' }),
          ]),
          el('div', { class: 'grid2' }, [
            field('Postal code', o, 'postal', { ph: '8200' }),
            selectField('Country', o, 'country', [['BD', 'Bangladesh'], ['JP', 'Japan']], 'BD'),
          ]),
        ]),
      ]), styler(b, { align: false, color: false }));
      break;

    case 'contactCards':
      add(objectList(b.items, (c) => [
        field('Heading', c, 'title'), field('Description', c, 'text'),
        el('div', { class: 'grid2' }, [field('Button text', c, 'label'), field('Link', c, 'href')]),
        selectField('Button style', c, 'style', [['primary', 'Filled'], ['ghost', 'Outline']], 'ghost'),
      ]), styler(b, { align: false, color: false }));
      break;

    case 'buttons':
      add(objectList(b.items, (x) => [buttonEditor(x)]), styler(b, { color: false }));
      break;

    case 'reviews':
      add(
        el('p', { class: 'small dim' }, [
          document.createTextNode('Choose how many show side by side on a large screen below. '),
          el('strong', { text: '3 on laptop, 2 on tablet, 1 on mobile' }),
          document.createTextNode(' — the rest can be swiped into view. This happens automatically.'),
        ]),
        selectField('Side by side on large screens', b, 'columns', [[4, '4'], [3, '3'], [2, '2']], 4),
        objectList(b.items, (r) => [
          el('div', { class: 'grid2' }, [
            field('Student name', r, 'name'),
            field('Identity', r, 'meta', { ph: 'SSW Visa · Osaka' }),
          ]),
          field('Experience', r, 'text', { area: true, hint: 'Shows up to 8 lines on the card if long' }),
          selectField('Rating', r, 'rating', [[5, '★★★★★'], [4, '★★★★'], [3, '★★★'], [0, 'Hidden']], 5),
          imagePicker(r, 'Photo (shows the first letter of the name if not given)'),
        ]),
        styler(b, { align: false, color: false }));
      break;

    case 'fees':
      add(
        el('p', { class: 'small dim',
          text: 'One card per course. Sits side by side on large screens, stacked '
              + 'on mobile — automatically.' }),
        objectList(b.items, (f) => [
          el('div', { class: 'grid2' }, [
            field('Course name', f, 'name', { ph: 'Japanese Language — N5' }),
            field('Short description', f, 'sub', { ph: '4 months · 3 days a week' }),
          ]),
          el('div', { class: 'grid2' }, [
            field('Fee', f, 'amount', { ph: '12,000' }),
            field('Unit', f, 'unit', { ph: 'BDT / course' }),
          ]),
          el('div', {}, [
            el('label', { class: 'lbl', text: 'What is included (one per line)' }),
            stringList(f.includes || (f.includes = []), null, { ph: '3 classes a week' }),
          ]),
          field('Short note', f, 'note', { area: true, hint: 'e.g. — admission fee is separate' }),
          el('div', { class: 'grid2' }, [
            field('Badge on top', f, 'badge', { ph: 'Popular' }),
            selectField('Highlight this one?', f, 'featured', [[false, 'No'], [true, 'Yes — highlighted']], false),
          ]),
          el('details', { class: 'sub' }, [
            el('summary', { text: '🔘 Card button (leave blank if not needed)' }),
            buttonEditor({
              get target() { return f.buttonTarget; }, set target(v) { f.buttonTarget = v; },
              get label() { return f.buttonLabel; }, set label(v) { f.buttonLabel = v; },
              get href() { return f.buttonHref; }, set href(v) { f.buttonHref = v; },
              get style() { return f.buttonStyle; }, set style(v) { f.buttonStyle = v; },
            }),
          ]),
        ]),
        field('Line below all cards', b, 'note', { area: true, hint: 'e.g. — all fees are non-refundable' }),
        styler(b, { align: false, color: false }));
      break;

    case 'media':
      add(
        el('p', { class: 'small dim' }, [
          document.createTextNode('Like a Facebook post — a photo or video, with text. '),
          el('strong', { text: 'Maximum 6' }),
          document.createTextNode('. Shows one at a time on mobile, swipe right for the next. '),
          el('strong', { text: 'Deleting a post removes its file from the server immediately.' }),
        ]),
        selectField('Side by side on large screens', b, 'columns', [[4, '4'], [3, '3'], [2, '2']], 3),
        selectField('Image frame', b, 'frame', FRAMES, 'soft'),
        objectList(b.items, (m) => mediaPostEditor(m), {
          max: 6,
          blank: () => ({ kind: 'image', image: '', title: '', text: '', date: '' }),
          onRemove: (m) => forgetMedia(m.image, m.video, m.poster, m.src),
        }),
        styler(b, { align: false, color: false }));
      break;

    case 'faq':
      add(
        el('p', { class: 'small dim' }, [
          document.createTextNode('These questions and answers are also sent to Google separately '),
          el('strong', { text: '(FAQ structured data)' }),
          document.createTextNode(' — so the answer may show directly in search results. '
            + 'Write real questions and clear answers; the answer should match exactly what is on the page.'),
        ]),
        objectList(b.items, (f) => [
          field('Question', f, 'q', { ph: 'Can I work on a student visa in Japan?' }),
          field('Answer', f, 'a', { area: true, hint: 'Answer directly in 2–4 sentences' }),
        ]),
        styler(b, { align: false, color: false }));
      break;

    case 'quote':
      add(field('Quote', b, 'text', { area: true }), field('Attributed to', b, 'cite'), styler(b));
      break;

    case 'spacer':
      add(numberField('Height', b, 'size', { min: 1, max: 12, step: 0.5, suffix: ' (rem)' }));
      break;

    case 'divider':
      add(el('p', { class: 'small dim', text: 'A thin horizontal line.' }));
      break;

    default:
      add(el('p', { class: 'small dim', text: 'No dedicated editor for this block.' }));
  }
  return body;
}

/**
 * One post — a photo or a clip, with its caption.
 *
 * The photo lives in `image` and the clip in `video`, deliberately separate. They used to
 * share one `src`, and switching the type wiped it — so anyone who uploaded a picture and
 * then looked at what "video" did lost the upload without being told. Now the two are
 * remembered independently and switching back and forth costs nothing; a file only ever
 * goes when it is explicitly removed, or the whole post is deleted.
 */
function mediaPostEditor(m) {
  m.kind = m.kind === 'video' ? 'video' : 'image';
  // Older posts stored a single `src`. Move it to whichever field its type implies.
  if (m.src && !m.image && !m.video) {
    if (m.kind === 'video') m.video = m.src; else m.image = m.src;
    delete m.src;
  }

  const box = el('div', { style: { display: 'grid', gap: '.55rem' } });

  const draw = () => {
    box.textContent = '';
    box.append(selectField('Kind', m, 'kind',
      [['image', '🖼 Image'], ['video', '🎬 Video (with sound)']], 'image', () => { draw(); touch(); }));

    if (m.kind === 'video') {
      box.append(
        videoPicker(m, 'video'),
        imagePicker(m, 'Video cover image (uses the first frame if not given)', 'poster'),
        el('div', { class: 'grid2' }, [
          selectField('Sound at start', m, 'muted', [[false, '🔊 On'], [true, '🔇 Off']], false),
          selectField('Loop?', m, 'loop', [[false, 'No'], [true, 'Yes']], false),
        ]),
        el('p', { class: 'small dim',
          text: 'Video does not autoplay — it only plays when a visitor taps it, so opening the page makes no sound. '
              + 'Playing one automatically pauses the others.' }),
      );
    } else {
      box.append(imagePicker(m, 'Image', 'image'), field('Image alt text', m, 'alt',
        { hint: "What's in the picture — for people who can't see it" }));
    }

    // Whatever is not showing is still safely kept, and saying so stops it feeling lost.
    const spare = m.kind === 'video' ? m.image : m.video;
    if (spare) {
      box.append(el('p', { class: 'small dim' }, [
        document.createTextNode(m.kind === 'video'
          ? "🖼 This post's image is still kept — set \"Kind\" back to image to get it back."
          : "🎬 This post's video is still kept — set \"Kind\" to video to get it back."),
      ]));
    }

    box.append(
      field('Heading', m, 'title', { ph: 'New Batch Classes Begin' }),
      field('Text', m, 'text', { area: true, hint: 'Shows up to 3 lines on the card' }),
      el('div', { class: 'grid2' }, [
        field('Date', m, 'date', { ph: '12 August 2026' }),
        field('Short tag', m, 'tag', { ph: 'Class' }),
      ]),
      field('Link (optional)', m, 'href', {
        ph: 'https://facebook.com/…',
        hint: m.kind === 'video'
          ? 'Shows a "See more →" link on the video — a full-card link would block the play button'
          : 'If given, tapping anywhere on the card goes there',
      }),
      selectField('This post\'s frame', m, 'frame', [['', 'Same as section'], ...FRAMES], ''),
    );
  };

  draw();
  return [box];
}

/**
 * Tell the server a file is finished with.
 *
 * The orphan sweep will not touch anything recent — it exists to stop a publish deleting
 * a picture the owner has only just chosen. But deleting a post is an explicit
 * instruction, so the file goes now rather than in six hours. The server still refuses
 * if anything else is using it.
 */
async function forgetMedia(...srcs) {
  const wanted = srcs.filter(s => typeof s === 'string' && s.startsWith('/uploads/'));
  if (!wanted.length) return;
  // Save first: the server checks the draft before deleting, so it has to see the removal.
  try {
    await api('/api/content', { method: 'PUT', body: JSON.stringify({ content: S.content }) });
    const r = await api('/api/media/forget', { method: 'POST', body: JSON.stringify({ srcs: wanted }) });
    if (r.removed?.length) toast(`Removed from server (${r.removed.length} file(s))`, 'ok');
    if (r.kept?.length) toast('This file is used elsewhere, so it was kept');
  } catch (err) {
    toast('Could not delete file: ' + err.message, 'err');
  }
}

/* ------------------------------------------------------------- pickers */

/**
 * Open the OS file picker the way every browser agrees on.
 *
 * The old version was a <div> that called `input.click()` on an input styled
 * `display:none`. That works in desktop Chrome and is unreliable on phones — Safari and
 * several Android browsers refuse to open a chooser for an element that is not rendered,
 * silently. Tapping did nothing, which is exactly what "I try to upload and it does not
 * work" looks like.
 *
 * A <label> pointing at the input is the native mechanism: no JavaScript, no exceptions.
 * The input stays in the layout but clipped, because `display:none` is the very thing
 * that breaks it.
 */
function filePicker({ id, accept, text, onFile }) {
  const input = el('input', { type: 'file', accept, id, class: 'file-input' });
  const label = el('label', { class: 'drop', for: id, text });
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (f) onFile(f);
    input.value = '';        // so choosing the same file twice still fires
  });
  ['dragenter', 'dragover'].forEach(ev => label.addEventListener(ev, (e) => {
    e.preventDefault(); label.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => label.addEventListener(ev, () => label.classList.remove('over')));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
  return { input, label };
}

/** A failure the owner cannot scroll past, unlike a toast that has already faded. */
function pickerError(msg) {
  return el('p', { class: 'picker-err' }, [
    el('strong', { text: '⚠ ' }), document.createTextNode(msg),
  ]);
}

function imagePicker(obj, label = 'Image', key = 'src') {
  const box = el('div', { style: { display: 'grid', gap: '.45rem' } });

  const draw = () => {
    box.textContent = '';
    box.append(el('label', { class: 'lbl', text: label }));

    if (obj[key]) {
      box.append(el('div', { class: 'thumb' }, [
        el('img', { src: obj[key], alt: '' }),
        el('button', {
          class: 'btn sm danger thumb__x', text: '✕ Remove',
          onclick: () => {
            const dropped = obj[key];
            obj[key] = '';
            if (key === 'src') { delete obj.width; delete obj.height; }
            draw(); touch();
            // Nothing points at it any more, so it should not sit on the server either.
            forgetMedia(dropped);
          },
        }),
      ]));
    }

    const upload = async (file) => {
      if (!file) return;
      dropLabel.textContent = `Uploading… (${(file.size / 1048576).toFixed(1)} MB)`;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await api('/api/upload', { method: 'POST', body: fd });
        obj[key] = r.src;
        if (key === 'src' || key === 'image') { obj.width = r.width; obj.height = r.height; }
        toast(`Uploaded — ${(r.original / 1024).toFixed(0)} KB down to ${(r.bytes / 1024).toFixed(0)} KB`, 'ok');
        draw(); touch();
      } catch (err) {
        draw();
        // Inline, not just a toast: on a phone the toast is easy to miss entirely, and
        // "nothing happened" is the worst possible failure message.
        box.append(pickerError(err.message || 'Could not upload'));
      }
    };

    // `image/*` alone hides HEIC in some Android file pickers, so the extensions are
    // named too. The server explains clearly if a HEIC cannot be read.
    // Named dropLabel, not label — `label` is this function's own parameter.
    const { input, label: dropLabel } = filePicker({
      id: 'pick-' + uid(),
      accept: 'image/*,.jpg,.jpeg,.png,.webp,.heic,.heif',
      text: obj[key] ? '↻ Choose another image' : '⬆ Choose an image (or drag one here)',
      onFile: upload,
    });

    box.append(dropLabel, input);
  };

  draw();
  return box;
}

function tableEditor(b) {
  const wrap = el('div');
  const draw = () => {
    wrap.textContent = '';
    const tbl = el('table', { class: 'tbl' });

    const hrow = el('tr');
    b.head.forEach((h, c) => {
      const i = el('input', { type: 'text' });
      i.value = h;
      i.addEventListener('input', () => { b.head[c] = i.value; touch(); });
      hrow.append(el('th', {}, [i]));
    });
    hrow.append(el('th', { style: { width: '2rem' } }));
    tbl.append(el('thead', {}, [hrow]));

    const body = el('tbody');
    b.rows.forEach((row, r) => {
      const tr = el('tr');
      b.head.forEach((_, c) => {
        const i = el('input', { type: 'text' });
        i.value = row[c] ?? '';
        i.addEventListener('input', () => { row[c] = i.value; touch(); });
        tr.append(el('td', {}, [i]));
      });
      tr.append(el('td', {}, [el('button', {
        class: 'btn icon danger sm', text: '🗑',
        onclick: () => { b.rows.splice(r, 1); draw(); touch(); },
      })]));
      body.append(tr);
    });
    tbl.append(body);

    wrap.append(el('div', { class: 'tblwrap' }, [tbl]), el('div', { class: 'row', style: { marginTop: '.4rem' } }, [
      el('button', { class: 'btn sm', text: '+ Row', onclick: () => { b.rows.push(b.head.map(() => '')); draw(); touch(); } }),
      el('button', { class: 'btn sm', text: '+ Column', onclick: () => { b.head.push('Column'); b.rows.forEach(r => r.push('')); draw(); touch(); } }),
      el('button', { class: 'btn sm danger', text: '− Column', disabled: b.head.length <= 2,
        onclick: () => { b.head.pop(); b.rows.forEach(r => r.pop()); draw(); touch(); } }),
    ]));
  };
  draw();
  return wrap;
}

/* ═════════════════════════════════════════════════════════ tab: pages */

/* ═══════════════════════════════════════ the whole page, in one place */

/**
 * The public site, described top to bottom the way it is SEEN rather than the way it is
 * stored.
 *
 * These six things used to live across four separate tabs — "Page content", "Hero",
 * "Brand & SEO", "Footer & menu" — and you had to already know which tab owned which
 * part of the screen before you could change anything. Now they are one list in page
 * order, each saying plainly where it appears, so the panel can be read instead of
 * learned.
 */
const PAGE_PARTS = [
  {
    id: 'brand', icon: '🏷', title: 'Brand & Logo',
    where: 'Very top of the page, left side',
    what: 'Logo or mark, business name, tagline, and the button on the upper right.',
    anchor: '#top', render: renderBrandBlock,
  },
  {
    id: 'nav', icon: '☰', title: 'Top Menu',
    where: 'At the top, next to the name',
    what: 'The links that jump to that part of the page when clicked.',
    anchor: '#top', render: renderNavBlock,
  },
  {
    id: 'hero', icon: '🏯', title: 'Hero — First Screen',
    where: 'The very first thing seen when the page opens',
    what: 'The text and buttons that float over the 3D Tokyo street. The street itself does not change.',
    anchor: '#hero', render: renderHeroBlock,
  },
  {
    id: 'sections', icon: '📄', title: 'Page Sections',
    where: 'Below the hero, spanning the whole page',
    what: "The site's main content — about us, reviews, visas, FAQ, offices, contact.",
    anchor: '#about', render: renderSectionsBlock,
  },
  {
    id: 'footer', icon: '🔻', title: 'Footer',
    where: 'Very bottom of the page',
    what: 'Address, contact info, and the copyright line.',
    anchor: '#contact', render: renderFooterBlock,
  },
  {
    id: 'seo', icon: '🔍', title: 'Search & Share (SEO)',
    where: 'Not on the page — on Google and Facebook',
    what: "The title and description Google's results show, and the image that appears when a link is shared.",
    render: renderSeoBlock,
  },
];

function renderSite(root) {
  root.append(el('p', { class: 'small dim', style: { margin: '0 0 .8rem' },
    text: "The list below is ordered the same way your page is — the top item is at the top, "
        + "the bottom item is at the bottom. Click whatever you want to change. You'll see it update in the preview on the right immediately." }));

  // A jump bar, so the page map is visible even when every card is closed.
  const bar = el('div', { class: 'map' });
  PAGE_PARTS.forEach((part) => {
    bar.append(el('button', {
      class: 'map__btn' + (S.open.has('part:' + part.id) ? ' on' : ''),
      title: part.where,
      onclick: () => openPart(part, true),
    }, [el('span', { text: part.icon }), document.createTextNode(' ' + part.title)]));
  });
  root.append(bar);

  PAGE_PARTS.forEach((part) => {
    const key = 'part:' + part.id;
    const open = S.open.has(key);
    const card = el('div', { class: 'sec part' + (open ? '' : ' closed') });

    card.append(el('div', {
      class: 'sec__head part__head',
      onclick: () => openPart(part),
    }, [
      el('span', { class: 'sec__chev', text: '▾' }),
      el('span', { class: 'part__icon', text: part.icon }),
      el('span', {}, [
        el('span', { class: 'sec__title', text: part.title }),
        el('span', { class: 'part__where', text: part.where }),
      ]),
    ]));

    if (open) {
      const body = el('div', { class: 'sec__body' });
      body.append(el('p', { class: 'part__what', text: part.what }));
      part.render(body);
      card.append(body);
      // First paint after login: the sections card is open by default, so aim the
      // preview at it too. Without this the editor showed the sections while the
      // preview sat on the hero, and it looked like they were not being rendered.
      if (previewAnchor === null && part.anchor) jumpPreview(part.anchor, part.title);
    }
    root.append(card);
  });
}

/**
 * Open one part at a time — an accordion, so the panel is never a wall of forms.
 *
 * `fromMap` matters: the map along the top is a list of DESTINATIONS, not a row of
 * toggles. Pressing "Page Sections" while it happens to be open used to collapse it
 * and leave the preview where it was, which read as "the sections never show up".
 * From the map it always opens and always takes the preview there; only the card's own
 * header collapses it.
 */
function openPart(part, fromMap = false) {
  const key = 'part:' + part.id;
  const wasOpen = S.open.has(key);
  PAGE_PARTS.forEach(p => S.open.delete('part:' + p.id));
  if (fromMap || !wasOpen) S.open.add(key);
  render();

  if (S.open.has(key)) {
    jumpPreview(part.anchor, part.title);
    if (fromMap) document.querySelector('.part:not(.closed)')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else {
    jumpPreview(null);
  }
}

/**
 * Point the live preview at whatever is being edited — and SAY which part it is.
 *
 * Scrolling alone was not enough. With eight sections that share a layout, landing on
 * one of them tells you nothing about whether it is the one you are typing into, so the
 * preview outlines the live section and labels it. The panel and the preview are then
 * answering the same question: "which bit is this?"
 *
 * The anchor is remembered, not fired once: the preview iframe reloads on every autosave,
 * and without that the editor would be showing the reviews while the preview snapped back
 * to the hero. `content-visibility` also means a section below the fold has no real
 * height until it renders, so one scrollIntoView lands short — hence the repeats.
 */
let previewAnchor = null;
let previewLabel = '';

// Injected into the preview document only. It is a separate render from the published
// page and is never what gets built, so nothing here can reach a visitor.
const PREVIEW_MARK_CSS = `
#bdec-mark-style ~ * .bdec-editing{}
.bdec-editing{position:relative;outline:2px solid #e95678!important;outline-offset:6px;
  border-radius:8px;scroll-margin-top:6rem}
.bdec-editing::after{content:attr(data-bdec-label);position:absolute;inset-block-start:-.1rem;
  inset-inline-start:0;transform:translateY(-100%);background:#e95678;color:#fff;
  font:600 12px/1.5 system-ui,sans-serif;padding:.25rem .6rem;border-radius:6px 6px 0 0;
  white-space:nowrap;pointer-events:none;z-index:50}
.bdec-flag{position:fixed;z-index:2147483647;inset-block-start:.55rem;inset-inline-start:50%;
  transform:translateX(-50%);background:#e95678;color:#fff;
  font:600 13px/1.45 system-ui,sans-serif;padding:.35rem .9rem;border-radius:999px;
  box-shadow:0 6px 20px rgb(0 0 0/.35);pointer-events:none;white-space:nowrap;max-width:92%;
  overflow:hidden;text-overflow:ellipsis}
`;

/** Outline the section being edited, inside the preview, and name it. */
function markPreview() {
  const d = document.getElementById('prev-frame')?.contentDocument;
  if (!d?.body) return;
  try {
    if (!d.getElementById('bdec-mark-style')) {
      const s = d.createElement('style');
      s.id = 'bdec-mark-style';
      s.textContent = PREVIEW_MARK_CSS;
      d.head.appendChild(s);
    }
    d.querySelectorAll('.bdec-editing').forEach((e) => {
      e.classList.remove('bdec-editing');
      e.removeAttribute('data-bdec-label');
    });
    d.querySelectorAll('.bdec-flag').forEach(e => e.remove());

    if (!previewAnchor) return;
    const flag = d.createElement('div');
    flag.className = 'bdec-flag';
    flag.textContent = '✎ Now viewing: ' + (previewLabel || previewAnchor.slice(1));
    d.body.appendChild(flag);

    if (previewAnchor === '#top') return;
    const target = d.getElementById(previewAnchor.slice(1));
    if (!target) return;
    target.dataset.bdecLabel = previewLabel || previewAnchor.slice(1);
    target.classList.add('bdec-editing');
  } catch (_) { /* preview swapped mid-flight */ }
}

function jumpPreview(anchor, label = '') {
  previewAnchor = anchor || null;
  previewLabel = label;
  if (!anchor) { markPreview(); return; }
  const f = document.getElementById('prev-frame');
  if (!f?.contentWindow) return;

  let tries = 0;
  const go = () => {
    const w = f.contentWindow;
    if (!w || tries++ > 14) return;
    try {
      markPreview();
      if (anchor === '#top') { w.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      const target = w.document.getElementById(anchor.slice(1));
      if (!target) return void setTimeout(go, 200);      // page still rendering
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // Sections below are still growing as they render; aim again until it settles.
      if (Math.abs(target.getBoundingClientRect().top - 96) > 8) setTimeout(go, 200);
    } catch (_) { setTimeout(go, 200); }
  };
  go();
}

/**
 * Follow the cursor.
 *
 * Opening a card is not the only way to start editing a section — you can click straight
 * into a field in one you already had open. Focus is the honest signal for "this is the
 * bit I am working on", so any field taking focus points the preview at its own section.
 */
function followFocus(anchor, label) {
  if (previewAnchor === anchor) { markPreview(); return; }
  jumpPreview(anchor, label);
}

/** Called by the panel after the preview iframe reloads. */
function reaimPreview() {
  if (previewAnchor) jumpPreview(previewAnchor, previewLabel);
}
reaimPreview.anchored = () => Boolean(previewAnchor);

function renderSectionsBlock(root) {
  root.append(el('div', { class: 'row', style: { marginBottom: '.6rem' } }, [
    el('span', { class: 'small dim', style: { flex: 1 },
      text: 'Use ↑ ↓ to reorder, 🙈 to hide, ⧉ to duplicate' }),
    el('button', { class: 'btn sm', text: '+ New section', onclick: () => addSection() }),
  ]));

  const list = el('div');
  S.content.sections.forEach((sec, i) => list.append(sectionCard(sec, i)));
  root.append(list);
  if (!S.content.sections.length) root.append(el('p', { class: 'empty', text: 'No sections yet. Click "+ New section".' }));
}

function addSection() {
  const id = 'section-' + uid();
  S.content.sections.push({ id, visible: true, animation: 'fade-up', blocks: [newBlock('heading')] });
  S.open.add(id);
  touch(); render();
}

function sectionCard(sec, index) {
  const key = 'sec:' + sec.id;
  const open = S.open.has(key);
  const card = el('div', { class: 'sec' + (open ? '' : ' closed') });

  const title = sec.blocks?.find(b => b.type === 'heading')?.text || sec.id;
  const plainTitle = String(title).replace(/<[^>]+>/g, '');
  // Clicking into any field in this card is the clearest possible statement of "this is
  // what I am editing" — so the preview follows it there and outlines it.
  card.addEventListener('focusin', () => followFocus('#' + sec.id, plainTitle));

  const head = el('div', { class: 'sec__head' }, [
    el('span', { class: 'sec__chev', text: '▾' }),
    el('span', { class: 'sec__title', text: String(title).replace(/<[^>]+>/g, '') }),
    el('span', { class: 'pill' + (sec.visible === false ? ' off' : ' on'), text: sec.visible === false ? 'Hidden' : 'Visible' }),
    moveBar(S.content.sections, index, () => { touch(); render(); }, [
      el('button', {
        class: 'btn icon ghost sm', text: sec.visible === false ? '👁' : '🙈',
        title: sec.visible === false ? 'Show' : 'Hide',
        onclick: (e) => { e.stopPropagation(); sec.visible = sec.visible === false; touch(); render(); },
      }),
    ]),
  ]);
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    card.classList.toggle('closed');
    if (S.open.has(key)) {
      S.open.delete(key);
    } else {
      S.open.add(key);
      // Show the visitor's view of the very section being opened, rather than leaving
      // the preview wherever it happened to be sitting.
      jumpPreview('#' + sec.id, plainTitle);
    }
  });

  const body = el('div', { class: 'sec__body' });
  body.append(el('div', { class: 'grid2', style: { margin: '.6rem 0' } }, [
    field('Section ID (this is the menu link)', sec, 'id', { hint: 'Letters and hyphens only' }),
    selectField('Animation', sec, 'animation', ANIMS, 'fade-up'),
  ]));
  body.append(colorField('Section background colour', sec, 'bg'));

  sec.blocks = sec.blocks || [];
  sec.blocks.forEach((b, i) => body.append(blockCard(b, i, sec.blocks)));

  const bar = el('div', { class: 'addbar' });
  BLOCK_KINDS.forEach(([type, label]) => bar.append(el('button', {
    class: 'btn ghost', text: label,
    onclick: () => { sec.blocks.push(newBlock(type)); touch(); render(); },
  })));
  body.append(bar);

  card.append(head, body);
  return card;
}

function blockCard(b, i, list) {
  const key = 'blk:' + (b._k || (b._k = uid()));
  const open = S.open.has(key);
  const card = el('div', { class: 'blk' + (open ? '' : ' closed'), draggable: 'true' });

  const kindLabel = (BLOCK_KINDS.find(k => k[0] === b.type) || [, b.type])[1];
  const head = el('div', { class: 'blk__head' }, [
    el('span', { class: 'sec__grip', text: '⠿', title: 'Drag to move' }),
    el('span', { class: 'blk__type', text: kindLabel }),
    el('span', { class: 'blk__peek', text: peek(b) }),
    moveBar(list, i, () => { touch(); render(); }),
  ]);
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    card.classList.toggle('closed');
    S.open.has(key) ? S.open.delete(key) : S.open.add(key);
  });

  // Drag to reorder within the section.
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(i));
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isInteger(from) && from !== i) {
      const [moved] = list.splice(from, 1);
      list.splice(i, 0, moved);
      touch(); render();
    }
  });

  const body = blockEditor(b);
  // Keep the collapsed summary honest while typing, so a closed block always shows what
  // is actually in it.
  const peekEl = head.querySelector('.blk__peek');
  body.addEventListener('input', () => { peekEl.textContent = peek(b); });

  card.append(head, body);
  return card;
}

/* ═════════════════════════════════════════════════════════ other tabs */

const MAX_PANELS = 3;
const PANEL_WHEN = [
  'At the start of the scroll — visitors see this as soon as they arrive',
  'Midway through the scroll — while moving along the street',
  'At the end, at the torii gate — the journey\'s final point',
];

function renderHeroBlock(root) {
  const h = S.content.hero;
  h.panels = h.panels || [];

  root.append(el('div', { class: 'row', style: { marginBottom: '.6rem' } }, [
    el('span', { class: 'small dim', style: { flex: 1 },
      text: 'Panels float up one after another as you scroll.' }),
    el('span', { class: 'pill', text: `${h.panels.length} / ${MAX_PANELS} panels` }),
  ]));

  root.append(el('div', { class: 'sec' }, [
    el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
      field('Scroll hint text', h, 'hint', { hint: 'The small hint shown at the bottom of the page' }),
    ]),
  ]));

  h.panels.slice(0, MAX_PANELS).forEach((p, i) => {
    p.kind = p.kind || 'text';
    p.buttons = p.buttons || [];
    const key = 'hero:' + (p.id || i);
    const open = S.open.has(key);
    const card = el('div', { class: 'sec' + (open ? '' : ' closed') });
    card.addEventListener('focusin', () => followFocus('#hero', `Hero — Panel ${i + 1}`));

    const head = el('div', { class: 'sec__head' }, [
      el('span', { class: 'sec__chev', text: '▾' }),
      el('span', { class: 'sec__title', text: `Panel ${i + 1} — ${String(p.title || '').replace(/<[^>]+>/g, '').slice(0, 34) || '(no heading)'}` }),
      el('span', { class: 'pill', text: { text: '¶ Text', image: '🖼 Image', video: '🎬 Video' }[p.kind] }),
      moveBar(h.panels, i, () => { touch(); render(); }),
    ]);
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      card.classList.toggle('closed');
      S.open.has(key) ? S.open.delete(key) : S.open.add(key);
    });

    const body = el('div', { class: 'sec__body' });
    body.append(el('p', { class: 'small dim', style: { margin: '.5rem 0 .2rem' }, text: '⏱ ' + (PANEL_WHEN[i] || '') }));

    // --- what kind of panel
    const kindRow = el('div', { class: 'row', style: { margin: '.6rem 0' } });
    for (const [k, label] of [['text', '¶ Text only'], ['image', '🖼 Image + text'], ['video', '🎬 Video + text']]) {
      kindRow.append(el('button', {
        class: 'btn sm' + (p.kind === k ? ' primary' : ' ghost'), text: label,
        onclick: () => { p.kind = k; touch(); render(); },
      }));
    }
    body.append(el('label', { class: 'lbl', text: 'What this panel contains' }), kindRow);

    // Photo and clip are kept in separate fields, as in the post editor. Sharing one
    // `src` meant that after switching a panel from image to video the video slot showed
    // a .webp — a file that cannot play, in a picker that looked broken.
    if (p.src && !p.image && !p.video) {
      if (p.kind === 'video') p.video = p.src; else p.image = p.src;
    }

    if (p.kind === 'image') {
      body.append(imagePicker(p, 'Image', 'image'),
        el('div', { class: 'grid2' }, [
          field('Alt text', p, 'alt'),
          selectField('Frame', p, 'frame', FRAMES, 'none'),
        ]));
    } else if (p.kind === 'video') {
      body.append(videoPicker(p, 'video'),
        el('div', { class: 'grid2' }, [
          field('What it shows (for screen readers)', p, 'alt'),
          selectField('Frame', p, 'frame', FRAMES, 'none'),
        ]),
        imagePicker(p, 'Poster image — shown before the video starts', 'poster'));
    }

    // --- copy
    body.append(
      field('Small label', p, 'eyebrow', { hint: 'The small line above the heading — leave blank to hide it' }),
      field('Heading', p, 'title', { area: true,
        hint: '<span class="hl">…</span> makes text gold, <br> breaks the line' }),
      field('Description', p, 'sub', { area: true }),
    );

    // --- placement & colour
    body.append(el('details', { class: 'styler', open: i === 0 ? undefined : true }, [
      el('summary', { class: 'small muted', style: { cursor: 'pointer' }, text: '🎨 Position & colour' }),
      el('div', { class: 'styler__grid' }, [
        selectField('Where it sits on screen', p, 'position', [
          ['center', '▣ Center'], ['top', '▔ Top'], ['bottom', '▁ Bottom'],
          ['left', '◧ Left'], ['right', '◨ Right'],
        ], 'center'),
        selectField('Text alignment', p, 'align', ALIGNS, ''),
      ]),
      colorField('Text colour', p, 'color'),
      el('p', { class: 'small dim',
        text: 'If no colour is set it follows the theme automatically — white at night, black by day.' }),
    ]));

    // --- buttons
    body.append(el('label', { class: 'lbl', style: { marginTop: '.6rem' }, text: 'Buttons' }));
    body.append(el('p', { class: 'small dim', style: { marginBottom: '.4rem' },
      text: 'Choose from the list — the text and link fill in automatically.' }));
    body.append(objectList(p.buttons, (x) => [buttonEditor(x)]));

    card.append(head, body);
    root.append(card);
  });

  // --- add / remove panels
  const bar = el('div', { class: 'row', style: { marginTop: '.8rem' } });
  if (h.panels.length < MAX_PANELS) {
    bar.append(el('button', {
      class: 'btn', text: '+ New panel',
      onclick: () => {
        h.panels.push({
          id: 'hero-panel-' + uid(), kind: 'text', position: 'center',
          eyebrow: '', title: 'New panel', sub: '', buttons: [],
        });
        touch(); render();
      },
    }));
  } else {
    bar.append(el('p', { class: 'small dim',
      text: `Maximum ${MAX_PANELS} panels — each is tied to a specific point on the camera path, and there's no room for a fourth.` }));
  }
  root.append(bar);
}

/**
 * Video for a hero panel.
 *
 * Kept separate from imagePicker because the trade-off is different: an image gets
 * squeezed to a couple of hundred kilobytes, a video cannot be. The warning is the point.
 */
function videoPicker(p, key = 'src') {
  const box = el('div', { style: { display: 'grid', gap: '.45rem' } });
  const draw = () => {
    box.textContent = '';
    box.append(el('label', { class: 'lbl', text: 'Video' }));

    if (p[key]) {
      const v = el('video', { src: p[key], controls: true, muted: true,
        style: { width: '100%', borderRadius: '8px', border: '1px solid var(--line)' } });
      box.append(el('div', { style: { position: 'relative' } }, [v]),
        el('button', { class: 'btn sm danger', text: '✕ Remove video',
          onclick: () => {
            const dropped = p[key];
            p[key] = ''; draw(); touch();
            forgetMedia(dropped);
          } }));
    }

    const upload = async (f) => {
      // Say it before the upload, not after: on a phone connection a 40 MB file takes
      // minutes, and finding out then that it was too big is the worst of both worlds.
      const mb = f.size / 1048576;
      if (mb > MAX_VIDEO_MB) {
        draw();
        box.append(pickerError(
          `Video is ${mb.toFixed(1)} MB — maximum ${MAX_VIDEO_MB} MB. Trim it shorter on your phone.`));
        return;
      }
      dropLabel.textContent = `Uploading… (${mb.toFixed(1)} MB) — this will take a moment`;
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await api('/api/upload-video', { method: 'POST', body: fd });
        p[key] = r.src;
        toast(`Video uploaded — ${(r.bytes / 1048576).toFixed(1)} MB`, r.heavy ? '' : 'ok');
        draw(); touch();
        if (r.heavy) box.append(pickerError(
          `${(r.bytes / 1048576).toFixed(1)} MB — will work, but it's heavy. Visitors will take a while to load it.`));
      } catch (err) {
        draw();
        box.append(pickerError(err.message || 'Could not upload video'));
      }
    };

    const { input, label: dropLabel } = filePicker({
      id: 'pickv-' + uid(),
      // .mov is what an iPhone records; naming it explicitly stops the picker greying
      // every video out on iOS.
      accept: 'video/*,.mp4,.mov,.m4v,.webm',
      text: p[key] ? '↻ Choose another video' : '⬆ Choose a video (or drag one here)',
      onFile: upload,
    });

    const url = el('input', { class: 'in', type: 'text', placeholder: 'Or paste a video URL' });
    url.value = p[key] ?? '';
    url.addEventListener('input', () => { p[key] = url.value; touch(); });

    box.append(dropLabel, input, url, el('p', { class: 'small dim',
      text: `📱 Videos from your phone work (.mp4 / .mov), up to ${MAX_VIDEO_MB} MB. `
          + 'You can leave the sound on — it only plays when a visitor taps it. '
          + 'The site runs from a home internet connection, so a short clip loads faster.' }));
  };
  draw();
  return box;
}

function renderBrandBlock(root) {
  const b = S.content.brand;
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    logoPicker(b),

    b.logo
      ? numberField('Logo height', b, 'logoSize', { min: 1, max: 6, step: .1, suffix: ' (rem)' })
      : field('Mark (shown when there is no logo)', b, 'mark'),

    el('div', { class: 'grid2' }, [field('Name', b, 'name'), field('Tagline', b, 'tagline')]),

    el('details', { class: 'styler', open: true }, [
      el('summary', { class: 'small muted', style: { cursor: 'pointer' }, text: '🎨 Header colours' }),
      b.logo ? null : colorField('Mark colour', b, 'markColor'),
      colorField('Name colour', b, 'nameColor'),
      colorField('Tagline colour', b, 'taglineColor'),
      el('p', { class: 'small dim',
        text: 'If no colour is set it follows the theme automatically — light at night, dark by day. '
            + 'A specific colour stays the same in both themes, so check it reads well in both.' }),
    ].filter(Boolean)),

    el('div', { class: 'grid2' }, [field('Header button', b, 'ctaLabel'), field('Button link', b, 'ctaHref')]),
    selectField('Button style', b, 'ctaStyle', [['primary', '▮ Filled'], ['ghost', '▯ Outline']], 'primary'),
    el('p', { class: 'small dim', text: 'Clearing the button text removes the button from the header entirely.' }),
  ])]));
}

function renderSeoBlock(root) {
  const s = S.content.seo;
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    counted(field('Page title', s, 'title', { hint: "The blue text in Google's results" }), s, 'title', 60),
    counted(field('Meta description', s, 'description', { area: true, hint: 'The grey text below the title' }), s, 'description', 160),
    el('p', { class: 'small dim', style: { marginTop: '-.3rem' },
      text: "What shows when the link is shared on Facebook/WhatsApp. Leave blank to use the two above." }),
    field('Share title (OG)', s, 'ogTitle'),
    field('Share description (OG)', s, 'ogDescription', { area: true }),
  ])]));
}

/**
 * Wrap a field with a live character count.
 *
 * Search engines truncate a title around 60 characters and a description around 160;
 * seeing the number while typing is the difference between a snippet that reads well and
 * one that ends mid-word.
 */
function counted(node, obj, key, limit) {
  const out = el('p', { class: 'small dim', style: { marginTop: '.2rem' } });
  const paint = () => {
    const n = (obj[key] || '').length;
    out.textContent = `${n} / ${limit} characters`;
    out.style.color = n > limit ? 'var(--warn)' : 'var(--dim)';
  };
  node.addEventListener('input', paint);
  paint();
  node.append(out);
  return node;
}

function renderNavBlock(root) {
  root.append(el('p', { class: 'small dim', style: { marginBottom: '.5rem' },
    text: 'Write links using a section name — e.g. #about, #work-visa, #contact. '
        + 'For another page, give the full address.' }));
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    objectList(S.content.nav, (n) => [
      el('div', { class: 'grid2' }, [field('Text', n, 'label'), field('Link', n, 'href', { ph: '#about' })]),
    ]),
  ])]));
}

function renderFooterBlock(root) {
  const f = S.content.footer;
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    objectList(f.columns, (c) => [field('Heading', c, 'title'), field('Text', c, 'html', { area: true })]),
    field('Copyright line', f, 'legal'),
  ])]));
}

function renderRegisterTab(root) {
  const r = S.content.register, f = r.fields;
  root.append(el('h2', { style: { fontSize: '1rem', marginBottom: '.3rem' }, text: 'Registration Form' }));
  root.append(el('p', { class: 'small dim', style: { marginBottom: '.9rem' } }, [
    document.createTextNode('View the page: '),
    el('a', { href: '/preview/register.html', target: '_blank', style: { color: 'var(--accent2)' }, text: '/register.html' }),
  ]));
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    field('Small label', r, 'eyebrow'), field('Heading', r, 'title'), field('Description', r, 'sub', { area: true }),
    el('div', { class: 'grid2' }, [field('First name', f, 'firstName'), field('Last name', f, 'lastName')]),
    el('div', { class: 'grid3' }, [field('Phone', f, 'phone'), field('Gender', f, 'gender'), field('Male', f, 'male')]),
    field('Female', f, 'female'),
    el('div', { class: 'grid2' }, [
      field('Course selector label', f, 'course', { ph: 'Which course are you interested in?' }),
      field('First line of the list', f, 'coursePlaceholder', { ph: 'Select one' }),
    ]),
    el('p', { class: 'small dim' }, [
      document.createTextNode('The course list '),
      el('strong', { text: 'comes automatically from the Course Fees section' }),
      document.createTextNode(' — adding or removing a card there changes this list too. '
        + "Whichever course a student picks shows up in the Telegram message and the registration list."),
    ]),
    field('Submit button', r, 'submit'),
    field('Success message', r, 'success', { area: true }),
    field('Error message', r, 'error', { area: true }),
  ])]));
}

async function renderLeads(root) {
  root.append(el('h2', { style: { fontSize: '1rem', marginBottom: '.8rem' }, text: 'Registrations' }));
  const stats = el('div', { class: 'grid3', style: { marginBottom: '.9rem' } });
  const search = el('input', { class: 'in', type: 'search', placeholder: 'Search by name, phone, or course…' });
  const tableWrap = el('div');
  root.append(stats, el('div', { class: 'row', style: { marginBottom: '.7rem' } }, [
    search,
    el('a', { class: 'btn sm', href: '/api/registrations.csv', text: '⬇ CSV' }),
    el('button', { class: 'btn sm ghost', text: '↻', onclick: () => load() }),
  ]), tableWrap);

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(search.value), 300); });

  async function load(q = '') {
    const data = await api('/api/registrations?q=' + encodeURIComponent(q));
    S.regs = data;
    stats.textContent = '';
    stats.append(
      el('div', { class: 'stat' }, [el('b', { text: String(data.total) }), el('span', { class: 'small muted', text: 'Total' })]),
      el('div', { class: 'stat' }, [el('b', { text: String(data.today) }), el('span', { class: 'small muted', text: 'Today' })]),
      el('div', { class: 'stat' }, [el('b', { text: String(data.items.length) }), el('span', { class: 'small muted', text: 'Showing' })]),
    );

    tableWrap.textContent = '';
    if (!data.items.length) { tableWrap.append(el('p', { class: 'empty', text: 'No registrations yet.' })); return; }

    const t = el('table', { class: 'datatable' });
    t.append(el('thead', {}, [el('tr', {}, ['#', 'Name', 'Course', 'Phone', 'Gender', 'Time', ''].map(h => el('th', { text: h })))]));
    const tb = el('tbody');
    data.items.forEach(r => {
      tb.append(el('tr', {}, [
        el('td', { class: 'dim', text: String(r.id) }),
        el('td', { text: `${r.first_name} ${r.last_name}` }),
        el('td', {}, r.course
          ? [el('span', { class: 'pill on', text: r.course })]
          : [el('span', { class: 'small dim', text: '—' })]),
        el('td', { class: 'mono' }, [el('a', { href: 'tel:' + r.phone, style: { color: 'var(--accent2)' }, text: r.phone })]),
        el('td', { text: r.gender === 'male' ? 'Male' : 'Female' }),
        el('td', { class: 'small dim', text: new Date(r.created_at).toLocaleString('en-GB') }),
        el('td', {}, [el('button', {
          class: 'btn icon danger sm', text: '🗑',
          onclick: async () => {
            if (!await confirmBox('Delete this?', `${r.first_name} ${r.last_name} — this registration will be permanently deleted.`, 'Delete')) return;
            await api('/api/registrations/' + r.id, { method: 'DELETE' });
            load(search.value); toast('Deleted', 'ok');
          },
        })]),
      ]));
    });
    t.append(tb);
    tableWrap.append(t);
  }
  load();
}

/**
 * The brand logo.
 *
 * One upload becomes three things — the header mark, the browser tab icon and the phone
 * home-screen icon — so there is nothing else to configure. It is stored under a fixed
 * name rather than a hashed one: there is only ever one logo, and that keeps it out of
 * the orphan sweep that runs on publish.
 */
function logoPicker(brand) {
  const box = el('div', { style: { display: 'grid', gap: '.5rem' } });

  const draw = () => {
    box.textContent = '';
    box.append(el('label', { class: 'lbl', text: 'Logo' }));

    if (brand.logo) {
      box.append(el('div', {
        class: 'thumb',
        style: { background: 'repeating-conic-gradient(#1c2430 0 25%, #151b24 0 50%) 50%/16px 16px', padding: '1rem' },
      }, [
        el('img', { src: brand.logo + '?t=' + Date.now(), alt: '',
          style: { maxHeight: '5rem', width: 'auto', margin: '0 auto', objectFit: 'contain' } }),
        el('button', {
          class: 'btn sm danger thumb__x', text: '✕ Remove',
          onclick: async () => {
            if (!await confirmBox('Remove the logo?', 'The header will show the mark (⛩) again, and the tab icon will revert to the default.', 'Remove')) return;
            await api('/api/logo', { method: 'DELETE' });
            delete brand.logo; delete brand.logoWidth; delete brand.logoHeight;
            draw(); touch(); toast('Logo removed', 'ok');
          },
        }),
      ]));
    }

    const upload = async (file) => {
      if (!file) return;
      dropLabel.textContent = `Uploading… (${(file.size / 1048576).toFixed(1)} MB)`;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await api('/api/logo', { method: 'POST', body: fd });
        brand.logo = r.src;
        brand.logoWidth = r.width;
        brand.logoHeight = r.height;
        draw(); touch();
        toast('Logo set — the header, tab icon, and phone icon have all updated', 'ok');
      } catch (err) {
        draw();
        box.append(pickerError(err.message || 'Could not upload logo'));
      }
    };

    const { input, label: dropLabel } = filePicker({
      id: 'picklogo-' + uid(),
      accept: 'image/*,.png,.jpg,.jpeg,.webp,.svg,.heic,.heif',
      text: brand.logo ? '↻ Choose another logo' : '⬆ Choose a logo (PNG / SVG / JPG)',
      onFile: upload,
    });

    box.append(dropLabel, input, el('p', { class: 'small dim',
      text: 'One file is enough — it generates the header logo, browser tab icon, and phone '
          + 'home-screen icon all at once. A transparent PNG looks best.' }));
  };

  draw();
  return box;
}

/**
 * AI knowledge.
 *
 * The assistant answers only from this text and says "I do not know" for everything else,
 * so this page is the single lever over what it will and will not claim. Saving takes
 * effect on the very next question — the chat server notices the file changed — which is
 * why there is an "ask it something" box right underneath: edit, save, check.
 */
async function renderKnowledge(root) {
  root.append(el('h2', { style: { fontSize: '1rem', marginBottom: '.3rem' }, text: '🤖 AI knowledge' }));
  root.append(el('p', { class: 'small dim', style: { marginBottom: '.9rem' },
    text: 'The support chatbot only ever says what is written here. For anything else it says '
        + '"I don\'t know" and gives the phone number — so if any visa info changes, update it here too.' }));

  let data;
  try { data = await api('/api/knowledge'); }
  catch (err) { root.append(el('p', { class: 'small', style: { color: '#ff9a92' }, text: err.message })); return; }

  const area = el('textarea', {
    class: 'in',
    style: { minHeight: '26rem', fontFamily: 'var(--mono)', fontSize: '.82rem', lineHeight: '1.7' },
    spellcheck: 'false',
  });
  area.value = data.text;

  const meta = el('p', { class: 'small dim' });
  const paint = () => {
    const n = area.value.length;
    meta.textContent = `${n.toLocaleString('en-US')} characters · approx. ${Math.round(n / 3.2).toLocaleString('en-US')} tokens`
      + (n > 20000 ? ' — larger means every answer will be a little slower' : '');
    meta.style.color = n > 20000 ? 'var(--warn)' : 'var(--dim)';
  };
  area.addEventListener('input', () => { paint(); saveBtn.disabled = false; });
  paint();

  const saveBtn = el('button', {
    class: 'btn primary', text: '💾 Save', disabled: true,
    onclick: async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api('/api/knowledge', { method: 'PUT', body: JSON.stringify({ text: area.value }) });
        toast('Saved — takes effect from the next question', 'ok');
      } catch (err) { toast(err.message, 'err'); saveBtn.disabled = false; }
      finally { saveBtn.textContent = '💾 Save'; }
    },
  });

  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    area, meta,
    el('div', { class: 'row', style: { marginTop: '.6rem' } }, [
      saveBtn,
      el('button', {
        class: 'btn sm', text: '↩ Revert to previous',
        onclick: async () => {
          if (!await confirmBox('Revert?', 'This will restore the text from right before the last save.', 'Revert')) return;
          try {
            const r = await api('/api/knowledge/revert', { method: 'POST' });
            area.value = r.text; paint();
            toast('Previous version restored', 'ok');
          } catch (err) { toast(err.message, 'err'); }
        },
      }),
    ]),
  ])]));

  // --- try it
  const q = el('input', { class: 'in', type: 'text',
    placeholder: 'e.g.: What is the age limit for an SSW visa? / What are the intake months? / 学生ビザは？' });
  const answer = el('div', { class: 'sub', style: { display: 'none', whiteSpace: 'pre-wrap' } });

  const ask = async () => {
    if (!q.value.trim()) return;
    answer.style.display = '';
    answer.textContent = 'Getting an answer…';
    try {
      const r = await api('/api/knowledge/ask', { method: 'POST', body: JSON.stringify({ q: q.value }) });
      answer.textContent = r.answer;
    } catch (err) { answer.textContent = '⚠ ' + err.message; }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

  root.append(el('div', { class: 'sec', style: { marginTop: '.8rem' } }, [
    el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
      el('h3', { style: { fontSize: '.9rem', marginBottom: '.2rem' }, text: '🔎 Test it' }),
      el('p', { class: 'small dim', style: { marginBottom: '.5rem' },
        text: 'After saving, ask a question here to see what the bot says. In English, বাংলা, or 日本語 — any language.' }),
      el('div', { class: 'row', style: { flexWrap: 'nowrap' } }, [
        q, el('button', { class: 'btn sm primary', text: 'Ask', onclick: ask }),
      ]),
      answer,
    ]),
  ]));
}

/**
 * Telegram notifications.
 *
 * The awkward part is unavoidable and worth stating plainly in the UI: a bot cannot
 * message a phone number. Someone has to open the bot on that phone and press Start
 * once; only then does a chat_id exist to send to. Everything below is scaffolding
 * around that single fact.
 */
function renderTelegram(root) {
  const box = el('div', { class: 'sec', style: { marginTop: '.8rem' } });
  const body = el('div', { class: 'sec__body', style: { borderTop: 'none' } });
  box.append(body);
  root.append(box);

  const load = async () => {
    body.textContent = '';
    body.append(el('h3', { style: { fontSize: '.9rem', marginBottom: '.2rem' },
      text: '📨 Registration Notifications (Telegram)' }));

    let data;
    try { data = await api('/api/telegram'); }
    catch (err) { body.append(el('p', { class: 'small', style: { color: '#ff9a92' }, text: err.message })); return; }

    if (!data.configured) {
      body.append(el('p', { class: 'small', style: { color: 'var(--warn)' },
        text: 'TELEGRAM_BOT_TOKEN missing from .env — notifications are off.' }));
      return;
    }

    const uname = data.bot?.username;
    body.append(el('p', { class: 'small dim', style: { marginBottom: '.7rem' } }, [
      document.createTextNode('Bot: '),
      el('b', { text: '@' + (uname || '?') }),
      document.createTextNode(' — new registrations will message every chat listed below.'),
    ]));

    // ---- linked chats
    const list = el('div', { style: { display: 'grid', gap: '.4rem', marginBottom: '.7rem' } });
    if (!data.chats.length) {
      list.append(el('p', { class: 'small dim', text: 'No chats linked yet — follow the two steps below.' }));
    }
    for (const c of data.chats) {
      list.append(el('div', { class: 'row' }, [
        el('span', { class: 'pill on', text: '● Active' }),
        el('b', { text: c.label || c.name }),
        el('span', { class: 'mono dim small', text: String(c.id) }),
        el('span', { class: 'spacer', style: { flex: 1 } }),
        el('button', {
          class: 'btn icon danger sm', text: '🗑', title: 'Remove',
          onclick: async () => {
            if (!await confirmBox('Remove this?', `${c.label || c.name} — this chat will no longer receive notifications.`, 'Remove')) return;
            await api('/api/telegram/chats/' + c.id, { method: 'DELETE' });
            load(); toast('Removed', 'ok');
          },
        }),
      ]));
    }
    body.append(list);

    // ---- how to link
    body.append(el('div', { class: 'styler', style: { marginBottom: '.7rem' } }, [
      el('p', { class: 'small', style: { fontWeight: '600', marginBottom: '.35rem' }, text: 'To add a new number' }),
      el('p', { class: 'small dim' }, [
        document.createTextNode('1. On the phone you want notifications on, open '),
        el('a', { href: `https://t.me/${uname}`, target: '_blank', rel: 'noopener',
          style: { color: 'var(--accent2)' }, text: `@${uname}` }),
        document.createTextNode(' in Telegram and press '),
        el('b', { text: 'Start' }),
        document.createTextNode('.'),
      ]),
      el('p', { class: 'small dim', text: '2. Then press "Find new chat" below.' }),
      el('p', { class: 'small', style: { color: 'var(--warn)', marginTop: '.4rem' },
        text: "⚠ A Telegram bot cannot message a phone number directly — this is Telegram's "
            + 'anti-spam rule. So pressing Start once is mandatory.' }),
    ]));

    // ---- actions
    const found = el('div', { style: { display: 'grid', gap: '.4rem' } });
    body.append(el('div', { class: 'row' }, [
      el('button', {
        class: 'btn sm primary', text: '🔍 Find new chat',
        onclick: async (e) => {
          const btn = e.target; btn.disabled = true; btn.textContent = 'Searching…';
          try {
            const r = await api('/api/telegram/scan', { method: 'POST' });
            found.textContent = '';
            if (!r.found.length) {
              found.append(el('p', { class: 'small dim',
                text: 'Nothing new found. Did you press Start on the phone? Try again after pressing it.' }));
            }
            for (const f of r.found) {
              const labelIn = el('input', { class: 'in', type: 'text',
                placeholder: 'Give it a name — e.g. "Main admin" or "Test"' });
              labelIn.value = f.name;
              found.append(el('div', { class: 'sub' }, [
                el('div', { class: 'sub__bar' }, [
                  el('b', { text: f.name }),
                  f.username ? el('span', { class: 'dim small', text: '@' + f.username }) : null,
                  el('span', { class: 'mono dim small', text: String(f.id) }),
                ].filter(Boolean)),
                labelIn,
                el('button', {
                  class: 'btn sm ok', text: '✓ Add',
                  onclick: async () => {
                    try {
                      await api('/api/telegram/chats', { method: 'POST',
                        body: JSON.stringify({ id: f.id, name: f.name, label: labelIn.value }) });
                      toast('Linked — a confirmation message was sent to that phone', 'ok');
                      load();
                    } catch (err) { toast(err.message, 'err'); }
                  },
                }),
              ]));
            }
          } catch (err) { toast(err.message, 'err'); }
          finally { btn.disabled = false; btn.textContent = '🔍 Find new chat'; }
        },
      }),
      data.chats.length ? el('button', {
        class: 'btn sm', text: '🔔 Send test message',
        onclick: async (e) => {
          const btn = e.target; btn.disabled = true;
          try {
            const r = await api('/api/telegram/test', { method: 'POST' });
            toast(r.failed.length
              ? `${r.sent} sent, failed: ${r.failed.join(', ')}`
              : `Message sent to ${r.sent} chat(s)`, r.failed.length ? 'err' : 'ok');
          } catch (err) { toast(err.message, 'err'); }
          finally { btn.disabled = false; }
        },
      }) : null,
    ].filter(Boolean)));
    body.append(found);
  };

  load();
}

function renderSettings(root) {
  root.append(el('h2', { style: { fontSize: '1rem', marginBottom: '.8rem' }, text: 'Settings' }));

  const cur = el('input', { class: 'in', type: 'password', autocomplete: 'current-password' });
  const nw = el('input', { class: 'in', type: 'password', autocomplete: 'new-password' });
  root.append(el('div', { class: 'sec' }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    el('h3', { style: { fontSize: '.9rem', marginBottom: '.5rem' }, text: 'Change Password' }),
    el('div', {}, [el('label', { class: 'lbl', text: 'Current password' }), cur]),
    el('div', {}, [el('label', { class: 'lbl', text: 'New password (at least 6 characters)' }), nw]),
    el('button', {
      class: 'btn primary sm', style: { marginTop: '.5rem' }, text: 'Change',
      onclick: async () => {
        try {
          await api('/api/password', { method: 'POST', body: JSON.stringify({ current: cur.value, new: nw.value }) });
          cur.value = nw.value = '';
          toast('Password changed', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      },
    }),
  ])]));

  renderTelegram(root);

  const list = el('div', { style: { display: 'grid', gap: '.3rem' } });
  root.append(el('div', { class: 'sec', style: { marginTop: '.8rem' } }, [el('div', { class: 'sec__body', style: { borderTop: 'none' } }, [
    el('h3', { style: { fontSize: '.9rem', marginBottom: '.2rem' }, text: 'Previous Versions' }),
    el('p', { class: 'small dim', style: { marginBottom: '.5rem' },
      text: 'Old content is saved here before every publish — the last 2 are kept to save server space. '
          + 'Restoring loads it as a draft; review it, then publish.' }),
    list,
  ])]));

  api('/api/backups').then(({ items }) => {
    list.textContent = '';
    if (!items.length) { list.append(el('p', { class: 'small dim', text: 'No backups yet.' })); return; }
    items.forEach(b => list.append(el('div', { class: 'row' }, [
      el('span', { class: 'mono small', text: b.when.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5') }),
      el('span', { class: 'spacer', style: { flex: 1 } }),
      el('button', {
        class: 'btn sm', text: 'Restore',
        onclick: async () => {
          if (!await confirmBox('Restore this?', 'This version will load as the draft. The current draft will be lost.', 'Restore')) return;
          const { content } = await api('/api/restore', { method: 'POST', body: JSON.stringify({ name: b.name }) });
          S.content = content; render(); refreshPreview();
          toast('Restored as draft — review it, then publish', 'ok');
        },
      }),
    ])));
  }).catch(() => {});
}

/* ------------------------------------------------------------- startup */
api('/api/session').then(({ ok }) => { if (ok) boot(); }).catch(() => {});
