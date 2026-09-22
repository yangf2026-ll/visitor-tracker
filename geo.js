/* ============================================================
 * geo.js —— 地理智能体服务端模块（v2，支持腾讯 / 高德双通道）
 * 放到项目根目录（和 server.js 平级），无需安装任何新依赖
 * 依赖：Node 18+（内置 fetch）
 *
 * v2 相比 v1 的变化：
 *   1. 新增高德通道（AMAP_KEY）。腾讯 Key 搞不定时可直接换高德
 *   2. 双通道自动切换：主通道失败自动尝试备用通道
 *   3. 新增 /api/geo-diag 诊断接口：浏览器直接打开就能看到具体报错，不用翻日志
 * ============================================================ */
'use strict';

/* ---------- 1. 配置：密钥全部从环境变量读取，绝不写死在代码里 ---------- */
// replace(/\s+/g,'') 是为了免疫在 Render 面板粘贴时混进的空格/换行
// （那会导致腾讯返回 311「key格式错误」，而你肉眼根本看不出来）
const TENCENT_KEY = (process.env.LBS_KEY  || '').replace(/\s+/g, '');  // 腾讯位置服务 Key
const AMAP_KEY    = (process.env.AMAP_KEY || '').replace(/\s+/g, '');  // 高德 Web 服务 Key
const AI_KEY      = (process.env.DEEPSEEK_KEY || '').replace(/\s+/g, '');
const AI_MODEL    = process.env.AI_MODEL || 'deepseek-v4-flash';
const AI_BASE     = process.env.AI_BASE_URL || 'https://api.deepseek.com';
const PROMPT_V    = process.env.PROMPT_VERSION || 'v1';    // 改了提示词就改这个版本号，否则一直读旧缓存
const PREFER      = (process.env.GEO_PROVIDER || 'auto').toLowerCase(); // auto | tencent | amap

const CACHE_TTL = 6 * 60 * 60 * 1000;   // 缓存 6 小时
const CACHE_MAX = 3000;
const RATE_MAX  = 20;                   // 每个 IP 每 10 分钟最多 20 次
const RATE_WIN  = 10 * 60 * 1000;

/* ---------- 2. 内存缓存 + 限流 ---------- */
const cache = new Map();
const rateMap = new Map();

function cacheGet(k) {
  const it = cache.get(k);
  if (!it) return null;
  if (Date.now() > it.expire) { cache.delete(k); return null; }
  return it.value;
}
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { value: v, expire: Date.now() + CACHE_TTL });
}
function rateOk(ip) {
  const now = Date.now();
  const it = rateMap.get(ip);
  if (!it || now > it.resetAt) { rateMap.set(ip, { count: 1, resetAt: now + RATE_WIN }); return true; }
  if (it.count >= RATE_MAX) return false;
  it.count++;
  return true;
}

