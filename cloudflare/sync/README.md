# 个人同步空间后端

使用 Workers Free 和 SQLite Durable Objects，不依赖 R2、D1 或付费 Workers 计划。前端继续由现有 GitHub Pages 托管。

## 本地运行

在本目录运行：

```sh
npm ci
npm run dev
```

本地数据位于 `.wrangler` 目录，与线上隔离。不要使用 `--remote` 连接线上数据。`wrangler.jsonc` 的 `ALLOWED_ORIGINS` 只允许现有网站和 3090 端口的本地预览。

联调前端时，将 `static/portfolio/sync-config.json` 的 `apiBase` 暂设为 `http://127.0.0.1:8787`，在项目根目录运行 `npm run build` 和 `npm run preview`，访问 `http://127.0.0.1:3090/portfolio/`。使用两个独立浏览器会话创建和加入空间。不要将本地 API 地址发布到线上。

## 配对 API

返回内容都是 JSON；错误为 `{ "error": "错误码" }`。带凭据的请求使用 `Authorization: Bearer <token>`，凭据不能放入地址。

| 请求 | 返回 |
| --- | --- |
| `GET /health` | `{ ok: true }` |
| `POST /v1/spaces` | `201 { roomId, token, deviceId, code, expiresAt }` |
| `POST /v1/pair`，JSON `{ code: "0123" }` | `{ roomId, token, deviceId }` |
| `GET /v1/spaces/:roomId`，需要凭据 | `{ roomId, createdAt, deviceId, messages }` |
| `POST /v1/spaces/:roomId/pair-code`，需要凭据 | `{ code, expiresAt }` |
| `POST /v1/spaces/:roomId/messages`，需要凭据，JSON `{ clientId, text }` | 一条消息；新建为 `201`，重试为 `200` |
| `DELETE /v1/spaces/:roomId/messages`，需要凭据 | `{ ok: true }`，同时清空所有设备的历史 |
| `DELETE /v1/spaces/:roomId/device`，需要凭据 | `{ ok: true }`，撤销当前设备凭据并断开其连接 |
| `GET /v1/spaces/:roomId/devices`，需要凭据 | `{ deviceId, devices: [{ deviceId, name, createdAt }] }`，顶层 `deviceId` 为当前设备 |
| `PATCH /v1/spaces/:roomId/devices/:deviceId`，需要凭据，JSON `{ name }` | `{ ok: true }`，修改指定设备名称 |
| `DELETE /v1/spaces/:roomId/devices/:deviceId`，需要凭据 | `{ ok: true }`，撤销指定设备凭据并断开其连接 |

时间为 Unix 毫秒。配对码保留前导零，十分钟内可供多台设备加入。重新生成会立即废弃旧码；同一空间每 30 秒最多重新生成一次。创建空间每 IP 每小时最多五次，尝试配对每 IP 每十分钟最多五次。限流返回 `429`，`Retry-After` 为剩余秒数。

浏览器保留 `roomId` 和该设备独立的 256 位随机凭据，后端仅保存凭据的 SHA-256。四位码只用于临时配对，不是永久密码；得到有效配对码的人具有相同空间访问权限。清理浏览器数据后，需要另一台已配对设备生成新码重新加入。

已配对成员都可以查看设备列表、重命名或撤销任意设备。名称最多 60 个 UTF-16 码元，保存时去除首尾空白，空名称由前端显示本地化默认名称。列表只返回设备 ID、名称和加入时间，不包含凭据或其哈希。目标设备不存在时返回 `404 device_not_found`，名称格式不正确时返回 `400 invalid_name`。既有空间的设备表首次加载时补充空名称列，原有凭据保持有效。未登记空间返回 `404 not_found`，不会实例化该空间的数据库。

## 消息与实时连接

消息为 `{ id, clientId, deviceId, text, createdAt }`。`id` 是空间内递增整数，`clientId` 是客户端生成的 UUID v4，同设备重试同一个 `clientId` 会返回已有消息。消息最多 10,000 个 UTF-16 码元，空白消息不接受。每个空间最多保留 5 天、最近 500 条，已清空或超出保留范围的旧消息不再参与重试去重。前端 Enter 发送，Shift+Enter 换行；输入法选词不会触发发送。

