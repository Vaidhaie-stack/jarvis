/**
 * Internet radio, started and stopped by JARVIS's `radio` tool.
 *
 * One <audio> element streaming a station URL the bridge picked from its own
 * fixed list (SomaFM), so the page never plays an address the model invented.
 * The CSP in index.html allows exactly those hosts.
 *
 * It ducks whenever he is listening or talking. Music at full volume would
 * both bury his voice and leak into the microphone, where the recogniser
 * would try to transcribe the lyrics.
 */

let el: HTMLAudioElement | null = null
let volume = 0.45
let ducked = false
let label = ''

const DUCKED = 0.08

function apply() {
  if (el) el.volume = ducked ? Math.min(volume, DUCKED) : volume
}

export function play(url: string, name: string, vol?: number) {
  if (typeof vol === 'number') volume = Math.max(0, Math.min(1, vol / 100))
  if (!el) {
    el = new Audio()
    el.preload = 'none'
  }
  if (el.src !== url) el.src = url
  label = name
  apply()
  el.play().catch((err) => console.warn('[jarvis] radio would not start:', err))
}

export function stop() {
  if (!el) return
  el.pause()
  // Dropping the source closes the stream rather than leaving it buffering.
  el.removeAttribute('src')
  el.load()
  label = ''
}

export function setVolume(vol: number) {
  volume = Math.max(0, Math.min(1, vol / 100))
  apply()
}

export function duck(on: boolean) {
  if (ducked === on) return
  ducked = on
  apply()
}

export const nowPlaying = () => label
