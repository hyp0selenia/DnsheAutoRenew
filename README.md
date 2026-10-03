# DNSHE 免费域名自动续期工具
[![GitHub Stars](https://img.shields.io/github/stars/Townwang/renew?style=flat-square)](https://github.com/Townwang/renew/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/Townwang/renew?style=flat-square)](https://github.com/Townwang/renew/network/members)
[![License](https://img.shields.io/github/license/Townwang/renew?style=flat-square)](https://github.com/Townwang/renew/blob/main/LICENSE)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20To-Cloudflare%20Workers-orange?style=flat-square)](https://workers.cloudflare.com)

基于 **Cloudflare Workers** 搭建的零成本 DNSHE 免费二级域名自动续期工具，告别域名手动续期烦恼，支持网页手动触发+定时自动执行，密钥安全存储无泄露风险。

## 目录
1. [项目介绍](#1-项目介绍)
2. [免费域名注册指导](#2-免费域名注册指导-dnshe平台)
3. [部署到Cloudflare Workers完整教程](#3-部署到cloudflare-workers完整教程)
4. [使用说明](#4-使用说明)
5. [故障排查](#5-故障排查)
6. [常见问题FAQ](#6-常见问题faq)
7. [项目文件说明](#7-项目文件说明)

## 1. 项目介绍
本项目专为 DNSHE 平台免费二级域名打造，解决免费域名易过期、手动续期繁琐的问题，依托 Cloudflare Workers 实现无服务器、零成本、7×24小时稳定运行，核心优势如下：
- ✅ **零成本部署**：Cloudflare Workers 免费额度完全满足日常使用，无需购买服务器
- ✅ **安全无风险**：API密钥通过Cloudflare环境变量存储，绝不硬编码、不上传代码仓库，杜绝密钥泄露
- ✅ **双重续期模式**：支持网页可视化手动续期+每6个月定时自动续期，双重保障域名不失效
- ✅ **实时日志反馈**：续期过程实时输出日志，成功/失败状态清晰可见，便于排查问题
- ✅ **无需值守**：配置完成后自动后台运行，无需人工干预，彻底解放双手

**适用场景**：适用于个人在DNSHE平台注册的所有免费二级域名，防止域名因忘记续期被回收。

## 2. 免费域名注册指导（DNSHE平台）
### 2.1 账号注册
1. 打开 [DNSHE官方网站](https://www.dnshe.com)，点击首页「注册」按钮
2. 填写邮箱、密码、验证码，完成账号注册并登录
3. 登录后完成邮箱验证，提升账号权限

### 2.2 免费二级域名申请
1. 登录账号后，进入左侧菜单栏**域名中心 → 免费二级域名**
2. 页面展示多种免费域名后缀，选择心仪的后缀（如：xxx.dnshe.com）
3. 输入自定义前缀，检查域名是否可注册，点击「立即注册」
4. 按照提示完成域名申请流程，无需付费，即可获得免费二级域名
5. 部分二级域名需要邀请码: `HUC06F7B16`

### 2.3 获取API密钥（核心步骤）
1. 登录DNSHE账号，点击右上角**头像 → API密钥管理**
2. 点击「生成API密钥」，完成安全验证
3. 复制生成的 **API Key** 和 **API Secret**，妥善保管，后续部署需用到
> ⚠️ 注意：API密钥具有账号操作权限，切勿泄露给他人，仅用于本工具配置

## 3. 部署到Cloudflare Workers完整教程
### 3.1 前提准备
- 注册 [Cloudflare账号](https://dash.cloudflare.com)（免费注册，无需绑定信用卡）
- 备好DNSHE平台的 **API Key** 和 **API Secret**

### 3.2 新建Worker项目
1. 登录Cloudflare Dashboard，进入左侧**Workers & Pages**
2. 点击右上角**创建应用程序 → 创建Worker**
3. 自定义Worker名称（如：dnshe-renew），点击**部署**
4. 进入Worker编辑页面，删除默认示例代码，复制本项目完整代码粘贴进去
5. 点击右上角**保存并部署**，完成Worker基础创建

### 3.3 配置环境变量（必做）
1. 进入已创建的Worker页面，点击顶部**设置 → 变量**
2. 在「环境变量」区域，点击**添加变量**，依次添加以下两个变量：
    - 变量名：`API_KEY`，变量值：粘贴DNSHE的API Key
    - 变量名：`API_SECRET`，变量值：粘贴DNSHE的API Secret
3. 勾选**加密**选项（防止密钥在后台明文显示），点击**保存**
4. 保存后返回Worker主页，点击**部署**使变量生效

### 3.4 配置定时自动续期
1. 进入Worker**设置 → 触发器**
2. 找到「Cron 触发器」，点击**添加 Cron 触发器**
3. 输入定时规则：`0 0 1 */6 *`（每6个月1号00:00 UTC，即北京时间8:00执行）
4. 点击**添加**，完成定时任务配置，工具将每半年自动续期一次域名

### 3.5 本地开发配置（可选）
仓库内已包含 `wrangler.toml`，内容如下：
```toml
name = "renew"
main = "src/worker.js"
compatibility_date = "2026-01-01"

# 定时任务配置
[triggers]
crons = ["0 0 1 */6 *"]
```

本地调试请用 `wrangler dev`，密钥通过 secret 注入，**不要**写进 `wrangler.toml`（该文件会被提交进仓库）：

```bash
npx wrangler secret put API_KEY
npx wrangler secret put API_SECRET
npx wrangler dev
```

部署到线上：

```bash
npx wrangler deploy
```

## 4. 使用说明
### 4.1 手动续期操作
1. 部署完成后，复制Cloudflare Workers分配的域名（如：dnshe-renew.xxx.workers.dev）
2. 在浏览器打开该域名，进入工具主页
3. 点击**开始续期**按钮，工具自动获取所有活跃域名并执行续期
4. 页面实时显示续期日志，可查看每个域名的续期成功/失败状态

> 日志中每个域名都会显示**状态**、**到期时间**和**剩余天数**，末尾给出「续期成功 / 跳过 / 失败」的汇总。剩余天数 > 180 的域名属于正常跳过，不是失败。

### 4.2 自动续期说明
配置Cron触发器后，工具会**每6个月1号自动执行续期**，无需手动操作，执行日志可在Cloudflare Workers的**日志**页面查看。

### 4.3 续期规则（以官方为准）
- 免费二级域名有效期为 **1 年**
- **到期前 180 天**开放免费续期窗口，窗口内续期免费且次数不限
- 续期成功后到期时间顺延 1 年
- 已设置为**永不过期**（`never_expires`）的域名会被自动跳过

### 4.4 诊断接口
部署后可直接访问 `/debug`（JSON），或点击页面上的**诊断**按钮，查看接口返回的真实结构：

- 每个域名的 `status`、`expires_at`、`updated_at`、`never_expires`
- 状态分布直方图（例如 `expired: 8`）
- 自动结论（指出认证失败、字段缺失、状态异常等）

`/debug` 为只读接口，只调用 `action=list`，不会执行任何续期操作，输出中也**不包含** `API_KEY` / `API_SECRET`。

## 5. 故障排查
### 5.1 日志显示「无活跃子域名」，但账号下明明有域名
这是本项目历史版本的一个已知缺陷：旧代码用 `filter(item => item.status === "active")` 过滤域名，**只有状态恰好等于 `active` 的域名才会被处理**。DNSHE 的 `status` 取值还包括 `expired`、`suspended` 等，一旦账号下没有 `active` 的域名，列表就会被清空，于是无论接口是否正常、密钥是否正确，都会统一输出「无活跃子域名」。

当前版本已修正：

- 不再按 `status === "active"` 一刀切；非 `active` 的域名只给出警告，仍会按到期时间尝试续期
- 日志始终打印**状态分布**，一眼就能看出真实取值
- 认证失败、字段结构变化等真实原因会原样输出，不再被兜底文案掩盖

### 5.2 剩余天数判断不准 / 明明快到期却提示无需续期
旧代码不读接口返回的权威字段 `expires_at`，而是拿 `updated_at` 按 365 天反推，并且额外减了 8 小时时区。Cloudflare Workers 运行时本身就是 UTC，`new Date("2026-09-22 10:00:00")` 会被当作 UTC 解析，再减 8 小时就产生了偏差，在 180 天边界上会误判。

当前版本改为：优先使用接口的 `expires_at`（按北京时间 `+08:00` 正确解析），其次 `remaining_days`，都没有时才回退到 `created_at` / `updated_at` 估算；到期时间无法解析时不再静默跳过，而是发起续期让接口给出真实原因。

### 5.3 其他常见返回
| 日志/返回 | 含义与处理 |
| --- | --- |
| `422 renewal not yet available` | 尚未进入到期前 180 天的续期窗口，属正常，过些天再试 |
| `403 renewal window expired` | 续期宽限期已过 |
| `403 redemption period requires administrator` | 域名处于赎回期，需联系 DNSHE 管理员 |
| `402 insufficient balance for redemption renewal` | 赎回期自动扣费但余额不足 |
| `404 subdomain not found` | 域名不存在或不属于当前 API Key |
| `listDomains HTTP错误: 401/403` | 密钥错误、被 IP 白名单拦截或额度受限 |

## 6. 常见问题FAQ
### Q1：部署后点击续期提示API密钥错误？
A：检查Cloudflare环境变量名称是否为`API_KEY`和`API_SECRET`（区分大小写），确认密钥粘贴无误，重新部署后重试。

### Q2：定时任务没有自动执行？
A：检查Cron规则是否正确输入`0 0 1 */6 *`，确认触发器已启用，可在Cloudflare Workers日志页面查看执行记录。

### Q3：续期失败提示「无活跃子域名」？
A：参见 [5.1](#51-日志显示无活跃子域名但账号下明明有域名)。请先访问 `/debug` 查看**状态分布**与每个域名的 `status` 字段；当前版本已不再因状态不为 `active` 而丢弃域名。

### Q4：Cloudflare Workers免费额度够用吗？
A：完全够用，Cloudflare Workers免费版每日请求次数10万次，本工具单次续期请求极少，无额度压力。

### Q5：可以修改自动续期的时间吗？
A：可以，修改Cron触发器的定时规则即可，例如改为每月1号执行：`0 0 1 * *`，根据自身需求调整。

### Q6：本工具安全吗？会泄露域名账号吗？
A：绝对安全，API密钥存储在Cloudflare官方环境变量中，代码中无任何密钥硬编码，不会上传至任何第三方服务器。此外 `/debug` 诊断接口的输出中也不包含 `API_KEY` / `API_SECRET`。

## 7. 项目文件说明
```
DnsheAutoRenew-main/
├── src/
│   ├── worker.js              # 部署用主代码（单文件，可直接整段粘贴进 Cloudflare 网页编辑器）
│   └── worker.upstream.js     # 上游原始版本，仅作对比留档，不参与部署
├── diagnostics/
│   └── worker-debug-only.js   # 只读诊断 Worker：仅调 action=list，不做任何续期写操作
├── tests/
│   ├── test-worker-fixed.mjs       # 主代码逻辑测试（模拟接口响应，21 项断言）
│   ├── test-worker-debug-only.mjs  # 诊断版安全性与输出测试
│   ├── test-delete-subdomain.mjs   # 删除工具测试（进程内 mock，28 项断言）
│   └── probe-api.mjs               # 直连 DNSHE 接口的探测脚本（需本机可访问 api005.dnshe.com）
├── wrangler.toml              # wrangler CLI 部署配置
├── README.md
└── LICENSE
```

### 7.1 运行测试
```bash
node tests/test-worker-fixed.mjs
node tests/test-worker-debug-only.mjs
node tests/test-delete-subdomain.mjs
```
三套测试共 49 项断言，全部使用模拟的接口响应，**不会访问真实接口、也不会读取真实密钥**，可随时安全运行：

- `test-worker-fixed.mjs`：8 个域名状态全非 `active`、未进入续期窗口、接口 `success=false`、响应缺少 `subdomains` 数组、`/debug` 诊断输出、北京时间时区解析、永不过期域名跳过
### 7.2 最小化部署
`src/worker.js` 已把诊断接口与页面 UI 一起打包，无需额外依赖，可直接整段替换 Cloudflare 网页编辑器中的代码。若只想要诊断能力，可临时部署 `diagnostics/worker-debug-only.js` 并访问 `/debug`。
## 开源协议
本项目基于 **MIT License** 开源协议，完全开源免费，可自由修改、分发、使用。

## 免责声明
本工具仅用于个人合法持有的DNSHE免费域名续期，请勿用于恶意批量注册、续期域名等违规行为，由此产生的法律责任由使用者自行承担。
