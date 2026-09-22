const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const { handleGeoIntro, handleGeoDiag } = require('./geo');
const PORT = process.env.PORT || 3000;

// 后台密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Supabase 配置（从环境变量读取）
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// 创建 Supabase 客户端
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 测试连接
async function testConnection() {
  try {
    const { data, error } = await supabase.from('visits').select('id').limit(1);
    if (error) {
      console.error('Supabase 连接失败:', error.message);
    } else {
      console.log('Supabase 连接成功');
    }
  } catch (err) {
    console.error('Supabase 连接异常:', err.message);
  }
}
testConnection();

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

// 记录访问（写入 Supabase）
app.post('/api/visit', async (req, res) => {
  try {
    const id = Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    const time = new Date().toISOString();
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const referer = req.headers['referer'] || req.headers['referrer'] || '';
    const page = req.body.page || req.path;
    const language = req.headers['accept-language'] || '';
    // GPS 定位信息
    const latitude = req.body.latitude || null;
    const longitude = req.body.longitude || null;
    const accuracy = req.body.accuracy || null;

    const { error } = await supabase.from('visits').insert([
      {
        id,
        time,
        ip,
        user_agent: userAgent,
        referer,
        page,
        language,
        latitude,
        longitude,
        accuracy
      }
    ]);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('记录访问失败:', err);
    res.status(500).json({ error: '记录失败' });
  }
});

// 获取访问记录（从 Supabase 读取）
app.get('/api/visits', async (req, res) => {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }

  try {
    // 获取总数
    const { count, error: countError } = await supabase
      .from('visits')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    // 获取最新500条
    const { data, error } = await supabase
      .from('visits')
      .select('id, time, ip, user_agent, referer, page, language, latitude, longitude, accuracy')
      .order('time', { ascending: false })
      .limit(500);

    if (error) throw error;

    // 字段名转换
    const visits = data.map(item => ({
      id: item.id,
      time: item.time,
      ip: item.ip,
      userAgent: item.user_agent,
      referer: item.referer,
      page: item.page,
      language: item.language,
      latitude: item.latitude,
      longitude: item.longitude,
      accuracy: item.accuracy
    }));

    res.json({
      total: count || 0,
      visits: visits
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
    const { error } = await supabase.from('visits').delete().neq('id', '');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('清空记录失败:', err);
    res.status(500).json({ error: '清空失败' });
  }
});
// AI 地理速写接口
app.post('/api/geo-intro', handleGeoIntro);
app.get('/api/geo-diag', handleGeoDiag);
app.listen(PORT, () => {
  console.log(`访客记录系统已启动（含GPS定位）`);
  console.log(`前台地址: http://localhost:${PORT}`);
  console.log(`后台地址: http://localhost:${PORT}/admin.html`);
  console.log(`后台密码: ${ADMIN_PASSWORD}`);
});
