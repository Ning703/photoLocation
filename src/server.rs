use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use lru::LruCache;
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::catalog::{Catalog, Snapshot, validate_file};
use crate::{native, photos};

#[derive(RustEmbed)]
#[folder = "web/"]
struct Web;

#[derive(Eq, Hash, PartialEq)]
struct PreviewKey {
    path: PathBuf,
    size: u32,
    modified: SystemTime,
    length: u64,
}

struct App {
    catalog: Arc<Catalog>,
    host: String,
    origin: String,
    token: String,
    cookie_name: String,
    set_cookie: HeaderValue,
    initial_directory: Option<PathBuf>,
    picker: Arc<Semaphore>,
    decoders: Arc<Semaphore>,
    previews: Mutex<LruCache<PreviewKey, Bytes>>,
}

#[derive(Clone, Copy)]
struct ApiError(StatusCode, &'static str, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"errorCode": self.1, "error": self.2}))).into_response()
    }
}

const INVALID_HOST: ApiError = ApiError(
    StatusCode::FORBIDDEN,
    "invalidHost",
    "请使用应用启动时显示的本机地址。",
);
const INVALID_ORIGIN: ApiError = ApiError(
    StatusCode::FORBIDDEN,
    "invalidOrigin",
    "请求必须来自当前本机页面。",
);
const EXPIRED: ApiError = ApiError(
    StatusCode::FORBIDDEN,
    "expiredSession",
    "本机会话已失效，请刷新页面。",
);
const BAD_REQUEST: ApiError = ApiError(StatusCode::BAD_REQUEST, "invalidRequest", "请求格式无效。");
const NO_PAGE: ApiError = ApiError(StatusCode::NOT_FOUND, "pageNotFound", "页面不存在。");
const NO_ROUTE: ApiError = ApiError(StatusCode::NOT_FOUND, "requestNotFound", "请求不存在。");
const NO_ITEM: ApiError = ApiError(StatusCode::NOT_FOUND, "itemMissing", "该项目已从相册移除。");
const NO_PHOTO: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    "photoMissing",
    "照片已移除或文件位置已变化。",
);
const NO_ORIGINAL: ApiError = ApiError(
    StatusCode::NOT_FOUND,
    "originalMissing",
    "找不到原图，请重新扫描文件夹。",
);
const PREVIEW_FAILED: ApiError = ApiError(
    StatusCode::UNPROCESSABLE_ENTITY,
    "photoPreviewFailed",
    "照片无法预览。",
);
const PICKER_BUSY: ApiError = ApiError(
    StatusCode::CONFLICT,
    "pickerBusy",
    "文件夹选择窗口已经打开。",
);
const PICKER_FAILED: ApiError = ApiError(
    StatusCode::SERVICE_UNAVAILABLE,
    "pickerFailed",
    "无法打开文件夹选择窗口。请在 Windows 上重新启动应用。",
);
const NATIVE_FAILED: ApiError = ApiError(
    StatusCode::SERVICE_UNAVAILABLE,
    "nativeActionFailed",
    "Windows 无法执行此操作，请检查默认应用与文件权限。",
);

pub fn router(host: String, catalog: Arc<Catalog>, initial_directory: Option<PathBuf>) -> Router {
    let token: String = rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let port = host.rsplit_once(':').expect("loopback host and port").1;
    let cookie_name = format!("photo_map_{port}");
    let set_cookie = format!("{cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict")
        .parse()
        .expect("valid cookie");
    let app = Arc::new(App {
        catalog,
        origin: format!("http://{host}"),
        host,
        token,
        cookie_name,
        set_cookie,
        initial_directory,
        picker: Arc::new(Semaphore::new(1)),
        decoders: Arc::new(Semaphore::new(2)),
        previews: Mutex::new(LruCache::new(NonZeroUsize::new(64).unwrap())),
    });

    let api = Router::new()
        .route("/catalog", get(catalog_snapshot))
        .route("/folders/pick", post(pick))
        .route("/folders/rescan", post(rescan))
        .route("/folders/{id}/{action}", post(update_folder))
        .route(
            "/photos/{id}/{action}",
            get(photo_preview).post(native_action),
        )
        .fallback(|| async { NO_ROUTE })
        .method_not_allowed_fallback(|| async { NO_ROUTE })
        .layer(middleware::from_fn_with_state(Arc::clone(&app), api_guard));

    Router::new()
        .nest("/api", api)
        .fallback(get(asset))
        .layer(middleware::from_fn_with_state(Arc::clone(&app), local_only))
        .with_state(app)
}

