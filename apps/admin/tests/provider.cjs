// HTTP fixture for browser tests only. The production services never load this file.
const { createServer } = require('node:http')
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.headers.authorization !== 'Bearer ui-only-provider-secret') { response.statusCode = 401; return response.end('{}') }
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixture-chat-browser' }, { id: 'fixture-image-browser' }] }))
  if (request.url === '/v1/images/generations' && request.method === 'POST') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.model !== 'fixture-image-browser' || !body.prompt) { response.statusCode = 400; return response.end('{}') }
    return response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNncAAAAASUVORK5CYII=' }] }))
  }
  response.statusCode = 404; response.end('{}')
})
server.listen(3320, '127.0.0.1')
process.on('SIGTERM', () => server.close())
