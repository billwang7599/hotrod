import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as todo from './todo.mjs'

const three = () => {
  let list = todo.addTask([], 'low one', { priority: 'low' })
  list = todo.addTask(list, 'normal one')
  list = todo.addTask(list, 'high one', { priority: 'high', due: '2026-01-10' })
  return list
}

test('hidden: priority defaults to normal and bad ones throw a TypeError naming the value', () => {
  assert.equal(todo.addTask([], 'x')[0].priority, 'normal')
  assert.throws(() => todo.addTask([], 'x', { priority: 'urgent' }), (e) => e instanceof TypeError && /urgent/.test(e.message))
})

test('hidden: completeTask marks done without changing the list it gets', () => {
  const list = three()
  const done = todo.completeTask(list, list[0].id)
  assert.equal(done.find((t) => t.id === list[0].id).done, true)
  assert.equal(list[0].done, false)
})

test('hidden: sortedTasks puts high first and keeps creation order within a priority; listTasks still works', () => {
  const titles = todo.sortedTasks(three()).map((t) => t.title)
  assert.deepEqual(titles, ['high one', 'normal one', 'low one'])
  assert.deepEqual(todo.listTasks(three()).map((t) => t.title), titles)
})

test('hidden: filterTasks, overdue, stats and a JSON round trip', () => {
  const base = three()
  const list = todo.completeTask(base, base[0].id)
  assert.equal(todo.filterTasks(list, { priority: 'high' }).length, 1)
  assert.deepEqual(todo.overdue(list, '2026-02-01').map((t) => t.title), ['high one'])
  const stats = todo.stats(list)
  assert.equal(stats.total, 3)
  assert.equal(stats.done, 1)
  assert.equal(stats.byPriority.high, 1)
  assert.deepEqual(todo.fromJSON(todo.toJSON(list)).map((t) => t.title), list.map((t) => t.title))
  assert.throws(() => todo.fromJSON(JSON.stringify([{ id: 1, title: 'x', done: false, priority: 'urgent' }])))
})
