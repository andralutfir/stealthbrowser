'use strict';
/** Deterministic PRNG so a given seed always reproduces the same persona. */
const crypto = require('crypto');

function hash32(str) {
  const h = crypto.createHash('sha256').update(String(str)).digest();
  return h.readUInt32LE(0);
}

/** mulberry32 */
function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash32(seed);
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.pickN = (arr, n) => {
    const copy = arr.slice();
    const out = [];
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
    return out;
  };
  rng.bool = (p = 0.5) => rng() < p;
  rng.float = (min, max, decimals = 4) => Number((min + rng() * (max - min)).toFixed(decimals));
  return rng;
}

function newSeed() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = { makeRng, newSeed, hash32 };
