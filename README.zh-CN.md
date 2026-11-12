# 照片地图

[English](README.md)

在 Windows 上用浏览器浏览本地照片的拍摄地点。应用提供两个 OpenStreetMap 全球底图来源，照片和索引保留在本机。

## 启动

需要 Windows、Windows PowerShell 5.1 或 PowerShell 7、Python 3.9 或更新版本，以及 Edge 或 Chrome。第一次在一台电脑上运行时，在项目目录执行以下命令。

~~~powershell
.\start.ps1 -Repair
~~~

此命令使用本机 Python 新建虚拟环境，安装图像处理依赖后启动应用。以后直接运行 `.\start.ps1`。迁移项目时，在目标电脑重新创建虚拟环境。遇到 Pillow 的 `_imaging` 导入错误，也可以运行 `.\start.ps1 -Repair`，原有环境会保存到 `.venv-backup-*`。

启动后会用系统默认浏览器打开页面，也可以把终端显示的本机地址粘贴到 Edge 或 Chrome。按 Ctrl+C 停止。用 `.\start.ps1 -Port 8765 -NoBrowser` 可以指定端口并手动打开页面。

## 使用

界面默认使用简体中文。点击标题旁的「English」可切换到英文，再点击「简体中文」可切换回来。

1. 点击「添加文件夹」。在 Windows 对话框中按住 Ctrl 多选，或分次添加不同位置的目录。应用会递归扫描。勾选文件夹即可切换地图上的照片，点击行尾的 × 可移除该目录。
2. 拖动地图移动、滚轮缩放，也可以聚焦地图后使用方向键和 + / −。点击「查看全部」重新框选当前照片。照片在缩小时聚合，放大时重新分组。
3. 点击地图上的照片卡片查看组内照片。照片按拍摄日期分组，同一天内按拍摄时间倒序。滚动时，当前日期以 YYYY-MM-DD 固定在列表顶部。点击照片放大并查看文件名，左右方向键切换。可以在资源管理器中选中原文件，或交给系统默认应用打开。
4. 应用会将已添加的文件夹路径和勾选状态保存在项目目录的 `photo-folders.local.json`。下次启动时自动恢复列表并扫描照片。源目录增加、移动或删除照片后，也可以点击「重新扫描」。
5. 点击地图左上角的「我的位置」，并在浏览器提示时允许定位。蓝点显示当前位置，再点击一次即可关闭。定位开关在打开页面时默认为关闭。

定位来自照片内的 EXIF GPS，支持 JPEG、PNG、WebP、TIFF、AVIF 和 HEIC/HEIF。经纬度同时为 0 的照片计入「无定位」。GPS 默认按 WGS‑84 与 OpenStreetMap 对齐，境内外使用相同坐标处理。底图采用 Web Mercator，超出南北约 85.05° 的标记显示在地图边缘，预览仍显示实际纬度。

底图访问需要网络。默认底图加载失败时，可在地图左上角的「底图」下拉菜单选「OSM 全球备用（德国站）」。德国站由 FOSSGIS 运营，覆盖全球，供个人非商业浏览，无需密钥。[德国站使用条款](https://openstreetmap.de/germanstyle/#nutzungsbedingungen)

当前底图服务会收到浏览区域的瓦片请求。瓦片失败时可以切换来源或重试，仍可浏览已经导入的照片。应用内置 Leaflet 1.9.4。[Leaflet 许可证](web/vendor/leaflet/LICENSE)

## 验证

手动验证时，点击「添加文件夹」并选择任意包含带 EXIF GPS 照片的本地文件夹。`testPic/` 是可选的本地目录，由 Git 忽略。若它存在，文件夹选择器会从该目录打开。自动化测试会临时生成所需的测试照片。

~~~powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
node --test tests/map-layout.test.mjs
~~~
