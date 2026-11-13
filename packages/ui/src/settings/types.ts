// What every Settings page gets, and how the dialog lists its pages.
import type { ReactNode } from 'react'
import type {
  ClientMessage,
  ContextSection,
  EngineAccounts,
  EngineInfo,
  ExtensionInfo,
  ModelLists,
  RestartState,
  Setup,
  PromptInfo,
  WorkersSettings,
  WorkFolder,
} from '@kothar/core/shared'
import type { Market } from '../marketplace.tsx'

export type PageProps = {
  engines: EngineInfo[]
  accounts: EngineAccounts[]
  contextDefaults: Record<ContextSection, boolean>
  extensions: ExtensionInfo[]
  modelLists: ModelLists
  setups?: Setup[]
  setupSave?: { count: number; id?: string; error?: string }
  // Settings → Workers; absent until the core's snapshot arrives.
  workers?: WorkersSettings
  // Kothar's own prompts (Settings → Prompts); absent until the core's snapshot arrives.
  corePrompts?: PromptInfo[]
  workFolder: WorkFolder
  chooseWorkFolder: () => void
  connected: boolean
  send: (m: ClientMessage) => void
  // Installed themes and the marketplace's catalog.
  market?: Market
  // The desktop app's folder picker, for Install from folder.
  pickFolder?: (title?: string) => Promise<string | null>
  // The master switch for community extensions, what waits for a restart, and how many chats a restart would stop.
  communityExtensions?: boolean
  restart?: RestartState
  running?: number
  // Opens the Marketplace window over Settings, showing one kind first.
  openMarketplace?: () => void
}

export const NO_RESTART: RestartState = { changes: [], canRestart: false }

export type Page = {
  id: string
  group: (typeof NAV_GROUPS)[number]
  title: string
  intro?: string
  body: (props: PageProps) => ReactNode
}

export const NAV_GROUPS = ['Options', 'Extensions'] as const
