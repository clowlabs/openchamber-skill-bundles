// Work Status section: "35 live / 212 installed". Read-only; the frame only runs while shown.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { errText } from '../shared/panel/host';
import { bundlesLine, liveLine, readCounts } from './counts';

const host = connectHost();
const REFRESH_MS = 30_000;
const $ = (id: string) => document.getElementById(id)!;

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const c = await readCounts(host);
    $('main').textContent = liveLine(c);
    $('main').classList.remove('err');
    $('sub').textContent = bundlesLine(c);
    $('line').title = `Open Skill Bundles · ~${c.chars.toLocaleString('en-US')} prompt chars`;
  } catch (e) {
    $('main').textContent = "Couldn't count skills";
    $('main').classList.add('err');
    $('sub').textContent = errText(e);
  } finally {
    busy = false;
    void host.setHeight(Math.ceil(document.body.scrollHeight));
  }
}

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  $('line').addEventListener('click', () => {
    host.openSurface('plugin:skill-bundles').catch((e) => {
      void host.toast({ kind: 'error', message: `Couldn't open Skill Bundles: ${errText(e)}`, dismiss: true });
    });
  });
  void refresh();
  // The frame is unloaded when the section is collapsed, so this only runs while visible.
  setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
});
