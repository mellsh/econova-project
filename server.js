// EcoNova 서버: 정적 파일 + 쓰레기통 상태 API + Gemini 분석
// 실행: node server.js  →  http://127.0.0.1:5500
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- .env 읽기 (패키지 없이) ----------
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT) || 5500; // 카카오 콘솔에 등록된 포트와 같아야 함
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
let GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const COURSE = JSON.parse(fs.readFileSync(path.join(DATA, 'course.json'), 'utf8'));

// ---------- 거리 계산 ----------
function distM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 쓰레기통이 코스의 몇 km 지점인지 계산
(function computeCourseKm() {
  const pts = COURSE.route.map(([lat, lng]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  const rawKm = cum[cum.length - 1] / 1000;
  // 경유지를 직선으로 이은 근사 경로라 실제보다 짧음 → 공식 거리(officialKm)에 맞춰 비례 보정
  const scale = COURSE.officialKm ? COURSE.officialKm / rawKm : 1;
  for (let i = 0; i < cum.length; i++) cum[i] *= scale;
  COURSE.totalKm = +(cum[cum.length - 1] / 1000).toFixed(2);
  for (const bin of COURSE.bins) {
    let best = { d: Infinity, at: 0 };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const segLen = cum[i] - cum[i - 1];
      // 평면 근사로 선분 위 투영
      const ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat;
      const t = Math.max(0, Math.min(1, ((bin.lng - ax) * (bx - ax) + (bin.lat - ay) * (by - ay)) / (((bx - ax) ** 2 + (by - ay) ** 2) || 1)));
      const p = { lat: ay + t * (by - ay), lng: ax + t * (bx - ax) };
      const d = distM(p, bin);
      if (d < best.d) best = { d, at: cum[i - 1] + t * segLen };
    }
    // course.json에 km를 직접 적은 경우(출발/도착이 같은 순환 코스 등) 그 값을 우선
    bin.km = typeof bin.km === 'number' ? bin.km : +(best.at / 1000).toFixed(1);
    // 왕복 코스면 돌아올 때 지나는 km도 계산 (반환점은 한 번만 지남)
    if (COURSE.outAndBack && bin.km > 0 && Math.abs(COURSE.totalKm / 2 - bin.km) > 0.15) bin.kmBack = +(COURSE.totalKm - bin.km).toFixed(1);
  }
})();

// ---------- 쓰레기통 상태 저장 ----------
function freshState() {
  const now = Date.now();
  const bins = {};
  for (const b of COURSE.bins) {
    bins[b.id] = { fill: b.initialFill, overflow: false, updatedAt: now - Math.floor(Math.random() * 20) * 60000, source: 'seed', note: '' };
  }
  return { bins, reports: [] };
}
let state;
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = freshState(); }
for (const b of COURSE.bins) if (!state.bins[b.id]) state.bins[b.id] = freshState().bins[b.id];
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {}), 300);
}

function binsView() {
  return COURSE.bins.map((b) => ({ id: b.id, name: b.name, lat: b.lat, lng: b.lng, water: b.water, km: b.km, kmBack: b.kmBack || null, ...state.bins[b.id] }));
}
function updateBin(id, patch) {
  if (!state.bins[id]) return null;
  const s = state.bins[id];
  if (patch.fill != null) s.fill = Math.max(0, Math.min(100, Math.round(Number(patch.fill))));
  if (patch.overflow != null) s.overflow = !!patch.overflow;
  if (patch.note != null) s.note = String(patch.note).slice(0, 200);
  s.source = patch.source || 'manual';
  s.updatedAt = Date.now();
  state.reports.push({ binId: id, fill: s.fill, overflow: s.overflow, source: s.source, at: s.updatedAt });
  if (state.reports.length > 500) state.reports.splice(0, state.reports.length - 500);
  save();
  return binsView().find((b) => b.id === id);
}

// ---------- Gemini ----------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callModel(model, body, timeoutMs = 30000) {
  return fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
// 설정한 모델을 못 쓸 때(404) 대체 모델 고르기
// 1) 에러 메시지가 추천하는 모델("use models/xxx") → 2) 버전이 가장 높은 일반 flash 모델
async function pickFlashModel(errText, exclude) {
  const hinted = /use models\/([\w.-]+)/.exec(errText || '');
  if (hinted && hinted[1] !== exclude) return hinted[1];
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
  if (!r.ok) return null;
  const { models = [] } = await r.json();
  const ver = (n) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(n) || [])[1] || 0);
  const ok = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => n !== exclude && /^gemini-[\d.]+-flash$/.test(n))
    .sort((a, b) => ver(b) - ver(a));
  return ok[0] || null;
}

