#!/usr/bin/env python3
"""Verify a reviewed source archive and publish a browsable source tree.

Runs locally in check mode or in GitHub Actions with --write. It uses no account
credentials and never changes the repository README, workflows or permissions.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import stat
import zipfile

PROFILES = {
    'inkspace': {
        'manifest': 'source-manifest.json', 'prefix': 'inkspace/',
        'directories': {'desktop', 'ios', 'obsidian', 'docs', 'scripts'},
        'files': {'.gitignore', '.gitattributes', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'},
    },
    'inkspace-modules': {
        'manifest': 'source-tree-manifest.json', 'prefix': 'inkspace-modules/',
        'directories': {'packages', 'swift', 'ui', 'integrations', 'scripts'},
        'files': {'.gitignore', '.gitattributes', 'LICENSE', 'README.md', 'Package.swift', 'package.json',
                  'package-lock.json', 'modules.json', 'swift-modules.json', 'FEATURES.md',
                  'VALIDATION.md', 'NODE-VALIDATION.md', 'coverage-audit.json'},
    },
}
FORBIDDEN = {'.git', '.github', 'node_modules', '__pycache__', '.build', '.swiftpm', 'dist',
             'DerivedData', 'publisher', '.env', 'vault', 'private', 'xcuserdata'}
STATE = '.source-tree-state.json'
MAX_TOTAL = 128 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(value):
    if not isinstance(value, str) or '\\' in value or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid source path')
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or '..' in p.parts or '.' in value.split('/'):
        raise ValueError('Unsafe source path')
    if any(x in FORBIDDEN for x in p.parts):
        raise ValueError('Unpublishable source directory')
    return p


def safe_target(root, name):
    result = root.joinpath(*PurePosixPath(name).parts)
    for ancestor in [result, *result.parents]:
        if ancestor == root.parent:
            break
        if ancestor.is_symlink():
            raise ValueError('Symbolic link in publication destination')
    result.resolve().relative_to(root.resolve())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=PROFILES, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    root = Path.cwd().resolve()
    profile = PROFILES[args.profile]
    manifest = json.loads((root / profile['manifest']).read_text())
    archive_name = manifest['archive']
    if PurePosixPath(archive_name).name != archive_name or not archive_name.endswith('.zip'):
        raise ValueError('Invalid source archive name')
    archive = root / archive_name
    if archive.stat().st_size > MAX_TOTAL or digest(archive.read_bytes()) != manifest['archiveSha256']:
        raise ValueError('Source archive digest mismatch')
    rows = manifest.get('sourceFiles', manifest.get('files'))
    if not isinstance(rows, list) or not rows:
        raise ValueError('Missing reviewed source manifest')
    expected = {}
    for row in rows:
        path = relative_path(row['path'])
        if len(path.parts) == 1:
            if str(path) not in profile['files']:
                raise ValueError('Unknown top-level source input')
        elif path.parts[0] not in profile['directories']:
            raise ValueError('Unknown source directory')
        if str(path) in expected:
            raise ValueError('Duplicate source manifest member')
        expected[str(path)] = row['sha256']
    planned = {}
    total = 0
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        if len(members) != len(expected):
            raise ValueError('Source archive member count mismatch')
        seen = set()
        for member in members:
            if not member.filename.startswith(profile['prefix']):
                raise ValueError('Unexpected source archive root')
            path = str(relative_path(member.filename[len(profile['prefix']):]))
            if path not in expected or path in seen or member.is_dir() or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('Invalid source archive member')
            total += member.file_size
            if total > MAX_TOTAL or member.file_size > 32 * 1024 * 1024:
                raise ValueError('Source archive exceeds publication limit')
            data = z.read(member)
            if digest(data) != expected[path]:
                raise ValueError('Source member digest mismatch')
            target = 'SOURCE_README.md' if path == 'README.md' else path
            planned[target] = data
            seen.add(path)
    previous = json.loads((root / STATE).read_text())['files'] if (root / STATE).is_file() else {}
    for name in previous:
        path = relative_path(name)
        if name == 'SOURCE_README.md':
            continue
        if len(path.parts) == 1:
            if name == 'README.md' or name not in profile['files']:
                raise ValueError('Invalid previously managed source file')
        elif path.parts[0] not in profile['directories']:
            raise ValueError('Invalid previously managed source directory')
    for name in set(previous) | set(planned):
        target = safe_target(root, name)
        if not target.exists():
            continue
        if not target.is_file():
            raise ValueError('Publication target is not a file')
        current = digest(target.read_bytes())
        incoming = digest(planned[name]) if name in planned else None
        if current != incoming and previous.get(name) != current:
            raise ValueError('Source has independent changes; review before replacing it: ' + name)
    if args.write:
        if not (root / '.git').exists():
            raise ValueError('Write mode requires a repository checkout')
        for name in previous.keys() - planned.keys():
            target = safe_target(root, name)
            if target.exists():
                target.unlink()
        for name, data in planned.items():
            target = safe_target(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() == data:
                continue
            temporary = target.with_name(target.name + '.incoming-source')
            with temporary.open('xb') as stream:
                stream.write(data)
            os.chmod(temporary, 0o644)
            temporary.replace(target)
        state = {'archive': archive_name, 'archiveSha256': manifest['archiveSha256'],
                 'files': {name: digest(data) for name, data in sorted(planned.items())}}
        (root / STATE).write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps({'profile': args.profile, 'filesVerified': len(planned), 'sourceBytes': total,
                      'mode': 'written' if args.write else 'check-only'}))


if __name__ == '__main__':
    main()
