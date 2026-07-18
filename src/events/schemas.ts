import { z } from 'zod'

/** Event payload schemas — the normative catalog is docs/spec/02-event-model.md (EVT-003). */

const ts = z.string().datetime({ offset: true })
const uuid = z.string().uuid()

export const eventPayloadSchemas: Record<string, z.ZodTypeAny> = {
  'location.ping': z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      accuracy_m: z.number().nonnegative().optional(),
      speed_mps: z.number().nonnegative().optional(),
    })
    .strict(),
  'journal.post': z.object({ text: z.string().trim().min(1).max(2000) }).strict(),

  'location.stop.started': z.object({ stop_id: uuid, lat: z.number(), lon: z.number() }).strict(),
  'location.stop.ended': z
    .object({
      stop_id: uuid,
      lat: z.number(),
      lon: z.number(),
      started_at: ts,
      ended_at: ts,
      duration_min: z.number().nonnegative(),
      journal_worthy: z.boolean(),
      place: z.string().nullish(),
    })
    .strict(),
  'location.crossing.state': z
    .object({ state: z.string(), state_code: z.string().length(2), prev_state_code: z.string().length(2).nullable() })
    .strict(),
  'location.crossing.city': z.object({ city: z.string(), state_code: z.string().length(2) }).strict(),
  'trip.leg.arrived': z
    .object({
      destination_id: uuid,
      destination_name: z.string(),
      summary: z.object({
        wall_minutes: z.number(),
        moving_minutes: z.number(),
        miles: z.number(),
        stop_count: z.number().int(),
        states: z.array(z.string()),
        games_played: z.number().int(),
      }),
    })
    .strict(),
  'trip.started': z.object({ trip_id: uuid, name: z.string() }).strict(),
  'trip.ended': z
    .object({
      trip_id: uuid,
      name: z.string(),
      // Totals frozen at end time for the journal entry (TRIP-009).
      miles: z.number().nonnegative(),
      states_count: z.number().int().nonnegative(),
    })
    .strict(),

  'game.created': z
    .object({
      game_id: uuid,
      game_type: z.enum(['chess', 'checkers', 'tictactoe', 'ultimate', 'hangman']),
      mode: z.enum(['open', 'challenge']),
      invited_profile_id: uuid.optional(),
      options: z.record(z.unknown()).default({}),
    })
    .strict(),
  'game.joined': z.object({ game_id: uuid, profile_id: uuid }).strict(),
  'game.move': z.object({ game_id: uuid, move_no: z.number().int().positive(), move: z.unknown() }).strict(),
  'game.finished': z
    .object({
      game_id: uuid,
      game_type: z.enum(['chess', 'checkers', 'tictactoe', 'ultimate', 'hangman']),
      result: z.enum(['win', 'draw']),
      winner_profile_id: uuid.optional(),
      loser_profile_id: uuid.optional(),
      move_count: z.number().int().nonnegative(),
      resigned: z.boolean().optional(),
    })
    .strict(),
  'game.abandoned': z.object({ game_id: uuid, by_profile_id: uuid }).strict(),

  'destination.added': z
    .object({ destination_id: uuid, name: z.string(), lat: z.number(), lon: z.number(), order_index: z.number().int() })
    .strict(),
  'destination.updated': z
    .object({
      destination_id: uuid,
      name: z.string().optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      order_index: z.number().int().optional(),
    })
    .strict(),
  'destination.removed': z.object({ destination_id: uuid }).strict(),
  'config.updated': z.object({ changes: z.record(z.number()) }).strict(),
  'profile.created': z
    .object({ profile_id: uuid, name: z.string(), avatar: z.string(), role: z.enum(['parent', 'kid']) })
    .strict(),
  'profile.updated': z
    .object({ profile_id: uuid, name: z.string(), avatar: z.string(), role: z.enum(['parent', 'kid']) })
    .strict(),
}

/** The only types clients may upload through sync (EVT-004). */
export const CLIENT_EVENT_TYPES = new Set(['location.ping', 'journal.post'])

export function validateEventPayload(
  type: string,
  payload: unknown,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  const schema = eventPayloadSchemas[type]
  if (!schema) return { ok: false, error: `unknown_type` }
  const result = schema.safeParse(payload)
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? 'invalid payload' }
  return { ok: true, payload: result.data }
}
