mod catalog;
mod photos;
mod server;

#[cfg(windows)]
mod native;

use std::error::Error;
use std::path::PathBuf;

use clap::Parser;

#[derive(Parser)]
#[command(about = "在浏览器中查看本地照片的拍摄地点")]
struct Options {
    /// 本机端口。默认自动选择
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// 仅打印地址
    #[arg(long)]
    no_browser: bool,
    /// 指定文件夹状态文件。默认与可执行文件同目录
    #[arg(long)]
    state_file: Option<PathBuf>,
}

#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    use std::io::{self, Write};

    let options = Options::parse();
    let executable = std::env::current_exe()?;
    let directory = executable.parent().expect("executable directory");
    let state_file = options
        .state_file
        .unwrap_or_else(|| directory.join("photo-folders.local.json"));
    let initial_directory = state_file.parent().map(|parent| parent.join("testPic"));
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port)).await?;
    let host = listener.local_addr()?.to_string();
    let url = format!("http://{host}/");
    let catalog = catalog::Catalog::open(state_file)?;
    let app = server::router(host, catalog, initial_directory);

    println!("{url}");
    io::stdout().flush()?;
    if !options.no_browser
        && let Err(error) = native::open(url.as_ref())
    {
        eprintln!("无法自动打开浏览器。请访问 {url} ({error})");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(not(windows))]
fn main() -> Result<(), Box<dyn Error>> {
    Err("This application targets Windows.".into())
}
