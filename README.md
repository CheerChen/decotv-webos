<!-- markdownlint-disable MD033 MD041 -->

<p align="center">
  <img src="assets/icons/icon-large.png" alt="DecoTV" width="120" />
</p>

<h1 align="center">DecoTV for webOS</h1>

<p align="center">
  <strong>面向 LG webOS 电视的 <a href="https://github.com/Decohererk/DecoTV">DecoTV</a> 原生客户端</strong><br />
  豆瓣目录 · 多源测速优选 · 遥控器全导航 · 硬件解码播放
</p>

<p align="center">
  <b>中文</b>
  &nbsp;·&nbsp;
  <a href="README.en.md"><b>English</b></a>
</p>

<p align="center">
  <a href="https://github.com/CheerChen/decotv-webos/stargazers"><img src="https://img.shields.io/github/stars/CheerChen/decotv-webos?style=flat&logo=github" alt="Stars" /></a>
  <a href="https://github.com/CheerChen/decotv-webos/releases"><img src="https://img.shields.io/github/v/release/CheerChen/decotv-webos?include_prereleases&label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/webOS-TV-a50034?logo=lg&logoColor=white" alt="webOS" />
  <img src="https://img.shields.io/badge/root-not%20required-2ea44f" alt="No root" />
  <img src="https://img.shields.io/badge/DecoTV-server%20required-blue" alt="DecoTV server" />
  <img src="https://img.shields.io/badge/language-JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License" /></a>
</p>

---

## 项目展示

| 首页 | 分类浏览 | 播放记录 |
| :---: | :---: | :---: |
| ![首页](assets/screenshots/home.webp) | ![分类](assets/screenshots/search.webp) | ![播放记录](assets/screenshots/library.webp) |

| 详情 · 多源测速 | 播放器 · 换源 | 设置 |
| :---: | :---: | :---: |
| ![详情](assets/screenshots/detail.webp) | ![播放](assets/screenshots/player.webp) | ![设置](assets/screenshots/settings.webp) |

---

## 这是什么

