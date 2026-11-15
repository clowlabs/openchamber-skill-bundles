// Skill Bundles' wiring of the shared popup and project list.
import type { HostClient } from '@openchamber/sdk';
import { createProjectList, type ProjectList } from '../shared/panel/projects';

import { createPopup as sharedCreatePopup, note as sharedNote, type PopupOptions } from '../shared/panel/popup';

export { button, closePopup, isPopupOpen, place, replace } from '../shared/panel/popup';
/** Skill Bundles' menus use the "sb-ctx" class names from styles.css. */
export const createPopup = (opts: PopupOptions) => sharedCreatePopup({ classPrefix: 'sb-ctx', ...opts });
export const note = (text: string) => sharedNote(text, 'sb-ctx');
export type { Project } from '../shared/panel/projects';
export { errorCode as codeOf } from '../shared/panel/host';

let list: ProjectList;
let knownHome: () => string | undefined = () => undefined;

export function initPopup(h: HostClient) {
  list = createProjectList({
    host: h,
    home: () => knownHome(),
    name: 'skill-bundles',
    notGrantedMessage: 'Needs the “sessions” permission. Re-approve Skill Bundles in Settings → Extensions.',
  });
}
/** main passes io's derived home so display and storage agree. */
export function setHomeSource(fn: () => string | undefined) {
  knownHome = fn;
}

export const projectList = () => list;
export const watchProjects = (onChange: () => void) => list.watch(onChange);
export const projectsNote = (shown: number, filter: string) => list.note(shown, filter);
export const shortDir = (dir: string) => list.shortDir(dir);
