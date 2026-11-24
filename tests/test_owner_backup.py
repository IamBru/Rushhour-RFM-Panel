import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

backup, verifier = load('owner_backup'), load('verify_backup')


class BackupTests(unittest.TestCase):
    def test_connection_secrets_are_environment_only_and_inherited_pg_options_removed(self):
        env = backup.database_environment({'host': 'example', 'password': 'test-only', 'dbname': 'postgres'},
                                          {'PATH': 'tools', 'PGSERVICE': 'unexpected', 'SUPABASE_DB_URL': 'test-only'})
        self.assertEqual(env['PGPASSWORD'], 'test-only')
        self.assertEqual(env['PGSSLMODE'], 'require')
        self.assertNotIn('PGSERVICE', env)
        self.assertNotIn('SUPABASE_DB_URL', env)
        with self.assertRaises(RuntimeError):
            backup.database_environment({'service': 'hidden-config'}, {})

    def test_object_download_checks_etag_and_size(self):
        calls = []
        def get_object(**args):
            calls.append(args)
            return {'Body': io.BytesIO(b'photo'), 'ContentLength': 5, 'ContentType': 'image/png'}
        client = types.SimpleNamespace(get_object=get_object)
        with tempfile.TemporaryDirectory() as temp:
            entry = {'bucket': 'images', 'key': '../../original-key', 'database_metadata': {'eTag': 'old'}}
            backup.save_object(client, entry, Path(temp) / 'safe-file')
            self.assertEqual(calls[0]['IfMatch'], '"old"')
            self.assertEqual(entry['sha256'], hashlib.sha256(b'photo').hexdigest())
            client.get_object = lambda **args: {'Body': io.BytesIO(b'bad'), 'ContentLength': 5}
            with self.assertRaises(RuntimeError):
                backup.save_object(client, entry, Path(temp) / 'second')

    def run_mock_backup(self, fail=None):
        calls, queries = [], []
        class Result:
            def __init__(self, rows): self.rows = rows
            def fetchone(self): return self.rows[0]
            def __iter__(self): return iter(self.rows)
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, sql):
                queries.append(sql)
                if 'pg_export_snapshot' in sql: return Result([('snapshot-id',)])
                if 'clock_timestamp' in sql: return Result([(backup.datetime.now(backup.timezone.utc),)])
                if 'storage.buckets' in sql: return Result([({'id': 'images'},)])
                if 'storage.objects' in sql: return Result([('images', '../../outside', {})])
                return Result([])
        def get_object(**args):
            if fail == 'object': raise RuntimeError('private details')
            return {'Body': io.BytesIO(b'photo'), 'ContentLength': 5}
        def quiet(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == 'pg_dump':
                Path(next(a[7:] for a in args if a.startswith('--file='))).write_bytes(b'database')
            if args[0] == 'age':
                if fail == 'encryption': raise RuntimeError('encryption failed')
                # Verify the real generated tar payload before the mock encryptor returns.
                with backup.tarfile.open(args[-1]) as tar:
                    names = tar.getnames()
                    self.assertIn('rfm-backup/objects/00000000', names)
                    manifest = json.load(tar.extractfile('rfm-backup/manifest.json'))
                    self.assertEqual(manifest['objects'][0]['key'], '../../outside')
                    self.assertEqual(manifest['database']['sha256'], hashlib.sha256(b'database').hexdigest())
                Path(args[args.index('--output') + 1]).write_bytes(b'mock-encrypted')
        modules = {'boto3': types.SimpleNamespace(client=lambda *a, **k: types.SimpleNamespace(get_object=get_object)),
                   'psycopg': types.SimpleNamespace(connect=lambda *a, **k: Connection()),
                   'psycopg.conninfo': types.SimpleNamespace(conninfo_to_dict=lambda url: {'password': 'test-only'}),
                   'botocore': types.ModuleType('botocore'),
                   'botocore.config': types.SimpleNamespace(Config=lambda **k: None)}
        with tempfile.TemporaryDirectory() as temp:
            env = {'SUPABASE_DB_URL': 'test-only', 'BACKUP_AGE_RECIPIENT': 'age1test',
                   'SUPABASE_S3_ENDPOINT': 'https://example.invalid', 'SUPABASE_S3_REGION': 'region',
                   'SUPABASE_S3_ACCESS_KEY_ID': 'test-only', 'SUPABASE_S3_SECRET_ACCESS_KEY': 'test-only',
                   'BACKUP_OUTPUT_DIR': temp}
            with patch.dict(sys.modules, modules), patch.dict(backup.os.environ, env, clear=True), \
                    patch.object(backup.shutil, 'which', return_value='installed'), patch.object(backup, 'quiet_run', side_effect=quiet):
                if fail:
                    with self.assertRaises(RuntimeError): backup.create_backup()
                    self.assertEqual(list(Path(temp).iterdir()), [])
                else:
                    backup.create_backup()
                    self.assertEqual(len(list(Path(temp).glob('*.age'))), 1)
            dump = next(args for args, kwargs in calls if args[0] == 'pg_dump')
            self.assertIn('--snapshot=snapshot-id', dump)
            self.assertNotIn('test-only', ' '.join(dump))
            self.assertIn('READ ONLY', queries[0])

    def test_database_and_storage_packaged_from_one_snapshot(self): self.run_mock_backup()
    def test_missing_object_does_not_publish_archive(self): self.run_mock_backup('object')
    def test_failed_encryption_does_not_publish_archive(self): self.run_mock_backup('encryption')

    def test_verifier_rejects_corruption_and_path_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'database.dump').write_bytes(b'data')
            manifest = {'format': 'rfm-owner-backup-v1', 'database': {'file': 'database.dump',
                        'sha256': hashlib.sha256(b'data').hexdigest()}, 'objects': []}
            def save(): (root / 'manifest.json').write_text(json.dumps(manifest))
            save()
            self.assertEqual(verifier.verify(root), 0)
            (root / 'database.dump').write_bytes(b'corrupt')
            with self.assertRaises(ValueError): verifier.verify(root)
            manifest['database']['file'] = '../outside'
            save()
            with self.assertRaises(ValueError): verifier.verify(root)


if __name__ == '__main__': unittest.main()
