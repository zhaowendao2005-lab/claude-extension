"""Run with python3 tests/store.test.py -v."""
import concurrent.futures
import copy
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "storage" / "store.py"


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "project" / ".budget" / "state.sqlite3"
        self.run = {
            "schemaVersion": 1, "id": "run-1", "revision": 0,
            "ownerSessionId": "session-1", "status": "running", "updatedAt": 100,
            "deliverDir": "/project/deliver", "task": "private prompt 中文",
            "events": [{"seq": 0, "type": "created"}],
        }

    def cli(self, action, *args):
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--db", str(self.db), "--action", action, *args],
            capture_output=True, text=True, timeout=15,
        )

    def save(self, run=None, expected="new", run_id=None):
        run = self.run if run is None else run
        return self.cli("save", "--id", run["id"] if run_id is None else run_id,
                        "--expected", str(expected), "--data", json.dumps(run))

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def failure(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("store: "), result.stderr)
        self.assertLess(len(result.stderr), 250)
        self.assertNotIn("private prompt", result.stderr)

    def load(self):
        return self.success(self.cli("load", "--id", self.run["id"]))

    def test_create_read_missing_and_reopen(self):
        self.assertIsNone(self.load())
        self.assertTrue(self.db.is_file())
        self.assertIsNone(self.success(self.save()))
        self.assertEqual(self.load(), self.run)
        self.assertIsNone(self.success(self.cli("load", "--id", "absent")))

    def test_cas_and_events_are_one_snapshot(self):
        self.success(self.save())
        updated = copy.deepcopy(self.run)
        updated["revision"] = 1
        updated["events"].append({"seq": 1, "type": "pause"})
        self.success(self.save(updated, 0))
        self.assertEqual(self.load(), updated)
        self.failure(self.save())
        self.failure(self.save(updated, 0))
        self.failure(self.save(dict(updated, revision=3), 1))
        self.failure(self.save(dict(updated, id="missing"), 0))
        self.assertEqual(self.load(), updated)

    def test_concurrent_cas_has_exactly_one_winner(self):
        self.success(self.save())

        def contender(index):
            updated = dict(self.run, revision=1, task=f"candidate-{index}",
                           events=[{"seq": 1, "type": f"winner-{index}"}])
            return updated, self.save(updated, 0)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(contender, range(8)))
        winners = [run for run, result in results if result.returncode == 0]
        self.assertEqual(len(winners), 1)
        for _, result in results:
            if result.returncode:
                self.failure(result)
                self.assertIn("revision conflict", result.stderr)
        self.assertEqual(self.load(), winners[0])

    def test_concurrent_create_has_exactly_one_winner(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.save(), range(6)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertEqual(self.load(), self.run)

    def test_list_is_summary_only(self):
        self.assertEqual(self.success(self.cli("list")), [])
        self.success(self.save())
        self.run = dict(self.run, revision=1, status="completed")
        self.success(self.save(self.run, 0))
        self.success(self.save(dict(self.run, id="run-2", revision=0, status="running", updatedAt=200, ownerSessionId="session-2")))
        summaries = self.success(self.cli("list"))
        self.assertEqual([run["id"] for run in summaries], ["run-2", "run-1"])
        keys = {"id", "ownerSessionId", "status", "updatedAt", "deliverDir"}
        for summary in summaries:
            self.assertEqual(set(summary), keys)
        self.assertEqual(summaries[1], {key: self.run[key] for key in keys})
        self.assertNotIn("private prompt", json.dumps(summaries))

    def test_invalid_data_does_not_overwrite(self):
        self.success(self.save())
        for patch in ({"schemaVersion": 2}, {"schemaVersion": True}, {"revision": True},
                      {"revision": -1}, {"updatedAt": float("nan")}, {"ownerSessionId": None}):
            self.failure(self.save(dict(self.run, **patch), 0))
        self.failure(self.save(dict(self.run, revision=1), 0, "wrong-id"))
        self.failure(self.cli("save", "--id", "run-1", "--expected", "0", "--data", "{"))
        self.failure(self.save(dict(self.run, revision=1), "nope"))
        self.failure(self.cli("save", "--id", "run-1"))
        self.failure(self.cli("claim", "--id", "run-1"))
        self.assertEqual(self.load(), self.run)

    def test_database_error_rolls_back_snapshot_and_revision(self):
        self.success(self.save())
        connection = sqlite3.connect(self.db)
        try:
            connection.execute("""CREATE TRIGGER abort_update AFTER UPDATE ON runs
                BEGIN SELECT RAISE(ABORT, 'forced failure'); END""")
            connection.commit()
        finally:
            connection.close()
        self.failure(self.save(dict(self.run, revision=1, events=[]), 0))
        self.assertEqual(self.load(), self.run)
        connection = sqlite3.connect(self.db)
        try:
            connection.execute("DROP TRIGGER abort_update")
            connection.commit()
        finally:
            connection.close()
        self.success(self.save(dict(self.run, revision=1), 0))

    def test_crashed_transaction_recovers_previous_snapshot(self):
        self.success(self.save())
        # Flush uncommitted pages then exit without close/rollback, exercising
        # SQLite's on-disk recovery, not just Python's exception cleanup.
        code = """
import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute('PRAGMA cache_size = 1')
c.execute('BEGIN IMMEDIATE')
c.execute('UPDATE runs SET revision=99, snapshot=?', ('x' * 2000000,))
os._exit(17)
"""
        result = subprocess.run([sys.executable, "-I", "-c", code, str(self.db)],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 17)
        self.assertEqual(self.load(), self.run)
        self.success(self.save(dict(self.run, revision=1), 0))


if __name__ == "__main__":
    unittest.main()
