$ext = "C:\Users\HOME\.pi\agent\extensions"
$gov = "C:\Users\HOME\Desktop\Agentic-Engineering\repos\protokol11\agent-governance"
$map = [ordered]@{
  "session-transfer"     = "lifecycle\session-transfer"
  "session-manager"      = "lifecycle\session-manager"
  "memory-gov"           = "extensions\memory-gov"
  "judgment"             = "extensions\judgment"
  "todo-state"           = "extensions\todo-state"
  "orchestration-graph"  = "orchestration\orchestration-graph"
  "paste"                = "extras\paste"
  "ask"                  = "extensions\ask"
  "session-search-lite"  = "extensions\session-search-lite"
  "setup-upgrade"        = "extras\setup-upgrade"
  "cost"                 = "extras\cost"
}
foreach ($k in $map.Keys) {
  $link = Join-Path $ext $k
  $target = Join-Path $gov $map[$k]
  if (Test-Path $link) { Write-Output "SKIP $link exists"; continue }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Output "OK $k -> $($map[$k])"
}
