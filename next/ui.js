/* ui.js — overlay primitives for the new UI: toasts, menus, dialogs, the
   command palette and side sheets. Every overlay animates in AND out, closes on
   Escape / outside click, and returns focus to where it came from. */
import { el, html, raw, icon, animate, SPRING, SMOOTH, $$ } from './lib.js';

/* one Escape stack so the topmost overlay closes first */
const stack = [];
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault(); e.stopPropagation();
  stack[stack.length - 1]();
}, true);
export function pushEsc(fn) { stack.push(fn); return () => { const i = stack.indexOf(fn); if (i >= 0) stack.splice(i, 1); }; }
export const overlayOpen = () => stack.length > 0;
/* where overlays go: in full screen only the full-screen element is drawn, so a
   menu or dialog opened from a full-screen player must live inside it */
const layer = () => document.fullscreenElement || document.body;

/* ---------- toast ---------- */
let toastBox = null;
export function toast(msg, { ic = 'check', bad = false, action, onAction, ms = 2800 } = {}) {
  if (!toastBox) toastBox = el('<div class="toasts" role="status" aria-live="polite"></div>');
  if (toastBox.parentNode !== layer()) layer().appendChild(toastBox);
  // the same message again (e.g. queueing several files) refreshes the one on screen
  // instead of stacking copies; and never more than three at a time
  const same = [...toastBox.children].find(t => t.dataset.msg === msg && !t.dataset.closing);
  if (same && !action) {
    clearTimeout(same._timer); same._timer = setTimeout(same._close, ms);
    animate(same, [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 300 });
    return same._close;
  }
  while (toastBox.children.length >= 3) toastBox.firstElementChild.remove();
  const t = el(html`<div class="toast${bad ? ' bad' : ''}"><span class="ti">${icon(bad ? 'info' : ic, 15, 2)}</span><span>${msg}</span>${action ? html`<button class="act">${action}</button>` : ''}</div>`);
  t.dataset.msg = msg;
  toastBox.appendChild(t);
  animate(t, [{ opacity: 0, transform: 'translateY(-14px) scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: SPRING });
  const close = () => {
    if (!t.isConnected || t.dataset.closing) return;
    t.dataset.closing = '1';
    animate(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) scale(0.95)' }], { duration: 200, easing: SMOOTH, fill: 'forwards' }).then(() => t.remove());
  };
  t._close = close;
  if (action) t.querySelector('.act').onclick = () => { close(); onAction && onAction(); };
  t._timer = setTimeout(close, action ? ms + 2200 : ms);
  return close;
}

/* ---------- menu ---------- */
/* items: [{ label, ic, run, danger, key }, '-' , { header }] — anchored at x,y or to an element.
   onClose runs however the menu goes away (picked, Esc, clicked off). */
let openMenu = null;
export function menu(items, at, { onClose } = {}) {
  closeMenu();
  const m = el('<div class="menu" role="menu"></div>');
  items.filter(Boolean).forEach(it => {
    if (it === '-') return m.appendChild(el('<hr>'));
    if (it.header) return m.appendChild(el(html`<div class="mh">${it.header}</div>`));
    const b = el(html`<button role="menuitem" class="${it.danger ? 'danger' : ''}">${icon(it.ic || 'chevron', 16)}<span>${it.label}</span>${it.key ? html`<span class="k">${it.key}</span>` : ''}</button>`);
    b.onclick = () => { closeMenu(); it.run && it.run(); };
    m.appendChild(b);
  });
  layer().appendChild(m);
  // position: next to the anchor element, or at the pointer; flip to stay on screen
  let x, y;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.right - m.offsetWidth; y = r.bottom + 6; if (x < 8) x = r.left; }
  else { x = at.x; y = at.y; }
  const W = innerWidth, H = innerHeight, w = m.offsetWidth, h = m.offsetHeight;
  let ox = 'left', oy = 'top';
  if (x + w > W - 8) { x = Math.max(8, W - w - 8); ox = 'right'; }
  if (y + h > H - 8) { y = Math.max(8, (at instanceof Element ? at.getBoundingClientRect().top - h - 6 : y - h)); oy = 'bottom'; }
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.style.setProperty('--ox', ox); m.style.setProperty('--oy', oy);
  animate(m, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: SPRING });
  // keyboard: arrows move, Enter runs
  const btns = $$('button', m); let hi = -1;
  const setHi = i => { hi = (i + btns.length) % btns.length; btns.forEach((b, j) => b.classList.toggle('hl', j === hi)); btns[hi].focus({ preventScroll: true }); };
  m.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(hi + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(hi - 1); }
  });
  const away = e => { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(() => { document.addEventListener('pointerdown', away, true); window.addEventListener('blur', closeMenu); }, 0);
  const pop = pushEsc(closeMenu);
  openMenu = { m, cleanup: () => { pop(); document.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', closeMenu); onClose && onClose(); } };
  return m;
}
export function closeMenu() {
  if (!openMenu) return;
  const { m, cleanup } = openMenu; openMenu = null; cleanup();
  m.style.pointerEvents = 'none';
  animate(m, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: 140, easing: SMOOTH, fill: 'forwards' }).then(() => m.remove());
}

/* ---------- dialog ---------- */
/* dialog({ title, text, ic, tint, body (markup), actions: [{label, kind, run(close, root) → false keeps open}], onMount(root, close) }) */
export function dialog({ title, text, ic, tint = 't-app', body, actions = [{ label: 'OK', kind: 'pri' }], onMount, wide } = {}) {
  const back = document.activeElement;
  const scrim = el('<div class="scrim"></div>');
  const box = el(html`<div class="dlg" role="dialog" aria-modal="true"${wide ? raw(' style="width:min(560px,100%)"') : ''}>
    ${ic ? html`<div class="di tint ${tint}">${icon(ic, 22)}</div>` : ''}
    ${title ? html`<h3>${title}</h3>` : ''}${text ? html`<p>${text}</p>` : ''}
    ${body ? html`<div class="body">${body}</div>` : ''}
    <div class="acts"></div></div>`);
  scrim.appendChild(box); layer().appendChild(scrim);
  let done = false;
  const close = () => {
    if (done) return; done = true; pop();
    scrim.style.pointerEvents = 'none';
    animate(box, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(0.96)' }], { duration: 180, easing: SMOOTH, fill: 'forwards' });
    animate(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: SMOOTH, fill: 'forwards' }).then(() => { scrim.remove(); back && back.focus && back.focus({ preventScroll: true }); });
  };
  const pop = pushEsc(close);
  const acts = box.querySelector('.acts');
  actions.forEach(a => {
    const b = el(html`<button class="b ${a.kind || ''}">${a.label}</button>`);
    b.onclick = async () => {
      if (!a.run) return close();
      b.disabled = true;
      try { const r = await a.run(close, box); if (r !== false) close(); }
      finally { b.disabled = false; }
    };
    acts.appendChild(b);
  });
  scrim.addEventListener('pointerdown', e => { if (e.target === scrim) close(); });
  animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: SMOOTH });
  animate(box, [{ opacity: 0, transform: 'translateY(18px) scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: SPRING });
  if (onMount) onMount(box, close);
  const f = box.querySelector('input, textarea, select') || box.querySelector('.acts .pri') || box.querySelector('.acts button');
  if (f) setTimeout(() => f.focus(), 30);
  return { close, root: box };
}
export function confirm({ title, text, ok = 'Confirm', danger, ic = 'info', tint }) {
  return new Promise(res => dialog({
    title, text, ic, tint: tint || (danger ? '' : 't-app'),
    actions: [{ label: 'Cancel', run: () => res(false) }, { label: ok, kind: danger ? 'danger' : 'pri', run: () => res(true) }],
  }));
}
export function prompt({ title, text, value = '', ok = 'Save', ic = 'pencil', placeholder = '', select }) {
  return new Promise(res => {
    let settled = false;
    const { root } = dialog({
      title, text, ic,
      body: html`<input class="in" value="${value}" placeholder="${placeholder}" spellcheck="false" />`,
      actions: [{ label: 'Cancel', run: () => { settled = true; res(null); } }, { label: ok, kind: 'pri', run: (_c, r) => { const v = r.querySelector('input').value.trim(); if (!v) return false; settled = true; res(v); } }],
      onMount: (r, close) => {
        const inp = r.querySelector('input');
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); r.querySelector('.acts .pri').click(); } });
        setTimeout(() => { inp.focus(); if (select) inp.setSelectionRange(0, select === 'base' ? (value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length) : value.length); }, 40);
        // resolve null if dismissed by Esc / scrim
        const obs = new MutationObserver(() => { if (!r.isConnected) { obs.disconnect(); if (!settled) res(null); } });
        obs.observe(document.body, { childList: true });
      },
    });
  });
}

