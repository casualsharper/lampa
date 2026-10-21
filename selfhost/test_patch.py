import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch  # noqa: E402


class ScriptUrlTest(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.dir = tempfile.TemporaryDirectory()
        os.chdir(self.dir.name)

    def tearDown(self):
        os.chdir(self.cwd)
        self.dir.cleanup()

    def write(self, text):
        with open('a.js', 'w') as f:
            f.write(text)

    def test_url_changes_with_content_only(self):
        self.write('one')
        first = patch.script_url('a.js')
        self.assertRegex(first, r'^\./a\.js\?v=[0-9a-f]{8}$')
        self.assertEqual(patch.script_url('a.js'), first)
        self.write('two')
        self.assertNotEqual(patch.script_url('a.js'), first)

    def test_generated_script_has_no_version(self):
        self.assertEqual(patch.script_url('config.js'), './config.js')

    def test_index_gets_versioned_tags(self):
        self.write('x')
        with open('index.html', 'w') as f:
            f.write('<head>\n    <script src="./vender/keypad/keypad.js"></script>\n</head>\n')
        saved = patch.OUR_SCRIPTS
        patch.OUR_SCRIPTS = ['config.js', 'a.js']
        try:
            patch.apply('index.html', patch.index_patches)
        finally:
            patch.OUR_SCRIPTS = saved
        with open('index.html') as f:
            html = f.read()
        self.assertIn('    <script src="./config.js"></script>\n', html)
        self.assertRegex(html, r'    <script src="\./a\.js\?v=[0-9a-f]{8}"></script>\n')


if __name__ == '__main__':
    unittest.main()
