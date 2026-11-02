/* classic.js — the bridge to the archived classic interface. The choice lives in
   localStorage 'simplex.ui' ('next' | 'classic'); ui2-boot.js in the classic page
   reads the same key, so both sides agree on where a visitor belongs. */
import { html, icon, lsSet } from './lib.js';
import { dialog } from './ui.js';

export const UI_KEY = 'simplex.ui';

/* leave for the classic interface (and stay there until the user switches back) */
export function openClassic(path = '/') {
  lsSet(UI_KEY, 'classic');
  const p = String(path || '/');
  location.href = p + (p.includes('?') ? '&' : '?') + 'ui=classic';
}

/* every app the classic interface has; only `ready` ones exist in the new UI */
export const APPS = [
  { id: 'database', name: 'Database', ic: 'database', desc: 'Files, media & folders', ready: true },
  { id: 'ai', name: 'AI', ic: 'spark', desc: 'Chat, tools & image edits', ready: true },
  { id: 'vms', name: 'Virtual machines', ic: 'desktop', desc: 'Disposable Windows desktops', ready: true, needs: 'vm' },
  { id: 'notes', name: 'Notes', ic: 'note', desc: 'Encrypted notes & docs' },
  { id: 'code', name: 'Code', ic: 'code', desc: 'Edit & run code' },
  { id: 'music', name: 'Music', ic: 'audio', desc: 'Library & listening together' },
  { id: 'photos', name: 'Photos', ic: 'image', desc: 'Shared albums' },
  { id: 'connect', name: 'Connect', ic: 'window', desc: 'Rooms, calls & screen share' },
  { id: 'tools', name: 'Tools', ic: 'wrench', desc: 'Converter & Series Maker', ready: true },
  { id: 'connectors', name: 'Connectors', ic: 'plug', desc: 'Link services' },
  { id: 'neural', name: 'Neural', ic: 'brain', desc: 'Train your own model' },
  { id: 'analytics', name: 'Analytics', ic: 'chart', desc: 'How you use Simplex' },
  { id: 'trading', name: 'Trading', ic: 'trend', desc: 'AI trader' },
  { id: 'visual', name: 'Simplex Visual', ic: 'model3d', desc: '2D game engine' },
  { id: 'bugs', name: 'Bug Reports', ic: 'bug', desc: 'Report & triage bugs' },
  { id: 'discord', name: 'Discord Bot', ic: 'chat', desc: 'Voice assistant', adminOnly: true },
  { id: 'settings', name: 'Classic settings', ic: 'settings', desc: 'Members, appearance, AI…' },
];
export const visibleApps = account => APPS.filter(a => (!a.adminOnly || (account && account.is_admin)) && (a.needs !== 'vm' || (account && (account.is_admin || account.can_vm))));

/* an app that hasn't been rebuilt: explain, then offer to switch */
export function lockedApp(app) {
  dialog({
    ic: app.ic, title: `${app.name} isn’t in the new Simplex yet`,
    text: 'It’s still being rebuilt. To use it now, switch back to the classic interface — you can return any time with the “New Simplex” button in its bottom corner, or from its Settings.',
    body: html`<div class="chip">${icon('lock', 12, 2)} Locked in the new interface</div>`,
    actions: [{ label: 'Stay here' }, { label: 'Switch to classic', kind: 'pri', run: () => openClassic('/' + app.id) }],
  });
}
