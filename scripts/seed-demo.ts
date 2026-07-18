#!/usr/bin/env tsx
/**
 * Demo trip seed (SIM-007, docs/spec/10-testing.md): populates a full fabricated day —
 * pings with stops and a state crossing, several finished games, manual journal posts, and
 * a leg arrival — so every read endpoint has realistic data for UI development.
 *
 * Drives the REAL API in-process (app.inject); no HTTP server needed.
 *   npx tsx scripts/seed-demo.ts            # uses DATABASE_URL
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { appendEvent } from '../src/events/store.js'

type Inject = (opts: {
  method: string
  url: string
  headers?: Record<string, string>
  payload?: unknown
}) => Promise<{ statusCode: number; json: () => any }>

const as = (id: string) => ({ 'x-profile-id': id })

async function must(res: { statusCode: number; json: () => any }, what: string) {
  if (res.statusCode >= 400) {
    throw new Error(`seed step failed (${what}): ${res.statusCode} ${JSON.stringify(res.json())}`)
  }
  return res.json()
}

/** Straight-line interpolation between waypoints with per-segment ping counts. */
function pingsAlong(
  waypoints: Array<[number, number]>,
  startTs: Date,
  intervalMin: number,
  perSegment: number,
): Array<{ lat: number; lon: number; ts: Date }> {
  const out: Array<{ lat: number; lon: number; ts: Date }> = []
  let t = startTs.getTime()
  for (let s = 0; s < waypoints.length - 1; s++) {
    const [aLat, aLon] = waypoints[s]!
    const [bLat, bLon] = waypoints[s + 1]!
    for (let i = 0; i < perSegment; i++) {
      const f = i / perSegment
      out.push({ lat: aLat + (bLat - aLat) * f, lon: aLon + (bLon - aLon) * f, ts: new Date(t) })
      t += intervalMin * 60_000
    }
  }
  const last = waypoints[waypoints.length - 1]!
  out.push({ lat: last[0], lon: last[1], ts: new Date(t) })
  return out
}

