import { describe, expect, it } from 'vitest'
import { read } from './repo.ts'

/**
 * v0.8.7 added a `LICENSE` file, and it was MIT: anyone could copy, modify
 * and sell the code. On 23/09 Shalom said he wants the code to be his
 * alone, and he found out only then that the repo was public *and* MIT.
 * That was never his decision, just a line in a spec. So the project is
 * proprietary now, and this check stops an open-source grant from coming
 * back in by accident. LICENSE, package.json and the Settings screen are
 * three places that make the same claim, and any one of them contradicting
 * the others would be the lie.
 */
describe('SoundGrid is proprietary — all rights reserved', () => {
  it('LICENSE reserves all rights and grants no open-source permission', () => {
    const license = read('LICENSE')
    expect(license).toContain('All rights reserved')
    expect(license).toContain('Shalom Eliyahu')
    expect(
      /Permission is hereby granted|MIT License|Apache License|GNU General Public/i.test(license),
      'LICENSE contains open-source grant text — the owner decided (23/09) the code is not open source.',
    ).toBe(false)
  })

  it('package.json declares "UNLICENSED", the npm marker for proprietary code', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string; private?: boolean }
    expect(pkg.license).toBe('UNLICENSED')
    expect(pkg.private, '"private": true keeps npm from ever publishing the package').toBe(true)
  })

  it('the Settings screen does not tell the user the code is open source', () => {
    const settings = read('src/app/components/Settings.tsx')
    expect(settings).not.toMatch(/code is MIT/i)
    expect(settings).toContain('all rights reserved')
  })
})
