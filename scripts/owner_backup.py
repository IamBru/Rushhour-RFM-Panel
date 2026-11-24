#!/usr/bin/env python3
"""Owner-operated, read-only backup. Never invoke this from the panel/browser."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone


def file_hash(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def required(env, name):
    value = env.get(name, '').strip()
    if not value:
        raise RuntimeError('Missing setting: ' + name)
    return value


def database_environment(settings, parent):
    # libpq accepts credentials via environment; never put a URL/password in argv.
    names = {'host': 'PGHOST', 'port': 'PGPORT', 'user': 'PGUSER',
             'password': 'PGPASSWORD', 'dbname': 'PGDATABASE', 'sslmode': 'PGSSLMODE'}
    unsupported = set(settings) - set(names)
    if unsupported:
        raise RuntimeError('Use a standard Supabase session-pooler connection URL without extra parameters.')
    env = {k: v for k, v in parent.items() if not k.startswith('PG') and not k.startswith('SUPABASE_')}
    env.update({names[k]: v for k, v in settings.items()})
    env.setdefault('PGSSLMODE', 'require')
    if env['PGSSLMODE'] not in {'require', 'verify-ca', 'verify-full'}:
        raise RuntimeError('Database connections must require SSL.')
    env['PGOPTIONS'] = '-c default_transaction_read_only=on'
    env['PGCONNECT_TIMEOUT'] = '30'
    return env


def quiet_run(args, **kwargs):
    # Tool errors can contain connection details. Only emit a generic failure.
    result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + ' failed; verify owner configuration and tool versions.')


def save_object(client, entry, destination):
    request = {'Bucket': entry['bucket'], 'Key': entry['key']}
    metadata = entry.get('database_metadata') or {}
    etag = metadata.get('eTag') or metadata.get('etag')
    if etag:
        request['IfMatch'] = '"' + str(etag).strip('"') + '"'
    response = client.get_object(**request)
    body = response['Body']
    size = 0
    try:
        with destination.open('xb') as output:
            while chunk := body.read(1024 * 1024):
                output.write(chunk)
                size += len(chunk)
    finally:
        body.close()
    if size != response['ContentLength']:
        raise RuntimeError('An object download was incomplete; no backup will be published.')
    entry.update(bytes=size, sha256=file_hash(destination), content_type=response.get('ContentType'))


def create_backup():
    import boto3
    import psycopg
    from psycopg.conninfo import conninfo_to_dict
    from botocore.config import Config

    env = os.environ
    url = required(env, 'SUPABASE_DB_URL')
    recipient = required(env, 'BACKUP_AGE_RECIPIENT')
    if not recipient.startswith('age1') or any(c.isspace() for c in recipient):
        raise RuntimeError('BACKUP_AGE_RECIPIENT must be one public age1 recipient, never a private key.')
    endpoint = required(env, 'SUPABASE_S3_ENDPOINT')
    if not endpoint.startswith('https://'):
        raise RuntimeError('Storage requires an HTTPS endpoint.')
    pg_env = database_environment(conninfo_to_dict(url), env)
    for tool in ['pg_dump', 'pg_restore', 'age']:
        if not shutil.which(tool):
            raise RuntimeError('Install required tool: ' + tool)
    output = Path(required(env, 'BACKUP_OUTPUT_DIR')).resolve()
    repo = Path(__file__).resolve().parents[1]
    if output == repo or repo in output.parents:
        raise RuntimeError('Backup output must be outside the repository and web root.')
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    final = output / ('rfm-' + stamp + '.tar.gz.age')
    pending = final.with_suffix('.partial')
    s3 = boto3.client('s3', endpoint_url=endpoint,
                      region_name=required(env, 'SUPABASE_S3_REGION'),
                      aws_access_key_id=required(env, 'SUPABASE_S3_ACCESS_KEY_ID'),
                      aws_secret_access_key=required(env, 'SUPABASE_S3_SECRET_ACCESS_KEY'),
                      config=Config(connect_timeout=30, read_timeout=120,
                                    retries={'max_attempts': 4}, s3={'addressing_style': 'path'}))
    try:
        with tempfile.TemporaryDirectory(prefix='rfm-owner-backup-') as temp:
            root = Path(temp)
            payload = root / 'payload'
            payload.mkdir()
            (payload / 'objects').mkdir()
            with psycopg.connect(url, connect_timeout=30, sslmode=pg_env['PGSSLMODE']) as conn:
                conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                snapshot = conn.execute('SELECT pg_export_snapshot()').fetchone()[0]
                started = conn.execute('SELECT clock_timestamp()').fetchone()[0].isoformat()
                # Snapshot and object manifest share exactly the same database view.
                buckets = [row[0] for row in conn.execute('SELECT to_jsonb(b) FROM storage.buckets b ORDER BY id')]
                objects = [{'bucket': bucket, 'key': key, 'database_metadata': meta}
                           for bucket, key, meta in conn.execute(
                               'SELECT bucket_id,name,metadata FROM storage.objects ORDER BY bucket_id,name')]
                dump = payload / 'database.dump'
                quiet_run(['pg_dump', '--format=custom', '--no-password', '--schema=public',
                           '--schema=auth', '--schema=storage', '--snapshot=' + snapshot,
                           '--file=' + str(dump)], env=pg_env, timeout=2700)
                quiet_run(['pg_restore', '--list', str(dump)], env=pg_env, timeout=60)
            for i, entry in enumerate(objects):
                # Opaque file names prevent bucket/key strings from escaping the archive directory.
                entry['file'] = f'objects/{i:08d}'
                save_object(s3, entry, payload / entry['file'])
            manifest = {'format': 'rfm-owner-backup-v1', 'database_snapshot_at': started,
                        'completed_at': datetime.now(timezone.utc).isoformat(),
                        'database': {'file': 'database.dump', 'sha256': file_hash(dump)},
                        'buckets': buckets, 'objects': objects}
            (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
            archive = root / 'backup.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(payload, arcname='rfm-backup')
            quiet_run(['age', '--recipient', recipient, '--output', str(pending), str(archive)], timeout=900)
            if not pending.is_file() or pending.stat().st_size == 0:
                raise RuntimeError('Encryption did not produce an archive.')
            pending.replace(final)
        print('Encrypted database and Storage backup completed.')
    finally:
        pending.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        create_backup()
    except Exception:
        # Never print exception bodies: driver errors can contain credentials or private object keys.
        print('Backup failed. No complete archive was published. Check settings, permissions, '
              'PostgreSQL client version, and concurrent photo changes; retry from Actions.')
        raise SystemExit(1)
