using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace AniBTDesktop {
  static class FolderWindow {
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name,IntPtr context,out IntPtr pidl,uint mask,out uint attributes);
    [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr folder,uint count,IntPtr items,uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window,int command);
    static object Get(object target,string name){return target.GetType().InvokeMember(name,BindingFlags.GetProperty,null,target,null);}
    static void Release(object value){if(value!=null&&Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
    static string Normalize(string folder){return Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);}
    static bool ActivateMatching(string folder){
      object shell=null,windows=null;
      try{
        shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        windows=shell.GetType().InvokeMember("Windows",BindingFlags.InvokeMethod,null,shell,null);
        int count=Convert.ToInt32(Get(windows,"Count"));
        for(int i=0;i<count;i++){
          object window=null,document=null,view=null,self=null;
          try{
            window=windows.GetType().InvokeMember("Item",BindingFlags.InvokeMethod,null,windows,new object[]{i});
            document=Get(window,"Document");view=Get(document,"Folder");self=Get(view,"Self");
            if(!String.Equals(Normalize(Convert.ToString(Get(self,"Path"))),folder,StringComparison.OrdinalIgnoreCase))continue;
            var handle=new IntPtr(Convert.ToInt64(Get(window,"HWND")));var root=GetAncestor(handle,2);if(root!=IntPtr.Zero)handle=root;
            if(IsIconic(handle))ShowWindowAsync(handle,9);
            SetForegroundWindow(handle);if(GetForegroundWindow()==handle)return true;
          }catch{}finally{Release(self);Release(view);Release(document);Release(window);}
        }
      }catch{}finally{Release(windows);Release(shell);}
      return false;
    }
    public static async Task<bool> Open(string folder){
      if(String.IsNullOrWhiteSpace(folder)||!Path.IsPathRooted(folder)||!Directory.Exists(folder))throw new IOException("保存目录不存在或无法访问。");
      folder=Normalize(folder); // Keep the root separator when opening a drive root.
      string shellPath=folder.EndsWith(":")?folder+Path.DirectorySeparatorChar:folder;
      IntPtr pidl;uint attributes;Marshal.ThrowExceptionForHR(SHParseDisplayName(shellPath,IntPtr.Zero,out pidl,0,out attributes));
      try{Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl,0,IntPtr.Zero,0));}finally{Marshal.FreeCoTaskMem(pidl);}
      for(int i=0;i<20;i++){if(ActivateMatching(folder))return true;await Task.Delay(100);}
      return false;
    }
  }
}
