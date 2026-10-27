// Stateless Streamable HTTP MCP server on 127.0.0.1:$PORT/mcp (default 3988).
// Tools: `echo` returns its text; `whoami` returns the X-Connector-Token
// header of the request that called it, so a remount with a new header value
// shows whether the new configuration reached the server.
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 3988)

function buildServer(token) {
  const server = new McpServer({ name: 'connector-hub-poc-test', version: '0.0.0' })
  server.registerTool('echo', {
    description: 'Return the given text unchanged, prefixed with "echo: ".',
    inputSchema: { text: z.string().describe('Text to echo') },
  }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }))
  server.registerTool('whoami', {
    description: 'Report the connector token this request carried.',
    inputSchema: {},
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ token }) }] }))
  return server
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (pathname !== '/mcp') {
    res.writeHead(404).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
    return
  }
  const token = req.headers['x-connector-token'] ?? null
  console.log(`${new Date().toISOString()} POST /mcp token=${token}`)
  const server = buildServer(token)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) res.writeHead(500).end()
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`connector-hub-poc test MCP server listening on http://127.0.0.1:${port}/mcp`)
})
