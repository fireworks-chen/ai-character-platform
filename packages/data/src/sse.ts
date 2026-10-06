/** Decode SSE frames without losing split UTF-8 characters or CRLF boundaries. */
export async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''
  function frame(value: string) {
    let event = 'message'; const data: string[] = []
    for (const line of value.split(/\r\n|\n|\r/)) {
      const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon)
      const raw = colon < 0 ? '' : line.slice(colon + 1); const content = raw.startsWith(' ') ? raw.slice(1) : raw
      if (field === 'event') event = content
      if (field === 'data') data.push(content)
    }
    return data.length ? { event, data: data.join('\n') } : null
  }
  try {
    while (true) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const parsed = frame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length)
        if (parsed) yield parsed
      }
      if (buffer.length > 2_000_000) throw new Error('流式数据帧过大')
      if (done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
