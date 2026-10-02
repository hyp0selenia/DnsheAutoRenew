import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const raw = fs.readFileSync(path.join(HERE, '..', '..', 'dnshekey.txt'), 'utf8');
const pair = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_]+)\s*[=:\s]\s*(\S+)\s*$/);
  if (m) pair[m[1]] = m[2];
}
console.log('parsed keys:', Object.keys(pair).join(', '));

const HOST = 'https://api005.dnshe.com';
const url = HOST + '/index.php?m=domain_hub&endpoint=subdomains&action=list';

const r = await fetch(url, {
  headers: {
    'X-API-Key': pair.API_KEY,
    'X-API-Secret': pair.API_SECRET,
    'User-Agent': 'Mozilla/5.0',
  },
});
console.log('HTTP', r.status, r.headers.get('content-type'));

const text = await r.text();
fs.writeFileSync(path.join(HERE, 'list.json'), text);
console.log('bytes:', text.length);

let d;
try { d = JSON.parse(text); } catch (e) {
  console.log('NOT JSON, first 800 chars:\n', text.slice(0, 800));
  process.exit(0);
}

console.log('top-level keys:', Object.keys(d).join(', '));
console.log('success:', d.success, '| count:', d.count, '| message:', d.message);
const list = d.subdomains ?? d.data ?? d.list;
console.log('array field:', d.subdomains ? 'subdomains' : (d.data ? 'data' : (d.list ? 'list' : 'NONE')));
if (Array.isArray(list)) {
  console.log('array length:', list.length);
  if (list.length) console.log('item[0] keys:', Object.keys(list[0]).join(', '));
  console.log('--- all items ---');
  for (const it of list) {
    console.log(JSON.stringify({ id: it.id, full_domain: it.full_domain, status: it.status, updated_at: it.updated_at, created_at: it.created_at }));
  }
  const byStatus = {};
  for (const it of list) byStatus[String(it.status)] = (byStatus[String(it.status)] || 0) + 1;
  console.log('status histogram:', JSON.stringify(byStatus));
  console.log('=== raw first item ===');
  console.log(JSON.stringify(list[0], null, 2));
}