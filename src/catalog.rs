use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::photos;

const READ_ERROR: (&str, &str) = ("folderMemoryRead", "无法读取上次打开的文件夹列表。");
const PARTIAL_ERROR: (&str, &str) = ("folderMemoryPartial", "无法读取部分已记忆的文件夹。");
const WRITE_ERROR: (&str, &str) = ("folderMemoryWrite", "无法保存文件夹列表。");

#[derive(Deserialize, Serialize)]
struct FolderRecord {
    path: PathBuf,
    enabled: bool,
}

struct Folder {
    id: Uuid,
    record: FolderRecord,
    scanning: bool,
    result: Scan,
}

#[derive(Clone)]
struct Photo {
    id: Uuid,
    path: PathBuf,
    location: photos::Location,
}

#[derive(Default)]
struct Scan {
    photos: Vec<Photo>,
    without_gps: HashSet<String>,
    unreadable: HashSet<String>,
    inaccessible: usize,
}

#[derive(Default)]
struct State {
    folders: Vec<Folder>,
    photos: HashMap<Uuid, (Photo, Uuid)>,
    revision: u64,
    memory_error: Option<(&'static str, &'static str)>,
}

pub struct Catalog {
    state: Mutex<State>,
    scans: mpsc::Sender<(Uuid, PathBuf)>,
    state_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    folders: Vec<FolderView>,
    photos: Vec<PhotoView>,
    stats: Stats,
    scanning: bool,
    folder_memory_error: Option<&'static str>,
    folder_memory_error_code: Option<&'static str>,
    heif_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderView {
    id: String,
    name: String,
    path: String,
    enabled: bool,
    scanning: bool,
    located: usize,
    without_gps: usize,
    unreadable: usize,
    inaccessible: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoView {
    id: String,
    name: String,
    lat: f64,
    lng: f64,
    captured_at: Option<String>,
    folder_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    without_gps: usize,
    unreadable: usize,
    inaccessible: usize,
}

impl Folder {
    fn new(record: FolderRecord) -> Self {
        Self {
            id: Uuid::new_v4(),
            record,
            scanning: false,
            result: Scan::default(),
        }
    }

    fn view(&self) -> FolderView {
        FolderView {
            id: id_text(self.id),
            name: display_name(&self.record.path),
            path: self.record.path.to_string_lossy().into_owned(),
            enabled: self.record.enabled,
            scanning: self.scanning,
            located: self.result.photos.len(),
            without_gps: self.result.without_gps.len(),
            unreadable: self.result.unreadable.len(),
            inaccessible: self.result.inaccessible,
        }
    }
}

impl State {
    fn reindex(&mut self) {
        self.photos.clear();
        for folder in self.folders.iter().filter(|folder| folder.record.enabled) {
            for photo in &folder.result.photos {
                self.photos
                    .entry(photo.id)
                    .or_insert_with(|| (photo.clone(), folder.id));
            }
        }
        self.revision += 1;
    }
}

impl Catalog {
    pub fn open(state_path: PathBuf) -> io::Result<Arc<Self>> {
        let (scans, jobs) = mpsc::channel();
        let catalog = Arc::new(Self {
            state: Mutex::new(restore(&state_path)),
            scans,
            state_path,
        });
        let weak = Arc::downgrade(&catalog);
        std::thread::Builder::new()
            .name("photo-scan".into())
            .spawn(move || {
                for (id, path) in jobs {
                    let Some(catalog) = weak.upgrade() else { break };
                    if !catalog
                        .state
                        .lock()
                        .unwrap()
                        .folders
                        .iter()
                        .any(|folder| folder.id == id)
                    {
                        continue;
                    }
                    let result =
                        std::panic::catch_unwind(|| scan_folder(&path)).unwrap_or_else(|_| Scan {
                            inaccessible: 1,
                            ..Scan::default()
                        });
                    let mut state = catalog.state.lock().unwrap();
                    if let Some(folder) = state.folders.iter_mut().find(|folder| folder.id == id) {
                        folder.result = result;
                        folder.scanning = false;
                        state.reindex();
                    }
                }
            })?;
        {
            let mut state = catalog.state.lock().unwrap();
            for folder in &mut state.folders {
                catalog.enqueue(folder);
            }
        }
        Ok(catalog)
    }

    fn enqueue(&self, folder: &mut Folder) {
        if !folder.scanning {
            folder.scanning = self
                .scans
                .send((folder.id, folder.record.path.clone()))
                .is_ok();
        }
    }

    fn persist(&self, state: &mut State) {
        let parent = self
            .state_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let mut file = tempfile::Builder::new()
                .prefix("photo-folders.local.json.")
                .suffix(".tmp")
                .tempfile_in(parent)?;
            let records: Vec<_> = state.folders.iter().map(|folder| &folder.record).collect();
            serde_json::to_writer_pretty(&mut file, &records)?;
            file.write_all(b"\n")?;
            file.as_file().sync_all()?;
            file.persist(&self.state_path)?;
            Ok(())
        })();
        state.memory_error = result.err().map(|_| WRITE_ERROR);
    }

