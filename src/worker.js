const API_HOST = "https://api005.dnshe.com";

// ---------------- 配置 ----------------
const VALID_DAYS = 365;             // 新注册免费域名有效期 1 年
const RENEW_BEFORE_DAYS = 180;      // 到期前 180 天开放免费续期窗口（官方规则）
const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000; // 接口时间均为北京时间 UTC+8

// ---------------- HTTP 入口 ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /debug：只读诊断，输出接口原始结构（不含密钥），用于排查“无活跃子域名”
    if (url.pathname === "/debug") {
      try {
        const raw = await fetchRawList(env);
        return json(await buildDiagnostics(raw, env));
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 500);
      }
    }

    if (url.pathname === "/run") {
      return new Response(sseStream(env, false), { headers: sseHeaders() });
    }
    if (url.pathname === "/run-debug") {
      return new Response(sseStream(env, true), { headers: sseHeaders() });
    }

    return new Response(pageHtml(), {
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(autoRenewAll(env, (m) => console.log(m)));
  },
};

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

function sseStream(env, debug) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (msg) => {
        console.log(msg);
        // 必须是 Uint8Array 分块，字符串分块在 Workers/undici 下会抛 TypeError
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`)); } catch (e) { /* 客户端已断开 */ }
      };
      try {
        if (debug) {
          const raw = await fetchRawList(env);
          const diag = await buildDiagnostics(raw, env);
          for (const line of diag.report) send(line);
        } else {
          await autoRenewAll(env, send);
        }
        send("全部完成");
        // 明确的结束标记：前端据此收尾，不再靠关键字猜
        try { controller.enqueue(encoder.encode('data: "[DONE]"\n\n')); } catch (e) { /* 客户端已断开 */ }
      } catch (e) {
        send("异常：" + (e && e.message ? e.message : String(e)));
      } finally {
        try { controller.close(); } catch (e) { /* 已关闭 */ }
      }
    },
  });
}

// ---------------- 核心流程 ----------------
async function autoRenewAll(env, log) {
  if (!env.API_KEY || !env.API_SECRET) {
    log("❌ 错误：请配置 API_KEY 和 API_SECRET 环境变量");
    return;
  }

  const { raw, list, status } = await fetchList(env, log);

  // 原始响应不可解析 / 不是成功响应 —— 把真实原因说出来，不要伪装成“无活跃子域名”
  if (!raw) return;
  if (status !== 200) {
    log(`❌ 接口返回 HTTP ${status}`);
    return;
  }
  if (raw.parseError) {
    log("❌ 接口返回的不是合法 JSON：" + String(raw.text).slice(0, 300));
    return;
  }
  if (raw.ok === false) {
    log(`❌ 接口认证/请求失败：${raw.message || "(无 message)"}${raw.error_code ? " [" + raw.error_code + "]" : ""}`);
    return;
  }
  if (!Array.isArray(list)) {
    log(`⚠️ 响应中没有 subdomains 数组，实际字段：${raw.topKeys.join(", ") || "(空)"}`);
    return;
  }

  log(`总域名数: ${raw.total}（本页 ${list.length} 条）`);

  if (list.length === 0) {
    log("无活跃子域名：该 API Key 对应账号下没有任何子域名");
    return;
  }

  // 状态分布：8 个域名却 0 个 active 时，答案是这里
  log("状态分布: " + formatHistogram(raw.statusHistogram));
  const inactive = list.filter((it) => !isActive(it));
  if (inactive.length) {
    log(`⚠️ 其中 ${inactive.length} 个域名状态不是 active，仍会按到期时间尝试续期：`
      + inactive.map((it) => `${it.full_domain || it.subdomain || it.id}(${it.status ?? "无状态字段"})`).join("、"));
  }

  let renewed = 0, skipped = 0, failed = 0;

  for (const item of list) {
    const id = item.id;
    const name = item.full_domain || item.subdomain || `ID ${id}`;
    const exp = describeExpiry(item);

    log(`处理: ${name} (ID: ${id}) 状态: ${item.status ?? "无"} 到期: ${exp.display} 剩余: ${exp.remainingDays === null ? "未知" : exp.remainingDays + " 天"}`);

    if (id === undefined || id === null) {
      log(`⚠️ ${name} 缺少 id 字段，跳过`);
      skipped++;
      continue;
    }

    if (exp.neverExpires) {
      log(`✅ ${name} 已设置为永不过期，跳过`);
      skipped++;
      continue;
    }

    // 到期时间无法解析时，不再静默跳过：改为尝试续期，让接口给出真实原因
    if (exp.remainingDays !== null && exp.remainingDays > RENEW_BEFORE_DAYS) {
      log(`✅ 剩余 ${exp.remainingDays} 天（> ${RENEW_BEFORE_DAYS} 天），未进入续期窗口，无需续期`);
      skipped++;
      await sleep(200);
      continue;
    }

    const res = await renew(env, id);
    if (res && res.success === true) {
      const after = res.remaining_days !== undefined ? `，续期后剩余 ${res.remaining_days} 天` : "";
      log(`✅ 续期成功: ${name}（新到期时间 ${res.new_expires_at || "接口未返回"}${after}）`);
      renewed++;
    } else {
      failed++;
      const detail = [res && res.message, res && res.error_code].filter(Boolean).join(" ");
      log(`❌ 续期失败: ${name}，原因: ${detail || "接口无响应"}`);
    }
    await sleep(800);
  }

  log(`本次结果：续期成功 ${renewed}，跳过 ${skipped}，失败 ${failed}`);
}

// ---------------- 接口调用 ----------------
async function fetchRawList(env) {
  if (!env.API_KEY || !env.API_SECRET) {
    return { ok: false, status: 0, message: "缺少 API_KEY / API_SECRET 环境变量", text: "" };
  }
  const url = `${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=list&per_page=500&include_total=1`;
  const headers = {
    "X-API-Key": env.API_KEY,
    "X-API-Secret": env.API_SECRET,
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0",
  };

  let r;
  try {
    r = await fetch(url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, status: 0, message: "网络请求异常: " + (e && e.message ? e.message : String(e)), text: "" };
  }

  const text = await r.text();
  const out = { status: r.status, ok: r.ok, text, url };

  try {
    const d = JSON.parse(text);
    out.json = d;
    out.ok = d.success === true;
    out.message = d.message;
    out.error_code = d.error_code;
    out.topKeys = Object.keys(d);
    out.count = d.count;
    out.pagination = d.pagination;
  } catch (e) {
    out.parseError = true;
    out.ok = false;
    out.message = "响应不是 JSON: " + text.slice(0, 200);
  }
  return out;
}

async function fetchList(env, log) {
  const raw = await fetchRawList(env);
  if (!raw.json) return { raw, list: null, status: raw.status };

  const j = raw.json;
  const list = Array.isArray(j.subdomains) ? j.subdomains
    : (Array.isArray(j.data) ? j.data : (Array.isArray(j.list) ? j.list : null));

  raw.total = (j.pagination && j.pagination.total) ?? j.count ?? (Array.isArray(list) ? list.length : 0);
  raw.statusHistogram = {};
  raw.fieldNames = [];
  if (Array.isArray(list)) {
    for (const it of list) {
      const key = it && it.status !== undefined ? String(it.status) : "(无 status 字段)";
      raw.statusHistogram[key] = (raw.statusHistogram[key] || 0) + 1;
    }
    if (list[0] && typeof list[0] === "object") raw.fieldNames = Object.keys(list[0]);
  }
  return { raw, list, status: raw.status };
}

async function renew(env, id) {
  try {
    const r = await fetch(`${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=renew`, {
      method: "POST",
      headers: {
        "X-API-Key": env.API_KEY,
        "X-API-Secret": env.API_SECRET,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ subdomain_id: id }),
    });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch (e) { return { success: false, message: `HTTP ${r.status} 非 JSON: ${text.slice(0, 200)}` }; }
    if (!r.ok && d.success !== true) {
      return { success: false, message: d.message || `HTTP ${r.status}`, error_code: d.error_code };
    }
    return d;
  } catch (e) {
    return { success: false, message: String(e && e.message ? e.message : e) };
  }
}

// ---------------- 状态 / 时间判断 ----------------
// 关键修正：只按 status==="active" 过滤会让非 active（如 expired）的域名被整批丢掉
function isActive(item) {
  return String(item && item.status || "").toLowerCase() === "active";
}

function isNeverExpires(item) {
  const v = item && (item.never_expires ?? item.neverExpire ?? item.never_expires_at);
  return v === 1 || v === true || v === "1" || v === "true";
}

// 把北京时间 "YYYY-MM-DD HH:mm:ss" 正确解析为时间点（Workers 运行时为 UTC，直接 new Date(str) 会错 8 小时）
function parseApiDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = m;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}+08:00`;
    const dt = new Date(iso);
    if (!isNaN(dt.getTime())) return dt;
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function describeExpiry(item) {
  const neverExpires = isNeverExpires(item);
  // 优先使用接口权威字段 expires_at / remaining_days
  const expiresAt = parseApiDate(item && (item.expires_at ?? item.expire_at ?? item.expired_at));
  const createdGuess = parseApiDate(item && item.created_at);
  const updatedGuess = parseApiDate(item && item.updated_at);

  let remainingDays = null;
  if (typeof item?.remaining_days === "number") {
    remainingDays = item.remaining_days;
  } else if (expiresAt) {
    remainingDays = Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS);
  } else if (createdGuess) {
    remainingDays = VALID_DAYS - Math.floor((Date.now() - createdGuess.getTime()) / DAY_MS);
  } else if (updatedGuess) {
    remainingDays = VALID_DAYS - Math.floor((Date.now() - updatedGuess.getTime()) / DAY_MS);
  }

  let display = "接口未返回 expires_at";
  if (item && item.expires_at) display = String(item.expires_at);
  else if (createdGuess) display = `按注册时间 ${item.created_at} 估算`;
  else if (updatedGuess) display = `按更新时间 ${item.updated_at} 估算`;

  return { neverExpires, expiresAt, remainingDays, display };
}

// ---------------- 诊断 ----------------
async function buildDiagnostics(raw, env) {
  const report = [];
  const data = {
    ok: false,
    generatedAt: new Date().toISOString(),
    env: {
      API_KEY_set: !!env.API_KEY,
      API_SECRET_set: !!env.API_SECRET,
      API_KEY_format_ok: typeof env.API_KEY === "string" && env.API_KEY.startsWith("cfsd_"),
      API_KEY_has_whitespace: typeof env.API_KEY === "string" && env.API_KEY !== env.API_KEY.trim(),
    },
    request: { url: raw.url, httpStatus: raw.status },
    response: {},
    domains: [],
    diagnosis: [],
  };

  if (!raw.json) {
    data.response.parseError = true;
    data.response.bodyPreview = String(raw.text || "").slice(0, 500);
    data.diagnosis.push("接口没有返回可解析的 JSON，先看 response.bodyPreview 与 httpStatus。");
    report.push(`❌ 接口返回不可解析：HTTP ${raw.status} ${String(raw.text || "").slice(0, 200)}`);
    return { ...data, report };
  }

  const j = raw.json;
  const list = Array.isArray(j.subdomains) ? j.subdomains
    : (Array.isArray(j.data) ? j.data : (Array.isArray(j.list) ? j.list : null));

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
        id: it.id,
        full_domain: it.full_domain,
        subdomain: it.subdomain,
        rootdomain: it.rootdomain,
        status: it.status,
        never_expires: it.never_expires,
        created_at: it.created_at,
        updated_at: it.updated_at,
        expires_at: it.expires_at,
        remaining_days: exp.remainingDays,
        wouldRenew: exp.neverExpires ? false : (exp.remainingDays === null ? true : exp.remainingDays <= RENEW_BEFORE_DAYS),
      });
    }
  }

  report.push(`HTTP ${raw.status} | success=${j.success} | count=${j.count ?? "无"} | 分页总数=${(j.pagination && j.pagination.total) ?? "无"}`);
  report.push(`响应字段: ${Object.keys(j).join(", ")}`);
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

  // 自动结论
  const hist = data.response.statusHistogram;
  if (j.success !== true) {
    data.diagnosis.push(`接口 success 不是 true（message=${j.message ?? "无"}，error_code=${j.error_code ?? "无"}）：密钥无效、被 IP 白名单拦截或额度受限。`);
  }
  if (Array.isArray(list) && list.length === 0) {
    data.diagnosis.push("接口成功但返回 0 条子域名：这个 API Key 所属账号下确实没有域名，或密钥属于另一个账号。");
  }
  if (hist && Object.keys(hist).length && !hist["active"]) {
    data.diagnosis.push(`状态里没有任何 "active"（实际为 ${formatHistogram(hist)}）：原版代码的 status==="active" 过滤会把全部域名丢掉，这就是“无活跃子域名”的直接原因。`);
  }
  if (Array.isArray(list) && list.length && !data.response.itemKeys.includes("expires_at")) {
    data.diagnosis.push("响应里没有 expires_at 字段：原版代码只能用 updated_at 按 365 天反推剩余天数，并额外减 8 小时时区，容易判断错续期窗口。");
  }
  if (Array.isArray(list) && list.length) {
    const willRenew = data.domains.filter((d) => d.wouldRenew).length;
    data.diagnosis.push(`共 ${list.length} 个域名，其中 ${willRenew} 个当前会执行续期、${list.length - willRenew} 个跳过。`);
  }
  if (!data.diagnosis.length) {
    data.diagnosis.push("接口与字段结构正常，没有发现异常。");
  }

  data.ok = true;
  return { ...data, report };
}

