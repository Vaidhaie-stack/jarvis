import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The personal-assistant half of JARVIS: memory, reminders, settings, weather,
 * news, the morning briefing and the radio.
 *
 * Everything here is local to this machine. Memory, reminders and settings
 * live as plain JSON in ~/.jarvis so they survive restarts and can be read or
 * edited by hand. Weather comes from Open-Meteo and news from Google News RSS,
 * both free and keyless.
 *
 * Reminders are the one thing that outlives a conversation. They are scheduled
 * here, in the bridge process, not in the agent session, and fired to every
 * connected browser. One that comes due while no browser is open is kept and
 * delivered the moment one connects.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const DATA_DIR = process.env.JARVIS_DATA_DIR ?? join(homedir(), '.jarvis')

function load(file, fallback) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'))
  } catch {
    return fallback
  }
}

/** Write-then-rename, so a crash mid-write never leaves a truncated file. */
function save(file, value) {
  mkdirSync(DATA_DIR, { recursive: true })
  const path = join(DATA_DIR, file)
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2))
  renameSync(`${path}.tmp`, path)
}

const newId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Language codes the browser can listen in, with a name the model can use. */
export const LANGUAGES = {
  'en-GB': 'British English',
  'en-US': 'American English',
  'en-IN': 'Indian English',
  'hi-IN': 'Hindi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'bn-IN': 'Bengali',
  'gu-IN': 'Gujarati',
  'pa-IN': 'Punjabi',
  'ur-PK': 'Urdu',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'it-IT': 'Italian',
  'pt-BR': 'Portuguese',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Mandarin Chinese',
  'ar-SA': 'Arabic',
  'ru-RU': 'Russian',
}

export const PERSONAS = {
  classic:
    'The classic JARVIS described above: dry, British, understated.',
  friendly:
    'Warm, relaxed and encouraging, like a helpful friend. Contractions are ' +
    'fine, light enthusiasm is fine, and you may say "sure". Still brief.',
  funny:
    'Playful and witty. A quick joke or a light tease in most answers, never ' +
    'at the expense of the answer itself. Still brief.',
  formal:
    'Precise, formal and strictly professional. No jokes, no banter, no ' +
    'contractions.',
  teacher:
    'A patient teacher. When the user is learning something, explain it ' +
    'simply, step by step, with one small example, and check they followed. ' +
    'Explanations may run to five or six sentences; everything else stays brief.',
  coach:
    'A focused productivity coach. Keep the user on task, break big jobs into ' +
    'the next small step, suggest a timer when they are starting work, and ' +
    'praise finished work in a few words.',
}

const DEFAULT_SETTINGS = {
  /** What JARVIS calls himself, and the wake word. */
  name: process.env.JARVIS_NAME ?? 'Jarvis',
  /** How he addresses the user: "sir", "ma'am", a name, or "" for nothing. */
  address: process.env.JARVIS_ADDRESS ?? 'sir',
  persona: process.env.JARVIS_PERSONA ?? 'classic',
  /** A BCP-47 code from LANGUAGES. */
  language: process.env.JARVIS_LANGUAGE ?? 'en-GB',
  /** Home city, for weather and the briefing. */
  city: process.env.JARVIS_CITY ?? '',
  /** Google News edition, e.g. "IN:en", "US:en", "GB:en". */
  newsRegion: process.env.JARVIS_NEWS_REGION ?? 'US:en',
}

/**
 * Environment variables set the starting values; anything changed by voice is
 * saved to settings.json and wins from then on.
 */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...load('settings.json', {}) }
}

function saveSettings(patch) {
  const next = { ...load('settings.json', {}), ...patch }
  save('settings.json', next)
  return { ...DEFAULT_SETTINGS, ...next }
}

/** The part of the settings the browser needs: the wake word and language. */
export function browserSettings() {
  const s = getSettings()
  return { name: s.name, language: s.language }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MAX_FACTS = 200

const facts = () => load('memory.json', [])

/**
 * Words that carry no meaning for matching, so "what is my exam date" finds
 * "exam is on the twentieth" on "exam" rather than failing on "what".
 */
const STOP = new Set(
  'a an the is are was were my me i you your of to in on at for and or what when where who how do does did about it that this'.split(
    ' ',
  ),
)
const words = (t) =>
  String(t)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w))

