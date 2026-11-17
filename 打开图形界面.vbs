Option Explicit
Dim fso, shell, base, nodePath, candidates, candidate
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = ""
candidates = Array(base & "\runtime\node.exe", shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe", "C:\Program Files\nodejs\node.exe")
For Each candidate In candidates
  If fso.FileExists(candidate) Then
    nodePath = candidate
    Exit For
  End If
Next
If nodePath = "" Then
  MsgBox "Node.js 22+ is required. Extract the complete portable package first.", 48, "AniBT"
  WScript.Quit 1
End If
shell.CurrentDirectory = base
shell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & base & "\dist\gui.mjs" & Chr(34), 0, False