function formatHistogram(h) {
  const keys = Object.keys(h || {});
  if (!keys.length) return "(无数据)";
  return keys.map((k) => `${k}: ${h[k]}`).join("，");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- 页面 ----------------
function pageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DNSHE 自动续期</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:#f0f2f5;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:20px}
.container{width:100%;max-width:760px;background:#fff;border-radius:16px;padding:30px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
h1{text-align:center;font-size:24px;color:#1e293b;margin-bottom:24px}
.row{display:flex;gap:10px}
.btn{flex:1;padding:14px;font-size:16px;color:#fff;background:#2563eb;border:none;border-radius:10px;cursor:pointer}
.btn:hover{background:#1d4ed8}
.btn.alt{background:#475569}
.btn.alt:hover{background:#334155}
.btn:disabled{background:#94a3b8;cursor:not-allowed}
.log-card{margin-top:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;min-height:240px;max-height:560px;overflow:auto;font-size:13.5px;line-height:1.7;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.log-success{color:#059669;font-weight:500}
.log-error{color:#dc2626;font-weight:500}
.log-normal{color:#334155}
.log-warning{color:#d97006;font-weight:500}
.hint{margin-top:14px;font-size:12.5px;color:#64748b;line-height:1.6}
</style>
</head>
<body>
<div class="container">
  <h1>DNSHE 自动续期</h1>
  <div class="row">
    <button class="btn" id="btn" onclick="startRun('/run',false)">开始续期</button>
    <button class="btn alt" id="dbtn" onclick="startRun('/run-debug',true)">诊断</button>
  </div>
  <div id="log" class="log-card">等待执行...</div>
  <div class="hint">诊断会列出接口返回的全部状态与到期字段，用于排查“无活跃子域名”。也可直接访问 <a href="/debug" target="_blank">/debug</a> 查看 JSON（不含密钥）。</div>
</div>
<script>
var btn=document.getElementById('btn'), dbtn=document.getElementById('dbtn'), logEl=document.getElementById('log'), es=null;
function reset(){ if(es){es.close();es=null;} btn.disabled=false; dbtn.disabled=false; btn.textContent='开始续期'; dbtn.textContent='诊断'; }
function startRun(path, isDebug){
  reset();
  btn.disabled=true; dbtn.disabled=true;
  if(isDebug){ dbtn.textContent='诊断中...'; } else { btn.textContent='执行中...'; }
  logEl.innerHTML='';
  es=new EventSource(path);
  es.onmessage=function(e){
    var line=e.data;
    try{ line=JSON.parse(e.data); }catch(err){}
    if(line==='[DONE]'){ reset(); return; }
    var txt=String(line).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var cls='log-normal';
    if(String(line).indexOf('✅')>-1){ cls='log-success'; }
    else if(String(line).indexOf('❌')>-1){ cls='log-error'; }
    else if(String(line).indexOf('⚠️')>-1){ cls='log-warning'; }
    var span=document.createElement('span');
    span.className=cls;
    span.textContent=String(line)+'\\n';
    logEl.appendChild(span);
    logEl.scrollTop=logEl.scrollHeight;
  };
  es.onerror=function(){ if(es){es.close();es=null;} reset(); };
}
</script>
</body>
</html>`;
}