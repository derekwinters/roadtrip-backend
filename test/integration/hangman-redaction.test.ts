import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestApp, asProfile, type TestApp } from '../helpers/app.js'

let t: TestApp
let dad: { id: string }
let sam: { id: string }

beforeAll(async () => {
  t = await createTestApp()
  dad = await t.addProfile('Dad', 'parent')
  sam = await t.addProfile('Sam', 'kid')
})
afterAll(async () => await t.close())

describe('hangman word redaction in event feeds', () => {
  it('redacts the word from game.created in feeds while ongoing, reveals after finish [GAME-014]', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/games',
      headers: asProfile(dad.id),
      payload: {
        game_type: 'hangman',
        mode: 'challenge',
        invited_profile_id: sam.id,
        options: { word: 'zyzzyva', ignore_dictionary: true },
      },
    })
    expect(created.statusCode).toBe(201)
    const gameId = created.json().id

    // Ongoing: neither the global feed nor the game stream may carry the word.
    for (const url of ['/api/events?types=game.created', `/api/games/${gameId}/events`]) {
      const res = await t.app.inject({ method: 'GET', url, headers: asProfile(sam.id) })
      const createdEvents = res.json().events.filter((e: any) => e.type === 'game.created')
      expect(createdEvents.length).toBeGreaterThan(0)
      expect(JSON.stringify(createdEvents)).not.toContain('zyzzyva')
    }

    // Finish the game (guesser wins), then the replay may reveal the word.
    await t.app.inject({ method: 'POST', url: `/api/games/${gameId}/join`, headers: asProfile(sam.id) })
    for (const letter of ['z', 'y', 'v', 'a']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/games/${gameId}/moves`,
        headers: asProfile(sam.id),
        payload: { move: { letter } },
      })
      expect(res.statusCode).toBe(200)
    }

    const after = await t.app.inject({
      method: 'GET',
      url: `/api/games/${gameId}/events`,
      headers: asProfile(sam.id),
    })
    const createdEvent = after.json().events.find((e: any) => e.type === 'game.created')
    expect(createdEvent.payload.options.word).toBe('zyzzyva')
  })
})
