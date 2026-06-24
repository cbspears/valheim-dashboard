// Tiny persisted state (cursors + dedupe sets) so restarts don't replay history.
import { readFile, writeFile } from 'node:fs/promises';

const STATE_PATH = new URL('../state.json', import.meta.url);

export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}
