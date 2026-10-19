/**
 * Full Dots and Boxes games (GAME-023) as scripted move lists, shared by the engine unit
 * tests and the API/replay integration tests. Each entry is [mover index into players, edge].
 * The mover is written out from the rules here, not taken from the engine, so a server that
 * hands the turn to the wrong player rejects the script.
 *
 * Every script draws all 49 horizontal edges first. None of them completes a box, so they
 * alternate creator (0), joiner (1), … and leave the joiner to move. After that, v(r,0)
 * completes nothing and each later v(r,1..7) completes box (r, c-1), so whoever draws
 * those verticals claims row r in one chain and keeps the turn throughout.
 */

export interface Edge {
  row: number
  col: number
  orientation: 'h' | 'v'
}
export type ScriptedMove = [by: 0 | 1, edge: Edge]

const h = (row: number, col: number): Edge => ({ row, col, orientation: 'h' })
const v = (row: number, col: number): Edge => ({ row, col, orientation: 'v' })
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** 49 horizontals, alternating from the creator; the joiner is to move afterwards. */
const allHorizontals = (): ScriptedMove[] =>
  range(7)
    .flatMap((r) => range(7).map((c) => h(r, c)))
    .map((edge, i) => [(i % 2) as 0 | 1, edge])

/** The six claiming verticals of row r, all by `by`. */
const claimRow = (by: 0 | 1, r: number): ScriptedMove[] => range(7).map((c) => [by, v(r, c + 1)])

/**
 * 21–21 draw: row by row, the player to move draws v(r,0) (no claim, turn passes) and the
 * other player claims row r. Joiner opens row 0, so the creator claims rows 0, 2, 4.
 */
export function drawGame(): ScriptedMove[] {
  const moves = allHorizontals()
  for (const r of range(6)) {
    const opener = (r % 2 === 0 ? 1 : 0) as 0 | 1
    const claimer = (1 - opener) as 0 | 1
    moves.push([opener, v(r, 0)], ...claimRow(claimer, r))
  }
  return moves
}

/**
 * Creator wins 35–7 with a 36-move chain: v(0..4, 0) continue the alternation (joiner first,
 * 54 non-claiming moves in all, creator to move), the creator claims rows 0..4 (35 moves),
 * then draws v(5,0), which claims nothing and passes to the joiner, who claims row 5.
 */
export function creatorWinsGame(): ScriptedMove[] {
  const moves = allHorizontals()
  range(5).forEach((r) => moves.push([((r + 1) % 2) as 0 | 1, v(r, 0)]))
  range(5).forEach((r) => moves.push(...claimRow(0, r)))
  moves.push([0, v(5, 0)], ...claimRow(1, 5))
  return moves
}

/** Joiner wins 42–0: all six v(r,0) continue the alternation, then the joiner claims every row. */
export function joinerWinsGame(): ScriptedMove[] {
  const moves = allHorizontals()
  range(6).forEach((r) => moves.push([((r + 1) % 2) as 0 | 1, v(r, 0)]))
  range(6).forEach((r) => moves.push(...claimRow(1, r)))
  return moves
}
