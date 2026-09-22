/* ============================================================
 * geo-widget.js —— 前端地理智能体组件（放到 public/ 目录）
 * 用法：在 index.html 的 </body> 前面加一行
 *   <script src="/geo-widget.js"></script>
 * 不需要改页面其他任何地方
 * ============================================================ */
(function () {
  'use strict';

  var API = '/api/geo-intro';
  var currentPos = null;
  var currentStyle = 'science';

  var css = [
    '.geo-card{margin-top:28px;border-top:1px solid #eee;padding-top:22px;text-align:left}',
    '.geo-title{font-size:16px;font-weight:600;color:#333;margin-bottom:6px}',
    '.geo-sub{font-size:12px;color:#999;margin-bottom:14px;line-height:1.6}',
    '.geo-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
    '.geo-chip{padding:6px 12px;font-size:12px;border:1px solid #ddd;background:#fff;color:#666;border-radius:999px;cursor:pointer;transition:.15s}',
    '.geo-chip:hover{border-color:#667eea;color:#667eea}',
    '.geo-chip.on{background:#667eea;border-color:#667eea;color:#fff}',
    '.geo-btn{width:100%;padding:12px;background:#667eea;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;transition:.15s}',
    '.geo-btn:hover{background:#5568d3}',
    '.geo-btn:disabled{background:#b9bff0;cursor:not-allowed}',
    '.geo-out{margin-top:16px;padding:16px;background:#f7f8fc;border-radius:10px;display:none}',
    '.geo-out.show{display:block}',
    '.geo-h{font-size:15px;font-weight:600;color:#333;margin-bottom:8px}',
    '.geo-p{font-size:14px;line-height:1.85;color:#555;white-space:pre-wrap}',
    '.geo-tags{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}',
    '.geo-tag{font-size:11px;color:#667eea;background:#eef0fd;padding:3px 9px;border-radius:999px}',
    '.geo-msg{margin-top:12px;font-size:13px;color:#999;min-height:18px}',
    '.geo-warn{margin-top:10px;font-size:11px;color:#c0392b;display:none}',
    '.geo-dot:after{content:"";animation:geoDots 1.2s steps(4,end) infinite}',
    '@keyframes geoDots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var mount = document.querySelector('.container') || document.body;
  var card = document.createElement('div');
  card.className = 'geo-card';
  card.innerHTML =
    '<div class="geo-title">我在哪儿 · AI 地理速写</div>' +
    '<div class="geo-sub">本页会记录访客的位置用于访问统计。点击下方按钮，AI 会据此生成一段关于此地的地理介绍。<br>位置信息不会对外公开。</div>' +
    '<div class="geo-chips">' +
      '<button class="geo-chip on" data-style="science">地理科普</button>' +
      '<button class="geo-chip" data-style="travel">旅行推荐</button>' +
      '<button class="geo-chip" data-style="brief">一句话</button>' +
    '</div>' +
    '<button class="geo-btn" id="geoGo">生成我的地点速写</button>' +
    '<div class="geo-msg" id="geoMsg"></div>' +
    '<div class="geo-out" id="geoOut">' +
      '<div class="geo-h" id="geoH"></div>' +
      '<div class="geo-p" id="geoP"></div>' +
      '<div class="geo-tags" id="geoTags"></div>' +
      '<div class="geo-warn" id="geoWarn"></div>' +
    '</div>';
  mount.appendChild(card);

  var btn = card.querySelector('#geoGo');
  var msg = card.querySelector('#geoMsg');
  var out = card.querySelector('#geoOut');
  var elH = card.querySelector('#geoH');
  var elP = card.querySelector('#geoP');
  var elTags = card.querySelector('#geoTags');
  var elWarn = card.querySelector('#geoWarn');

  card.querySelectorAll('.geo-chip').forEach(function (c) {
    c.addEventListener('click', function () {
      card.querySelectorAll('.geo-chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on');
      currentStyle = c.dataset.style;
    });
  });

  function getPos() {
    return new Promise(function (resolve, reject) {
      if (window.__visitorPos) return resolve(window.__visitorPos);
      if (currentPos) return resolve(currentPos);
      if (!window.isSecureContext) return reject(new Error('页面不是 HTTPS，浏览器禁止定位'));
      if (!navigator.geolocation) return reject(new Error('浏览器不支持定位'));
      navigator.geolocation.getCurrentPosition(
        function (p) {
          currentPos = { latitude: p.coords.latitude, longitude: p.coords.longitude };
          resolve(currentPos);
        },
        function (e) {
          reject(new Error(e.code === 1 ? '你拒绝了定位授权' : '定位失败，将改用 IP 粗定位'));
        },
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 }
      );
    });
  }

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    out.classList.remove('show');
    elWarn.style.display = 'none';
    msg.innerHTML = '正在获取位置<span class="geo-dot"></span>';

    var payload = { style: currentStyle };
    try {
      var pos = await getPos();
      payload.latitude = pos.latitude;
      payload.longitude = pos.longitude;
      msg.innerHTML = '位置已获取，AI 正在写作<span class="geo-dot"></span>';
    } catch (e) {
      msg.textContent = e.message + '，继续生成…';
    }

    try {
      var res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var j = await res.json();
      if (!res.ok || !j.ok) throw new Error((j && j.error) || '生成失败');

      elH.textContent = j.data.title;
      elP.textContent = j.data.body;
      elTags.innerHTML = (j.data.tags || []).map(function (t) {
        return '<span class="geo-tag">' + t + '</span>';
      }).join('');
      out.classList.add('show');

      if (j.degraded) {
        elWarn.style.display = 'block';
        elWarn.textContent = '（当前为纯事实速写：AI 生成内容未通过事实校验，已自动替换为权威地理数据拼接版本）';
      }
      msg.textContent = j.source === 'ip' ? '基于 IP 的城市级定位结果' : '基于 GPS 定位结果';
    } catch (err) {
      msg.textContent = '出错了：' + err.message;
    } finally {
      btn.disabled = false;
    }
  });
})();
