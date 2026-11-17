// Work Status section: the skills meter (live / installed, est. tokens). Only cached counts
// are written. The whole section opens the rail panel, where bundles are toggled.
// The frame only runs while the section is shown.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { errText } from '../shared/panel/host';
import { listenChanges } from '../panel/sync';
import { createStatusLoader, createStatusRefresher, renderMeterHeader, type SkillCounts } from './counts';
import { createCachedStatusPainter } from './cache';

const host = connectHost();
let currentDir: string | null = null;
let mounted = false;
let needFull = false;
let needImmediateScan = false;

function requestRefresh(fast = false, immediateScan = false) {
  if (!fast) needFull = true;
  if (immediateScan) needImmediateScan = true;
  void refresh();
}

host.onDirectory((dir) => {
  if (currentDir === dir) return;
  currentDir = dir;
  if (mounted) {
    void cachedPainter.select(currentDir);
    requestRefresh(true);
  }
});

const REFRESH_MS = 30_000;
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}
const fit = () => void host.setHeight(Math.ceil(document.body.scrollHeight));

function paint(c: SkillCounts) {
  const { wrap } = renderMeterHeader(c, { compact: true });
  $('head').replaceChildren(wrap);
  $('section').setAttribute('aria-label', `Skills: ${c.live} live of ${c.installed} installed. Open Skill Bundles`);
  fit();
}

const cachedPainter = createCachedStatusPainter(host, paint);
let loadTicket = 0;
const loader = createStatusLoader(host, {
  onRevalidated: (c) => { void cachedPainter.fresh(loadTicket, c); },
});

const refresh = createStatusRefresher(
  async () => {
    const forceScan = needFull;
    const forceImmediateScan = needImmediateScan;
    needFull = false;
    needImmediateScan = false;
    const ticket = cachedPainter.ticket();
    loadTicket = ticket;
    if (forceImmediateScan) loader.invalidateScanAge();
    const c = await loader.load(currentDir, { forceScan: forceScan || forceImmediateScan, forceImmediateScan });
    void cachedPainter.fresh(ticket, c);
    return c;
  },
  () => {},
  (e) => {
    if (!cachedPainter.isCurrent(loadTicket)) return;
    $('head').replaceChildren(
      Object.assign(document.createElement('div'), { className: 'err', textContent: "Couldn't count skills" }),
      Object.assign(document.createElement('div'), { className: 'skm-sub', textContent: errText(e) }),
    );
    $('section').setAttribute('aria-label', `Skills: couldn't count skills (${errText(e)}). Open Skill Bundles`);
    fit();
  },
);

const openPanel = () => {
  host.openSurface('plugin:skill-bundles').catch((e) => {
    void host.toast({ kind: 'error', message: `Couldn't open Skill Bundles: ${errText(e)}`, dismiss: true });
  });
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // A later `ready` (e.g. interface font size changed) resizes the text: refit the frame.
  fit();
  if (mounted) return;
  currentDir = ctx.directory;
  mounted = true;
  const section = $('section');
  section.addEventListener('click', openPanel);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
  });
  void cachedPainter.select(currentDir);
  requestRefresh(false);
  listenChanges(({ full }) => { requestRefresh(!full, full); });
  // The frame is unloaded when the section is collapsed, so this only runs while visible.
  setInterval(() => { if (document.visibilityState !== 'hidden') requestRefresh(false); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestRefresh(false); });
});
