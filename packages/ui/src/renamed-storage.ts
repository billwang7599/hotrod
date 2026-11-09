// Kothar was called Hotrod, and kept its UI preferences (theme, panels, drafts, folds, the token) under `hotrod.*`
// keys. They move to `kothar.*` before anything reads them; a value already under the new key wins.
export const OLD_PREFIX = 'hotrod.'
export const PREFIX = 'kothar.'

type KeyedStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

export function moveRenamedKeys(storage: KeyedStorage) {
  const old: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(OLD_PREFIX)) old.push(key)
  }
  for (const key of old) {
    const value = storage.getItem(key)
    const renamed = PREFIX + key.slice(OLD_PREFIX.length)
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value)
    storage.removeItem(key)
  }
}

// Imported first in main.tsx, so this runs before any module reads a preference.
if (typeof localStorage !== 'undefined') {
  try {
    moveRenamedKeys(localStorage)
  } catch {
    // Storage that can't be read or written keeps nothing to move.
  }
}
