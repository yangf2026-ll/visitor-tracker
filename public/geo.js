/* ============================================================
 * geo.js —— 地理智能体服务端模块
 * 放到项目根目录（和 server.js 平级），无需安装任何新依赖
 * 依赖：Node 18+（内置 fetch）。Render 默认即为 Node 18/20/22
 * ============================================================ */
'use strict';

/* ---------- 1. 配置：密钥全部从环境变量读取，绝不写死在代码里 ---------- */
const LBS_KEY  = process.env.LBS_KEY  || '';                          // 腾讯位置服务 Key
const AI_KEY   = process.env.DEEPSEEK_KEY || '';                      // DeepSeek API Key
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4-flash';         // 换模型只改环境变量
const AI_BASE  = process.env.AI_BASE_URL || 'https://api.deepseek.com';
const PROMPT_V = process.env.PROMPT_VERSION || 'v1';                  // 改了提示词就改这个版本号，否则会一直读旧缓存

const CACHE_TTL = 6 * 60 * 60 * 1000;   // 缓存 6 小时
const CACHE_MAX = 3000;                 // 最多缓存 3000 条，防止内存撑爆
const RATE_MAX  = 20;                   // 每个 IP 每 10 分钟最多 20 次
const RATE_WIN  = 10 * 60 * 1000;

/* ---------- 2. 内存缓存 + 限流（单实例够用；多实例请换 Redis） ---------- */
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

/* ---------- 4. 三种文案风格（想改语气改这里就行） ---------- */
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

/* ---------- 5. 系统提示词：防幻觉 + 合规的硬约束 ---------- */
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

/* ---------- 6. 腾讯位置服务：坐标转换 / 逆地址解析 / IP 定位 ---------- */
async function lbsGet(pathname, params) {
  const url = new URL('https://apis.map.qq.com' + pathname);
  url.searchParams.set('key', LBS_KEY);
  url.searchParams.set('output', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return request(url.toString(), {}, 8000);
}

// 浏览器给的是 WGS-84（GPS 原始坐标），内地逆地址解析要用 GCJ-02，不转换会偏移几百米
async function toGcj02(lat, lng) {
  try {
    const j = await lbsGet('/ws/coord/v1/translate', { locations: `${lng},${lat}`, type: 1 });
    const loc = j && j.locations && j.locations[0];
    if (j.status === 0 && loc) return { lat: loc.lat, lng: loc.lng };
  } catch (e) { /* 转换失败就用原坐标继续，不要中断 */ }
  return { lat, lng };
}

async function reverseGeocode(lat, lng) {
  const j = await lbsGet('/ws/geocoder/v1/', {
    location: `${lat},${lng}`,                                        // 注意：这里是 纬度,经度
    get_poi: 1,
    poi_options: 'address_format=short;radius=1000;policy=1;orderby=_distance'
  });
  if (!j || j.status !== 0 || !j.result) return null;
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

async function ipLocate(ip) {
  if (!ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null;
  const j = await lbsGet('/ws/location/v1/ip', { ip });
  if (!j || j.status !== 0 || !j.result) return null;
  const r = j.result;
  const loc = r.location || {}, ad = r.ad_info || {};
  if (!loc.lat || !loc.lng) return null;
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
  // ③ 敏感与无关内容
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
  if (!LBS_KEY) return res.status(500).json({ error: '服务端未配置 LBS_KEY' });

  const ip = getClientIp(req);
  if (!rateOk(ip)) return res.status(429).json({ error: '请求太频繁了，歇会儿再试～' });

  const styleKey = STYLES[req.body && req.body.style] ? req.body.style : 'science';

  // ① 取坐标：优先用前端 GPS，没有就用 IP 粗定位
  let lat = parseFloat(req.body && req.body.latitude);
  let lng = parseFloat(req.body && req.body.longitude);
  let source = 'gps';
  let coarseFacts = null;

  if (!isFinite(lat) || !isFinite(lng)) {
    const ipInfo = await ipLocate(ip);
    if (!ipInfo) return res.status(400).json({ error: '无法获取位置信息' });
    coarseFacts = ipInfo;
    source = 'ip';
  } else {
    const g = await toGcj02(lat, lng);
    lat = g.lat; lng = g.lng;
  }

  // ② 拿权威地理事实
  let facts = coarseFacts;
  if (!facts) {
    facts = await reverseGeocode(lat, lng);
    if (!facts && coarseFacts) facts = coarseFacts;
  }
  if (!facts) return res.status(502).json({ error: '地理信息查询失败' });

  // ③ 缓存（按 提示词版本 + 风格 + 行政区划 + 200米网格）
  const ck = [PROMPT_V, styleKey, facts.adcode || '0', isFinite(lat) ? grid(lat) : 'x', isFinite(lng) ? grid(lng) : 'x'].join(':');
  const hit = cacheGet(ck);
  if (hit) {
    return res.json({ ok: true, source, cached: true, degraded: !!hit.degraded, data: hit.data, facts });
  }

  // ④ 生成 + 校验
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
  console.log('[geo] source=%s degraded=%s adcode=%s city=%s', source, degraded, facts.adcode || '-', facts.city || '-');

  res.json({ ok: true, source, cached: false, degraded, data, facts });
}

module.exports = { handleGeoIntro, getClientIp, STYLES };
