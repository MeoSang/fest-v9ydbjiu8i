// 창 없는 검사. 의존성 없음(Node 22 이상: fetch·WebSocket 내장).
// 사용: node tools/check.mjs [--verbose] [--net] [--ui] [--data <booths.json 또는 폴더>]
//   --data 폴더를 주면 그 폴더의 booths.json·official-2026.json·x-posts.json·booth-codes.json·groups.json을 쓴다.
//   --data 파일을 주면 그 파일을 booths.json으로 쓰고 손 자료는 data/에서 읽는다.
//   --site <폴더>: 화면 검사(--ui)에서 site/ 대신 띄울 폴더(index.html·data/booths.json 이 있는 곳).
//   --gifts-sample: 화면 검사를 시험용 특전 자료(부스 둘에 gifts 를 넣은 임시 사본)로 돌린다.
//     실제 자료에 특전이 하나도 없으면 이 인자 없이도 시험용 자료로 돌린다(경고로 알림).
// 출력: 항목마다 ✓(통과) / !(경고) / ✗(실패). 실패가 하나라도 있으면 종료 코드 1.
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argValue = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(n + '='));
  return eq ? eq.slice(n.length + 1) : null;
};
const VERBOSE = flag('--verbose');

let failures = 0;
let warnings = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const warn = (msg) => { warnings++; console.log(`! ${msg}`); };
const fail = (msg) => { failures++; console.log(`✗ ${msg}`); };
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(detail ? `${msg} — ${detail}` : msg));
const listOut = (items, max = 20) => {
  const shown = items.slice(0, max).map((s) => `    ${s}`);
  if (items.length > max) shown.push(`    … 외 ${items.length - max}건`);
  return shown.join('\n');
};
const section = (t) => console.log(`\n[${t}]`);

// ---------- 자료 위치 ----------
const dataArg = argValue('--data');
let boothsPath = join(ROOT, 'site', 'data', 'booths.json');
let handDir = join(ROOT, 'data');
if (dataArg) {
  const p = resolve(process.cwd(), dataArg);
  if (existsSync(p) && statSync(p).isDirectory()) { boothsPath = join(p, 'booths.json'); handDir = p; }
  else boothsPath = p;
}

function readJson(path, label, { required = false } = {}) {
  if (!existsSync(path)) {
    (required ? fail : warn)(`${label} 없음 (${path})`);
    return undefined;
  }
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { fail(`${label} JSON 읽기 실패 — ${e.message}`); return undefined; }
}

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const PICK_RE = /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/;
const HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/;
// 방문·참여 특전(gifts): 최대 3개, url 은 PICK_RE, kinds 는 약속된 값 1개 이상, summary 는 80자 이하 문자열
const GIFT_KINDS = new Set(['visit', 'game', 'stamp', 'sns', 'purchase', 'etc']);
// gifts 배열 하나를 보고 문제 목록을 돌려준다. withEmbed: booths.json 쪽(embed 는 문자열 또는 null, <script 없음)
function giftProblems(id, gifts, picks, withEmbed) {
  if (!Array.isArray(gifts)) return [`${id}: gifts 배열 아님`];
  const out = [];
  if (gifts.length > 3) out.push(`${id}: gifts ${gifts.length}개 (3개 초과)`);
  const pickSet = new Set(Array.isArray(picks) ? picks : []);
  for (const [i, g] of gifts.entries()) {
    const at = `${id} gifts[${i}]`;
    if (!isObj(g)) { out.push(`${at}: 객체 아님`); continue; }
    if (!isStr(g.url) || !PICK_RE.test(g.url)) out.push(`${at}: url 모양 ${JSON.stringify(g.url)}`);
    if (!Array.isArray(g.kinds) || g.kinds.length === 0) out.push(`${at}: kinds 가 1개 이상인 배열 아님`);
    else for (const k of g.kinds) if (!GIFT_KINDS.has(k)) out.push(`${at}: 약속에 없는 kinds ${JSON.stringify(k)}`);
    if (!isStr(g.summary)) out.push(`${at}: summary 문자열 아님`);
    else if ([...g.summary].length > 80) out.push(`${at}: summary ${[...g.summary].length}자 (80자 초과)`);
    if (withEmbed) {
      if (!('embed' in g) || !(g.embed === null || isStr(g.embed))) out.push(`${at}: embed 가 문자열 또는 null 아님`);
      else if (isStr(g.embed) && /<script/i.test(g.embed)) out.push(`${at}: embed 에 <script`);
    }
    if (isStr(g.url) && pickSet.has(g.url)) out.push(`${at}: 같은 주소가 picks 에도 있음 ${g.url}`);
  }
  const urls = gifts.filter(isObj).map((g) => g.url);
  const dup = [...new Set(urls.filter((u, i) => urls.indexOf(u) !== i))];
  if (dup.length) out.push(`${id}: gifts 안에서 같은 주소 반복 ${dup.join(', ')}`);
  return out;
}

// 공식 참가사 리스트 그림의 표기(A01, B03, …) 또는 그 범위 표기(R01~R03)
const CODE_RE = /^[A-Z]\d{2}(?:~[A-Z]\d{2})?$/;

// ---------- 1. 자료 검사 ----------
section('자료');
console.log(`  booths: ${boothsPath}`);
console.log(`  손 자료: ${handDir}`);

const officialRaw = readJson(join(handDir, 'official-2026.json'), '공식 원본 official-2026.json');
const official = Array.isArray(officialRaw) ? officialRaw : officialRaw?.listData;
const officialKeys = official ? new Set(official.map((x) => `${x.userid}/${x.boothName}`)) : null;
const officialUsers = official ? new Set(official.map((x) => x.userid)) : null;
const EXPECT_COMPANIES = officialUsers ? officialUsers.size : 101;
const EXPECT_BOOTHS = official ? official.length : 129;
if (official) {
  check(officialKeys.size === official.length, `공식 원본 부스 열쇠 고유 (${officialKeys.size}/${official.length})`);
}

