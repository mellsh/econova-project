/* EcoNova 프론트엔드 */
(function () {
  'use strict';

  // ---------- 상태 ----------
  const S = {
    map: null,
    course: null,
    bins: [],
    pins: {},          // binId -> { overlay, el }
    user: null,        // { lat, lng, demo }
    userOverlay: null,
    selectedId: null,
    priorityRank: {},  // binId -> rank (AI 결과)
    sim: null,         // 시뮬레이션 타이머
    simDist: 0,
    geoWatch: null,
  };
  const $ = (id) => document.getElementById(id);

  // ---------- 유틸 ----------
  function distM(a, b) {
    const R = 6371000, r = (d) => (d * Math.PI) / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const kmText = (b) => (b.kmBack ? `${b.km}·${b.kmBack}km` : `${b.km}km`);
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);
  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return '방금 전';
    if (min < 60) return `${min}분 전`;
    return `${Math.floor(min / 60)}시간 전`;
  }
  function level(fill) {
    if (fill >= 100) return 'full';
    if (fill >= 80) return 'high';
    if (fill >= 50) return 'mid';
    return 'ok';
  }
  const COLORS = { ok: '#22c55e', mid: '#eab308', high: '#f97316', full: '#dc2626' };
  const LEVEL_TEXT = { ok: '여유', mid: '보통', high: '거의 참', full: '꽉 참' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.body ? 'POST' : opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }

  // ---------- 카카오 지도 로드 (보안 프로그램의 http 차단 우회) ----------
  function loadKakao(cb) {
    if (typeof kakao === 'undefined') {
      document.getElementById('map').innerHTML =
        '<p style="padding:120px 20px;color:#dc2626;text-align:center">카카오 지도 SDK를 불러오지 못했어요.<br>카카오 콘솔에 현재 주소(' + location.origin + ')가 등록되어 있는지 확인하세요.</p>';
      return;
    }
    kakao.maps.TUNNELING = true; // 이미지·타일을 https로
    const head = document.getElementsByTagName('head')[0];
    const orig = head.appendChild;
    head.appendChild = function (el) {
      if (el && el.tagName === 'SCRIPT' && /^http:\/\/[^/]*kakaocdn\.net\//.test(el.src)) el.src = el.src.replace(/^http:/, 'https:');
      return orig.call(this, el);
    };
    kakao.maps.load(cb);
  }

  // ---------- 지도 ----------
  function initMap() {
    const c = S.course;
    S.map = new kakao.maps.Map($('map'), { center: new kakao.maps.LatLng(37.5690, 126.9920), level: 6 });

    const path = c.route.map(([lat, lng]) => new kakao.maps.LatLng(lat, lng));
    // 코스: 흰 테두리 + 진한 선
    new kakao.maps.Polyline({ map: S.map, path, strokeWeight: 10, strokeColor: '#ffffff', strokeOpacity: 0.9 });
    new kakao.maps.Polyline({ map: S.map, path, strokeWeight: 6, strokeColor: '#0f766e', strokeOpacity: 0.85 });

    const flag = (p, text) =>
      new kakao.maps.CustomOverlay({ map: S.map, position: new kakao.maps.LatLng(p.lat, p.lng), content: `<div class="flag">${esc(text)}</div>`, yAnchor: 2.2, zIndex: 3 });
    flag(c.start, c.outAndBack ? '🏁 출발 · 도착' : '🏁 출발');
    if (c.finish && !c.outAndBack) flag(c.finish, '🏆 도착');
    if (c.turn) flag(c.turn, '↩️ 반환점');

    const bounds = new kakao.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    S.map.setBounds(bounds, 120, 40, 260, 40);
  }

  function pinHtml(b) {
    const lv = level(b.fill);
    const rank = S.priorityRank[b.id];
    return `<div class="head" style="background:${COLORS[lv]}">${b.fill}%</div>` +
      (b.water ? '<span class="water" title="급수대">💧</span>' : '') +
      (rank ? `<span class="rankb">${rank}</span>` : '');
  }

  function renderPins() {
    for (const b of S.bins) {
      let p = S.pins[b.id];
      if (!p) {
        const el = document.createElement('div');
        el.addEventListener('click', () => openBin(b.id));
        const overlay = new kakao.maps.CustomOverlay({ map: S.map, position: new kakao.maps.LatLng(b.lat, b.lng), content: el, yAnchor: 1.25, zIndex: 5, clickable: true });
        p = S.pins[b.id] = { overlay, el };
      }
      const lv = level(b.fill);
      p.el.className = `pin ${lv}${S.selectedId === b.id ? ' sel' : ''}`;
      p.el.innerHTML = pinHtml(b);
      p.overlay.setZIndex(lv === 'full' ? 8 : lv === 'high' ? 7 : 5);
    }
  }

  function renderUser() {
    if (!S.user) return;
    const pos = new kakao.maps.LatLng(S.user.lat, S.user.lng);
    if (!S.userOverlay) {
      S.userOverlay = new kakao.maps.CustomOverlay({ map: S.map, position: pos, content: '<div class="me"></div>', zIndex: 10 });
    } else S.userOverlay.setPosition(pos);
    const badge = $('locBadge');
    badge.hidden = !S.user.demo;
    badge.textContent = S.sim ? '🏃 시뮬레이션 위치' : '2026 JTBC 마라톤';
  }

  // ---------- 목록 ----------
  function sortedByDistance() {
    if (!S.user) return S.bins.map((b) => ({ ...b, d: null })).sort((a, b) => a.km - b.km);
    return S.bins.map((b) => ({ ...b, d: distM(S.user, b) })).sort((a, b) => a.d - b.d);
  }

  function renderNear() {
    const list = sortedByDistance();
    const n = list[0];
    if (n) {
      const lv = level(n.fill);
      $('nearestCard').innerHTML = `
        <div class="lbl">가장 가까운 쓰레기통</div>
        <div class="row">
          <div><b>${esc(n.name)}</b><div class="sub" style="font-size:12px;color:#64748b">${n.d != null ? fmtDist(n.d) + ' · ' : ''}${kmText(n)} 지점 · ${LEVEL_TEXT[lv]} ${n.fill}%</div></div>
          <button class="primary" data-open="${n.id}">상태 제보</button>
        </div>`;
    }
    $('nearList').innerHTML = list.map((b) => {
      const lv = level(b.fill);
      return `<li class="bin-item" data-open="${b.id}">
        <div class="info">
          <div class="name">${b.water ? '💧 ' : ''}${esc(b.name)}${b.overflow ? ' ⚠️' : ''}</div>
          <div class="sub">${b.d != null ? fmtDist(b.d) + ' · ' : ''}${kmText(b)} 지점 · ${ago(b.updatedAt)}</div>
          <div class="bar"><i style="width:${b.fill}%;background:${COLORS[lv]}"></i></div>
        </div>
        <div class="pct" style="color:${COLORS[lv]}">${b.fill}%</div>
      </li>`;
    }).join('');
  }

  function renderAll() {
    renderPins();
    renderNear();
    if (S.selectedId && !$('modal').hidden) fillModal(S.selectedId);
  }

  // ---------- 데이터 ----------
  async function refreshBins() {
    try {
      const { bins } = await api('/api/bins');
      S.bins = bins;
      renderAll();
    } catch (e) { /* 네트워크 일시 오류는 무시 */ }
  }
  function applyBin(bin) {
    const i = S.bins.findIndex((b) => b.id === bin.id);
    if (i >= 0) S.bins[i] = bin;
    renderAll();
  }

  // ---------- 쓰레기통 상세 / 제보 ----------
  function fillModal(id) {
    const b = S.bins.find((x) => x.id === id);
    if (!b) return;
    const lv = level(b.fill);
    $('mTitle').textContent = `${b.water ? '💧 ' : '🗑️ '}${b.name}`;
    const d = S.user ? ` · 나와 ${fmtDist(distM(S.user, b))}` : '';
    $('mMeta').textContent = `코스 ${kmText(b)} 지점${d} · ${ago(b.updatedAt)} 업데이트`;
    $('mGauge').style.width = Math.max(b.fill, 2) + '%';
    $('mGauge').style.background = COLORS[lv];
    $('mGaugeText').textContent = `${LEVEL_TEXT[lv]} ${b.fill}%${b.overflow ? ' · 바닥에 넘침 ⚠️' : ''}`;
    $('mNote').textContent = b.note ? `📝 ${b.note}` : '';
    $('overflowChk').checked = !!b.overflow;
  }
  function openBin(id) {
    S.selectedId = id;
    $('photoPreview').hidden = true;
    $('photoResult').innerHTML = '';
    $('photoInput').value = '';
    fillModal(id);
    $('modal').hidden = false;
    const b = S.bins.find((x) => x.id === id);
    if (b) S.map.panTo(new kakao.maps.LatLng(b.lat, b.lng));
    renderPins();
  }
  function closeModal() {
    $('modal').hidden = true;
    S.selectedId = null;
    renderPins();
  }

  async function report(fill) {
    const id = S.selectedId;
    try {
      const { bin } = await api(`/api/bins/${id}/report`, { body: { fill, overflow: $('overflowChk').checked } });
      applyBin(bin);
      toast(`${bin.name}: ${LEVEL_TEXT[level(bin.fill)]} ${bin.fill}%로 반영했어요`);
    } catch (e) { toast('제보 실패: ' + e.message); }
  }

  // 사진을 1024px JPEG로 줄여서 전송
  function compress(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, 1024 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없어요')); };
      img.src = url;
    });
  }

  let analyzing = false;
  async function analyzePhotoFile(file) {
    if (!file || !S.selectedId || analyzing) return;
    analyzing = true;
    const binId = S.selectedId;
    const out = $('photoResult');
    let timer;
    try {
      const dataUrl = await compress(file);
      $('photoPreview').src = dataUrl; $('photoPreview').hidden = false;
      const t0 = Date.now();
      const tick = () => {
        out.innerHTML = `<div class="analyzing"><span class="spinner dark"></span>Gemini AI가 쓰레기통을 분석하는 중…<small>${Math.round((Date.now() - t0) / 1000)}초 경과 · 보통 10~20초 걸려요</small></div>`;
      };
      tick(); timer = setInterval(tick, 1000);
      out.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = await api(`/api/bins/${binId}/photo`, { body: { image: dataUrl } });
      clearInterval(timer);
      const a = r.analysis;
      if (!r.bin) {
        out.innerHTML = `<div class="ai-result" style="border-color:#94a3b8"><div class="lv">⚠️ ${esc(r.message)}</div><div class="sum">${esc(a.summary)}</div><div class="types">쓰레기통이 잘 보이게 다시 찍어 주세요</div></div>`;
        return;
      }
      applyBin(r.bin);
      const lv = level(a.fill_percent);
      out.innerHTML = `<div class="ai-result" style="border-color:${COLORS[lv]};background:${COLORS[lv]}12">
          <div class="types">🤖 AI 판정 결과</div>
          <div class="big" style="color:${COLORS[lv]}">${a.fill_percent}%</div>
          <div class="lv" style="color:${COLORS[lv]}">${LEVEL_TEXT[lv]}${a.overflow ? ' · 바닥에 넘침 ⚠️' : ''}</div>
          <div class="sum">${esc(a.summary)}</div>
          ${a.trash_types && a.trash_types.length ? `<div class="types">보이는 쓰레기: ${a.trash_types.map(esc).join(', ')}</div>` : ''}
          <div class="src">${esc(a._model || 'Gemini')} · 지도에 바로 반영됐어요</div>
        </div>`;
      toast(`${r.bin.name}: ${a.fill_percent}% (${LEVEL_TEXT[lv]})`);
    } catch (err) {
      out.innerHTML = `<div class="ai-result" style="border-color:#dc2626"><div class="lv">❌ 사진 분석 실패</div><div class="sum">${esc(err.message)}</div><div class="types">잠시 후 다시 찍거나 아래 버튼으로 직접 선택해 주세요</div></div>`;
    } finally {
      clearInterval(timer);
      analyzing = false;
    }
  }
  function onPhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    analyzePhotoFile(file);
  }

  // ---------- AI 우선순위 ----------
  async function analyze() {
    const btn = $('analyzeBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Gemini가 분석하는 중…';
    try {
      const r = await api('/api/priority', { body: { location: S.user ? { lat: S.user.lat, lng: S.user.lng } : null } });
      S.priorityRank = {};
      r.priorities.forEach((p) => (S.priorityRank[p.bin_id] = p.rank));
      renderPins();
      const URG = { high: '긴급', medium: '보통', low: '여유' };
      const items = r.priorities.map((p) => {
        const b = S.bins.find((x) => x.id === p.bin_id) || { name: p.bin_id, fill: 0, km: '-' };
        return `<div class="prio" data-open="${p.bin_id}">
          <div class="rank">${p.rank}</div>
          <div class="body">
            <div class="title">${esc(b.name)} <span class="chip ${esc(p.urgency)}">${URG[p.urgency] || esc(p.urgency)}</span>
              <span style="font-weight:500;font-size:12px;color:#64748b">${b.fill}% · ${b.km === '-' ? '-' : kmText(b)}</span></div>
            <div class="reason">${esc(p.reason)}</div>
            <div class="action">👉 ${esc(p.action)}</div>
          </div>
        </div>`;
      }).join('');
      $('aiResult').innerHTML = `
        <div class="ai-summary">${esc(r.summary)}
          <div class="ai-src">${r.source === 'gemini' ? `🤖 Gemini 분석 (${esc(r.model)})` : `⚙️ 규칙 기반 분석 (Gemini 연결 실패: ${esc(r.error || '')})`} · ${new Date().toLocaleTimeString('ko-KR')}</div>
        </div>
        ${items || '<p class="hint">지금은 급하게 치울 쓰레기통이 없어요 👍</p>'}
        ${r.route_tip ? `<div class="route-tip">🧭 <b>추천 동선</b><br>${esc(r.route_tip)}</div>` : ''}`;
      if (r.source !== 'gemini') toast('Gemini 연결이 안 돼서 규칙 기반으로 분석했어요');
    } catch (e) {
      $('aiResult').innerHTML = `<p class="hint">❌ 분석 실패: ${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🤖 Gemini로 수거 우선순위 다시 분석';
    }
  }

  // ---------- 위치 ----------
  function nearCourse(p) {
    return S.course.route.some(([lat, lng]) => distM(p, { lat, lng }) < 3000);
  }
  function useDemoLocation(reason) {
    const s = S.course.start;
    S.user = { lat: s.lat, lng: s.lng, demo: true };
    renderUser(); renderNear();
    if (reason) toast(reason, 3500);
  }
  function startGeolocation() {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      useDemoLocation('이 접속 환경에서는 위치 권한을 쓸 수 없어서 데모 위치(출발점)를 사용해요');
      return;
    }
    let first = true;
    S.geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        if (S.sim) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!nearCourse(p)) {
          if (first) useDemoLocation('현재 위치가 코스에서 멀어서 데모 위치(출발점)를 사용해요');
          first = false;
          return;
        }
        first = false;
        S.user = { ...p, demo: false };
        renderUser(); renderNear();
      },
      () => { if (first) useDemoLocation('위치 권한이 없어서 데모 위치(출발점)를 사용해요'); first = false; },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  let _routeLen = 0;
  function routeLenM() {
    if (_routeLen) return _routeLen;
    const r = S.course.route;
    for (let i = 1; i < r.length; i++) _routeLen += distM({ lat: r[i - 1][0], lng: r[i - 1][1] }, { lat: r[i][0], lng: r[i][1] });
    return _routeLen;
  }
  // 코스를 따라 이동하는 시뮬레이션 (시연용)
  function pointAt(dist) {
    const r = S.course.route.map(([lat, lng]) => ({ lat, lng }));
    for (let i = 1; i < r.length; i++) {
      const seg = distM(r[i - 1], r[i]);
      if (dist <= seg) {
        const t = dist / seg;
        return { lat: r[i - 1].lat + (r[i].lat - r[i - 1].lat) * t, lng: r[i - 1].lng + (r[i].lng - r[i - 1].lng) * t };
      }
      dist -= seg;
    }
    return null;
  }
  function toggleSim() {
    if (S.sim) {
      clearInterval(S.sim); S.sim = null;
      $('simBtn').textContent = '🏃 코스 따라 이동 시뮬레이션 시작';
      renderUser();
      return;
    }
    S.simDist = 0;
    S.sim = setInterval(() => {
      // 코스 길이와 상관없이 약 4분이면 완주 (풀코스도 시연 가능)
      S.simDist += Math.max(40, routeLenM() / 240);
      const p = pointAt(S.simDist);
      if (!p) { S.simDist = 0; return; }
      S.user = { ...p, demo: true };
      renderUser(); renderNear();
    }, 1000);
    $('simBtn').textContent = '⏹ 시뮬레이션 멈추기';
    $('demoMenu').hidden = true;
    toast('출발점부터 코스를 따라 이동해요. "내 주변" 목록이 실시간으로 바뀌어요');
  }

  // ---------- 이벤트 ----------
  function bindEvents() {
    document.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        $('panel-near').hidden = t.dataset.tab !== 'near';
        $('panel-ai').hidden = t.dataset.tab !== 'ai';
        document.body.classList.remove('sheet-min');
      })
    );
    $('grabber').addEventListener('click', () => document.body.classList.toggle('sheet-min'));

    // data-open 속성이 있는 요소 클릭 → 상세 열기
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-open]');
      if (el) openBin(el.dataset.open);
      const c = e.target.closest('[data-close]');
      if (c) $(c.dataset.close).hidden = true;
    });

    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
    $('demoMenu').addEventListener('click', (e) => { if (e.target.id === 'demoMenu') $('demoMenu').hidden = true; });

    document.querySelectorAll('.quick button').forEach((b) => b.addEventListener('click', () => report(Number(b.dataset.fill))));
    $('overflowChk').addEventListener('change', () => {
      const b = S.bins.find((x) => x.id === S.selectedId);
      if (b) report(b.fill);
    });
    $('photoInput').addEventListener('change', onPhoto);
    $('albumInput').addEventListener('change', onPhoto);
    // 지도 위 촬영 버튼: 가장 가까운 쓰레기통으로 바로 카메라 열기
    $('camFab').addEventListener('click', () => {
      const n = sortedByDistance()[0];
      if (!n) return toast('쓰레기통 정보를 불러오는 중이에요');
      S.camTarget = n.id;
      $('quickCam').click();
    });
    $('quickCam').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !S.camTarget) return;
      openBin(S.camTarget);
      analyzePhotoFile(file);
    });
    $('clearBtn').addEventListener('click', async () => {
      try {
        const { bin } = await api(`/api/bins/${S.selectedId}/clear`, { body: {} });
        delete S.priorityRank[bin.id];
        applyBin(bin);
        toast(`${bin.name} 수거 완료! 🧹`);
      } catch (e) { toast('실패: ' + e.message); }
    });

    $('analyzeBtn').addEventListener('click', analyze);
    $('myLocBtn').addEventListener('click', () => {
      if (S.user) S.map.panTo(new kakao.maps.LatLng(S.user.lat, S.user.lng));
      else toast('위치를 아직 못 받았어요');
    });

    $('demoBtn').addEventListener('click', () => ($('demoMenu').hidden = false));
    $('simBtn').addEventListener('click', toggleSim);
    $('fillBtn').addEventListener('click', async () => {
      const { bins } = await api('/api/demo/fill', { body: {} });
      S.bins = bins; renderAll(); toast('쓰레기통이 차올랐어요 (급수대가 더 빨리 참)');
    });
    $('resetBtn').addEventListener('click', async () => {
      const { bins } = await api('/api/demo/reset', { body: {} });
      S.bins = bins; S.priorityRank = {}; $('aiResult').innerHTML = ''; renderAll(); toast('초기화했어요');
    });
  }

  // ---------- 시작 ----------
  async function start() {
    bindEvents();
    try {
      const [course, binsRes, health] = await Promise.all([api('/api/course'), api('/api/bins'), api('/api/health')]);
      S.course = course; S.bins = binsRes.bins;
      $('courseName').textContent = `${course.name} · ${course.totalKm}km`;
      $('geminiStatus').textContent = health.gemini ? `🤖 Gemini 연결됨 (${health.model})` : '⚠️ Gemini 키 없음 → 규칙 기반 분석으로 동작 중 (.env에 GEMINI_API_KEY 입력)';
    } catch (e) {
      // Live Server나 파일로 직접 열면 API가 없어서 여기로 옴
      $('map').innerHTML =
        '<div style="padding:140px 24px;text-align:center;line-height:1.7">' +
        '<div style="font-size:40px">⚠️</div><b>EcoNova 서버에 연결되지 않았어요</b><br>' +
        '<span style="color:#64748b;font-size:14px">Live Server를 끄고 터미널에서 <code>node server.js</code>를 실행한 뒤<br>' +
        '<b>http://127.0.0.1:5500</b> 으로 접속하세요.</span></div>';
      return;
    }
    loadKakao(() => {
      initMap();
      renderAll();
      startGeolocation();
      setInterval(refreshBins, 8000); // 다른 사람의 제보 반영
    });
  }
  start();
})();
