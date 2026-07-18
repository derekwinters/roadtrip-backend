import { EventEmitter } from 'node:events'

/**
 * In-process wake-up channel for long-pollers (EVT-008, GAME-009, NOTIF-005).
 * Emitted after an event row is committed; listeners re-query rather than trusting payloads,
 * so spurious wakes are harmless. Single-server deployment by design (home server).
 */
export class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(1000)
  }

  notify(): void {
    this.emit('event')
  }

  /** Resolves when a new event is committed, or after `ms` — whichever comes first. */
  waitForEvent(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onEvent = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.off('event', onEvent)
        resolve(false)
      }, ms)
      this.once('event', onEvent)
    })
  }
}
