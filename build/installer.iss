; ATS Co-Driver — Windows installer (Inno Setup 7).
; Build:  ISCC.exe build\installer.iss   (after build\build.mjs has produced dist\ATS Co-Driver)
; Output: dist\ATS-Co-Driver-Setup-<version>.exe
;
; What it does
;   - installs the program (read-only) to Program Files; user data stays in %LOCALAPPDATA%\ATS Co-Driver
;   - Start-menu shortcut (+ optional desktop shortcut), "start now" at the end
;   - firewall rule: the bundled node.exe may accept connections from the local network only
; Uninstall
;   - stops a running Co-Driver, removes the game plugin(s) the launcher recorded in plugin-paths.txt,
;     the firewall rule, and (if the user agrees) the built map, voice and settings

#define AppName "ATS Co-Driver"
#define AppVersion "1.0.0"
#define Dist "..\dist\ATS Co-Driver"

[Setup]
AppId={{6B0C7E52-3D2F-4C8E-9C1E-0D5A1C0D7A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppComments=Free tablet GPS & dashboard for American Truck Simulator. Not affiliated with SCS Software.
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=ATS-Co-Driver-Setup-{#AppVersion}
SetupIconFile={#Dist}\codriver.ico
UninstallDisplayIcon={app}\codriver.ico
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=no

[Tasks]
Name: desktopicon; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#Dist}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\ATS Co-Driver.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\codriver.ico"; Comment: "Start ATS Co-Driver (keep the window open while you play)"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\ATS Co-Driver.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\codriver.ico"; Tasks: desktopicon

[Run]
; phones/tablets on the home Wi-Fi reach the Co-Driver server; nothing from outside the local network
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#AppName}"" dir=in action=allow program=""{app}\node\node.exe"" enable=yes profile=private,public remoteip=localsubnet"; Flags: runhidden waituntilterminated
Filename: "{app}\ATS Co-Driver.cmd"; WorkingDir: "{app}"; Description: "Start {#AppName} now"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden waituntilterminated; RunOnceId: "fwrule"

[Code]
const
  PluginName = 'ats_codriver.dll';

function UserHome(): String;
begin
  Result := ExpandConstant('{localappdata}\ATS Co-Driver');
end;

{ Stop Co-Driver started from THIS install only (exact node.exe path) — never other node programs. }
procedure StopCoDriver(AppDir: String);
var
  Code: Integer;
  Exe: String;
begin
  Exe := AddBackslash(AppDir) + 'node\node.exe';
  if not FileExists(Exe) then Exit;
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ''' + Exe + ''' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopCoDriver(ExpandConstant('{app}'));   { update over a running copy }
  Result := '';
end;

{ Remove the game plugin(s) the launcher installed. Only files named ats_codriver.dll are touched. }
procedure RemovePlugins();
var
  Lines: TArrayOfString;
  I: Integer;
  Failed: String;
begin
  Failed := '';
  if not LoadStringsFromFile(UserHome() + '\plugin-paths.txt', Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
    if (Trim(Lines[I]) <> '') and (CompareText(ExtractFileName(Trim(Lines[I])), PluginName) = 0) and FileExists(Trim(Lines[I])) then
      if not DeleteFile(Trim(Lines[I])) then Failed := Failed + #13#10 + Trim(Lines[I]);
  if (Failed <> '') and not UninstallSilent() then
    MsgBox('The game plugin could not be removed (is American Truck Simulator running?). Close the game and delete it by hand:' + Failed, mbInformation, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopCoDriver(ExpandConstant('{app}'));
    RemovePlugins();
  end;
  if (CurUninstallStep = usPostUninstall) and DirExists(UserHome()) and not UninstallSilent() then
    if MsgBox('Also delete the map built from your game, the downloaded voice and your Co-Driver settings?' + #13#10 + #13#10 + UserHome(),
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(UserHome(), True, True, True);
end;
