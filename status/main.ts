// Work Status section: the skills meter (live / installed, est. tokens). Read-only: no writes, no
// lock. The whole section is one button that opens the rail panel, where bundles are toggled.
// The frame only runs while the section is shown.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import * as core from '../src/core.js';
import { skillRoots } from '../src/discover.js';
import { errorCode, errText, readOptional } from '../shared/panel/host';
import { createHomeDeriver } from '../shared/panel/projects';
import { listenChanges } from '../panel/sync';
import { createStatusRefresher, listSkillIds, readCounts, renderMeterHeader, type SkillCounts } from './counts';

const host = connectHost();
const homeDeriver = createHomeDeriver(host);
let currentDir: string | null = null;
let mounted = false;
let idCache: { allIds: string[]; rootsKey: string; rootStamps: string } | null = null;
let needFull = true;

function requestRefresh(fast = false) {
  if (!fast) needFull = true;
  void refresh();
}

host.onDirectory((dir) => {
  if (currentDir === dir) return;
  currentDir = dir;
  if (mounted) requestRefresh(true);
});

const REFRESH_MS = 30_000;
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}
const fit = () => void host.setHeight(Math.ceil(document.body.scrollHeight));

async function statRoots(roots: readonly string[]): Promise<string> {
  const stamps = await Promise.all(
    roots.map((r) =>
      host.stat(r).then(
        (st) => `${st.kind}:${st.size}:${st.mtime}`,
        (e) => `err:${errorCode(e) || 'ERR'}`,
      ),
    ),
  );
  return stamps.join('|');
}

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
  async () => {
    const full = needFull || idCache === null;
    needFull = false;
    const [home, opencodeText] = await Promise.all([
      homeDeriver.derive(),
      readOptional(host, core.OPENCODE_PATH),
    ]);
    const roots = skillRoots(opencodeText);
    const rootsKey = JSON.stringify(roots);
    const rootStamps = await statRoots(roots);
    let allIds: string[];
    if (!full && idCache && idCache.rootsKey === rootsKey && idCache.rootStamps === rootStamps) {
      allIds = idCache.allIds;
    } else {
      allIds = await listSkillIds(host, opencodeText);
      idCache = { allIds, rootsKey, rootStamps };
    }
    return readCounts(host, { projectDir: currentDir, home, opencodeText, cachedIds: allIds });
  },
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

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  const section = $('section');
  section.addEventListener('click', openPanel);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
  });
  requestRefresh(false);
  listenChanges(({ full }) => { requestRefresh(!full); });
  // The frame is unloaded when the section is collapsed, so this only runs while visible.
  setInterval(() => { if (document.visibilityState !== 'hidden') requestRefresh(false); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestRefresh(false); });
});
