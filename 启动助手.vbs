Option Explicit
Dim shell, files, root, nodePath, launchCmd, folder, candidate
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
nodePath = ""
For Each folder In Split(shell.Environment("Process")("PATH"), ";")
  folder = Replace(Trim(folder), Chr(34), "")
  If Len(folder) > 0 Then
    candidate = files.BuildPath(folder, "node.exe")
    If files.FileExists(candidate) Then
      nodePath = candidate
      Exit For
    End If
  End If
Next
If Len(nodePath) = 0 Then
  MsgBox "Node.js 24 or later is required. Install Node.js and restart the application.", vbExclamation, "Free Game Keeper"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
launchCmd = Chr(34) & nodePath & Chr(34) & " --disable-warning=ExperimentalWarning " & Chr(34) & files.BuildPath(files.BuildPath(root, "src"), "cli.mjs") & Chr(34) & " serve"
WScript.Quit shell.Run(launchCmd, 0, True)
