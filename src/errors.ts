/** Application error carrying the stable machine code from docs/spec/03-api.md (API-001). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const unauthenticated = () => new AppError(401, 'unauthenticated', 'Unknown or missing profile')
export const parentRequired = () => new AppError(403, 'parent_required', 'This action requires a parent profile')
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`)
export const validation = (message: string) => new AppError(400, 'validation', message)
export const conflict = (code: string, message: string) => new AppError(409, code, message)
export const forbidden = (code: string, message: string) => new AppError(403, code, message)
