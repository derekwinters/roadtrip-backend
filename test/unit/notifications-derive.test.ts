import { describe, it, expect } from 'vitest'
import { deriveNotifications } from '../../src/notifications/derive.js'
import type { EventRow } from '../../src/events/store.js'

const DAD = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'
const MOM = '55555555-5555-4555-8555-555555555555'
const GAME_ID = '33333333-3333-4333-8333-333333333333'
const DEST_ID = '44444444-4444-4444-8444-444444444444'

const profiles = new Map([
  [DAD, { name: 'Dad', avatar: '🧔' }],
  [SAM, { name: 'Sam', avatar: '🦖' }],
  [MOM, { name: 'Mom', avatar: '🚗' }],
])

let seqCounter = 0
function ev(type: string, payload: unknown, actorId: string | null = null): EventRow {
  seqCounter += 1
  return {
    seq: seqCounter,
    event_id: `eeeeeeee-eeee-4eee-8eee-${String(seqCounter).padStart(12, '0')}`,
    type,
    actor_id: actorId,
    device_id: null,
    payload,
    client_ts: '2026-07-04T12:00:00.000Z',
    server_ts: '2026-07-04T12:00:01.000Z',
  }
}

describe('deriveNotifications', () => {
  it('a challenge inviting P yields challenge_received for P only [NOTIF-002]', () => {
    const events = [
      ev('game.created', {
        game_id: GAME_ID,
        game_type: 'chess',
        mode: 'challenge',
        invited_profile_id: SAM,
        options: {},
      }),
    ]
    const forSam = deriveNotifications(events, SAM, profiles)
    expect(forSam).toHaveLength(1)
    expect(forSam[0]).toMatchObject({
      seq: events[0]!.seq,
      kind: 'challenge_received',
      game_id: GAME_ID,
    })
    expect(forSam[0]!.text.length).toBeGreaterThan(0)
    expect(deriveNotifications(events, DAD, profiles)).toHaveLength(0)
    expect(deriveNotifications(events, MOM, profiles)).toHaveLength(0)
  })

  it('an open game.created (no invite) notifies nobody [NOTIF-002] [NOTIF-004]', () => {
    const events = [
      ev('game.created', { game_id: GAME_ID, game_type: 'chess', mode: 'open', options: {} }),
    ]
    for (const p of [DAD, SAM, MOM]) {
      expect(deriveNotifications(events, p, profiles)).toHaveLength(0)
    }
  })

  it('a journal.post by A yields journal_activity for everyone except A [NOTIF-003]', () => {
    const events = [ev('journal.post', { text: 'hello from the back seat' }, SAM)]
    for (const p of [DAD, MOM]) {
      const items = deriveNotifications(events, p, profiles)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ seq: events[0]!.seq, kind: 'journal_activity' })
      expect(items[0]!.text).toContain('hello from the back seat')
    }
    expect(deriveNotifications(events, SAM, profiles)).toHaveLength(0)
  })

  it('actorless journal-worthy events notify every profile [NOTIF-004]', () => {
    const events = [
      ev('location.crossing.state', { state: 'Kansas', state_code: 'KS', prev_state_code: 'CO' }),
      ev('location.stop.ended', {
        stop_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        lat: 39.26,
        lon: -103.69,
        started_at: '2026-07-04T11:37:00.000Z',
        ended_at: '2026-07-04T12:00:00.000Z',
        duration_min: 23,
        journal_worthy: true,
        place: 'Limon',
      }),
      ev('trip.leg.arrived', {
        destination_id: DEST_ID,
        destination_name: 'Twine Ball',
        summary: { wall_minutes: 60, moving_minutes: 50, miles: 40, stop_count: 1, states: [], games_played: 0 },
      }),
    ]
    for (const p of [DAD, SAM, MOM]) {
      const items = deriveNotifications(events, p, profiles)
      expect(items).toHaveLength(3)
      expect(items.every((i) => i.kind === 'journal_activity')).toBe(true)
    }
  })

  it('a game.finished result produces no notification for any profile [NOTIF-004]', () => {
    // Game results still render in the journal feed, but only challenges notify for games.
    const actorless = [
      ev('game.finished', {
        game_id: GAME_ID,
        game_type: 'chess',
        result: 'win',
        winner_profile_id: DAD,
        loser_profile_id: SAM,
        move_count: 24,
      }),
    ]
    for (const p of [DAD, SAM, MOM]) {
      expect(deriveNotifications(actorless, p, profiles)).toHaveLength(0)
    }

    // Even when the result carries an actor, nobody is notified.
    const withActor = [
      ev(
        'game.finished',
        { game_id: GAME_ID, game_type: 'chess', result: 'win', winner_profile_id: SAM, loser_profile_id: DAD, move_count: 12 },
        SAM,
      ),
    ]
    for (const p of [DAD, SAM, MOM]) {
      expect(deriveNotifications(withActor, p, profiles)).toHaveLength(0)
    }
  })

  it('pings, moves, short stops and config/admin events never notify [NOTIF-004]', () => {
    const events = [
      ev('location.ping', { lat: 40, lon: -105 }, DAD),
      ev('game.move', { game_id: GAME_ID, move_no: 1, move: 'e4' }, DAD),
      ev('location.stop.ended', { lat: 1, lon: 2, duration_min: 3, journal_worthy: false }),
      ev('location.stop.started', { stop_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lat: 1, lon: 2 }),
      ev('location.crossing.city', { city: 'Salina', state_code: 'KS' }),
      ev('config.updated', { changes: { stop_radius_m: 120 } }, DAD),
      ev('profile.created', { profile_id: MOM, name: 'Mom', avatar: '🚗', role: 'parent' }, DAD),
      ev('destination.added', { destination_id: DEST_ID, name: 'X', lat: 1, lon: 2, order_index: 0 }, DAD),
      ev('game.joined', { game_id: GAME_ID, profile_id: SAM }, SAM),
    ]
    for (const p of [DAD, SAM, MOM]) {
      expect(deriveNotifications(events, p, profiles)).toHaveLength(0)
    }
  })

  it('items carry kind, text, related ids, and the event seq for cursor advance [NOTIF-001]', () => {
    const challenge = ev('game.created', {
      game_id: GAME_ID,
      game_type: 'checkers',
      mode: 'challenge',
      invited_profile_id: MOM,
      options: {},
    })
    const journalPost = ev('journal.post', { text: 'spotted a moose' }, DAD)
    const items = deriveNotifications([challenge, journalPost], MOM, profiles)
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(typeof item.seq).toBe('number')
      expect(typeof item.text).toBe('string')
      expect(item.text.length).toBeGreaterThan(0)
    }
    expect(items[0]!.seq).toBe(challenge.seq)
    expect(items[1]!.seq).toBe(journalPost.seq)
    expect(items[0]!.kind).toBe('challenge_received')
    expect(items[0]!.game_id).toBe(GAME_ID)
    expect(items[1]!.kind).toBe('journal_activity')
  })
})
