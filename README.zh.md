# dsh-deepseek-usage

[English](README.md) | 中文

一个 DSH Web 插件：把 **DeepSeek 账户余额显示在侧边栏脚部、设置行上方**，并带一个刷新按钮。
点击该行会打开弹出层，内含余额卡、本地聚合的用量图表、按模型明细表，以及指向
`platform.deepseek.com/usage` 的链接。

所有元素都使用 shell 自身的主题令牌渲染，因此浅色与深色主题都正常。

| 侧边栏脚部 | 弹出层 |
| --- | --- |
| 一行：`DeepSeek 余额 ¥85.66` + 刷新按钮。折叠成 56px 轨道时退化为图标，数字显示在其 Tooltip 里。 | 余额卡（总余额 / 充值余额 / 赠送余额 / 币种 / 账户状态 / 数据时间 / 数据来源）、7/30 天窗口的每日 Token 折线图与每日估算费用柱状图、按模型明细表，以及「打开用量页」按钮。 |

## 显示什么，以及数字从哪来

| 数字 | 来源 | 是否为权威值 |
| --- | --- | --- |
| 余额 | `GET https://api.deepseek.com/user/balance`，在宿主侧请求，缓存 60 秒 | 是——这是官方接口 |
| 用量 / 费用 | 由**本机** DSH 会话日志（`assistant/message` 与 `assistant/attempt` 的 usage）聚合，按官方峰谷单价表计价 | **否——这是本地估算值** |

用量一侧被明确标注为估算值，且面板上写明了它的统计范围，原因是 **DeepSeek 并未提供用量 API**：
`api.deepseek.com` 只暴露了一个账户接口（`/user/balance`），而平台自身的用量接口需要**浏览器登录
令牌**，API key 无法代替。该结论背后的实测记录见
[`docs/usage-data-sources.md`](docs/usage-data-sources.md)。

安装前有两点值得了解：

- **估算只覆盖本机的 DSH 会话日志**（本机所有工作区）。同一账号在其它电脑、网页版或任何其它工具
  产生的消耗都不会被计入，因此这里的数字可能低于平台账单。这一点已写在面板本身上。实测例子：
  某天会话日志从当地时间 15:05 才开始，估算 ¥5.02，而平台账单为 ¥13.60；另一天日志完整，估算
  ¥30.55，平台 ¥31.28。
- **API key 全程不会进入浏览器。** key 每次操作都通过宿主的凭据库解析，且只用于发往
  `api.deepseek.com` 的 `Authorization` 请求头。浏览器半的代码里既没有密钥，也不含上游域名
  （由 `tests/ui-row.test.mjs` 断言）。

## 安装

```sh
dsh plugin add github:The-five-stooges/dsh-deepseek-usage
```

`dsh plugin` 会在 profile 目录内转发给 pnpm，随后对齐 `dsh.profile.bundles`；本包因为声明了
`dsh.bundle` 而被识别为插件层。

**没有构建步骤**：`lib/client.js` 与 `lib/index.js` 都是已提交的生成产物，且本包没有声明
`prepare` 脚本。因此从 git 源码安装**不需要** `allowBuilds` 授权——pnpm 的构建脚本闸门没有东西
可拦。

装好后需要**重启一次宿主进程**（宿主半在启动期合成），然后刷新页面。

每次发布都附带预构建 tarball，也可以直接用它安装：

```sh
dsh plugin add https://github.com/The-five-stooges/dsh-deepseek-usage/releases/latest/download/dsh-deepseek-usage.tgz
```

需要凭据库（或启动环境）里存在 `DEEPSEEK_API_KEY`。未配置 key 时，该行会显示明确的「未配置」状态，
而不是报错。

### 可选配置

```yaml
- id: dsh-deepseek-usage
  config:
    timeoutMs: 10000   # 上游余额请求超时（默认 10000）
    ttlMs: 60000       # 成功快照缓存 TTL（默认 60000；force=1 绕过）
```

## HTTP 接口

两条路由都由宿主半在会话自身的 origin 上提供：

| 路由 | 成功响应 | 失败响应 |
| --- | --- | --- |
| `GET /api/dsh-deepseek-usage/balance[?force=1]` | `{ ok:true, currency, totalBalance, grantedBalance, toppedUpBalance, isAvailable, fetchedAt, cached }` | `{ ok:false, error:{ code, message, httpStatus? } }`，并带真实状态码 |
| `GET /api/dsh-deepseek-usage/usage[?days=N]` | `{ ok:true, requestedDays, days, generatedAt, truncated, totals }` | 同样的 envelope |
| `GET /api/dsh-deepseek-usage/health`（别名 `/healthz`） | 插件名、版本、台账可用性 | — |

`tests/contract.test.mjs` 是这些响应形状的唯一事实来源；改响应就要同时改它。

## 已知限制

- 用量估算会漏掉一切未经过本机 DSH 会话日志的调用（见上文）——这是它与平台账单可能不一致的
  主要原因。
- 插件无法内嵌 `platform.deepseek.com/usage`：该页面会发送
  `Content-Security-Policy: frame-ancestors 'none'`，因此弹出层改为外链打开。
- 柱状图显示的是依据公开单价表推算的估算费用，平台账单始终为权威。
- 引擎版本下限：`dsh >= 0.1.5-rc.1`。

## 开发

架构、冻结的内部契约、浏览器包如何由 `src/client/*.mjs` 合成、验收文档，以及如何跑测试套件
（222 个测试）见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。

```
lib/        生成的浏览器半 + 宿主入口
src/host/   余额读取、会话日志台账、路由、cordis 插件
src/client/ row、service、chart、modal —— 合成进 lib/client.js
tests/      contract、host 与 UI 测试套件
tools/      UI 套件驱动的真实浏览器布局探针
docs/       验收记录与实测设计说明
```

```sh
node --test                              # 全量测试
node scripts/compose-client.mjs --check  # lib/client.js 是否与 src/client 同步
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。本项目与 DeepSeek 官方无隶属关系。
