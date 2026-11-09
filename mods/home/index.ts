import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Mod } from '@kotharhq/mod-api'

const HOME_ID = 'main'

const INSTRUCTIONS =
  "You are the user's personal assistant in Kothar, running in its main chat, Home. Answer general questions, help " +
  'with personal tasks and use your MCP tools. You may work in any directory the user names in this chat. No ' +
  'folder stays attached to Home; each message starts in a scratch folder. For ongoing ' +
  'work in a folder, offer to make a space for it: a chat with that folder, made with the kothar create_chat tool. ' +
  'list_chats, read_chat and send_message reach every space.'

type NewSpace = { name: string; prompt?: string; folders?: string[]; files?: string[]; engine?: string }

const home: Mod = {
  id: 'home',
  name: 'Home',
  description:
    'A main chat beside your spaces: your assistant for general questions and personal tasks. It can list, read ' +
    'and message every space, and make new ones. Off hides it; its history stays.',
  enabledByDefault: true,
  chats: [{ id: HOME_ID, name: 'Home', instructions: INSTRUCTIONS, seesAll: true }],
  tools: [
    {
      name: 'create_chat',
      description:
        'Make a space: a named chat whose folders (absolute paths of existing folders) and files go into its ' +
        'context. It works in its own folder in the work folder, where each git folder is checked out on a new ' +
        'branch, kothar/<name>. Give a prompt to start it. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1 },
          folders: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          engine: { type: 'string' },
        },
        required: ['name'],
      },
      offered: (caller) => caller.id === HOME_ID,
      run({ prompt, ...spec }: NewSpace, { host }) {
        const relative = spec.folders?.find((folder) => !isAbsolute(folder))
        if (relative !== undefined) throw new Error(`The path must be absolute: ${relative}`)
        const missing = spec.folders?.find((folder) => !existsSync(folder))
        if (missing !== undefined) {
          throw new Error(`No such folder: ${missing}; create_chat attaches existing folders only`)
        }
        const chat = host.createChat(spec)
        if (prompt) host.send(chat.id, prompt)
        return { chatId: chat.id }
      },
    },
  ],
}

export default home