// 기본 모델이 붐비면(503/429) 순서대로 시도할 예비 모델
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.1-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
const busyUntil = {}; // 모델 -> 이 시각까지 건너뜀
const CALL_TIMEOUT_MS = 30000;
const BUSY_SKIP_MS = 10 * 60000; // 붐빈 모델은 10분간 건너뜀 (시연 중 대기 시간 줄이기)

async function gemini(parts, schema) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY가 .env에 없어요');
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
  };
  const models = [GEMINI_MODEL, ...FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];
  const errors = [];
  for (const model of models) {
    if (busyUntil[model] > Date.now()) continue;
    let r;
    try {
      r = await callModel(model, body, CALL_TIMEOUT_MS);
    } catch (e) {
      errors.push(`${model}: 시간 초과`); busyUntil[model] = Date.now() + BUSY_SKIP_MS; continue;
    }
    if (r.status === 404 && model === GEMINI_MODEL) {
      const alt = await pickFlashModel(await r.text(), model);
      if (alt) { console.log(`[Gemini] ${model} 사용 불가 → ${alt}로 변경`); GEMINI_MODEL = alt; return gemini(parts, schema); }
    }
    if (r.status === 503 || r.status === 429 || r.status === 500) {
      errors.push(`${model}: ${r.status} 붐빔`); busyUntil[model] = Date.now() + BUSY_SKIP_MS;
      console.log(`[Gemini] ${model} ${r.status} → 10분간 건너뛰고 다음 모델 시도`);
      continue;
    }
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) { errors.push(`${model}: 빈 응답`); continue; }
    const out = JSON.parse(text);
    out._model = model;
    return out;
  }
  throw new Error('모든 Gemini 모델이 응답하지 않아요 (' + (errors.join(', ') || '잠시 후 다시 시도') + ')');
}

const PHOTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_trash_bin: { type: 'BOOLEAN' },
    fill_percent: { type: 'INTEGER' },
    overflow: { type: 'BOOLEAN' },
    trash_types: { type: 'ARRAY', items: { type: 'STRING' } },
    summary: { type: 'STRING' },
  },
  required: ['is_trash_bin', 'fill_percent', 'overflow', 'trash_types', 'summary'],
};

async function analyzePhoto(dataUrl, bin) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('이미지 형식이 올바르지 않아요');
  const prompt = `당신은 마라톤 대회 환경 관리 AI입니다. 사진은 "${bin.name}" 쓰레기통(급수대 근처: ${bin.water ? '예' : '아니오'}) 사진입니다.
- is_trash_bin: 사진에 쓰레기통(또는 쓰레기 수거함/봉투 거치대)이 보이면 true
- fill_percent: 쓰레기통이 얼마나 찼는지 0~100 정수로 추정 (뚜껑 위까지 쌓이면 100)
- overflow: 쓰레기통 주변 바닥에 쓰레기가 넘치거나 흩어져 있으면 true
- trash_types: 보이는 쓰레기 종류 (예: 종이컵, 페트병, 에너지젤 포장지, 바나나 껍질, 우비)
- summary: 상황을 한국어 한 문장으로 요약
쓰레기통이 아닌 사진이면 is_trash_bin=false, fill_percent=0으로 답하세요.`;
  return gemini([{ text: prompt }, { inlineData: { mimeType: m[1], data: m[2] } }], PHOTO_SCHEMA);
}

const PRIORITY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    priorities: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bin_id: { type: 'STRING' },
          rank: { type: 'INTEGER' },
          urgency: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          reason: { type: 'STRING' },
          action: { type: 'STRING' },
        },
        required: ['bin_id', 'rank', 'urgency', 'reason', 'action'],
      },
    },
    route_tip: { type: 'STRING' },
  },
  required: ['summary', 'priorities', 'route_tip'],
};

function binsForAnalysis(collector) {
  const now = Date.now();
  return binsView().map((b) => ({
    bin_id: b.id,
    name: b.name,
    course_km: b.km,
    course_km_on_return: b.kmBack || null,
    fill_percent: b.fill,
    overflow_on_ground: b.overflow,
    near_water_station: b.water,
    minutes_since_update: Math.round((now - b.updatedAt) / 60000),
    distance_from_collector_m: collector ? Math.round(distM(collector, b)) : null,
  }));
}