连接 `GET /v1/spaces/:roomId/socket` 并升级 WebSocket，地址中不携带凭据。在十秒内发送首帧 `{ "type": "auth", "token": "..." }`；认证成功返回 `{ type: "ready", deviceId, messages }`，包含当前完整保留历史。未认证连接不会收到历史或广播。

后续服务端广播 `{ type: "message", message }`、`{ type: "cleared" }` 或 `{ type: "history", messages }`。自动清理通过 `history` 同步剩余完整历史，客户端应替换已有列表。设备加入、改名和撤销后广播 `{ type: "devices" }`，客户端可重新读取设备列表；被撤销的设备以 `4001` 断开，不再接收广播。客户端消息发送仍使用上述 HTTP 接口。需要保活时发送字符串 `ping`，运行时直接回复字符串 `pong`，不会唤醒闲置对象。新建 WebSocket 每 IP 每十分钟最多 30 次。

连接采用 Hibernation API。每个空间共用一个 Durable Object alarm，取首次认证截止和最早消息满 5 天的时间中较早者，无人打开网页时也能清理。alarm 实际触发时间取决于平台调度；读取、重连和发送前也会清除已过期消息。认证截止时间是十秒，超过截止时间的新认证帧始终会被拒绝。网络变化或后端重新部署会断开连接；客户端应重连并重新认证，使用新的 `ready` 历史恢复状态。

无效或已撤销凭据使用 WebSocket 关闭码 `4001`，客户端应清除该设备凭据并重新配对。超时或其他协议错误使用 `1008`。

## 存储清理

所有同步空间共用一份容量预算。Registry 汇总各空间的 `sql.databaseSize` 及自身数据库，接近 4,700,000,000 字节时启动后台清理，并为下一条消息预留 128 KiB。先分批重新读取实际容量，避免已过期消息的旧记账触发多余删除；确认仍达警戒线后，本轮目标设为当前占用减去 3,000,000,000 字节，即通常从约 4.7 GB 降到约 1.7 GB。

后台按所有空间的消息时间从旧到新清理，每批最多 100 条，每次 alarm 最多处理十批，尚未达标则安排下一次。目标持久化，服务重新部署后仍可继续；总量已回到警戒线以下时允许继续发送。再次增长到 4.7 GB 后启动下一轮。清理仅删除消息，保留设备配对凭据；若已无消息可删，仍被元数据占满，会返回 `507 storage_full`。达到警戒线且正在清理时，新消息返回 `503 storage_cleaning` 和 `Retry-After: 1`，草稿保留，稍后可重试。已有消息的重试直接返回原消息，不会触发清理。删除也消耗 Cloudflare 免费写入额度，3 GB 是每轮目标，并不保证立即完成；每天 UTC 00:17 的 Cron 会分批复核已登记空间、修复过期清理 alarm，并恢复未完成的容量清理，以便日额度重置后继续。

这里统计本项目登记的所有同步空间，不是账户实时剩余容量。Cloudflare 的 5 GB 免费存储由账户共享，其他 Worker 的存储不在此汇总中；本项目未接入需要额外凭据的账户 Analytics API。字节数使用十进制 GB。当前只接收文本；未来文件或视频存储需要另行接入并计量。

## 上线配置

后端地址为 `https://portfolio-sync.li2096870763.workers.dev`。更新后端时，在已登录的 Cloudflare 账号中运行 `npx wrangler deploy`；使用兼容 Workers Free 的 `new_sqlite_classes` 迁移，不开通付费计划。仓库内 `static/portfolio/sync-config.json` 的 `apiBase` 指向该 HTTPS 地址，修改前端后仍需构建并发布网站。

前端只从这个静态配置读取后端地址；不要通过查询参数接受其他 API 地址，避免访问者的设备凭据被发送到陌生服务。Cloudflare 登录由账号持有人完成，不把 API token、设备凭据或 `.dev.vars` 提交到仓库。

## 免费额度

Workers Free 和 Durable Objects Free 到达每日限制后会暂时拒绝操作。免费额度及服务政策由 Cloudflare 决定，不保证永久不变。首期只保存文本，不开通 R2 计费订阅。参见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 和 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
