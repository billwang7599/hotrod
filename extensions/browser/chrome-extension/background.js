// The Kothar extension's service worker: wires Chrome's events to agent.js and keeps the connection to Kothar up.
import { createAgent } from './agent.js'

const agent = createAgent({ chrome, WebSocket })

chrome.tabs.onCreated.addListener(agent.events.onTabCreated)
chrome.tabs.onUpdated.addListener(agent.events.onTabUpdated)
chrome.tabs.onRemoved.addListener(agent.events.onTabRemoved)
chrome.tabGroups.onRemoved.addListener(agent.events.onGroupRemoved)
chrome.debugger.onEvent.addListener(agent.events.onDebuggerEvent)
chrome.debugger.onDetach.addListener(agent.events.onDebuggerDetach)

// Chrome stops idle service workers; this wakes it to reconnect when Kothar starts later.
chrome.alarms.create('kothar-reconnect', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(() => void agent.connect())
chrome.runtime.onStartup.addListener(() => void agent.connect())
chrome.runtime.onInstalled.addListener(() => void agent.connect())

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  const done = (promise) =>
    promise.then(
      () => reply({ ok: true, status: agent.status }),
      (error) => reply({ ok: false, error: String(error?.message ?? error), status: agent.status }),
    )
  if (message?.type === 'status') done(agent.connect())
  else if (message?.type === 'pair') done(agent.pair(message.code))
  else if (message?.type === 'unpair') done(agent.unpair())
  else return
  return true
})

void agent.connect()
