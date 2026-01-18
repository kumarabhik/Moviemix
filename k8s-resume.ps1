param(
  [string]$Namespace = "moviemix"
)

Write-Host "Scaling all deployments to 1 in namespace: $Namespace"
kubectl -n $Namespace scale deploy --all --replicas=1

Write-Host ""
Write-Host "Waiting for core services to be ready..."

kubectl -n $Namespace rollout status deploy/recommender --timeout=300s
kubectl -n $Namespace rollout status deploy/backend --timeout=300s
kubectl -n $Namespace rollout status deploy/frontend --timeout=300s

Write-Host ""
Write-Host "Pods after scale-up:"
kubectl get pods -n $Namespace

Write-Host ""
Write-Host "Checking recommender data folder (PVC persistence check):"
kubectl -n $Namespace exec deploy/recommender -- sh -lc "ls -lah /app/data | head -20"

Write-Host ""
Write-Host "Next step (run this manually):"
Write-Host "  minikube service frontend -n $Namespace --url"
