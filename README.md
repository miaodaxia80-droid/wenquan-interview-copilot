# 问全 · 留心听，问清楚

当前手机插件版本 **0.4.1**（网关维持 0.4.0），需求基线 [项目需求 v0.5](docs/项目需求_v0.5.md)。公网网关已在 2026-10-17 从 0.2.5 更新至 0.4.0，地址为 `https://cx.kevinxu.cn/wenquan`。手机新包配合官方 GM Web Bridge v2 使用。

手机“访谈主题”页顶部新增“打开剧本演示预设”，一键填写《第一个陌生用户之后》的主题、目标和起点/转折/选择/后续四条主线。未结束演练可继续，结束后再次打开会新建，不覆盖历史。预设仅准备内容，不预填回答或自动开始录音。

## 现在的使用流程

1. 会前填写主题、希望聊清楚的目标，确认主线；嘉宾背景和访谈边界可选。
2. 获得对方同意记录后开始访谈。开场自然说明双方角色，流式 ASR 区分声音，模型结合语境自动判断主持人/嘉宾；同一声音沿用角色，不确定的片段保留待识别。可在完整转写中更正。
3. 会中先听回答，再选择 0–3 个候选中的一题；眼镜每次显示一题。实际自发提问也可记录，已问和已回应分别管理。
4. 点击“结束并整理”，收尾后自动生成整场核心内容、按主线归纳及待补问；要点带嘉宾原话出处，章节摘要可以编辑并导出 Markdown。

会中主要显示当前问题、最新发言和采集状态；文本演练、完整转写、问题历史、眼镜诊断和高级设置收起。新建入口只保留主持人访谈，原有其他场景记录和 v1 接口保留。

自动识别指访谈角色与本次流内声音归属，不是实名身份认证或声纹注册。嘉宾反问不应仅因问号改成主持人；模型有不确定性，人工纠正优先。归纳的引用校验不等于事实核实或语义绝对正确。

## 演示与安装

- [两人访谈剧本：第一个陌生用户之后](docs/演示访谈_两人剧本.md)：虚构人物、小林与小周，6～8 分钟，含逐句台词、会前设置、操作节奏和会后核对标准。
- 手机包：`release/wenquan-0.4.1.mmpkg`。
- 原生 Studio 组合包：`release/问全-0.4.1-Studio.zip`，配套官方 GM Web Bridge v2。
- [本轮验收与部署记录](docs/升级验收_0.4.0_2026-10-17.md)。

原生 MemoMind Plugin Studio 选择相邻 `plugin-open-platform` 工作区，手机选择 **问全 · 主持人实时访谈助手 0.4.1**。个人包预置公网连接；如果曾明确保存本机 8790 地址，需在服务设置改回公网地址。旧记录无需删除。实体手机需要安装新组合包，更新网关不会自动更新手机插件。

安装包含个人网关设备访问码，仅供本人使用；服务端模型与 ASR Key 不在手机包内。Studio review v3 与当前 SDK 只接受 review v1/v2 的 ZIP 检查器存在兼容差异，详见验收记录。

## 开发与运维

```sh
npm ci
npm run check
npm run build
npm test
npm run start:studio
```

Node.js >=22。唯一编辑源为本项目 `web`，构建自动更新 `dist`、MMPKG 和相邻 PhoneSDK 中的问全镜像；不改 SDK 公共实现。Studio 开发服务只监听 `127.0.0.1:8790`，不能用于公网。正式网关使用 `server/service.mjs`，容器仅映射服务器回环地址，现有 Caddy 提供 HTTPS/WSS。

模型与 ASR 配置沿用服务器 `.env`，不打印、不打进源码包。新环境参考 `.env.example` 及 `profiles/volc-agent-plan.env.example`；当前文本模型为 Agent Plan DeepSeek V4.1 Flash，ASR 为豆包流式 2.0。流式转写主路径不依赖服务器 ffmpeg；旧 HTTP 文件转写兼容接口不在云端支持范围。

```sh
node --env-file-if-exists=.env scripts/verify-interview-0.4.mjs
node scripts/verify-interview-0.4.mjs --cloud
WENQUAN_GATEWAY_URL=https://cx.kevinxu.cn/wenquan node --env-file=.env.cloud scripts/probe-cloud-0.4.mjs
```

这些探针会真实调用现有服务额度，测试内容为虚构文本或系统合成声音。主路径为连续采集、WSS 识别、角色判断、实时分析；原始音频不存到问全后端磁盘，本地保留完整转写。会后归纳读取整场转写，长内容分块整理后合并，最多 1500 段 / 24 万字符，超限明确提示，不静默裁剪。

源码说明：`web/intelligence.js` 负责角色及归纳引用校验，`server/intelligence.mjs` 负责模型识别和整场整理，`web/interview-ui.js` 负责精简后的主持人界面；原有转写、状态、权限和显示链路继续使用。

部署、备份和回滚见 [deploy/README.md](deploy/README.md)。历史状态见 [0.3.0 README 存档](docs/README_0.3.0历史.md) 与各版本验收文档，不能当作当前版本结果。
