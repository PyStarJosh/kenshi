import { useSyncExternalStore } from 'react'
import type { Settings } from '../core/types'
import { settingsStore } from './settings'

/** The current settings; the component re-renders when they change. */
export function useSettings(): Settings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
}
