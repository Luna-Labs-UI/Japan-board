const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3456;
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const jobsHandler = require(path.join(ROOT, 'api', 'jobs.js'));
function likesHandler(req, res) { res.json({ counts: {} }); }

function shim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  res.end = res.end.bind(res);
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

http.createServer(async (req, res) => {
  shim(res);
  const url = req.url.split('?')[0];

  if (url === '/api/jobs') return jobsHandler(req, res);

  if (url === '/api/likes') {
    if (req.method === 'POST') req.body = await readBody(req);
    return likesHandler(req, res);
  }

  let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(filePath))   { res.statusCode = 404; return res.end('Not found'); }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}`));
