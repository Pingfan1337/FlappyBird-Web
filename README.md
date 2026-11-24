<div align="center">
  <img src="assets/icons/icon-180.png" width="90" alt="Flappy Bird Web 图标" />

# Flappy Bird · Web

**将 [FlappyBird-arm64-Metal-iOS27](https://github.com/Pingfan1337/FlappyBird-arm64-Metal-iOS27) 完整移植到现代网页浏览器：1:1 原版 1.2 玩法逻辑、单 Draw Call WebGL2 实例化渲染、Web Audio 三通道低延迟音效、多端全自适应与全输入方式支持。**

[![Test and Deploy to GitHub Pages](https://github.com/Pingfan1337/FlappyBird-Web/actions/workflows/deploy.yml/badge.svg)](https://github.com/Pingfan1337/FlappyBird-Web/actions/workflows/deploy.yml)
![Renderer](https://img.shields.io/badge/Renderer-WebGL2%20%2B%20Canvas2D-60a5fa)
![Audio](https://img.shields.io/badge/Audio-Web%20Audio%20API-22c55e)
![Dependencies](https://img.shields.io/badge/Dependencies-Zero-8b5cf6)
![PWA](https://img.shields.io/badge/PWA-Offline%20Ready-f59e0b)

**[立即在线游玩 (GitHub Pages)](https://pingfan1337.github.io/FlappyBird-Web/)** · [架构对照](#与原-ios-仓库的架构对照) · [操控指南](#全端操控指南) · [渲染与物理原理](#核心技术实现) · [本地运行与测试](#本地运行与测试) · [云端部署](#云端部署指南)

</div>

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [与原 iOS 仓库的架构对照](#与原-ios-仓库的架构对照)
- [全端操控指南](#全端操控指南)
- [核心技术实现](#核心技术实现)
  - [1. 1:1 原版模拟与数值一致性](#1-11-原版模拟与数值一致性)
  - [2. 固定 60Hz 物理与高刷线性插值](#2-固定-60hz-物理与高刷线性插值)
  - [3. 单 Draw Call WebGL2 实例化渲染](#3-单-draw-call-webgl2-实例化渲染)
  - [4. 多端全屏自适应布局](#4-多端全屏自适应布局)
  - [5. 全输入防抖与亚帧锁存](#5-全输入防抖与亚帧锁存)
  - [6. Web Audio 三通道中断音频引擎](#6-web-audio-三通道中断音频引擎)
  - [7. 离线 PWA 与本地持久化](#7-离线-pwa-与本地持久化)
- [目录结构与模块说明](#目录结构与模块说明)
- [本地运行与测试](#本地运行与测试)
- [资源处理工具](#资源处理工具)
- [云端部署指南](#云端部署指南)
- [已知限制与说明](#已知限制与说明)
- [致谢与权利声明](#致谢与权利声明)

---

## 项目简介

本项目是 [Pingfan1337/FlappyBird-arm64-Metal-iOS27](https://github.com/Pingfan1337/FlappyBird-arm64-Metal-iOS27) 的完整浏览器移植版。原项目将 32 位 Flappy Bird **1.2** 的 ARMv7 反编译玩法规则以 C++17 + Metal + AVFoundation 重建为现代 iOS 原生应用；本仓库在此基础上将全部游戏逻辑、渲染管线、音频调度、高刷帧节奏统计与多端交互完整迁移至零第三方依赖的原生 Web 技术栈（ES Modules + WebGL2 + Web Audio API + Pointer Events + Service Worker）。

在开发阶段，我们直接编译原 iOS 仓库中的 C++ 核心头文件（`OriginalBird.hpp`、`OriginalGame.hpp`、`Presentation.hpp`）运行 977 帧完整游戏流程，并与 JavaScript 移植版进行逐帧、逐字段、逐图元比对校验，确保核心规则、物理抛物线、碰撞判定、管道生成与得分动画完全一致。

---

## 核心特性

| 维度 | 实现细节 |
|---|---|
| **原版规则还原** | 完整移植 1.2 菜单、准备起飞、点击振翅、管道循环、得分、闪白震屏、结算面板、铜/银/金/白金奖牌与 `NEW` 标志 |
| **零依赖轻量体积** | 纯原生 ES Modules，无打包器、无框架运行时，全部 JS 代码约 58 KB，资源总计约 588 KB |
| **高效率渲染** | WebGL2 单次 `drawArraysInstanced` 渲染整帧（每图元 40 字节，热路径零 GC 分配），不支持 WebGL2 时自动回退 Canvas 2D |
| **高刷帧率独立** | 物理严格锁定 60Hz，渲染跟随显示器原生刷新率（60Hz / 120Hz ProMotion / 144Hz / 240Hz）进行连续线性插值 |
| **多端全屏自适应** | 竖屏上下延展天空与地面并适配刘海/灵动岛安全区；横屏/桌面端横向无缝平铺天空、城市与地面，居中裁剪管道区 |
| **全输入友好** | 统一支持**键盘**、**触摸屏**、**鼠标**、**触控板**与**游戏手柄**，覆盖悬停反馈、亚 16ms 快点锁存、防长按连跳与防触控板误滑返回 |
| **低延迟原版音效** | 无损转换原版 5 个 `.caf`/`.aif` 为标准 44.1kHz PCM `.wav` 并裁剪尾部静音，Web Audio 三通道中断调度播放 |
| **性能诊断读数** | 右上角实时显示实际 `FPS` 与最近 256 帧的 `P99` 帧间隔（ms），支持快捷键或双指双击切换 |
| **离线可用 PWA** | 内置 `manifest.webmanifest` 与 `sw.js` 缓存全部运行资源，支持添加到桌面/主屏幕离线畅玩 |

---

## 与原 iOS 仓库的架构对照

| 子系统 | 原 iOS 实现 (`FlappyBird-arm64-Metal-iOS27`) | 本 Web 移植版 (`FlappyBird-Web`) |
|---|---|---|
| **核心玩法与物理** | `src/Core/OriginalBird.hpp`、`OriginalGame.hpp` | `js/game.js`（`Math.fround` + `Math.trunc` 严格对齐 binary32 与整数截断） |
| **显示时钟与布局** | `src/Core/Presentation.hpp`、`FramePacingStats.hpp` | `js/presentation.js`（`PresentationClock`、`ViewLayout`、`FramePacingStats`、`composeFrame`） |
| **GPU 着色器与几何** | `src/App/Shaders.hpp`、`MetalGeometry.hpp` | `js/renderer.js`（GLSL ES 3.00 实例化着色器 + 预乘 Alpha 混合 + Canvas 2D 回退） |
| **图集索引** | `resources/atlas.txt` + 运行时解析 | `tools/gen-atlas.mjs` 预编译为 `js/atlas.js` 静态 `Int16Array` 查找表 |
| **音频引擎** | `src/App/AudioBackend.hpp`（`AVAudioEngine` + 3 个 `AVAudioPlayerNode`） | `js/audio.js`（`AudioContext({ latencyHint: 'interactive' })` + 3 个中断槽位） |
| **用户输入** | `UIView` `touchesBegan/Moved/Ended` + 双指双击手势 | `js/input.js`（Pointer Events + Keyboard + Trackpad + Gamepad + 双指双击手势） |
| **系统外壳与存储** | `UIViewController`、`CAMetalDisplayLink`、`NSUserDefaults` | `js/main.js`、`index.html`、`requestAnimationFrame`、`localStorage`、Service Worker |

---

## 全端操控指南

### 键盘（桌面端 / iPad 外接键盘）

| 按键 | 作用 | 说明 |
|---|---|---|
| `Space` / `↑` / `W` / `J` / `Enter` | **振翅 / 开始 / 重开** | 游戏中按一次振翅一次（忽略长按连发 `e.repeat`）；在菜单或结算界面按压会按下 `PLAY` 按钮并在松开后进入游戏 |
| `P` / `Esc` | **暂停 / 继续** | 仅在飞行过程中可暂停；若当前打开了弹窗则优先关闭弹窗 |
| `M` | **静音开关** | 状态自动保存至本地 `localStorage` |
| `F` / `F3` | **显示/隐藏 FPS & P99** | 切换右上角性能读数 |
| `R` | **快速重开** | 非菜单且非暂停状态下直接淡出重新开始一局 |

### 触摸屏（手机 / 平板 / 触控屏笔记本）

- **单指点击屏幕任意位置**：在菜单/结算页点击 `PLAY`、排行榜或 `RATE` 按钮；在准备页与飞行中任意位置零延迟起飞或振翅。
- **双指双击**：快速用两根手指轻点屏幕两次，切换右上角 `FPS | P99` 显示（还原原 iOS 端隐藏手势）。
- **防误触设计**：已禁用双击放大、长按文本选中与弹出菜单（`touch-action: none`、`user-select: none`）。

### 鼠标与触摸板（macOS Trackpad / Windows 精确触控板）

- **左键点击 / 触控板轻点（Tap-to-Click）**：任意区域点击即振翅；悬停在可交互像素按钮上时鼠标指针自动变为手型（`pointer`）。
- **亚帧点击锁存**：即使触控板轻点在不到 16.6ms（单物理帧）内完成按下与抬起，输入控制器也会自动锁存至下一个 60Hz 逻辑帧，确保 UI 按钮点击**永不吞键**。
- **手势隔离**：页面配置 `overscroll-behavior: none` 并拦截画布 `contextmenu`，防止双指轻扫触发浏览器前进/后退或弹出右键菜单。

### 游戏手柄（Gamepad API）

- 在浏览器帧循环中自动检测已连接手柄：按 **A / Cross 键**、**方向键上（D-Pad Up）** 或 **Start 键** 即可开始或振翅。

---

## 核心技术实现

### 1. 1:1 原版模拟与数值一致性

JavaScript 默认所有数字均为 IEEE 754 `float64`，而原版 Flappy Bird 1.2（ARMv7）以及重建 C++ 代码中的物理速度、重力、角速度与缓动曲线均采用 **binary32 (`float`)** 运算与 C 风格向零整数截断：

- `js/game.js` 对所有浮点中间值使用 `Math.fround()`，对所有整型坐标/角度/分数强制使用 `Math.trunc()`。
- 完整保留原版 Marsaglia MWC 伪随机数生成器（`randomW` / `randomZ`）、50 槽位 30ms 步进计时器队列、与屏幕可见区联动的 `flapCeiling` 顶部飞行限制（可完全飞出视野但限制无限上升，自然回落可再次振翅）以及稳定 `entity` 编号（避免管道队列旋转时插值错配）。
- `tests/trace.test.mjs` 会直接调用 `clang++` 编译原仓库头文件，验证 977 帧内每一帧状态、绘制列表与插值输出 100% 一致。

### 2. 固定 60Hz 物理与高刷线性插值

```text
显示器刷新 (60Hz / 120Hz / 144Hz / 240Hz)
   │
   ▼ requestAnimationFrame(nowMs)
PresentationClock.advance(nowSec)
   ├─ 累积 dt（上限钳制 0.1s 防止切后台雪崩）
   ├─ 每满 1/60s 步进一次 game.step()（记录上一帧 previousDraws）
   └─ 计算余数比例 blend = remainder / (1/60) ∈ [0, 1]
          │
          ▼ composeFrame(game, blend, layout, quads)
     对同一实体的坐标、旋转角、透明度做线性插值：
     pos = prev + (curr - prev) * blend
```

- 与原版 `Presentation.hpp` 一致，渲染层始终处于“上一逻辑帧到当前逻辑帧”之间，因此即使遇到浏览器 `rAF` 偶尔出现 `0 tick / 2 tick` 边界抖动，视觉运动依然保持平滑线性连续。
- 地面循环（`landX` 从 `-23` 跳回 `0`）在插值时会识别周期跳变并补偿 `-24`，避免地面倒退闪烁。

### 3. 单 Draw Call WebGL2 实例化渲染

为在浏览器端获得最高渲染效率与最低 CPU 开销，`js/renderer.js` 采用 **WebGL2 Instanced Rendering**：

- **每图元仅 10 个 float（40 字节）**：`aRect (x, y, w, h)`、`aUV (u, v, uw, vh)`、`aRotAlpha (angleDeg, alpha)`。
- **GPU 端展开与旋转**：顶点着色器通过 `gl_VertexID`（0..3 的 `TRIANGLE_STRIP`）展开四角并完成旋转与 NDC 坐标投影，JS 主线程不执行三角函数与 6 顶点展开。
- **零垃圾回收**：每帧直接写入预分配的 `Float32Array`（容量 256 图元），通过单次 `gl.bufferSubData` + `gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n)` 完成整帧绘制。
- **混合模式对齐 Metal**：纹理上传启用 `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`，混合模式设为 `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`，采样器使用 `LINEAR` + `CLAMP_TO_EDGE` 且关闭 Mipmap，彻底杜绝旋转精灵边缘黑边与邻接图集渗色。
- **自动降级**：若运行环境禁用了 WebGL2，自动无缝切换至 `Canvas 2D` 渲染路径。

### 4. 多端全屏自适应布局

`ViewLayout.make(width, height, safeTop, safeBottom)` 自动计算缩放比例 `scale = min(width / 288, height / 512)`：

- **竖屏手机 / 平板（高宽比 > 512/288）**：等比保持 `288` 宽度居中，上下延展单像素纯色天空与沙地，并自动把上方管道柱身延伸至屏幕最顶端；同时通过隐藏探针 `#safe-probe` 读取 CSS `env(safe-area-inset-top/bottom)`，避开 iOS 灵动岛与底部手势条。
- **横屏 / 桌面宽屏（`layout.width > 288.5`）**：
  - 全屏铺满 `100%` 浏览器视口，无黑边。
  - 天空背景 `bg_day` / `bg_night` 横向无缝平铺（奇数瓦片水平镜像并内缩半个 texel 消除线性采样接缝）。
  - 草地 `land` 利用其原生精确的 `24px` 周期特性，截取内部 `288px`（`12 × 24px`）子矩形连续平铺，在 `LINEAR` 过滤下实现零透明缝隙的无缝滚动。
  - 管道严格裁剪至中央 `[offsetX, offsetX + 288]` 核心舞台，两侧叠加柔和半透明暗角遮罩，既保证管道不会在屏幕外侧凭空出现/消失，又允许鼠标或手指在全屏任意区域点击操控。

### 5. 全输入防抖与亚帧锁存

- 使用统一的 **Pointer Events** 处理触屏、手写笔、鼠标和触控板，避免 `touchstart` + `mousedown` 导致的双倍触发与移动端 300ms 点击延迟。
- 所有 HTML HUD 按钮（暂停、静音、帧率）在点击后立即执行 `.blur()`，防止焦点残留在按钮上导致后续按 `Space` 振翅时误触发按钮。
- 针对高频轻点引入 `touchLatch` / `virtualLatch` 单帧锁存机制，确保 `pointerdown` 与 `pointerup` 即使在同一帧间隔内完成，也能稳定触发一次按钮按下与释放事件。

### 6. Web Audio 三通道中断音频引擎

原 iOS 仓库使用 `AVAudioEngine` + 3 个 `AVAudioPlayerNode` 并开启 `AVAudioPlayerNodeBufferInterrupts`。Web 端 `js/audio.js` 完整复刻这一调度策略：

- 启动时并行拉取 5 个 `.wav` 文件并在用户首次交互（`pointerdown` / `keydown`）时即时解锁 `AudioContext({ latencyHint: 'interactive' })`。
- **3 个独立中断声道**：
  - 通道 0：`sfx_point.wav`（事件 9，增益 `0.2`）与 `sfx_hit.wav`（事件 12，增益 `1.0`）
  - 通道 1：`sfx_swooshing.wav`（事件 10，增益 `1.0`）
  - 通道 2：`sfx_die.wav`（事件 11，增益 `1.0`）与 `sfx_wing.wav`（事件 13，增益 `1.0`）
- 同一通道新音效开始前自动停止前一个 `AudioBufferSourceNode`，避免快速振翅或撞击时声音混叠刺耳。

### 7. 离线 PWA 与本地持久化

- `localStorage` 本地持久化最高分（`flappy12_best`）、累计局数（`flappy12_games`）、静音状态（`flappy12_muted`）和 FPS 开关（`flappy12_fps`）。
- Service Worker（`sw.js`）在首次访问时预缓存全部 JS、图集、图标与音效资源，支持断网游玩及移动端“添加到主屏幕”全屏独立运行。

---

## 目录结构与模块说明

```text
FlappyBird-Web/
├── index.html                  # 页面入口、自适应样式、Safe-Area 探针、HUD 与弹窗 DOM
├── manifest.webmanifest        # PWA 应用清单
├── sw.js                       # Service Worker 离线资源缓存
├── .nojekyll                   # 禁用 GitHub Pages Jekyll 处理
├── NOTICE.md                   # 权利归属与范围说明
├── README.md                   # 项目文档
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions 自动测试并部署至 GitHub Pages
├── assets/
│   ├── atlas.png               # 原版 1024×1024 RGBA 像素精灵图集
│   ├── sfx_die.wav             # 44.1kHz 16-bit PCM（由原 .caf 无损转换）
│   ├── sfx_hit.wav             # 44.1kHz 16-bit PCM（由原 .caf 无损转换）
│   ├── sfx_point.wav           # 44.1kHz 16-bit PCM（由原 .aif 无损转换）
│   ├── sfx_swooshing.wav       # 44.1kHz 16-bit PCM（由原 .caf 无损转换并裁剪尾部静音）
│   ├── sfx_wing.wav            # 44.1kHz 16-bit PCM（由原 .caf 无损转换）
│   └── icons/                  # 180 / 192 / 512 应用与 PWA 图标
├── js/
│   ├── atlas.js                # 由 tools/gen-atlas.mjs 生成的精灵索引与矩形表
│   ├── game.js                 # OriginalBird、OriginalGame、Tween、Button、DrawList
│   ├── presentation.js         # PresentationClock、ViewLayout、FramePacingStats、composeFrame
│   ├── renderer.js             # WebGL2 实例化单 Draw Call 渲染器 + Canvas 2D 回退
│   ├── audio.js                # Web Audio API 预解码与三通道中断播放器
│   ├── input.js                # 触摸 / 鼠标 / 触控板 / 键盘 / 手柄统一输入控制器
│   └── main.js                 # 主循环、Safe-Area 监听、本地存储、HUD 与弹窗逻辑
├── tests/
│   ├── unit.test.mjs           # 飞行上限、60/120/144/240Hz 时钟、P99 统计、亚帧锁存与黄金回放测试
│   └── trace.test.mjs          # 编译原 iOS C++ 头文件并逐帧比对 977 帧状态与渲染输出
└── tools/
    ├── atlas.txt               # 原版精灵图集坐标清单
    ├── gen-atlas.mjs           # 从 atlas.txt 生成 js/atlas.js
    └── trim.mjs                # 无损裁剪 WAV 尾部数字静音的工具脚本
```

---

## 本地运行与测试

本项目无构建步骤、无 npm 依赖，任意静态 HTTP 服务器均可直接托管运行（因使用 ES Modules 与 `fetch`，请勿直接用 `file://` 协议打开 `index.html`）：

```bash
# 1. 克隆仓库
git clone https://github.com/Pingfan1337/FlappyBird-Web.git
cd FlappyBird-Web

# 2. 启动任意本地静态服务器
python3 -m http.server 4173
# 或：npx serve .
```

然后用浏览器访问 `http://127.0.0.1:4173`。

### 运行自动化校验测试

需要 Node.js 20+：

```bash
# 运行独立单元测试与 977 帧确定性黄金回放校验（全平台可运行）
node tests/unit.test.mjs

# 可选：若同级目录或 IOS_SRC_DIR 存在原 iOS 仓库且本机装有 clang++，
# 可实时编译 C++ 头文件并执行逐帧、逐图元交叉验证：
IOS_SRC_DIR=../FlappyBird-arm64-Metal-iOS27 node tests/trace.test.mjs
```

---

## 资源处理工具

- **`tools/gen-atlas.mjs`**：读取 `tools/atlas.txt` 并生成零解析开销的 `js/atlas.js` 常量表：
  ```bash
  node tools/gen-atlas.mjs
  ```
- **`tools/trim.mjs`**：无损移除 16-bit PCM WAV 文件末尾连续数字静音（如原 `sfx_swooshing.caf` 含 1.37 秒尾随静音，裁剪后从 352 KB 缩减至 110 KB，音频波形零失真）：
  ```bash
  node tools/trim.mjs input.wav output.wav
  ```

---

## 云端部署指南

本项目为**纯静态站点**，可零成本免费部署到几乎所有静态托管平台：

### 1. GitHub Pages（本仓库已内置自动部署）

仓库中的 `.github/workflows/deploy.yml` 会在每次推送到 `main` 分支时自动运行 `node tests/unit.test.mjs`，通过后组装静态资源并发布至 GitHub Pages。

若你 Fork 了本仓库，只需在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**，推送任意提交即可自动上线。

### 2. Cloudflare Pages / Vercel / Netlify

由于无需任何编译或打包命令，直接连接 Git 仓库并按如下填写即可：

| 平台 | Build command（构建命令） | Output directory（输出目录） |
|---|---|---|
| Cloudflare Pages | *(留空)* | `.` |
| Vercel | *(留空)* | `.` |
| Netlify | *(留空)* | `.` |

### 3. 自建 Nginx / Caddy

只需将仓库根目录（或仅 `index.html`、`manifest.webmanifest`、`sw.js`、`assets/`、`js/`）放到站点目录并确保 `.js` / `.webmanifest` / `.wav` MIME 类型正确即可（推荐开启 HTTPS 以便启用 Service Worker 离线缓存）。

---

## 已知限制与说明

- **Game Center 排行榜**：原版 iOS Game Center 排行榜属于原开发者账号，网页版无法接入；点击排行榜按钮会弹出**本地战绩**卡片，展示基于 `localStorage` 的历史最高分、总局数、最高奖牌及当前渲染后端（`WEBGL2` / `CANVAS2D`）。
- **商店链接与广告**：与原 iOS 移植版一致，已移除原广告 SDK；主菜单 `RATE` 按钮在网页版改为展示**关于与快捷键说明**弹窗。
- **奖牌闪烁粒子**：沿用原 iOS 重建版范围，奖牌闪烁粒子效果尚未实现。
- **高刷上限取决于浏览器调度**：游戏自身以 `requestAnimationFrame` 请求显示器最高刷新率，但部分浏览器在省电模式（如 macOS/iOS 低电量模式或 Safari 默认设置）下可能会将 `rAF` 限制在 60Hz。

---

## 致谢与权利声明

- 玩法逻辑、资源索引与帧插值方案移植自 [Pingfan1337/FlappyBird-arm64-Metal-iOS27](https://github.com/Pingfan1337/FlappyBird-arm64-Metal-iOS27)。
- 原版游戏、像素美术、音效与相关品牌归原权利人 **.GEARS / dotGEARS** 所有。
- 本项目为非官方移植与技术研究/保存项目，未对原版素材与重建代码授予 MIT / Apache / 公有领域等通用开源许可，具体范围请参阅 [NOTICE.md](NOTICE.md)。
