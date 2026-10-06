const { createServer } = require('node:http')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
  if (!req.url.endsWith('/chat/completions') || !body.stream || !body.stream_options?.include_usage || req.headers.authorization !== 'Bearer ui-stream-fixture') { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'Invalid fixture streaming request' } })) }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = data => res.write('data: ' + JSON.stringify(data) + '\n\n')
  event({ choices: [{ index: 0, delta: { reasoning_content: 'private fixture reasoning' } }] })
  await pause(700); if (res.destroyed) return
  if (body.messages.at(-1)?.content === 'long-stream') {
    for (let index = 0; index < 80; index++) {
      if (res.destroyed) return
      event({ choices: [{ index: 0, delta: { content: '雨落在书店门前，灯光温柔地照亮窗边。' + (index % 10 === 9 ? '\n\n' : '') } }] })
      await pause(40)
    }
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 800 } } })
    return res.end('data: [DONE]\n\n')
  }
  event({ choices: [{ index: 0, delta: { content: '*轻轻挥手*\n\n第一段回复' } }] })
  await pause(1800); if (res.destroyed) return
  event({ choices: [{ index: 0, delta: { content: '\n\n第二段回复，**很高兴见到你**。\n\n```js\nconsole.log("hello")\n```' } }] })
  await pause(350); if (res.destroyed) return
  event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } })
  res.end('data: [DONE]\n\n')
}).listen(3420, '0.0.0.0')
