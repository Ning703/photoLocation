use std::ffi::{OsStr, OsString, c_void};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::ERROR_CANCELLED;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    Common::ITEMIDLIST, FOS_ALLOWMULTISELECT, FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM,
    FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
    SHOpenFolderAndSelectItems, SHParseDisplayName, SIGDN_FILESYSPATH, ShellExecuteW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{Error, HRESULT, PCWSTR, Result, w};

struct Apartment;

impl Apartment {
    fn enter() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn wide(path: &OsStr) -> Vec<u16> {
    path.encode_wide().chain([0]).collect()
}

pub fn pick_folders(initial: Option<&Path>, english: bool) -> Result<Vec<PathBuf>> {
    let _apartment = Apartment::enter()?;
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        let options = dialog.GetOptions()?;
        dialog.SetOptions(
            options
                | FOS_PICKFOLDERS
                | FOS_FORCEFILESYSTEM
                | FOS_ALLOWMULTISELECT
                | FOS_DONTADDTORECENT,
        )?;
        dialog.SetTitle(if english {
            w!("Select photo folders")
        } else {
            w!("选择照片文件夹")
        })?;
        if let Some(initial) = initial.filter(|path| path.is_dir()) {
            let path = wide(initial.as_os_str());
            let folder: Result<IShellItem> =
                SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None);
            if let Ok(folder) = folder {
                let _ = dialog.SetFolder(&folder);
            }
        }

        match dialog.Show(None) {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                return Ok(Vec::new());
            }
            result => result?,
        }
        let items = dialog.GetResults()?;
        let mut paths = Vec::new();
        for index in 0..items.GetCount()? {
            let item = items.GetItemAt(index)?;
            let path = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            paths.push(PathBuf::from(OsString::from_wide(path.as_wide())));
            CoTaskMemFree(Some(path.0.cast::<c_void>()));
        }
        Ok(paths)
    }
}

pub fn open(target: &OsStr) -> Result<()> {
    let _apartment = Apartment::enter()?;
    let target = wide(target);
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(Error::from_thread());
    }
    Ok(())
}

pub fn reveal(path: &Path) -> Result<()> {
    let _apartment = Apartment::enter()?;
    let path = wide(path.as_os_str());
    let mut item: *mut ITEMIDLIST = std::ptr::null_mut();
    unsafe {
        SHParseDisplayName(PCWSTR(path.as_ptr()), None, &mut item, 0, None)?;
        let result = SHOpenFolderAndSelectItems(item, None, 0);
        CoTaskMemFree(Some(item.cast::<c_void>()));
        result
    }
}
