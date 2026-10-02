import worker from '../src/worker.js';

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 19).replace('T', ' ');

function makeList(items) {
  return { success: true, count: items.length, pagination: { total: items.length }, subdomains: items };
}

function mockFetch(listBody, renewHandler) {
  return async (url, opts = {}) => {
    if (String(url).includes('action=list')) {
      return new Response(JSON.stringify(listBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('action=renew')) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify(renewHandler(body.subdomain_id)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected url ' + url);
  };
}

async function collect(path, env) {
  const lines = [];
  const req = new Request('https://x' + path);
  const res = await worker.fetch(req, env, { waitUntil() {} });
  const text = await res.text();
  if (path === '/debug') return { json: JSON.parse(text), lines };
  for (const block of text.split('\n\n')) {
    const m = block.match(/^data: (.*)$/m);
    if (m) lines.push(JSON.parse(m[1]));
  }
  return { json: null, lines };
}

const env = { API_KEY: 'cfsd_testkey1234567890', API_SECRET: 's'.repeat(64) };
let renewCalls = [];
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---------- 场景 1：8 个域名，状态全是 expired（用户遇到的场景） ----------
console.log('\n=== 场景 1：8 个域名，status 全为 expired，且都已进入续期窗口 ===');
{
  renewCalls = [];
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    subdomain: 'demo' + (i + 1),
    rootdomain: 'de5.net',
    full_domain: 'demo' + (i + 1) + '.de5.net',
    status: 'expired',
    created_at: iso(-300),
    updated_at: iso(-300),
    expires_at: iso(-1),
  }));
  globalThis.fetch = mockFetch(makeList(items), (id) => {
    renewCalls.push(id);
    return { success: true, message: 'Subdomain renewed successfully', subdomain_id: id, new_expires_at: '2027-01-05 00:00:00', remaining_days: 365, charged_amount: 0 };
  });
  const { lines } = await collect('/run', env);
  const joined = lines.join('\n');
  check('不再输出“无活跃子域名”', !joined.includes('无活跃子域名'));
  check('识别出 8 个域名', joined.includes('总域名数: 8'));
  check('输出状态分布且无 active', /状态分布.*expired: 8/.test(joined));
  check('对全部 8 个域名发起续期', renewCalls.length === 8, '实际 ' + renewCalls.length);
  check('报告 8 个续期成功', /续期成功 8/.test(joined));
  check('最后发出 [DONE] 结束标记', lines[lines.length - 1] === '[DONE]', JSON.stringify(lines[lines.length-1]));
}

// ---------- 场景 2：status 为 active 但未进入续期窗口 ----------
console.log('\n=== 场景 2：status=active，到期时间还早，应跳过续期 ===');
{
  renewCalls = [];
  const items = [{ id: 9, full_domain: 'far.de5.net', status: 'active', created_at: iso(-10), updated_at: iso(-10), expires_at: iso(355) }];
  globalThis.fetch = mockFetch(makeList(items), (id) => { renewCalls.push(id); return { success: true }; });
  const { lines } = await collect('/run', env);
  const joined = lines.join('\n');
  check('未发起续期', renewCalls.length === 0, '实际 ' + renewCalls.length);
  check('提示未进入续期窗口', joined.includes('未进入续期窗口'));
  check('报告跳过 1 个', /跳过 1/.test(joined));
}

// ---------- 场景 3：接口 success=false（密钥/IP 白名单问题） ----------
console.log('\n=== 场景 3：接口 success=false，应报出真实原因 ===');
{
  globalThis.fetch = mockFetch({ success: false, message: 'Invalid API credentials' }, () => ({}));
  const { lines } = await collect('/run', env);
  const joined = lines.join('\n');
  check('报出接口失败原因', joined.includes('Invalid API credentials'));
  check('不再误报“无活跃子域名”', !joined.includes('无活跃子域名'));
}

// ---------- 场景 4：响应结构变化（没有 subdomains 字段） ----------
console.log('\n=== 场景 4：响应结构变化，缺少 subdomains 数组 ===');
{
  globalThis.fetch = mockFetch({ success: true, count: 0, items: [] }, () => ({}));
  const { lines } = await collect('/run', env);
  const joined = lines.join('\n');
  check('提示字段与预期不符并列出顶层字段', joined.includes('响应中没有 subdomains 数组') && joined.includes('items'));
}

// ---------- 场景 5：/debug 诊断端点 ----------
console.log('\n=== 场景 5：/debug 诊断端点 ===');
{
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, subdomain: 'demo' + (i + 1), rootdomain: 'de5.net', full_domain: 'demo' + (i + 1) + '.de5.net',
    status: i === 0 ? 'active' : 'expired', created_at: iso(-300), updated_at: iso(-300), expires_at: iso(-1),
  }));
  globalThis.fetch = mockFetch(makeList(items), () => ({}));
  const { json } = await collect('/debug', env);
  check('诊断返回 ok', json.ok === true);
  check('给出状态直方图', JSON.stringify(json.response.statusHistogram) === '{"active":1,"expired":7}', JSON.stringify(json.response.statusHistogram));
  check('列出每个域名的 status 与到期时间', json.domains.length === 8 && json.domains[0].expires_at !== undefined);
  check('输出自动结论', json.diagnosis.length > 0);
  check('诊断结果里不含 API_SECRET', !JSON.stringify(json).includes(env.API_SECRET));
  check('诊断结果里不含 API_KEY 明文', !JSON.stringify(json).includes(env.API_KEY));
  console.log('  diagnosis:', JSON.stringify(json.diagnosis, null, 2).split('\n').join('\n  '));
}

// ---------- 场景 6：时区解析（北京时间 → UTC） ----------
console.log('\n=== 场景 6：北京时间解析与永久域名跳过 ===');
{
  renewCalls = [];
  // 北京时间到期时间 = 现在 + 100 天（应为续期）；再放一个永不过期的域名（应跳过）
  const beijing = new Date(Date.now() + 100 * DAY + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const items = [
    { id: 21, full_domain: 'soon.de5.net', status: 'active', expires_at: beijing },
    { id: 22, full_domain: 'forever.de5.net', status: 'active', never_expires: 1, expires_at: null },
  ];
  globalThis.fetch = mockFetch(makeList(items), (id) => { renewCalls.push(id); return { success: true, remaining_days: 465 }; });
  const { lines } = await collect('/run', env);
  const joined = lines.join('\n');
  const soonLine = lines.find((l) => l.includes('soon.de5.net'));
  const foreverLine = lines.find((l) => l.includes('forever.de5.net'));
  console.log('  soon   :', soonLine);
  console.log('  forever:', foreverLine);
  check('剩余天数在 100 天附近（时区未错 8 小时）', /剩余: (99|100) 天/.test(joined), soonLine);
  check('到期 100 天的域名被续期', renewCalls.includes(21));
  check('永不过期的域名被跳过', !renewCalls.includes(22));
}

console.log('\n================ 结果: ' + pass + ' passed, ' + fail + ' failed ================');
process.exit(fail ? 1 : 0);