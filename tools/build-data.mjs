// 공식 목록과 손 자료를 합쳐 site/data/booths.json을 만든다.
// 실행: node tools/build-data.mjs [--data-dir <폴더>] [--out <파일>] [--cache <파일>]
//   --data-dir  official-2026.json, x-posts.json, booth-codes.json, groups.json을 읽을 폴더 (기본: data/)
//   --out       쓸 파일 (기본: site/data/booths.json)
//   --cache     oEmbed 캐시 파일 (기본: <data-dir>/embed-cache.json)
// 손 자료 셋은 없거나 깨져 있어도 경고만 하고 빈 값으로 계속한다.
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OEMBED = 'https://publish.x.com/oembed?omit_script=true&dnt=true&lang=ko&url=';
const PAUSE_MS = 300;
const MAX_PICKS = 3;
// 방문·참여 특전 글(gifts). 화면 맨 위에 고정한다.
const MAX_GIFTS = 3;
const MAX_GIFT_SUMMARY = 80;
const GIFT_KINDS = new Set(['visit', 'game', 'stamp', 'sns', 'purchase', 'etc']);
// https:// 없음, www.·mobile., 뒤의 /photo/N·/video/N, 끝 슬래시, ?s=20 같은 꼬리를 받아들인다.
const URL_RE = /^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?(?:\?[^#\s]*)?(?:#\S*)?$/i;
// 같은 글이 주소 모양만 달라 두 번 불리지 않도록 https://x.com/<계정>/status/<숫자>로 맞춘다.
function canonicalPostUrl(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(URL_RE) : null;
  return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
}
// 글 번호. 계정 이름의 대소문자만 다른 주소도 같은 글로 본다.
const postId = (url) => url.match(/\/status\/(\d+)$/)[1];
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
// "@foo", " @ foo ", "https://x.com/foo" 를 foo 로 맞춘다. 계정 이름 모양이 아니면 null.
function normalizeHandle(raw) {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().replace(/^@\s*/, '');
  const m = h.match(/^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  if (m) h = m[1];
  return HANDLE_RE.test(h) ? h : null;
}
// 퍼가기 html 허용 목록 검사. 캐시 항목과 새 응답에 똑같이 쓴다. 다시 쓰지 않고, 벗어나면 그 글을 뺀다.
// 통과: 최상위가 <blockquote class="twitter-tweet" …> 하나, 안의 태그는 blockquote·p·a·br만,
// 속성은 실제 oEmbed가 쓰는 것만(값은 큰따옴표), href는 https:// 로 시작.
const EMBED_ATTRS = {
  blockquote: new Set(['class', 'data-lang', 'data-dnt', 'data-theme', 'data-conversation', 'data-cards', 'data-align', 'data-width', 'data-link-color', 'data-media-max-width']),
  p: new Set(['lang', 'dir']),
  a: new Set(['href']),
  br: new Set(),
};
const TAG_RE = /^<(\/?)([a-z]+)((?:\s+[a-z][a-z0-9-]*(?:="[^"<>]*")?)*)\s*\/?>$/;
const ATTR_RE = /\s+([a-z][a-z0-9-]*)(?:="([^"<>]*)")?/g;
// 문제가 없으면 null, 있으면 까닭을 돌려준다.
function embedProblem(h) {
  if (typeof h !== 'string') return '문자열이 아님';
  const html = h.trim();
  const parts = html.split(/(<[^>]*>)/);
  const stack = [];
  let sawTop = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (part.includes('<')) return '태그가 아닌 < 가 있음';
      if (part.trim() && stack.length === 0) return '최상위 blockquote 밖에 글자가 있음';
      continue;
    }
    const m = part.match(TAG_RE);
    if (!m) return `허용하지 않는 태그 모양: ${part.slice(0, 40)}`;
    const [, close, tag, attrText] = m;
    if (!Object.hasOwn(EMBED_ATTRS, tag)) return `허용하지 않는 태그: <${tag}>`;
    if (close) {
      if (attrText) return `닫는 태그에 속성: ${part.slice(0, 40)}`;
      if (stack.pop() !== tag) return `태그 짝이 맞지 않음: </${tag}>`;
      continue;
    }
    if (stack.length === 0) {
      if (sawTop || tag !== 'blockquote') return '최상위가 blockquote 하나가 아님';
      sawTop = true;
    }
    for (const [, name, value] of attrText.matchAll(ATTR_RE)) {
      if (!EMBED_ATTRS[tag].has(name)) return `허용하지 않는 속성: <${tag} ${name}>`;
      if (name === 'href' && !/^https:\/\//i.test(value ?? '')) return `https가 아닌 링크: ${String(value).slice(0, 40)}`;
    }
    if (stack.length === 0 && !/(?:^|\s)class="(?:[^"]*\s)?twitter-tweet(?:\s[^"]*)?"/.test(attrText)) return '최상위 blockquote에 class="twitter-tweet"이 없음';
    if (tag !== 'br') stack.push(tag);
  }
  if (!sawTop) return 'blockquote가 없음';
  if (stack.length) return '닫히지 않은 태그가 있음';
  return null;
}
const isEmbedHtml = (h) => embedProblem(h) === null;

// ---- 인자 ----
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--(data-dir|out|cache)(?:=(.*))?$/);
    if (!m) {
      console.error(`[build] 알 수 없는 인자: ${a}`);
      process.exit(2);
    }
    const v = m[2] ?? argv[++i];
    if (!v) {
      console.error(`[build] --${m[1]} 값이 없습니다.`);
      process.exit(2);
    }
    opts[m[1]] = path.resolve(v);
  }
  return opts;
}
const args = parseArgs(process.argv.slice(2));
const DATA_DIR = args['data-dir'] ?? path.join(ROOT, 'data');
const OUT = args.out ?? path.join(ROOT, 'site', 'data', 'booths.json');
const CACHE = args.cache ?? path.join(DATA_DIR, 'embed-cache.json');