export async function seedDemo(app: FastifyInstance): Promise<void> {
  const inject: Inject = (opts) => app.inject(opts as any) as any

  // ---- family ---------------------------------------------------------------
  const { rows } = await app.pool.query(
    `INSERT INTO profiles (name, avatar, role) VALUES
      ('Dad', '🧭', 'parent'), ('Mom', '🚗', 'parent'), ('Sam', '🦖', 'kid'), ('Alex', '🎨', 'kid')
     RETURNING id, name`,
  )
  const ids = Object.fromEntries(rows.map((r: any) => [r.name, r.id])) as Record<string, string>
  const [dad, mom, sam, alex] = [ids.Dad!, ids.Mom!, ids.Sam!, ids.Alex!]

  // ---- one active trip wrapping the fabricated day (TRIP-011) -----------------
  // The day's events are backdated, so the trip is inserted directly with a start
  // before them (the API always starts trips "now"); the lifecycle event goes through
  // the normal append path and lands inside its own window.
  const day = new Date()
  day.setHours(8, 0, 0, 0)
  // Start an hour before both the fabricated day and "now", so backdated pings/posts
  // and live-created games all fall inside the trip window whatever the local time is.
  const tripStart = new Date(Math.min(day.getTime(), Date.now()) - 60 * 60_000)
  const tripName = 'Summer Road Trip'
  const { rows: tripRows } = await app.pool.query(
    `INSERT INTO trips (name, status, started_at) VALUES ($1, 'active', $2) RETURNING id`,
    [tripName, tripStart],
  )
  await appendEvent(app.pool, {
    type: 'trip.started',
    actorId: dad,
    payload: { trip_id: tripRows[0].id, name: tripName },
    clientTs: tripStart,
  })

  // ---- destinations (Denver -> Cheyenne day) ---------------------------------
  await must(
    await inject({
      method: 'POST',
      url: '/api/destinations',
      headers: as(dad),
      payload: { name: "Grandma's house (Cheyenne)", lat: 41.14, lon: -104.8202 },
    }),
    'destination',
  )
  await must(
    await inject({
      method: 'POST',
      url: '/api/destinations',
      headers: as(mom),
      payload: { name: 'Yellowstone cabin', lat: 44.4605, lon: -110.8281 },
    }),
    'destination 2',
  )

  // ---- the drive: I-25 Denver -> Cheyenne with a lunch stop in Fort Collins ---
  const leg1 = pingsAlong(
    [
      [39.7392, -104.9903], // Denver
      [39.9205, -105.0087], // Westminster
      [40.1672, -105.1019], // Longmont
      [40.3978, -105.0748], // Loveland
      [40.5853, -105.0844], // Fort Collins
    ],
    day,
    5,
    5,
  )
  // 45-minute lunch stop in Fort Collins (stationary pings)
  const lunchStart = leg1[leg1.length - 1]!.ts.getTime()
  const lunch = Array.from({ length: 9 }, (_, i) => ({
    lat: 40.5853 + (i % 2) * 0.0002,
    lon: -105.0844 - (i % 2) * 0.0002,
    ts: new Date(lunchStart + (i + 1) * 5 * 60_000),
  }))
  const afterLunch = new Date(lunch[lunch.length - 1]!.ts.getTime() + 5 * 60_000)
  const leg2 = pingsAlong(
    [
      [40.5853, -105.0844], // Fort Collins
      [40.7025, -105.0055], // Wellington
      [40.9958, -104.9825], // state line area
      [41.14, -104.8202], // Cheyenne (arrival)
    ],
    afterLunch,
    5,
    5,
  )
  // linger at the destination so arrival (a stop) is detected
  const lingerStart = leg2[leg2.length - 1]!.ts.getTime()
  const linger = Array.from({ length: 4 }, (_, i) => ({
    lat: 41.14,
    lon: -104.8202,
    ts: new Date(lingerStart + (i + 1) * 5 * 60_000),
  }))

  const allPings = [...leg1, ...lunch, ...leg2, ...linger]
  for (let i = 0; i < allPings.length; i += 100) {
    await must(
      await inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: as(dad),
        payload: {
          device_id: 'dads-phone',
          events: allPings.slice(i, i + 100).map((p) => ({
            event_id: randomUUID(),
            type: 'location.ping',
            client_ts: p.ts.toISOString(),
            payload: { lat: p.lat, lon: p.lon, accuracy_m: 8 },
          })),
        },
      }),
      `ping batch @${i}`,
    )
  }

  // ---- journal posts (some backdated / "offline") -----------------------------
  const posts: Array<[string, string, number]> = [
    [sam, 'Spotted a train with 112 cars!!', 90],
    [alex, 'I drew a horse. It looks like a dog.', 150],
    [mom, 'Fort Collins lunch: green chile burritos 10/10', 260],
    [sam, 'Wyoming looks like Colorado but emptier', 340],
  ]
  for (const [who, text, minAfterStart] of posts) {
    await must(
      await inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: as(who),
        payload: {
          device_id: `${who.slice(0, 8)}-tablet`,
          events: [
            {
              event_id: randomUUID(),
              type: 'journal.post',
              client_ts: new Date(day.getTime() + minAfterStart * 60_000).toISOString(),
              payload: { text },
            },
          ],
        },
      }),
      'journal post',
    )
  }

  // ---- games ------------------------------------------------------------------
  // Tic-tac-toe: Sam challenges Alex and wins.
  const ttt = await must(
    await inject({
      method: 'POST',
      url: '/api/games',
      headers: as(sam),
      payload: { game_type: 'tictactoe', mode: 'challenge', invited_profile_id: alex },
    }),
    'ttt create',
  )
  await must(await inject({ method: 'POST', url: `/api/games/${ttt.id}/join`, headers: as(alex) }), 'ttt join')
  const tttMoves: Array<[string, number]> = [
    [sam, 4], [alex, 0], [sam, 2], [alex, 3], [sam, 6], // sam: 2,4,6 → anti-diagonal win
  ]
  for (const [who, cell] of tttMoves) {
    await must(
      await inject({
        method: 'POST',
        url: `/api/games/${ttt.id}/moves`,
        headers: as(who),
        payload: { move: { cell } },
      }),
      `ttt move ${cell}`,
    )
  }

  // Hangman: Dad sets a non-dictionary phrase for Sam.
  const hang = await must(
    await inject({
      method: 'POST',
      url: '/api/games',
      headers: as(dad),
      payload: {
        game_type: 'hangman',
        mode: 'challenge',
        invited_profile_id: sam,
        options: { word: 'road trip', ignore_dictionary: true },
      },
    }),
    'hangman create',
  )
  await must(await inject({ method: 'POST', url: `/api/games/${hang.id}/join`, headers: as(sam) }), 'hangman join')
  for (const letter of ['r', 'o', 'a', 'd', 't', 'i', 'p']) {
    await must(
      await inject({
        method: 'POST',
        url: `/api/games/${hang.id}/moves`,
        headers: as(sam),
        payload: { move: { letter } },
      }),
      `hangman ${letter}`,
    )
  }

  // Open chess game left mid-flight so the lobby/spectate views have live data.
  const chess = await must(
    await inject({
      method: 'POST',
      url: '/api/games',
      headers: as(mom),
      payload: { game_type: 'chess', mode: 'open' },
    }),
    'chess create',
  )
  await must(await inject({ method: 'POST', url: `/api/games/${chess.id}/join`, headers: as(dad) }), 'chess join')
  for (const [who, move] of [
    [mom, { from: 'e2', to: 'e4' }],
    [dad, { from: 'e7', to: 'e5' }],
    [mom, { from: 'g1', to: 'f3' }],
  ] as Array<[string, { from: string; to: string }]>) {
    await must(
      await inject({ method: 'POST', url: `/api/games/${chess.id}/moves`, headers: as(who), payload: { move } }),
      'chess move',
    )
  }

  console.log(
    'Demo trip seeded: 4 profiles, 1 active trip, 2 destinations, %d pings, %d posts, 3 games.',
    allPings.length,
    posts.length,
  )
}

// CLI entry
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const { createPool, migrate } = await import('../src/db.js')
  const { seedConfigDefaults } = await import('../src/config.js')
  const { buildApp } = await import('../src/app.js')
  const pool = createPool()
  await migrate(pool)
  await seedConfigDefaults(pool)
  const app = await buildApp({ pool })
  await seedDemo(app)
  await app.close()
  await pool.end()
}