    pub fn add(&self, paths: Vec<PathBuf>) -> (usize, usize) {
        let mut rejected = 0;
        let mut roots = Vec::new();
        for path in paths {
            match dunce::canonicalize(path) {
                Ok(root) if root.is_dir() => roots.push(root),
                _ => rejected += 1,
            }
        }

        let mut state = self.state.lock().unwrap();
        let mut known: HashSet<_> = state
            .folders
            .iter()
            .map(|folder| path_key(&folder.record.path))
            .collect();
        let mut added = 0;
        for path in roots {
            if known.insert(path_key(&path)) {
                let mut folder = Folder::new(FolderRecord {
                    path,
                    enabled: true,
                });
                self.enqueue(&mut folder);
                state.folders.push(folder);
                added += 1;
            }
        }
        if added > 0 {
            state.reindex();
            self.persist(&mut state);
        }
        (added, rejected)
    }

    pub fn rescan(&self) {
        let mut state = self.state.lock().unwrap();
        for folder in &mut state.folders {
            self.enqueue(folder);
        }
        state.revision += 1;
    }

    pub fn remove(&self, id: Uuid) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(index) = state.folders.iter().position(|folder| folder.id == id) else {
            return false;
        };
        state.folders.remove(index);
        state.reindex();
        self.persist(&mut state);
        true
    }

    pub fn enable(&self, id: Uuid, enabled: bool) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(folder) = state.folders.iter_mut().find(|folder| folder.id == id) else {
            return false;
        };
        folder.record.enabled = enabled;
        state.reindex();
        self.persist(&mut state);
        true
    }

    pub fn photo_path(&self, id: Uuid) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap()
            .photos
            .get(&id)
            .map(|(photo, _)| photo.path.clone())
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().unwrap();
        let mut without_gps = HashSet::new();
        let mut unreadable = HashSet::new();
        let mut inaccessible = 0;
        for folder in state.folders.iter().filter(|folder| folder.record.enabled) {
            without_gps.extend(folder.result.without_gps.iter());
            unreadable.extend(folder.result.unreadable.iter());
            inaccessible += folder.result.inaccessible;
        }
        Snapshot {
            revision: state.revision,
            folders: state.folders.iter().map(Folder::view).collect(),
            photos: state
                .photos
                .values()
                .map(|(photo, folder_id)| PhotoView {
                    id: id_text(photo.id),
                    name: display_name(&photo.path),
                    lat: photo.location.lat,
                    lng: photo.location.lng,
                    captured_at: photo.location.captured_at.clone(),
                    folder_id: id_text(*folder_id),
                })
                .collect(),
            stats: Stats {
                without_gps: without_gps.len(),
                unreadable: unreadable.len(),
                inaccessible,
            },
            scanning: state.folders.iter().any(|folder| folder.scanning),
            folder_memory_error_code: state.memory_error.map(|error| error.0),
            folder_memory_error: state.memory_error.map(|error| error.1),
            heif_available: true,
        }
    }
}

fn restore(path: &Path) -> State {
    let mut state = State::default();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                state.memory_error = Some(READ_ERROR);
            }
            return state;
        }
    };
    let Ok(Value::Array(records)) = serde_json::from_reader(io::BufReader::new(file)) else {
        state.memory_error = Some(READ_ERROR);
        return state;
    };

    let mut known = HashSet::new();
    for record in records {
        match serde_json::from_value::<FolderRecord>(record) {
            Ok(record) if record.path.is_absolute() => {
                if known.insert(path_key(&record.path)) {
                    state.folders.push(Folder::new(record));
                }
            }
            _ => state.memory_error = Some(PARTIAL_ERROR),
        }
    }
    state
}

fn path_key(path: &Path) -> String {
    let text = dunce::simplified(path).to_string_lossy();
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text.into_owned()
    }
}

fn id_text(id: Uuid) -> String {
    id.simple().to_string()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

pub fn validate_file(path: &Path) -> io::Result<Metadata> {
    let resolved = dunce::canonicalize(path)?;
    let info = fs::symlink_metadata(path)?;
    if path_key(&resolved) != path_key(path) || !info.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "photo changed"));
    }
    Ok(info)
}

fn scan_folder(root: &Path) -> Scan {
    let mut result = Scan::default();
    let Ok(resolved) = dunce::canonicalize(root) else {
        result.inaccessible = 1;
        return result;
    };
    if path_key(&resolved) != path_key(root) {
        result.inaccessible = 1;
        return result;
    }

    let mut dirs = vec![resolved];
    while let Some(path) = dirs.pop() {
        let Ok(entries) = fs::read_dir(path) else {
            result.inaccessible += 1;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                result.inaccessible += 1;
                continue;
            };
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_symlink() => continue,
                Ok(kind) if kind.is_dir() => dirs.push(path),
                Ok(kind) if kind.is_file() && photos::supported_extension(&path) => {
                    scan_photo(path, &mut result);
                }
                Err(_) if photos::supported_extension(&path) => {
                    result.unreadable.insert(path_key(&path));
                }
                Err(_) => result.inaccessible += 1,
                _ => {}
            }
        }
    }
    result
}

fn scan_photo(path: PathBuf, result: &mut Scan) {
    let key = path_key(&path);
    match photos::location(&path) {
        Ok(Some(location)) => result.photos.push(Photo {
            id: Uuid::new_v5(&Uuid::NAMESPACE_URL, key.as_bytes()),
            path,
            location,
        }),
        Ok(None) => {
            result.without_gps.insert(key);
        }
        Err(_) => {
            result.unreadable.insert(key);
        }
    }
}
