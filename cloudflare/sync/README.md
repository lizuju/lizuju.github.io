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

除文件下载外，返回内容都是 JSON；错误为 `{ "error": "错误码" }`。带凭据的请求使用 `Authorization: Bearer <token>`，设备凭据不能放入地址。

| 请求 | 返回 |
| --- | --- |
| `GET /health` | `{ ok, service: "portfolio-sync", apiVersion: 1, revision, versionId }`，本地未注入发布信息时后两项为 `null` |
| `POST /v1/spaces` | `201 { roomId, token, deviceId, code, expiresAt, pairing }` |
| `POST /v1/pair`，JSON `{ code: "0123" }` | `{ roomId, token, deviceId, pairing }` |
| `GET /v1/spaces/:roomId`，需要凭据 | `{ roomId, createdAt, deviceId, messages, history, historyMode, pairing }`，最新 50 条 |
| `GET /v1/spaces/:roomId/messages?before=:id&limit=50&generation=:generation`，需要凭据 | 较早一页 `{ messages, history, historyMode }`；每页最多 50 条 |
| `POST /v1/spaces/:roomId/pair-code`，需要凭据 | `{ code, expiresAt }` |
| `POST /v1/spaces/:roomId/messages`，需要凭据，JSON `{ clientId, text }` | 一条消息；新建为 `201`，重试为 `200` |
| `DELETE /v1/spaces/:roomId/messages`，需要凭据 | `{ ok: true }`，清空历史及附件，并取消进行中的上传 |
| `DELETE /v1/spaces/:roomId/device`，需要凭据 | `{ ok: true }`，撤销当前设备凭据并断开其连接 |
| `GET /v1/spaces/:roomId/devices`，需要凭据 | `{ deviceId, devices: [{ deviceId, name, createdAt }] }`，顶层 `deviceId` 为当前设备 |
| `PATCH /v1/spaces/:roomId/devices/:deviceId`，需要凭据，JSON `{ name }` | `{ ok: true }`，修改指定设备名称 |
| `DELETE /v1/spaces/:roomId/devices/:deviceId`，需要凭据 | `{ ok: true }`，撤销指定设备凭据并断开其连接 |

时间为 Unix 毫秒。`pairing` 为当前有效的 `{ code, expiresAt }`，没有有效配对码时为 `null`。配对码保留前导零，十分钟内可供多台设备加入；同一空间的所有设备共用这个码。有效期内再次获取或并发获取都返回原码及原到期时间，不延长有效期，也没有 30 秒获取限制；过期后首次获取才生成新码。创建空间每 IP 每小时最多五次，尝试配对每 IP 每十分钟最多五次。限流返回 `429`，`Retry-After` 为剩余秒数。

浏览器保留 `roomId` 和该设备独立的 256 位随机凭据，后端仅保存凭据的 SHA-256。四位码只用于临时配对，不是永久密码；得到有效配对码的人具有相同空间访问权限。清理浏览器数据后，需要另一台已配对设备生成新码重新加入。

已配对成员都可以查看设备列表、重命名或撤销任意设备。名称去除首尾空白后最多 8 个 Unicode 字符，按用户输入的文本保存；空名称由前端显示本地化默认名称。列表只返回设备 ID、名称和加入时间，不包含凭据或其哈希。目标设备不存在时返回 `404 device_not_found`，名称格式不正确时返回 `400 invalid_name`。既有空间的设备表首次加载时补充空名称列，原有凭据保持有效。未登记空间返回 `404 not_found`，不会实例化该空间的数据库。

## 消息与实时连接

消息为 `{ id, clientId, deviceId, text, createdAt, attachment? }`，附件元数据为 `{ name, type, size }`，大小以字节计。`id` 是空间内递增整数，`clientId` 是客户端生成的 UUID v4，同设备重试同一个 `clientId` 会返回已有消息。文字最多 10,000 个 UTF-16 码元，纯文字消息不能全为空白；带附件时文字可留空。每个空间最多保留 5 天、最近 500 条，删除消息时同步清理附件。已清空或超出保留范围的旧消息不再参与重试去重。前端 Enter 发送，Shift+Enter 换行；输入法选词不会触发发送。

