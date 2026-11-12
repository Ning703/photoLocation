# Photo Location

[Simplified Chinese README](README.zh-CN.md)

Browse where your local photos were taken on a map in your browser on Windows. The app offers two global OpenStreetMap basemap sources. Your photos and photo index stay on your computer.

## Build and run

On Windows x64, install a current stable Rust toolchain with its matching linker and add NASM to PATH for the AVIF decoder. From the repository directory, build and launch the app.

~~~powershell
cargo build --release --locked
Copy-Item .\target\release\photo-location.exe .
.\photo-location.exe
~~~

The EXE includes the web assets and image decoders. It opens the default browser and prints the local address. Press Ctrl+C in the terminal to stop the app.

~~~powershell
.\photo-location.exe --port 8765 --no-browser
~~~

A fixed port lets the browser remember its language preference across restarts.

## Using the app

The interface defaults to Simplified Chinese. Click **English** next to the app title to switch to English. Click the same button again to switch back.

1. Click **Add folders**. Hold Ctrl in the Windows dialog to select multiple folders, or add folders one at a time. The app scans each folder recursively. Use the checkboxes to control which folders appear on the map, and click × to remove a folder.
2. Drag the map to pan and use the mouse wheel to zoom. With the map focused, use the arrow keys to pan and + or − to zoom. Click **Fit all** to show all currently selected photos. Photos cluster as you zoom out and regroup as you zoom in.
3. Click a photo card on the map to open its group. The gallery groups photos by date and shows the newest first within each day. The current date stays visible at the top as you scroll. Click a photo to enlarge it and see its filename. Use the left and right arrow keys to move between photos, or use the viewer buttons to locate the original in File Explorer or open it in the default app.
4. The app saves the folder paths and checkbox states in `photo-folders.local.json` in the project directory. It restores the list and scans the folders at startup. After adding, moving, or removing photos, click **Rescan** to refresh the map.
5. Click **My location** and allow location access when the browser prompts you. A blue dot marks your position. Click the button again to turn location off. It starts off each time you open the page.

The app reads EXIF GPS metadata from JPEG, PNG, WebP, TIFF, AVIF, and HEIC/HEIF photos. Photos with both latitude and longitude set to zero count as having no location. Coordinates use WGS 84 worldwide. The Web Mercator basemap displays points beyond about 85.05° north or south at the edge of the map, and the photo preview shows their actual latitude.

Basemap tiles require an internet connection. If the default source fails to load, choose **OSM global fallback** from **Basemap**. FOSSGIS operates the fallback, which offers global coverage for personal, noncommercial browsing without an API key. [Fallback tile usage terms](https://openstreetmap.de/germanstyle/#nutzungsbedingungen)

The selected basemap provider receives tile requests for the area you're viewing. If tiles fail to load, you can switch sources or retry while continuing to browse imported photos. The app bundles Leaflet 1.9.4. [Leaflet license](web/vendor/leaflet/LICENSE)
