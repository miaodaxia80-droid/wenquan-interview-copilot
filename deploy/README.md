# 问全云端网关部署说明

现有部署：SSH 别名 `aliyun`，目录 `/opt/wenquan`，Compose 项目 `wenquan`，容器 `wenquan-gateway`。公网地址 `https://cx.kevinxu.cn/wenquan`。现有 Caddy 代理到 `127.0.0.1:8788`，容器内监听 `0.0.0.0:8787`。运行时不依赖 Mac。

## 0.4.0 已部署更新（2026-10-17）

实际运行镜像为 `wenquan-gateway:0.4.0`，健康响应声明版本 0.4.0、analysisVersions [1,2] 及 automaticRoles/interviewSummary 功能。新增 `/api/identify-speakers` 和 `/api/summarize`，旧 JSON 与 NDJSON 接口保留。新增运行文件 `web/intelligence.js`，Dockerfile 已包含。

本轮备份目录：`/opt/wenquan/backups/pre-0.4.0-20261017-1625`；源码压缩包 `source.tar.gz`，已有 `.env` 备份与校验值保留在该目录内（权限 700）。原镜像另标为 `wenquan-gateway:rollback-pre-0.4.0`。部署后 `.env` 校验一致；没有改动 Caddy 或其他服务。

回滚须先保存届时的新改动，然后在 /opt/wenquan 解开该备份的 source.tar.gz 恢复源码与 compose，再执行 `docker compose up -d --no-build`，将恢复为旧 compose 指向的 0.2.5 镜像。不要删除现有备份或盲目覆盖后续配置。

本机 `start:studio` 仅监听 127.0.0.1:8790，不使用公网鉴权，不能部署为生产入口。

## 重建和更新

本目录 `compose.yaml` 以部署目录为构建上下文，需将以下文件以如下布局传到目标目录，先核对目标和已有版本，再更新；不要把整个开发目录或本地 `.env*` 打入镜像：

```text
/opt/wenquan/
  Dockerfile              # 本目录 Dockerfile
  compose.yaml            # 本目录 compose.yaml
  package.json
  package-lock.json
  server/                 # 项目 server 目录
  web/core.js
  web/interview.js
  web/intelligence.js
  web/audio-file.js
  web/platform.js
  .env                    # 权限 600，只在服务器保留
```

服务器 `.env` 使用现有模型与火山套餐配置，并设置：

```dotenv
HOST=0.0.0.0
PORT=8787
GATEWAY_TOKEN=至少32字符的随机设备访问码
SERVE_WEB=false
ALLOW_LOOPBACK_ORIGINS=false
ALLOW_TOKEN_ORIGINS=true
```

访问码与上游 API Key 分离；不要在日志、命令参数、安装包或访谈导出中写入真实值。不同手机 WebView 的来源可变，因此开启携码访问的 CORS 来源兼容；这不替代鉴权。HTTP 使用 Bearer 请求头，WebSocket 在第一条 `start` JSON 消息中鉴权，成功前不连接上游，访问码不放 URL。

```sh
ssh aliyun
cd /opt/wenquan
docker compose build
docker compose up -d
docker compose ps
```

容器默认自动重启、只读文件系统、非 root、256 MiB 内存和 0.75 CPU 上限。Docker 日志轮转；应用不记录原始录音、访谈正文或密钥。

## HTTPS 路由与回滚

`caddy-route.txt` 给出现有站点内的路径路由。当前路由已部署，无需再次运行安装脚本。`install-caddy-route.py` 只用于本服务器的首次添加，会要求目标站点唯一、已有路由时退出、备份原文件并验证后重载；未来更新不可直接覆盖整个 Caddyfile。

卸载网关时，先移除 `cx.kevinxu.cn` 站点里的 `/wenquan/*` 路由，运行 `caddy validate --config /etc/caddy/Caddyfile` 并重载，再在 `/opt/wenquan` 执行 `docker compose down`。不要删除其他站点或停止整个 Caddy。现有原始配置备份 `/opt/wenquan/Caddyfile.before-20261017T043327Z`；只有确认期间没有其他修改时才可整份恢复，否则仅移除问全路由。

更新代码前保留当前镜像与源码；回滚时使用保留镜像启动该 Compose 服务。轮换访问码需同时更新服务器 `.env` 与手机设置，再重建容器环境；已有手机访问码随即失效。

## 验证与限制

在开发机使用忽略的 `.env.cloud` 运行公网验证（会真实调用已配置服务额度）：

```sh
WENQUAN_GATEWAY_URL=https://cx.kevinxu.cn/wenquan node --env-file=.env.cloud scripts/probe-cloud-0.4.mjs
```

测试使用项目内虚构合成音频，检查匿名 401、移动来源预检、HTTPS 配置、WSS 中间和稳定转写、模型结果与引文校验。结果写入 `evidence/cloud-gateway-probe-0.4.0.json`；不能替代实体手机测试。

主路径为前台原生 Opus 增量封装与 WSS，文件回放由 WebView 解码为 PCM 再实时发送。镜像未安装 ffmpeg，因此旧的 `/api/transcribe` HTTP 文件兼容接口不在本次云端支持范围；不要通过该接口测试主路径。开发机兼容适配需要自行安装 ffmpeg。

当前设备访问码面向个人原型使用，不包含多用户账号系统。手机重装后需要重新导入本机私密 `.env.connection.json`；该文件和 QR 配置不属于交付安装包或公开源码。

## 0.2.2 个人免配置包

按用户要求，0.2.2 的个人安装包已包含网关设备访问码，只供本人使用，不能作为公开分发包。上游火山与模型 API Key 未进入包。源代码中的访问码仍为空，构建仅从忽略的本机 `.env.connection.json` 注入生成目录。当前服务器无需改动，仍运行网关 0.2.1。访问码轮换后需要重建安装包并更新手机，或在手机设置中手动更改。


## 历史已部署 0.2.5 模型与流式更新

Compose 镜像为 `wenquan-gateway:0.2.5`，仍只暴露服务器回环 `127.0.0.1:8788`；Caddy 路由未变。运行环境中 `MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3`、`MODEL_NAME=deepseek-v4.1-flash`、`MODEL_STREAM=true`、`MODEL_THINKING=disabled`、`MODEL_REPAIR=true`。套餐 Key 使用服务端现有私密配置，不写入发布包。ASR 不变。

`POST /api/analyze` 和 `/api/checklist` 在客户端发送 `Accept: application/x-ndjson` 时，输出 start、delta、可选 reset、result/error。result 已经服务器校验；原 JSON 请求继续兼容。反向代理应保留流式传输，禁止缓冲；服务返回 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`。公网探针已确认实际内容增量早于完整结果。

当前源码文件与部署容器中的关键文件 SHA256 一致，见 `evidence/deployment-0.2.5.json`。上传的 `wenquan-gateway-0.2.5.tar.gz` 只含运行源码、Dockerfile 和 Compose，不含 `.env`。

部署前配置、源码备份位于 `/opt/wenquan/backups/0.2.1-before-model-stream/`，权限受限；旧镜像另存 `wenquan-gateway:rollback-before-0.2.5`。如需完整回滚，先保存当前私密配置，将备份 env.private 恢复为权限 600 的 `.env`，恢复原源码及 Compose，指定保留的旧镜像并执行 `docker compose up -d --no-build`。无需回滚或替换其他站点的 Caddyfile。只想换模型时更新服务端 MODEL_* 并重建容器环境，旧手机连接无需改变。
