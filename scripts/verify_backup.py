"""Verify a privately extracted RFM backup without contacting any live service."""
import hashlib
import json
from pathlib import Path
import sys


def verify(root):
    root = Path(root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 'rfm-owner-backup-v1':
        raise ValueError('Unsupported backup format')
    entries = [manifest['database'], *manifest['objects']]
    seen = set()
    for entry in entries:
        file = (root / entry['file']).resolve()
        if root not in file.parents or file in seen:
            raise ValueError('Invalid or duplicate archive path')
        seen.add(file)
        if 'bytes' in entry and file.stat().st_size != entry['bytes']:
            raise ValueError('Backup file length mismatch')
        with file.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError('Backup checksum mismatch')
    return len(manifest['objects'])


if __name__ == '__main__':
    try:
        count = verify(sys.argv[1])
        print(f'Checksums verified: database archive and {count} Storage files. A database restore drill is still required.')
    except Exception:
        print('Verification failed. Check the extraction directory and archive integrity.')
        raise SystemExit(1)
