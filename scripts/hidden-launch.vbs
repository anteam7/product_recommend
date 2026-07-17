' hidden-launch.vbs - run a console command with no visible window.
'
' Windows Task Scheduler runs its action directly in the interactive session,
' so any console program (node.exe, wsl.exe, powershell.exe, *.cmd) flashes a
' terminal window on every fire. wscript.exe is a GUI-subsystem host and never
' allocates a console, so routing the action through this script makes the run
' completely invisible. Waits for the child and propagates its exit code, so
' Task Scheduler still reports real duration and "Last Run Result".
'
' Usage (Task Scheduler action):
'   Program:   wscript.exe
'   Arguments: "<path>\hidden-launch.vbs" <original program> <original args...>
'
' Any path containing a space MUST be quoted by the caller in the task's
' Arguments field - Task Scheduler splits on spaces before this script sees
' them, so an unquoted C:\Program Files\... arrives as two separate arguments.
'
' Only arguments that contain a space get re-quoted below. This is deliberate:
' wsl.exe does not parse quoted flags - "-d" "Ubuntu" makes it exit 0 without
' running anything (a silent no-op), so blanket-quoting every token would break
' the WSL crons invisibly. Quoting only space-bearing tokens reproduces the
' original command line exactly.
'
' ASCII only (wscript reads ANSI by default).

Option Explicit
Dim sh, cmd, i, a, rc

If WScript.Arguments.Count = 0 Then WScript.Quit 2

cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If i > 0 Then cmd = cmd & " "
  If InStr(a, " ") > 0 Then
    cmd = cmd & """" & a & """"
  Else
    cmd = cmd & a
  End If
Next

' Never let a failed launch raise a modal error dialog: wscript would sit there
' forever waiting for a click nobody can see, and the task would hang in
' "running" state instead of reporting a failure.
On Error Resume Next
Set sh = CreateObject("WScript.Shell")
rc = sh.Run(cmd, 0, True)
If Err.Number <> 0 Then
  WScript.Quit 9009
End If
On Error Goto 0

WScript.Quit rc
