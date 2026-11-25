// Panel I/O façade: the one import surface for main, compact, detail, send, projects, popup and
// the tests. The work lives in the modules below; this file only wires a new host through them.
//   state.ts        S (with the boot phase), host, hooks, home, undo history, error types
//   disk.ts         stat stamps and project config reads
//   catalog.ts      skill scan, lazy SKILL.md text, on-demand reads, applySkillSnapshot
//   stored-index.ts the index the next open paints first (build, save, paint)
//   refresh.ts      generations, stamps, lock observation, load, runSync/syncFromDisk/checkDisk/startSync
//   txn.ts          write queue, CLI lock, save transactions, descriptions, seeding, undo
import type { HostClient } from '@openchamber/sdk';
import { S, setHostRef } from './state';
import { resetLazy } from './catalog';
import { resetRefresh } from './refresh';
import { resetLock } from './txn';

export { errText } from '../shared/panel/host';
export { homeFromDirs } from '../shared/panel/projects';
export {
  S, activeProjectDir, bundlesOf, effectiveHome, homeOpt, host, hooks, isBundleOnInScope, lockTiming, mode, noteCreatedBundle,
  orderBundles, readOptional, sameProjectDir, skillPath, toastError, type Phase,
} from './state';
export { fmError, hasSkillMd, loadSkillMd, meta, skillText } from './catalog';
export { checkDisk, load, startSync, syncFromDisk } from './refresh';
export {
  applyChange, canUndo, commit, enqueue, pending, saveDescription, seedDefaults, toggleBundle, toggleBundleInScope, undo,
  undoDepth, undoLabel, type ChangeOpts,
} from './txn';

/** Point the panel at a host (main at boot, tests with a fake); drops everything tied to the old one. */
export function setHost(h: HostClient) {
  resetRefresh();
  S.activeDir = null;
  S.projectTexts = Object.create(null);
  resetLazy();
  setHostRef(h);
  resetLock(h);
}
