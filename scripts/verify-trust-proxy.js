import express from 'express';

const app = express();
app.set('trust proxy', 1);
app.get('/ip', (req, res) => res.json({ ip: req.ip }));

const server = app.listen(0, async () => {
  const { port } = server.address();
  const r1 = await fetch(`http://localhost:${port}/ip`).then(r => r.json());
  const r2 = await fetch(`http://localhost:${port}/ip`, {
    headers: { 'X-Forwarded-For': '203.0.113.4' }
  }).then(r => r.json());

  console.log('Without X-Forwarded-For:', r1.ip);
  console.log('With X-Forwarded-For:   ', r2.ip);

  const ok = r2.ip === '203.0.113.4';
  console.log(ok ? '✅ trust proxy working' : '❌ trust proxy NOT working');
  server.close();
  process.exit(ok ? 0 : 1);
});
