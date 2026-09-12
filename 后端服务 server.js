const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 后台密码，部署时请修改
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 数据文件路径
const DATA_FILE = path.join(__dirname, 'data', 'visits.json');

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 确保数据文件存在
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 读取访问记录
function readVisits() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

// 写入访问记录
function writeVisits(visits) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(visits, null, 2), 'utf8');
}

// 获取客户端真实 IP（兼容代理）
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress || '';
}

// 记录访问
app.post('/api/visit', (req, res) => {
  const visits = readVisits();
  const visit = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    time: new Date().toISOString(),
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || '',
    referer: req.headers['referer'] || req.headers['referrer'] || '',
    page: req.body.page || req.path,
    language: req.headers['accept-language'] || ''
  };
  visits.unshift(visit); // 最新的放前面
  // 最多保留 10000 条记录
  if (visits.length > 10000) {
    visits.length = 10000;
  }
  writeVisits(visits);
  res.json({ success: true });
});

// 获取访问记录（需要密码）
app.get('/api/visits', (req, res) => {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  const visits = readVisits();
  res.json({
    total: visits.length,
    visits: visits.slice(0, 500) // 最多返回500条
  });
});

// 清空记录（需要密码）
app.delete('/api/visits', (req, res) => {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  writeVisits([]);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`访客记录系统已启动`);
  console.log(`前台地址: http://localhost:${PORT}`);
  console.log(`后台地址: http://localhost:${PORT}/admin.html`);
  console.log(`后台密码: ${ADMIN_PASSWORD}`);
});
//（注：内容由AI生成）