async function priorityWithGemini(collector) {
  const data = binsForAnalysis(collector);
  const prompt = `당신은 마라톤 대회 운영 본부의 쓰레기 수거 지휘 AI입니다.
코스: ${COURSE.name} (총 ${COURSE.totalKm}km${COURSE.outAndBack ? ', 같은 해안길을 갔다가 돌아오는 왕복 코스라 대부분 쓰레기통을 러너가 두 번 지남' : ''}). 현재 시각: ${new Date().toLocaleTimeString('ko-KR')}.
${collector ? '수거 담당자의 현재 위치가 주어졌고, 각 쓰레기통까지의 거리(distance_from_collector_m)가 포함되어 있습니다.' : '수거 담당자 위치는 알 수 없습니다.'}

아래 쓰레기통 상태 데이터를 보고 "어느 쓰레기통부터 치워야 하는지" 수거 우선순위를 정하세요.
판단 기준:
1) fill_percent가 높을수록, 특히 80 이상은 곧 넘침
2) overflow_on_ground=true면 이미 바닥에 쓰레기가 넘쳐 러너 안전(미끄러짐)과 민원 위험 → 최우선
3) near_water_station=true인 곳은 종이컵이 몰려 빠르게 참
4) minutes_since_update가 크면 실제로는 더 찼을 가능성
5) 수거 동선 효율 (가까운 곳끼리 묶기, 담당자와의 거리)
fill_percent가 40 미만이고 넘침이 없으면 목록에서 빼도 됩니다. 최대 8개까지.

출력:
- summary: 전체 상황 한두 문장
- priorities: rank 1부터 순서대로. reason은 왜 급한지 구체적으로(수치 포함), action은 현장에서 할 일 (예: "봉투 교체 + 주변 컵 수거, 2명 투입")
- route_tip: 추천 수거 동선 한 문장 (쓰레기통 이름 순서로)

데이터:
${JSON.stringify(data, null, 1)}`;
  const result = await gemini([{ text: prompt }], PRIORITY_SCHEMA);
  const ids = new Set(COURSE.bins.map((b) => b.id));
  result.priorities = (result.priorities || []).filter((p) => ids.has(p.bin_id)).sort((a, b) => a.rank - b.rank);
  return result;
}

