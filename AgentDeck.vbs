' Starts AgentDeck in its own window with no console. Double-click to run.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
node = "node"
If shell.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
  node = ""
  For Each candidate In Array(shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"))
    If fso.FileExists(candidate) Then node = """" & candidate & """"
  Next
End If
If node = "" Then
  MsgBox "AgentDeck needs Node.js 18 or later, and none was found." & vbCrLf & "Install it from https://nodejs.org and run AgentDeck again.", 48, "AgentDeck"
Else
  shell.Run node & " """ & dir & "\server.js""", 0, False
End If