function matching(query) {
  const want = words(query)
  if (!want.length) return facts()
  return facts().filter((f) => {
    const have = new Set(words(f.text))
    return want.some((w) => have.has(w) || [...have].some((h) => h.startsWith(w)))
  })
}

// ---------------------------------------------------------------------------
// The system prompt additions
// ---------------------------------------------------------------------------

/**
 * Appended to the persona prompt when a session starts, so JARVIS begins every
 * conversation already knowing who he is talking to and how to talk to them.
 */
export function promptAdditions() {
  const s = getSettings()
  const out = []

  out.push(`YOUR NAME is ${s.name}. Answer to it.`)

  if (s.address.toLowerCase() !== 'sir') {
    out.push(
      s.address
        ? `FORM OF ADDRESS. Wherever the rules above say "sir", say "${s.address}" instead, by the same positional rules.`
        : 'FORM OF ADDRESS. Ignore every rule above about "sir". Do not use any form of address.',
    )
  }

  const persona = PERSONAS[s.persona] ?? s.persona
  if (s.persona !== 'classic') {
    out.push(
      `PERSONALITY. This overrides the style rules above wherever they conflict: ${persona}`,
    )
  }

  if (!s.language.startsWith('en')) {
    const lang = LANGUAGES[s.language] ?? s.language
    out.push(
      `LANGUAGE. Speak ${lang}, written in its own script, because your reply is read aloud by a ${lang} voice. ` +
        'If the user clearly switches to another language, follow them.',
    )
  } else {
    out.push(
      'LANGUAGE. Reply in English unless the user speaks another language; then reply in theirs.',
    )
  }

  const known = facts()
  if (known.length) {
    out.push(
      'WHAT YOU REMEMBER about the user, from earlier conversations. Use it ' +
        'naturally; never recite it unprompted:\n' +
        known.map((f) => `- ${f.text}`).join('\n'),
    )
  }

  const due = pendingReminders()
  if (due.length) {
    out.push(
      'THEIR UPCOMING REMINDERS:\n' +
        due.map((r) => `- ${r.text} (${new Date(r.at).toString()})`).join('\n'),
    )
  }

  out.push(`The current local time when this conversation began: ${new Date().toString()}.`)
  if (s.city) out.push(`The user lives in ${s.city}.`)

  out.push(`YOUR ASSISTANT TOOLS (the \`jarvis_assistant\` server):
- \`remember\` whenever the user tells you something worth keeping: their name,
  birthday, exams, preferences, people in their life, goals. Also when they
  say "remember". \`recall\` before saying you do not know something personal.
  \`forget\` when asked.
- \`set_reminder\` for "remind me", timers and alarms; work out the time from
  what they said. \`list_reminders\` and \`cancel_reminder\` as asked. A timer
  for focused work is a reminder too.
- \`settings\` when they ask you to change your name, how you address them,
  your personality, the language, their city or their news region. Confirm in
  one short line.
- \`weather\` for any weather question, \`news\` for headlines. Put the result
  on a blade with \`display\` and say only the gist.
- \`briefing\` when they say good morning, ask for a briefing, or ask what is
  on today. Show it on a blade, then speak three or four short sentences:
  the date, the weather, their reminders, one headline.
- \`radio\` to play, change or stop music. Pick a station that fits what they
  asked for.`)

  return '\n\n' + out.join('\n\n')
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** Every browser tab connected right now, by its send function. */
const clients = new Set()

const allReminders = () => load('reminders.json', [])
const pendingReminders = () =>
  allReminders()
    .filter((r) => !r.done)
    .sort((a, b) => a.at - b.at)

const timers = new Map()

/** setTimeout overflows past about 24.8 days; re-arm in steps instead. */
const MAX_DELAY = 2 ** 31 - 1

function arm(r) {
  clearTimeout(timers.get(r.id))
  const delay = Math.max(0, r.at - Date.now())
  timers.set(
    r.id,
    setTimeout(() => (delay > MAX_DELAY ? arm(r) : fire(r.id)), Math.min(delay, MAX_DELAY)),
  )
}

function spokenLine(text) {
  const { address } = getSettings()
  return address ? `${address[0].toUpperCase()}${address.slice(1)}, a reminder. ${text}` : `A reminder. ${text}`
}

function fire(id) {
  timers.delete(id)
  const list = allReminders()
  const r = list.find((x) => x.id === id)
  if (!r || r.done) return
  console.log(`[jarvis] reminder due: ${r.text}`)
  if (!clients.size) return // kept, and delivered when a browser connects
  r.done = true
  save('reminders.json', list)
  for (const send of clients) {
    send({ type: 'reminder', id: r.id, text: r.text, spoken: spokenLine(r.text) })
  }
  if (r.repeat) {
    schedule(r.text, r.at + REPEATS[r.repeat], r.repeat)
  }
}

const REPEATS = { daily: 86_400_000, weekly: 7 * 86_400_000, hourly: 3_600_000 }

function schedule(text, at, repeat) {
  const r = { id: newId(), text, at, repeat: repeat ?? null, done: false }
  const list = allReminders().filter((x) => !x.done || x.at > Date.now() - 7 * 86_400_000)
  list.push(r)
  save('reminders.json', list)
  arm(r)
  return r
}

/** Arm everything on disk when the bridge starts. */
export function startReminders() {
  for (const r of pendingReminders()) arm(r)
  const n = pendingReminders().length
  if (n) console.log(`[jarvis] ${n} reminder${n === 1 ? '' : 's'} scheduled`)
}

/**
 * Register a connected browser. Returns the function that unregisters it.
 * Anything that came due while nobody was connected is delivered now.
 */
export function addClient(send) {
  clients.add(send)
  send({ type: 'ui', op: 'settings', args: browserSettings() })
  for (const r of pendingReminders()) {
    if (r.at <= Date.now()) setTimeout(() => fire(r.id), 12_000) // after the boot sequence
  }
  return () => clients.delete(send)
}

/** "in 10 minutes" or an absolute time, whichever the model gave. */
function resolveTime({ in_minutes, at }) {
  const mins = Number(in_minutes)
  if (Number.isFinite(mins) && mins > 0) return Date.now() + mins * 60_000
  if (at) {
    const t = Date.parse(at)
    if (Number.isFinite(t)) return t
  }
  return null
}

const when = (t) =>
  new Date(t).toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })

