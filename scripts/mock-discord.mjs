// Tiny stand-in for a Discord webhook, for offline testing of the workflows.
//   node scripts/mock-discord.mjs            → http://localhost:8099/mock-discord
//   MOCK_FAIL=1 node scripts/mock-discord.mjs → always answers 500 (tests the delivery-failure path)
// Every received message is appended to mock-discord.log (gitignored).
import http from 'node:http';
import fs from 'node:fs';

const fail = process.env.MOCK_FAIL === '1';
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    n++;
    let content = body;
    try { content = JSON.parse(body).content ?? body; } catch {}
    const entry = `\n===== #${n} ${new Date().toISOString()} ${req.method} ${req.url} =====\n${content}\n`;
    fs.appendFileSync('mock-discord.log', entry);
    process.stdout.write(entry);
    if (fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"mock failure"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: String(Date.now()), type: 0, content: String(content).slice(0, 50) + '…', channel_id: 'mock' }));
  });
}).listen(8099, () => console.log(`mock Discord listening on :8099 (fail=${fail})`));
