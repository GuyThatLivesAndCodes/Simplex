/* ============================================================
   PHOTOS app (apps-photos.js) — shared photo albums, loaded on demand
   (openApp -> openLazyApp -> loadFeature("apps-photos")). Plain non-module script
   sharing app.js's global scope, like the other apps-*.js files. The tiny CORE bits
   that must exist before this file loads (the PH state object, phOnPhotos() and
   photosOpenAlbum(), used by the router) live in app.js.
   See [[photos-app]] and [[lazy-loading-architecture]].
   ============================================================ */
/* ============================================================
   PHOTOS

   A picture-only space built around ALBUMS you share with specific people. This is
   the deliberate difference from Music: Music is ONE global library everyone sees,
   whereas a photo album here is private by default — visible only to its owner and
   the people invited to it. That's what makes "one album the whole family adds to"
   work without opening the pictures up to every account on the server.

   Adding a photo COPIES its bytes into the shared Photos store (see server.js), so an
   album never depends on the uploader's vault: if they later delete the original, the
   album still has the picture.

   Roles, enforced on the server and mirrored in the UI:
     owner        — rename, invite/remove people, set the cover, delete the album,
                    and remove ANY photo in it.
     contributor  — add photos, and manage the ones they added.
     viewer       — look and comment only.
   ============================================================ */

function photosHTML() {
  return `<div class="ph-app" data-screen-label="Photos">
    <div class="ph-head">
      <div>
        <h2 class="ph-title">${svg('image', 20, 1.8)} Photos</h2>
        <p class="ph-sub">Albums you share with the people you choose. Add from your vault — everyone invited sees them.</p>
      </div>
      <div class="ph-head-acts">
        <button class="btn primary sm" id="phNew">${svg('plus', 14)} New album</button>
        <button class="btn ghost sm" id="phRefresh">${svg('refresh', 14)} Refresh</button>
      </div>
    </div>
    <div id="phBody"><div class="ph-loading">${svg('image', 28)}<span>Loading your photos…</span></div></div>
  </div>`;
}

async function wirePhotos() {
  const nb = document.getElementById('phNew');
  const rb = document.getElementById('phRefresh');
  if (nb) nb.onclick = phNewAlbum;
  if (rb) rb.onclick = () => loadPhotos();
  _appCleanup = null;
  await loadPhotos();
}

/* load the album list (the app's home view). If an album is open, refresh that. */
async function loadPhotos() {
  const body = document.getElementById('phBody');
  if (!body) return;
  try {
    const data = await photosAlbums();
    PH.albums = data.albums || [];
    if (!phOnPhotos()) return;
    if (PH.openAlbum) await photosOpenAlbum(PH.openAlbum.id, true);
    else renderPhotosBody();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    body.innerHTML = `<div class="ph-loading">${svg('info', 24)}<span>Couldn't load your photos.</span></div>`;
  }
}

function renderPhotosBody() {
  const body = document.getElementById('phBody');
  if (!body) return;
  body.innerHTML = PH.openAlbum ? phAlbumDetailHTML() : phAlbumsHTML();
  wirePhotosBody();
  phObserveThumbs(body);   // thumbnails load only as they scroll into view
}

/* ---- thumbnails are LAZY: emit an <img> with no src and the url on data-thumb, and
   let an IntersectionObserver fill it in as cards approach the viewport. An album can
   hold hundreds of photos; loading every thumbnail at once would swamp the connection
   (the same reason the Music grid lazies its covers). ---- */
function phObserveThumbs(root) {
  const imgs = (root || document).querySelectorAll('img[data-thumb]');
  if (!imgs.length) return;
  if (!('IntersectionObserver' in window)) { imgs.forEach(im => { im.src = im.dataset.thumb; im.removeAttribute('data-thumb'); }); return; }
  const io = new IntersectionObserver((entries, obs) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const im = en.target;
      if (im.dataset.thumb) { im.src = im.dataset.thumb; im.removeAttribute('data-thumb'); }
      obs.unobserve(im);
    }
  }, { rootMargin: '400px 0px' });   // start fetching before they're actually on screen
  imgs.forEach(im => io.observe(im));
}

