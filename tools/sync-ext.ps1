# sync-ext.ps1 — one-directional sync: agent-governance (source of truth) -> npm/ package dirs + standalone repo mirrors.
# Usage: powershell -File tools\sync-ext.ps1 [-Extension session-transfer] [-WhatIf]
# README.md files are NOT synced: repo/npm copies carry their own quick-start headers.
# pi-deep-research is a hand-assembled bundle (skill + agent-directory) — sync it by hand.

param(
  [string]$Extension = "",
  [switch]$WhatIf
)

$gov   = "C:\Users\HOME\Desktop\Agentic-Engineering\repos\protokol11\agent-governance"
$proto = "C:\Users\HOME\Desktop\Agentic-Engineering\repos\protokol11"
$robocopyExclude = @("node_modules","package-lock.json",".pi","__pycache__","*.pyc","config.json","cache.json","README.md")

# name -> @{ cluster = governance subdir; pkg = npm/ + repo dir; repo = $true/$false }
$map = [ordered]@{
  "session-transfer"    = @{ cluster = "lifecycle\session-transfer";    pkg = "pi-session-transfer";    repo = $true }
  "session-manager"     = @{ cluster = "lifecycle\session-manager";     pkg = "pi-session-manager";     repo = $true }
  "memory-gov"          = @{ cluster = "extensions\memory-gov";         pkg = "pi-memory-gov";          repo = $true }
  "judgment"            = @{ cluster = "extensions\judgment";           pkg = "pi-judgment";            repo = $false }
  "todo-state"          = @{ cluster = "extensions\todo-state";         pkg = "pi-todo-state";          repo = $true }
  "orchestration-graph" = @{ cluster = "orchestration\orchestration-graph"; pkg = "pi-orchestration-graph"; repo = $true }
  "paste"               = @{ cluster = "extras\paste";                  pkg = "pi-paste";               repo = $true }
  "ask"                 = @{ cluster = "extensions\ask";                  pkg = "pi-ask";                 repo = $true }
  "session-search-lite" = @{ cluster = "extensions\session-search-lite";  pkg = "pi-session-search-lite"; repo = $true }
  "setup-upgrade"       = @{ cluster = "extras\setup-upgrade";            pkg = "pi-setup-upgrade";       repo = $true }
  "cost"                = @{ cluster = "extras\cost";                     pkg = "pi-cost";                repo = $true }
}

foreach ($name in $map.Keys) {
  if ($Extension -ne "" -and $name -ne $Extension) { continue }
  $m = $map[$name]
  $src = Join-Path $gov $m.cluster
  $common = @("/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/XD") + $robocopyExclude + @("/XF", "README.md")

  $dstNpm = Join-Path "$gov\npm" "$($m.pkg)\extensions"
  if ($WhatIf) { Write-Output "WOULD sync $name -> npm\$($m.pkg)\extensions" }
  else { robocopy $src $dstNpm @common | Out-Null }

  if ($m.repo) {
    $dstRepo = Join-Path $proto $m.pkg
    if ($WhatIf) { Write-Output "WOULD sync $name -> repos\protokol11\$($m.pkg)" }
    else { robocopy $src $dstRepo @common | Out-Null }
  }
  Write-Output "SYNCED $name"
}
Write-Output "Done. pi-deep-research: sync by hand (bundle of skill + agent-directory)."
