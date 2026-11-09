import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addTask, listTasks } from './todo.mjs'

test('adds a task with a trimmed title', () => {
  const list = addTask([], '  buy milk ')
  assert.equal(list.length, 1)
  assert.equal(list[0].title, 'buy milk')
  assert.equal(list[0].done, false)
})

test('does not change the list it gets', () => {
  const empty = []
  addTask(empty, 'a')
  assert.deepEqual(empty, [])
})

test('lists tasks', () => {
  assert.equal(listTasks(addTask(addTask([], 'a'), 'b')).length, 2)
})