function phMemberLine(a) {
  const others = (a.members || []).length;
  if (!others) return a.role === 'owner' ? 'Only you' : `Shared by ${esc(a.ownerName)}`;
  const names = (a.members || []).slice(0, 2).map(m => esc(m.name)).join(', ');
  const extra = others > 2 ? ` +${others - 2}` : '';
  return a.role === 'owner' ? `Shared with ${names}${extra}` : `${esc(a.ownerName)}, ${names}${extra}`;
}

/* ---------- the album grid (app home) ---------- */
function phAlbumsHTML() {
  if (!PH.albums.length) {
    return `<div class="ph-empty">
      ${svg('image', 40)}
      <h3>No albums yet</h3>
      <p>An album is a set of photos you share with the people you pick. Make one, invite them, and everybody can add pictures to it.</p>
      <button class="btn primary" data-phnew>${svg('plus', 14)} New album</button>
    </div>`;
  }
  const mine = PH.albums.filter(a => a.role === 'owner');
  const shared = PH.albums.filter(a => a.role !== 'owner');
  const section = (title, list, dek) => !list.length ? '' : `
    <div class="ph-section">
      <div class="ph-section-head"><h3>${esc(title)}</h3><span class="ph-section-dek">${esc(dek)}</span></div>
      <div class="ph-albums">${list.map(phAlbumCardHTML).join('')}</div>
    </div>`;
  return section('Your albums', mine, 'You own these — invite people and set who can add.')
       + section('Shared with you', shared, 'Albums other people invited you to.');
}

function phAlbumCardHTML(a) {
  const cover = a.coverUrl
    ? `<img data-thumb="${esc(a.coverUrl)}" alt="" loading="lazy" />`
    : `<div class="ph-album-ph">${svg('image', 26)}</div>`;
  return `<button type="button" class="ph-album" data-album="${esc(a.id)}">
    <div class="ph-album-art">${cover}<span class="ph-album-count">${a.count} photo${a.count !== 1 ? 's' : ''}</span></div>
    <div class="ph-album-meta">
      <div class="ph-album-name" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="ph-album-sub">${phMemberLine(a)}</div>
    </div>
  </button>`;
}

/* ---------- one album: the photo grid ---------- */
function phAlbumDetailHTML() {
  const a = PH.openAlbum;
  const photos = a.photos || [];
  const roleChip = a.role === 'owner' ? 'Owner' : a.role === 'viewer' ? 'Can view' : 'Can add';
  const people = [{ id: a.ownerId, name: a.ownerName, role: 'owner' }].concat(a.members || []);

  const grid = photos.length
    ? `<div class="ph-grid">${photos.map((p, i) => phPhotoCardHTML(p, i)).join('')}</div>`
    : `<div class="ph-empty sm">
         ${svg('image', 34)}
         <h3>This album is empty</h3>
         <p>${a.canAdd ? 'Add photos from your vault — everyone in the album will see them.' : 'Nobody has added photos to this album yet.'}</p>
         ${a.canAdd ? `<button class="btn primary" data-phadd>${svg('plus', 14)} Add photos</button>` : ''}
       </div>`;

  return `<div class="ph-detail">
    <div class="ph-detail-head">
      <button class="btn ghost sm" data-phback>${svg('back', 14)} All albums</button>
      <div class="ph-detail-acts">
        ${a.canAdd ? `<button class="btn primary sm" data-phadd>${svg('plus', 14)} Add photos</button>` : ''}
        ${a.canManage ? `<button class="btn ghost sm" data-phshare>${svg('share', 14)} Share</button>` : ''}
        <button class="btn ghost sm" data-phmore>${svg('more', 14)}</button>
      </div>
    </div>
    <div class="ph-detail-title">
      <h3>${esc(a.name)}<span class="ph-role-chip">${esc(roleChip)}</span></h3>
      ${a.note ? `<p class="ph-detail-note">${esc(a.note)}</p>` : ''}
      <div class="ph-detail-stats">
        <span>${photos.length} photo${photos.length !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span>${fmtSize(a.totalSize || 0)}</span>
        <span>·</span>
        <span class="ph-people">${people.map(m => `<span class="ph-person" title="${esc(m.role === 'owner' ? 'Owner' : m.role === 'viewer' ? 'Can view' : 'Can add')}">${esc(m.name)}</span>`).join('')}</span>
      </div>
    </div>
    ${grid}
  </div>`;
}

