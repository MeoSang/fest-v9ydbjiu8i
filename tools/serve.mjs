// 의존성 없는 정적 서버: site/ 폴더를 http://localhost:5173 으로 제공한다.
// 사용: node tools/serve.mjs [--port 5173] [--root site]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : fallback;
};

const portArg = argValue('--port', '5173');
const port = Number(portArg);
// --port 0 이면 빈 포트를 운영체제가 고른다(check.mjs 가 쓴다). 실제 포트는 시작 줄에 찍는다.
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`포트 값이 올바르지 않습니다: ${portArg} (0~65535 정수)`);
  process.exit(2);
}
const root = resolve(here, '..', argValue('--root', 'site'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    const file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let target = file;
    const info = await stat(target).catch(() => null);
    if (info && info.isDirectory()) target = join(target, 'index.html');
    const body = await readFile(target).catch(() => null);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // 이 PC 안에서 다른 포트의 시험 자료(?data=…)를 읽을 수 있게 한다.
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`포트 ${port} 를 이미 다른 프로그램이 쓰고 있습니다. --port 로 다른 번호를 주세요.`);
  else console.error(`서버를 띄우지 못했습니다: ${err.message}`);
  process.exit(1);
});

// 이 PC 안에서만 열리도록 127.0.0.1 에만 묶는다(다른 PC 에서는 접속되지 않는다).
server.listen(port, '127.0.0.1', () => {
  console.log(`AGF 2026 부스 안내: http://localhost:${server.address().port}/  (${root})`);
});
