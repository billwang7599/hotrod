const statusEl = document.getElementById('status')
const form = document.getElementById('pair')
const unpairButton = document.getElementById('unpair')

const WORDS = {
  unpaired: 'Not paired with Kothar yet.',
  connecting: 'Connecting to Kothar…',
  connected: 'Connected to Kothar.',
  offline: 'Can’t reach Kothar. Is it running? If you paired again in Kothar, paste the new code.',
}

function show(answer) {
  statusEl.textContent = answer.ok ? WORDS[answer.status] ?? answer.status : answer.error
  statusEl.className = answer.ok ? answer.status : 'error'
  unpairButton.hidden = answer.status === 'unpaired'
}

const ask = (message) => chrome.runtime.sendMessage(message).then(show)

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void ask({ type: 'pair', code: document.getElementById('code').value }).then(() => {
    document.getElementById('code').value = ''
    setTimeout(() => void ask({ type: 'status' }), 800)
  })
})
unpairButton.addEventListener('click', () => void ask({ type: 'unpair' }))
void ask({ type: 'status' })
setInterval(() => void ask({ type: 'status' }), 2000)
