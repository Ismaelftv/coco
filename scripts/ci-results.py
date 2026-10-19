#!/usr/bin/env python3
"""Recolhe os relatórios publicados por scripts/ci-annotate.py numa execução da CI.

Uso: ci-results.py <run_id> [--out pasta]   (requer `gh` autenticado)
Escreve um .json por relatório (nome = título da anotação).
"""
import base64, gzip, json, subprocess, sys, os, re, collections

run = sys.argv[1]
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else 'resultados-ci'
repo = os.environ.get('GITHUB_REPOSITORY', 'Ismaelftv/projetoia')

jobs = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/actions/runs/{run}/jobs', '--jq', '.jobs'], text=True))
parts = collections.defaultdict(dict)
for job in jobs:
    anns = json.loads(subprocess.check_output(['gh', 'api', f"repos/{repo}/check-runs/{job['id']}/annotations", '--jq', '.'], text=True))
    for a in anns:
        m = re.match(r'resultado:(.+):(\d+)/(\d+)$', a.get('title') or '')
        if m:
            parts[(job['name'], m.group(1))][int(m.group(2))] = (int(m.group(3)), a['message'])
os.makedirs(out, exist_ok=True)
for (job, name), chunks in parts.items():
    total = next(iter(chunks.values()))[0]
    if len(chunks) != total:
        print(f'! {job}/{name}: faltam blocos ({len(chunks)}/{total})'); continue
    raw = ''.join(chunks[i][1] for i in range(1, total + 1))
    data = gzip.decompress(base64.b64decode(raw))
    fname = re.sub(r'[^A-Za-z0-9._-]+', '_', f'{job}__{name}') + '.json'
    open(os.path.join(out, fname), 'wb').write(data)
    print('ok', fname, len(data), 'bytes')
