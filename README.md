# 物品管家

管理三类东西的手机 App，iOS 和安卓共用一套代码（Expo / React Native）。

| 类别 | 能做什么 |
| --- | --- |
| 食品 | 扫条码录入，填过期日期（直接选，或按「生产日期 + 保质期」自动算），记库存；快到期、已过期、库存不足时提醒 |
| 日用品 | 和食品一样扫码录入、记库存、库存不足提醒；过期日期可以不填 |
| 设备 | 电脑及配件：类别、名称、型号、序列号（可扫码）、数量；登记谁领走（使用人、数量、领取日期）和退还日期，支持部分退还，留全部领用记录 |

## 功能说明

- **扫码**：认识的条码直接打开该物品，选「入库」或「出库 / 用掉」；没见过的条码进新建页，并去 Open Food Facts 开放商品库查名称（只发送条码；国产商品收录不全，查不到就手填，手填一次后本机就记住了）。
- **批次**：同一商品买了好几次、过期日期不同，会分批记录；出库时先扣最早到期的那批。
- **提醒**（设置页可改）：
  - 到期前几天开始提醒（默认 7 天；单个物品可另设）
  - 多久提醒一次：每天 / 每 2 天 / 每 3 天 / 每周（到期当天一定提醒）
  - 每天几点提醒（默认 09:00）
  - 库存下限：库存 ≤ 下限时提醒补货（每个物品单独设，留空不提醒）
  - 用的是手机本地通知，不需要服务器；每次打开 App 或改库存都会按最新数据重排未来 60 天的提醒。
- **提醒页**：汇总已过期、快到期、库存不足和借出中的设备，点进去直接处理。
- **数据**：存在手机本地 SQLite 里，设置页可以导出 JSON 备份（通过系统分享）。

## 在手机上试用（不用装 Xcode / Android Studio）

1. 手机装 **Expo Go**（App Store / Google Play 搜 “Expo Go”）。
2. 电脑上：
   ```bash
   cd ~/code/item-keeper
   npm install
   npx expo start            # 手机和电脑在同一 Wi-Fi
   npx expo start --tunnel   # 不在同一网络时用这个
   ```
3. iPhone 用相机扫终端里的二维码，安卓用 Expo Go 扫，就能打开。

扫码、本地通知、SQLite 在 Expo Go 里都能用。

## 打成正式安装包

用 EAS 云端构建，本机不需要 Xcode / Android Studio（需要一个免费的 Expo 账号）：

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure          # 首次会问 iOS bundle id / 安卓包名
npx eas-cli@latest build -p android --profile preview   # 出 apk，直接发给别人装
npx eas-cli@latest build -p ios                          # 需要 Apple 开发者账号
```

## 开发

```bash
npm run typecheck   # TypeScript 检查
npm run lint        # ESLint
npm test            # 日期、出库、提醒排程的单元测试
```

目录：

```
src/app/            页面（expo-router，文件即路由）
  (tabs)/           底部五个标签：提醒、食品、日用品、设备、设置
  scan.tsx          扫码页
  stock/            食品 / 日用品的新建、详情（入库出库）、编辑
  device/           设备的新建、详情（领用退还）、编辑
src/db/             SQLite 表结构与查询
src/lib/            日期、提醒排程（纯函数，有单测）、通知、条码查询
src/components/     通用组件
tests/              单元测试
```

## 目前的限制

- 数据只在一台手机上，多人 / 多设备共用需要加一个服务端同步（下一步可以做）。
- 只有导出备份，还没有导入。
- 国产商品条码联网查名经常查不到，需要手填一次；如果要查得全，可以接中国物品编码中心等付费接口。
- App 图标和启动图还是 Expo 默认的。
