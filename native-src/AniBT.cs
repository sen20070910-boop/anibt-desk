using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Net;
using System.IO.Pipes;
using System.Threading;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Interop;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AniBTDesktop {
  static class Program {
    public const string AppId = "AniBT.AutoDownload";
    public static readonly string BasePath = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    public static readonly string Root = Path.GetFullPath(Path.Combine(BasePath, ".."));
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [STAThread] static int Main(string[] args) {
      try {
        SetCurrentProcessExplicitAppUserModelID(AppId);
        if(args.Length>0 && args[0]=="--register"){Notifications.Register();return 0;}
        if(args.Length>0 && args[0]=="--notify"){Notifications.Register();return Notifications.Send(args.Length>1?args[1]:"下载完成",args.Length>2?args[2]:"",args.Length>3?args[3]:"download");}
        if(args.Length>0 && args[0]=="--notification-status"){Notifications.Register();return Notifications.Status();}
        if(args.Length==0){Process.Start(new ProcessStartInfo("wscript.exe", "\""+Path.Combine(Root,"打开图形界面.vbs")+"\""){UseShellExecute=true});return 0;}
        Uri address;
        if(!Uri.TryCreate(args[0],UriKind.Absolute,out address)||address.Scheme!="http"||address.Host!="127.0.0.1")return 2;
        string key;using(var sha=SHA256.Create())key=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Root+Environment.UserName))).Replace("-","").Substring(0,24);
        bool first;using(var single=new Mutex(true,"Local\\AniBT-"+key,out first)){
          if(!first){using(var client=new NamedPipeClientStream(".","AniBT-"+key,PipeDirection.Out)){client.Connect(2500);using(var writer=new StreamWriter(client)){writer.WriteLine(address.Query.Contains("background=1")?"background":"show");writer.Flush();}}return 0;}
          var app=new Application();app.ShutdownMode=ShutdownMode.OnMainWindowClose;var shell=new Shell(address);
          var listener=new Thread(()=>{while(true){try{var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(System.Security.Principal.WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,System.Security.AccessControl.AccessControlType.Allow));using(var pipe=new NamedPipeServerStream("AniBT-"+key,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.None,0,0,security)){pipe.WaitForConnection();string command=new StreamReader(pipe).ReadLine();shell.Dispatcher.BeginInvoke(new Action(()=>{if(command=="background")shell.RequestAttention();else{if(shell.WindowState==WindowState.Minimized)shell.WindowState=WindowState.Normal;shell.Activate();}}));}}catch{}}});listener.IsBackground=true;listener.Start();app.Run(shell);return 0;
        }
      } catch(Exception e){try{Directory.CreateDirectory(Path.Combine(Root,"data"));File.AppendAllText(Path.Combine(Root,"data/native-error.log"),DateTime.Now+" "+e+Environment.NewLine);}catch{}return 1;}
    }
  }
  sealed class Shell : Window {
    readonly Uri address;readonly string origin,token,id=Guid.NewGuid().ToString("N");readonly bool background;bool attention;int unread;AniBTAccount account;
    readonly Grid outer=new Grid();readonly Border titlebar=new Border();readonly TextBlock caption=new TextBlock();readonly TextBlock status=new TextBlock();readonly Button minimize,maximize,close;readonly WebView2 web=new WebView2();bool dark,restoreMax,closed,webSuspended,morph,apple;int activityVersion;
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
    [StructLayout(LayoutKind.Sequential)] struct FlashInfo {public uint size;public IntPtr window;public uint flags;public uint count;public uint timeout;}
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FlashInfo info);
    public void RequestAttention(){attention=true;UpdateOverlay();var flash=new FlashInfo{size=(uint)Marshal.SizeOf(typeof(FlashInfo)),window=new WindowInteropHelper(this).Handle,flags=14,count=3,timeout=0};FlashWindowEx(ref flash);WriteState();}
    void UpdateOverlay(){TaskbarItemInfo.Overlay=(unread>0||attention)?new DrawingImage(new GeometryDrawing(new SolidColorBrush(Color.FromRgb(233,86,114)),new Pen(Brushes.White,1),new EllipseGeometry(new Point(8,8),7,7))):null;TaskbarItemInfo.Description=unread>0?unread+" 条未读下载完成通知":attention?"新番已开始下载":"AniBT 自动追番";}
    public Shell(Uri uri) {
      address=uri;origin=uri.GetLeftPart(UriPartial.Authority);token=uri.Fragment.StartsWith("#token=")?uri.Fragment.Substring(7):"";
      background=uri.Query.Contains("background=1");if(background){ShowActivated=false;WindowState=WindowState.Minimized;}
      Title="AniBT · 追番与资源工作台";Width=1380;Height=950;MinWidth=760;MinHeight=600;WindowStartupLocation=WindowStartupLocation.CenterScreen;WindowStyle=WindowStyle.None;ResizeMode=ResizeMode.CanResize;
      TaskbarItemInfo=new TaskbarItemInfo();LoadLayout();Closing+=(s,e)=>SaveLayout();
      Activated+=(s,e)=>{attention=false;UpdateOverlay();};
      try{Icon=BitmapFrame.Create(new Uri(Path.Combine(Program.Root,"ui/anibt.ico")));}catch{}
      var chrome=new WindowChrome{CaptionHeight=40,ResizeBorderThickness=new Thickness(6),GlassFrameThickness=new Thickness(0),CornerRadius=new CornerRadius(9),UseAeroCaptionButtons=false};WindowChrome.SetWindowChrome(this,chrome);
      outer.RowDefinitions.Add(new RowDefinition{Height=new GridLength(40)});outer.RowDefinitions.Add(new RowDefinition{Height=new GridLength(1,GridUnitType.Star)});Content=outer;
      var bar=new Grid();bar.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(1,GridUnitType.Star)});bar.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
      var left=new StackPanel{Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(19,0,0,0)};
      try{left.Children.Add(new Image{Source=Icon,Width=19,Height=19,Margin=new Thickness(0,0,10,0)});}catch{}
      caption.Text="AniBT";caption.FontFamily=new FontFamily("Segoe UI");caption.FontSize=13;caption.FontWeight=FontWeights.SemiBold;caption.VerticalAlignment=VerticalAlignment.Center;left.Children.Add(caption);
      status.Text="  /  追番与资源工作台";status.FontSize=10;status.FontFamily=new FontFamily("Microsoft YaHei UI");status.VerticalAlignment=VerticalAlignment.Center;left.Children.Add(status);bar.Children.Add(left);
      var controls=new StackPanel{Orientation=Orientation.Horizontal};Grid.SetColumn(controls,1);bar.Children.Add(controls);
      minimize=CaptionButton("\uE921","最小化","AniBT.Minimize");maximize=CaptionButton("\uE922","最大化","AniBT.Maximize");close=CaptionButton("\uE8BB","关闭窗口，后台继续追番","AniBT.Close");
      controls.Children.Add(minimize);controls.Children.Add(maximize);controls.Children.Add(close);minimize.Click+=(s,e)=>SystemCommands.MinimizeWindow(this);maximize.Click+=(s,e)=>{if(WindowState==WindowState.Maximized)SystemCommands.RestoreWindow(this);else SystemCommands.MaximizeWindow(this);};close.Click+=(s,e)=>Close();
      titlebar.Child=bar;outer.Children.Add(titlebar);Grid.SetRow(web,1);outer.Children.Add(web);
      SourceInitialized+=(s,e)=>{int corner=2;DwmSetWindowAttribute(new WindowInteropHelper(this).Handle,33,ref corner,4);ApplyTheme(dark);};
      PreviewKeyDown+=(s,e)=>{
        if(e.Key!=Key.F5||Keyboard.Modifiers!=ModifierKeys.None)return;
        e.Handled=true;
        if(e.IsRepeat)return;
        Dispatcher.BeginInvoke(new Action(()=>{
          if(!closed&&web.CoreWebView2!=null)
            web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"refresh-current-page\"}");
        }));
      };
      StateChanged+=(s,e)=>{if(WindowState!=WindowState.Minimized)restoreMax=WindowState==WindowState.Maximized;maximize.Content=WindowState==WindowState.Maximized?"\uE923":"\uE922";maximize.ToolTip=WindowState==WindowState.Maximized?"还原":"最大化";outer.Margin=WindowState==WindowState.Maximized?new Thickness(7):new Thickness(0);WriteState();UpdateActivity();};
      Loaded+=async(s,e)=>{if(background){WindowState=WindowState.Minimized;RequestAttention();}else{WindowState=restoreMax?WindowState.Maximized:WindowState.Normal;Activate();}Lifecycle("open");try{var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Program.Root,"data/webview-profile"));await web.EnsureCoreWebView2Async(environment);web.CoreWebView2.Settings.AreDevToolsEnabled=false;web.CoreWebView2.Settings.IsStatusBarEnabled=false;web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;web.CoreWebView2.Settings.IsZoomControlEnabled=true;
        web.CoreWebView2.WebMessageReceived+=async(sender,message)=>{try{if(new Uri(message.Source).GetLeftPart(UriPartial.Authority)!=origin)return;var data=Json.Deserialize<Dictionary<string,object>>(message.WebMessageAsJson);if(data.ContainsKey("type")&&Convert.ToString(data["type"])=="folder-open"){string requestId=Convert.ToString(data["id"]);try{bool foreground=await FolderWindow.Open(Convert.ToString(data["path"]));web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="folder-open-response",id=requestId,foreground=foreground}));}catch(Exception error){web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="folder-open-response",id=requestId,error=error.Message}));}return;}if(data.ContainsKey("type")&&Convert.ToString(data["type"])=="anibt-account"){string requestId=Convert.ToString(data["id"]);if(Convert.ToString(data["action"])=="capabilities"){web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="anibt-account-response",id=requestId,result=new{account=true,version="1.8.0"}}));return;}try{if(account==null)account=new AniBTAccount(this,dark,()=>web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="anibt-login-complete"})));var result=await account.Call(Convert.ToString(data["action"]),data.ContainsKey("data")?(Dictionary<string,object>)data["data"]:new Dictionary<string,object>());web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="anibt-account-response",id=requestId,result=result}));}catch(Exception error){web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="anibt-account-response",id=requestId,error=error.Message}));}return;}if(data.ContainsKey("type")&&Convert.ToString(data["type"])=="theme"){morph=data.ContainsKey("design")&&Convert.ToString(data["design"])=="morph";apple=data.ContainsKey("design")&&Convert.ToString(data["design"])=="apple";ApplyTheme(Convert.ToString(data["theme"])=="dark");}if(data.ContainsKey("type")&&Convert.ToString(data["type"])=="unread"){int count=Math.Max(0,Math.Min(999,Convert.ToInt32(data["count"])));unread=count;UpdateOverlay();}}catch{}};
        web.CoreWebView2.NewWindowRequested+=(sender,message)=>{message.Handled=true;OpenExternal(message.Uri);};
        web.CoreWebView2.NavigationStarting+=(sender,message)=>{Uri next;if(Uri.TryCreate(message.Uri,UriKind.Absolute,out next)&&next.Scheme!="about"&&next.GetLeftPart(UriPartial.Authority)!=origin){message.Cancel=true;if(message.IsUserInitiated)OpenExternal(message.Uri);}};
        web.CoreWebView2.NavigationCompleted+=(sender,args)=>UpdateActivity();
        web.Source=address;
      }catch(Exception error){status.Text="  /  界面启动失败";File.AppendAllText(Path.Combine(Program.Root,"data/native-error.log"),error+Environment.NewLine);}};
      Closed+=(s,e)=>{closed=true;activityVersion++;Lifecycle("close");if(account!=null)account.Dispose();web.Dispose();};
      string initialDesign=InitialVisualDesign();morph=initialDesign=="morph";apple=initialDesign=="apple";ApplyTheme(InitialDark());
    }
    async void UpdateActivity(){
      int version=++activityVersion;
      if(closed||web.CoreWebView2==null)return;
      bool hidden=WindowState==WindowState.Minimized;
      try{
        if(!hidden){
          web.CoreWebView2.Resume();webSuspended=false;
          web.Visibility=Visibility.Visible;
          web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="window-state",hidden=false}));
          WriteState();return;
        }
        web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="window-state",hidden=true}));
        // Let already queued draft saves complete before suspending script execution.
        await System.Threading.Tasks.Task.Delay(1200);
        if(closed||version!=activityVersion||WindowState!=WindowState.Minimized)return;
        web.Visibility=Visibility.Hidden;
        await System.Threading.Tasks.Task.Delay(50);
        if(closed||version!=activityVersion||WindowState!=WindowState.Minimized)return;
        webSuspended=await web.CoreWebView2.TrySuspendAsync();
        if(closed)return;
        if(version!=activityVersion||WindowState!=WindowState.Minimized){
          web.CoreWebView2.Resume();webSuspended=false;web.Visibility=Visibility.Visible;
          web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(new{type="window-state",hidden=false}));
        }
        WriteState();
      }catch{
        if(!closed&&WindowState!=WindowState.Minimized){web.Visibility=Visibility.Visible;}
      }
    }
    void LoadLayout(){try{var data=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Program.Root,"data/window-layout.json")));double w=Convert.ToDouble(data["width"]),h=Convert.ToDouble(data["height"]),x=Convert.ToDouble(data["left"]),y=Convert.ToDouble(data["top"]);if(Double.IsNaN(w)||Double.IsInfinity(w)||Double.IsNaN(h)||Double.IsInfinity(h)||Double.IsNaN(x)||Double.IsInfinity(x)||Double.IsNaN(y)||Double.IsInfinity(y))return;double sw=SystemParameters.VirtualScreenWidth,sh=SystemParameters.VirtualScreenHeight,sx=SystemParameters.VirtualScreenLeft,sy=SystemParameters.VirtualScreenTop;Width=Math.Max(MinWidth,Math.Min(w,sw));Height=Math.Max(MinHeight,Math.Min(h,sh));Left=Math.Max(sx,Math.Min(x,sx+sw-Width));Top=Math.Max(sy,Math.Min(y,sy+sh-Height));WindowStartupLocation=WindowStartupLocation.Manual;restoreMax=data.ContainsKey("maximized")&&Convert.ToBoolean(data["maximized"]);}catch{}}
    void SaveLayout(){try{var r=WindowState==WindowState.Normal?new Rect(Left,Top,Width,Height):RestoreBounds;if(r.IsEmpty||r.Width<MinWidth||r.Height<MinHeight)return;string target=Path.Combine(Program.Root,"data/window-layout.json"),temp=target+".tmp";File.WriteAllText(temp,Json.Serialize(new{width=r.Width,height=r.Height,left=r.Left,top=r.Top,maximized=restoreMax}));if(File.Exists(target))File.Replace(temp,target,null);else File.Move(temp,target);}catch{}}
    Button CaptionButton(string glyph,string name,string idValue) {
      var button=new Button{Content=glyph,Width=46,Height=40,FontFamily=new FontFamily("Segoe Fluent Icons"),FontSize=10,BorderThickness=new Thickness(0),ToolTip=name,Focusable=false};
      var template=new ControlTemplate(typeof(Button));var border=new FrameworkElementFactory(typeof(Border));border.SetBinding(Border.BackgroundProperty,new System.Windows.Data.Binding("Background"){RelativeSource=new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent)});var content=new FrameworkElementFactory(typeof(ContentPresenter));content.SetValue(FrameworkElement.HorizontalAlignmentProperty,HorizontalAlignment.Center);content.SetValue(FrameworkElement.VerticalAlignmentProperty,VerticalAlignment.Center);border.AppendChild(content);template.VisualTree=border;button.Template=template;
      WindowChrome.SetIsHitTestVisibleInChrome(button,true);System.Windows.Automation.AutomationProperties.SetName(button,name);System.Windows.Automation.AutomationProperties.SetAutomationId(button,idValue);
      button.MouseEnter+=(s,e)=>{button.Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(idValue=="AniBT.Close"?"#C84E68":apple?(dark?"#303033":"#E9E9EF"):morph?(dark?"#2B4353":"#D9E8ED"):dark?"#3A3048":"#EEE8F5"));if(idValue=="AniBT.Close")button.Foreground=Brushes.White;};
      button.MouseLeave+=(s,e)=>{button.Background=Brushes.Transparent;button.Foreground=new SolidColorBrush((Color)ColorConverter.ConvertFromString(ChromeForeground()));};return button;
    }
    bool InitialDark(){try{var p=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Program.Root,"data/preferences.json")));string theme=Convert.ToString(p["theme"]);if(theme=="dark")return true;if(theme=="light")return false;}catch{}try{using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"))return Convert.ToInt32(key.GetValue("AppsUseLightTheme",1))==0;}catch{return false;}}
    string InitialVisualDesign(){
      try{var p=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Program.Root,"data/preferences.json")));string value=p.ContainsKey("design")?Convert.ToString(p["design"]):"classic";return value=="morph"||value=="apple"?value:"classic";}catch{return "classic";}
    }
    string ChromeForeground(){return apple?(dark?"#F5F5F7":"#1C1C1E"):morph?(dark?"#D7EDF1":"#305466"):(dark?"#C5B6D5":"#8F7B9F");}
    void ApplyTheme(bool value){
      dark=value;
      string background=apple?(dark?"#000000":"#F2F2F7"):morph?(dark?"#101A25":"#F0F6F7"):(dark?"#11131B":"#F4F5F9");
      string bar=apple?(dark?"#1C1C1E":"#F2F2F7"):morph?(dark?"#14212C":"#F0F6F7"):(dark?"#161923":"#F5F6FA");
      Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(background));
      titlebar.Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(bar));
      titlebar.BorderBrush=new SolidColorBrush((Color)ColorConverter.ConvertFromString(apple?(dark?"#38383A":"#DDDDE3"):morph?(dark?"#2C4252":"#DCE8ED"):dark?"#2B3040":"#E8DFF1"));
      titlebar.BorderThickness=new Thickness(0,0,0,1);
      caption.Text="AniBT";
      caption.FontWeight=FontWeights.SemiBold;
      caption.Foreground=new SolidColorBrush((Color)ColorConverter.ConvertFromString(ChromeForeground()));
      status.Foreground=new SolidColorBrush((Color)ColorConverter.ConvertFromString(apple?(dark?"#A1A1AA":"#707078"):morph?(dark?"#A1AEC8":"#6C7892"):(dark?"#B49EC5":"#AA96B9")));
      foreach(var button in new[]{minimize,maximize,close}){button.Background=Brushes.Transparent;button.Foreground=new SolidColorBrush((Color)ColorConverter.ConvertFromString(ChromeForeground()));}
      web.DefaultBackgroundColor=System.Drawing.ColorTranslator.FromHtml(background);
      try{int enabled=dark?1:0;DwmSetWindowAttribute(new WindowInteropHelper(this).Handle,20,ref enabled,4);int corner=2;DwmSetWindowAttribute(new WindowInteropHelper(this).Handle,33,ref corner,4);}catch{}
      WriteState();
    }
    void WriteState(){try{Directory.CreateDirectory(Path.Combine(Program.Root,"data"));File.WriteAllText(Path.Combine(Program.Root,"data/native-window.json"),Json.Serialize(new{pid=Process.GetCurrentProcess().Id,state=WindowState.ToString(),theme=dark?"dark":"light",windowId=id,background=background,attention=attention,suspended=webSuspended,design=apple?"apple":morph?"morph":"classic"}));}catch{}}
    void Lifecycle(string action){try{var request=(HttpWebRequest)WebRequest.Create(origin+"/api/window");request.Method="POST";request.ContentType="application/json";request.Headers["X-App-Token"]=token;request.Timeout=1000;byte[] payload=Encoding.UTF8.GetBytes(Json.Serialize(new{action=action,windowId=id}));using(var stream=request.GetRequestStream())stream.Write(payload,0,payload.Length);using(var response=request.GetResponse()){} }catch{}}
    static void OpenExternal(string value){Uri uri;if(Uri.TryCreate(value,UriKind.Absolute,out uri)&&(uri.Scheme=="https"||uri.Scheme=="http"))Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});}
  }
  static class Notifications {
    [ComImport,Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
    [ComImport,InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW {
      void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder file,int max,IntPtr data,int flags);void GetIDList(out IntPtr id);void SetIDList(IntPtr id);void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder text,int max);void SetDescription([MarshalAs(UnmanagedType.LPWStr)]string text);void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder text,int max);void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)]string path);void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder text,int max);void SetArguments([MarshalAs(UnmanagedType.LPWStr)]string args);void GetHotkey(out short key);void SetHotkey(short key);void GetShowCmd(out int cmd);void SetShowCmd(int cmd);void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)]StringBuilder text,int max,out int index);void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)]string path,int index);void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)]string path,int reserved);void Resolve(IntPtr window,int flags);void SetPath([MarshalAs(UnmanagedType.LPWStr)]string path);
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey {public Guid Format;public uint Id;public PropertyKey(Guid f,uint i){Format=f;Id=i;}}
    [StructLayout(LayoutKind.Explicit,Size=24)] struct PropVariant {[FieldOffset(0)]public ushort Type;[FieldOffset(8)]public IntPtr Value;}
    [ComImport,InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {void GetCount(out uint count);void GetAt(uint index,out PropertyKey key);void GetValue(ref PropertyKey key,out PropVariant value);void SetValue(ref PropertyKey key,ref PropVariant value);void Commit();}
    public static void Register(){string folder=Environment.GetFolderPath(Environment.SpecialFolder.Programs);string file=Path.Combine(folder,"AniBT 自动追番.lnk");var link=(IShellLinkW)new ShellLink();link.SetPath(System.Reflection.Assembly.GetExecutingAssembly().Location);link.SetWorkingDirectory(Program.Root);link.SetDescription("AniBT subscriptions, resource search and download notifications");link.SetIconLocation(Path.Combine(Program.Root,"ui/anibt.ico"),0);var store=(IPropertyStore)link;var key=new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),5);var value=new PropVariant{Type=31,Value=Marshal.StringToCoTaskMemUni(Program.AppId)};try{store.SetValue(ref key,ref value);store.Commit();((IPersistFile)link).Save(file,true);}finally{Marshal.FreeCoTaskMem(value.Value);Marshal.ReleaseComObject(link);}}
    static int PowerShell(string script,string input){var p=new Process();p.StartInfo=new ProcessStartInfo("powershell.exe","-NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};p.Start();p.StandardInput.Write(input);p.StandardInput.Close();string output=p.StandardOutput.ReadToEnd(),error=p.StandardError.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0){try{File.AppendAllText(Path.Combine(Program.Root,"data/notification-error.log"),DateTime.Now+" "+error+Environment.NewLine);}catch{}}Console.Write(output);return p.ExitCode;}
    public static int Status(){return PowerShell("$ErrorActionPreference='Stop';[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;$n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('"+Program.AppId+"');if($null -eq $n.Setting){[Console]::Write('Unknown')}else{[Console]::Write($n.Setting.ToString())};","");}
    public static int Send(string title,string body,string tag){string payload=Convert.ToBase64String(Encoding.UTF8.GetBytes(title))+"|"+Convert.ToBase64String(Encoding.UTF8.GetBytes(body))+"|"+Convert.ToBase64String(Encoding.UTF8.GetBytes(tag.Length>16?tag.Substring(0,16):tag));string script=@"$ErrorActionPreference='Stop';[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;$p=[Console]::In.ReadToEnd().Split('|');$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[0]));$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]));$tag=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]));$n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AniBT.AutoDownload');if($null -ne $n.Setting -and $n.Setting.ToString() -ne 'Enabled'){throw ('Windows notification setting: '+$n.Setting)};$xml=New-Object Windows.Data.Xml.Dom.XmlDocument;$xml.LoadXml('<toast><visual><binding template=""ToastGeneric""><text>'+[Security.SecurityElement]::Escape($title)+'</text><text>'+[Security.SecurityElement]::Escape($body)+'</text></binding></visual></toast>');$toast=[Windows.UI.Notifications.ToastNotification]::new($xml);$toast.Tag=$tag;$toast.Group='downloads';$n.Show($toast);[Console]::Write('shown');";return PowerShell(script,payload);}
  }
}