function phPhotoCardHTML(p, i) {
  const who = esc(p.ownerName || '');
  return `<button type="button" class="ph-tile" data-photo="${esc(p.id)}" data-idx="${i}">
    <img data-thumb="${esc(p.thumbUrl)}" alt="${esc(p.caption || '')}" loading="lazy" />
    <span class="ph-tile-veil">
      <span class="ph-tile-cap">${esc(p.caption || '')}</span>
      <span class="ph-tile-by">${who}${p.comments ? ` · ${svg('note', 11)} ${p.comments}` : ''}</span>
    </span>
  </button>`;
}

function wirePhotosBody() {
  const body = document.getElementById('phBody');
  if (!body) return;

  body.querySelectorAll('[data-phnew]').forEach(b => b.onclick = phNewAlbum);
  body.querySelectorAll('[data-album]').forEach(b => {
    b.onclick = () => photosOpenAlbum(b.dataset.album);
    b.oncontextmenu = (e) => { e.preventDefault(); phAlbumMenu(e.clientX, e.clientY, b.dataset.album); };
  });

  const back = body.querySelector('[data-phback]');
  if (back) back.onclick = () => { PH.openAlbum = null; syncUrl(); renderPhotosBody(); };

  body.querySelectorAll('[data-phadd]').forEach(b => b.onclick = phAddFromVault);
  const share = body.querySelector('[data-phshare]');
  if (share) share.onclick = () => phManageMembers(PH.openAlbum);
  const more = body.querySelector('[data-phmore]');
  if (more) more.onclick = (e) => { const r = more.getBoundingClientRect(); phAlbumMenu(r.left, r.bottom + 4, PH.openAlbum.id); };

  body.querySelectorAll('[data-photo]').forEach(b => {
    b.onclick = () => phOpenLightbox(Number(b.dataset.idx));
    b.oncontextmenu = (e) => { e.preventDefault(); phPhotoMenu(e.clientX, e.clientY, b.dataset.photo); };
  });
}

/* ---------- open an album (also the router's entry point for /photos/album/<id>) ---------- */
async function photosOpenAlbumImpl(id, quiet) {
  try {
    const data = await photosAlbum(id);
    PH.openAlbum = data;
    if (!phOnPhotos()) return;
    renderPhotosBody();
    if (!quiet) syncUrl();
  } catch (e) {
    if (e && e.code === 'AUTH') return relock();
    toast('Could not open that album', 'close');
    PH.openAlbum = null;
    renderPhotosBody();
  }
}