连接 `GET /v1/spaces/:roomId/socket` 并升级 WebSocket，地址中不携带凭据。浏览器使用子协议 `['sync', 'auth.' + token]`，后端在升级前校验凭据，正常连接按空间内设备分别限制为每十分钟 60 次；匿名或伪造凭据的连接共用每 IP 每十分钟 30 次的额度。服务器只选择 `sync` 子协议。升级后仍须在十秒内发送首帧 `{ "type": "auth", "token": "..." }`；首帧必须与升级时验证的设备一致。认证成功返回 `{ type: "ready", deviceId, messages, history, historyMode, pairing }`。首次只传最新 50 条，前端通过“加载更早消息”向前翻页。`history` 包含 `{ generation, oldestId, latestId, hasMore, continuationId, hasNewer }`。重连可带 `?after=:lastId&generation=:generation`，版本一致且游标仍在保留范围内时，每次最多传 50 条缺少的消息，`historyMode` 为 `append`；`hasNewer` 为真时继续以 `continuationId` 作为 `after` 分页补齐，实时广播不会跳过尚未补齐的消息；否则返回最新一页并以 `replace` 替换。历史清空、过期或容量淘汰都会更新版本，较早页面的过时响应不能重新加入列表。重连也从 Registry 读取最新配对码，不依赖设备本地保存的旧码。未认证连接不会收到历史、配对码或广播。

后续服务端广播 `{ type: "message", message, history }`、`{ type: "cleared", history, ... }` 或 `{ type: "history", messages, history, historyMode: "replace" }`。自动清理通过 `history` 同步最新一页，客户端替换已有列表。任一已配对设备调用 `POST /pair-code` 后，向同一空间的已认证连接广播 `{ type: "pairing", pairing }`，包括复用现有码时；该 HTTP 接口仍返回顶层 `{ code, expiresAt }`。客户端按 `expiresAt` 隐藏过期码，过期本身不主动广播；创建、加入、读取空间及重连的响应都会携带当前 `pairing`。配对码只持久保存在 Registry。设备加入、改名和撤销后广播 `{ type: "devices" }`，客户端可重新读取设备列表；被撤销的设备以 `4001` 断开，不再接收广播。客户端消息发送仍使用上述 HTTP 接口。需要保活时发送字符串 `ping`，运行时直接回复字符串 `pong`，不会唤醒闲置对象。客户端按指数退避并加入少量随机延迟重连；首次连接失败且确认空间已回收或凭据已撤销时，返回重新配对界面。

连接采用 Hibernation API。每个空间共用一个 Durable Object alarm，处理首次认证截止、最早消息满 5 天、未完成上传过期和待删除附件，无人打开网页时也能清理。alarm 实际触发时间取决于平台调度；读取、重连和发送前也会清除已过期消息。认证截止时间是十秒，超过截止时间的新认证帧始终会被拒绝。网络变化或后端重新部署会断开连接；客户端应重连并重新认证，使用新的 `ready` 历史恢复状态。

无效或已撤销凭据使用 WebSocket 关闭码 `4001`，客户端应清除该设备凭据并重新配对。超时或其他协议错误使用 `1008`。

## 文件与图片

每条消息可附一个任意格式文件，最大 `2 * 1024^3` 字节（2 GiB，界面标为 2GB）。客户端逐块读取文件，不把整个文件载入内存。上传使用 8 MiB 块，后端将文件存入多个 64 MiB 的 SQLite Durable Objects 分片；不使用 R2。上传状态按本次已确认的新增字节显示速度及预计剩余时间，恢复前已经上传的字节不计入测速。