/* ---------- palette ---------- */
/* palette({ placeholder, source(query) → [{group, label, desc, ic, tint, img, locked, run, menu?}] })
   menu() returns context-menu items for that entry (right-click, the Menu key or
   Shift+F10); entries without one get a plain "Open". Picking one closes the palette. */
let pal = null;
export function palette({ placeholder, source }) {
  if (pal) return closePalette();
  const back = document.activeElement;
  const scrim = el('<div class="scrim" style="background:rgb(4 5 8 / .4);align-items:flex-start"></div>');
  const box = el(html`<div class="pal" role="dialog" aria-label="Search">
    <div class="pin">${icon('search', 20)}<input placeholder="${placeholder}" spellcheck="false" autocomplete="off" aria-label="Search" /><span class="kbd">esc</span></div>
    <div class="pl" role="listbox"></div>
    <div class="pf"><span><span class="kbd">↑↓</span> move</span><span><span class="kbd">↵</span> open</span></div></div>`);
  document.body.append(scrim, box);
  const input = box.querySelector('input'), list = box.querySelector('.pl');
  let items = [], sel = 0;
  const draw = () => {
    items = source(input.value.trim().toLowerCase());
    sel = Math.min(sel, Math.max(0, items.length - 1));
    if (!items.length) { list.innerHTML = '<div class="pe">Nothing matches</div>'; return; }
    let last = null, out = '';
    items.forEach((it, i) => {
      if (it.group !== last) { out += html`<div class="pg">${it.group}</div>`.s; last = it.group; }
      out += html`<button class="pi${i === sel ? ' on' : ''}" data-i="${i}" role="option">
        <span class="pic tint ${it.tint || 't-app'}">${it.img ? raw(`<img src="${it.img}" alt="" loading="lazy">`) : icon(it.ic, 16)}</span>
        <span>${it.label}</span>${it.locked ? html`<span class="lk">${icon('lock', 14)}</span>` : ''}<span class="pd">${it.desc || ''}</span></button>`.s;
    });
    list.innerHTML = out;
  };
  const hl = () => { $$('.pi', list).forEach(b => b.classList.toggle('on', +b.dataset.i === sel)); const on = list.querySelector('.pi.on'); on && on.scrollIntoView({ block: 'nearest' }); };
  const run = i => { const it = items[i]; closePalette(); if (it) setTimeout(() => it.run(), 60); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  const itemMenu = (i, at) => {
    const it = items[i]; if (!it) return;
    sel = i; hl();
    const given = (it.menu ? it.menu() : null) || [];
    const wrap = x => (!x || x === '-' || x.header ? x : { ...x, run: () => { closePalette(); setTimeout(() => x.run && x.run(), 60); } });
    const list2 = given.length ? given.filter(Boolean).map(wrap) : [{ label: 'Open', ic: it.ic || 'chevron', run: () => run(i) }];
    menu(list2, at, { onClose: () => { if (pal) input.focus({ preventScroll: true }); } });
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; hl(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; hl(); } }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); const b = list.querySelector('.pi.on'); if (b) itemMenu(sel, b); }
  });
  list.addEventListener('click', e => { const b = e.target.closest('.pi'); if (b) run(+b.dataset.i); });
  list.addEventListener('contextmenu', e => { const b = e.target.closest('.pi'); e.preventDefault(); if (b) itemMenu(+b.dataset.i, { x: e.clientX, y: e.clientY }); });
  list.addEventListener('pointermove', e => { const b = e.target.closest('.pi'); if (b && +b.dataset.i !== sel) { sel = +b.dataset.i; hl(); } });
  scrim.addEventListener('pointerdown', () => closePalette());
  const pop = pushEsc(() => closePalette());
  pal = { scrim, box, pop, back };
  draw(); input.focus();
  animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  animate(box, [{ opacity: 0, transform: 'translateX(-50%) translateY(-12px) scale(0.96)' }, { opacity: 1, transform: 'translateX(-50%)' }], { duration: 420, easing: SPRING });
}
export function closePalette() {
  if (!pal) return;
  const { scrim, box, pop, back } = pal; pal = null; pop();
  box.style.pointerEvents = scrim.style.pointerEvents = 'none';
  animate(box, [{ opacity: 1, transform: 'translateX(-50%)' }, { opacity: 0, transform: 'translateX(-50%) translateY(-8px) scale(0.97)' }], { duration: 160, fill: 'forwards', easing: SMOOTH });
  animate(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).then(() => { scrim.remove(); box.remove(); back && back.focus && back.focus({ preventScroll: true }); });
}