/* ---------- create / edit / delete an album ---------- */
function phNewAlbum() {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>New album</h3>
    <p>Give it a name. You can invite people right after.</p>
    <label class="ph-field"><span>Name</span><input id="phAlbName" placeholder="Family photos" maxlength="120" autocomplete="off" /></label>
    <label class="ph-field"><span>Note <em>(optional)</em></span><input id="phAlbNote" placeholder="Everything from this summer" maxlength="500" autocomplete="off" /></label>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Create album</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const nameEl = bg.querySelector('#phAlbName');
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const submit = async () => {
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    close();
    try {
      const r = await photosCreateAlbum(name, bg.querySelector('#phAlbNote').value.trim(), []);
      toast('Album created');
      await loadPhotos();
      // straight into "who's it shared with" — making an album is almost always
      // followed by inviting the people it's for.
      if (r.album) { await photosOpenAlbum(r.album.id); phManageMembers(PH.openAlbum); }
    } catch (e) { toast(e.message || 'Could not create the album', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = submit;
  nameEl.onkeydown = e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); };
  setTimeout(() => nameEl.focus(), 30);
}

function phEditAlbum(a) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>Album details</h3>
    <label class="ph-field"><span>Name</span><input id="phAlbName" maxlength="120" autocomplete="off" /></label>
    <label class="ph-field"><span>Note <em>(optional)</em></span><input id="phAlbNote" maxlength="500" autocomplete="off" /></label>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>
  </div>`;
  document.body.appendChild(bg);
  const nameEl = bg.querySelector('#phAlbName'); nameEl.value = a.name || '';
  const noteEl = bg.querySelector('#phAlbNote'); noteEl.value = a.note || '';
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const submit = async () => {
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    close();
    try {
      await photosUpdateAlbum(a.id, { name, note: noteEl.value.trim() });
      toast('Saved');
      await loadPhotos();
    } catch (e) { toast(e.message || 'Could not save', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = submit;
  nameEl.onkeydown = e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); };
  setTimeout(() => nameEl.focus(), 30);
}

/* ---------- who the album is shared with ---------- */
async function phManageMembers(a) {
  if (!a) return;
  let all = [];
  try { all = (await photosMembers()).members || []; } catch (e) { toast('Could not load the member list', 'close'); return; }
  const me = (ACCOUNT && ACCOUNT.id) || null;
  // the owner is implicit — never listed as someone to invite or remove
  const pickable = all.filter(m => m.id !== a.ownerId);
  const roles = new Map((a.members || []).map(m => [m.id, m.role || 'contributor']));

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ph-share-modal">
    <h3>Share “${esc(a.name)}”</h3>
    <p>Pick who can see this album. <strong>Can add</strong> lets them put their own photos in; <strong>Can view</strong> is look-and-comment only.</p>
    <div class="ph-share-list" id="phShareList"></div>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save sharing</button></div>
  </div>`;
  document.body.appendChild(bg);
  const list = bg.querySelector('#phShareList');
  const close = () => bg.remove();

  const render = () => {
    if (!pickable.length) { list.innerHTML = `<p class="ph-share-empty">There are no other accounts on this server yet.</p>`; return; }
    list.innerHTML = pickable.map(m => {
      const on = roles.has(m.id);
      const role = roles.get(m.id) || 'contributor';
      return `<div class="ph-share-row ${on ? 'on' : ''}" data-mid="${esc(m.id)}">
        <label class="ph-share-who">
          <input type="checkbox" data-mtoggle ${on ? 'checked' : ''} />
          <span>${esc(m.name)}${m.id === me ? ' (you)' : ''}</span>
        </label>
        <select class="ph-share-role" data-mrole ${on ? '' : 'disabled'}>
          <option value="contributor"${role !== 'viewer' ? ' selected' : ''}>Can add</option>
          <option value="viewer"${role === 'viewer' ? ' selected' : ''}>Can view</option>
        </select>
      </div>`;
    }).join('');
    list.querySelectorAll('.ph-share-row').forEach(row => {
      const id = row.dataset.mid;
      const box = row.querySelector('[data-mtoggle]');
      const sel = row.querySelector('[data-mrole]');
      box.onchange = () => {
        if (box.checked) roles.set(id, sel.value); else roles.delete(id);
        row.classList.toggle('on', box.checked);
        sel.disabled = !box.checked;
      };
      sel.onchange = () => { if (roles.has(id)) roles.set(id, sel.value); };
    });
  };
  render();

  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    close();
    try {
      await photosSetMembers(a.id, [...roles.entries()].map(([id, role]) => ({ id, role })));
      toast('Sharing updated');
      await loadPhotos();
    } catch (e) { toast(e.message || 'Could not update sharing', 'close'); }
  };
}

