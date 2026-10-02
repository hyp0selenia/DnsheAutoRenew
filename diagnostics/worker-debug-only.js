// ============================================================
//  DNSHE 只读诊断 Worker（单文件版）
//  作用：把 DNSHE 接口的真实返回原样列出来，用来定位
//        “总域名数: 8 无活跃子域名” 到底卡在哪一步。
//  安全：只调用 action=list 只读接口，不会做任何续期/写操作；
//        输出中不包含 API Key / API Secret。
//  用法：临时替换 Worker 代码并部署 → 打开 https://你的域名/debug
// ============================================================

const API_HOST = "https://api005.dnshe.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_DAYS = 180;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/debug") {
      const raw = await fetchRawList(env);
      const diag = buildDiagnostics(raw, env);
      return new Response(JSON.stringify(diag, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/run") return sseDiag(env);
    return new Response(PAGE, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  },
};

function sseDiag(env) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (m) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(m)}\n\n`)); } catch (e) {} };
      try {
        const diag = buildDiagnostics(await fetchRawList(env), env);
        for (const line of diag.report) send(line);
        send("全部完成");
        try { controller.enqueue(encoder.encode('data: "[DONE]"\n\n')); } catch (e) {}
      } catch (e) {
        send("异常：" + (e && e.message ? e.message : String(e)));
      } finally {
        try { controller.close(); } catch (e) {}
      }
    },
  });
}

async function fetchRawList(env) {
  const out = { url: `${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=list&per_page=500&include_total=1` };
  if (!env.API_KEY || !env.API_SECRET) {
    return { ...out, status: 0, ok: false, message: "缺少 API_KEY / API_SECRET 环境变量", text: "" };
  }
  let r;
  try {
    r = await fetch(out.url, {
      headers: { "X-API-Key": env.API_KEY, "X-API-Secret": env.API_SECRET, Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
  } catch (e) {
    return { ...out, status: 0, ok: false, message: "网络请求异常: " + (e && e.message ? e.message : String(e)), text: "" };
  }
  const text = await r.text();
  const res = { ...out, status: r.status, ok: r.ok, text };
  try {
    const d = JSON.parse(text);
    res.json = d;
    res.ok = d.success === true;
    res.message = d.message;
    res.error_code = d.error_code;
  } catch (e) {
    res.parseError = true;
    res.ok = false;
    res.message = "响应不是 JSON";
  }
  return res;
}

function buildDiagnostics(raw, env) {
  const report = [];
  const data = {
    generatedAt: new Date().toISOString(),
    env: {
      API_KEY_set: !!env.API_KEY,
      API_SECRET_set: !!env.API_SECRET,
      API_KEY_prefix_ok: typeof env.API_KEY === "string" && env.API_KEY.startsWith("cfsd_"),
    },
    request: { url: raw.url, httpStatus: raw.status },
    response: {},
    domains: [],
    diagnosis: [],
  };

  if (!raw.json) {
    data.response.parseError = true;
    data.response.bodyPreview = String(raw.text || "").slice(0, 500);
    data.diagnosis.push("接口没有返回可解析的 JSON，请看 response.bodyPreview 与 request.httpStatus。");
    report.push(`❌ HTTP ${raw.status}：${String(raw.text || raw.message || "").slice(0, 200)}`);
    return { ...data, report };
  }

  const j = raw.json;
  const list = Array.isArray(j.subdomains) ? j.subdomains : (Array.isArray(j.data) ? j.data : (Array.isArray(j.list) ? j.list : null));

  data.response = {
    success: j.success,
    message: j.message,
    error_code: j.error_code,
    topLevelKeys: Object.keys(j),
    count: j.count,
    pagination: j.pagination,
    arrayField: j.subdomains ? "subdomains" : (j.data ? "data" : (j.list ? "list" : null)),
    arrayLength: Array.isArray(list) ? list.length : null,
    itemKeys: Array.isArray(list) && list[0] ? Object.keys(list[0]) : [],
    statusHistogram: {},
    rawFirstItem: Array.isArray(list) && list[0] ? list[0] : null,
  };

  if (Array.isArray(list)) {
    for (const it of list) {
      const k = it && it.status !== undefined ? String(it.status) : "(无 status 字段)";
      data.response.statusHistogram[k] = (data.response.statusHistogram[k] || 0) + 1;
    }
    for (const it of list) {
      const exp = describeExpiry(it);
      data.domains.push({
        id: it.id, full_domain: it.full_domain, subdomain: it.subdomain, rootdomain: it.rootdomain,
        status: it.status, never_expires: it.never_expires,
        created_at: it.created_at, updated_at: it.updated_at, expires_at: it.expires_at,
        remaining_days: exp.remainingDays,
        wouldRenew: exp.neverExpires ? false : (exp.remainingDays === null ? true : exp.remainingDays <= RENEW_BEFORE_DAYS),
      });
    }
  }

  report.push(`HTTP ${raw.status} | success=${j.success} | count=${j.count ?? "无"} | 分页总数=${(j.pagination && j.pagination.total) ?? "无"}`);
  report.push(`顶层字段: ${Object.keys(j).join(", ")}`);
  if (Array.isArray(list)) {
    report.push(`subdomains 条数: ${list.length}`);
    report.push(`单个域名字段: ${data.response.itemKeys.join(", ") || "(无)"}`);
    report.push(`状态分布: ${formatHistogram(data.response.statusHistogram)}`);
    for (const d of data.domains) {
      report.push(`  · ${d.full_domain ?? d.subdomain ?? d.id} | status=${JSON.stringify(d.status)} | expires_at=${d.expires_at ?? "(无)"} | updated_at=${d.updated_at ?? "(无)"} | 剩余=${d.remaining_days ?? "未知"}天 | ${d.wouldRenew ? "将续期" : "跳过"}`);
    }
  } else {
    report.push(`⚠️ 未找到 subdomains 数组，顶层字段为: ${Object.keys(j).join(", ") || "(空)"}`);
  }

  const hist = data.response.statusHistogram;
  if (j.success !== true) data.diagnosis.push(`接口 success 不是 true（message=${j.message ?? "无"}，error_code=${j.error_code ?? "无"}）：密钥无效、被 IP 白名单拦截或额度受限。`);
  if (Array.isArray(list) && list.length === 0) data.diagnosis.push("接口成功但返回 0 条：这个 API Key 所属账号下确实没有域名。");
  if (hist && Object.keys(hist).length && !hist["active"]) data.diagnosis.push(`状态里没有任何 "active"（实际为 ${formatHistogram(hist)}）：原版代码的 status==="active" 过滤会丢掉全部域名，这就是“无活跃子域名”的直接原因。`);
  if (Array.isArray(list) && list.length && !data.response.itemKeys.includes("expires_at")) data.diagnosis.push("响应里没有 expires_at 字段：原版只能用 updated_at 按 365 天反推，并且额外减了 8 小时时区，容易判断错续期窗口。");
  if (!data.diagnosis.length) data.diagnosis.push("接口与字段结构正常，没有发现异常。");

  return { ...data, report };
}

function parseApiDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") { const d = new Date(value < 1e12 ? value * 1000 : value); return isNaN(d.getTime()) ? null : d; }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = m;
    const dt = new Date(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}+08:00`);
    if (!isNaN(dt.getTime())) return dt;
  }
  const f = new Date(s);
  return isNaN(f.getTime()) ? null : f;
}

