"""Install pinned official wheels into the managed Mac notebook runtime.

Run with runtime/python/darwin-arm64/bin/python3 -I -B. Accepts --wheel-dir for
an offline cache; otherwise pip downloads only the SHA-256-pinned PyPI wheels.
No host Python/site-packages is changed and no notebooks are executed.
"""
from pathlib import Path
import argparse, subprocess, sys, hashlib, json, shutil
root = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(); p.add_argument('--wheel-dir'); args = p.parse_args()
base = root / 'runtime/notebook'
target = base / 'darwin-arm64'
if target.exists():
    raise SystemExit('Runtime already exists; verify it or use a clean source checkout.')
command = [sys.executable, '-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-compile', '--only-binary=:all:', '--no-deps', '--require-hashes', '--target', str(target), '-r', str(base / 'requirements-darwin-arm64.lock')]
if args.wheel_dir: command += ['--no-index', '--find-links', str(Path(args.wheel_dir).resolve())]
subprocess.run(command, check=True)
print('Managed notebook dependencies installed. Run collect-notebook-runtime.py to record files and licenses.')
