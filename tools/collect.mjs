// AGF 2026 공식 참가사 목록을 받아 data/official-2026.json에 쓴다.
// 실행: node tools/collect.mjs
// 응답이 200이 아니거나 listData가 100건 미만이면 오류로 끝내고 옛 파일을 덮어쓰지 않는다.
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'official-2026.json');
const API = 'https://api.agfkorea.com:3070/front/api/getAttend?yy=2026';
const MIN_COUNT = 100;

function fail(msg) {
  console.error(`[collect] 오류: ${msg}`);
  console.error('[collect] 옛 파일은 그대로 둡니다.');
  process.exit(1);
}

let res;
try {
  res = await fetch(API, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
} catch (e) {
  fail(`요청 실패: ${e.message}`);
}
if (res.status !== 200) fail(`HTTP ${res.status}`);

let body;
try {
  body = await res.json();
} catch (e) {
  fail(`JSON 해석 실패: ${e.message}`);
}
const list = body?.listData;
if (!Array.isArray(list)) fail('응답에 listData 배열이 없습니다.');
if (list.length < MIN_COUNT) fail(`listData가 ${list.length}건으로 ${MIN_COUNT}건 미만입니다.`);
// 줄 모양이 바뀐 응답(userid·boothName이 없는 줄)으로 옛 파일을 덮어쓰지 않는다.
const bad = list.filter((b) => !b || typeof b.userid !== 'string' || !b.userid || typeof b.boothName !== 'string' || !b.boothName).length;
if (bad) fail(`listData ${list.length}건 중 ${bad}건에 userid나 boothName이 없습니다.`);

await mkdir(path.dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
try {
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  await rename(tmp, OUT);
} catch (e) {
  await rm(tmp, { force: true });
  fail(`파일을 쓰지 못했습니다 (${e.code ?? e.message})`);
}

const users = new Set(list.map((b) => b.userid));
console.log(`[collect] ${path.relative(ROOT, OUT)} 저장: ${list.length}건, userid ${users.size}종`);