function describeExpiry(item) {
  const v = item && (item.never_expires ?? item.neverExpire);
  const neverExpires = v === 1 || v === true || v === "1" || v === "true";
  const expiresAt = parseApiDate(item && (item.expires_at ?? item.expire_at ?? item.expired_at));
  let remainingDays = null;
  if (typeof item?.remaining_days === "number") remainingDays = item.remaining_days;
  else if (expiresAt) remainingDays = Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS);
  return { neverExpires, expiresAt, remainingDays };
}

function formatHistogram(h) {
  const keys = Object.keys(h || {});
  return keys.length ? keys.map((k) => `${k}: ${h[k]}`).join("，") : "(无数据)";
}

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DNSHE 只读诊断</title>
<style>body{font-family:system-ui;background:#f0f2f5;display:flex;justify-content:center;padding:20px}
.c{width:100%;max-width:760px;background:#fff;border-radius:16px;padding:30px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
h1{font-size:22px;color:#1e293b;text-align:center;margin-bottom:8px}p{color:#64748b;font-size:13px;text-align:center;margin-bottom:20px}
button{width:100%;padding:14px;font-size:16px;color:#fff;background:#2563eb;border:0;border-radius:10px;cursor:pointer}
button:disabled{background:#94a3b8}
#log{margin-top:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;min-height:200px;max-height:520px;overflow:auto;font:13px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:#334155}</style></head>
<body><div class="c"><h1>DNSHE 只读诊断</h1><p>不会执行任何续期操作，输出中不含密钥</p>
<button id="b" onclick="go()">开始诊断</button><div id="log">点击上方按钮开始…</div></div>
<script>var b=document.getElementById('b'),l=document.getElementById('log'),es;
function go(){if(es)es.close();b.disabled=true;b.textContent='诊断中…';l.innerHTML='';
es=new EventSource('/run');
es.onmessage=function(e){var s=e.data;try{s=JSON.parse(e.data)}catch(x){}
 if(s==='[DONE]'){es.close();b.disabled=false;b.textContent='重新诊断';return}
 l.textContent+=s+'\\n';l.scrollTop=l.scrollHeight};
es.onerror=function(){if(es)es.close();b.disabled=false;b.textContent='重新诊断'}}</script></body></html>`;