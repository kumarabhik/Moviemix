param(
  [string]$Namespace = "moviemix"
)

Write-Host "Scaling all deployments to 0 in namespace: $Namespace"
kubectl -n $Namespace scale deploy --all --replicas=0

Write-Host "Pods after scale-down:"
kubectl get pods -n $Namespace
