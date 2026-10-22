# 任务清单: RHC 铺单限流自激修复（review3 六补丁）

## 补丁 1 批量配速
- [√] 1.1 lighter.js：SAFE_GRID_BATCH 10->15、PACE 0->1500ms、OPENING_RETRY_BASE_MS 1s->5s

## 补丁 2 确认多轮
- [√] 2.1 _confirmAccepted 改为多轮等待 [350,800,1600,3000] 部分确认，已接收未确认批次不再整批入重试

## 补丁 3 轮询降载
- [√] 3.1 lighter setPollLight + _poll 跳过重查询；bot.js _placeMany 铺单期间 setPollLight(true/false)

## 补丁 4 写请求保险带
- [√] 4.1 _request POST 分支 1100ms 最小间隔

## 补丁 5/6 体验
- [√] 5.1 启动铺单按离现价近者优先排序；启动告警标注预期铺单时长（勿中途停止）

## 测试
- [√] 6.1 更新 lighter.test 断言（orderBatchSize=15/PACE=1500/retry=5000），全量通过 + lint 干净

## 版本与文档
- [√] 7.1 version 1.4.4；CHANGELOG；wiki；提交推送 dev004
