// Loaded only into Kothar's Chromium in a window (see ../group.ts), where every tab is the agent's: each tab joins
// its window's "Kothar" group. One change at a time, so two new tabs never make two groups.
const TITLE = 'Kothar'
const COLOR = 'blue'
let queue = Promise.resolve()

async function group(tab) {
  if (tab.id === undefined || tab.pinned || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return
  // Only normal windows hold tab groups; a popup stays as it is.
  const window = await chrome.windows.get(tab.windowId).catch(() => undefined)
  if (window?.type !== 'normal') return
  const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: TITLE })
  if (existing) return void (await chrome.tabs.group({ groupId: existing.id, tabIds: tab.id }))
  const id = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } })
  await chrome.tabGroups.update(id, { title: TITLE, color: COLOR, collapsed: false })
}

const later = (tab) => {
  queue = queue.then(() => group(tab)).catch(() => {})
}

chrome.tabs.onCreated.addListener(later)
chrome.tabs.onAttached.addListener((tabId) => chrome.tabs.get(tabId).then(later, () => {}))
chrome.tabs.onUpdated.addListener((_, change, tab) => {
  if (change.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || change.pinned === false) later(tab)
})
chrome.tabs.query({}).then((tabs) => tabs.forEach(later))