// Gemini를 못 쓸 때 쓰는 규칙 기반 우선순위 (데모가 끊기지 않게)
function priorityByRule(collector) {
  const data = binsForAnalysis(collector);
  const scored = data
    .map((b) => {
      const score = b.fill_percent + (b.overflow_on_ground ? 30 : 0) + (b.near_water_station ? 10 : 0) + Math.min(b.minutes_since_update, 60) / 6
        - (b.distance_from_collector_m != null ? Math.min(b.distance_from_collector_m, 2000) / 200 : 0);
      return { ...b, score };
    })
    .filter((b) => b.fill_percent >= 40 || b.overflow_on_ground)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const priorities = scored.map((b, i) => {
    const why = [`${b.fill_percent}% 참`];
    if (b.overflow_on_ground) why.push('바닥에 쓰레기 넘침');
    if (b.near_water_station) why.push('급수대 근처라 종이컵 급증');
    if (b.minutes_since_update >= 15) why.push(`${b.minutes_since_update}분 전 정보라 더 찼을 수 있음`);
    const urgency = b.fill_percent >= 80 || b.overflow_on_ground ? 'high' : b.fill_percent >= 60 ? 'medium' : 'low';
    return {
      bin_id: b.bin_id, rank: i + 1, urgency, reason: why.join(', '),
      action: urgency === 'high' ? '즉시 봉투 교체 + 주변 쓰레기 수거' : urgency === 'medium' ? '다음 순회 때 봉투 교체' : '상태 모니터링',
    };
  });
  return {
    summary: `점검이 필요한 쓰레기통 ${priorities.length}곳 (긴급 ${priorities.filter((p) => p.urgency === 'high').length}곳).`,
    priorities,
    route_tip: priorities.length ? `${scored.map((b) => b.name).slice(0, 4).join(' → ')} 순서로 도세요.` : '지금은 급한 곳이 없어요.',
  };
}

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('요청이 너무 커요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON 형식 오류')); } });
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { gemini: !!GEMINI_KEY, model: GEMINI_MODEL });
  if (req.method === 'GET' && p === '/api/course')
    return send(res, 200, { name: COURSE.name, note: COURSE.note || '', totalKm: COURSE.totalKm, outAndBack: !!COURSE.outAndBack, start: COURSE.start, finish: COURSE.finish || null, turn: COURSE.turn || null, route: COURSE.route });
  if (req.method === 'GET' && p === '/api/bins') return send(res, 200, { bins: binsView(), now: Date.now() });

  let m;
  if (req.method === 'POST' && (m = p.match(/^\/api\/bins\/([\w-]+)\/report$/))) {
    const body = await readJson(req);
    const bin = updateBin(m[1], { fill: body.fill, overflow: body.overflow, note: body.note, source: 'manual' });
    return bin ? send(res, 200, { bin }) : send(res, 404, { error: '쓰레기통을 찾을 수 없어요' });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/bins\/([\w-]+)\/clear$/))) {
    const bin = updateBin(m[1], { fill: 0, overflow: false, note: '수거 완료', source: 'cleared' });
    return bin ? send(res, 200, { bin }) : send(res, 404, { error: '쓰레기통을 찾을 수 없어요' });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/bins\/([\w-]+)\/photo$/))) {
    const binMeta = COURSE.bins.find((b) => b.id === m[1]);
    if (!binMeta) return send(res, 404, { error: '쓰레기통을 찾을 수 없어요' });
    const body = await readJson(req);
    try {
      const analysis = await analyzePhoto(body.image, binMeta);
      if (!analysis.is_trash_bin) return send(res, 200, { analysis, bin: null, message: '쓰레기통이 보이지 않아서 반영하지 않았어요' });
      const bin = updateBin(m[1], { fill: analysis.fill_percent, overflow: analysis.overflow, note: analysis.summary, source: 'photo' });
      return send(res, 200, { analysis, bin });
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }
  if (req.method === 'POST' && p === '/api/priority') {
    const body = await readJson(req);
    const collector = body.location && isFinite(body.location.lat) && isFinite(body.location.lng) ? body.location : null;
    try {
      const out = await priorityWithGemini(collector);
      return send(res, 200, { source: 'gemini', model: out._model, ...out });
    } catch (e) {
      console.log('[Gemini 실패 → 규칙 기반]', e.message);
      return send(res, 200, { source: 'rule', error: e.message, ...priorityByRule(collector) });
    }
  }
  // 발표/시연용
  if (req.method === 'POST' && p === '/api/demo/fill') {
    for (const b of COURSE.bins) {
      const s = state.bins[b.id];
      s.fill = Math.min(100, s.fill + Math.round(Math.random() * (b.water ? 30 : 15)));
      if (s.fill >= 100 && Math.random() < 0.5) s.overflow = true;
      s.updatedAt = Date.now(); s.source = 'demo';
    }
    save();
    return send(res, 200, { bins: binsView() });
  }
  if (req.method === 'POST' && p === '/api/demo/reset') { state = freshState(); save(); return send(res, 200, { bins: binsView() }); }

  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.resolve(PUBLIC, '.' + rel);
    if (!filePath.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n❌ 포트 ${PORT}을(를) 다른 프로그램이 쓰고 있어서 서버를 못 켰어요.`);
    console.log('   → VSCode 아래 파란 상태바의 "Port : 5500"을 눌러 Live Server를 끄거나,');
    console.log('     다른 터미널에서 켜 둔 node server.js를 Ctrl+C로 끈 뒤 다시 실행하세요.\n');
    process.exit(1);
  }
  throw err;
}).listen(PORT, '0.0.0.0', () => { // 0.0.0.0: Live Server와 겹치면 바로 에러 + 같은 Wi-Fi 핸드폰 접속 허용
  console.log(`\n♻️  EcoNova 서버 실행 중: http://127.0.0.1:${PORT}`);
  const lan = Object.values(require('os').networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map((i) => i.address);
  for (const ip of lan) console.log(`📱 핸드폰(같은 네트워크)에서: http://${ip}:${PORT}   ← 카카오 콘솔에 이 주소도 등록해야 지도가 떠요`);
  console.log(GEMINI_KEY ? `🤖 Gemini 연결됨 (모델: ${GEMINI_MODEL})` : '⚠️  GEMINI_API_KEY 없음 → .env에 키를 넣으세요 (지금은 규칙 기반 분석으로 동작)');
  console.log('끄려면 Ctrl+C\n');
});
