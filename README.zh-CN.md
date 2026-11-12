# 照片地图

[English](README.md)

在 Windows 上用浏览器浏览本地照片的拍摄地点。应用提供两个 OpenStreetMap 全球底图来源，照片和索引保留在本机。

## 构建与启动

在 Windows x64 上准备当前稳定版的 Rust 工具链及对应链接器，并将 AVIF 解码器构建所需的 NASM 加入 PATH。在仓库目录中构建并运行。

~~~powershell
cargo build --release --locked
Copy-Item .\target\release\photo-location.exe .
.\photo-location.exe
~~~

EXE 已包含网页资源和图像解码器。程序会打开默认浏览器，并在终端显示本机地址。按 Ctrl+C 停止。

~~~powershell
.\photo-location.exe --port 8765 --no-browser
~~~

使用固定端口可以让浏览器在重启后继续记住语言偏好。

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