前端在系统窗口内预览附件：PNG/JPEG/GIF/WebP/AVIF/HEIC 图片支持缩放，PDF 按可见页渲染并纵向滚动，MP4/WebM/OGG 视频使用原生播放器按需读取。DOCX、XLSX/XLS/ODS/CSV/TSV 及常见文本文件在浏览器本地解析，不上传第三方文档查看服务。图片预览限 20 MiB，文档/表格限 25 MiB，文本限 2 MiB；表格在独立 Worker 内解析和格式化，主线程仅渲染可见行，显示当前工作表前 1,000 行、50 列和已有的公式缓存值，不执行公式。语言切换更新文档内提示并保留工作表及横纵滚动位置；加载失败后再次点击同一附件可重试。文档排版可能与原文件不同，旧版 `.doc` 等未支持格式或超过预览限制的文件仍可下载。关闭预览、清空历史或离开空间会释放预览资源并终止表格 Worker。

下表路径均以 `/v1/spaces/:roomId` 开头，除最后一项外需要设备凭据。

| 请求 | 返回或用途 |
| --- | --- |
| `POST /files/uploads`，JSON `{ clientId, name, type, size, text? }` | `{ uploadId, chunkSize, receivedBytes }`；已完成的同一 `clientId` 返回 `{ message }` |
| `PUT /files/uploads/:uploadId/chunks/:index`，`application/octet-stream` | `{ receivedBytes }`；`index` 从零开始，末块除外均须为 `chunkSize` 字节 |
| `POST /files/uploads/:uploadId/complete` | 完整消息，新建为 `201`，重试为 `200`；完成后广播消息 |
| `DELETE /files/uploads/:uploadId` | `{ ok: true }`，取消当前设备的未完成上传 |
| `GET /files/:messageId`，也支持 `HEAD` | 鉴权后的文件字节流，用于按需预览 |
| `POST /files/:messageId/download` | `{ ticket, expiresAt }`，取得本机下载凭证，同设备同附件复用有效票据 |
| `GET /downloads/:ticket`，也支持 `HEAD` | 可续传的文件下载，不需要 Authorization；ticket 24 小时内可重复使用 |

同设备对同一附件重复申请会返回已有票据及原到期时间，不延长有效期；临近到期一分钟时才换新票据。前端将下载与预览共用的票据缓存在当前会话内，并合并同时发起的申请；移除消息或切换空间时清除缓存。预览和下载前通过 HEAD 检查可用性，票据返回 401/404 时自动重新申请一次。下载使用浏览器原生文件下载，iframe 的 load 事件不代表下载失败；仍可再次点击下载重试。服务端每次下载和预览仍检查设备权限、附件存在及保留期限。

ticket 路径添加 `?preview=1` 可流式内联预览 PNG、JPEG、GIF、WebP、AVIF、MP4、WebM、OGG 视频和 PDF；后端仅对白名单 MIME 返回对应 `Content-Type` 与 `inline`，HTML、SVG 及其余格式仍作为二进制附件下载。预览共用下载的 Range、HEAD、有效期和撤销检查。

前端上传前在 Worker 内采样文件首部、中部和尾部各 64 KiB，并与文件大小一起计算 SHA-256，将 `fingerprint` 随初始化请求发送。后端保存该指纹，同一 `clientId` 的指纹、名称、类型或大小不同会返回 `409 upload_conflict`；旧版无指纹的未完成上传不能用新指纹直接续传，需重新开始。采样能识别常见误选文件，不等于完整文件的校验和。失败后使用同一 `clientId` 重新初始化，再从 `receivedBytes` 继续顺序上传；同一块可以重试，内容冲突返回 `409 chunk_conflict`。进度字节数与块数在成功确认块时事务更新，重复块不重复计数；旧上传第一次恢复时从已有块记录补齐计数，以后不再逐块重复聚合整张记录。初始化、块上传和完成的可重试错误遵守 `Retry-After`（秒数或 HTTP 日期）；缺少该头时按指数退避，等待可取消。刷新页面会保留上传标识，重新选择同一文件并发送即可续传；上传期间可取消，保留输入的文字。未完成上传在最后活动 24 小时后回收。取消或清空后的上传不能继续完成。文件名最多 255 个 UTF-16 码元，不能包含路径分隔符或控制字符。空间成员可下载该空间的完整附件，但上传、续传和取消只能由原上传设备操作。

