# 点点计数 Android 版

Android 版将项目网页放在应用内，通过系统 WebView 离线运行。当前版本 **1.0.4**（versionCode 5），应用 ID 为 `cn.diandian.counter`，支持 Android 8.0 及以上。

## 安装与更新

从 [最新版发布页面](https://github.com/wobuyaoquminga/diandian-counter/releases/latest) 下载 `diandian-counter-1.0.4.apk`，复制到手机后用文件管理器打开，按系统提示允许该来源安装应用。首次打开没有任务，点击“新建任务”开始使用。若提示 WebView 组件版本问题，请更新 Android System WebView 或 Chrome。

应用的计数和历史保存在本机。使用**同一签名**的新版 APK 覆盖安装，通常会保留原数据；卸载应用或清除应用数据会删除本地记录。电脑浏览器的数据与手机数据彼此独立，目前只有 JSON 导出、没有导入。导出时系统会让你选择保存位置；取消保存不会改变计数。建议更新或清理手机前导出留档。

## 从源码构建

在 Windows 上准备 JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。在项目根目录运行 PowerShell，并把两个示例路径替换为本机实际安装位置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\android\build-apk.ps1 -SdkRoot "<Android SDK 路径>" -JdkRoot "<JDK 17 路径>"
```

脚本读取根目录的五个网页文件，编译、对齐并签名 APK，输出到 `dist/diandian-counter-1.0.4.apk`，同时生成 `.apk.sha256` 文件。测试数据和预览图片不会打包。

首次自行构建时，脚本会在 `android/.signing/` 创建签名材料；它们只保存在构建者本机，不应提交或公开。**新生成的签名与官方发布 APK 不同，不能用自行构建的 APK 直接覆盖安装官方版本。**若要持续覆盖更新自己的构建版本，需妥善保留同一套签名材料。

发布版 1.0.4 已通过 APK 签名、对齐和内置资源校验，并通过项目的单元及浏览器检查。真机安装和 Android 文件选择器导出尚未实测。
