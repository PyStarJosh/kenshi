import { describe, expect, test } from 'vitest'
import { EventBus } from './bus'

interface Topics {
  number: number
  text: string
}

describe('EventBus', () => {
  test('delivers a payload to every listener of the topic, in subscribe order', () => {
    const bus = new EventBus<Topics>()
    const seen: string[] = []
    bus.subscribe('number', (n) => seen.push(`a${n}`))
    bus.subscribe('number', (n) => seen.push(`b${n}`))
    bus.publish('number', 7)
    expect(seen).toEqual(['a7', 'b7'])
  })

  test('topics are independent', () => {
    const bus = new EventBus<Topics>()
    const numbers: number[] = []
    bus.subscribe('number', (n) => numbers.push(n))
    bus.publish('text', 'hello')
    expect(numbers).toEqual([])
  })

  test('publishing a topic nobody listens to does nothing', () => {
    expect(() => new EventBus<Topics>().publish('text', 'x')).not.toThrow()
  })

  test('unsubscribe stops delivery, and is safe to call twice', () => {
    const bus = new EventBus<Topics>()
    let calls = 0
    const off = bus.subscribe('number', () => calls++)
    bus.publish('number', 1)
    off()
    off()
    bus.publish('number', 2)
    expect(calls).toBe(1)
  })

  test('a listener that unsubscribes itself while being called does not skip the next one', () => {
    const bus = new EventBus<Topics>()
    const seen: string[] = []
    const off = bus.subscribe('number', () => {
      seen.push('first')
      off()
    })
    bus.subscribe('number', () => seen.push('second'))
    bus.publish('number', 1)
    bus.publish('number', 2)
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  test('a listener that throws is reported and does not stop the others', () => {
    const errors: [string, unknown][] = []
    const bus = new EventBus<Topics>((topic, error) => errors.push([topic, error]))
    const seen: number[] = []
    bus.subscribe('number', () => {
      throw new Error('boom')
    })
    bus.subscribe('number', (n) => seen.push(n))
    bus.publish('number', 5)
    expect(seen).toEqual([5])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe('number')
    expect((errors[0][1] as Error).message).toBe('boom')
  })
})
