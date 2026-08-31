// The snn: URI handler: Windows ShellExecutes this (via wscript //B, no
// window) when a toast raised by notify-action.ps1 is clicked. It writes the
// stamped click line the in-Steam bridge polls -- the same file and format
// the POSIX helper writes, so everything past this point is shared.
//
// The argument arrives from a toast's launch attribute through the shell, so
// it is validated against the one shape ever emitted and everything else is
// dropped: nothing here may ever be interpreted as a path or a command.
var arg = WScript.Arguments.length > 0 ? WScript.Arguments(0) : "";
var match = /^snn:replay\/([A-Za-z0-9_.\-]+)$/.exec(arg);
if (match) {
	var fso = new ActiveXObject("Scripting.FileSystemObject");
	var dir = fso.GetParentFolderName(WScript.ScriptFullName);
	var epoch = Math.round(new Date().getTime() / 1000);
	var tmp = dir + "\\.click.tmp";
	var out = fso.CreateTextFile(tmp, true);
	out.Write(epoch + "|replay:" + match[1]);
	out.Close();
	// Move, not write-in-place, so the bridge's poll never reads a half
	// write; a lost race against another click just drops one of them.
	if (fso.FileExists(dir + "\\.click")) {
		fso.DeleteFile(dir + "\\.click");
	}
	fso.MoveFile(tmp, dir + "\\.click");
}
