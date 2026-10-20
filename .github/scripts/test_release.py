"""Release planning against a local Git history and a mocked GitHub boundary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = os.environ | {
            'GITHUB_REF': 'refs/heads/main',
            'GITHUB_REPOSITORY': 'example/app',
            'GITHUB_OUTPUT': str(self.root / 'output'),
            'FORCED': '',
            'PATH': f'{self.root}:{os.environ["PATH"]}',
            'PR_FIXTURES': str(self.root / 'prs.json'),
        }
        (self.root / 'gh').write_text(
            '#!/usr/bin/env python3\n'
            'import json, os, sys\n'
            'if os.environ.get("GH_FAIL"):\n'
            '    sys.stderr.write("GitHub unavailable\\n")\n'
            '    sys.exit(1)\n'
            'data = json.load(open(os.environ["PR_FIXTURES"]))\n'
            'print(json.dumps(data[sys.argv[3]]))\n'
        )
        (self.root / 'gh').chmod(0o755)
        (self.root / 'prs.json').write_text('{}')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release@example.invalid')
        self.commit('initial')

    def git(self, *args):
        return subprocess.check_output(
            ['git', *args], cwd=self.root, env=self.env, text=True
        ).strip()

    def commit(self, subject):
        self.git('commit', '--allow-empty', '-qm', subject)

    def pr(self, files, labels=(), number=1):
        fixtures = json.loads((self.root / 'prs.json').read_text())
        fixtures[str(number)] = {
            'number': number, 'title': 'Change app', 'body': '',
            'files': [{'path': path} for path in files],
            'labels': [{'name': name} for name in labels],
        }
        (self.root / 'prs.json').write_text(json.dumps(fixtures))
        self.commit(f'Change app (#{number})')

    def plan(self, forced='', ok=True):
        result = subprocess.run(
            ['bash', str(SCRIPTS / 'release-version.sh')],
            cwd=self.root, env=self.env | {'FORCED': forced},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        output = self.root / 'output'
        return dict(line.split('=', 1) for line in output.read_text().splitlines()) if output.exists() else {}

    def test_first_release(self):
        output = self.plan()
        self.assertEqual(output['version'], '1.0.0')
        self.assertEqual(output['release_tag'], 'v1.0.0')
        self.assertEqual(output['sha'], self.git('rev-parse', 'HEAD'))

    def test_migrate_above_highest_legacy_version(self):
        self.git('tag', 'desktop/v1.2.1')
        self.git('tag', 'ios/v0.1.1')
        self.git('tag', 'release/2026-10-20')
        output = self.plan()
        self.assertEqual(output['version'], '1.2.2')
        self.assertEqual(output['previous'], 'desktop/v1.2.1')

    def test_migrate_iphone_highest(self):
        self.git('tag', 'desktop/v1.2.1')
        self.git('tag', 'ios/v2.0.0')
        self.assertEqual(self.plan()['version'], '2.0.1')

    def test_enhancement_on_either_platform_bumps_minor(self):
        for path in ('desktop/shell/src/main.rs', 'ios/src-tauri/src/lib.rs', 'core/src/lib.rs'):
            with self.subTest(path=path):
                self.git('tag', '-f', 'v1.2.1')
                self.pr([path], ['enhancement'])
                self.assertEqual(self.plan()['version'], '1.3.0')

    def test_fix_bumps_patch(self):
        self.git('tag', 'v1.2.1')
        self.pr(['frontend/src/api.ts'], ['bug'])
        self.assertEqual(self.plan()['version'], '1.2.2')

    def test_nothing_new_skips_release(self):
        self.git('tag', 'v1.2.1')
        self.assertEqual(self.plan(), {})

    def test_docs_dependencies_and_workflow_only_skip_release(self):
        self.git('tag', 'v1.2.1')
        self.pr(['ios/README.md'], ['enhancement'], 1)
        self.pr(['Cargo.lock'], ['dependencies'], 2)
        self.pr(['.github/workflows/weekly-release.yml'], [], 3)
        self.assertEqual(self.plan(), {})

    def test_override_with_no_app_changes(self):
        self.git('tag', 'v1.2.1')
        self.assertEqual(self.plan('2.0.0')['version'], '2.0.0')

    def test_reject_invalid_equal_and_lower_overrides(self):
        self.git('tag', 'v1.2.1')
        for version in ('1.2.1', '1.2.0', '0.1.0', '01.3.0', 'v1.3.0', '1.3.0-beta', 'bad\nversion'):
            with self.subTest(version=version):
                self.plan(version, ok=False)

    def test_reject_override_below_legacy(self):
        self.git('tag', 'desktop/v1.2.1')
        self.plan('0.2.0', ok=False)

    def test_reject_existing_tag_even_off_main(self):
        self.git('tag', 'v1.2.1')
        self.git('checkout', '-qb', 'other')
        self.commit('other change')
        self.git('tag', 'v1.3.0')
        self.git('checkout', '-q', '-')
        self.plan('1.3.0', ok=False)

    def test_reject_automatic_tag_collision(self):
        self.git('tag', 'v1.2.1')
        self.git('checkout', '-qb', 'other')
        self.commit('other change')
        self.git('tag', 'v1.2.2')
        self.git('checkout', '-q', '-')
        self.pr(['core/src/lib.rs'], ['bug'])
        self.plan(ok=False)

    def test_reject_wrong_branch(self):
        self.env['GITHUB_REF'] = 'refs/heads/feature'
        self.plan(ok=False)

    def test_github_failure_stops_planning(self):
        self.git('tag', 'v1.2.1')
        self.pr(['core/src/lib.rs'])
        self.env['GH_FAIL'] = '1'
        self.plan(ok=False)

    def test_collect_each_pr_once(self):
        self.git('tag', 'v1.2.1')
        self.pr(['core/src/lib.rs', 'ios/src-tauri/src/lib.rs'])
        self.commit('Another commit (#1)')
        result = subprocess.check_output(
            ['bash', str(SCRIPTS / 'release-prs.sh'), 'v1.2.1', 'HEAD'],
            cwd=self.root, env=self.env, text=True,
        )
        self.assertEqual([pr['number'] for pr in json.loads(result)], [1])


if __name__ == '__main__':
    unittest.main()