下载使用 `Content-Disposition: attachment` 和流式响应，浏览器直接保存文件，不先缓存整个 2 GiB。两种下载路径均支持单个 `Range: bytes=start-end`、`bytes=start-` 或 `bytes=-suffix`，返回 `206` 和准确的 `Content-Range`、`Content-Length`；无效、越界或多段请求返回 `416` 和 `Content-Range: bytes */总字节数`。`HEAD` 返回完整元信息和长度，不读取文件字节，也不处理 Range。文件返回稳定的 `ETag` 与 `Last-Modified`；`If-Range` 匹配时返回分段，失配时返回完整 `200`。流从所需分片偏移读取，每个分片最多一次 RPC，完整 2 GiB 下载为 32 个分片读取。ticket 可在 24 小时内重试或继续下载，但设备撤销、消息删除或附件满 5 天后立即不可用。

## 存储清理

所有同步空间的文字、附件和进行中的上传共用一份容量预算。Registry 汇总自身、空间及附件分片的 SQLite 大小，并计入未完成上传预留容量。上传开始时已预留完整文件及开销，逐块传输只更新房间内的分片记录，不再每块触发 Registry 维护和容量回填；预留继续占用全局预算，在完成、取消、过期清理或每日复核时更新汇总。接近 4,700,000,000 字节时启动后台清理；新建空间和下一条文字消息预留 128 KiB，附件按完整文件及分片开销预留。新建空间在 Registry 内同步完成容量检查和预留，再创建房间并回填实际占用，容量不足时不创建数据库。先分批重新读取实际容量，避免旧记账触发多余删除；确认仍需清理后，本轮目标设为当前占用减去 3,000,000,000 字节，即通常从约 4.7 GB 降到约 1.7 GB。

后台按所有空间的消息和上传时间从旧到新清理，每批最多 100 个消息或上传、每次 alarm 最多十批。先释放已标记删除的文件；淘汰批次遇到第一份附件或未完成上传即停止，分批释放它的分片后重新判断容量，避免顺带删除较新的消息或取消较新的上传。尚未达标则安排下一次。目标持久化，服务重新部署后仍可继续；总量已回到警戒线以下时允许继续发送。再次增长到 4.7 GB 后启动下一轮。清理删除消息及对应附件，也可取消较早的未完成上传，保留设备配对凭据；若已无内容可删，仍被元数据占满，会返回 `507 storage_full`。达到警戒线或不足以预留完整附件时，返回 `503 storage_cleaning` 和 `Retry-After: 1`，稍后可重试。已有消息的重试直接返回原消息。删除也消耗 Cloudflare 免费写入额度，3 GB 是每轮目标，并不保证立即完成；每天 UTC 00:17 的 Cron 会分批复核已登记空间、修复过期清理 alarm，并恢复未完成的容量清理，以便日额度重置后继续。

Registry 对同一房间的操作按队列执行，跨房间等待不使用全局锁。跨房间写入前持久化预留容量，完成后原子替换为实际占用，防止并发上传同时通过容量检查。每日复核也校准中断操作留下的预留。单个房间维护较慢时，其他房间可以继续发送。

这里统计本项目登记的所有同步空间，不是账户实时剩余容量。Cloudflare 的 5 GB 免费存储由账户共享，其他 Worker 的存储不在此汇总中；账户每日请求、读写和执行用量可通过下述 Analytics API 连接查询，账户总存储余额尚未接入。容量清理阈值使用十进制 GB，单文件及分块大小使用二进制 GiB/MiB。

## 联络站存储与日志

