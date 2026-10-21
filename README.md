# dsh-bocha-tavily-router

Bocha（博查）+ Tavily 的搜索路由插件，为 DeepSeek Harness 的 `web_search` 提供中文/英文双引擎。

## 行为

在 `ctx.web` 上注册 provider id `router`：

| 查询 | 走向 |
|---|---|
| 含中日韩字符 | 博查 `POST https://api.bocha.cn/v1/web-search` |
| 其他 | Tavily `POST https://api.tavily.com/search` |
| 以 `[cn]` 开头 | 强制博查（前缀不会发给引擎） |
| 以 `[intl]` 开头 | 强制 Tavily |
| 首选失败或零结果 | 自动回落到另一家 |

## 凭据

按顺序解析：`ctx.credentials` → 环境变量 → `~/.dsh/.credentials.yaml`。

需要两个引用：

```yaml
BOCHA_API_KEY: sk-...
TAVILY_API_KEY: tvly-...
```

## 安装

```bash
dsh plugin --profile <profile> add <本包>
```

或从 DSH 插件页「添加插件」填入包名 / `github:user/repo` / tarball 地址。

安装后需重启：Desktop profile 只在启动时装配补丁。

## 注意

- base 组合会把 `web.searchProvider` 固定为 `deepseek-official`，本包的 `cordis.patch.yml` 会覆盖成 `router`。
- 停用或卸载本插件前，请先删掉 profile `cordis.patch.yml` 里 `- id: web` 那段，否则搜索会报 `configured web provider "router" is not registered`。
- 本地目录 / tarball 形式安装在部分 DSH Desktop 版本上不会被 apply（见 `NOTES.md`），建议走 npm 或 `github:` 源。

## 排查

插件在加载时会向 `~/.dsh/plugins/router-boot.log` 追加：

- `module evaluated` — 模块被 import
- `apply called; ...` — Cordis 调用了 apply
- `registered provider router` — provider 注册成功

三者缺一，就能定位卡在哪一步。

## License

MIT
