// 强制使用 IPv4 解析，解决 Render 免费版不支持 IPv6 的问题
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 后台密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 数据库连接字符串（从环境变量读取）
const DATABASE_URL = process.env.DATABASE_URL;

// 创建数据库连接池
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 15000,
});

// 测试数据库连接
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功');
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 获取客户端真实 IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress || '';
}

// 记录访问（写入数据库）
app.post('/api/visit', async (req, res) => {
  try {
    const id = Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const time = new Date().toISOString();
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const referer = req.headers['referer'] || req.headers['referrer'] || '';
    const page = req.body.page || req.path;
    const language = req.headers['accept-language'] || '';

    await pool.query(
      'INSERT INTO visits (id, time, ip, user_agent, referer, page, language) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, time, ip, userAgent, referer, page, language]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('记录访问失败:', err);
    res.status(500).json({ error: '记录失败' });
  }
});

// 获取访问记录（从数据库读取）
app.get('/api/visits', async (req, res) => {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }

  try {
    // 获取总数
    const countResult = await pool.query('SELECT COUNT(*) FROM visits');
    const total = parseInt(countResult.rows[0].count);

    // 获取最新500条
    const result = await pool.query(
      'SELECT id, time, ip, user_agent as "userAgent", referer, page, language FROM visits ORDER BY time DESC LIMIT 500'
    );

    res.json({
      total: total,
      visits: result.rows
    });
  } catch (err) {
    console.error('查询记录失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 清空记录
app.delete('/api/visits', async (req, res) => {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }

  try {
    await pool.query('DELETE FROM visits');
    res.json({ success: true });
  } catch (err) {
    console.error('清空记录失败:', err);
    res.status(500).json({ error: '清空失败' });
  }
});

app.listen(PORT, () => {
  console.log(`访客记录系统已启动`);
  console.log(`前台地址: http://localhost:${PORT}`);
  console.log(`后台地址: http://localhost:${PORT}/admin.html`);
  console.log(`后台密码: ${ADMIN_PASSWORD}`);
});
