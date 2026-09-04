; Clear Rows installer branding.
;
; Included by Tauri's NSIS template before the MUI pages are declared
; (bundle.windows.nsis.installerHooks), so MUI settings defined here shape
; the welcome, header and finish pages. Artwork comes from
; scripts/installer-art.py.

; --- Look -------------------------------------------------------------
; Dark welcome and finish pages to match the sidebar panel; the header on
; the inner pages stays light so the standard controls read correctly.
!define MUI_BGCOLOR "111214"
!define MUI_TEXTCOLOR "ECECE9"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Clear Rows is not installed yet. Leave the setup?"

; --- Welcome ----------------------------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Clear Rows"
!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_WELCOMEPAGE_TEXT "Open multi-gigabyte CSV and TSV files in a second, filter them with plain words or a click, sort, search across files and export what you found.$\r$\n$\r$\nSetup installs for your account only, so no administrator prompt.$\r$\n$\r$\nClick Next to choose where it goes."

; --- Finish -----------------------------------------------------------
!define MUI_FINISHPAGE_TITLE "Ready"
!define MUI_FINISHPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TEXT "Clear Rows is installed. Double-click any .csv or .tsv file, or drop one onto the window.$\r$\n$\r$\nCtrl K inside the app lists every command."
!define MUI_FINISHPAGE_RUN_TEXT "Open Clear Rows now"

; --- Splash -----------------------------------------------------------
; A short fade of the mark while the installer starts. advsplash ships with
; NSIS; the bitmap is extracted to the temp plugins dir and removed again.
!define MUI_CUSTOMFUNCTION_GUIINIT ClearRowsGuiInit

Function ClearRowsGuiInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\splash.bmp "${__FILEDIR__}\splash.bmp"
  ; delay 700 ms, fade in 300 ms, fade out 300 ms, no key colour
  advsplash::show 700 300 300 -1 "$PLUGINSDIR\splash"
  Pop $0
  Delete "$PLUGINSDIR\splash.bmp"
FunctionEnd
