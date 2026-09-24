import { validateSave, type SaveData } from '../sim/save';

/** The single save slot (manual saves and autosaves share it). */
const KEY = 'owcs.save.v1';

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? validateSave(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Returns false if storage is unavailable or full. */
export function writeSave(save: SaveData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

/** One-line description for menus: "$4,200 · 3 areas cleared · 5 min ago". */
export function describeSave(save: SaveData, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - save.savedAt) / 60000));
  const ago =
    mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  const areas = save.cleared.length;
  return `$${save.money.toLocaleString('en-US')} · ${areas} area${areas === 1 ? '' : 's'} cleared · saved ${ago}`;
}
