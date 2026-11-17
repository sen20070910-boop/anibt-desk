using System;
using System.IO;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AniBTDesktop {
  sealed class AniBTAccount : IDisposable {
    readonly Window owner; readonly bool dark; readonly Action completed;
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly Dictionary<string,TaskCompletionSource<Dictionary<string,object>>> pending=new Dictionary<string,TaskCompletionSource<Dictionary<string,object>>>();
    readonly System.Threading.SemaphoreSlim gate=new System.Threading.SemaphoreSlim(1,1);
    Window panel;WebView2 view;TextBlock hint;Task initialization;bool disposed;
    public AniBTAccount(Window owner,bool dark,Action completed){this.owner=owner;this.dark=dark;this.completed=completed;}
    async Task Initialize(){
      panel=new Window{Title="AniBT 官方登录 · anibt.net",Width=1100,Height=850,MinWidth=780,MinHeight=620,Left=-30000,Top=-30000,WindowStartupLocation=WindowStartupLocation.Manual,ShowActivated=false,ShowInTaskbar=false,WindowStyle=WindowStyle.None,ResizeMode=ResizeMode.CanResize,Owner=owner,Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(dark?"#25202E":"#F7F7FA"))};
      WindowChrome.SetWindowChrome(panel,new WindowChrome{CaptionHeight=40,ResizeBorderThickness=new Thickness(6),GlassFrameThickness=new Thickness(0),UseAeroCaptionButtons=false});
      var grid=new Grid();grid.RowDefinitions.Add(new RowDefinition{Height=new GridLength(40)});grid.RowDefinitions.Add(new RowDefinition());grid.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});panel.Content=grid;
      var caption=new Grid{Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(dark?"#292234":"#F2EDF8"))};var title=new TextBlock{Text="AniBT 官方账号 · https://anibt.net",Margin=new Thickness(18,0,60,0),VerticalAlignment=VerticalAlignment.Center,FontSize=12,Foreground=new SolidColorBrush((Color)ColorConverter.ConvertFromString(dark?"#DAC7ED":"#79628E"))};caption.Children.Add(title);
      var close=new Button{Content="×",Width=46,Height=40,HorizontalAlignment=HorizontalAlignment.Right,Background=Brushes.Transparent,BorderThickness=new Thickness(0),Foreground=title.Foreground,FontSize=19};WindowChrome.SetIsHitTestVisibleInChrome(close,true);close.Click+=(s,e)=>panel.Hide();caption.Children.Add(close);grid.Children.Add(caption);
      view=new WebView2();Grid.SetRow(view,1);grid.Children.Add(view);
      var footer=new StackPanel{Margin=new Thickness(18,12,18,14)};hint=new TextBlock{Text="请在官方页面完成登录。密码和登录会话保留在本机的专用浏览器资料中。",TextWrapping=TextWrapping.Wrap,Foreground=title.Foreground,FontSize=12};footer.Children.Add(hint);
      var done=new Button{Content="已完成登录，返回工具",HorizontalAlignment=HorizontalAlignment.Right,Padding=new Thickness(20,9,20,9),Margin=new Thickness(0,9,0,0),Background=new SolidColorBrush(Color.FromRgb(170,140,221)),Foreground=Brushes.White,BorderThickness=new Thickness(0)};footer.Children.Add(done);Grid.SetRow(footer,2);grid.Children.Add(footer);
      done.Click+=async(s,e)=>{done.IsEnabled=false;try{var result=await Call("session",new Dictionary<string,object>());if(!Convert.ToBoolean(result["loggedIn"])){hint.Text="尚未检测到登录，请先完成官方页面中的登录。";return;}panel.Hide();completed();}catch{hint.Text="登录状态暂时无法确认，请稍后重试。";}finally{done.IsEnabled=true;}};
      panel.Closing+=(s,e)=>{if(!disposed){e.Cancel=true;panel.Hide();}};
      panel.Show();var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Program.Root,"data/anibt-account-profile"));await view.EnsureCoreWebView2Async(environment);view.CoreWebView2.Settings.AreDevToolsEnabled=false;view.CoreWebView2.Settings.IsStatusBarEnabled=false;view.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
      await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("if(location.origin==='https://anibt.net'){try{localStorage.setItem('theme','"+(dark?"dark":"light")+"');}catch{}}");
      view.CoreWebView2.NavigationStarting+=(s,e)=>{Uri uri;if(!Uri.TryCreate(e.Uri,UriKind.Absolute,out uri)||uri.Scheme!="https"||!(uri.Host=="anibt.net"||uri.Host=="bgm.tv"||uri.Host=="bangumi.tv"||uri.Host=="chii.in"))e.Cancel=true;};
      view.CoreWebView2.NewWindowRequested+=(s,e)=>{e.Handled=true;Uri uri;if(Uri.TryCreate(e.Uri,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&(uri.Host=="anibt.net"||uri.Host=="bgm.tv"||uri.Host=="bangumi.tv"||uri.Host=="chii.in"))view.CoreWebView2.Navigate(uri.AbsoluteUri);};
      view.CoreWebView2.WebMessageReceived+=(s,e)=>{try{var uri=new Uri(e.Source);if(uri.Scheme!="https"||uri.Host!="anibt.net")return;var data=json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);if(Convert.ToString(data["type"])!="anibt-account-result")return;var id=Convert.ToString(data["id"]);TaskCompletionSource<Dictionary<string,object>> task;if(!pending.TryGetValue(id,out task))return;pending.Remove(id);if(data.ContainsKey("error"))task.TrySetException(new Exception(Convert.ToString(data["error"])));else task.TrySetResult((Dictionary<string,object>)data["result"]);}catch{}};
      var loaded=new TaskCompletionSource<bool>();EventHandler<CoreWebView2NavigationCompletedEventArgs> handler=null;handler=(s,e)=>{view.CoreWebView2.NavigationCompleted-=handler;loaded.TrySetResult(e.IsSuccess);};view.CoreWebView2.NavigationCompleted+=handler;view.CoreWebView2.Navigate("https://anibt.net/subscriptions");
      if(await Task.WhenAny(loaded.Task,Task.Delay(25000))!=loaded.Task)throw new Exception("AniBT 登录页面加载超时，请检查网络后重试。");panel.Hide();
    }
    async Task Ready(){if(initialization==null)initialization=Initialize();try{await initialization;}catch{initialization=null;if(panel!=null){disposed=true;panel.Close();disposed=false;}throw;}}
    public async Task<Dictionary<string,object>> Call(string action,Dictionary<string,object> data){
      if(!new HashSet<string>{"session","identity","memberships","list","subscribe","unsubscribe","login","refresh"}.Contains(action))throw new Exception("不支持的 AniBT 操作。");
      await Ready();if(action=="login"){panel.Left=Math.Max(0,owner.Left+(owner.ActualWidth-panel.Width)/2);panel.Top=Math.Max(0,owner.Top+(owner.ActualHeight-panel.Height)/2);panel.ShowActivated=true;panel.ShowInTaskbar=true;panel.Show();panel.Activate();return new Dictionary<string,object>{{"opened",true}};}
      await gate.WaitAsync();string id=Guid.NewGuid().ToString("N");try{
        var uri=new Uri(view.CoreWebView2.Source);if(uri.Host!="anibt.net")throw new Exception("请先完成 AniBT 官方登录流程。");
        if(action=="refresh"){var loaded=new TaskCompletionSource<bool>();EventHandler<CoreWebView2NavigationCompletedEventArgs> handler=null;handler=(s,e)=>{view.CoreWebView2.NavigationCompleted-=handler;loaded.TrySetResult(e.IsSuccess);};view.CoreWebView2.NavigationCompleted+=handler;view.CoreWebView2.Reload();if(await Task.WhenAny(loaded.Task,Task.Delay(25000))!=loaded.Task)throw new Exception("AniBT 账号页面刷新超时，请重试。");return new Dictionary<string,object>{{"ok",true}};}
        var task=new TaskCompletionSource<Dictionary<string,object>>();pending[id]=task;string bridge=File.ReadAllText(Path.Combine(Program.Root,"ui/anibt-site-bridge.js"));
        await view.CoreWebView2.ExecuteScriptAsync(bridge+"\nwindow.__anibtDesktopCall("+json.Serialize(id)+","+json.Serialize(action)+","+json.Serialize(data)+");");
        if(await Task.WhenAny(task.Task,Task.Delay(30000))!=task.Task)throw new Exception("AniBT 操作响应超时，请刷新网站订阅状态后重试。");return await task.Task;
      }finally{pending.Remove(id);gate.Release();}
    }
    public void Dispose(){disposed=true;foreach(var task in new List<TaskCompletionSource<Dictionary<string,object>>>(pending.Values))task.TrySetCanceled();pending.Clear();if(view!=null)view.Dispose();if(panel!=null)panel.Close();}
  }
}
