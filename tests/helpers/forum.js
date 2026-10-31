// Builds a minimal stand-in for derStandard's <dst-forum> web component,
// mirroring the live DOM structure the extension relies on:
//
//   <dst-forum> #shadow-root
//     <header class="forum--header">
//     <main class="forum--main">
//       <dst-posting-box>                       comment form
//       <dst-posting data-level="0">            root posting (sortable)
//         <dst-posting--ratinglog postingid=… positiveratings=… negativeratings=…>
//         <time datetime=…>
//         <button class="answers">              native reply toggle
//       <section class="thread">                replies of the posting above
//       <slot>                                  ad container
//     <button class="thread--more">             "Weitere Postings laden"

let autoId = 0;

export function createPosting(doc, spec = {}) {
  const p = doc.createElement('dst-posting');
  const id = spec.id === undefined ? 'P' + (++autoId) : spec.id;
  p.setAttribute('data-level', spec.level === undefined ? '0' : String(spec.level));
  if (spec.level === null) p.removeAttribute('data-level');
  if (spec.pinned) p.setAttribute('pinned', '');
  if (spec.ariaLabel) p.setAttribute('aria-label', spec.ariaLabel);
  if (spec.className) p.className = spec.className;
  if (spec.hasThread) p.classList.add('posting-with-thread');
  if (spec.expanded) p.classList.add('posting-has-thread-expanded');

  if (spec.ratings !== false) {
    const r = doc.createElement('dst-posting--ratinglog');
    if (id) r.setAttribute('postingid', id);
    r.setAttribute('positiveratings', String(spec.pos || 0));
    r.setAttribute('negativeratings', String(spec.neg || 0));
    p.appendChild(r);
  }
  if (spec.time !== undefined || spec.timeText !== undefined) {
    const t = doc.createElement('time');
    if (spec.time !== undefined) t.setAttribute('datetime', spec.time);
    t.textContent = spec.timeText || '';
    p.appendChild(t);
  }
  if (spec.text) {
    const body = doc.createElement('p');
    body.textContent = spec.text;
    p.appendChild(body);
  }
  if (spec.hasThread || spec.expanded) {
    const btn = doc.createElement('button');
    btn.className = 'answers';
    btn.textContent = 'Antworten';
    // Native toggle: flips the expanded class and marks the posting active.
    btn.addEventListener('click', () => {
      p.classList.toggle('posting-has-thread-expanded');
      p.classList.add('is-active-posting');
      p.dataset.toggleClicks = String(Number(p.dataset.toggleClicks || 0) + 1);
    });
    p.appendChild(btn);
  }
  return p;
}

// postings: array of posting specs; spec.replies adds a SECTION.thread after it,
// spec.ad adds a SLOT after it.
export function appendPostings(doc, main, postings) {
  const created = [];
  for (const spec of postings) {
    const p = createPosting(doc, spec);
    main.appendChild(p);
    created.push(p);
    if (spec.replies) {
      const s = doc.createElement('section');
      s.className = 'thread';
      for (let i = 0; i < spec.replies; i++) {
        const r = createPosting(doc, { id: (spec.id || 'R') + '-r' + i, level: 1, pos: 1 });
        s.appendChild(r);
      }
      main.appendChild(s);
    }
    if (spec.ad) main.appendChild(doc.createElement('slot'));
  }
  return created;
}

export function buildForum(doc, {
  postings = [],
  postingBox = true,
  header = true,
  count,
  attach = true
} = {}) {
  const forum = doc.createElement('dst-forum');
  const shadow = forum.attachShadow({ mode: 'open' });
  if (header) {
    const h = doc.createElement('header');
    h.className = 'forum--header';
    if (count !== undefined) {
      const c = doc.createElement('span');
      c.className = 'forum--postingcount';
      c.textContent = count + ' Postings und Antworten';
      h.appendChild(c);
    }
    shadow.appendChild(h);
  }
  const main = doc.createElement('main');
  main.className = 'forum--main';
  shadow.appendChild(main);
  if (postingBox) main.appendChild(doc.createElement('dst-posting-box'));
  appendPostings(doc, main, postings);
  if (attach) doc.body.appendChild(forum);
  return { forum, shadow, main };
}

// Simulates native pagination: a "Weitere Postings laden" button that appends
// one batch per click (asynchronously, like the GraphQL round trip) and
// disappears once all batches are rendered.
export function addLoadMoreButton(doc, shadow, main, batches, { delay = 100 } = {}) {
  const btn = doc.createElement('button');
  btn.className = 'thread--more';
  btn.textContent = 'Weitere Postings laden';
  btn.clicks = 0;
  btn.addEventListener('click', () => {
    btn.clicks++;
    const batch = batches.shift();
    btn.setAttribute('aria-busy', 'true');
    doc.defaultView.setTimeout(() => {
      if (batch) appendPostings(doc, main, batch);
      btn.removeAttribute('aria-busy');
      if (batches.length === 0) btn.remove();
    }, delay);
  });
  shadow.appendChild(btn);
  return btn;
}

// IDs of the visible root postings in their rendered (CSS order) sequence.
export function renderedOrder(main) {
  return Array.from(main.children)
    .filter((el) => el.tagName === 'DST-POSTING' && el.style.display !== 'none')
    .map((el, i) => ({ el, i, order: el.style.order === '' ? Infinity : Number(el.style.order) }))
    .sort((a, b) => (a.order - b.order) || (a.i - b.i))
    .map(({ el }) => {
      const r = el.querySelector('dst-posting--ratinglog');
      return r ? r.getAttribute('postingid') : null;
    });
}

export function orderOf(el) {
  return Number(el.style.order);
}
