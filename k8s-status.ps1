param(
  [string]$Namespace = "moviemix"
)

Write-Host "=== Deployments ==="
kubectl get deploy -n $Namespace

Write-Host "`n=== Pods ==="
kubectl get pods -n $Namespace

Write-Host "`n=== Services ==="
kubectl get svc -n $Namespace