const data = readJson(boothsPath, 'booths.json', { required: true });
const allBooths = [];
if (data) {
  const topMissing = ['generatedAt', 'source', 'mapUrl', 'companies'].filter((k) => !(k in data));
  check(topMissing.length === 0, '최상위 칸 generatedAt·source·mapUrl·companies', `빠짐: ${topMissing.join(', ')}`);
  check(isStr(data.mapUrl) && /^https?:\/\//.test(data.mapUrl), `mapUrl 주소 모양 (${data.mapUrl})`);
  const companies = Array.isArray(data.companies) ? data.companies : [];
  check(companies.length === EXPECT_COMPANIES, `회사 수 ${companies.length} (기대 ${EXPECT_COMPANIES})`);

  const compIds = companies.map((c) => c?.id);
  const dupComp = compIds.filter((id, i) => compIds.indexOf(id) !== i);
  check(dupComp.length === 0, '회사 id 중복 0', `중복: ${[...new Set(dupComp)].join(', ')}`);

  const compFieldErr = [];
  const boothFieldErr = [];
  const badCategory = [];
  const badPrefix = [];
  const aggErr = [];
  for (const c of companies) {
    if (!isObj(c)) { compFieldErr.push(String(c)); continue; }
    const miss = [];
    if (!isStr(c.id) || !c.id) miss.push('id');
    if (!isStr(c.name) || !c.name) miss.push('name');
    if (!isStr(c.logo)) miss.push('logo');
    if (!Array.isArray(c.categories)) miss.push('categories');
    if (!Array.isArray(c.codes)) miss.push('codes');
    if (!Array.isArray(c.booths) || c.booths.length === 0) miss.push('booths');
    if (miss.length) compFieldErr.push(`${c.id}: ${miss.join(', ')}`);
    for (const b of Array.isArray(c.booths) ? c.booths : []) {
      allBooths.push({ company: c, booth: b });
      if (!isObj(b)) { boothFieldErr.push(`${c.id}: ${String(b)}`); continue; }
      const bm = [];
      for (const k of ['id', 'name', 'logo', 'copy', 'homepage']) if (!isStr(b[k])) bm.push(k);
      if (!('category' in b)) bm.push('category');
      if (!('code' in b) || !(b.code === null || isStr(b.code))) bm.push('code');
      if (!('x' in b) || !(b.x === null || isObj(b.x))) bm.push('x');
      if (bm.length) boothFieldErr.push(`${b.id ?? c.id}: ${bm.join(', ')}`);
      if (!(Number.isInteger(b.category) && b.category >= 1 && b.category <= 7)) badCategory.push(`${b.id}: ${JSON.stringify(b.category)}`);
      if (isStr(b.id) && !b.id.startsWith(c.id + '/')) badPrefix.push(b.id);
    }
    if (Array.isArray(c.booths) && Array.isArray(c.categories) && Array.isArray(c.codes)) {
      const cats = [...new Set(c.booths.map((b) => b?.category))].sort().join(',');
      const ccats = [...new Set(c.categories)].sort().join(',');
      const codes = [...new Set(c.booths.map((b) => b?.code).filter(Boolean))].sort().join(',');
      const ccodes = [...new Set(c.codes)].sort().join(',');
      if (cats !== ccats) aggErr.push(`${c.id}: categories [${ccats}] ≠ 부스 [${cats}]`);
      if (codes !== ccodes) aggErr.push(`${c.id}: codes [${ccodes}] ≠ 부스 [${codes}]`);
    }
  }
  check(compFieldErr.length === 0, '회사 필수 칸(id·name·logo·categories·codes·booths)', `${compFieldErr.length}건\n${listOut(compFieldErr)}`);
  check(allBooths.length === EXPECT_BOOTHS, `부스 합 ${allBooths.length} (기대 ${EXPECT_BOOTHS})`);
  check(boothFieldErr.length === 0, '부스 필수 칸(id·name·category·logo·copy·homepage·code·x)', `${boothFieldErr.length}건\n${listOut(boothFieldErr)}`);
  const bIds = allBooths.map(({ booth }) => booth?.id);
  const dupB = [...new Set(bIds.filter((id, i) => bIds.indexOf(id) !== i))];
  check(dupB.length === 0, '부스 열쇠 중복 0', `중복 ${dupB.length}건\n${listOut(dupB)}`);
  check(badCategory.length === 0, 'category 값 1~7', `${badCategory.length}건\n${listOut(badCategory)}`);
  check(badPrefix.length === 0, '부스 열쇠가 "<회사 id>/"로 시작', `${badPrefix.length}건\n${listOut(badPrefix)}`);
  check(aggErr.length === 0, '회사 categories·codes가 부스 값의 모음과 같음', `${aggErr.length}건\n${listOut(aggErr)}`);

  if (officialKeys) {
    const set = new Set(bIds);
    const extra = bIds.filter((k) => !officialKeys.has(k));
    const missing = [...officialKeys].filter((k) => !set.has(k));
    check(extra.length === 0 && missing.length === 0, '부스 열쇠가 공식 목록과 같음',
      `공식에 없음 ${extra.length}: ${extra.slice(0, 5).join(' | ')} / 빠짐 ${missing.length}: ${missing.slice(0, 5).join(' | ')}`);
  }

  // X 자료
  const badPicks = [];
  const badHandle = [];
  const scriptEmbeds = [];
  const tooManyEmbeds = [];
  const tooManyPicks = [];
  for (const { booth: b } of allBooths) {
    if (!isObj(b) || !isObj(b.x)) continue;
    const x = b.x;
    if (!isStr(x.handle) || !HANDLE_RE.test(x.handle)) badHandle.push(`${b.id}: ${JSON.stringify(x.handle)}`);
    const picks = Array.isArray(x.picks) ? x.picks : null;
    const embeds = Array.isArray(x.embeds) ? x.embeds : null;
    if (!picks) badPicks.push(`${b.id}: picks 배열 아님`);
    else {
      if (picks.length > 3) tooManyPicks.push(`${b.id}: ${picks.length}`);
      for (const p of picks) if (!isStr(p) || !PICK_RE.test(p)) badPicks.push(`${b.id}: ${p}`);
    }
    if (!embeds) badPicks.push(`${b.id}: embeds 배열 아님`);
    else {
      for (const e of embeds) if (!isStr(e) || /<script/i.test(e)) scriptEmbeds.push(b.id);
      if (picks && embeds.length > picks.length) tooManyEmbeds.push(`${b.id}: embeds ${embeds.length} > picks ${picks.length}`);
    }
  }
  check(badHandle.length === 0, 'X handle 모양', `${badHandle.length}건\n${listOut(badHandle)}`);
  check(badPicks.length === 0, 'picks 주소 모양(https://x.com/<계정>/status/<숫자>)', `${badPicks.length}건\n${listOut(badPicks)}`);
  check(tooManyPicks.length === 0, 'picks 3개 이하', `${tooManyPicks.length}건\n${listOut(tooManyPicks)}`);
  check(scriptEmbeds.length === 0, 'embeds에 <script 없음', `${scriptEmbeds.length}건\n${listOut([...new Set(scriptEmbeds)])}`);
  check(tooManyEmbeds.length === 0, 'embeds 수 ≤ picks 수', `${tooManyEmbeds.length}건\n${listOut(tooManyEmbeds)}`);

  // 방문·참여 특전(gifts): x 가 있으면 gifts 는 항상 배열
  const giftBad = [];
  let giftBooths = 0;
  let giftPosts = 0;
  for (const { booth: b } of allBooths) {
    if (!isObj(b) || !isObj(b.x)) continue;
    if (!('gifts' in b.x)) { giftBad.push(`${b.id}: x 에 gifts 배열이 없음`); continue; }
    giftBad.push(...giftProblems(b.id, b.x.gifts, b.x.picks, true));
    if (Array.isArray(b.x.gifts) && b.x.gifts.length) { giftBooths += 1; giftPosts += b.x.gifts.length; }
  }
  check(giftBad.length === 0, 'booths.json gifts 모양(x 마다 배열·3개 이하·url·kinds·summary 80자·embed 문자열|null·<script 없음·picks 와 주소 겹침 없음)', `${giftBad.length}건\n${listOut(giftBad)}`);
  if (giftPosts) ok(`방문·참여 특전: 부스 ${giftBooths}곳, 특전 글 ${giftPosts}건`);
  else warn('방문·참여 특전 0건 (booths.json 에 gifts 가 든 부스가 아직 없음)');

  // 번호 표기
  const codes = allBooths.map(({ booth }) => booth?.code).filter((c) => c !== null && c !== undefined);
  const badCode = [...new Set(codes.filter((c) => !isStr(c) || !CODE_RE.test(c)))];
  check(badCode.length === 0, `부스 번호 표기 모양 일정(영문 1자+숫자 2자리 또는 범위 X00~X00, ${codes.length}곳)`, `어긋남: ${badCode.join(', ')}`);
  // 같은 번호를 서로 다른 회사가 쓰는지(정보)
  const codeOwners = {};
  for (const { company, booth } of allBooths) if (booth?.code) (codeOwners[booth.code] ??= new Set()).add(company.id);
  const shared = Object.entries(codeOwners).filter(([, s]) => s.size > 1).map(([c, s]) => `${c}: ${[...s].join(', ')}`);
  if (shared.length) warn(`번호 하나를 여러 회사가 씀 ${shared.length}건\n${listOut(shared)}`);
  else ok('번호 하나를 여러 회사가 같이 쓰지 않음');

  // 경고: X 없는 부스, 번호 없는 부스
  const noX = allBooths.filter(({ booth }) => isObj(booth) && booth.x === null).map(({ booth }) => booth.id);
  const noCode = allBooths.filter(({ booth }) => isObj(booth) && !booth.code).map(({ booth }) => booth.id);
  if (noX.length) warn(`X 계정 없는 부스 ${noX.length}/${allBooths.length}${VERBOSE ? '\n' + listOut(noX, 1000) : ' (목록은 --verbose)'}`);
  else ok('모든 부스에 X 자료 있음');
  if (noCode.length) warn(`번호 없는 부스 ${noCode.length}/${allBooths.length}${VERBOSE ? '\n' + listOut(noCode, 1000) : ' (목록은 --verbose)'}`);
  else ok('모든 부스에 번호 있음');
}

// 손 자료
section('손 자료');
const xPosts = readJson(join(handDir, 'x-posts.json'), 'x-posts.json');
const boothCodes = readJson(join(handDir, 'booth-codes.json'), 'booth-codes.json');
const groups = readJson(join(handDir, 'groups.json'), 'groups.json');
const builtById = new Map(allBooths.map(({ booth }) => [booth?.id, booth]));
const builtComp = new Map((data?.companies ?? []).map((c) => [c?.id, c]));

if (xPosts !== undefined) {
  if (!isObj(xPosts)) fail('x-posts.json 이 객체가 아님');
  else {
    const keys = Object.keys(xPosts);
    if (officialKeys) {
      const extra = keys.filter((k) => !officialKeys.has(k));
      check(extra.length === 0, `x-posts 열쇠가 모두 공식 목록에 있음 (${keys.length}개)`, `없는 열쇠 ${extra.length}\n${listOut(extra)}`);
    }
    const bad = [];
    for (const [k, v] of Object.entries(xPosts)) {
      if (v === null) continue;
      if (!isObj(v)) { bad.push(`${k}: 객체 아님`); continue; }
      if (!isStr(v.handle) || !HANDLE_RE.test(v.handle)) bad.push(`${k}: handle ${JSON.stringify(v.handle)}`);
      if (!Array.isArray(v.picks) || v.picks.length > 3) bad.push(`${k}: picks 배열 아님 또는 3개 초과`);
      else for (const p of v.picks) if (!isStr(p) || !PICK_RE.test(p)) bad.push(`${k}: ${p}`);
    }
    check(bad.length === 0, 'x-posts 값 모양(handle·picks)', `${bad.length}건\n${listOut(bad)}`);
    // gifts 는 고를 때만 있는 칸(선택)
    const gBad = [];
    let gBooths = 0;
    let gPosts = 0;
    for (const [k, v] of Object.entries(xPosts)) {
      if (!isObj(v) || !('gifts' in v)) continue;
      gBad.push(...giftProblems(k, v.gifts, v.picks, false));
      if (Array.isArray(v.gifts) && v.gifts.length) { gBooths += 1; gPosts += v.gifts.length; }
    }
    check(gBad.length === 0, `x-posts gifts 모양 (특전 있는 부스 ${gBooths}곳, 특전 글 ${gPosts}건)`, `${gBad.length}건\n${listOut(gBad)}`);
  }
}

if (boothCodes !== undefined) {
  const codes = boothCodes?.codes;
  if (!isObj(codes)) fail('booth-codes.json 에 codes 객체 없음');
  else {
    const keys = Object.keys(codes);
    if (officialKeys) {
      const extra = keys.filter((k) => !officialKeys.has(k));
      check(extra.length === 0, `booth-codes 열쇠가 모두 공식 목록에 있음 (${keys.length}개)`, `없는 열쇠 ${extra.length}\n${listOut(extra)}`);
      const missing = [...officialKeys].filter((k) => !(k in codes));
      if (missing.length) warn(`booth-codes 에 빠진 공식 부스 ${missing.length}\n${listOut(missing)}`);
      else ok('booth-codes 가 공식 부스를 모두 담음');
    }
    const badVal = Object.entries(codes).filter(([, v]) => !(v === null || (isStr(v) && CODE_RE.test(v)))).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    check(badVal.length === 0, 'booth-codes 값이 번호 표기 또는 null', `${badVal.length}건\n${listOut(badVal)}`);
    if (data) {
      const diff = Object.entries(codes).filter(([k, v]) => builtById.has(k) && (builtById.get(k)?.code ?? null) !== v).map(([k, v]) => `${k}: 손 ${v} / 빌드 ${builtById.get(k)?.code ?? null}`);
      if (diff.length) warn(`booth-codes 와 booths.json 번호가 다름 ${diff.length}건 (빌드를 다시 돌려야 할 수 있음)\n${listOut(diff)}`);
      else ok('booth-codes 와 booths.json 번호 일치');
    }
  }
}

if (groups !== undefined) {
  if (!isObj(groups)) fail('groups.json 이 객체가 아님');
  else {
    const keys = Object.keys(groups);
    if (officialUsers) {
      const extra = keys.filter((k) => !officialUsers.has(k));
      check(extra.length === 0, `groups 열쇠가 모두 공식 계정 (${keys.length}개)`, `없는 계정 ${extra.length}: ${extra.join(', ')}`);
    }
    const bad = Object.entries(groups).filter(([, v]) => !isObj(v) || !isStr(v.name) || !v.name.trim()).map(([k]) => k);
    check(bad.length === 0, 'groups 값에 name 있음', bad.join(', '));
    if (data) {
      const diff = Object.entries(groups).filter(([k, v]) => builtComp.has(k) && builtComp.get(k)?.name !== v?.name).map(([k, v]) => `${k}: 손 "${v?.name}" / 빌드 "${builtComp.get(k)?.name}"`);
      if (diff.length) warn(`groups 이름과 booths.json 회사 이름이 다름 ${diff.length}건 (빌드를 다시 돌려야 할 수 있음)\n${listOut(diff)}`);
      else ok('groups 이름과 booths.json 회사 이름 일치');
    }
  }
}

// ---------- 2. 그림 주소 검사 (--net) ----------
async function netCheck() {
  section('그림 주소 (--net)');
  if (!data) { warn('[건너뜀] booths.json 이 없어 그림 주소를 모를 수 있음'); return; }
  const urls = new Set();
  for (const c of data.companies ?? []) if (isStr(c?.logo) && c.logo) urls.add(c.logo);
  for (const { booth } of allBooths) if (isStr(booth?.logo) && booth.logo) urls.add(booth.logo);
  const list = [...urls];
  const bad = [];
  let i = 0;
  const probe = async (u) => {
    const opt = { redirect: 'follow', headers: { 'User-Agent': 'agf2026-check/1.0' } };
    try {
      let r = await fetch(u, { ...opt, method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (r.status === 405 || r.status === 403 || r.status === 501) {
        // HEAD 를 막는 서버: GET 으로 머리만 보고 본문은 버린다. GET 에도 시간 제한을 건다.
        r = await fetch(u, { ...opt, method: 'GET', signal: AbortSignal.timeout(15000) });
        r.body?.cancel().catch(() => {});
      }
      return r.status;
    } catch (e) { return `오류 ${e.cause?.code ?? e.name}`; }
  };
  const worker = async () => {
    while (i < list.length) {
      const u = list[i++];
      const s = await probe(u);
      if (s !== 200) bad.push(`${s} ${u}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  check(bad.length === 0, `홍보 그림 주소 ${list.length}개가 200으로 답함 (HEAD, 동시 6)`, `${bad.length}건\n${listOut(bad, 50)}`);
}

// ---------- 3. 화면 검사 (--ui) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const env = process.env;
  const cands = [
    env.AGF_BROWSER,
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? null;
}

// serve.mjs 를 --port 0 으로 띄워 운영체제가 고른 빈 포트를 시작 줄에서 읽는다.
// (빈 포트를 미리 골라 닫은 뒤 넘기면 그 사이에 다른 프로그램이 포트를 잡을 수 있다.)
function startServer(siteDir) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', '0', '--root', siteDir],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const done = (port, why) => { clearTimeout(timer); res({ child, port, why }); };
    const timer = setTimeout(() => done(null, '10초 안에 시작 줄이 나오지 않음'), 10000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/localhost:(\d+)\//); if (m) done(Number(m[1])); });
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (code) => done(null, `serve.mjs 가 끝남 (코드 ${code}) ${err.trim()}`));
    child.once('error', (e) => done(null, e.message));
  });
}

async function waitFor(fn, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* 재시도 */ }
    await sleep(stepMs);
  }
  return last;
}

const waitExit = (child, ms) => (!child || child.exitCode !== null || child.signalCode !== null)
  ? Promise.resolve()
  : new Promise((r) => { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); });

function rmProfileSync(dir) {
  for (let k = 0; k < 10; k++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
  }
}

// Ctrl+C 등으로 도중에 멈춰도 띄운 서버·브라우저를 내리고 임시 프로필을 지운다.
// (finally 는 신호로 끝날 때 돌지 않는다. 작업 관리자 강제 종료처럼 신호 없이 끝나는 경우는 막을 수 없다.)
let uiCleanupSync = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`\n${sig} 받음 — 띄운 서버·브라우저를 내리고 끝냄`);
    try { uiCleanupSync?.(); } finally { process.exit(130); }
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* 이미 끝남 */ }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg.method, msg.params);
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => res(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 연결 실패')), { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} 시간 초과`)); } }, 20000);
    });
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch { /* 무시 */ } }
}