/* ---------- 3. 网络请求（带超时，避免把整个服务拖死） ---------- */
async function request(url, options = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 4. 三种文案风格 ---------- */
const STYLES = {
  science: {
    label: '地理科普',
    tone: '像一个懂地理的朋友在讲解，客观、有信息量，可以提到所处的地形部位、周边地标类型。'
  },
  travel: {
    label: '旅行推荐',
    tone: '像一个本地向导，热情、有画面感，重点说这里适合做什么、附近有什么值得注意的地方。'
  },
  brief: {
    label: '一句话',
    tone: '只用一句话概括这个位置，不超过 40 个字，干净利落。'
  }
};

/* ---------- 5. 系统提示词：防幻觉 + 合规硬约束 ---------- */
const SYSTEM_RULES = [
  '你是"地点地理志"撰写助手，根据 <facts> 中提供的权威地理数据，写一段关于该位置的中文介绍。',
  '【最重要】只准使用 <facts> 里出现过的地名、行政区划、道路、地标和距离数字。facts 里没有的信息一律不准写，尤其禁止编造历史、人口、GDP、海拔、气候、面积等数据。',
  '禁止输出任何 <facts> 中不存在的数字。',
  '涉及中国台湾、中国香港、中国澳门时，必须使用"中国台湾地区""中国香港特别行政区""中国澳门特别行政区"等规范表述，不得将其称为国家，也不得与其他主权国家并列。',
  '不得自行描述国界线、领土归属；如必须提及，只准复述 facts 中的行政区划名称。',
  '不得描述军事管理区、涉密单位或未公开设施。',
  '不要出现"你好""我是AI""根据您提供的资料"这类开场白，直接写内容。',
  '输出严格为 JSON：{"title": "8-16字标题", "body": "正文，120-260字", "tags": ["标签1","标签2","标签3"]}，不要输出额外文字。'
].join('\n');

/* ============================================================
 * 6. 地图服务商通道
 *    两家接口规范（已按官方文档核对）：
 *    腾讯：location 参数是「纬度,经度」；coord/translate 的 locations 是「经度,纬度」——两者顺序相反
 *    高德：location / locations 参数一律是「经度,纬度」
 *    腾讯：status === 0 表示成功（数字）
 *    高德：status === '1' 表示成功（字符串）
 * ============================================================ */

// 决定用哪家、以及先后顺序
function providerList() {
  if (PREFER === 'amap'    && AMAP_KEY)    return ['amap'];
  if (PREFER === 'tencent' && TENCENT_KEY) return ['tencent'];
  const list = [];
  if (AMAP_KEY)    list.push('amap');     // 高德放前面：它的 Web 服务 Key 申请更省事
  if (TENCENT_KEY) list.push('tencent');
  return list;
}

async function tencentGet(pathname, params) {
  const url = new URL('https://apis.map.qq.com' + pathname);
  url.searchParams.set('key', TENCENT_KEY);
  url.searchParams.set('output', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return request(url.toString(), {}, 8000);
}
async function amapGet(pathname, params) {
  const url = new URL('https://restapi.amap.com' + pathname);
  url.searchParams.set('key', AMAP_KEY);
  url.searchParams.set('output', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return request(url.toString(), {}, 8000);
}

/* --- 6.1 坐标转换：手机 GPS 是 WGS-84，国内地图要 GCJ-02，不转换会偏移几百米 --- */
async function toGcj02(provider, lat, lng) {
  try {
    if (provider === 'amap') {
      // 高德：locations=经度,纬度  coordsys=gps 表示原始坐标是 GPS（WGS-84）
      const j = await amapGet('/v3/assistant/coordinate/convert', {
        locations: `${lng},${lat}`, coordsys: 'gps'
      });
      if (j && j.status === '1' && typeof j.locations === 'string') {
        const [nlng, nlat] = j.locations.split(',').map(Number);
        if (isFinite(nlat) && isFinite(nlng)) return { lat: nlat, lng: nlng };
      }
      console.error('[geo][amap] 坐标转换失败 status=' + (j && j.status) + ' info=' + (j && j.info));
    } else {
      // 腾讯：locations=经度,纬度  type=1 表示 GPS → GCJ-02
      const j = await tencentGet('/ws/coord/v1/translate', { locations: `${lng},${lat}`, type: 1 });
      const loc = j && j.locations && j.locations[0];
      if (j && j.status === 0 && loc) return { lat: loc.lat, lng: loc.lng };
      console.error('[geo][tencent] 坐标转换失败 status=' + (j && j.status) + ' message=' + (j && j.message));
    }
  } catch (e) {
    console.error('[geo][' + provider + '] 坐标转换异常: ' + e.message); // 转换失败就用原坐标继续，不中断
  }
  return { lat, lng };
}

/* --- 6.2 逆地址解析：把经纬度换成"我在哪" --- */
async function reverseGeocode(provider, lat, lng) {
  if (provider === 'amap') {
    const j = await amapGet('/v3/geocode/regeo', {
      location: `${lng},${lat}`,      // 高德：经度在前
      extensions: 'all',
      radius: 1000,
      roadlevel: 0
    });
    if (!j || j.status !== '1' || !j.regeocode) {
      console.error('[geo][amap] 逆地编码失败 status=' + (j && j.status) + ' info=' + (j && j.info) + ' infocode=' + (j && j.infocode));
      return null;
    }
    const rg = j.regeocode;
    const ac = rg.addressComponent || {};
    const sn = rg.streetNumber || {};
    const ba = (rg.businessAreas || [])[0] || {};
    const ri = (rg.roadinters || [])[0] || {};
    const ao = (rg.aois || [])[0] || {};
    // 高德在直辖市下 city 字段返回空，这里回落到 province，避免文案里缺城市名
    const city = typeof ac.city === 'string' ? ac.city : '';
    return {
      address: rg.formatted_address || '',
      formatted: rg.formatted_address || '',
      nation: typeof ac.country === 'string' ? ac.country : '',
      province: typeof ac.province === 'string' ? ac.province : '',
      city: city || (typeof ac.province === 'string' ? ac.province : ''),
      district: typeof ac.district === 'string' ? ac.district : '',
      street: typeof sn.street === 'string' ? sn.street : '',
      streetNumber: typeof sn.number === 'string' ? sn.number : '',
      adcode: ac.adcode ? String(ac.adcode) : '',
      famousArea: typeof ba.name === 'string' ? ba.name : '',
      landmarkL1: typeof ao.name === 'string' ? ao.name : '',
      landmarkL2: '',
      town: typeof ac.township === 'string' ? ac.township : '',
      water: '',
      crossroad: (ri.first_name && ri.second_name) ? `${ri.first_name}与${ri.second_name}交叉口` : '',
      pois: (rg.pois || []).slice(0, 6).map(p => ({
        name: p.name || '', category: p.type || '',
        distance: p.distance == null ? '' : String(Math.round(Number(p.distance))),
        dir: p.direction || ''
      }))
    };
  }

  // 腾讯：location 是「纬度,经度」
  const j = await tencentGet('/ws/geocoder/v1/', {
    location: `${lat},${lng}`,
    get_poi: 1,
    poi_options: 'address_format=short;radius=1000;policy=1;orderby=_distance'
  });
  if (!j || j.status !== 0 || !j.result) {
    console.error('[geo][tencent] 逆地编码失败 status=' + (j && j.status) + ' message=' + (j && j.message) + ' request_id=' + (j && j.request_id));
    return null;
  }
  const r = j.result;
  const ac = r.address_component || {};
  const ad = r.ad_info || {};
  const rf = r.address_reference || {};
  const pick = (o) => (o && o.title) || '';
  return {
    address: r.address || '',
    formatted: (r.formatted_addresses || {}).recommend || '',
    nation: ac.nation || '', province: ac.province || '',
    city: ac.city || '', district: ac.district || '',
    street: ac.street || '', streetNumber: ac.street_number || '',
    adcode: ad.adcode ? String(ad.adcode) : '',
    famousArea: pick(rf.famous_area),
    landmarkL1: pick(rf.landmark_l1),
    landmarkL2: pick(rf.landmark_l2),
    town: pick(rf.town),
    water: pick(rf.water),
    crossroad: pick(rf.crossroad),
    pois: (r.pois || []).slice(0, 6).map(p => ({
      name: p.title || '', category: p.category || '',
      distance: p._distance == null ? '' : String(Math.round(p._distance)),
      dir: p._dir_desc || ''
    }))
  };
}

/* --- 6.3 IP 粗定位（访客拒绝授权定位时的兜底） --- */
async function ipLocate(provider, ip) {
  if (!ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null;
  if (provider === 'amap') {
    // 高德 IP 定位仅支持国内 IPv4
    const j = await amapGet('/v3/ip', { ip });
    if (!j || j.status !== '1') {
      console.error('[geo][amap] IP定位失败 status=' + (j && j.status) + ' info=' + (j && j.info));
      return null;
    }
    if (!j.city && !j.province) return null;
    return {
      address: '', formatted: '',
      nation: '中国', province: j.province || '', city: j.city || j.province || '',
      district: '', street: '', streetNumber: '',
      adcode: j.adcode ? String(j.adcode) : '',
      famousArea: '', landmarkL1: '', landmarkL2: '', town: '', water: '', crossroad: '',
      pois: [], coarse: true
    };
  }
  const j = await tencentGet('/ws/location/v1/ip', { ip });
  if (!j || j.status !== 0 || !j.result) {
    console.error('[geo][tencent] IP定位失败 status=' + (j && j.status) + ' message=' + (j && j.message));
    return null;
  }
  const r = j.result;
  const ad = r.ad_info || {};
  return {
    address: '', formatted: '',
    nation: ad.nation || '', province: ad.province || '',
    city: ad.city || '', district: ad.district || '',
    street: '', streetNumber: '',
    adcode: ad.adcode ? String(ad.adcode) : '',
    famousArea: '', landmarkL1: '', landmarkL2: '', town: '', water: '', crossroad: '',
    pois: [], coarse: true
  };
}

/* --- 6.4 统一入口：按 provider 顺序取地理事实，一家失败自动换下一家 --- */
async function resolveFacts(lat, lng, ip) {
  const list = providerList();
  if (!list.length) return null;
  let lastErr = null;
  for (const p of list) {
    try {
      if (isFinite(lat) && isFinite(lng)) {
        const g = await toGcj02(p, lat, lng);
        const f = await reverseGeocode(p, g.lat, g.lng);
        if (f) return { facts: f, provider: p, source: 'gps' };
      } else {
        const f = await ipLocate(p, ip);
        if (f) return { facts: f, provider: p, source: 'ip' };
      }
    } catch (e) {
      lastErr = e.message;
      console.error('[geo][' + p + '] 通道异常: ' + e.message);
    }
  }
  if (lastErr) console.error('[geo] 所有通道均失败，最后错误: ' + lastErr);
  return null;
}

/* ---------- 7. 把地理数据整理成喂给模型的"事实包" ---------- */
function buildFactText(f) {
  const lines = [];
  const put = (k, v) => { if (v) lines.push(`${k}：${v}`); };
  put('国家', f.nation);
  put('省级', f.province);
  put('城市', f.city);
  put('区/县', f.district);
  put('街道/乡镇', f.street || f.town);
  put('门牌', f.streetNumber);
  put('行政区划代码', f.adcode);
  put('标准地址', f.address);
  put('通俗地址', f.formatted);
  if (f.famousArea) put('所属商圈/知名区域', f.famousArea);
  if (f.landmarkL1) put('一级地标', f.landmarkL1);
  if (f.landmarkL2) put('二级地标', f.landmarkL2);
  if (f.water) put('附近水系', f.water);
  if (f.crossroad) put('最近路口', f.crossroad);
  if (f.pois && f.pois.length) {
    lines.push('周边地点（名称 / 类别 / 直线距离米 / 方位）：');
    f.pois.forEach(p => lines.push(`  - ${p.name} / ${p.category} / ${p.distance} / ${p.dir}`));
  }
  return lines.join('\n');
}
function buildUserPrompt(f, styleKey) {
  const tone = (STYLES[styleKey] || STYLES.science).tone;
  return `<facts>\n${buildFactText(f)}\n</facts>\n\n写作语气要求：${tone}`;
}

/* ---------- 8. 调大模型 ---------- */
async function callAI(facts, styleKey) {
  if (!AI_KEY) return null;
  const messages = [
    { role: 'system', content: SYSTEM_RULES },
    { role: 'user', content: buildUserPrompt(facts, styleKey) }
  ];
  // 先尝试"关闭思考模式"（更快更省）；万一平台不支持该参数，再退化成普通请求重试一次
  const attempts = [
    { model: AI_MODEL, messages, temperature: 0.8, max_tokens: 800, thinking: { type: 'disabled' } },
    { model: AI_MODEL, messages, temperature: 0.8, max_tokens: 800 }
  ];
  for (const body of attempts) {
    try {
      const res = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
      });
      if (!res.ok) continue;
      const j = await res.json();
      const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (txt) return txt;
    } catch (e) { /* 超时或网络错误，换下一种尝试 */ }
  }
  return null;
}

/* ---------- 9. 后置校验：幻觉 + 合规，不通过就用兜底文案 ---------- */
function pickJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

function complianceCheck(obj, facts) {
  if (!obj || typeof obj.title !== 'string' || typeof obj.body !== 'string') return false;
  const text = obj.title + obj.body;
  if (text.length < 16 || text.length > 1200) return false;

  // ① 数字必须来自事实包：正文出现的每个数字都要能在 facts 里找到
  const allowed = new Set((JSON.stringify(facts).match(/\d+/g) || []));
  const nums = text.match(/\d+/g) || [];
  for (const n of nums) if (!allowed.has(n)) return false;

  // ② 涉台港澳必须规范表述
  if (/台湾|香港|澳门/.test(text)) {
    const ok = /中国台湾|台湾地区|台湾省|中国香港|香港特别行政区|中国澳门|澳门特别行政区/.test(text);
    if (!ok) return false;
  }
  // ③ 敏感内容
  if (/军事|部队|军营|禁区|边境争议/.test(text)) return false;
  return true;
}

// 兜底：完全不依赖大模型，纯事实拼接。模型挂了功能照样能用
function fallback(facts, styleKey) {
  // 直辖市会出现 province 和 city 相同（北京市 / 北京市），去重后再拼接
  const regionParts = [facts.province, facts.city, facts.district].filter(Boolean);
  const region = regionParts.filter((v, i) => regionParts.indexOf(v) === i).join('');
  const near = (facts.pois && facts.pois[0]) ? facts.pois[0] : null;
  const dirText = !near || !near.dir ? '附近'
    : near.dir === '内' ? '就在其中'
    : `你的${near.dir}侧`;
  const parts = [];
  parts.push(`你当前位于${region || '所在区域'}${facts.famousArea ? '的' + facts.famousArea : ''}。`);
  if (facts.street) parts.push(`所在道路为${facts.street}${facts.streetNumber || ''}。`);
  if (facts.landmarkL1 || facts.landmarkL2) parts.push(`最近的地标是${facts.landmarkL1 || facts.landmarkL2}。`);
  if (near && near.distance) parts.push(`最近的地点是${near.name}（${near.category}），距离约${near.distance}米，在${dirText}。`);
  if (facts.coarse) parts.push('（当前为城市级粗定位，授权定位可获得更精确的描述）');
  return {
    title: region ? `${region}·位置速写` : '位置速写',
    body: parts.join(''),
    tags: [facts.city, facts.district, (STYLES[styleKey] || STYLES.science).label].filter(Boolean)
  };
}

/* ---------- 10. 对外：请求处理器 ---------- */
function grid(v) { return (Math.round(Number(v) * 500) / 500).toFixed(3); } // 约 200 米一格

function getClientIp(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return f.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || '';
}

async function handleGeoIntro(req, res) {
  if (!AMAP_KEY && !TENCENT_KEY) {
    return res.status(500).json({ error: '服务端未配置地图 Key（AMAP_KEY 或 LBS_KEY 二选一）' });
  }

  const ip = getClientIp(req);
  if (!rateOk(ip)) return res.status(429).json({ error: '请求太频繁了，歇会儿再试～' });

  const body = req.body || {};
  const styleKey = STYLES[body.style] ? body.style : 'science';

  // ① 取坐标：优先用前端 GPS，没有就用 IP 粗定位
  let lat = parseFloat(body.latitude);
  let lng = parseFloat(body.longitude);

  const resolved = await resolveFacts(lat, lng, ip);
  if (!resolved) {
    return res.status(502).json({ error: '地理信息查询失败', hint: '打开 /api/geo-diag 查看具体原因' });
  }
  const { facts, provider, source } = resolved;

  // ② 缓存（按 提示词版本 + 风格 + 行政区划 + 200米网格）
  const ck = [PROMPT_V, styleKey, facts.adcode || '0',
    isFinite(lat) ? grid(lat) : 'x', isFinite(lng) ? grid(lng) : 'x'].join(':');
  const hit = cacheGet(ck);
  if (hit) {
    return res.json({ ok: true, provider, source, cached: true, degraded: !!hit.degraded, data: hit.data, facts });
  }

  // ③ 生成 + 校验
  const raw = await callAI(facts, styleKey);
  const parsed = pickJson(raw);
  let data, degraded = false;
  if (parsed && complianceCheck(parsed, facts)) {
    data = { title: parsed.title, body: parsed.body, tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3) : [] };
  } else {
    data = fallback(facts, styleKey);
    degraded = true;
    if (!parsed) console.warn('[geo] AI 无返回，已走兜底（检查 DEEPSEEK_KEY / 余额 / 模型名）');
    else console.warn('[geo] AI 输出未通过事实或合规校验，已走兜底');
  }
  cacheSet(ck, { data, degraded });
  console.log('[geo] provider=%s source=%s degraded=%s adcode=%s city=%s',
    provider, source, degraded, facts.adcode || '-', facts.city || '-');

  res.json({ ok: true, provider, source, cached: false, degraded, data, facts });
}

/* ---------- 11. 诊断接口：浏览器直接打开就能看到到底哪一步出错 ---------- */
function mask(k) {
  if (!k) return null;
  const s = String(k);
  if (s.length <= 8) return s.slice(0, 2) + '****' + s.slice(-2) + ' (长度' + s.length + ')';
  return s.slice(0, 4) + '****' + s.slice(-4) + ' (长度' + s.length + ')';
}

async function handleGeoDiag(req, res) {
  const out = {
    time: new Date().toISOString(),
    keys: {
      AMAP_KEY: AMAP_KEY ? mask(AMAP_KEY) : '未配置',
      LBS_KEY: TENCENT_KEY ? mask(TENCENT_KEY) : '未配置',
      DEEPSEEK_KEY: AI_KEY ? mask(AI_KEY) : '未配置'
    },
    order: providerList(),
    prefer: PREFER,
    tests: []
  };

  // 每个已配置的 Key 都真实调一次，把原始状态码带回来
  for (const p of ['amap', 'tencent']) {
    const key = p === 'amap' ? AMAP_KEY : TENCENT_KEY;
    if (!key) { out.tests.push({ provider: p, skipped: '未配置 Key' }); continue; }
    const t = { provider: p };
    try {
      // 用北京中关村的一组固定坐标做测试
      const g = await toGcj02(p, 39.984154, 116.307490);
      t.converted = g;
      const f = await reverseGeocode(p, g.lat, g.lng);
      if (f) {
        t.reverseGeocode = 'OK';
        t.sample = { 省: f.province, 市: f.city, 区: f.district, 路: f.street, adcode: f.adcode, 周边数: f.pois.length };
      } else {
        t.reverseGeocode = '失败';
      }
    } catch (e) {
      t.error = e.message;
    }
    out.tests.push(t);
  }

  // 顺带探一下大模型是否可用（不消耗太多：只问一句）
  if (AI_KEY) {
    try {
      const r = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY },
        body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: '回复两个字：正常' }], max_tokens: 10 }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
      });
      out.ai = { httpStatus: r.status, ok: r.ok };
      if (!r.ok) out.ai.detail = (await r.text()).slice(0, 200);
    } catch (e) { out.ai = { error: e.message }; }
  } else {
    out.ai = '未配置 DEEPSEEK_KEY（功能可用，但文案走纯事实兜底）';
  }

  res.json(out);
}

module.exports = { handleGeoIntro, handleGeoDiag, getClientIp, STYLES };
