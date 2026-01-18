param(
  [string]$Namespace = "moviemix",
  [string]$K8sDir = ".\infra\k8s",
  [string]$JwtSecretValue = "super_secret_key_change_me"
)

$ErrorActionPreference = "Stop"

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

  # Create / update backend-secrets with jwt_secret
  # We use "apply" from generated YAML so it's idempotent.
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
  kubectl -n $Namespace rollout status deploy/recommender --timeout=300s | Out-Host
  kubectl -n $Namespace rollout status deploy/backend --timeout=300s | Out-Host
  kubectl -n $Namespace rollout status deploy/frontend --timeout=300s | Out-Host

}

# ---- Sanity checks ----
if (!(Test-Path $K8sDir)) {
  throw "K8s directory not found: $K8sDir"
}

# ---- Apply in dependency order ----
Apply-Manifest (Join-Path $K8sDir "namespace.yaml")

# ✅ Ensure backend JWT secret exists BEFORE backend deploy starts
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