/* ---------- album "…" menu ---------- */
function phAlbumMenu(x, y, albumId) {
  const a = (PH.openAlbum && PH.openAlbum.id === albumId) ? PH.openAlbum : PH.albums.find(al => al.id === albumId);
  if (!a) return;
  if (typeof hideCtx === 'function') hideCtx();
  const items = [{ head: a.name }];
  items.push({ ic: 'eye', label: 'Open', fn: () => photosOpenAlbum(a.id) });
  if (a.canAdd) items.push({ ic: 'plus', label: 'Add photos…', fn: async () => { if (!PH.openAlbum || PH.openAlbum.id !== a.id) await photosOpenAlbum(a.id); phAddFromVault(); } });
  if (a.canManage) {
    items.push({ div: true });
    items.push({ ic: 'rename', label: 'Album details…', fn: () => phEditAlbum(a) });
    items.push({ ic: 'share', label: 'Share with…', fn: async () => { const full = (PH.openAlbum && PH.openAlbum.id === a.id) ? PH.openAlbum : (await photosAlbum(a.id)); phManageMembers(full); } });
  }
  items.push({ div: true });
  if (a.role !== 'owner') {
    items.push({ ic: 'close', label: 'Leave album', danger: true, fn: () => {
      confirmModal('Leave this album?', `You'll stop seeing “${a.name}”. The owner can always invite you back.`, async () => {
        try { await photosLeaveAlbum(a.id); toast('Left the album'); PH.openAlbum = null; syncUrl(); await loadPhotos(); } catch (e) { toast(e.message || 'Failed', 'close'); }
      }, 'Leave');
    } });
  }
  if (a.canManage) {
    items.push({ ic: 'trash', label: 'Delete album', danger: true, fn: () => {
      confirmModal('Delete this album?', `“${a.name}” and its ${a.count} photo${a.count !== 1 ? 's' : ''} are deleted for everyone it's shared with. Photos still in your vault are untouched.`, async () => {
        try { await photosDeleteAlbum(a.id); toast('Album deleted'); PH.openAlbum = null; syncUrl(); await loadPhotos(); } catch (e) { toast(e.message || 'Failed', 'close'); }
      });
    } });
  }
  const panel = buildCtxPanel(items);
  document.body.appendChild(panel);
  if (typeof ctxEl !== 'undefined') ctxEl = panel;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  panel.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

/* ---------- per-photo menu ---------- */
function phPhotoMenu(x, y, photoId) {
  const a = PH.openAlbum; if (!a) return;
  const p = (a.photos || []).find(ph => ph.id === photoId); if (!p) return;
  const me = (ACCOUNT && ACCOUNT.id) || null;
  const canEdit = a.canManage || p.ownerId === me;
  if (typeof hideCtx === 'function') hideCtx();

  const items = [{ head: p.caption || 'Photo' }];
  items.push({ ic: 'eye', label: 'View', fn: () => phOpenLightbox((a.photos || []).indexOf(p)) });
  items.push({ ic: 'download', label: 'Save to my vault…', fn: () => phSaveToVault(p.id) });
  if (canEdit) {
    items.push({ div: true });
    items.push({ ic: 'rename', label: 'Edit caption…', fn: () => phEditCaption(p) });
  }
  if (a.canManage) items.push({ ic: 'star', label: 'Make album cover', fn: async () => {
    try { await photosUpdateAlbum(a.id, { coverPhotoId: p.id }); toast('Album cover set'); await loadPhotos(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  } });
  if (canEdit) {
    items.push({ div: true });
    items.push({ ic: 'trash', label: 'Remove from album', danger: true, fn: () => {
      confirmModal('Remove this photo?', "It's removed for everyone in the album. The copy in your vault is untouched.", async () => {
        try { await photosRemoveItem(p.id); toast('Removed'); await loadPhotos(); } catch (e) { toast(e.message || 'Failed', 'close'); }
      }, 'Remove');
    } });
  }
  const panel = buildCtxPanel(items);
  document.body.appendChild(panel);
  if (typeof ctxEl !== 'undefined') ctxEl = panel;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  panel.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

function phEditCaption(p) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>Caption</h3>
    <label class="ph-field"><span>What's happening in this photo?</span><input id="phCap" maxlength="200" autocomplete="off" /></label>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>
  </div>`;
  document.body.appendChild(bg);
  const el = bg.querySelector('#phCap'); el.value = p.caption || '';
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  const submit = async () => {
    close();
    try { await photosUpdateItem(p.id, { caption: el.value.trim() }); toast('Saved'); await loadPhotos(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  };
  bg.querySelector('[data-ok]').onclick = submit;
  el.onkeydown = e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); };
  setTimeout(() => el.focus(), 30);
}

/* ---------- add photos from the vault (the copy-on-add flow) ---------- */
async function phAddFromVault() {
  const a = PH.openAlbum;
  if (!a) return;
  if (!a.canAdd) { toast('You can only view this album', 'close'); return; }
  // Photos can be opened without ever visiting the Database, so the vault file list
  // may not be loaded yet — load it on demand (no-op if already cached).
  try { await ensureAiDB(); } catch (e) { if (e && e.code === 'AUTH') return relock(); }
  const images = allOfType('image').filter(f => !f.locked);
  const nameOf = (f) => (f.name || '').replace(/\.[^.]+$/, '') || f.name || 'Photo';
  const already = new Set((a.photos || []).map(p => (p.caption || '').toLowerCase()));

  phPhotoPicker({
    title: `Add photos to “${a.name}”`,
    dek: 'Pick pictures from your vault — each is copied into the album so everyone invited can see it.',
    searchPlaceholder: 'Search your photos…',
    emptyText: 'No unlocked images in your vault yet. Upload some in the Database app first.',
    items: images,
    get: { id: f => f.id, title: nameOf, thumb: f => (f.posterUrl || f.url || null), size: f => f.size },
    badge: f => already.has(nameOf(f).toLowerCase()) ? 'In album' : null,
    confirmLabel: n => `Add ${n} photo${n !== 1 ? 's' : ''}`,
    countText: n => `${n} photo${n !== 1 ? 's' : ''} in your vault`,
    onConfirm: async (ids) => {
      let added = 0, dup = 0, fail = 0;
      toast(`Adding ${ids.length} photo${ids.length !== 1 ? 's' : ''}…`);
      for (const id of ids) {
        try { const r = await photosAddItem(a.id, id); if (r.duplicate) dup++; else added++; }
        catch (e) { fail++; }
      }
      await loadPhotos();
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (dup) parts.push(`${dup} already in the album`);
      if (fail) parts.push(`${fail} failed`);
      toast(parts.join(' · ') || 'Done', fail ? 'close' : 'save');
    },
  });
}

/* A multi-select picker for vault images. Same shape as the Music song picker, but
   image-first: a big thumbnail grid, since you pick photos by looking at them. */
function phPhotoPicker(opts) {
  const g = opts.get;
  const items = opts.items || [];
  const sel = new Set();
  let filter = '';

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ph-pick-modal">
    <div class="ph-pick-head">
      <div>
        <h3>${esc(opts.title)}</h3>
        ${opts.dek ? `<p class="ph-pick-dek">${esc(opts.dek)}</p>` : ''}
      </div>
    </div>
    <div class="ph-pick-toolbar">
      <div class="ph-pick-search">${svg('image', 14)}<input id="phPickSearch" placeholder="${esc(opts.searchPlaceholder || 'Search…')}" autocomplete="off" /></div>
      <label class="ph-pick-all"><input type="checkbox" id="phPickAll" /> <span>Select all</span></label>
    </div>
    <div class="ph-pick-body" id="phPickBody"></div>
    <div class="acts">
      <span class="ph-pick-count" id="phPickCount"></span>
      <button class="btn ghost" data-cancel>Cancel</button>
      <button class="btn primary" data-ok disabled>Add selected</button>
    </div>
  </div>`;
  document.body.appendChild(bg);

  const body = bg.querySelector('#phPickBody');
  const okBtn = bg.querySelector('[data-ok]');
  const countEl = bg.querySelector('#phPickCount');
  const allBox = bg.querySelector('#phPickAll');
  const close = () => bg.remove();

  const visible = () => {
    const q = filter.trim().toLowerCase();
    return items.filter(it => !q || (g.title(it) || '').toLowerCase().includes(q));
  };

  function syncFooter() {
    const vis = visible();
    okBtn.disabled = sel.size === 0;
    okBtn.textContent = sel.size ? (opts.confirmLabel ? opts.confirmLabel(sel.size) : 'Add ' + sel.size) : 'Add selected';
    countEl.textContent = sel.size ? `${sel.size} selected` : (opts.countText ? opts.countText(items.length) : `${items.length} photos`);
    const visIds = vis.map(g.id);
    allBox.checked = visIds.length > 0 && visIds.every(id => sel.has(id));
    allBox.indeterminate = !allBox.checked && visIds.some(id => sel.has(id));
  }

  function render() {
    const vis = visible();
    if (!items.length) { body.innerHTML = `<div class="ph-pick-empty">${svg('image', 28)}<p>${esc(opts.emptyText || 'Nothing to add.')}</p></div>`; syncFooter(); return; }
    if (!vis.length) { body.innerHTML = `<div class="ph-pick-empty">${svg('image', 24)}<p>No matches for “${esc(filter)}”.</p></div>`; syncFooter(); return; }
    body.innerHTML = vis.map(it => {
      const id = g.id(it), title = esc(g.title(it)), badge = opts.badge && opts.badge(it), thumb = g.thumb(it);
      return `<button type="button" class="ph-pick-card ${sel.has(id) ? 'sel' : ''}" data-pick="${esc(id)}">
        <div class="ph-pick-art">
          ${thumb ? `<img data-thumb="${esc(thumb)}" alt="" loading="lazy" />` : `<div class="ph-pick-ph">${svg('image', 18)}</div>`}
          <span class="ph-pick-tick">${svg('check', 14)}</span>
          ${badge ? `<span class="ph-pick-have">${esc(badge)}</span>` : ''}
        </div>
        <div class="ph-pick-t" title="${title}">${title}</div>
        <div class="ph-pick-s">${fmtSize(g.size(it) || 0)}</div>
      </button>`;
    }).join('');
    body.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      const id = el.dataset.pick;
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      el.classList.toggle('sel', sel.has(id));
      syncFooter();
    });
    phObserveThumbs(body);
    syncFooter();
  }

  bg.querySelector('#phPickSearch').oninput = (e) => { filter = e.target.value; render(); };
  allBox.onclick = () => {
    const vis = visible();
    const allSel = vis.every(it => sel.has(g.id(it)));
    vis.forEach(it => { const id = g.id(it); if (allSel) sel.delete(id); else sel.add(id); });
    render();
  };
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('#phPickSearch').onkeydown = e => { if (e.key === 'Escape') close(); };
  okBtn.onclick = () => { const ids = Array.from(sel); close(); if (ids.length) opts.onConfirm(ids); };

  render();
  setTimeout(() => { const s = bg.querySelector('#phPickSearch'); if (s) s.focus(); }, 30);
}

/* ---------- save a shared photo back into your own vault ---------- */
async function phSaveToVault(photoId) {
  const a = PH.openAlbum; if (!a) return;
  const p = (a.photos || []).find(ph => ph.id === photoId); if (!p) return;
  try { await ensureAiDB(); } catch (e) { if (e && e.code === 'AUTH') return relock(); }
  const folders = allOfType('folder');

  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>Save to my vault</h3>
    <p>Copies “${esc(p.caption || 'this photo')}” into your own encrypted vault. The album keeps its copy.</p>
    <label class="ph-field"><span>Destination folder</span>
      <select id="phDest">
        <option value="">Vault root</option>
        ${folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}
      </select>
    </label>
    <div class="acts"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary" data-ok>Save</button></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-cancel]').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => {
    const dest = bg.querySelector('#phDest').value || null;
    close();
    try { await photosSaveToVault(p.id, dest); toast('Saved to your vault'); }
    catch (e) { toast(e.message || 'Could not save', 'close'); }
  };
}

