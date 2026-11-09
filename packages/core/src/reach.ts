// The one rule for which chats a chat may reach: list_chats, read_chat, send_message and stop_chat use it, and so do a
// mod's host.reaches and host.reachable. A chat reaches its own workers. A chat that sees every chat (Home) also
// reaches every other chat except other chats' workers. No chat reaches itself.
export type Reacher = { id: string; worker?: boolean; parentId?: string }

export const reaches = (caller: Reacher, chat: Reacher, seesAll: boolean) =>
  chat.worker ? chat.parentId === caller.id : chat.id !== caller.id && seesAll
