import { describe, it, expect } from 'vitest'
import { JOURNAL_EVENT_TYPES, renderJournalEntry } from '../../src/journal/render.js'

const DAD = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'
const GAME_ID = '33333333-3333-4333-8333-333333333333'
const DEST_ID = '44444444-4444-4444-8444-444444444444'

const profiles = new Map([
  [DAD, { name: 'Dad', avatar: '🧔' }],
  [SAM, { name: 'Sam', avatar: '🦖' }],
])

function row(over: Record<string, unknown> = {}) {
  return {
    seq: '42',
    event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    type: 'journal.post',
    actor_id: null,
    device_id: null,
    payload: {},
    client_ts: '2026-07-04T12:00:00.000Z',
    server_ts: '2026-07-04T12:00:05.000Z',
    ...over,
  }
}

describe('renderJournalEntry', () => {
  it('renders a post with actor from joined profile columns and no deep link [JRNL-001] [JRNL-005]', () => {
    const entry = renderJournalEntry(
      row({
        payload: { text: 'Saw a dinosaur statue!' },
        actor_id: SAM,
        p_id: SAM,
        p_name: 'Sam',
        p_avatar: '🦖',
        p_role: 'kid',
      }),
    )
    expect(entry).toMatchObject({
      seq: 42,
      kind: 'post',
      ts: '2026-07-04T12:00:00.000Z',
      text: 'Saw a dinosaur statue!',
      actor: { id: SAM, name: 'Sam', avatar: '🦖', role: 'kid' },
    })
    expect(entry!.link).toBeUndefined()
  })

  it('timestamps entries from client_ts whether it arrives as Date or ISO string [JRNL-002]', () => {
    const asString = renderJournalEntry(row({ payload: { text: 'x' } }))
    expect(asString!.ts).toBe('2026-07-04T12:00:00.000Z')
    const asDate = renderJournalEntry(
      row({ payload: { text: 'x' }, client_ts: new Date('2026-07-01T08:30:00.000Z') }),
    )
    expect(asDate!.ts).toBe('2026-07-01T08:30:00.000Z')
  })

  it('renders a journal-worthy stop with rounded minutes, place, and map_pin link [JRNL-001] [JRNL-005]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'location.stop.ended',
        payload: {
          stop_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          lat: 39.26,
          lon: -103.69,
          started_at: '2026-07-04T11:37:00.000Z',
          ended_at: '2026-07-04T12:00:00.000Z',
          duration_min: 22.6,
          journal_worthy: true,
          place: 'Limon',
        },
      }),
    )
    expect(entry).toMatchObject({
      kind: 'stop',
      text: 'Stopped for 23 min near Limon',
      link: { kind: 'map_pin', lat: 39.26, lon: -103.69 },
    })
  })

  it('omits the place suffix when the stop has no place [JRNL-001]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'location.stop.ended',
        payload: { lat: 1, lon: 2, duration_min: 15.2, journal_worthy: true, place: null },
      }),
    )
    expect(entry!.text).toBe('Stopped for 15 min')
  })

  it('filters short stops with journal_worthy=false out of the feed [JRNL-004]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'location.stop.ended',
        payload: { lat: 1, lon: 2, duration_min: 3, journal_worthy: false },
      }),
    )
    expect(entry).toBeNull()
  })

  it('returns null for every non-journal event type [JRNL-004]', () => {
    for (const type of [
      'location.ping',
      'location.stop.started',
      'location.crossing.city',
      'game.created',
      'game.joined',
      'game.move',
      'game.abandoned',
      'destination.added',
      'config.updated',
      'profile.created',
    ]) {
      expect(JOURNAL_EVENT_TYPES.has(type)).toBe(false)
      expect(renderJournalEntry(row({ type, payload: {} }))).toBeNull()
    }
  })

  it('renders a state crossing with a checklist link [JRNL-001] [JRNL-005]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'location.crossing.state',
        payload: { state: 'Kansas', state_code: 'KS', prev_state_code: 'CO' },
      }),
    )
    expect(entry).toMatchObject({
      kind: 'state_crossing',
      text: 'Crossed into Kansas',
      link: { kind: 'checklist', state_code: 'KS' },
    })
  })

  it('renders a leg arrival with hours to 1 decimal, rounded miles, and leg_summary link [JRNL-001] [JRNL-005]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'trip.leg.arrived',
        payload: {
          destination_id: DEST_ID,
          destination_name: "World's Largest Ball of Twine",
          summary: { wall_minutes: 660, moving_minutes: 570, miles: 500.2, stop_count: 8, states: ['CO', 'KS'], games_played: 3 },
        },
      }),
    )
    expect(entry).toMatchObject({
      kind: 'leg_arrival',
      text: "Arrived at World's Largest Ball of Twine. 11.0 h in the car (9.5 h driving), 500 mi, 8 stops.",
      link: { kind: 'leg_summary', destination_id: DEST_ID },
    })
  })

  it('renders a win from the game.finished payload and profile names only [JRNL-006] [JRNL-005]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'game.finished',
        payload: {
          game_id: GAME_ID,
          game_type: 'chess',
          result: 'win',
          winner_profile_id: DAD,
          loser_profile_id: SAM,
          move_count: 24,
        },
      }),
      profiles,
    )
    expect(entry).toMatchObject({
      kind: 'game_result',
      text: 'Dad beat Sam in chess, 24 moves',
      link: { kind: 'game_replay', game_id: GAME_ID },
    })
  })

  it('renders a draw phrasing [JRNL-006]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'game.finished',
        payload: {
          game_id: GAME_ID,
          game_type: 'tictactoe',
          result: 'draw',
          winner_profile_id: DAD,
          loser_profile_id: SAM,
          move_count: 9,
        },
      }),
      profiles,
    )
    expect(entry!.text).toBe('Dad and Sam drew in tictactoe after 9 moves')
  })

  it('renders a resignation phrasing [JRNL-006]', () => {
    const entry = renderJournalEntry(
      row({
        type: 'game.finished',
        payload: {
          game_id: GAME_ID,
          game_type: 'checkers',
          result: 'win',
          winner_profile_id: SAM,
          loser_profile_id: DAD,
          move_count: 10,
          resigned: true,
        },
      }),
      profiles,
    )
    expect(entry!.text).toBe('Sam beat Dad in checkers (resigned)')
  })
})