// X 도메인: 이 이름과 그 아래 모든 이름(platform.twitter.com, syndication.twitter.com, pbs.twimg.com, …)
const X_HOSTS = ['x.com', 'twitter.com', 'twimg.com', 't.co'];
// 1겹: 페이지의 요청을 CDP 로 막는다(막힌 요청은 blockedReason 이 붙어 셀 수 있다).
const BLOCK = X_HOSTS.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
// 2겹: 브라우저 전체의 이름 풀이를 막는다. CDP 가 못 막는 iframe(별도 프로세스)·worker 요청도 X 에 닿지 않는다.
const RESOLVER_RULES = X_HOSTS.flatMap((h) => [`MAP ${h} ~NOTFOUND`, `MAP *.${h} ~NOTFOUND`]).join(', ');
const isBlockedUrl = (u) => /^https?:\/\/([^/]*\.)?(x\.com|twitter\.com|twimg\.com|t\.co)(:\d+)?(\/|$)/i.test(u ?? '');

// 시험용 자료: site 화면 파일 + booths.json 사본에서 부스 둘에 특전(gifts)을 넣는다.
//   ① 부스가 여럿인 회사의 X 부스 하나(탭 전환 시험용, 특전 2개: embed 있는 것·없는 것)
//   ② 부스가 하나인 X 회사(특전 1개, embed 없음)
function makeGiftSample(siteDir, data) {
  const d = structuredClone(data);
  const comps = d.companies ?? [];
  const multi = comps.find((c) => (c.booths ?? []).length > 1 && c.booths.some((b) => b?.x?.handle));
  const single = comps.find((c) => (c.booths ?? []).length === 1 && c.booths[0]?.x?.handle && c !== multi);
  if (!multi || !single) return null;
  let n = 0;
  const gift = (handle, kinds, summary, withEmbed) => {
    const url = `https://x.com/${handle}/status/9${String((n += 1)).padStart(18, '0')}`;
    const embed = withEmbed ? `<blockquote class="twitter-tweet"><p lang="ko" dir="ltr">[시험 자료] ${summary || '특전 안내'}</p>&mdash; (@${handle}) <a href="${url}">시험 글</a></blockquote>` : null;
    return { url, kinds, summary, embed };
  };
  const a = multi.booths.find((b) => b?.x?.handle);
  a.x.gifts = [gift(a.x.handle, ['visit', 'stamp'], '부스 방문 시 시험 스티커 증정', true), gift(a.x.handle, ['game'], '', false)];
  const s = single.booths[0];
  s.x.gifts = [gift(s.x.handle, ['sns', 'purchase', 'etc'], 'SNS 인증 시 시험 엽서', false)];
  for (const c of comps) for (const b of c.booths ?? []) if (isObj(b?.x) && !Array.isArray(b.x.gifts)) b.x.gifts = [];
  const dir = mkdtempSync(join(tmpdir(), 'agf-check-gifts-'));
  mkdirSync(join(dir, 'data'));
  for (const f of ['index.html', 'style.css', 'app.js']) copyFileSync(join(siteDir, f), join(dir, f));
  writeFileSync(join(dir, 'data', 'booths.json'), JSON.stringify(d));
  return dir;
}

