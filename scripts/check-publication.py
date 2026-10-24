#!/usr/bin/env python3
"""Read-only checks for the prepared public source tree; never print file contents."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import unicodedata
import zlib


EXCLUDED_DIRECTORIES = {
    '.git', 'node_modules', 'dist', 'release', 'DerivedData', '.build',
    '__pycache__', 'xcuserdata', '.venv', 'venv', '.downloads', '.tools',
    '.pytest_cache', '.mypy_cache', '.next', 'coverage',
}
ICON_FILES = {'icon.png', 'icon.ico', 'icon.icns'}
FORBIDDEN_EXTENSIONS = {
    '.pem', '.p12', '.pfx', '.p8', '.key', '.jks', '.keystore', '.cer',
    '.crt', '.der', '.csr', '.mobileprovision', '.provisionprofile',
    '.ipa', '.dmg', '.exe', '.msi', '.pkg', '.deb', '.rpm', '.apk',
    '.aab', '.appx', '.msix', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.db', '.sqlite', '.sqlite3', '.realm', '.mdb', '.kdbx', '.log',
    '.ips', '.crash', '.xcuserstate', '.pyc',
}
FORBIDDEN_NAMES = {
    '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials',
    'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    '.publication-local.json',
}
FORBIDDEN_DIRECTORY_SUFFIXES = {'.app', '.xcarchive'}
PRIVATE_DIRECTORY_NAMES = {'.obsidian', 'vault', 'private', 'publisher'}
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
PNG_METADATA = {b'eXIf', b'tEXt', b'iTXt', b'zTXt', b'caBX'}
FONT_SIGNATURES = {
    '.woff': (b'wOFF',), '.woff2': (b'wOF2',),
    '.ttf': (b'\x00\x01\x00\x00', b'true'), '.otf': (b'OTTO',),
    '.ttc': (b'ttcf',),
}
TEXT_EXTENSIONS = {
    '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.swift', '.py', '.pyi',
    '.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx', '.css', '.scss', '.less',
    '.html', '.htm', '.svg', '.vue', '.svelte', '.json', '.jsonc', '.lock',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.txt', '.md', '.rst',
    '.xml', '.plist', '.strings', '.entitlements', '.pbxproj', '.xcscheme',
    '.xcconfig', '.xcworkspacedata', '.xcsettings', '.modulemap', '.sh',
    '.bash', '.zsh', '.bat', '.ps1', '.rs', '.go', '.kt', '.java', '.rb',
    '.sql', '.cs', '.csproj', '.sln',
}
TEXT_NAMES = {
    'license', 'copying', 'notice', 'makefile', 'dockerfile', '.gitignore',
    '.gitattributes', '.editorconfig', '.npmignore', '.env.example',
}
MAX_FILE_BYTES = 64 * 1024 * 1024
# SheetJS's unmodified code-page tables contain literal non-NUL controls.
# Only these reviewed upstream bytes qualify as text; later versions need review.
AUDITED_CONTROL_TEXT = {
    'desktop/src/vendor/excel/xlsx.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
    'ios/InkSpace/Resources/Excel/xlsx.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
    'packages/notebook-data/lib/vendor/excel/xlsx.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
    'packages/notebook-data/sources/vendor/excel/xlsx.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
}
HOME_PATH = re.compile(
    r'(?<![A-Za-z0-9_])/(?:' + 'Users' + r'|' + 'home'
    + r')/[A-Za-z0-9_][A-Za-z0-9_. -]*(?=[/\\\s"\x27`]|$)'
)
SECRET_PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{70,})\b'),
    'api-secret': re.compile(r'\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{32,}\b'),
    'aws-access-key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'google-api-key': re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'),
    'slack-token': re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{24,}\b'),
}


def folded(value: str) -> str:
    return unicodedata.normalize('NFKC', value).casefold()


def png_rules(data: bytes) -> set[str]:
    if not data.startswith(PNG_SIGNATURE):
        return {'invalid-png'}
    rules: set[str] = set()
    offset = len(PNG_SIGNATURE)
    saw_header = False
    while offset + 12 <= len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            return rules | {'invalid-png'}
        payload = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from('>I', data, offset + 8 + size)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            return rules | {'invalid-png'}
        if not saw_header:
            if kind != b'IHDR' or size != 13:
                return rules | {'invalid-png'}
            saw_header = True
        if kind in PNG_METADATA:
            rules.add('png-metadata')
        if kind == b'IEND':
            if size != 0 or end != len(data):
                rules.add('invalid-png')
            return rules
        offset = end
    return rules | {'invalid-png'}


def icon_rules(data: bytes, suffix: str) -> set[str]:
    rules: set[str] = set()
    if suffix == '.icns':
        if len(data) < 8 or data[:4] != b'icns' or struct.unpack_from('>I', data, 4)[0] != len(data):
            return {'invalid-icon'}
        offset = 8
        while offset < len(data):
            if offset + 8 > len(data):
                return rules | {'invalid-icon'}
            size = struct.unpack_from('>I', data, offset + 4)[0]
            if size < 8 or offset + size > len(data):
                return rules | {'invalid-icon'}
            payload = data[offset + 8:offset + size]
            if payload.startswith(PNG_SIGNATURE):
                rules.update(png_rules(payload))
            offset += size
        return rules
    if len(data) < 6 or data[:4] != b'\x00\x00\x01\x00':
        return {'invalid-icon'}
    count = struct.unpack_from('<H', data, 4)[0]
    if not count or 6 + 16 * count > len(data):
        return {'invalid-icon'}
    for index in range(count):
        size, offset = struct.unpack_from('<II', data, 6 + 16 * index + 8)
        if offset < 6 + 16 * count or not size or offset + size > len(data):
            return rules | {'invalid-icon'}
        payload = data[offset:offset + size]
        if payload.startswith(PNG_SIGNATURE):
            rules.update(png_rules(payload))
        elif len(payload) < 40 or struct.unpack_from('<I', payload)[0] < 40:
            rules.add('invalid-icon')
    return rules


def file_rules(relative: Path, data: bytes, denied: list[str]) -> set[str]:
    rules: set[str] = set()
    suffix = relative.suffix.lower()
    if suffix == '.png':
        rules.update(png_rules(data))
    elif suffix in {'.ico', '.icns'}:
        rules.update(icon_rules(data, suffix))
    elif suffix in FONT_SIGNATURES:
        if not data.startswith(FONT_SIGNATURES[suffix]):
            rules.add('invalid-font')
    else:
        if suffix not in TEXT_EXTENSIONS and relative.name.lower() not in TEXT_NAMES:
            rules.add('unknown-source-format')
        try:
            encoding = 'utf-16' if suffix in {'.strings', '.plist'} and data[:2] in {b'\xff\xfe', b'\xfe\xff'} else 'utf-8-sig'
            decoded = data.decode(encoding)
            if any(ord(char) < 32 and char not in '\t\n\r\f' for char in decoded):
                reviewed = AUDITED_CONTROL_TEXT.get(relative.as_posix())
                if reviewed is None or hashlib.sha256(data).hexdigest() != reviewed:
                    rules.add('unknown-binary')
        except UnicodeError:
            rules.add('unknown-binary')
    # Also inspect readable byte sequences in permitted asset containers.
    text = data.decode('utf-8', errors='ignore')
    if suffix in {'.strings', '.plist'} and data[:2] in {b'\xff\xfe', b'\xfe\xff'}:
        text = data.decode('utf-16', errors='ignore')
    if HOME_PATH.search(text):
        rules.add('private-home-path')
    for name, pattern in SECRET_PATTERNS.items():
        if pattern.search(text):
            rules.add(name)
    readable = [text]
    if suffix in {'.png', '.ico', '.icns', *FONT_SIGNATURES}:
        readable.extend(data.decode(encoding, errors='ignore') for encoding in ('utf-16-le', 'utf-16-be'))
    combined = folded(relative.as_posix() + '\n' + '\n'.join(readable))
    if any(value in combined for value in denied):
        rules.add('private-denylist')
    return rules


def safe_label(relative: Path, denied: list[str]) -> str:
    value = relative.as_posix()
    for pattern in SECRET_PATTERNS.values():
        value = pattern.sub('[redacted]', value)
    for term in denied:
        if term in folded(value):
            # Avoid echoing a private term embedded in a file or directory name.
            value = '/'.join('[redacted]' if term in folded(part) else part for part in value.split('/'))
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1], help='Prepared source tree; defaults to this repository.')
    parser.add_argument('--denylist', type=Path, help='External JSON array of private strings; never copied or printed.')
    args = parser.parse_args()
    if args.root.is_symlink() or not args.root.is_dir():
        print('Publication check configuration failed: source root must be a real directory.', file=sys.stderr)
        return 2
    root = args.root.resolve()
    denied: list[str] = []
    if args.denylist:
        try:
            denyfile = args.denylist.resolve(strict=True)
            if denyfile.is_relative_to(root):
                raise ValueError('external denylist required')
            values = json.loads(denyfile.read_text(encoding='utf-8'))
            if not isinstance(values, list) or any(not isinstance(value, str) or not value.strip() for value in values):
                raise ValueError('string array required')
            denied = [folded(value) for value in values]
        except (OSError, UnicodeError, ValueError):
            print('Publication check configuration failed: denylist must be an external JSON array of nonempty strings.', file=sys.stderr)
            return 2
    findings: set[tuple[str, str]] = set()
    checked = 0

    def record(relative: Path, rule: str) -> None:
        findings.add((safe_label(relative, denied), rule))

    def visit(directory: Path) -> None:
        nonlocal checked
        try:
            entries = sorted(directory.iterdir(), key=lambda value: value.name)
        except OSError:
            record(directory.relative_to(root), 'unreadable-directory')
            return
        for entry in entries:
            relative = entry.relative_to(root)
            if entry.name in EXCLUDED_DIRECTORIES or entry.name.endswith('.xcresult'):
                continue
            if entry.name == 'build' and relative != Path('desktop/build'):
                continue
            if directory.relative_to(root) == Path('desktop/build') and entry.name not in ICON_FILES:
                continue
            if relative == Path('desktop/public/pdfjs'):
                continue
            try:
                info = entry.lstat()
                if stat.S_ISLNK(info.st_mode):
                    record(relative, 'symbolic-link')
                    continue
                if stat.S_ISDIR(info.st_mode):
                    if entry.suffix.lower() in FORBIDDEN_DIRECTORY_SUFFIXES or entry.name in PRIVATE_DIRECTORY_NAMES:
                        record(relative, 'private-or-installation-directory')
                    else:
                        visit(entry)
                    continue
                if not stat.S_ISREG(info.st_mode):
                    record(relative, 'nonregular-file')
                    continue
                name = entry.name.lower()
                if (entry.suffix.lower() in FORBIDDEN_EXTENSIONS or name in FORBIDDEN_NAMES
                        or (name.startswith('.env') and name != '.env.example')
                        or re.search(r'\.(?:sqlite\d*|db)-(?:wal|shm)$', name)):
                    record(relative, 'private-or-packaged-file')
                    continue
                if info.st_size > MAX_FILE_BYTES:
                    record(relative, 'source-file-size-limit')
                    continue
                flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                descriptor = os.open(entry, flags)
                with os.fdopen(descriptor, 'rb') as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        record(relative, 'input-changed')
                        continue
                    data = stream.read(MAX_FILE_BYTES + 1)
                    after = os.fstat(stream.fileno())
                if len(data) != info.st_size or len(data) > MAX_FILE_BYTES or after.st_mtime_ns != info.st_mtime_ns:
                    record(relative, 'input-changed')
                    continue
                checked += 1
                for rule in file_rules(relative, data, denied):
                    record(relative, rule)
            except OSError:
                record(relative, 'unreadable-or-changed-file')

    visit(root)
    for relative, rule in sorted(findings):
        print(json.dumps({'path': relative, 'rule': rule}, ensure_ascii=False))
    if findings:
        print(f'Publication check failed: {len(findings)} finding(s); {checked} source file(s) checked.')
        return 1
    print(f'Publication check passed: {checked} source file(s) checked.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
