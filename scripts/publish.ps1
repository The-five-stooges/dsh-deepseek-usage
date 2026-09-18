<#
.SYNOPSIS
  Publish the dsh-deepseek-usage plugin to a git host and cut its first release.

.DESCRIPTION
  Everything here is already prepared and committed locally; this script only performs the
  steps that need YOUR credentials, so it is written to be run by you (or by an agent you have
  authenticated). It is idempotent enough to re-run: an existing remote is left alone, an
  existing tag aborts, an existing release asset is replaced.

  It does NOT touch the DSH host process, the profile, or runtime\.

.EXAMPLE
  pwsh -File publish.ps1 -Platform github -Owner myname
  pwsh -File publish.ps1 -Platform gitee  -Owner myname -Repo dsh-deepseek-usage
#>
[CmdletBinding()]
param(
  # github | gitee | gitlab — decides the remote URL shape and the release tooling.
  [ValidateSet('github', 'gitee', 'gitlab')]
  [string]$Platform = 'github',

  # Your account name on that host (REQUIRED — there is no reliable way to guess it).
  [Parameter(Mandatory = $true)]
  [string]$Owner,

  [string]$Repo = 'dsh-deepseek-usage',

  # Release tag; the tarball asset name stays version-free on purpose (see the contributing
  # guide: `latest/download/<name>` resolves `latest` but takes the filename literally, so a
  # versioned asset name 404s after the next release).
  [string]$Tag = 'v0.1.0',

  # Where the built tarball lives.
  [string]$Tarball = 'E:\deepseek workspace\awesome-submission\release\dsh-deepseek-usage.tgz',

  [string]$PackageDir = 'C:\Users\Administrator\AppData\Local\DSH-Portable\launcher\home\plugins\dsh-deepseek-usage'
)

$ErrorActionPreference = 'Stop'

function Say($text) { Write-Host $text }

# ---------------------------------------------------------------- preflight
Say "== preflight =="
if (-not (Test-Path $PackageDir)) { throw "package dir not found: $PackageDir" }
if (-not (Test-Path $Tarball)) { throw "tarball not found: $Tarball — build it with: npm pack (then rename the asset to dsh-deepseek-usage.tgz)" }

Push-Location $PackageDir
try {
  $dirty = & git status --porcelain
  if ($dirty) { throw "working tree is dirty — commit first:`n$dirty" }
  $head = & git rev-parse --short HEAD
  Say "  local commit : $head"
  Say "  tarball      : $Tarball"

  $remote = switch ($Platform) {
    'github' { "https://github.com/$Owner/$Repo.git" }
    'gitee'  { "https://gitee.com/$Owner/$Repo.git" }
    'gitlab' { "https://gitlab.com/$Owner/$Repo.git" }
  }
  Say "  target remote: $remote"

  # ------------------------------------------------------------- remote
  Say ""
  Say "== remote =="
  # `git remote get-url` writes to stderr when origin is absent, and PowerShell 5.1 turns
  # that into a terminating error under ErrorActionPreference=Stop — read it defensively.
  $existing = $null
  try { $existing = (& git remote get-url origin 2>$null) } catch { $existing = $null }
  if ([string]::IsNullOrWhiteSpace($existing)) {
    & git remote add origin $remote
    Say "  added origin"
  } elseif ($existing -ne $remote) {
    Say "  origin already set to $existing (leaving it alone; expected $remote)"
  } else {
    Say "  origin already correct"
  }

  Say ""
  Say "== create the repository on $Platform (do this before pushing) =="
  switch ($Platform) {
    'github' {
      Say "  Option A (gh CLI, also creates it in one step):"
      Say "    gh auth login"
      Say "    gh repo create $Owner/$Repo --public --source . --remote origin --push"
      Say "    gh repo edit $Owner/$Repo --add-topic dsh-plugin --description `"DSH plugin: DeepSeek balance row and locally estimated usage popover`""
      Say "  Option B (web): create an EMPTY repo named $Repo, then come back and run:"
      Say "    git push -u origin main"
      Say "  Then add the required topic manually: Settings → Topics → dsh-plugin"
    }
    'gitee' {
      Say "  Create an empty repo named $Repo at https://gitee.com/projects/new, then:"
      Say "    git push -u origin main"
      Say "  (Gitee has no topics; the awesome-list requires a GitHub repo, so a Gitee-only"
      Say "   publication cannot be submitted there.)"
    }
    'gitlab' {
      Say "  Create an empty project named $Repo on your GitLab, then:"
      Say "    git push -u origin main"
    }
  }

  Say ""
  Say "== push (run manually once the repo exists) =="
  Say "  git push -u origin main"

  # ------------------------------------------------------------- release
  Say ""
  Say "== release $Tag with the prebuilt tarball =="
  switch ($Platform) {
    'github' {
      Say "  git tag $Tag && git push origin $Tag"
      Say "  gh release create $Tag `"$Tarball`" --title `"$Tag`" --notes `"First release.`""
      Say ""
      Say "  The asset name must be exactly: dsh-deepseek-usage.tgz"
      Say "  (gh renames nothing; the file already has that name.)"
    }
    'gitee' {
      Say "  git tag $Tag && git push origin $Tag"
      Say "  Then attach $Tarball to the release in the Gitee web UI as: dsh-deepseek-usage.tgz"
    }
    'gitlab' {
      Say "  git tag $Tag && git push origin $Tag"
      Say "  Then attach $Tarball via CI or the Releases UI as: dsh-deepseek-usage.tgz"
    }
  }

  Say ""
  Say "== verify the release URL resolves (replace owner) =="
  switch ($Platform) {
    'github' { Say "  curl -sSI https://github.com/$Owner/$Repo/releases/latest/download/dsh-deepseek-usage.tgz | Select-String '^HTTP'" }
    'gitee'  { Say "  curl -sSI https://gitee.com/$Owner/$Repo/releases/download/$Tag/dsh-deepseek-usage.tgz | Select-String '^HTTP'" }
    'gitlab' { Say "  check the asset link in the GitLab release UI" }
  }

  Say ""
  Say "== after the repo is public =="
  Say "  1. Set the repository URL in every file that names it (the entry file, README,"
  Say "     package.json repository/homepage/bugs) — substitute $Owner, then re-commit."
  Say "  2. The awesome-list submission is ready at:"
  Say "     E:\deepseek workspace\awesome-submission\data\plugins\<owner>__<repo>.yml"
  Say "  3. Submit it only after the repo is >= 1 day old (CI enforces that floor)."
}
finally {
  Pop-Location
}
