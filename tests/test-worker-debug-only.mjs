import worker from '../diagnostics/worker-debug-only.js';
let calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return new Response(JSON.stringify({
    success: true, count: 8, pagination: { total: 8 },
    subdomains: Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, subdomain: 'demo' + (i + 1), rootdomain: 'de5.net', full_domain: 'demo' + (i + 1) + '.de5.net',
      status: 'suspended', created_at: '2025-12-20 10:00:00', updated_at: '2025-12-20 10:00:00', expires_at: '2026-12-20 10:00:00', never_expires: 0,
    })),
  }), { status: 200 });
};
const env = { API_KEY: 'cfsd_abcdefghijklmnop', API_SECRET: 'z'.repeat(64) };
const res = await worker.fetch(new Request('https://x/debug'), env, {});
const j = await res.json();
console.log('HTTP', res.status);
console.log('diagnosis:', JSON.stringify(j.diagnosis, null, 2));
console.log('statusHistogram:', JSON.stringify(j.response.statusHistogram));
console.log('domains[0]:', JSON.stringify(j.domains[0]));
console.log('itemKeys:', j.response.itemKeys.join(', '));
const all = JSON.stringify(j);
console.log('\n--- safety checks ---');
console.log('只调用了 list 接口:', calls.every((u) => u.includes('action=list')));
console.log('没有 renew 写操作:', !calls.some((u) => u.includes('renew')));
console.log('不含 secret:', !all.includes(env.API_SECRET));
console.log('不含 key 明文:', !all.includes(env.API_KEY));
console.log('捕获到 suspended 全量:', j.diagnosis.some((d) => d.includes('没有任何 "active"')));