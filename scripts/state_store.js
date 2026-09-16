// Append-only job event store. Pure Node filesystem; no browser/network.
const fs = require('fs')
const path = require('path')

const TERMINAL = new Set([
  'VERIFIED', 'SKIPPED_DUPLICATE', 'SKIPPED_RULE', 'SKIPPED_CLOSED', 'FAILED_TERMINAL', 'NEEDS_USER',
])

const ALLOWED = {
  DISCOVERED: ['VALIDATED', 'SKIPPED_DUPLICATE', 'SKIPPED_RULE'],
  VALIDATED: ['READY', 'SKIPPED_RULE', 'SKIPPED_CLOSED'],
  READY: ['OPENED', 'FAILED_RETRYABLE'],
  OPENED: ['CONTACT_CLICKED', 'SKIPPED_CLOSED', 'FAILED_RETRYABLE'],
  CONTACT_CLICKED: ['CHAT_READY', 'FAILED_RETRYABLE'],
  CHAT_READY: ['CONVERSATION_CONFIRMED', 'FAILED_RETRYABLE'],
  CONVERSATION_CONFIRMED: ['DRAFT_FILLED', 'FAILED_RETRYABLE'],
  DRAFT_FILLED: ['SENT', 'FAILED_RETRYABLE'],
  SENT: ['VERIFIED', 'FAILED_RETRYABLE'],
  FAILED_RETRYABLE: ['READY', 'OPENED', 'NEEDS_USER', 'FAILED_TERMINAL'],
}

function readEvents(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
}

function jobId(job) {
  if (!job || !job.url) throw new Error('job.url is required')
  return job.url
}

function currentStates(events) {
  const states = new Map()
  for (const ev of events) states.set(ev.jobId, ev)
  return states
}

function canTransition(from, to) {
  if (!from) return to === 'DISCOVERED'
  if (TERMINAL.has(from)) return false
  return (ALLOWED[from] || []).includes(to)
}

function makeStore(file, runId) {
  function stateOf(jobOrId) {
    const id = typeof jobOrId === 'string' ? jobOrId : jobId(jobOrId)
    return currentStates(readEvents(file)).get(id) || null
  }
  function append(job, state, extra = {}) {
    const id = typeof job === 'string' ? job : jobId(job)
    const prior = stateOf(id)
    if (!canTransition(prior && prior.state, state)) {
      throw new Error(`invalid transition ${prior ? prior.state : '∅'} → ${state} for ${id}`)
    }
    const event = {
      runId, jobId: id, co: typeof job === 'string' ? undefined : job.co,
      state, at: new Date().toISOString(), ...extra,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(event) + '\n')
    return event
  }
  function pending(jobs) {
    const states = currentStates(readEvents(file))
    return jobs.filter(job => {
      const cur = states.get(jobId(job))
      return !cur || !TERMINAL.has(cur.state)
    })
  }
  return { readEvents: () => readEvents(file), stateOf, append, pending }
}

module.exports = { TERMINAL, ALLOWED, canTransition, makeStore }
