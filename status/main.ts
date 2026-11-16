// Work Status section: the skills meter (live / installed, est. tokens). Read-only: no writes, no
// lock. The whole section is one button that opens the rail panel, where bundles are toggled.
// The frame only runs while the section is shown.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { errText } from '../shared/panel/host';
import { listenChanges } from '../panel/sync';
import { createStatusRefresher, readCounts, renderMeterHeader, type SkillCounts } from './counts';

const host = connectHost();
const REFRESH_MS = 30_000;
const $ = (id: string) => document.getElementById(id)!;
const fit = () => void host.setHeight(Math.ceil(document.body.scrollHeight));

function paint(c: SkillCounts) {
  const head = $('head');
  const prev = head.querySelector<HTMLElement>('.skm-fill')?.style.width;
  const { wrap, fill } = renderMeterHeader(c);
  // Animate from the previous width (the meter is rebuilt on every refresh).
  if (prev != null && prev !== fill.style.width) {
    const to = fill.style.width;
    fill.style.width = prev;
    requestAnimationFrame(() => { fill.style.width = to; });
  }
  head.replaceChildren(wrap);
  $('section').setAttribute('aria-label', `Skills: ${c.live} live of ${c.installed} installed. Open Skill Bundles`);
  fit();
}

const refresh = createStatusRefresher(
  () => readCounts(host),
  paint,
  (e) => {
    $('head').replaceChildren(
      Object.assign(document.createElement('div'), { className: 'err', textContent: "Couldn't count skills" }),
      Object.assign(document.createElement('div'), { className: 'skm-sub', textContent: errText(e) }),
    );
    fit();
  },
);

const openPanel = () => {
  host.openSurface('plugin:skill-bundles').catch((e) => {
    void host.toast({ kind: 'error', message: `Couldn't open Skill Bundles: ${errText(e)}`, dismiss: true });
  });
};

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  const section = $('section');
  section.addEventListener('click', openPanel);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
  });
  void refresh();
  listenChanges(() => { void refresh(); });
  // The frame is unloaded when the section is collapsed, so this only runs while visible.
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
});