/* ---------- side sheet ---------- */
let sheetOpen = null;
export function sheet({ title, body, onMount }) {
  closeSheet();
  const scrim = el('<div class="scrim" style="background:rgb(4 5 8 / .3)"></div>');
  const box = el(html`<aside class="sheet" role="dialog" aria-label="${title}"><div class="sh"><h3>${title}</h3><button class="ib" data-x aria-label="Close">${icon('close', 18)}</button></div><div class="sb">${body}</div></aside>`);
  document.body.append(scrim, box);
  const pop = pushEsc(closeSheet);
  sheetOpen = { scrim, box, pop };
  box.querySelector('[data-x]').onclick = closeSheet;
  scrim.addEventListener('pointerdown', closeSheet);
  animate(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
  animate(box, [{ opacity: 0, transform: 'translateX(40px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: SPRING });
  if (onMount) onMount(box);
  return box;
}
export function closeSheet() {
  if (!sheetOpen) return;
  const { scrim, box, pop } = sheetOpen; sheetOpen = null; pop();
  box.style.pointerEvents = scrim.style.pointerEvents = 'none';
  animate(box, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(30px)' }], { duration: 220, fill: 'forwards', easing: SMOOTH });
  animate(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).then(() => { scrim.remove(); box.remove(); });
}

/* ---------- segmented control with a sliding thumb ---------- */
export function seg(root, value, onChange) {
  let thumb = root.querySelector('.thumb');
  if (!thumb) { thumb = el('<span class="thumb"></span>'); root.prepend(thumb); }
  const place = () => {
    const on = root.querySelector(`button[data-v="${CSS.escape(String(value))}"]`);
    $$('button', root).forEach(b => b.classList.toggle('on', b === on));
    if (on) { thumb.style.left = on.offsetLeft + 'px'; thumb.style.width = on.offsetWidth + 'px'; }
  };
  root.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b || b.dataset.v === String(value)) return; value = b.dataset.v; place(); onChange(value); });
  requestAnimationFrame(place);
  return { set(v) { value = v; place(); } };
}
