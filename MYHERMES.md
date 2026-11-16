# MyHermes

本仓库是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的 fork，**只改桌面端 UI/UX**，不动执行逻辑（agent、工具、网关、渠道、模型路由一行没改）。

`myhermes` 分支上的成品：左侧图标栏 + 会话列表 + 聊天区三栏布局、标题栏内的「会话 / 机器人」切换、按渠道过滤列表、内置默认外观（气泡配色、消息标记、底部余额与耗时）。

## 装

```bash
git clone -b myhermes https://github.com/lessismoretest/hermes-agent.git
cd hermes-agent
bash scripts/build-myhermes.sh
```

脚本会：校验 Node ≥ 26 → `pnpm run pack` → 拷成 `/Applications/MyHermes.app` → 改 bundle id 与显示名 → 删掉官方更新源 → ad-hoc 签名。

装完打开 `/Applications/MyHermes.app` 即可。**首次启动**会把内置外观（`Resources/default-profile/` 里的皮肤与桌面插件）写进 `~/.hermes/`，已有文件不覆盖——所以下载即所见，不需要导入任何 CSS。

要求：macOS、Node ≥ 26、pnpm。仓库必须在 `myhermes` 分支上（脚本会检查）。

## 和上游的差异

```
13 files changed, ~1000 insertions(+), 24 deletions(-)
```

集中在四处：

| 文件 | 改了什么 |
|---|---|
| `apps/desktop/src/app/chat/sidebar/index.tsx` | 图标栏 + 列表列 + 底部条的三段式布局；渠道过滤；搜索框下的「新建会话」；图标栏的 i18n 文案 |
| `apps/desktop/src/store/layout.ts` | `$railScope`（会话 / 定时任务 / 某渠道），持久化 |
| `apps/desktop/src/components/pane-shell/tree/renderer/zone-header-layout.ts` | 侧栏的面板 tab 与窗口控件同一行 |
| `apps/desktop/src/app/messaging/platform-icon.tsx` + `src/assets/feishu.png` | 飞书官方图标；API 用「消息+代码」符号 |
| `apps/desktop/electron/default-profile-seed.ts` + `resources/default-profile/` | 首次启动把内置皮肤与桌面插件铺进 `~/.hermes` |

## 跟上游

```bash
git fetch upstream            # 若没配：git remote add upstream https://github.com/NousResearch/hermes-agent.git
git rebase upstream/main
```

冲突几乎只会落在 `sidebar/index.tsx`。上游大改版后，先 rebase 再重新 `build-myhermes.sh`。

## 不含什么

- 不含任何密钥、账号、本机路径。
- 不含皮肤里内嵌的个人头像（发布版把头像规则去掉了，其余外观一致）。
- 不做第三方插件的兼容承诺：桌面插件与皮肤贴的是宿主内部结构，上游改版后可能需要跟着改。

## 许可

上游是 MIT，本 fork 沿用 MIT（见 `LICENSE`）。
