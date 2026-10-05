' Starts AgentDeck in its own window with no console. Double-click to run.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run "node """ & dir & "\server.js"" --window", 0, False
