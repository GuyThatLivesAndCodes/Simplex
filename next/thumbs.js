/* thumbs.js — the ONLY way the new UI loads thumbnail images.
 *
 * Why it exists: video posters (/api/files/:id/poster) are rendered server-side
 * by ffmpeg, two at a time; the rest wait in the server's queue with their HTTP
 * connection held open. A browser gets ~6 connections per host over HTTP/1.1, so
 * firing every visible thumbnail at once used to pin all of them on pending
 * posters — the video stream and even page reloads then had nothing left to use
 * and the site looked frozen. So:
 *   - at most MAX images load at once, and at most MAX_POSTER of those are posters
 *   - the queue pauses while media plays (playback gets the connections)
 *   - leaving a view cancels its queued + in-flight loads
 *   - a poster that failed once isn't retried this session
 */
const MAX = 3, MAX_POSTER = 1;
const isPoster = u => /\/poster(\?|$)/.test(u);
let queue = [], active = 0, activePoster = 0, paused = 0;
const failed = new Set();

/* img: an <img data-src>; onFail(img) swaps in a fallback icon */
export function loadThumb(img, onFail) {
  const url = img.dataset.src;
  if (!url) return;
  if (failed.has(url)) { onFail && onFail(img); return; }
  queue.push({ img, url, onFail });
  pump();
}

function pump() {
  if (paused) return;
  for (let i = 0; i < queue.length && active < MAX;) {
    const job = queue[i];
    if (!job.img.isConnected) { queue.splice(i, 1); continue; }
    const poster = isPoster(job.url);
    if (poster && activePoster >= MAX_POSTER) { i++; continue; }
    queue.splice(i, 1);
    start(job, poster);
  }
}

function start({ img, url, onFail }, poster) {
  active++; if (poster) activePoster++;
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    active--; if (poster) activePoster--;
    clearTimeout(timer);
    if (ok) img.classList.add('ok');
    else { failed.add(url); if (img.isConnected && onFail) onFail(img); }
    pump();
  };
  // a slow poster can't hold a slot forever: give up after 25s (it's just a thumbnail)
  const timer = setTimeout(() => { img.removeAttribute('src'); finish(false); }, poster ? 25000 : 15000);
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  img._cancel = () => { img.removeAttribute('src'); finish(true); };
  img.src = url;
  img.removeAttribute('data-src');
}

/* drop everything queued, and abort in-flight loads inside `scope` (a view being left) */
export function cancelThumbs(scope) {
  queue = scope ? queue.filter(j => !scope.contains(j.img)) : [];
  if (scope) scope.querySelectorAll('img').forEach(i => { if (i._cancel && !i.classList.contains('ok')) i._cancel(); });
}
/* media playback holds the line: no new thumbnail loads until it's released */
export function pauseThumbs() { paused++; }
export function resumeThumbs() { paused = Math.max(0, paused - 1); pump(); }

/* watch a container: thumbnails start loading as they near the viewport */
export function lazy(container, onFail) {
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    loadThumb(e.target, onFail);
  }), { rootMargin: '300px' });
  container.querySelectorAll('img[data-src]:not([data-lz])').forEach(i => { i.setAttribute('data-lz', ''); io.observe(i); });
  return io;
}
