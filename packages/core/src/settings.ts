// Kothar's own settings in settings.json: which engines are on, the model for summaries, the work folder and the
// terminal, and the default permission switches. Extensions' own settings aren't here.
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Settings } from './chat-store.ts'
import type { openModels } from './models.ts'
import { PERMISSION_SWITCHES, type Adapter, type CoreMessage, type EngineInfo, type PermissionSwitch, type WorkFolder } from './shared.ts'
import { AUTOMATIC, MAC_TERMINALS } from './terminal.ts'
import { within } from './util.ts'

export type SettingsDeps = {
  garage: string
  /** The user's home folder: never a work folder, and what ~ means in a typed path. */
  home: string
  settings: Settings
  saveSettings: () => void
  broadcast: (message: CoreMessage) => void
  canSandbox: boolean
  adapterFor: (engine: string) => Adapter | undefined
  /** Throws unless the engine is known. */
  checkEngine: (engine: string) => void
  /** Throws unless the engine is on. */
  checkEnabled: (engine: string) => void
  offersModel: (engine: string, model?: string) => boolean
  engineInfo: (engine: string) => EngineInfo
  models: Pick<ReturnType<typeof openModels>, 'settle'>
  /** Chats that follow their model list move with it. */
  followModels: () => void
  /** Extensions' background work starts once there's a work folder. */
  startExtensions: () => void
}

export function openAppSettings(deps: SettingsDeps) {
  const { garage, home, settings, saveSettings, broadcast, adapterFor, checkEngine, checkEnabled, offersModel, engineInfo, models } = deps
  const defaultWorkFolder = join(garage, 'work')
  const workFolder = (): WorkFolder => ({
    ...(settings.workFolder && { path: settings.workFolder }),
    defaultPath: defaultWorkFolder,
    canSandbox: deps.canSandbox,
    ...(settings.terminal && settings.terminal !== AUTOMATIC && { terminal: settings.terminal }),
    ...(process.platform === 'darwin' && { terminals: MAC_TERMINALS.map(({ id, name }) => ({ id, name })) }),
    ...Object.fromEntries(
      PERMISSION_SWITCHES.flatMap((name) => (settings[name] === undefined ? [] : [[name, settings[name]]])),
    ),
  })
  const setEngineEnabled = (engine: string, enabled: boolean) => {
    checkEngine(engine)
    settings.engines = { ...settings.engines, [engine]: enabled }
    saveSettings()
    broadcast({ type: 'engine.updated', engine: engineInfo(engine) })
    models.settle()
    deps.followModels()
  }
  const setMemory = (engine?: string, model?: string) => {
    if (engine === undefined && model !== undefined) throw new Error('Pick the engine for summaries with its model')
    if (engine !== undefined) {
      checkEngine(engine)
      if (!adapterFor(engine)?.complete) throw new Error(`Engine "${engine}" can't write summaries`)
      checkEnabled(engine)
      if (model !== undefined && !offersModel(engine, model)) {
        throw new Error(`Engine "${engine}" offers no model "${model}"`)
      }
    }
    settings.memory = { ...(engine && { engine }), ...(model && { model }) }
    saveSettings()
    broadcast({ type: 'memory.updated', memory: settings.memory })
  }
  // A work folder holding the garage would let an agent write chat.json, settings and accounts.
  const checkWorkFolder = (path: string) => {
    const reachesGarage = within(garage, path) || (within(path, garage) && path !== defaultWorkFolder)
    if (reachesGarage || [home, realpathSync(home)].includes(path)) {
      throw new Error(`${path} can't be the work folder: pick a folder of its own, outside Kothar's`)
    }
  }
  const setWorkFolder = (rawPath: unknown) => {
    const typed = String(rawPath ?? '').trim().replace(/^~(?=$|\/)/, home)
    if (!isAbsolute(typed)) throw new Error(`The path must be absolute: ${rawPath}`)
    checkWorkFolder(resolve(typed))
    if (existsSync(typed) && !statSync(typed).isDirectory()) throw new Error(`Not a folder: ${rawPath}`)
    mkdirSync(typed, { recursive: true })
    const path = realpathSync(typed)
    checkWorkFolder(path)
    settings.workFolder = path
    saveSettings()
    broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
    deps.startExtensions()
  }
  const setPermissionDefault = (name: unknown, enabled: boolean) => {
    settings[checkSwitch(name)] = enabled
    saveSettings()
    broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
  }
  const setTerminal = (rawTerminal: unknown) => {
    const terminal = String(rawTerminal ?? '')
    if (terminal !== AUTOMATIC && !MAC_TERMINALS.some((t) => t.id === terminal)) {
      throw new Error(`Unknown terminal "${terminal}"`)
    }
    if (terminal === AUTOMATIC) delete settings.terminal
    else settings.terminal = terminal
    saveSettings()
    broadcast({ type: 'workFolder.updated', workFolder: workFolder() })
  }

  return { workFolder, setWorkFolder, setEngineEnabled, setMemory, setPermissionDefault, setTerminal }
}

export const checkSwitch = (name: unknown) => {
  if (!PERMISSION_SWITCHES.includes(name as PermissionSwitch)) throw new Error(`Unknown permission switch "${name}"`)
  return name as PermissionSwitch
}
