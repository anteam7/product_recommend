' work-agent launcher - runs the keep-alive cmd hidden (no console window).
' Placed in Startup folder so the remote work-instruction executor auto-starts at logon.
' ASCII only (wscript reads ANSI by default).
CreateObject("WScript.Shell").Run "cmd /c """ & "C:\Web\jimscanner-personal\scripts\work-agent.cmd" & """", 0, False