async function uiCheck() {
  section('화면 (--ui)');
  const siteArg = argValue('--site');
  const siteDir = siteArg ? resolve(process.cwd(), siteArg) : join(ROOT, 'site');
  if (!existsSync(join(siteDir, 'index.html'))) { warn('[건너뜀] site/index.html 이 아직 없음 — 화면 파일이 생기면 다시 돌린다'); return; }
  if (!existsSync(join(ROOT, 'tools', 'serve.mjs'))) { warn('[건너뜀] tools/serve.mjs 없음'); return; }
  if (typeof WebSocket !== 'function') { warn(`[건너뜀] 이 Node(${process.version})에 WebSocket 이 없음 — Node 22 이상 필요`); return; }
  const browserPath = findBrowser();
  if (!browserPath) { warn('[건너뜀] headless로 띄울 Edge/Chrome 을 찾지 못함 (AGF_BROWSER 환경 변수로 경로 지정 가능)'); return; }
  if (dataArg) warn(`화면 검사는 ${siteDir} 를 띄운 서버의 data/booths.json 으로 본다 (--data 는 화면 검사에 쓰이지 않음, 바꾸려면 --site)`);
  if (siteArg) console.log(`  site: ${siteDir}`);

  let server, browser, cdp, browserCdp, profile, sampleDir;
  uiCleanupSync = () => { killTree(browser); killTree(server); if (profile) rmProfileSync(profile); if (sampleDir) rmProfileSync(sampleDir); };
  try {
    // 방문·참여 특전: 실제 자료에 gifts 가 있으면 실제 자료로, 없으면(또는 --gifts-sample) 시험용 자료로 화면을 본다.
    let serveDir = siteDir;
    let realData = null;
    try { realData = JSON.parse(readFileSync(join(siteDir, 'data', 'booths.json'), 'utf8').replace(/^﻿/, '')); } catch { /* 서버에서 다시 읽음 */ }
    const hasGifts = (d) => (d?.companies ?? []).some((c) => (c.booths ?? []).some((b) => Array.isArray(b?.x?.gifts) && b.x.gifts.length));
    if (realData && (flag('--gifts-sample') || !hasGifts(realData))) {
      sampleDir = makeGiftSample(siteDir, realData);
      if (sampleDir) { serveDir = sampleDir; warn(`화면 검사를 시험용 자료로 돌림 — ${flag('--gifts-sample') ? '--gifts-sample' : '실제 자료에 특전(gifts)이 아직 없음'}. 부스 둘에 시험 특전을 넣은 사본(${sampleDir})`); }
    }
    // 서버
    const srv = await startServer(serveDir);
    server = srv.child;
    if (!srv.port) { fail(`serve.mjs 를 띄우지 못함 — ${srv.why}`); return; }
    const port = srv.port;
    const base = `http://localhost:${port}/`;
    const up = await waitFor(async () => (await fetch(base, { signal: AbortSignal.timeout(2000) })).status === 200, 10000);
    if (!up) { fail(`serve.mjs 가 ${base} 에서 200 으로 답하지 않음`); return; }
    ok(`serve.mjs 를 빈 포트 ${port} 에 띄움`);
    const siteData = await (await fetch(base + 'data/booths.json')).json();
    const comps = siteData.companies ?? [];
    const gameCount = comps.filter((c) => (c.categories ?? []).includes(2)).length;
    const daewon = comps.find((c) => c.id === 'daewonmedia');

    // 브라우저 (headless, 임시 프로필 — 사용자 브라우저와 섞이지 않고 창도 뜨지 않음)
    profile = mkdtempSync(join(tmpdir(), 'agf-check-'));
    browser = spawn(browserPath, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--host-resolver-rules=${RESOLVER_RULES}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--mute-audio', '--hide-scrollbars',
      '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    const portFile = join(profile, 'DevToolsActivePort');
    const devPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0].trim(), 15000);
    if (!devPort) { fail('headless 브라우저의 디버깅 포트를 얻지 못함'); return; }
    const version = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
    browserCdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const targets = await waitFor(async () => {
      const pages = (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).filter((t) => t.type === 'page');
      return pages.length ? pages : null; // 빈 배열은 참이라 바로 끝나 버리므로 null 로 바꿔 다시 기다린다
    }, 5000);
    if (!targets) { fail('headless 브라우저의 페이지를 찾지 못함'); return; }
    cdp = await Cdp.connect(targets[0].webSocketDebuggerUrl);
    ok(`headless 브라우저 사용: ${browserPath.split(/[\\/]/).pop()} ${version.Browser ?? ''}`);

    // 오류 수집
    const errors = [];
    const blockedSeen = []; // CDP 가 막은 X 요청
    const escapedCdp = []; // CDP 를 빠져나갔지만 2겹(이름 풀이)에서 막힌 X 요청
    const xResponses = []; // X 에서 실제로 답이 온 요청 (있으면 안 됨)
    const xRequests = []; // 페이지가 X 로 보내려 한 요청 전부(막혔든 아니든)
    const reqUrl = new Map();
    cdp.on((method, p) => {
      if (method === 'Network.requestWillBeSent') {
        reqUrl.set(p.requestId, p.request.url);
        if (isBlockedUrl(p.request.url)) xRequests.push(p.request.url);
      }
      else if (method === 'Network.responseReceived') {
        if (isBlockedUrl(p.response?.url)) xResponses.push(p.response.url);
      } else if (method === 'Network.loadingFailed') {
        const u = reqUrl.get(p.requestId);
        if (!isBlockedUrl(u)) return;
        if (p.blockedReason) blockedSeen.push(u);
        else escapedCdp.push(`${u} (${p.errorText})`);
      } else if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        errors.push(`예외: ${d.exception?.description ?? d.text} (${d.url ?? ''}:${d.lineNumber ?? ''})`);
      } else if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
        const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (!/ERR_BLOCKED_BY_CLIENT/.test(text)) errors.push(`console.${p.type}: ${text}`);
      } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
        const e = p.entry;
        if (isBlockedUrl(e.url) || /ERR_BLOCKED_BY_CLIENT/.test(e.text)) return;
        errors.push(`${e.source}: ${e.text}${e.url ? ' ' + e.url : ''}`);
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: BLOCK });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const VIS = `(el) => !!el && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0`;
    const visibleCards = () => evaluate(`(() => { const vis = ${VIS}; return [...document.querySelectorAll('#grid .card[data-company-id]')].filter(vis).length; })()`);
    const countText = () => evaluate(`document.querySelector('#count')?.textContent?.trim() ?? null`);
    const setSearch = (v) => evaluate(`(() => { const i = document.querySelector('#search'); if (!i) return false; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    const frames = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    const settle = async (fn, want, ms = 3000) => (await waitFor(async () => { const v = await fn(); return v === want ? { v } : null; }, ms))?.v ?? (await fn());

    await cdp.send('Page.navigate', { url: base });
    const cards = await waitFor(async () => { const n = await evaluate(`document.querySelectorAll('#grid .card[data-company-id]').length`); return n >= comps.length ? n : null; }, 15000)
      ?? await evaluate(`document.querySelectorAll('#grid .card[data-company-id]').length`);
    check(cards === comps.length, `카드 ${cards}장 (기대 ${comps.length})`);

    // DOM 약속 요소 존재
    const contract = await evaluate(`(() => { const q = (s) => !!document.querySelector(s); return {
      grid: q('#grid'), search: q('#search'), count: q('#count'), panel: q('#panel'), close: q('#panel-close'), footer: q('#footer'),
      picks: q('#picks'), timeline: q('#timeline'), timelineLoad: q('#timeline-load'), timelineFallback: q('#timeline-fallback'),
      giftsWrap: q('#gifts-wrap'), gifts: q('#gifts'),
      chips: [...document.querySelectorAll('button[data-category]')].map((b) => b.dataset.category),
      panelHidden: document.querySelector('#panel')?.hasAttribute('hidden') ?? null }; })()`);
    const missEl = ['grid', 'search', 'count', 'panel', 'close', 'footer', 'picks', 'timeline', 'timelineLoad', 'timelineFallback', 'giftsWrap', 'gifts'].filter((k) => !contract[k]);
    check(missEl.length === 0, 'DOM 약속 요소(#grid #search #count #panel #panel-close #footer #picks #timeline #timeline-load #timeline-fallback #gifts-wrap #gifts)', `없음: ${missEl.join(', ')}`);
    const wantChips = ['all', '1', '2', '3', '4', '5', '6', '7'];
    const missChip = wantChips.filter((c) => !contract.chips.includes(c));
    check(missChip.length === 0, `분류 칩 button[data-category] all·1~7 (${contract.chips.join(',')})`, `없음: ${missChip.join(',')}`);
    check(contract.panelHidden === true, '처음에는 #panel 이 hidden');

    // 검색
    // 기대 장수는 자료에서 센다(회사 이름·부스 이름·소개·X 계정에 검색어가 든 회사). 자료가 바뀌어도 헛실패하지 않게.
    const QUERY = '브라운';
    const norm = (t) => String(t ?? '').toLocaleLowerCase('ko').normalize('NFKC');
    const wantSearch = comps.filter((c) => norm([c.name, ...(c.booths ?? []).flatMap((b) => [b.name, b.copy, b.x?.handle])].join('\n')).includes(norm(QUERY))).length;
    if (!wantSearch) warn(`[건너뜀] 검색 — 자료에 "${QUERY}"가 든 회사가 없음`);
    else if (await setSearch(QUERY)) {
      const n = await settle(visibleCards, wantSearch);
      check(n === wantSearch, `검색 "${QUERY}" → ${n}장 (#count: ${await countText()})`, `기대 ${wantSearch}장`);
      await setSearch('');
      const back = await settle(visibleCards, comps.length);
      check(back === comps.length, `검색 지우면 ${back}장으로 돌아옴`);
    } else fail('#search 를 찾지 못함');

    // Game 칩
    if (await click('button[data-category="2"]')) {
      const n = await settle(visibleCards, gameCount);
      check(n === gameCount, `Game 칩 → ${n}장 (자료의 Game 회사 ${gameCount}, #count: ${await countText()})`);
      await click('button[data-category="all"]');
      const back = await settle(visibleCards, comps.length);
      check(back === comps.length, `전체 칩 → ${back}장으로 돌아옴`);
    } else fail('button[data-category="2"] 를 찾지 못함');

    // 대원미디어 패널
    const panelOpen = () => evaluate(`(() => { const vis = ${VIS}; const p = document.querySelector('#panel'); return !!p && !p.hasAttribute('hidden') && vis(p); })()`);
    const boothTabs = () => evaluate(`document.querySelectorAll('#panel [data-booth-id]').length`);
    if (daewon && await click('.card[data-company-id="daewonmedia"]')) {
      const open = await settle(panelOpen, true);
      check(open === true, '대원미디어 카드를 누르면 #panel 이 보임');
      const tabs = await settle(boothTabs, daewon.booths.length);
      check(tabs === daewon.booths.length, `패널 부스 탭 ${tabs}개 (기대 ${daewon.booths.length})`);
      const parts = await evaluate(`({ picks: !!document.querySelector('#panel #picks') || !!document.querySelector('#picks'), timeline: !!document.querySelector('#timeline') })`);
      check(parts.picks && parts.timeline, '패널에 #picks·#timeline 있음', JSON.stringify(parts));
      await click('#panel-close');
      const closed = await settle(async () => evaluate(`document.querySelector('#panel')?.hasAttribute('hidden') ?? null`), true);
      check(closed === true, '#panel-close 로 닫히면 #panel 에 hidden');
    } else fail('대원미디어 카드(.card[data-company-id="daewonmedia"])를 찾지 못함');

    // 계정 최신 글: 단추를 누를 때만 시도한다(X 요청은 막혀 있음).
    // 고른 글(embeds)이 없는 X 부스를 고르면 "단추를 누르기 전에는 X 에 아무 요청도 없다"까지 볼 수 있다.
    const isTimelineUrl = (u) => /syndication\.twitter\.com|syndication\.twimg\.com|timeline-profile|\/embed\/Timeline/i.test(u ?? '');
    const xBooths = comps.flatMap((c) => c.booths.filter((b) => b.x && b.x.handle).map((b) => ({ c, b })));
    const target = xBooths.find(({ b }) => !(b.x.embeds ?? []).length) ?? xBooths[0];
    if (!target) warn('[건너뜀] 계정 최신 글 단추 — 자료에 X 계정이 있는 부스가 아직 없음');
    else {
      const { c: tc, b: tb } = target;
      const noEmbeds = !(tb.x.embeds ?? []).length;
      const xReqFrom = xRequests.length;
      await click(`.card[data-company-id="${tc.id}"]`);
      await settle(panelOpen, true);
      if (tc.booths.length > 1) await click(`#panel [data-booth-id="${tb.id.replace(/["\\]/g, '\\$&')}"]`);
      await sleep(1500);
      const btnState = () => evaluate(`(() => { const vis = ${VIS}; const b = document.querySelector('#timeline-load'); const a = document.querySelector('#timeline-x-link'); const f = document.querySelector('#timeline-fallback');
        return { btn: !!b && vis(b), text: b?.textContent.trim() ?? null, disabled: b?.getAttribute('aria-disabled') === 'true' || !!b?.disabled, link: a && vis(a) ? a.href : null, fallback: !!f && vis(f), frames: document.querySelectorAll('#timeline iframe').length }; })()`);
      const s0 = await btnState();
      const early = xRequests.slice(xReqFrom);
      const earlyTimeline = early.filter(isTimelineUrl);
      check(earlyTimeline.length === 0, `패널을 연 직후 X 타임라인 요청 없음 (${tc.id}/${tb.name})`, listOut(earlyTimeline));
      if (noEmbeds) check(early.length === 0, '고른 글 없는 X 부스: 단추를 누르기 전 X 요청 0건(widgets.js 도 안 실음)', listOut(early));
      check(s0.btn && s0.text === '최신 글 불러오기' && !s0.disabled && !s0.fallback && s0.frames === 0,
        '#timeline-load "최신 글 불러오기"가 보이고 대체 문구·타임라인은 아직 없음', JSON.stringify(s0));
      check(isStr(s0.link) && s0.link.toLowerCase() === `https://x.com/${tb.x.handle.replace(/^@/, '')}`.toLowerCase(), `"X에서 @계정 보기" 링크가 처음부터 보임 (${s0.link})`);

      // 단추 누름 → 시도 중(누를 수 없음) → 막혔으므로 8초 안에 대체 문구와 "다시 시도"
      const clicked = await evaluate(`(() => { const b = document.querySelector('#timeline-load'); b.click(); return { text: b.textContent.trim(), disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled }; })()`);
      check(clicked.text === '불러오는 중…' && clicked.disabled, `누른 직후 "불러오는 중…"·누를 수 없음`, JSON.stringify(clicked));
      const t0 = Date.now();
      const after = await waitFor(async () => { const st = await btnState(); return st.fallback && st.text === '다시 시도' && !st.disabled ? st : null; }, 12000, 200);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      check(!!after, `X 를 막은 채 누르면 ${secs}초 뒤 #timeline-fallback 과 "다시 시도"가 나옴`, JSON.stringify(after ?? await btnState()));
      const fbText = await evaluate(`document.querySelector('#timeline-fallback')?.textContent.trim() ?? ''`);
      check(fbText === '지금은 X가 최신 글을 보내 주지 않습니다.', `대체 문구 "${fbText}"`);
      if (!blockedSeen.length) warn('X 요청 차단이 실제로 걸린 요청이 없었음 (단추가 X 를 부르지 않았을 수 있음)');
      else ok(`X 요청 ${blockedSeen.length}건을 차단함`);

      // 다른 부스로 바꾸거나 닫으면 단추 상태에서 다시 시작
      await click('#panel-close');
      await settle(async () => evaluate(`document.querySelector('#panel')?.hasAttribute('hidden') ?? null`), true);
      await click(`.card[data-company-id="${tc.id}"]`);
      await settle(panelOpen, true);
      if (tc.booths.length > 1) await click(`#panel [data-booth-id="${tb.id.replace(/["\\]/g, '\\$&')}"]`);
      const s2 = await btnState();
      check(s2.btn && s2.text === '최신 글 불러오기' && !s2.fallback, '다시 열면 단추 상태("최신 글 불러오기")에서 시작', JSON.stringify(s2));
      await click('#panel-close');
    }
    if (escapedCdp.length) warn(`CDP 차단을 빠져나간 X 요청 ${escapedCdp.length}건 (이름 풀이 차단으로 X 에는 닿지 않음)\n${listOut(escapedCdp)}`);
    check(xResponses.length === 0, 'X 에서 답이 온 요청 0건', `${xResponses.length}건\n${listOut(xResponses)}`);

    // 방문·참여 특전: 보이는지·개수·자리(고른 글 위)·탭을 바꾸면 남지 않는지
    {
      const KIND_OK = new Set(['visit', 'game', 'stamp', 'sns', 'purchase', 'etc']);
      const validGifts = (b) => (Array.isArray(b?.x?.gifts) ? b.x.gifts : []).filter((g) => isObj(g) && (isStr(g.url) || isStr(g.embed)));
      const giftList = comps.flatMap((c) => c.booths.map((b, i) => ({ c, b, i }))).filter(({ b }) => b?.x?.handle && validGifts(b).length);
      const tabSel = (b) => `#panel [data-booth-id="${b.id.replace(/["\\]/g, '\\$&')}"]`;
      const giftState = () => evaluate(`(() => { const vis = ${VIS}; const w = document.querySelector('#gifts-wrap'); const p = document.querySelector('#picks-wrap');
        if (!w || !p) return { missing: !w ? '#gifts-wrap' : '#picks-wrap', shown: false, hiddenAttr: false, gifts: -1, kinds: -1, summaries: [], before: false, picksShown: false };
        const wr = w.getBoundingClientRect(), pr = p.getBoundingClientRect();
        return { shown: vis(w), hiddenAttr: w.hasAttribute('hidden'), gifts: document.querySelectorAll('#gifts .gift').length,
          kinds: document.querySelectorAll('#gifts .gift-kind[data-kind]').length, summaries: [...document.querySelectorAll('#gifts .gift-summary')].map((e) => e.textContent),
          before: !!(w.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING), picksShown: vis(p), giftTop: wr.top, picksTop: pr.top }; })()`);
      if (!giftList.length) warn('[건너뜀] 방문·참여 특전 화면 — 띄운 자료에 특전이 든 X 부스가 없음');
      else {
        // 탭 전환 시험이 되도록 부스가 여럿인 회사의 특전 부스를 먼저 고른다
        const g = giftList.find(({ c }) => c.booths.length > 1) ?? giftList[0];
        const want = validGifts(g.b);
        const wantKinds = want.reduce((n, x) => n + new Set((Array.isArray(x.kinds) ? x.kinds : []).filter((k) => KIND_OK.has(k))).size, 0);
        const wantSummaries = want.map((x) => (isStr(x.summary) ? x.summary.trim() : '')).filter(Boolean);
        await click(`.card[data-company-id="${g.c.id}"]`);
        await settle(panelOpen, true);
        if (g.c.booths.length > 1) await click(tabSel(g.b));
        await frames();
        const s1 = await giftState();
        check(s1.shown && s1.gifts === want.length, `특전 있는 부스(${g.c.id}/${g.b.name})를 열면 #gifts-wrap 이 보이고 .gift ${s1.gifts}개 (자료 ${want.length})`, JSON.stringify(s1));
        check(s1.kinds === wantKinds && JSON.stringify(s1.summaries) === JSON.stringify(wantSummaries), `종류 이름표 ${s1.kinds}개(자료 ${wantKinds})·요약 ${s1.summaries.length}개(빈 요약은 만들지 않음)`, JSON.stringify({ got: s1.summaries, want: wantSummaries }));
        check(s1.before && (!s1.picksShown || s1.giftTop < s1.picksTop), `#gifts-wrap 이 #picks-wrap 보다 위(문서 순서${s1.picksShown ? `·화면 위치 ${Math.round(s1.giftTop)} < ${Math.round(s1.picksTop)}` : ', 이 부스는 고른 글이 없어 화면 위치는 문서 순서로 봄'})`, JSON.stringify(s1));
        // 특전 없는 부스로 바꾸면 이전 부스의 .gift 가 남지 않고 hidden
        const other = g.c.booths.find((b) => b !== g.b && !validGifts(b).length);
        if (other) {
          await click(tabSel(other));
          await frames();
          const s2 = await giftState();
          check(!s2.shown && s2.hiddenAttr && s2.gifts === 0, `탭을 특전 없는 부스(${other.name})로 바꾸면 #gifts-wrap hidden·.gift 0개`, JSON.stringify(s2));
          await click('#panel-close');
        } else {
          await click('#panel-close');
          const nog = comps.find((c) => c.booths.length === 1 && c.booths[0]?.x?.handle && !validGifts(c.booths[0]).length);
          if (nog) {
            await settle(async () => evaluate(`document.querySelector('#panel')?.hasAttribute('hidden') ?? null`), true);
            await click(`.card[data-company-id="${nog.id}"]`);
            await settle(panelOpen, true);
            const s2 = await giftState();
            check(!s2.shown && s2.hiddenAttr && s2.gifts === 0, `특전 없는 X 부스(${nog.id})를 열면 #gifts-wrap hidden·.gift 0개`, JSON.stringify(s2));
            await click('#panel-close');
          }
        }
        await settle(async () => evaluate(`document.querySelector('#panel')?.hasAttribute('hidden') ?? null`), true);
        const left = await evaluate(`document.querySelectorAll('#gifts .gift').length`);
        check(left === 0, `패널을 닫으면 #gifts 를 비움 (.gift ${left}개)`);
      }
    }

    // 폭 360px 가로 넘침
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
    // 고정 대기 대신: 폭이 360 으로 바뀐 것을 확인하고 두 프레임을 그린 뒤 잰다.
    await waitFor(async () => (await evaluate('document.documentElement.clientWidth')) <= 360, 3000, 50);
    await frames();
    const overflow = () => evaluate(`(() => { const d = document.documentElement; const wide = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > d.clientWidth + 1 && getComputedStyle(el).position !== 'fixed'; }).slice(0, 5).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).join('.') : '')); return { sw: d.scrollWidth, cw: d.clientWidth, wide }; })()`);
    const o1 = await overflow();
    check(o1.sw <= o1.cw, `폭 360px 격자 화면 가로 넘침 없음 (scrollWidth ${o1.sw} / clientWidth ${o1.cw})`, `넘친 요소: ${o1.wide.join(', ')}`);
    if (daewon && await click('.card[data-company-id="daewonmedia"]')) {
      await settle(panelOpen, true);
      await frames();
      const o2 = await overflow();
      check(o2.sw <= o2.cw, `폭 360px 패널 연 화면 가로 넘침 없음 (scrollWidth ${o2.sw} / clientWidth ${o2.cw})`, `넘친 요소: ${o2.wide.join(', ')}`);
      await click('#panel-close');
    }

    await sleep(300);
    check(errors.length === 0, `콘솔 오류 ${errors.length}건 (X 차단으로 생긴 것은 뺌)`, '\n' + listOut(errors));
  } catch (e) {
    fail(`화면 검사 중 오류 — ${e.message}`);
  } finally {
    try { if (browserCdp) await browserCdp.send('Browser.close').catch(() => {}); } catch { /* 무시 */ }
    cdp?.close(); browserCdp?.close();
    await waitExit(browser, 3000); // Browser.close 뒤 스스로 끝나기를 기다리고, 안 끝나면 아래에서 강제로 내린다
    killTree(browser);
    killTree(server);
    if (profile) for (let k = 0; k < 10; k++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    if (sampleDir) rmProfileSync(sampleDir);
    uiCleanupSync = null;
  }
}

if (flag('--net')) await netCheck();
if (flag('--ui')) await uiCheck();

console.log(`\n결과: 실패 ${failures}, 경고 ${warnings}${flag('--net') ? '' : ' (그림 주소는 --net)'}${flag('--ui') ? '' : ' (화면은 --ui)'}`);
process.exit(failures ? 1 : 0);
