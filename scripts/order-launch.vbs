' jimorder:// protocol handler - ensure order-server is running, then open the order page.
' Registered in HKCU\Software\Classes\jimorder (see scripts/register-jimorder-protocol.ps1).
' Flow: admin page [purchase] button -> health probe fails -> jimorder://order/<orderId>
'       -> this script starts order-server.cmd (keep-alive loop) if port 39201 is down,
'          waits for /health, then opens http://127.0.0.1:39201/order?id=<orderId>.
' ASCII only (wscript reads ANSI by default).
Option Explicit
Dim arg, id, parts, i, sh, http, ok, started

arg = ""
If WScript.Arguments.Count > 0 Then arg = WScript.Arguments(0)
' arg looks like jimorder://order/25100197337246 (trailing slash possible)
id = ""
parts = Split(Replace(arg, "jimorder://", ""), "/")
For i = UBound(parts) To 0 Step -1
  If parts(i) <> "" Then id = parts(i) : Exit For
Next
' numeric guard: id goes into a shell command line - reject anything non-numeric
If id = "" Or Not IsNumeric(id) Then WScript.Quit 1

Set sh = CreateObject("WScript.Shell")
ok = False
started = False
On Error Resume Next
For i = 1 To 40 ' ~20s max wait
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.Open "GET", "http://127.0.0.1:39201/health", False
  http.SetTimeouts 500, 500, 500, 500
  Err.Clear
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ok = True : Exit For
  End If
  If Not started Then
    ' server down -> start keep-alive loop hidden (loop itself skips if port is taken)
    sh.Run "cmd /c """ & "C:\Web\jimscanner-personal\scripts\order-server.cmd" & """", 0, False
    started = True
  End If
  WScript.Sleep 500
Next
On Error Goto 0

If ok Then
  sh.Run "http://127.0.0.1:39201/order?id=" & id
Else
  MsgBox "order-server (127.0.0.1:39201) start failed - check %TEMP%\order-server.log", 48, "jimorder"
End If
