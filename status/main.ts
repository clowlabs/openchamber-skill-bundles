// Work Status section: skill counts (live / installed, est. tokens). Writes the
// skill-counts-v1 and skill index caches. The section opens the rail panel for toggles.
// The frame only runs while the section is shown.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { errText } from '../shared/panel/host';
import { listenChanges } from '../panel/sync';
import { $, el } from '../panel/dom';
import { createStatusLoader, createCachedStatusRefresher, renderMeterHeader } from './counts';
import { createCachedStatusPainter, type LastCounts } from './cache';

const host = connectHost();
let currentDir: string | null = null;
let mounted = false;
let needFull = false;
let needImmediateScan = false;

function requestRefresh(fast = false, immediateScan = false) {
  if (!fast) needFull = true;
  if (immediateScan) needImmediateScan = true;
  void refresher.refresh();
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
const fit = () => void host.setHeight(Math.ceil(document.body.scrollHeight));

let lastPainted: LastCounts | null = null;
function paint(c: LastCounts) {
  if (lastPainted && lastPainted.live === c.live && lastPainted.installed === c.installed && lastPainted.chars === c.chars) return;
  lastPainted = { live: c.live, installed: c.installed, chars: c.chars };
  $('head').replaceChildren(renderMeterHeader(c));
  $('section').setAttribute('aria-label', `Skills: ${c.live} live of ${c.installed} installed. Open Skill Bundles`);
  fit();
}

const cachedPainter = createCachedStatusPainter(host, paint);
const loader = createStatusLoader(host, {
  onRevalidated: (c) => { void cachedPainter.fresh(refresher.ticket(), c); },
});

const refresher = createCachedStatusRefresher(
  cachedPainter,
  async () => {
    const forceScan = needFull;
    const forceImmediateScan = needImmediateScan;
    needFull = false;
    needImmediateScan = false;
    return loader.load(currentDir, { forceScan, forceImmediateScan });
  },
  (e) => {
    lastPainted = null;
    $('head').replaceChildren(
      el('div', 'err', "Couldn't count skills"),
      el('div', 'skm-sub', errText(e)),
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