// ---- 경고 ----
const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.warn(`[build] 경고: ${msg}`);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 파일을 JSON으로 읽는다. 없거나 비었거나 깨졌으면 경고하고 fallback을 돌려준다.
async function readJsonSoft(file, label, fallback, { quietMissing = false } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && quietMissing) return fallback;
    if (e.code === 'ENOENT') warn(`${label} 파일이 없습니다 (${file}). 이 자료 없이 계속합니다.`);
    else warn(`${label} 파일을 읽지 못했습니다 (${e.code ?? e.message}). 이 자료 없이 계속합니다.`);
    return fallback;
  }
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) {
    warn(`${label} 파일이 비어 있습니다. 이 자료 없이 계속합니다.`);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    warn(`${label} JSON을 해석하지 못했습니다 (${e.message}). 이 자료 없이 계속합니다.`);
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    // 백신 등이 잠깐 잡고 있으면 바꿔치기가 실패하므로 몇 번 다시 한다.
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
        await sleep(100 * (i + 1));
      }
    }
    // 다른 프로그램이 파일을 잡고 있어 바꿔치기가 안 되면 직접 쓴다.
    try {
      await writeFile(file, text, 'utf8');
    } catch (e) {
      console.error(`[build] 오류: ${file}에 쓰지 못했습니다 (${e.code ?? e.message}). 옛 파일은 그대로 둡니다.`);
      await rm(tmp, { force: true });
      process.exit(1);
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 공식 목록 (필수) ----
const officialFile = path.join(DATA_DIR, 'official-2026.json');
let official;
try {
  official = JSON.parse((await readFile(officialFile, 'utf8')).replace(/^\uFEFF/, ''));
} catch (e) {
  console.error(`[build] 오류: 공식 목록을 읽지 못했습니다 (${officialFile}): ${e.message}`);
  console.error('[build] 먼저 node tools/collect.mjs를 실행하세요.');
  process.exit(1);
}
if (!Array.isArray(official) || official.length === 0) {
  console.error('[build] 오류: 공식 목록이 배열이 아니거나 비어 있습니다.');
  process.exit(1);
}

const boothKey = (b) => `${b.userid}/${b.boothName}`;
const boothKeys = new Set();
// userid·boothName이 없는 줄과 같은 열쇠의 두 번째 줄은 뺀다(부스 id가 겹치거나 "undefined/undefined"가 되지 않게).
official = official.filter((b, i) => {
  if (!isObj(b) || typeof b.userid !== 'string' || !b.userid || typeof b.boothName !== 'string' || !b.boothName) {
    warn(`공식 목록 ${i + 1}번째 줄에 userid나 boothName이 없어 뺍니다.`);
    return false;
  }
  const k = boothKey(b);
  if (boothKeys.has(k)) {
    warn(`공식 목록에 같은 부스 열쇠가 두 번 있어 뒤의 것을 뺍니다: ${k}`);
    return false;
  }
  boothKeys.add(k);
  return true;
});
if (official.length === 0) {
  console.error('[build] 오류: 공식 목록에 쓸 수 있는 줄이 없습니다.');
  process.exit(1);
}
const userIds = new Set(official.map((b) => b.userid));

// ---- 손 자료 ----
let xPosts = await readJsonSoft(path.join(DATA_DIR, 'x-posts.json'), 'x-posts.json', null);
// x-posts를 제대로 읽었을 때만 캐시에서 더는 안 쓰는 글을 정리한다(읽기 실패로 캐시가 통째로 지워지지 않게).
const xPostsLoaded = isObj(xPosts);
if (xPosts !== null && !xPostsLoaded) warn('x-posts.json 최상위가 객체가 아닙니다. 이 자료 없이 계속합니다.');
if (!xPostsLoaded) xPosts = {};

let codesDoc = await readJsonSoft(path.join(DATA_DIR, 'booth-codes.json'), 'booth-codes.json', {});
let codes = {};
if (!isObj(codesDoc)) warn('booth-codes.json 최상위가 객체가 아닙니다. 이 자료 없이 계속합니다.');
else if (codesDoc.codes === undefined) {
  if (Object.keys(codesDoc).length) warn('booth-codes.json에 codes 항목이 없습니다. 이 자료 없이 계속합니다.');
} else if (!isObj(codesDoc.codes)) warn('booth-codes.json의 codes가 객체가 아닙니다. 이 자료 없이 계속합니다.');
else codes = codesDoc.codes;

let groups = await readJsonSoft(path.join(DATA_DIR, 'groups.json'), 'groups.json', {});
if (!isObj(groups)) {
  warn('groups.json 최상위가 객체가 아닙니다. 이 자료 없이 계속합니다.');
  groups = {};
}

// 공식 목록에 없는 열쇠 (오타 찾기용)
function reportUnknown(label, keys, known) {
  const bad = keys.filter((k) => !known.has(k));
  if (bad.length) warn(`${label}에 공식 목록에 없는 열쇠 ${bad.length}개: ${bad.map((k) => JSON.stringify(k)).join(', ')}`);
}
reportUnknown('x-posts.json', Object.keys(xPosts), boothKeys);
reportUnknown('booth-codes.json codes', Object.keys(codes), boothKeys);
reportUnknown('groups.json', Object.keys(groups), userIds);

// ---- oEmbed 캐시 ----
let cache = await readJsonSoft(CACHE, 'embed-cache.json', null, { quietMissing: true });
if (cache === null) cache = {};
else if (!isObj(cache)) {
  warn('embed-cache.json 최상위가 객체가 아닙니다. 빈 캐시로 시작합니다.');
  cache = {};
}
let cacheDirty = false;
// 캐시에 <script>가 들어갔거나 blockquote가 아닌 항목, 글 주소가 아닌 열쇠는 버린다.
const cacheById = new Map(); // 글 번호 → 캐시 열쇠
for (const [u, h] of Object.entries(cache)) {
  const cu = canonicalPostUrl(u);
  const problem = cu ? embedProblem(h) : '열쇠가 글 주소가 아님';
  if (problem) {
    warn(`캐시 항목이 올바르지 않아 버립니다(${problem}): ${u}`);
    delete cache[u];
    cacheDirty = true;
    continue;
  }
  cacheById.set(postId(cu), u);
}

let netCalls = 0;
let cacheHits = 0;
let lastCallAt = 0;
let rateLimited = false; // 429를 받으면 이번 실행에서는 더 부르지 않는다.
let skippedByLimit = 0;
const failedIds = new Set(); // 이번 실행에서 실패한 글은 다른 부스에서 다시 부르지 않는다.
const usedIds = new Set(); // 이번 실행에서 쓴 글(캐시 정리용)

// 성공하면 html 문자열, 실패하면 null
async function getEmbed(url, boothId) {
  const id = postId(url);
  usedIds.add(id);
  const cachedKey = cacheById.get(id);
  if (cachedKey !== undefined) {
    cacheHits++;
    return cache[cachedKey];
  }
  if (failedIds.has(id)) return null;
  if (rateLimited) {
    skippedByLimit++;
    return null;
  }
  const html = await fetchEmbed(url, boothId);
  if (html === null) {
    failedIds.add(id);
    return null;
  }
  cache[url] = html;
  cacheById.set(id, url);
  cacheDirty = true;
  return html;
}

async function fetchEmbed(url, boothId) {
  const wait = lastCallAt + PAUSE_MS - Date.now();
  if (lastCallAt && wait > 0) await sleep(wait);
  netCalls++;
  let res;
  try {
    res = await fetch(OEMBED + encodeURIComponent(url), { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    lastCallAt = Date.now();
    warn(`[${boothId}] oEmbed 네트워크 실패, 이 글은 건너뜁니다: ${url} (${e.cause?.code ?? e.message})`);
    return null;
  }
  lastCallAt = Date.now();
  if (res.status === 404) {
    warn(`[${boothId}] 지워진 글(404)이라 뺍니다: ${url}`);
    return null;
  }
  if (res.status === 429) {
    rateLimited = true;
    warn(`[${boothId}] oEmbed HTTP 429(요청 한도), 이번 실행에서는 더 부르지 않고 캐시만 씁니다: ${url}`);
    return null;
  }
  if (res.status !== 200) {
    warn(`[${boothId}] oEmbed HTTP ${res.status}, 이 글은 건너뜁니다: ${url}`);
    return null;
  }
  let html;
  try {
    html = (await res.json())?.html;
  } catch (e) {
    warn(`[${boothId}] oEmbed 응답 JSON 해석 실패, 이 글은 건너뜁니다: ${url}`);
    return null;
  }
  if (typeof html !== 'string' || !/^\s*<blockquote[\s>]/i.test(html)) {
    warn(`[${boothId}] oEmbed 응답에 blockquote html이 없어 건너뜁니다: ${url}`);
    return null;
  }
  const problem = embedProblem(html);
  if (problem) {
    warn(`[${boothId}] oEmbed html이 허용 목록을 벗어나 버립니다(${problem}): ${url}`);
    return null;
  }
  return html.trim();
}

// x-posts의 gifts를 [{ url, kinds, summary, embed }]로 맞춘다. 퍼가기를 못 받아도 항목은 남기고 embed: null.
async function buildGifts(entry, key) {
  let gifts = entry.gifts ?? [];
  if (!Array.isArray(gifts)) {
    warn(`[${key}] gifts가 배열이 아니라 특전 없이 넣습니다.`);
    gifts = [];
  }
  if (gifts.length > MAX_GIFTS) {
    warn(`[${key}] gifts가 ${gifts.length}개라 앞 ${MAX_GIFTS}개만 씁니다.`);
    gifts = gifts.slice(0, MAX_GIFTS);
  }
  const out = [];
  const seenIds = new Set();
  for (const g of gifts) {
    if (!isObj(g)) {
      warn(`[${key}] gifts 항목이 객체가 아니라 뺍니다: ${JSON.stringify(g)}`);
      continue;
    }
    const url = canonicalPostUrl(g.url);
    if (!url) {
      warn(`[${key}] 특전 글 주소 모양이 아니라 뺍니다: ${JSON.stringify(g.url)}`);
      continue;
    }
    if (seenIds.has(postId(url))) {
      warn(`[${key}] gifts에 같은 글이 두 번 있어 하나만 씁니다: ${url}`);
      continue;
    }
    seenIds.add(postId(url));
    let kinds = typeof g.kinds === 'string' ? [g.kinds] : g.kinds ?? [];
    if (!Array.isArray(kinds)) {
      warn(`[${key}] 특전 kinds가 배열이 아니라 etc로 둡니다: ${url}`);
      kinds = [];
    }
    const badKinds = kinds.filter((k) => !GIFT_KINDS.has(k));
    if (badKinds.length) warn(`[${key}] 특전 kinds에 약속에 없는 값이 있어 뺍니다: ${badKinds.map((k) => JSON.stringify(k)).join(', ')} (${url})`);
    kinds = [...new Set(kinds.filter((k) => GIFT_KINDS.has(k)))];
    if (!kinds.length) kinds = ['etc'];
    // 화면이 textContent로 넣는 순수 글자. 공백·줄바꿈을 한 칸으로 맞추고 80자(글자 단위)로 자른다.
    let summary = typeof g.summary === 'string' ? g.summary.replace(/\s+/g, ' ').trim() : '';
    const chars = Array.from(summary);
    if (chars.length > MAX_GIFT_SUMMARY) {
      warn(`[${key}] 특전 summary가 ${chars.length}자라 ${MAX_GIFT_SUMMARY}자로 자릅니다: ${url}`);
      summary = chars.slice(0, MAX_GIFT_SUMMARY).join('');
    }
    const embed = await getEmbed(url, key);
    out.push({ url, kinds, summary, embed: embed ?? null });
  }
  return out;
}

async function buildX(key) {
  if (!Object.hasOwn(xPosts, key)) return null; // 아직 안 본 부스
  const entry = xPosts[key];
  if (entry === null) return null; // 계정을 못 찾은 부스
  if (!isObj(entry)) {
    warn(`[${key}] x-posts 값이 객체도 null도 아니라 무시합니다.`);
    return null;
  }
  const handle = normalizeHandle(entry.handle);
  if (!handle) {
    warn(`[${key}] x-posts의 handle이 없거나 계정 이름 모양이 아니라 무시합니다: ${JSON.stringify(entry.handle)}`);
    return null;
  }
  let picks = entry.picks ?? [];
  if (typeof picks === 'string') {
    warn(`[${key}] picks가 문자열 하나라 배열로 감싸 씁니다.`);
    picks = [picks];
  }
  if (!Array.isArray(picks)) {
    warn(`[${key}] picks가 배열이 아니라 글 없이 계정만 넣습니다.`);
    picks = [];
  }
  if (picks.length > MAX_PICKS) {
    warn(`[${key}] picks가 ${picks.length}개라 앞 ${MAX_PICKS}개만 씁니다.`);
    picks = picks.slice(0, MAX_PICKS);
  }
  const gifts = await buildGifts(entry, key);
  const giftIds = new Set(gifts.map((g) => postId(g.url)));
  const outPicks = [];
  const embeds = [];
  const seen = new Set();
  for (const raw of picks) {
    const url = canonicalPostUrl(raw);
    if (!url) {
      warn(`[${key}] 글 주소 모양이 아니라 건너뜁니다: ${JSON.stringify(raw)}`);
      continue;
    }
    if (giftIds.has(postId(url))) {
      warn(`[${key}] 같은 글이 gifts에도 있어 picks에서 뺍니다: ${url}`);
      continue;
    }
    if (seen.has(url)) {
      warn(`[${key}] 같은 글 주소가 두 번 있어 하나만 씁니다: ${url}`);
      continue;
    }
    seen.add(url);
    const html = await getEmbed(url, key);
    if (html === null) continue;
    outPicks.push(url);
    embeds.push(html);
  }
  return { handle, picks: outPicks, embeds, gifts };
}

// ---- 조립 ----
const companies = [];
const byUser = new Map();
for (const b of official) {
  let c = byUser.get(b.userid);
  if (!c) {
    c = { id: b.userid, booths: [] };
    byUser.set(b.userid, c);
    companies.push(c);
  }
  const key = boothKey(b);
  let code = Object.hasOwn(codes, key) ? codes[key] : null;
  if (code !== null && typeof code !== 'string') {
    warn(`[${key}] 부스 번호가 문자열이 아니라 null로 둡니다: ${JSON.stringify(code)}`);
    code = null;
  }
  if (typeof code === 'string') code = code.trim() || null;
  const category = Number(b.attendAni);
  if (!(Number.isInteger(category) && category >= 1 && category <= 7)) warn(`[${key}] attendAni가 1~7이 아닙니다: ${JSON.stringify(b.attendAni)}`);
  c.booths.push({
    id: key,
    name: b.boothName,
    category,
    logo: b.logoJpg ?? '',
    copy: b.promotionCopy ?? '',
    homepage: b.homepage ?? '',
    code,
    x: await buildX(key),
  });
}

const uniq = (arr) => [...new Set(arr.filter((v) => v !== null && v !== undefined))];
const result = companies.map((c) => {
  let name;
  if (c.booths.length === 1) name = c.booths[0].name;
  else {
    const g = groups[c.id];
    if (isObj(g) && typeof g.name === 'string' && g.name.trim()) name = g.name.trim();
    else {
      if (Object.hasOwn(groups, c.id)) warn(`[${c.id}] groups.json의 name이 올바르지 않아 기본 이름을 씁니다.`);
      name = `${c.booths[0].name} 외 ${c.booths.length - 1}`;
    }
  }
  return {
    id: c.id,
    name,
    logo: c.booths[0].logo,
    categories: uniq(c.booths.map((b) => b.category)),
    codes: uniq(c.booths.map((b) => b.code)),
    booths: c.booths,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  source: 'https://www.agfkorea.com/information',
  mapUrl: 'https://www.agfkorea.com/event?idx=3',
  companies: result,
};

let pruned = 0;
if (xPostsLoaded) {
  for (const [u] of Object.entries(cache)) {
    if (!usedIds.has(postId(canonicalPostUrl(u)))) {
      delete cache[u];
      pruned++;
    }
  }
  if (pruned) cacheDirty = true;
}
if (skippedByLimit) warn(`요청 한도(429) 때문에 퍼가기를 받지 못한 글 ${skippedByLimit}개가 더 있습니다. 나중에 다시 빌드하세요.`);

if (cacheDirty) await writeJsonAtomic(CACHE, cache);
await writeJsonAtomic(OUT, out);

// ---- 요약 ----
const allBooths = result.flatMap((c) => c.booths);
const withX = allBooths.filter((b) => b.x).length;
const pickCount = allBooths.reduce((n, b) => n + (b.x ? b.x.embeds.length : 0), 0);
const withCode = allBooths.filter((b) => b.code).length;
const inputPicks = Object.values(xPosts).reduce((n, e) => n + (!isObj(e) ? 0 : Array.isArray(e.picks) ? e.picks.length : typeof e.picks === 'string' ? 1 : 0), 0);
const inputGifts = Object.values(xPosts).reduce((n, e) => n + (isObj(e) && Array.isArray(e.gifts) ? e.gifts.length : 0), 0);
const giftEmbeds = allBooths.reduce((n, b) => n + (b.x ? b.x.gifts.filter((g) => g.embed).length : 0), 0);
const withGifts = allBooths.filter((b) => b.x && b.x.gifts.length).length;
console.log(`[build] ${OUT} 저장`);
console.log(`[build] oEmbed: 네트워크 호출 ${netCalls}회, 캐시 사용 ${cacheHits}회, 안 쓰는 캐시 정리 ${pruned}개 (캐시 ${CACHE})`);
console.log(
  `[build] 요약: 회사 ${result.length}곳, 부스 ${allBooths.length}개, X 계정 있는 부스 ${withX}개, ` +
    `고른 글 ${pickCount}개(입력 ${inputPicks}개 중 퍼가기 받은 글), 번호 있는 부스 ${withCode}개, ` +
    `특전 글 ${giftEmbeds}개(입력 ${inputGifts}개 중 퍼가기 받은 글), 특전 있는 부스 ${withGifts}개, 경고 ${warnings.length}건`
);
