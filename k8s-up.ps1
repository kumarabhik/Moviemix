param(
  [string]$Namespace = "moviemix",
  [string]$K8sDir = ".\infra\k8s",
  [string]$JwtSecretValue = ""
)

$ErrorActionPreference = "Stop"

function New-RandomSecret {
  param([int]$Length = 64)
  $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  -join (1..$Length | ForEach-Object { $chars[(Get-Random -Minimum 0 -Maximum $chars.Length)] })
}

function Apply-Manifest {
  param([string]$Path)

  if (!(Test-Path $Path)) {
    throw "Manifest not found: $Path"
  }

  Write-Host "Applying manifest: $Path"
  kubectl apply -f $Path | Out-Host
}

function Ensure-BackendSecrets {
  param(
    [string]$Ns,
    [string]$JwtVal
  )

  if ([string]::IsNullOrWhiteSpace($JwtVal)) {
    $existingSecretB64 = kubectl -n $Ns get secret backend-secrets -o jsonpath='{.data.jwt_secret}' 2>$null
    if ($LASTEXITCODE -eq 0 -and ![string]::IsNullOrWhiteSpace($existingSecretB64)) {
      try {
        $JwtVal = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($existingSecretB64))
        Write-Host "Reusing existing jwt_secret from backend-secrets."
      } catch {
        $JwtVal = ""
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($JwtVal)) {
    $JwtVal = New-RandomSecret -Length 64
    Write-Host "Generated strong JWT secret for backend-secrets."
  }

  # Create / update backend-secrets with jwt_secret (idempotent via apply).
  Write-Host "Ensuring secret: backend-secrets (jwt_secret) in namespace: $Ns"

  $secretYaml = @"
apiVersion: v1
kind: Secret
metadata:
  name: backend-secrets
  namespace: $Ns
type: Opaque
stringData:
  jwt_secret: "$JwtVal"
"@

  $secretYaml | kubectl apply -f - | Out-Host
}

function Wait-For-Ready {
  param(
    [string]$Ns,
    [int]$TimeoutSeconds = 300
  )

  Write-Host "Waiting for pods in namespace: $Ns (timeout: $TimeoutSeconds s)"
  $timeoutArg = "$($TimeoutSeconds)s"
  kubectl -n $Ns rollout status deploy/recommender --timeout=$timeoutArg | Out-Host
  kubectl -n $Ns rollout status deploy/backend --timeout=$timeoutArg | Out-Host
  kubectl -n $Ns rollout status deploy/frontend --timeout=$timeoutArg | Out-Host

}

# ---- Sanity checks ----
if (!(Test-Path $K8sDir)) {
  throw "K8s directory not found: $K8sDir"
}

# ---- Apply in dependency order ----
Apply-Manifest (Join-Path $K8sDir "namespace.yaml")

# Ensure backend JWT secret exists BEFORE backend deploy starts
Ensure-BackendSecrets -Ns $Namespace -JwtVal $JwtSecretValue

# DB first so backend can connect
Apply-Manifest (Join-Path $K8sDir "db.yaml")
Apply-Manifest (Join-Path $K8sDir "recommender-pvc.yaml")

# Backend dependencies
Apply-Manifest (Join-Path $K8sDir "recommender.yaml")
Apply-Manifest (Join-Path $K8sDir "backend.yaml")

# Frontend depends on backend service DNS
Apply-Manifest (Join-Path $K8sDir "frontend.yaml")

# Airflow last (usually depends on DB)
Apply-Manifest (Join-Path $K8sDir "airflow.yaml")

# ---- Show status ----
Write-Host ""
Write-Host "Current pods:"
kubectl get pods -n $Namespace | Out-Host

Write-Host ""
Write-Host "Current services:"
kubectl get svc -n $Namespace | Out-Host

# ---- Wait for readiness (optional) ----
try {
  Wait-For-Ready -Ns $Namespace -TimeoutSeconds 300
} catch {
  Write-Host "Some pods are not Ready yet. Showing details:"
  kubectl get pods -n $Namespace | Out-Host
}

Write-Host ""
Write-Host "Done. To open the frontend:"
Write-Host "  minikube service frontend -n $Namespace"


Write-Host "Checking recommender data folder..."
kubectl -n $Namespace exec deploy/recommender -- sh -lc "ls -lah /app/data | head -20" | Out-Host