// ---------------------------------------------------------------------------
// Weather and news
// ---------------------------------------------------------------------------

const WEATHER_CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle',
  55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow',
  75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'jarvis-assistant/1.0' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return res.json()
}

async function weather(place) {
  const name = String(place || getSettings().city || '').trim()
  if (!name) {
    throw new Error(
      'No place given and no home city is set. Ask the user which city, and offer to save it with the settings tool.',
    )
  }
  // The geocoder matches a bare place name; "Chennai, India" finds nothing.
  const query = name.split(',')[0].trim()
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=${encodeURIComponent(query)}`,
  )
  const g = geo.results?.[0]
  if (!g) throw new Error(`No place called "${name}" was found.`)
  const f = await getJson(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${g.latitude}&longitude=${g.longitude}&timezone=auto&forecast_days=3` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  )
  const c = f.current ?? {}
  const d = f.daily ?? {}
  return {
    place: [g.name, g.admin1, g.country].filter(Boolean).join(', '),
    now: {
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      conditions: WEATHER_CODES[c.weather_code] ?? 'unknown',
    },
    forecast: (d.time ?? []).map((day, i) => ({
      day,
      high_c: d.temperature_2m_max?.[i],
      low_c: d.temperature_2m_min?.[i],
      rain_chance_pct: d.precipitation_probability_max?.[i],
      conditions: WEATHER_CODES[d.weather_code?.[i]] ?? 'unknown',
    })),
  }
}

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim()