桌面开始菜单的“控制面板”打开设置窗口，点击“联络站存储”进入同一窗口的二级页面，点击“上一级”返回。公开只读接口 `GET /v1/status` 不需要设备凭据或管理员密钥，进入详情时加载一次，可手动刷新，不持续轮询。

状态接口只读探测应用数据，轮换抽样已登记房间及其已完成附件的现有分片，缺失分片不会被重新建表。显示本项目存储和写入预留量、空间数、清理阶段及目标、最近维护时间和下次 alarm；不触发清理，也不返回房间 ID、消息、配对码、设备或下载凭据。维护从未成功时显示未执行，不会显示正常；超过 26 小时没有成功记录、待处理维护缺少 alarm 或 alarm 逾期一分钟以上会提示逾期。存储容量只统计本项目；账户存储与精确账单仍需账户持有人登录控制台查看，释放存储不会恢复当日请求、读写或执行额度。

### 账户每日额度监控

控制面板也可显示整个 Cloudflare 账户当天的 Workers 请求、Durable Objects 请求、SQLite 读写行数和执行时长。后端通过官方 GraphQL Analytics API 获取 UTC 当天 00:00 至查询时刻的账户汇总，不按本项目过滤；额度在 UTC 00:00 重置。统计属于平台可能采样、延迟的估算，不能作为精确账单，也不代表达到额度前一定可用。Durable Objects 的 `hibernation` 入站 WebSocket 消息从 invocations 数据集读取，普通 WebSocket 入站消息从 periodic 数据集读取，分别按 20 条折算 1 次请求后相加，其余请求类型正常计数；执行时长保留官方 `duration` 的 GB·秒单位。免费额度参考值分别为每日 100,000、100,000、5,000,000、100,000 和 13,000 GB·秒；达到 80%、95%、100% 会提高提示级别。

`wrangler.jsonc` 中的 `CF_ACCOUNT_ID` 是账户标识，不是密钥。启用查询还需账户持有人创建仅限该账户、具有 Analytics Read / Account Analytics 只读权限的 API Token，然后在本目录执行以下命令，按提示输入；不要把 Token 写进配置、前端或 Git：

```sh
npx wrangler secret put CF_ANALYTICS_TOKEN
```

本地隔离调试可以使用未跟踪的 `.dev.vars`；测试自带虚构响应，不需要真实凭据。缺少凭据时返回 `dailyUsage.status = "not_configured"`、`available = false`、`metrics = null`，不会显示成用量为零。API 返回错误时，不向公开接口或日志透出原始错误及请求内容。

Registry 合并并发查询，将成功结果缓存在内存和持久存储中 5 分钟；失败结果缓存 1 分钟，避免公开刷新连续请求 Analytics API。每 15 分钟的 Cron 更新统计，原有 UTC 00:17 的每日维护保留。同一天查询失败时，可以展示最近成功值，但标为 `stale` 并保留原查询时间；跨过 UTC 午夜后不会把昨日结果显示为今日用量。监控故障不影响 `/health`、数据库探测或清理任务。

`GET /v1/status` 增加 `dailyUsage`：`status` 为 `ready`、`stale`、`not_configured` 或 `unavailable`；`day` 为查询对应的 UTC 日期，`checkedAt` 为最近成功时间，`resetsAt` 为下次 UTC 午夜。`metrics` 中的 `workersRequests`、`durableRequests`、`rowsRead`、`rowsWritten`、`duration` 各含 `used`、`limit`、`level`，后者为 `normal`、`warning`、`critical` 或 `exceeded`。公开响应仅包含汇总用量，不包含账户 ID、Token 或 Worker 名称。存储容量仍按本项目统计，不能用账户每日请求用量推算存储余额。

配置开启 10% 采样的 Workers Logs，关闭默认 invocation logs，避免记录下载票据所在的完整 URL。应用错误日志只包含固定路由类别、HTTP 状态、耗时和通用错误码；不记录请求体、原始异常、凭据、配对码或票据路径。维护失败记录时间并产生 `sync_maintenance_error`，平台可重试 alarm。

