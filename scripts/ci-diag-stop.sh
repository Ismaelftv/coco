#!/usr/bin/env bash
# Diagnóstico: quanto tempo demora um contentor a parar depois de `docker kill`/`rm -f` neste anfitrião.
# Uso: scripts/ci-diag-stop.sh [imagem]   (por omissão, a de config/sandbox-image.txt)
IMG=${1:-$(cat "$(dirname "$0")/../config/sandbox-image.txt")}
name="forja-diag-$$"
echo "os: $(. /etc/os-release; echo "$PRETTY_NAME") | kernel $(uname -r)"
docker version --format 'docker server {{.Server.Version}}' 2>&1
docker info --format 'storage={{.Driver}} cgroup={{.CgroupVersion}} cgroupdriver={{.CgroupDriver}} runtime={{.DefaultRuntime}} init={{.InitBinary}} sec={{json .SecurityOptions}}' 2>&1
docker run -d --rm --init --name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$IMG" node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 || echo "run falhou"
sleep 1
echo "antes do kill: $(docker ps -a --filter "name=$name" --format '{{.Status}}')"
t0=$(date +%s%N)
out=$(docker kill "$name" 2>&1); echo "kill rc=$? out=$out ($(( ($(date +%s%N)-t0)/1000000 )) ms)"
t0=$(date +%s%N)
out=$(docker rm -f "$name" 2>&1); echo "rm -f rc=$? out=$out ($(( ($(date +%s%N)-t0)/1000000 )) ms)"
for i in $(seq 1 16); do
  echo "+$(( i*250 )) ms: ps=[$(docker ps --filter "name=$name" --format '{{.Status}}')] ps-a=[$(docker ps -a --filter "name=$name" --format '{{.Status}}')]"
  sleep 0.25
done
docker rm -f "$name" >/dev/null 2>&1 || true
