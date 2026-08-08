/**
 * The site assistant — chat panel.
 *
 * Lazy-loaded: the launcher button lives in index.html so it is painted with the page,
 * but this module is only fetched when someone actually shows interest in it. Nothing
 * here is on the critical path.
 *
 * There is no API key in this file, and there never should be. The browser talks to
 * /api/chat on our own origin; the key stays on the server (see build.mjs).
 */

const ENDPOINT = '/api/chat';
const MAX_CHARS = 1000;

const UI = {
  bn: {
    title: 'Support Centre',
    subtitle: 'Ask about Japan visas and education',
    placeholder: 'Type your question…',
    send: 'Send',
    close: 'Close',
    greeting: 'Welcome to BD Education Centre! Ask anything about studying in Japan, work visas, or permanent residency — in English, বাংলা, or 日本語, whichever you prefer.',
    suggestions: ['What are the SSW visa requirements?', 'How many hours can I work on a student visa?', 'Where is the office?'],
    thinking: 'Typing…',
    network: 'Connection problem. Please try again, or call +88 01689-447591',
  },
};

const t = UI.bn;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Render the assistant's markdown-ish output.
 *
 * The model is told not to emit tables, headings or code — so this only needs to handle
 * paragraphs, dash lists and **bold**. Built with DOM nodes rather than innerHTML so a
 * model reply can never inject markup.
 */
function renderMarkdown(container, text) {
  container.textContent = '';
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const isList = lines.every(l => /^[-*•]\s+/.test(l));
    if (isList) {
      const ul = el('ul', 'chat-list');
      for (const line of lines) ul.appendChild(bold(el('li'), line.replace(/^[-*•]\s+/, '')));
      container.appendChild(ul);
    } else {
      container.appendChild(bold(el('p'), lines.join(' ')));
    }
  }
}

/** Apply **bold** runs as <strong>, everything else as text. */
function bold(node, text) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part) return;
    node.appendChild(i % 2 ? el('strong', null, part) : document.createTextNode(part));
  });
  return node;
}

export function mountChat(launcher) {
  const root = el('div', 'chat');
  root.id = 'chat-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', t.title);

  root.innerHTML = '';
  const head = el('header', 'chat__head');
  const titles = el('div');
  titles.appendChild(el('p', 'chat__title', t.title));
  titles.appendChild(el('p', 'chat__sub', t.subtitle));
  const closeBtn = el('button', 'chat__close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t.close);
  closeBtn.textContent = '✕';
  head.append(titles, closeBtn);

  const log = el('div', 'chat__log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions text');

  const form = el('form', 'chat__form');
  const input = el('textarea', 'chat__input');
  input.id = 'chat-input';
  input.name = 'message';
  input.rows = 1;
  input.maxLength = MAX_CHARS;
  input.placeholder = t.placeholder;
  input.setAttribute('aria-label', t.placeholder);
  const send = el('button', 'chat__send');
  send.type = 'submit';
  send.setAttribute('aria-label', t.send);
  send.textContent = '➤';
  form.append(input, send);

  root.append(head, log, form);
  document.body.appendChild(root);

  // ---------------------------------------------------------------- state
  /** @type {{role:'user'|'assistant', content:string}[]} */
  const history = [];
  let busy = false;
  let controller = null;

  function bubble(role) {
    const wrap = el('div', `chat__msg chat__msg--${role}`);
    const body = el('div', 'chat__bubble');
    wrap.appendChild(body);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function addGreeting() {
    renderMarkdown(bubble('bot'), t.greeting);
    const chips = el('div', 'chat__chips');
    for (const s of t.suggestions) {
      const b = el('button', 'chat__chip', s);
      b.type = 'button';
      b.addEventListener('click', () => { chips.remove(); ask(s); });
      chips.appendChild(b);
    }
    log.appendChild(chips);
  }

  async function ask(question) {
    if (busy) return;
    const text = question.trim().slice(0, MAX_CHARS);
    if (!text) return;

    busy = true;
    send.disabled = true;
    input.value = '';
    autoGrow();

    renderMarkdown(bubble('user'), text);
    history.push({ role: 'user', content: text });

    const body = bubble('bot');
    const typing = el('span', 'chat__typing');
    typing.setAttribute('aria-label', t.thinking);
    typing.append(el('i'), el('i'), el('i'));
    body.appendChild(typing);

    let answer = '';
    controller = new AbortController();

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!frame.startsWith('data:')) continue;
          let msg;
          try { msg = JSON.parse(frame.slice(5).trim()); } catch { continue; }

          if (msg.t) {
            answer += msg.t;
            renderMarkdown(body, answer);
            log.scrollTop = log.scrollHeight;
          } else if (msg.retry) {
            // The server fell back to another model; discard the partial answer so the
            // two are not spliced together mid-sentence.
            answer = '';
            body.textContent = '';
            body.appendChild(typing);
          } else if (msg.error) {
            answer = msg.error;
            renderMarkdown(body, answer);
          }
        }
      }

      if (!answer.trim()) throw new Error('empty');
      history.push({ role: 'assistant', content: answer });
    } catch (err) {
      if (err.name !== 'AbortError') {
        renderMarkdown(body, typeof err.message === 'string' && err.message.length > 12
          ? err.message : t.network);
      }
      // Drop the unanswered turn so a retry does not send it twice.
      if (history.at(-1)?.role === 'user') history.pop();
    } finally {
      typing.remove();
      busy = false;
      send.disabled = false;
      controller = null;
      log.scrollTop = log.scrollHeight;
    }
  }

  // ------------------------------------------------------------ behaviour
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter makes a new line — what people expect from a chat box.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  });

  let open = false;
  let lastFocus = null;

  function setOpen(next) {
    open = next;
    root.hidden = !next;
    launcher.setAttribute('aria-expanded', String(next));
    document.documentElement.classList.toggle('chat-open', next);
    if (next) {
      lastFocus = document.activeElement;
      if (!log.childElementCount) addGreeting();
      requestAnimationFrame(() => input.focus());
    } else {
      controller?.abort();
      lastFocus?.focus?.();
    }
  }

  closeBtn.addEventListener('click', () => setOpen(false));
  // The launcher is an <a href="#contact"> so it still works without JS; now that the
  // panel exists, take the click instead of letting it jump down the page.
  launcher.addEventListener('click', (e) => { e.preventDefault(); setOpen(!open); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });

  // Keep focus inside the panel while it is open — it is a dialog, and tabbing out to
  // the page behind it loses people.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll('button, textarea')].filter(n => !n.disabled && n.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  setOpen(true);
  return { open: () => setOpen(true), close: () => setOpen(false) };
}
