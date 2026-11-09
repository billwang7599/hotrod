// A to-do list is a plain array of tasks; functions return new lists and never change the one they get.
let nextId = 1

export function addTask(list, title) {
  if (typeof title !== 'string' || !title.trim()) throw new TypeError('A task needs a title')
  return [...list, { id: nextId++, title: title.trim(), done: false }]
}

export function listTasks(list) {
  return [...list]
}