本仓库是 **[DecoTV](https://github.com/Decohererk/DecoTV)** 在 **LG webOS 电视**上的专用客户端（非浏览器套壳）。

- 对接已部署的 DecoTV 服务端：豆瓣目录、分类筛选、聚合搜索、多源测速与播放
- 为 TV UI 与遥控器 D-pad 设计焦点导航
- 使用 webOS 原生 `<video>` **硬件解码 HLS**，不依赖 HLS.js
- **不需要 root**；开发者模式或 [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) 即可安装

服务端本身是空壳，**无内置片源**。片源需在 DecoTV 服务端自行配置。

当前版本为 `0.5.0`，详见 [Releases](https://github.com/CheerChen/decotv-webos/releases)。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 首页海报墙 | 继续观看置顶；热门电影、剧集、动漫、综艺分行展示 |
| 海报加载 | 由 webOS JS Service 请求，带缓存、失败回退与可信域校验 |
| 分类浏览 | 顶栏进入热门与精选：电影、剧集、动漫、综艺、纪录片；可按地区 / 类型 / 年份等筛选 |
| 多源测速优选 | 并发检测全部播放源，按画质、吞吐与启动时延排序；测速在后台继续，期间可随时开始播放 |
| 详情页直达播放 | 点击剧集或播放源即开始播放；剧集列表在播放源上方，上次观看的剧集高亮标记 |
| 播放失败换源 | 当前源失败后选择剩余源中实测最优者，并从中断位置继续；播放中可打开换源侧栏手动切换 |
| 进度记忆 | 按「标题 + 年份」记进度，换源不丢断点；播放按钮显示继续播放集数 |
| 片尾自动跳集 | 播放器内标记一次片尾，本剧每集播到该位置自动进入下一集（最后一集除外）；标记按距结尾偏移记录，仅保存在本机 |
| 收藏与播放记录 | 登录后与服务端双向同步，跨设备可见；`public` 模式或未登录时存在电视本地 |
| 设置分区 | 左侧可操作（切换服务器、清空记录、语言），右侧只读（本机信息 + 服务器信息） |
| 中英界面 | 跟随电视语言（非中文一律英文），可在设置中手动切换；片源与分类等服务端内容仍为中文 |
| 遥控器导航 | D-pad / OK / 返回全覆盖；数字键 `0–9` 快速切换导航；几何焦点引擎 |
| 播放器控制 | 上一集 / 下一集按钮与频道 +/− 键；↑ 打开剧集列表；左右键 10 秒快进快退；播放条与侧栏面板 5 秒无操作自动隐藏，暂停时保持显示 |
| 播放器 OSD | 实时分辨率、缓冲与进度条片尾标记；支持选集、换源和中插广告自动跳过 |
| 硬件解码 | 系统原生 HLS，无 HLS.js |

### 与 PC 端的差异（必读）

| 项目 | PC / 浏览器 DecoTV | 本客户端 (webOS) |
| --- | --- | --- |
| 认证 | 账号密码等模式 | 同左；`public` 模式服务器可匿名浏览 |
| 收藏 / 进度 | 与服务端同步 | 同左，需登录账号；未登录时仅存本机 |
| 片源配置 | 服务端后台 | 同左——客户端不配置片源 |
| 播放解码 | HLS.js / ArtPlayer 等 | 系统原生硬件解码 |

**账号模式支持：** `0.5.0` 起支持 password 账号模式，`0.4.2` 仅支持 `public` 模式。登录后收藏与播放记录随服务端跨设备同步；为保持会话而引入的 JS Service 同时接管了海报加载（缓存与失败回退，`public` 模式同样受益）。

**会话如何保持：** 应用从 `file://` 加载，请求服务端属于跨站。电视 WebView 不会保存 `SameSite=Lax` 的会话 Cookie，网页代码也无法读写 `Cookie` 请求头。IPK 内附带一个 webOS JS 服务，在 WebView 之外的独立 Node 进程中发起请求，由它保存并回填 Cookie，账号会话因此得以保持。

**`public` 模式的限制：** 该模式下 `/api/login` 不下发 Cookie，客户端无法建立账号会话，`/api/favorites` 与 `/api/playrecords` 返回 401。浏览、搜索与播放不受影响，收藏与播放记录则退回电视本地存储，不跨设备同步。需要同步时，在服务端去掉 `NEXT_PUBLIC_AUTH_MODE=public` 并配置 `USERNAME` 与 `PASSWORD`。

**凭据存储：** 账号模式下首次连接会要求登录一次，用户名与密码以明文保存在电视的 `localStorage`，用于会话过期后静默重建。这是面向单人自有电视的取舍；多人共用或不接受该风险时，请勿在设置中保存账号。

---

## 要求

1. **LG webOS 电视**（开发者模式或已装 Homebrew Channel；root 非必须）
2. **已部署的 DecoTV 服务**（`public` 模式可匿名使用；收藏与播放记录同步需账号模式）
3. 电视与服务端网络可达（同局域网或可访问的域名 / IP）

服务端部署参见：[DecoTV](https://github.com/Decohererk/DecoTV)

---

## 安装

### 方式 A — Homebrew Channel（规划中）

上架 [webosbrew/apps-repo](https://github.com/webosbrew/apps-repo) 后，可在电视 Homebrew Channel 中搜索安装。

### 方式 B — 开发者模式 / 手动 sideload

从 [Releases](https://github.com/CheerChen/decotv-webos/releases) 下载已构建 IPK。

**开发者模式：** 使用 LG 官方 `ares-install` 安装 IPK。

**已 root 电视（opkg 路径，绕过 appinstalld 解包失败）：**

将下方 `TV` 换成电视的局域网 IP，或本机 `~/.ssh/config` 中已配置的主机名。

```bash
scp com.cheerchen.decotv_*_all.ipk root@TV:/tmp/decotv.ipk
ssh root@TV 'opkg --add-dest developer:/media/developer install -d developer /tmp/decotv.ipk && \
          mkdir -p /media/developer/apps/usr/palm/applications/ && \
          cp -a /media/developer/usr/palm/applications/com.cheerchen.decotv \
                /media/developer/apps/usr/palm/applications/'
ssh root@TV 'sync; reboot'   # 首次安装需重启，sam 才会注册应用
```

也可本地打包：

```bash
./scripts/package.sh
# → com.cheerchen.decotv_<version>_all.ipk
```

---

## 快速开始

1. 安装并打开 **DecoTV**
2. 输入服务端地址，例如 `http://192.168.1.10:3000`
3. 账号模式服务器会要求登录一次，之后自动重建会话；`public` 模式可直接跳过
4. 首页用方向键浏览，OK 进入详情
5. 详情页自动测速并优选播放源；失败时自动或手动换源
6. 播放器支持上一集 / 下一集、片尾标记与自动跳集
7. 收藏与播放记录在「收藏」页；本机信息与服务器信息在「设置」页右侧只读区

---

## 技术栈

| 层级 | 选型 |
| --- | --- |
| 运行时 | webOS Web App (WAM / Chromium) |
| 语言 | 原生 ES modules，无构建步骤 |
| UI | 焦点引擎 + 屏幕路由 |
| 播放 | 原生 `<video>` + UMS 硬件解码 |
| 服务协议 | DecoTV / LunaTV 兼容 HTTP API |
| 会话保持 | 随 IPK 附带的 webOS JS 服务（Node 进程，独立于 WebView） |
| 本地数据 | `localStorage`（服务器地址、登录凭据、收藏、播放记录与片尾标记） |
| 打包 | `ares-package` → IPK |

---

## 开发

```bash
# 单元测试
npm test

# 热更新（已 root / 已装应用）：推送前端源码后 CDP 刷新，无需重打包
# JS Service 或 appinfo.json 改动仍需重新打包安装
# 将 TV 换成电视局域网 IP 或 SSH 主机名
scp -r js css index.html root@TV:/media/developer/apps/usr/palm/applications/com.cheerchen.decotv/
# CDP 隧道示例：ssh -f -N -L 9977:localhost:9998 root@TV
uv run scripts/cdp_reload.py
```

应用 ID：`com.cheerchen.decotv`。

可选调试脚本：`scripts/cdp_eval.py`、`scripts/cdp_reload.py`、`scripts/cdp_screenshot.py`。

---

## 相关项目

- [DecoTV](https://github.com/Decohererk/DecoTV) — 服务端 / Web 端
- [webosbrew](https://github.com/webosbrew) — webOS 社区工具与应用仓库
- [youtube-webos](https://github.com/webosbrew/youtube-webos)
- [jellyfin-webos](https://github.com/jellyfin/jellyfin-webos)

---

## 免责声明

- 本项目为客户端壳，**不提供、不内置任何影视资源**
- 使用者需自行部署 DecoTV 并合法配置数据源，后果自负
- 请勿在未获授权的公开渠道将本项目与盗版资源捆绑宣传

---

## License

[MIT](LICENSE)。上游 DecoTV 与第三方依赖遵循各自许可证。

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=CheerChen/decotv-webos&type=Date)](https://star-history.com/#CheerChen/decotv-webos&Date)
