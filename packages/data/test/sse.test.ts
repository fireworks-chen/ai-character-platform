import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSse } from '../src/sse'

test('SSE keeps split UTF-8, CRLF, multiline data and skips heartbeat comments', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\nevent: delta\r\ndata: {"text":"小猫🐱"}\r\n\r\nevent: example\ndata: first\ndata: second\n\n')
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const frames = []; for await (const frame of readSse(body)) frames.push(frame)
  assert.deepEqual(frames, [{ event: 'delta', data: '{"text":"小猫🐱"}' }, { event: 'example', data: 'first\nsecond' }])
})

test('An incomplete final SSE event is not mistaken for completion', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: done\ndata: {"reply":"partial"}')); controller.close() } })
  const frames = []; for await (const frame of readSse(body)) frames.push(frame)
  assert.deepEqual(frames, [])
})

test('Stopping iteration cancels the upstream reader', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')) }, cancel() { cancelled = true } })
  for await (const frame of readSse(body)) { assert.equal(frame.data, 'first'); break }
  assert.equal(cancelled, true)
})