async function news(topic, count = 6) {
  const region = getSettings().newsRegion
  const [country, lang] = region.split(':')
  const params = `hl=${lang ?? 'en'}-${country}&gl=${country}&ceid=${country}:${lang ?? 'en'}`
  const url = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&${params}`
    : `https://news.google.com/rss?${params}`
  const res = await fetch(url, {
    headers: { 'user-agent': 'jarvis-assistant/1.0' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`the news feed answered ${res.status}`)
  const xml = await res.text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, count)
  const field = (block, tag) =>
    decode(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
  return items.map(([, block]) => {
    const source = field(block, 'source')
    let title = field(block, 'title')
    // Google appends " - Source" to every headline.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3)
    return { title, source, published: field(block, 'pubDate'), url: field(block, 'link') }
  })
}

// ---------------------------------------------------------------------------
// Radio
// ---------------------------------------------------------------------------

/** SomaFM: listener-supported, ad-free internet radio with stable stream URLs. */
export const STATIONS = {
  focus: { label: 'Groove Salad — chilled beats for focus', url: 'https://ice2.somafm.com/groovesalad-128-mp3' },
  lofi: { label: 'Fluid — instrumental hip-hop', url: 'https://ice2.somafm.com/fluid-128-mp3' },
  ambient: { label: 'Drone Zone — deep ambient', url: 'https://ice2.somafm.com/dronezone-128-mp3' },
  space: { label: 'Deep Space One — space ambient', url: 'https://ice2.somafm.com/deepspaceone-128-mp3' },
  jazz: { label: 'Sonic Universe — modern jazz', url: 'https://ice2.somafm.com/sonicuniverse-128-mp3' },
  lounge: { label: 'Secret Agent — spy lounge', url: 'https://ice2.somafm.com/secretagent-128-mp3' },
  electronic: { label: 'Beat Blender — deep house and downtempo', url: 'https://ice2.somafm.com/beatblender-128-mp3' },
  indie: { label: 'Indie Pop Rocks', url: 'https://ice2.somafm.com/indiepop-128-mp3' },
  classic: { label: 'Left Coast 70s — classic rock', url: 'https://ice2.somafm.com/seventies-128-mp3' },
  cafe: { label: 'Lush — mellow vocals', url: 'https://ice2.somafm.com/lush-128-mp3' },
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const ok = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
})
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

/** Every tool body goes through this, so a network hiccup is one plain sentence. */
const safely = (fn) => async (args) => {
  try {
    return await fn(args ?? {})
  } catch (err) {
    return fail(String(err?.message ?? err))
  }
}

/**
 * @param {(msg: object) => void} send - pushes a frame to this connection's browser
 */
export function assistantServer(send) {
  return createSdkMcpServer({
    name: 'jarvis_assistant',
    version: '1.0.0',
    instructions:
      'Personal assistant tools: long-term memory, reminders and timers, ' +
      'settings, weather, news, the daily briefing and the radio.',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Save a fact about the user to long-term memory, kept across conversations. ' +
          'Write it as a short third-person statement, e.g. "Their exam is on 20 November 2026".',
        { fact: z.string().describe('The fact to keep, one sentence.') },
        safely(({ fact }) => {
          const text = String(fact).trim()
          if (!text) return fail('Nothing to remember.')
          const list = facts().filter((f) => f.text.toLowerCase() !== text.toLowerCase())
          list.push({ id: newId(), text, at: new Date().toISOString() })
          save('memory.json', list.slice(-MAX_FACTS))
          return ok('Remembered.')
        }),
      ),

      tool(
        'recall',
        'Search long-term memory. Leave the query empty to list everything remembered.',
        { query: z.string().optional().describe('Words to look for, e.g. "exam".') },
        safely(({ query }) => {
          const hits = matching(query ?? '')
          return ok(hits.length ? hits.map((f) => `${f.text} (saved ${f.at.slice(0, 10)})`).join('\n') : 'Nothing remembered about that.')
        }),
      ),

      tool(
        'forget',
        'Delete remembered facts that match the words given. Use "everything" to clear all memory, only when the user plainly asks for that.',
        { query: z.string().describe('Words identifying what to forget, or "everything".') },
        safely(({ query }) => {
          if (String(query).trim().toLowerCase() === 'everything') {
            save('memory.json', [])
            return ok('All memory cleared.')
          }
          const gone = new Set(matching(query).map((f) => f.id))
          if (!gone.size) return ok('Nothing matched, so nothing was forgotten.')
          save('memory.json', facts().filter((f) => !gone.has(f.id)))
          return ok(`Forgot ${gone.size} item${gone.size === 1 ? '' : 's'}.`)
        }),
      ),

      tool(
        'set_reminder',
        'Set a reminder, timer or alarm. It is spoken aloud when due, even in a later conversation. ' +
          'Give either in_minutes (for "in ten minutes") or at (for "at six pm"). Prefer in_minutes for anything ' +
          'relative. If unsure of the date or time, call list_reminders first: it reports the current local time.',
        {
          text: z.string().describe('What to remind them of, phrased to be read out, e.g. "Time to call your mother."'),
          in_minutes: z.union([z.number(), z.string()]).optional().describe('Minutes from now.'),
          at: z.string().optional().describe('An absolute local time, ISO 8601 without an offset, e.g. "2026-11-06T18:00:00".'),
          repeat: z.enum(['hourly', 'daily', 'weekly']).optional().describe('Repeat the reminder.'),
        },
        safely((args) => {
          const at = resolveTime(args)
          if (!at) return fail('No valid time was given. Pass in_minutes or an ISO time in at.')
          if (at < Date.now() - 60_000) return fail('That time has already passed.')
          const r = schedule(String(args.text).trim() || 'Your timer is done.', at, args.repeat)
          return ok(`Reminder set for ${when(r.at)}${r.repeat ? `, repeating ${r.repeat}` : ''}.`)
        }),
      ),

      tool(
        'list_reminders',
        'List upcoming reminders and timers.',
        {},
        safely(() => {
          const list = pendingReminders()
          const now = `The local time now is ${new Date().toString()}.`
          if (!list.length) return ok(`No reminders are set. ${now}`)
          return ok(now + '\n' + list.map((r) => `${r.id}: ${r.text} — ${when(r.at)}${r.repeat ? ` (${r.repeat})` : ''}`).join('\n'))
        }),
      ),

      tool(
        'cancel_reminder',
        'Cancel reminders by id, or by words that match their text. Use "all" to cancel every one.',
        { match: z.string().describe('A reminder id, words from its text, or "all".') },
        safely(({ match }) => {
          const m = String(match).trim().toLowerCase()
          const list = allReminders()
          const hit = list.filter(
            (r) => !r.done && (m === 'all' || r.id === m || r.text.toLowerCase().includes(m)),
          )
          if (!hit.length) return ok('No reminder matched.')
          for (const r of hit) {
            r.done = true
            clearTimeout(timers.get(r.id))
            timers.delete(r.id)
          }
          save('reminders.json', list)
          return ok(`Cancelled ${hit.length} reminder${hit.length === 1 ? '' : 's'}.`)
        }),
      ),

      tool(
        'settings',
        'Change how you behave. Only pass what the user asked to change. Changes are saved for future conversations; ' +
          'adopt them immediately in this one. ' +
          `Personas: ${Object.keys(PERSONAS).join(', ')} — or any short free-text description. ` +
          `Languages: ${Object.entries(LANGUAGES).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
        {
          name: z.string().optional().describe('Your new name, which also becomes the wake word, e.g. "Friday".'),
          address: z.string().optional().describe('How to address the user: "sir", "ma\'am", "boss", their first name, or "none".'),
          persona: z.string().optional().describe('A persona key or a short description of the personality wanted.'),
          language: z.string().optional().describe('A language code from the list.'),
          city: z.string().optional().describe('Their home city, for weather and briefings.'),
          news_region: z.string().optional().describe('Google News edition as COUNTRY:lang, e.g. "IN:en", "US:en", "GB:en", "IN:hi".'),
        },
        safely((args) => {
          const patch = {}
          if (args.name?.trim()) patch.name = args.name.trim().slice(0, 30)
          if (args.address != null) {
            const a = args.address.trim()
            patch.address = a.toLowerCase() === 'none' ? '' : a.slice(0, 30)
          }
          if (args.persona?.trim()) patch.persona = args.persona.trim().slice(0, 400)
          if (args.language?.trim()) {
            const code = Object.keys(LANGUAGES).find(
              (k) => k.toLowerCase() === args.language.trim().toLowerCase(),
            )
            if (!code) return fail(`Unknown language code. Use one of: ${Object.keys(LANGUAGES).join(', ')}.`)
            patch.language = code
          }
          if (args.city?.trim()) patch.city = args.city.trim().slice(0, 80)
          if (args.news_region?.trim()) patch.newsRegion = args.news_region.trim()
          if (!Object.keys(patch).length) return ok(`Current settings: ${JSON.stringify(getSettings())}`)

          const s = saveSettings(patch)
          if (patch.name || patch.language) {
            for (const push of clients) push({ type: 'ui', op: 'settings', args: browserSettings() })
          }
          const notes = []
          if (patch.name) notes.push(`You are now called ${s.name}, and "${s.name}" wakes you.`)
          if ('address' in patch) notes.push(s.address ? `Address the user as "${s.address}".` : 'Use no form of address.')
          if (patch.persona) notes.push(`From now on your personality is: ${PERSONAS[s.persona] ?? s.persona}`)
          if (patch.language) notes.push(`From now on speak ${LANGUAGES[s.language]}, in its own script. The interface now listens and speaks in it.`)
          if (patch.city) notes.push(`Home city saved as ${s.city}.`)
          if (patch.newsRegion) notes.push(`News region saved as ${s.newsRegion}.`)
          return ok(`Saved. ${notes.join(' ')}`)
        }),
      ),

      tool(
        'weather',
        'Current weather and a three-day forecast. Leave place empty for the user\'s home city.',
        { place: z.string().optional().describe('A city or town name.') },
        safely(async ({ place }) => ok(await weather(place))),
      ),

      tool(
        'news',
        'Latest headlines, from Google News, for the user\'s region. Give a topic to search, or leave it empty for top stories.',
        {
          topic: z.string().optional().describe('e.g. "artificial intelligence", "cricket", "stock market".'),
          count: z.number().optional().describe('How many headlines, 1 to 10. Default 6.'),
        },
        safely(async ({ topic, count }) =>
          ok(await news(topic, Math.max(1, Math.min(10, Number(count) || 6)))),
        ),
      ),

      tool(
        'briefing',
        'Everything for a morning or daily briefing in one call: the date and time, weather for the home city, upcoming reminders, top headlines and what you remember.',
        {},
        safely(async () => {
          const s = getSettings()
          const [w, n] = await Promise.allSettled([
            s.city ? weather(s.city) : Promise.reject(new Error('no home city set — offer to save one')),
            news('', 5),
          ])
          const soon = pendingReminders().filter((r) => r.at < Date.now() + 36 * 3_600_000)
          return ok({
            now: new Date().toString(),
            weather: w.status === 'fulfilled' ? w.value : `unavailable: ${w.reason?.message}`,
            reminders_next_36h: soon.map((r) => ({ text: r.text, when: when(r.at) })),
            headlines: n.status === 'fulfilled' ? n.value.map((h) => `${h.title} (${h.source})`) : `unavailable: ${n.reason?.message}`,
            remembered: facts().slice(-15).map((f) => f.text),
          })
        }),
      ),

      tool(
        'radio',
        'Play internet radio through the interface, change station, set the volume, or stop. ' +
          `Stations: ${Object.entries(STATIONS).map(([k, v]) => `${k} (${v.label})`).join('; ')}.`,
        {
          action: z.enum(['play', 'stop', 'volume']).describe('What to do.'),
          station: z.string().optional().describe('A station key, for play. Default "focus".'),
          volume: z.number().optional().describe('0 to 100, for volume or play.'),
        },
        safely(({ action, station, volume }) => {
          if (action === 'stop') {
            send({ type: 'ui', op: 'radio', args: { action: 'stop' } })
            return ok('Radio stopped.')
          }
          const v = Number.isFinite(Number(volume)) ? Math.max(0, Math.min(100, Number(volume))) : undefined
          if (action === 'volume') {
            if (v === undefined) return fail('Give a volume from 0 to 100.')
            send({ type: 'ui', op: 'radio', args: { action: 'volume', volume: v } })
            return ok(`Volume ${v}.`)
          }
          const key = String(station ?? 'focus').toLowerCase()
          const s = STATIONS[key]
          if (!s) return fail(`Unknown station. Choose one of: ${Object.keys(STATIONS).join(', ')}.`)
          send({ type: 'ui', op: 'radio', args: { action: 'play', url: s.url, label: s.label, volume: v } })
          return ok(`Playing ${s.label}.`)
        }),
      ),
    ],
  })
}