/* ---------- the lightbox: full-size viewing, arrow-key paging, comments ---------- */
function phOpenLightbox(idx) {
  const a = PH.openAlbum; if (!a) return;
  const photos = a.photos || [];
  if (!photos.length) return;
  PH.lightIdx = Math.max(0, Math.min(photos.length - 1, idx || 0));

  const w = document.createElement('div');
  w.id = 'phLightbox';
  w.className = 'ph-light';
  w.innerHTML = `
    <button class="ph-light-close" data-lclose title="Close">${svg('close', 18)}</button>
    <button class="ph-light-nav prev" data-lprev title="Previous">${svg('back', 22)}</button>
    <button class="ph-light-nav next" data-lnext title="Next">${svg('back', 22)}</button>
    <div class="ph-light-stage"><img id="phLightImg" alt="" /></div>
    <div class="ph-light-bar">
      <div class="ph-light-meta" id="phLightMeta"></div>
      <div class="ph-light-acts">
        <button class="btn ghost sm" data-lsave>${svg('download', 14)} Save to my vault</button>
        <button class="btn ghost sm" data-lcomments>${svg('note', 14)} Comments</button>
      </div>
    </div>
    <div class="ph-light-comments" id="phLightComments" hidden></div>`;
  document.body.appendChild(w);
  requestAnimationFrame(() => w.classList.add('show'));

  const close = () => {
    document.removeEventListener('keydown', onKey);
    w.classList.remove('show');
    setTimeout(() => w.remove(), 180);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowLeft') phLightStep(-1);
    else if (e.key === 'ArrowRight') phLightStep(1);
  };
  document.addEventListener('keydown', onKey);

  w.querySelector('[data-lclose]').onclick = close;
  w.onclick = (e) => { if (e.target === w || e.target.classList.contains('ph-light-stage')) close(); };
  w.querySelector('[data-lprev]').onclick = () => phLightStep(-1);
  w.querySelector('[data-lnext]').onclick = () => phLightStep(1);
  w.querySelector('[data-lsave]').onclick = () => { const p = (PH.openAlbum.photos || [])[PH.lightIdx]; if (p) phSaveToVault(p.id); };
  w.querySelector('[data-lcomments]').onclick = () => {
    const box = document.getElementById('phLightComments');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) phLoadComments();
  };

  phLightRender();
}

