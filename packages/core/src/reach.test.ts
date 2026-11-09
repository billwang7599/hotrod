import { expect, it } from 'vitest'
import { reaches } from './reach.ts'

it("reaches a chat's own workers, and for a chat that sees all, every other chat but others' workers", () => {
  const home = { id: 'main' }
  const lead = { id: 'a' }
  const other = { id: 'b' }
  const mine = { id: 'w1', worker: true, parentId: 'a' }
  const homes = { id: 'w2', worker: true, parentId: 'main' }
  expect(reaches(lead, mine, false)).toBe(true)
  expect(reaches(lead, other, false)).toBe(false)
  expect(reaches(lead, homes, false)).toBe(false)
  expect(reaches(lead, lead, false)).toBe(false)
  expect(reaches(home, lead, true)).toBe(true)
  expect(reaches(home, homes, true)).toBe(true)
  expect(reaches(home, mine, true)).toBe(false)
  expect(reaches(home, home, true)).toBe(false)
})
