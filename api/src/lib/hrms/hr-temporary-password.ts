import { randomInt } from 'node:crypto'

/**
 * A password HR can read out or paste into a message: four groups of five,
 * like `2gzNv-5LDVC-4ftGu-bvukW`.
 *
 * The alphabet leaves out the characters that get misread when someone copies
 * a password by eye (0/O, 1/l/I) and has no symbols, so there is nothing for a
 * chat app or a phone keyboard to mangle. Twenty characters from 54 is about
 * 115 bits, far more than a password an employee will ever type once and
 * replace.
 *
 * `randomInt` draws from the operating system's random source and is unbiased,
 * which `Math.random` and a modulo over random bytes are not.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

export function generateTemporaryPassword(): string {
  const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return [group(), group(), group(), group()].join('-')
}