function phLightStep(d) {
  const photos = (PH.openAlbum && PH.openAlbum.photos) || [];
  if (!photos.length) return;
  PH.lightIdx = (PH.lightIdx + d + photos.length) % photos.length;
  phLightRender();
  const box = document.getElementById('phLightComments');
  if (box && !box.hidden) phLoadComments();
}

function phLightRender() {
  const photos = (PH.openAlbum && PH.openAlbum.photos) || [];
  const p = photos[PH.lightIdx];
  if (!p) return;
  const img = document.getElementById('phLightImg');
  const meta = document.getElementById('phLightMeta');
  if (img) { img.src = p.url; img.alt = p.caption || ''; }
  if (meta) {
    meta.innerHTML = `<div class="ph-light-cap">${esc(p.caption || 'Untitled')}</div>
      <div class="ph-light-sub">Added by ${esc(p.ownerName || 'someone')} · ${fmtDate(p.created)} · ${PH.lightIdx + 1} of ${photos.length}</div>`;
  }
}

async function phLoadComments() {
  const box = document.getElementById('phLightComments');
  const p = ((PH.openAlbum && PH.openAlbum.photos) || [])[PH.lightIdx];
  if (!box || !p) return;
  box.innerHTML = `<div class="ph-cm-loading">Loading comments…</div>`;
  let comments = [];
  try { comments = (await photosComments(p.id)).comments || []; }
  catch (e) { box.innerHTML = `<div class="ph-cm-loading">Couldn't load comments.</div>`; return; }

  box.innerHTML = `
    <div class="ph-cm-list">${comments.length
      ? comments.map(c => `<div class="ph-cm" data-cm="${esc(c.id)}">
          <div class="ph-cm-head"><strong>${esc(c.authorName)}</strong><span>${fmtDate(c.created)}</span>
            ${c.canDelete ? `<button class="ph-cm-del" data-cmdel="${esc(c.id)}" title="Delete">${svg('close', 12)}</button>` : ''}</div>
          <div class="ph-cm-text">${esc(c.text)}</div>
        </div>`).join('')
      : `<div class="ph-cm-empty">No comments yet — say something about this photo.</div>`}</div>
    <form class="ph-cm-form" id="phCmForm">
      <input id="phCmText" placeholder="Add a comment…" maxlength="1000" autocomplete="off" />
      <button class="btn primary sm" type="submit">Post</button>
    </form>`;

  box.querySelectorAll('[data-cmdel]').forEach(b => b.onclick = async () => {
    try { await photosDeleteComment(b.dataset.cmdel); phLoadComments(); } catch (e) { toast(e.message || 'Failed', 'close'); }
  });
  const form = box.querySelector('#phCmForm');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const el = box.querySelector('#phCmText');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    try { await photosAddComment(p.id, text); phLoadComments(); }
    catch (err) { toast(err.message || 'Could not post', 'close'); }
  };
}
