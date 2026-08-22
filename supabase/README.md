# Supabase 云端快照接入说明

这个目录用于把嘉华珺园看板从“浏览器本地快照”升级为“Supabase 云端历史快照”。

## 一次性配置

1. 在 Supabase 新建项目。
2. 打开 Supabase 的 SQL Editor。
3. 执行 `schema.sql`，创建三张表和只读策略。
4. 在项目设置里找到：
   - Project URL
   - anon public key
5. 打开 `assets/supabase-config.js`，改成：

```js
window.SUPABASE_CONFIG = {
  enabled: true,
  url: '你的 Supabase Project URL',
  anonKey: '你的 Supabase anon public key',
  projectCode: 'jiahua_junyuan'
};
```

## 数据表含义

- `houses`：房源基础信息，保存人工校正后的楼栋、房号、面积段，不建议每日覆盖。
- `daily_project_snapshots`：每天一条项目概览快照，保存已签约套数、面积、均价。
- `house_status_snapshots`：每天每套房一条状态快照，保存可售、已签约、网上联机备案等状态。

## 权限原则

网页前端只能使用 `anon public key` 读取数据。

每日自动更新任务写入数据时，需要使用 Supabase `service_role key`，但这个密钥只能放在自动任务或服务端环境变量里，不能写入网页文件。

## 页面读取逻辑

网页会读取 `daily_project_snapshots` 中最新的两天：

- 最新日期：作为当前数据
- 前一日期：作为昨日对比基线

随后读取这两天的 `house_status_snapshots`，计算新成交、退房、成交总价和均价。这样别人第一次打开网页，也能直接看到统一的云端历史对比。