## 完整大文件本地验收

在本目录运行 `npm run test:large-transfer`，使用独立临时目录和本地 Miniflare，不连接线上、不使用真实文件。测试实际上传完整 2 GiB（256 个 8 MiB 块），512 MiB 后重启运行时，检查重复块计数与续传；完整流式慢读下载后核对 SHA-256，再检查跨分片 Range、末段续传以及下载中撤销设备。结束时删除测试数据库。需要至少 7 GiB 可用临时磁盘，因耗时和磁盘开销单独执行，不加入日常单元测试。

本次本机验收已完整通过：2,147,483,648 字节，下载 SHA-256 为 `91df9bbd79220fd4b4708e6e2478906b02ce07396a04cc81e297e85c1332023e`，约 69 秒。Node 进程峰值 RSS 约 289 MB（不包含 workerd 子进程）；这是本地测试结果，公网吞吐仍取决于网络和 Cloudflare 免费额度。

日常空间刷新和每日轮扫也会回收闲置空房间：必须没有设备、保留消息、文件、上传记录或分片，且没有仍有效的配对码。最后一台设备退出后，十分钟配对码仍可用于重新加入；有效期结束前不会回收。符合条件时删除房间 SQLite、Registry 容量记录及其过期配对码。同一房间的配对加入和回收在 Registry 内串行执行，已回收房间的迟到请求不会重新创建数据库。仍有内容或待清理分片的空间先按现有保留期及分批规则处理。

仍留有旧设备凭据的废弃空房间，在超过 30 天无认证活动、没有在线的已认证设备、没有有效配对码，且所有消息、附件、上传和分片都已清理后，也会在维护时回收。活动记录每小时最多写一次，并为回收增加一小时宽限；有效 HTTP 鉴权、设备加入和合法下载会更新活动，已认证的长连接断开时也会补记活动。既有空间首次升级从当前时间开始计时，不会因缺少旧活动记录被立即回收。回收后的旧凭据失效，重新使用需要创建或加入空间。

## 上线配置

后端地址为 `https://portfolio-sync.li2096870763.workers.dev`。更新后端时，先提交本次发布内容，在本目录运行 `npm run deploy`。脚本要求工作区干净，先运行后端测试和打包检查，检查 Cloudflare 登录，再部署并注入当前完整 Git SHA 为 `RELEASE_REVISION`；部署后检查 `/health` 返回的服务名、API 版本、提交 SHA 和 Cloudflare 版本 ID，失败会以非零状态退出。使用兼容 Workers Free 的 `new_sqlite_classes` 迁移，不开通付费计划。仓库内 `static/portfolio/sync-config.json` 的 `apiBase` 指向该 HTTPS 地址，修改前端后仍需构建并发布网站。

GitHub Pages 发布后，在仓库根目录运行 `npm run verify:release -- <本次完整提交SHA>`。验证器只发 GET 请求，不创建空间或消息；除核对后端版本外，还逐字节比较线上个人主页 HTML、后端配置、主 JS 和主 CSS 与本地 `docs/` 构建结果，防止后端成功而前端仍是旧版。单独验证后端可在本目录运行 `npm run verify:release -- <本次完整提交SHA> --backend-only`。`/health` 可访问、CI 通过或部署命令成功都不替代这一步。

前端只从这个静态配置读取后端地址；不要通过查询参数接受其他 API 地址，避免访问者的设备凭据被发送到陌生服务。Cloudflare 登录由账号持有人完成，不把 API token、设备凭据或 `.dev.vars` 提交到仓库。

## 免费额度

Workers Free 和 Durable Objects Free 到达每日限制后会暂时拒绝操作。大文件上传、下载和删除都会消耗免费请求、读写及存储额度，支持 2 GiB 不代表每天可无限传输。免费额度及服务政策由 Cloudflare 决定，不保证永久不变；本实现不开通 R2 计费订阅。参见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 和 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
