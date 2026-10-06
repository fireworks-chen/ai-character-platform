# 自有支付适配器协议

管理端「支付渠道」保存适配服务 URL、商户号、HMAC 密钥和用户 API 的外网回调地址。供应商原生协议如不兼容以下接口，需要在自有渠道前部署一个转换服务。未配置渠道时购买返回 503，不创建假支付、不充值。

## 创建订单

用户 API POST 到 `{gatewayUrl}/orders`，JSON 包含 `merchantId`、`orderNo`、`amount`（人民币分）、`currency: CNY`、`description`、`notifyUrl`、`timestamp`（毫秒时间戳字符串）及 `signature`。

签名为 `HMAC-SHA256(secret, merchantId + "|" + orderNo + "|" + amount + "|" + timestamp)` 的小写十六进制字符串。适配服务应验签、验证商户号和时间窗口，按 `orderNo` 幂等创建支付单，返回 `{"paymentUrl":"https://..."}`。套餐金额和积分均取服务端数据库快照，不接受浏览器传入金额或积分。

## 支付通知

适配服务 POST 到 `/api/v1/payments/callback`，JSON 包含 `orderNo`、`eventId`（唯一支付事件 ID）、`amount`（人民币分）、`status: paid`、`timestamp` 和 `signature`。

回调签名为 `HMAC-SHA256(secret, orderNo + "|" + eventId + "|" + amount + "|paid|" + timestamp)`。时间戳必须在五分钟内。接收端先验签和核对订单金额，再在同一 PostgreSQL 事务中锁定订单、增加积分、写账本、更新会员和订单状态、写操作日志。相同事件重试不会再次增加积分；重试使用最新时间戳重新签名。

成功响应 `{"success":true}`。重复通知额外返回 `duplicate:true`。签名不匹配返回 401，金额不匹配返回 400，不改变余额或会员。本地取消后仍到达的真实已支付通知会正常入账，避免已收款但丢失积分。

本地取消只关闭用户的待支付入口，不等同于渠道已取消交易。真实退款与渠道主动关单需要原生渠道 API 文档后单独接入；当前不提供模拟退款或人工把订单标记为支付成功的入口。
