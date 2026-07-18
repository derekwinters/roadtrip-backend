import { describe, it, expect } from 'vitest'
import { foldBingoCard, type PlateEvent } from '../../src/bingo/card.js'

/** License Plate Bingo fold (docs/spec/14-bingo.md, BNG-002/003). */

const DAD = '00000000-0000-4000-8000-00000000000d'
const SAM = '00000000-0000-4000-8000-00000000000a'
const ALEX = '00000000-0000-4000-8000-00000000000b'

const profiles = new Map([
  [DAD, { name: 'Dad', role: 'parent' }],
  [SAM, { name: 'Sam', role: 'kid' }],
  [ALEX, { name: 'Alex', role: 'kid' }],
])

const T = (n: number) => new Date(Date.UTC(2026, 6, 4, 12, 0, n)).toISOString()

let seqCounter = 0
function ev(type: 'plate.spotted' | 'plate.unspotted', actor: string | null, code: string, ts: string, seq?: number): PlateEvent {
  return { seq: seq ?? ++seqCounter, type, actor_id: actor, payload: { state_code: code }, client_ts: ts }
}

describe('bingo card fold', () => {
  it('credits the first standing spotter; duplicate spots are no-ops [BNG-002]', () => {
    const card = foldBingoCard(
      [ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.spotted', ALEX, 'CO', T(2)), ev('plate.spotted', ALEX, 'WY', T(3))],
      profiles,
    )
    expect(card.cells).toEqual([
      { state_code: 'CO', spotted_by: SAM, spotted_by_name: 'Sam', spotted_at: T(1) },
      { state_code: 'WY', spotted_by: ALEX, spotted_by_name: 'Alex', spotted_at: T(3) },
    ])
    expect(card.counts).toEqual({ [SAM]: 1, [ALEX]: 1 })
    // Only effective actions land in the log — the duplicate spot is a no-op.
    expect(card.log.map((l) => [l.action, l.state_code])).toEqual([
      ['spotted', 'CO'],
      ['spotted', 'WY'],
    ])
  })

  it('unspotting an empty state is a no-op [BNG-002]', () => {
    const card = foldBingoCard([ev('plate.unspotted', SAM, 'MT', T(1))], profiles)
    expect(card.cells).toEqual([])
    expect(card.log).toEqual([])
    expect(card.counts).toEqual({})
  })

  it('folds in client_ts order with seq as tie-break, regardless of array order [BNG-002]', () => {
    // Events arrive out of order (offline queues flush late) — the fold sorts by client_ts.
    const card = foldBingoCard(
      [ev('plate.unspotted', SAM, 'CO', T(3)), ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.spotted', ALEX, 'CO', T(2))],
      profiles,
    )
    expect(card.cells).toEqual([]) // spot @1, dup @2, removal by spotter @3
    expect(card.log.map((l) => [l.action, l.actor_name])).toEqual([
      ['spotted', 'Sam'],
      ['unspotted', 'Sam'],
    ])

    // Same client_ts: the lower seq wins the credit.
    const tie = foldBingoCard(
      [ev('plate.spotted', ALEX, 'UT', T(5), 20), ev('plate.spotted', SAM, 'UT', T(5), 10)],
      profiles,
    )
    expect(tie.cells).toEqual([{ state_code: 'UT', spotted_by: SAM, spotted_by_name: 'Sam', spotted_at: T(5) }])
  })

  it('a removed-then-respotted state credits the respotter [BNG-002]', () => {
    const card = foldBingoCard(
      [
        ev('plate.spotted', SAM, 'CO', T(1)),
        ev('plate.unspotted', SAM, 'CO', T(2)),
        ev('plate.spotted', ALEX, 'CO', T(3)),
      ],
      profiles,
    )
    expect(card.cells).toEqual([{ state_code: 'CO', spotted_by: ALEX, spotted_by_name: 'Alex', spotted_at: T(3) }])
    expect(card.counts).toEqual({ [ALEX]: 1 })
    expect(card.log).toHaveLength(3)
  })

  it('removals are honored only from the original spotter or a parent [BNG-003]', () => {
    // A stranger kid's removal is ignored; the cell and the log are untouched by it.
    const ignored = foldBingoCard(
      [ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.unspotted', ALEX, 'CO', T(2))],
      profiles,
    )
    expect(ignored.cells).toEqual([{ state_code: 'CO', spotted_by: SAM, spotted_by_name: 'Sam', spotted_at: T(1) }])
    expect(ignored.log.map((l) => l.action)).toEqual(['spotted'])

    // A parent's removal is honored even though the parent did not spot it.
    const parental = foldBingoCard(
      [ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.unspotted', DAD, 'CO', T(2))],
      profiles,
    )
    expect(parental.cells).toEqual([])
    expect(parental.log.map((l) => [l.action, l.actor_name])).toEqual([
      ['spotted', 'Sam'],
      ['unspotted', 'Dad'],
    ])

    // Without a profile map, roles are unknown: only the spotter's own removal sticks.
    const bare = foldBingoCard([ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.unspotted', SAM, 'CO', T(2))])
    expect(bare.cells).toEqual([])
    const bareIgnored = foldBingoCard([ev('plate.spotted', SAM, 'CO', T(1)), ev('plate.unspotted', DAD, 'CO', T(2))])
    expect(bareIgnored.cells).toHaveLength(1)
  })
})