async fn local_only(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let mut response = if header_text(request.headers(), header::HOST) == Some(&app.host) {
        next.run(request).await
    } else {
        INVALID_HOST.into_response()
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "referrer-policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(concat!(
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; ",
            "img-src 'self' data: https://tile.openstreetmap.org https://tile.openstreetmap.de; ",
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        )),
    );
    response
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn api_guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let post = request.method() == Method::POST;
    if post && header_text(request.headers(), header::ORIGIN) != Some(&app.origin) {
        return INVALID_ORIGIN.into_response();
    }

    let authenticated = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .any(|(name, value)| {
            name == app.cookie_name && bool::from(value.as_bytes().ct_eq(app.token.as_bytes()))
        });
    if !authenticated {
        return EXPIRED.into_response();
    }

    let mut request = request;
    if post {
        let json_type = header_text(request.headers(), header::CONTENT_TYPE)
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
        if !json_type {
            return BAD_REQUEST.into_response();
        }
        let (mut parts, body) = request.into_parts();
        let Ok(bytes) = to_bytes(body, 2048).await else {
            return BAD_REQUEST.into_response();
        };
        let Ok(payload @ Value::Object(_)) = serde_json::from_slice::<Value>(&bytes) else {
            return BAD_REQUEST.into_response();
        };
        parts.extensions.insert(payload);
        request = Request::from_parts(parts, Body::empty());
    }
    next.run(request).await
}

async fn asset(State(app): State<Arc<App>>, request: Request) -> Result<Response, ApiError> {
    let path = request.uri().path();
    let filename = if path == "/" {
        "index.html"
    } else {
        &path[1..]
    };
    let file = Web::get(filename).ok_or(NO_PAGE)?;
    let mime = match filename.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    let mut response = ([(header::CONTENT_TYPE, mime)], file.data).into_response();
    if path == "/" {
        response
            .headers_mut()
            .insert(header::SET_COOKIE, app.set_cookie.clone());
    }
    Ok(response)
}

async fn catalog_snapshot(State(app): State<Arc<App>>) -> Json<Snapshot> {
    Json(app.catalog.snapshot())
}

async fn pick(
    State(app): State<Arc<App>>,
    Extension(payload): Extension<Value>,
) -> Result<Json<Value>, ApiError> {
    let permit = Arc::clone(&app.picker)
        .try_acquire_owned()
        .map_err(|_| PICKER_BUSY)?;
    let english = payload["language"].as_str() == Some("en");
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let paths = native::pick_folders(app.initial_directory.as_deref(), english)
            .map_err(|_| PICKER_FAILED)?;
        let cancelled = paths.is_empty();
        let (added, rejected) = app.catalog.add(paths);
        Ok(Json(json!({
            "added": added, "rejected": rejected, "cancelled": cancelled,
            "catalog": app.catalog.snapshot(),
        })))
    })
    .await
    .map_err(|_| PICKER_FAILED)?
}

async fn rescan(State(app): State<Arc<App>>) -> Json<Snapshot> {
    app.catalog.rescan();
    Json(app.catalog.snapshot())
}

async fn update_folder(
    State(app): State<Arc<App>>,
    Path((id, action)): Path<(String, String)>,
    Extension(payload): Extension<Value>,
) -> Result<Json<Snapshot>, ApiError> {
    let enabled = match (action.as_str(), payload["enabled"].as_bool()) {
        ("enabled", Some(enabled)) => Some(enabled),
        ("remove", _) => None,
        _ => return Err(NO_ROUTE),
    };
    let id = Uuid::parse_str(&id).map_err(|_| NO_ITEM)?;
    tokio::task::spawn_blocking(move || {
        let found = match enabled {
            Some(enabled) => app.catalog.enable(id, enabled),
            None => app.catalog.remove(id),
        };
        if !found {
            return Err(NO_ITEM);
        }
        Ok(Json(app.catalog.snapshot()))
    })
    .await
    .map_err(|_| NATIVE_FAILED)?
}

async fn photo_preview(
    State(app): State<Arc<App>>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let size = match action.as_str() {
        "thumbnail" => 320,
        "preview" => 1600,
        _ => return Err(NO_ROUTE),
    };
    let id = Uuid::parse_str(&id).map_err(|_| NO_PHOTO)?;
    let permit = Arc::clone(&app.decoders)
        .acquire_owned()
        .await
        .map_err(|_| PREVIEW_FAILED)?;
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let path = app.catalog.photo_path(id).ok_or(NO_PHOTO)?;
        let metadata = validate_file(&path).map_err(|_| NO_PHOTO)?;
        let key = PreviewKey {
            path,
            size,
            modified: metadata.modified().map_err(|_| NO_PHOTO)?,
            length: metadata.len(),
        };
        if let Some(cached) = app.previews.lock().unwrap().get(&key).cloned() {
            return Ok(cached);
        }
        let bytes = Bytes::from(photos::jpeg(&key.path, size).map_err(|_| PREVIEW_FAILED)?);
        app.previews.lock().unwrap().put(key, bytes.clone());
        Ok(bytes)
    })
    .await
    .map_err(|_| PREVIEW_FAILED)??;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response())
}

async fn native_action(
    State(app): State<Arc<App>>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(action.as_str(), "open" | "reveal") {
        return Err(NO_ROUTE);
    }
    let id = Uuid::parse_str(&id).map_err(|_| NO_ITEM)?;
    tokio::task::spawn_blocking(move || {
        let path = app.catalog.photo_path(id).ok_or(NO_ITEM)?;
        validate_file(&path).map_err(|_| NO_ORIGINAL)?;
        if action == "open" {
            native::open(path.as_os_str())
        } else {
            native::reveal(&path)
        }
        .map_err(|_| NATIVE_FAILED)?;
        Ok(Json(json!({"ok": true})))
    })
    .await
    .map_err(|_| NATIVE_FAILED)?
}
