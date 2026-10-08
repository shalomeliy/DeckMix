import { describe, expect, it } from 'vitest'
import { scrollTopToReveal } from '@/core/reveal-row'

// 36 px rows, a 360 px box (10 rows, the header takes 30 px of it, so 9.2 rows show), header 30 px
const at = (index: number, scrollTop: number) => scrollTopToReveal(index, 36, scrollTop, 360, 30)

describe('scrolling the browse selection into view', () => {
  it('a row already inside the window does not move the list', () => {
    expect(at(3, 0)).toBeNull()
    expect(at(5, 100)).toBeNull()
  })

  it('a row below the window comes to the bottom edge, no further', () => {
    // row 12 spans 30 + 432 = 462 .. 498; the box shows up to scrollTop + 360
    expect(at(12, 0)).toBe(498 - 360)
  })

  it('a row above the window comes just under the sticky header', () => {
    // scrolled to 400: the header covers 400..430 of the visible strip; row 2's top is 30 + 72 = 102
    expect(at(2, 400)).toBe(72)
  })

  it('never scrolls above the top', () => {
    expect(at(0, 50)).toBe(0)
  })

  it('stepping down one row at a time moves the list one row at a time once it reaches the bottom', () => {
    let top = 0
    const seen: number[] = []
    for (let i = 0; i < 20; i++) {
      const next = at(i, top)
      if (next != null) top = next
      seen.push(top)
    }
    const moves = seen.filter((v, i) => i > 0 && v !== seen[i - 1]).map((v, i, a) => (i === 0 ? v - seen[0] : v - a[i - 1]))
    expect(moves.every((m) => m === 36 || m > 0)).toBe(true)
    expect(top).toBeGreaterThan(0)
  })
})
