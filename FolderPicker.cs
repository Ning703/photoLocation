using System;
using System.Runtime.InteropServices;

namespace PhotoMap
{
    // OpenFolderDialog is unavailable in Windows PowerShell's .NET Framework.
    public static class FolderPicker
    {
        private const uint PickFolders = 0x20;
        private const uint ForceFileSystem = 0x40;
        private const uint AllowMultiSelect = 0x200;
        private const uint DontAddToRecent = 0x02000000;
        private const uint FileSystemPath = 0x80058000;
        private const int Cancelled = unchecked((int)0x800704C7);
        private static readonly Guid FileOpenDialogClass = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");

        public static string[] Choose(string title, string initialDirectory)
        {
            var dialog = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(FileOpenDialogClass));
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | PickFolders | ForceFileSystem | AllowMultiSelect | DontAddToRecent);
                dialog.SetTitle(title);
                SetInitialDirectory(dialog, initialDirectory);

                int result = dialog.Show(IntPtr.Zero);
                if (result == Cancelled)
                    return new string[0];
                Marshal.ThrowExceptionForHR(result);

                IShellItemArray items;
                dialog.GetResults(out items);
                try
                {
                    uint count;
                    items.GetCount(out count);
                    var paths = new string[count];
                    for (uint i = 0; i < count; i++)
                    {
                        IShellItem item;
                        items.GetItemAt(i, out item);
                        try
                        {
                            item.GetDisplayName(FileSystemPath, out paths[i]);
                        }
                        finally
                        {
                            Marshal.ReleaseComObject(item);
                        }
                    }
                    return paths;
                }
                finally
                {
                    Marshal.ReleaseComObject(items);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(dialog);
            }
        }

        private static void SetInitialDirectory(IFileOpenDialog dialog, string path)
        {
            if (string.IsNullOrEmpty(path))
                return;
            Guid itemId = typeof(IShellItem).GUID;
            IShellItem folder;
            if (SHCreateItemFromParsingName(path, IntPtr.Zero, ref itemId, out folder) < 0)
                return;
            try
            {
                dialog.SetFolder(folder);
            }
            finally
            {
                Marshal.ReleaseComObject(folder);
            }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);

        // COM dispatch depends on the order of these methods in the Windows SDK.
        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr owner);
            void SetFileTypes(uint count, IntPtr filters);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem folder);
            void SetFolder(IShellItem folder);
            void GetFolder(out IShellItem folder);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
            void AddPlace(IShellItem item, uint alignment);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
            void GetResults(out IShellItemArray items);
            void GetSelectedItems(out IShellItemArray items);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint format, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }

        [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItemArray
        {
            void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
            void GetPropertyStore(uint flags, ref Guid iid, out IntPtr store);
            void GetPropertyDescriptionList(IntPtr key, ref Guid iid, out IntPtr description);
            void GetAttributes(uint flags, uint mask, out uint attributes);
            void GetCount(out uint count);
            void GetItemAt(uint index, out IShellItem item);
            void EnumItems(out IntPtr enumerator);
        }
    }
}
