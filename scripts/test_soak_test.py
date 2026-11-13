"""Regression checks for the report validator; the full probe runs separately."""
import csv
from pathlib import Path
import sqlite3
import tempfile
import unittest

from soak_test import inspect_database, verify_csv


class ReportValidation(unittest.TestCase):
    def test_csv_preserves_zero_and_absent_failed_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'export.csv'
            with path.open('w', newline='') as output:
                writer = csv.writer(output)
                writer.writerow(['id_equipo', 'calidad', 'valor'])
                writer.writerows([['a', 'good', '0'], ['a', 'timeout', '']])
            self.assertEqual(verify_csv(path, 'a'), {'rows': 2, 'good': 1, 'failed': 1})
            with self.assertRaises(ValueError):
                verify_csv(path, 'b')
            path.write_text('id_equipo,calidad,valor\na,timeout,0\n')
            with self.assertRaises(ValueError):
                verify_csv(path, 'a')

    def test_database_detects_a_paused_plc_still_recording_and_another_plc_stopping(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'monitor.db'
            with sqlite3.connect(path) as db:
                db.executescript('CREATE TABLE samples(plc_id TEXT,variable_id TEXT,quality TEXT,observed_at_ms INTEGER); CREATE TABLE events(plc_id TEXT,kind TEXT);')
                for plc in ('demo-tank', 'demo-belt'):
                    for variable in ('a', 'b', 'c'):
                        db.execute('INSERT INTO samples VALUES(?,?,?,?)', (plc, variable, 'good', 5000))
            actions = [{'plc_id': 'demo-oven', 'scenario': 'pause', 'at_ms': 1000}, {'plc_id': 'demo-oven', 'scenario': 'resume', 'at_ms': 10000}]
            result = inspect_database(path, 0, 20000, actions)
            self.assertEqual(result['integrity'], 'ok')
            self.assertTrue(all(check['passed'] for check in result['isolation'] + result['pauses']))
            with sqlite3.connect(path) as db:
                db.execute('INSERT INTO samples VALUES(?,?,?,?)', ('demo-oven', 'a', 'good', 5000))
                db.execute("DELETE FROM samples WHERE plc_id='demo-belt'")
            result = inspect_database(path, 0, 20000, actions)
            self.assertFalse(result['pauses'][0]['passed'])
            self.assertTrue(any(not check['passed'] for check in result['isolation']))


if __name__ == '__main__':
    unittest.main()
